// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability } from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * Phase 7 smoke — OpenAI `/v1` passthrough plus the Codex-specific
 * `/v1/responses` capture under the daemon boot path.
 *
 * Boots `runDaemon` with `@hypaware/ai-gateway` activated and an
 * `openai`-named upstream rooted at `/v1`. Two requests run through
 * it:
 *
 *   - `POST /v1/chat/completions` — the legacy OpenAI Chat path, a
 *     proxy of every non-streaming inference call.
 *   - `POST /v1/responses` — the OpenAI Responses API endpoint Codex
 *     uses; the response is an SSE stream so the recorder also
 *     exercises the `is_sse=true` / `stream_event_count>0` columns.
 *
 * Bead `hy-bbyi` assertions:
 *
 *   - Two rows land in `ai_gateway_messages` filterable by
 *     `dev_run_id`, with `upstream='openai'` and the original paths.
 *   - The `/v1/responses` row has `is_sse=true` and a positive
 *     `stream_event_count`.
 *   - Daemon self-telemetry (`source.start`, `sink.tick`,
 *     `cache.append`, `daemon.shutdown`) is present in JSONL.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'gateway_codex_capture: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const openai = await startOpenAiUpstream()

  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:0',
          upstreams: [
            // `path_prefix: '/v1'` is the same value `@hypaware/codex`
            // registers via `registerUpstreamPreset()` in production —
            // matches `/v1/chat/completions`, `/v1/responses`, and any
            // other Responses-API path Codex emits.
            { name: 'openai', base_url: openai.url, path_prefix: '/v1', provider: 'openai' },
          ],
        },
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

  const gatewayDetails = /** @type {{ host: string, port: number }} */ (
    handle.snapshot().sources.find((s) => s.name === 'ai-gateway')?.details
  )
  expect.that(
    'snapshot: ai-gateway bound to a loopback host:port',
    gatewayDetails,
    (v) => v !== undefined && typeof v.host === 'string' && typeof v.port === 'number',
  )
  const gatewayUrl = `http://${gatewayDetails.host}:${gatewayDetails.port}`

  // ----- 1. Non-streaming /v1/chat/completions -----
  const chatBody = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
  const chatResp = await postJson(`${gatewayUrl}/v1/chat/completions`, harness.devRunId, chatBody)
  expect.that('gateway: /v1/chat/completions returned 200', chatResp.statusCode, (v) => v === 200)

  // ----- 2. Streaming /v1/responses (the Codex contract path) -----
  const responsesBody = JSON.stringify({
    model: 'gpt-5-codex',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'help refactor' }] }],
    stream: true,
  })
  const responsesResp = await postJson(`${gatewayUrl}/v1/responses`, harness.devRunId, responsesBody)
  expect.that('gateway: /v1/responses returned 200', responsesResp.statusCode, (v) => v === 200)
  expect.that(
    'gateway: /v1/responses body looks like an SSE stream',
    responsesResp.body,
    (v) => typeof v === 'string' && v.includes('data: ') && v.includes('response.completed'),
  )

  await sleep(120)
  await handle.stop()
  await handle.done
  await obs.shutdown()
  await openai.close()

  // ----- Query the captured rows -----
  const sql = `select upstream, path, status_code, is_sse, stream_event_count from ai_gateway_messages where JSON_VALUE(metadata, '$.dev_run_id') = '${harness.devRunId}' order by ts_start`
  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'never', '--format', 'json'],
    { stdout: stdoutBuf, stderr: stderrBuf, env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath } },
  )
  expect.that('dispatch: query sql exited 0', code, (v) => v === 0)
  expect.that('stderr: query sql had no errors', stderrBuf.text(), (v) => v === '')

  /** @type {any[]} */
  const rows = JSON.parse(stdoutBuf.text())
  expect.that(
    'query: ai_gateway_messages has exactly two rows for the dev_run_id',
    rows,
    (v) => Array.isArray(v) && v.length === 2,
  )

  const byPath = new Map(rows.map((r) => [r.path, r]))
  const chat = byPath.get('/v1/chat/completions')
  const responses = byPath.get('/v1/responses')
  expect.that(
    'query: both rows carry upstream=openai',
    [chat?.upstream, responses?.upstream],
    ([a, b]) => a === 'openai' && b === 'openai',
  )
  expect.that(
    'query: /v1/chat/completions row has status_code=200 and is_sse=false',
    [chat?.status_code, chat?.is_sse],
    ([s, sse]) => Number(s) === 200 && (sse === false || sse === 0 || sse === 'false'),
  )
  expect.that(
    'query: /v1/responses row has status_code=200',
    responses?.status_code,
    (v) => Number(v) === 200,
  )
  expect.that(
    'query: /v1/responses row has is_sse=true',
    responses?.is_sse,
    (v) => v === true || v === 1 || v === 'true',
  )
  expect.that(
    'query: /v1/responses row has stream_event_count > 0',
    Number(responses?.stream_event_count),
    (v) => typeof v === 'number' && v > 0,
  )

  // ----- Daemon-self-telemetry assertions -----
  const traces = await expect.traces()

  expect.that(
    'traces: source.start span emitted for ai-gateway under the daemon boot path',
    traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'source.start' && t.attributes?.hyp_source === 'ai-gateway',
    ),
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )
  expect.that(
    'traces: at least one sink.tick fired before shutdown',
    traces.filter((/** @type {any} */ t) => t.name === 'sink.tick'),
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )
  expect.that(
    'traces: at least two cache.append spans for ai_gateway_messages',
    traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'cache.append' && t.attributes?.hyp_dataset === 'ai_gateway_messages',
    ),
    (rows) => Array.isArray(rows) && rows.length >= 2,
  )
  expect.that(
    'traces: daemon.shutdown span emitted',
    traces.filter((/** @type {any} */ t) => t.name === 'daemon.shutdown'),
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  const logs = await expect.logs()
  const exchangeLogs = logs.filter(
    (/** @type {any} */ l) =>
      l.body === 'aigw.exchange' && l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
  )
  expect.that(
    'logs: aigw.exchange logged twice tagged with the run id',
    exchangeLogs,
    (rows) => rows.length === 2,
  )
  expect.that(
    'logs: aigw.exchange for /v1/responses carries is_sse=true',
    exchangeLogs.find((/** @type {any} */ l) => l.attributes?.path === '/v1/responses')?.attributes?.is_sse,
    (v) => v === true,
  )
}

// ---------------------------------------------------------------------
// OpenAI-style upstream
// ---------------------------------------------------------------------

/**
 * Spin up an upstream that mimics the two OpenAI endpoints the smoke
 * exercises:
 *
 *   - `POST /chat/completions` — non-streaming JSON response.
 *   - `POST /responses`        — SSE stream with three events ending in
 *                                `response.completed`.
 *
 * The proxy prefix `/v1` is consumed by the gateway's path matcher;
 * the upstream sees `/chat/completions` and `/responses`.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startOpenAiUpstream() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end('{"error":"method"}')
      return
    }
    req.resume()
    req.on('end', () => {
      if (req.url === '/v1/responses' || req.url === '/responses') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        })
        res.write('event: response.created\ndata: {"id":"resp_1","status":"in_progress"}\n\n')
        res.write('event: response.output_text.delta\ndata: {"delta":"ok"}\n\n')
        res.write('event: response.completed\ndata: {"id":"resp_1","status":"completed"}\n\n')
        res.end()
        return
      }
      if (req.url === '/v1/chat/completions' || req.url === '/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"unknown path"}')
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve(undefined))
    server.listen(0, '127.0.0.1')
  })
  const addr = server.address()
  if (!addr || typeof addr !== 'object') throw new Error('openai-upstream: failed to bind')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close() {
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve(undefined))),
      )
    },
  }
}

/**
 * Issue one POST through the gateway with the contract header.
 *
 * @param {string} url
 * @param {string} runId
 * @param {string} body
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postJson(url, runId, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: Number.parseInt(parsed.port, 10),
        path: parsed.pathname + parsed.search,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'x-hyp-dev-run-id': runId,
        },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
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
