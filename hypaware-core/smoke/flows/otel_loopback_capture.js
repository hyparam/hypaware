// @ts-check

import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability } from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * Phase 7 smoke: OTLP HTTP listener acceptance plus daemon
 * self-telemetry capture into local storage, under the daemon boot
 * path.
 *
 * Two arms run in one daemon lifecycle:
 *
 *   - **External OTLP acceptance.** The smoke posts one OTLP/JSON
 *     payload per signal (logs, traces, metrics) at the daemon's
 *     `@hypaware/otel` listener, tagging each row with `dev_run_id`.
 *     `hyp query sql` then reads each dataset back through the
 *     dispatcher.
 *
 *   - **Daemon self-telemetry loopback.** With `HYP_DEV_TELEMETRY=1`
 *     the kernel's JSONL exporter records every daemon-emitted span
 *     into `<state>/dev-telemetry/`: that's the "local storage" the
 *     bead asks for. The smoke asserts the expected spans landed:
 *     `source.start` (otlp), `sink.tick`, `daemon.shutdown`. No OTLP
 *     loopback into the cache is required (the kernel's exporters are
 *     JSONL-vs-OTLP mutually exclusive: see
 *     `src/core/observability/tracer.js`).
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'otel_loopback_capture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/otel',
        config: { listen_host: '127.0.0.1', listen_port: 0 },
      },
    ],
    query: { cache: { retention: { default_days: 30 } } },
  }, null, 2))

  process.env.HYP_HOME = harness.hypHome
  process.env.HYP_CONFIG = configPath

  const handle = await runDaemon({
    hypHome: harness.hypHome,
    configPath,
    env: process.env,
    runId: harness.devRunId,
    tickIntervalMs: 50,
    installSignalHandlers: false,
  })

  // Snapshot reports the bound otel host/port via the source's
  // `status().details`: that's how external OTLP clients discover it.
  const otelDetails = /** @type {{ listen_host: string, listen_port: number }} */ (
    handle.snapshot().sources.find((s) => s.name === 'otlp')?.details
  )
  expect.that(
    'snapshot: otlp source bound to a loopback host:port',
    otelDetails,
    (v) => v !== undefined && typeof v.listen_host === 'string' && typeof v.listen_port === 'number',
  )
  const baseUrl = `http://${otelDetails.listen_host}:${otelDetails.listen_port}`

  // ----- POST one payload per signal -----
  await postOtlp(`${baseUrl}/v1/logs`, buildLogsPayload(harness.devRunId))
  await postOtlp(`${baseUrl}/v1/traces`, buildTracesPayload(harness.devRunId))
  await postOtlp(`${baseUrl}/v1/metrics`, buildMetricsPayload(harness.devRunId))

  // Wait for the sink-tick interval to fire at least once so the JSONL
  // exporter captures a `sink.tick` span before the daemon stops.
  await sleep(120)

  await handle.stop()
  await handle.done
  await obs.shutdown()

  // ----- Query each dataset back through the dispatcher -----
  const env = { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath }

  const logsCount = await queryCount(env, 'logs', 'attributes', harness.devRunId)
  expect.that(
    'query: logs has one row for the dev_run_id',
    logsCount,
    (v) => v === 1,
  )

  const tracesCount = await queryCount(env, 'traces', 'attributes', harness.devRunId)
  expect.that(
    'query: traces has one row for the dev_run_id',
    tracesCount,
    (v) => v === 1,
  )

  const metricsCount = await queryCount(env, 'metrics', 'attributes', harness.devRunId)
  expect.that(
    'query: metrics has one row for the dev_run_id',
    metricsCount,
    (v) => v === 1,
  )

  // ----- Daemon self-telemetry assertions -----
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
    'traces: at least one sink.tick fired before shutdown',
    traces.filter((/** @type {any} */ t) => t.name === 'sink.tick'),
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )
  expect.that(
    'traces: daemon.shutdown span recorded',
    traces.filter((/** @type {any} */ t) => t.name === 'daemon.shutdown'),
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  // The otel plugin opens an `otel.receive` span per signal it
  // accepted. All three should be present with `dev_run_id` flowing
  // through the resource attributes the harness stamps on the run.
  const receiveSpans = traces.filter((/** @type {any} */ t) => t.name === 'otel.receive')
  const signals = new Set(receiveSpans.map((/** @type {any} */ s) => s.attributes?.signal))
  expect.that(
    'traces: otel.receive span emitted for each of logs/traces/metrics',
    signals,
    (set) => set.has('logs') && set.has('traces') && set.has('metrics'),
  )
  expect.that(
    'traces: otel.receive spans carry the dev_run_id on the resource',
    receiveSpans.map((/** @type {any} */ s) => s.resource?.dev_run_id),
    (arr) => Array.isArray(arr) && arr.length >= 3 && arr.every((v) => v === harness.devRunId),
  )

  // sentinel: ports got reaped on stop so a follow-up listener could
  // re-bind cleanly if a downstream phase wants it.
  const probe = await canBind(otelDetails.listen_host, otelDetails.listen_port)
  expect.that(
    'shutdown: otlp listener freed its port',
    probe,
    (v) => v === true,
  )
}

// ---------------------------------------------------------------------
// OTLP payload builders + helpers
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
                body: { stringValue: 'otel_loopback_capture log' },
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
 * @param {string} runId
 */
function buildTracesPayload(runId) {
  const startNs = String(BigInt(Date.now()) * 1_000_000n)
  const endNs = String(BigInt(Date.now() + 5) * 1_000_000n)
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'hypaware-smoke' } }] },
        scopeSpans: [
          {
            scope: { name: 'smoke', version: '1.0.0' },
            spans: [
              {
                traceId: '0102030405060708090a0b0c0d0e0f10',
                spanId: '1112131415161718',
                name: 'otel_loopback_capture.span',
                kind: 1,
                startTimeUnixNano: startNs,
                endTimeUnixNano: endNs,
                attributes: [{ key: 'dev_run_id', value: { stringValue: runId } }],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * @param {string} runId
 */
function buildMetricsPayload(runId) {
  const nowNs = String(BigInt(Date.now()) * 1_000_000n)
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'hypaware-smoke' } }] },
        scopeMetrics: [
          {
            scope: { name: 'smoke', version: '1.0.0' },
            metrics: [
              {
                name: 'otel_loopback_capture.counter',
                sum: {
                  isMonotonic: true,
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      asInt: '1',
                      startTimeUnixNano: nowNs,
                      timeUnixNano: nowNs,
                      attributes: [{ key: 'dev_run_id', value: { stringValue: runId } }],
                    },
                  ],
                },
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
    const text = await response.text().catch(() => '<unreadable>')
    throw new Error(`otel_loopback_capture: POST ${url} returned ${response.status}: ${text}`)
  }
  await response.text()
}

/**
 * Count rows in `dataset` filtered by `dev_run_id` via `hyp query sql`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} dataset
 * @param {string} jsonColumn   The JSON column the OTEL plugin stores `dev_run_id` under.
 * @param {string} runId
 */
async function queryCount(env, dataset, jsonColumn, runId) {
  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const sql = `select count(*) as n from ${dataset} where JSON_VALUE(${jsonColumn}, '$.dev_run_id') = '${runId}'`
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
    { stdout: stdoutBuf, stderr: stderrBuf, env },
  )
  if (code !== 0) {
    throw new Error(`hyp query sql exited ${code} for ${dataset}: ${stderrBuf.text()}`)
  }
  const parsed = JSON.parse(stdoutBuf.text())
  const n = parsed?.[0]?.n
  return typeof n === 'bigint' ? Number(n) : Number(n)
}

/**
 * @param {string} host
 * @param {number} port
 */
function canBind(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => {
      server.close()
      resolve(false)
    })
    server.listen(port, host, () => {
      server.close(() => resolve(true))
    })
  })
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
