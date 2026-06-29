// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'

/**
 * Phase 8.1 smoke. Boots `@hypaware/otel` from the in-repo workspace
 * with `listen_port: 0`, POSTs one OTLP/JSON log payload to the bound
 * listener (carrying `attributes.dev_run_id`), and asserts the §Phase
 * 8.1 contract from the implementation plan:
 *
 * - query: `select count(*) from logs where JSON_VALUE(attributes,
 *   '$.dev_run_id') = '<run-id>'` returns 1
 * - traces: exactly one `source.start` span tagged
 *   `hyp_plugin=@hypaware/otel` with `listen_host`/`listen_port`
 *   attributes captured at bind time
 * - traces: an `otel.receive` span with `status=ok`, `signal=logs`,
 *   `payload_bytes>0`, `row_count=1` following the `source.start` span
 * - traces: at least one `cache.append` for `hyp_dataset=logs`
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0012#source-kinds [tests] - OTLP receiver source ingests a signal and writes cache rows
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'otel_listener_writes_rows: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginDir = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'plugins-workspace',
    'otel'
  )
  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'otel_activate',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded } = await loadManifests([pluginDir])
      const entries = loaded.map((l) => ({
        manifest: l.manifest,
        rootDir: l.rootDir,
        config: { listen_host: '127.0.0.1', listen_port: 0 },
      }))
      return activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
    }
  )

  // The activate() in `@hypaware/otel` auto-starts the source via
  // `ctx.sources.start('otlp', ctx)`, so the kernel has already opened
  // the listener by the time activatePlugins resolves.
  const started = kernel.sources.started('otlp')
  if (!started) {
    throw new Error('otel_listener_writes_rows: source `otlp` not started after activate')
  }
  const status = await /** @type {NonNullable<typeof started.status>} */ (started.status)()
  const details = /** @type {{ listen_host?: string, listen_port?: number }} */ (status.details ?? {})
  const listenHost = details.listen_host
  const listenPort = details.listen_port
  if (typeof listenHost !== 'string' || typeof listenPort !== 'number') {
    throw new Error(
      `otel_listener_writes_rows: expected listen_host/listen_port in status.details, got ${JSON.stringify(status.details)}`
    )
  }

  const payload = buildOtlpLogPayload(harness.devRunId)
  const postResponse = await fetch(`http://${listenHost}:${listenPort}/v1/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  expect.that(
    'otlp POST: server returned 200',
    postResponse.status,
    (v) => v === 200
  )

  // Drain the response body so the connection is released cleanly
  // before kernel shutdown.
  await postResponse.text()

  // Run `hyp query sql` against the `logs` dataset to count the row
  // we just POSTed in. `--refresh always` mirrors the bead's SQL, even
  // though the otel dataset's `refreshPartition` is a no-op (data
  // landed in the cache via `storage.appendRows` during the receive).
  const sqlStdout = makeBuf()
  const sqlStderr = makeBuf()
  const sqlCode = await dispatch(
    [
      'query',
      'sql',
      `select count(*) as n from logs where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'`,
      '--refresh',
      'always',
      '--format',
      'json',
    ],
    { stdout: sqlStdout, stderr: sqlStderr, kernel, registry, env: smokeEnv(harness) }
  )
  expect.that('dispatch: query sql exited 0', sqlCode, (v) => v === 0)
  expect.that(
    'stderr: query sql had no errors',
    sqlStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )

  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(sqlStdout.text())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    expect.that(
      `stdout: query sql --format json was valid JSON (parse error: ${message})`,
      false,
      (v) => v === true
    )
    return
  }
  expect.that(
    'stdout: json result is an array with exactly one row',
    parsed,
    (v) => Array.isArray(v) && v.length === 1
  )
  const count = parsed?.[0]?.n
  expect.that(
    'stdout: select count(*) returned 1 (the smoke POSTed exactly one log)',
    count,
    (v) => v === 1 || v === '1' || (typeof v === 'bigint' && Number(v) === 1)
  )

  // Stop the source before flushing telemetry so the
  // server.close() span (if any) lands in the same JSONL batch.
  await kernel.sources.stop('otlp')

  await obs.shutdown()

  const traces = await expect.traces()

  const startSpans = traces.filter(
    (/** @type {any} */ t) => t.name === 'source.start' && t.attributes?.[Attr.PLUGIN] === '@hypaware/otel'
  )
  expect.that(
    'traces: exactly one source.start span for @hypaware/otel',
    startSpans,
    (rows) => rows.length === 1
  )
  expect.that(
    'traces: source.start tagged hyp_source=otlp',
    startSpans[0]?.attributes?.hyp_source,
    (v) => v === 'otlp'
  )
  expect.that(
    'traces: source.start carries listen_host',
    startSpans[0]?.attributes?.listen_host,
    (v) => v === listenHost
  )
  expect.that(
    'traces: source.start carries listen_port matching bound port',
    startSpans[0]?.attributes?.listen_port,
    (v) => v === listenPort
  )

  const receiveSpans = traces.filter(
    (/** @type {any} */ t) =>
      t.name === 'otel.receive' && t.attributes?.[Attr.PLUGIN] === '@hypaware/otel'
  )
  expect.that(
    'traces: exactly one otel.receive span for @hypaware/otel',
    receiveSpans,
    (rows) => rows.length === 1
  )
  expect.that(
    'traces: otel.receive tagged signal=logs',
    receiveSpans[0]?.attributes?.signal,
    (v) => v === 'logs'
  )
  expect.that(
    'traces: otel.receive status=ok',
    receiveSpans[0]?.attributes?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: otel.receive row_count=1',
    receiveSpans[0]?.attributes?.row_count,
    (v) => v === 1
  )
  expect.that(
    'traces: otel.receive payload_bytes>0',
    receiveSpans[0]?.attributes?.payload_bytes,
    (v) => typeof v === 'number' && v > 0
  )

  // Ordering check: the receive span must have started AFTER the
  // listener bound. Compare hrtime start timestamps surfaced by the
  // JSONL exporter via the ISO `startTimestamp`.
  expect.that(
    'traces: otel.receive started after source.start',
    [startSpans[0]?.startTimestamp, receiveSpans[0]?.startTimestamp],
    ([startTs, receiveTs]) =>
      typeof startTs === 'string' &&
      typeof receiveTs === 'string' &&
      startTs <= receiveTs
  )

  const cacheAppends = traces.filter(
    (/** @type {any} */ t) =>
      t.name === 'cache.append' && t.attributes?.hyp_dataset === 'logs'
  )
  expect.that(
    'traces: at least one cache.append for logs',
    cacheAppends,
    (rows) => rows.length >= 1
  )
}

/**
 * Build a minimal valid OTLP/JSON logs payload with `dev_run_id` set
 * in the log record's `attributes`. The harness pipes the run id
 * through so the smoke can `select count(*) ... where dev_run_id=...`
 * without colliding with rows from a previous smoke that shared the
 * same on-disk cache (we don't, but the assertion is still strict).
 *
 * @param {string} devRunId
 */
function buildOtlpLogPayload(devRunId) {
  const nowNs = String(BigInt(Date.now()) * 1_000_000n)
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'hypaware-smoke' } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: 'smoke', version: '1.0.0' },
            logRecords: [
              {
                timeUnixNano: nowNs,
                observedTimeUnixNano: nowNs,
                severityNumber: 9,
                severityText: 'INFO',
                body: { stringValue: 'otel_listener_writes_rows smoke' },
                attributes: [
                  { key: 'dev_run_id', value: { stringValue: devRunId } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * @param {{ hypHome: string }} harness
 */
function smokeEnv(harness) {
  return { ...process.env, HYP_HOME: harness.hypHome }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
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
