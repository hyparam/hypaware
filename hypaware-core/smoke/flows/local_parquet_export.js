// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parquetReadObjects } from 'hyparquet'

import { Attr, installObservability } from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * @import { ActivePlugin, SinkEncoder } from '../../../collectivus-plugin-kernel-types'
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(HERE, '..', '..', 'plugins-workspace')

/**
 * Phase 7 smoke — Parquet export through the `@hypaware/local-fs` +
 * `@hypaware/format-parquet` pair under the daemon boot path, with a
 * CLI-driven forced tick and a failed-export → outbox path.
 *
 * Two sink instances are wired through the daemon's runtime:
 *
 *   - `good`     — base dir is a clean tmp dir; the tick lands a
 *                  readable Parquet file under
 *                  `<dir>/logs/partition=all/partition=all.parquet`.
 *   - `broken`   — a regular file is pre-staged at
 *                  `<dir>/logs`, so `fs.mkdir(partitionDir,
 *                  recursive: true)` inside `local-fs.writeBlob` hits
 *                  ENOTDIR. The driver then routes the failed batch
 *                  into `<state>/sinks/broken/outbox/<batchId>.json`.
 *
 * The forced tick is driven through `hyp sink force` so the CLI
 * surface is exercised, not just the in-process driver. Dispatch is
 * handed the daemon's runtime via `opts.kernel` because Phase 7 does
 * not yet wire config-driven sink instantiation — the smoke owns the
 * `kernel.sinks.instantiate` calls until that lands.
 *
 * Bead `hy-bbyi` assertions:
 *
 *   - One row writes to the `logs` dataset via OTLP, queryable by
 *     `dev_run_id`.
 *   - The good sink produces a Parquet file decodable by
 *     `parquetReadObjects` containing the captured log row.
 *   - The broken sink's failure lands in the outbox.
 *   - `hyp sink force good` exits 0 and the report mentions the
 *     instance as `exported`.
 *   - Daemon self-telemetry includes `source.start` (otlp),
 *     `sink.tick`, `sink.export_batch` (status=ok for `good`, !=ok
 *     for `broken`), and `daemon.shutdown`.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'local_parquet_export: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  // ----- Stage config: otel + local-fs + format-parquet -----
  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/otel', config: { listen_host: '127.0.0.1', listen_port: 0 } },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/local-fs' },
    ],
    query: { cache: { retention: { default_days: 30 } } },
  }, null, 2))

  process.env.HYP_HOME = harness.hypHome
  process.env.HYP_CONFIG = configPath

  const goodDir = path.join(harness.tmpDir, 'sink-good')
  const brokenDir = path.join(harness.tmpDir, 'sink-broken')
  await fs.mkdir(goodDir, { recursive: true })
  await fs.mkdir(brokenDir, { recursive: true })
  // Stage the failure up front (before the daemon's auto-tick loop
  // can race past it): writeBlob will try to mkdir
  // `<brokenDir>/logs/partition=all` recursively, which hits ENOTDIR
  // because `<brokenDir>/logs` is already a regular file.
  await fs.writeFile(path.join(brokenDir, 'logs'), 'not-a-directory')

  // ----- Boot the daemon (otel listener auto-starts; local-fs's sink
  //       contribution registers; format-parquet's encoder capability
  //       lands in the registry) -----
  const handle = await runDaemon({
    hypHome: harness.hypHome,
    configPath,
    env: process.env,
    runId: harness.devRunId,
    // 60ms cadence so a few scheduled ticks fire during the smoke and
    // the daemon's `sink.tick` span shows up in JSONL — the CLI force
    // tick exercises the dispatcher path but does not emit `sink.tick`
    // itself.
    tickIntervalMs: 60,
    installSignalHandlers: false,
  })

  // ----- POST one OTLP log payload so the `logs` dataset has a row to
  //       export -----
  const otelDetails = /** @type {{ listen_host: string, listen_port: number }} */ (
    handle.snapshot().sources.find((s) => s.name === 'otlp')?.details
  )
  await postOtlp(
    `http://${otelDetails.listen_host}:${otelDetails.listen_port}/v1/logs`,
    buildLogsPayload(harness.devRunId),
  )

  // ----- Wire two sink instances on the daemon's kernel -----
  const kernel = handle.runtime
  const encoder = /** @type {SinkEncoder} */ (
    kernel.capabilities.require('@hypaware/local-fs', 'hypaware.encoder', '^1.0.0')
  )
  const contribution = kernel.sinks.getContribution('@hypaware/local-fs', 'local-fs')
  expect.that(
    'sinks: local-fs contributed a local-fs sink under daemon boot',
    contribution,
    (v) => v !== undefined,
  )
  if (!contribution) return

  const localFsDir = path.join(PLUGINS_WORKSPACE, 'local-fs')
  /** @type {ActivePlugin} */
  const destinationPlugin = {
    name: '@hypaware/local-fs',
    version: '1.0.0',
    manifest: {
      schema_version: 1,
      name: '@hypaware/local-fs',
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './src/index.js',
    },
    rootDir: localFsDir,
  }

  for (const instance of ['good', 'broken']) {
    await kernel.sinks.instantiate({
      kind: 'blob',
      instanceName: instance,
      destination: contribution,
      writerPlugin: '@hypaware/format-parquet',
      encoder,
      config: { schedule: '* * * * *', dir: instance === 'good' ? goodDir : brokenDir },
      plugin: destinationPlugin,
      paths: {
        rootDir: localFsDir,
        stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/local-fs', instance),
        cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/local-fs', instance),
        tempDir: path.join(harness.tmpDir, 'plugin-temp', instance),
      },
      log: makeNoopLogger(),
    })
  }

  // ----- Drive the forced tick through the CLI (`hyp sink force`) -----
  const forceStdout = makeBuf()
  const forceStderr = makeBuf()
  const forceCode = await dispatch(
    ['sink', 'force'],
    {
      stdout: forceStdout,
      stderr: forceStderr,
      env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath },
      kernel,
    },
  )
  expect.that(
    `dispatch: hyp sink force exited 0 (stderr=${forceStderr.text()})`,
    forceCode,
    (v) => v === 0,
  )
  const forceOut = forceStdout.text()
  expect.that(
    'stdout: hyp sink force reported the good instance as exported',
    forceOut,
    (v) => typeof v === 'string' && /good: exported/.test(v),
  )
  expect.that(
    'stdout: hyp sink force reported the broken instance as partial (failed mkdir)',
    forceOut,
    (v) => typeof v === 'string' && /broken: (partial|failed)/.test(v),
  )

  // ----- Inspect the Parquet artifact written by `good` -----
  const goodPartitionDir = path.join(goodDir, 'logs', 'partition=all')
  const goodFile = path.join(goodPartitionDir, 'partition=all.parquet')
  const goodStat = await fs.stat(goodFile)
  expect.that(
    `good sink: ${goodFile} is a non-empty Parquet file`,
    goodStat,
    (s) => s.isFile() && s.size > 0,
  )
  const parquetBytes = await fs.readFile(goodFile)
  const buf = parquetBytes.buffer.slice(
    parquetBytes.byteOffset,
    parquetBytes.byteOffset + parquetBytes.byteLength,
  )
  const decoded = await parquetReadObjects({ file: asyncBufferFromArrayBuffer(buf) })
  expect.that(
    'good sink: Parquet decoded to at least one row',
    decoded,
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )
  expect.that(
    'good sink: decoded row body matches the smoke payload',
    decoded[0]?.body,
    (v) => typeof v === 'string' && /local_parquet_export/.test(v),
  )

  // ----- Verify the broken sink's failure landed in the outbox -----
  const outboxDir = path.join(harness.stateDir, 'sinks', 'broken', 'outbox')
  const outboxEntries = await fs.readdir(outboxDir).catch(() => [])
  expect.that(
    'broken sink: outbox has at least one batch file',
    outboxEntries,
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )
  const outboxRaw = await fs.readFile(path.join(outboxDir, outboxEntries[0]), 'utf8')
  /** @type {any} */
  const outboxPayload = JSON.parse(outboxRaw)
  expect.that(
    'broken sink: outbox entry names the broken instance',
    outboxPayload?.sinkInstance,
    (v) => v === 'broken',
  )
  expect.that(
    'broken sink: outbox entry records a non-empty error message',
    outboxPayload?.error,
    (v) => typeof v === 'string' && v.length > 0,
  )

  // ----- Query the logs dataset back through the dispatcher -----
  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const sql = `select count(*) as n from logs where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'`
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'never', '--format', 'json'],
    {
      stdout: stdoutBuf,
      stderr: stderrBuf,
      env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath },
      kernel,
    },
  )
  expect.that('dispatch: query sql exited 0', code, (v) => v === 0)
  expect.that(
    'query: logs has exactly one row for the dev_run_id',
    JSON.parse(stdoutBuf.text())?.[0]?.n,
    (v) => Number(v) === 1,
  )

  // Give the daemon's tick loop room to fire at least once so the
  // `sink.tick` self-telemetry span lands in JSONL before we stop.
  await sleep(120)

  await handle.stop()
  await handle.done
  await obs.shutdown()

  // ----- Daemon-self-telemetry assertions -----
  const traces = await expect.traces()

  expect.that(
    'traces: source.start span emitted for otlp under daemon boot',
    traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'source.start' && t.attributes?.hyp_source === 'otlp',
    ),
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  expect.that(
    'traces: sink.tick span emitted (force from CLI)',
    traces.filter((/** @type {any} */ t) => t.name === 'sink.tick'),
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  const exportSpans = traces.filter((/** @type {any} */ t) => t.name === 'sink.export_batch')
  const goodExport = exportSpans.find(
    (/** @type {any} */ t) => t.attributes?.hyp_sink_instance === 'good',
  )
  const brokenExport = exportSpans.find(
    (/** @type {any} */ t) => t.attributes?.hyp_sink_instance === 'broken',
  )
  expect.that(
    'traces: sink.export_batch span for good instance has status=ok',
    goodExport?.attributes?.status,
    (v) => v === 'ok',
  )
  expect.that(
    'traces: sink.export_batch span for broken instance has status != ok',
    brokenExport?.attributes?.status,
    (v) => v === 'degraded' || v === 'failed',
  )

  expect.that(
    'traces: daemon.shutdown span emitted',
    traces.filter((/** @type {any} */ t) => t.name === 'daemon.shutdown'),
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  // The encoder.encode_parquet span is what produces the bytes — both
  // the good and the broken instances open it (the broken one fails
  // after — its failure surfaces during writeBlob, not encoding).
  const encodeSpans = traces.filter((/** @type {any} */ t) => t.name === 'encoder.encode_parquet')
  expect.that(
    'traces: at least one encoder.encode_parquet span emitted',
    encodeSpans,
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )
  expect.that(
    'traces: encoder.encode_parquet emitted compression=SNAPPY',
    encodeSpans[0]?.attributes?.compression,
    (v) => v === 'SNAPPY',
  )
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

/**
 * @param {string} runId
 */
function buildLogsPayload(runId) {
  const nowNs = String(BigInt(Date.now()) * 1_000_000n)
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'hypaware-smoke' } }] },
        scopeLogs: [
          {
            scope: { name: 'smoke', version: '1.0.0' },
            logRecords: [
              {
                timeUnixNano: nowNs,
                observedTimeUnixNano: nowNs,
                severityNumber: 9,
                severityText: 'INFO',
                body: { stringValue: 'local_parquet_export smoke log' },
                attributes: [{ key: 'dev_run_id', value: { stringValue: runId } }],
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * @param {string} url
 * @param {object} payload
 */
async function postOtlp(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (response.status !== 200) {
    throw new Error(`local_parquet_export: POST ${url} returned ${response.status}`)
  }
  await response.text()
}

/**
 * @param {ArrayBufferLike} buffer
 */
function asyncBufferFromArrayBuffer(buffer) {
  return {
    byteLength: buffer.byteLength,
    /** @param {number} start @param {number} [end] */
    slice(start, end) {
      return buffer.slice(start, end ?? buffer.byteLength)
    },
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeNoopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
