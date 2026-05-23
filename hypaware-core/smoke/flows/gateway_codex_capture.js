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
 * ChatGPT `/backend-api/codex/responses` capture under the daemon boot path.
 *
 * Boots `runDaemon` with `@hypaware/ai-gateway` activated and
 * OpenAI plus ChatGPT Codex upstreams. Two requests run through it:
 *
 *   - `POST /v1/chat/completions` — the legacy OpenAI Chat path, a
 *     proxy of every non-streaming inference call.
 *   - `POST /backend-api/codex/responses` — the ChatGPT endpoint Codex
 *     Desktop uses; the response is an SSE stream so the recorder also
 *     exercises the `is_sse=true` / `stream_event_count>0` columns and
 *     Codex metadata projection.
 *
 * Bead `hy-bbyi` assertions:
 *
 *   - Four normalized rows land in `ai_gateway_messages` filterable by
 *     `dev_run_id`: user+assistant for chat completions and user+assistant
 *     for Codex Responses.
 *   - The `/backend-api/codex/responses` rows carry `is_sse=true`, a
 *     positive `stream_event_count` under `attributes.gateway`, and
 *     Codex turn metadata projected into first-class columns.
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
            // Config-driven local fakes. Names are prefixed `local-` so
            // they don't collide with the `openai` / `chatgpt` preset
            // names @hypaware/codex registers in production. Both
            // local entries appear first in the merged routing table
            // (lower seq), so with identical priority + prefix length
            // they outrank the plugin presets at routing time. The
            // plugin presets remain in the table — they just never win
            // routing for this smoke's traffic.
            { name: 'local-openai', base_url: openai.url, path_prefix: '/v1', provider: 'openai' },
            { name: 'local-chatgpt', base_url: openai.url, path_prefix: '/backend-api/codex', provider: 'chatgpt' },
          ],
        },
      },
      // Activate the Codex adapter so its exchange projector gets
      // registered. The plugin's preset upstreams (real api.openai.com
      // / chatgpt.com) are also added to the routing table but are
      // outranked by the local-* config entries above.
      { name: '@hypaware/codex', config: {} },
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

  // ----- 2. Streaming /backend-api/codex/responses (the Codex contract path) -----
  const codexWorkspace = '/Users/phil/workspace/hypaware'
  const codexThreadId = `thread-${harness.devRunId}`
  const codexSessionId = `session-${harness.devRunId}`
  const codexTurnId = `turn-${harness.devRunId}`
  const responsesBody = JSON.stringify({
    model: 'gpt-5-codex',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'help refactor' }] }],
    stream: true,
  })
  const responsesResp = await postJson(
    `${gatewayUrl}/backend-api/codex/responses`,
    harness.devRunId,
    responsesBody,
    {
      'thread-id': codexThreadId,
      'session-id': codexSessionId,
      'x-client-request-id': `client-request-${harness.devRunId}`,
      originator: 'Codex Desktop',
      'user-agent': 'Codex Desktop/0.133.0-alpha.1',
      'x-codex-window-id': `window-${harness.devRunId}`,
      'x-codex-turn-metadata': JSON.stringify({
        session_id: codexSessionId,
        thread_id: codexThreadId,
        thread_source: 'user',
        turn_id: codexTurnId,
        workspaces: {
          [codexWorkspace]: {
            associated_remote_urls: { origin: 'https://github.com/hyparam/hypaware.git' },
            latest_git_commit_hash: '072b240f2c82e15de26022a8b9bb29e13be826a9',
            has_changes: true,
          },
        },
        sandbox: 'seatbelt',
        turn_started_at_unix_ms: 1779476507669,
      }),
    }
  )
  expect.that('gateway: /backend-api/codex/responses returned 200', responsesResp.statusCode, (v) => v === 200)
  expect.that(
    'gateway: /backend-api/codex/responses body looks like an SSE stream',
    responsesResp.body,
    (v) => typeof v === 'string' && v.includes('data: ') && v.includes('response.completed'),
  )

  await sleep(120)
  await handle.stop()
  await handle.done
  await obs.shutdown()
  await openai.close()

  // ----- Query the captured rows -----
  const sql = `
    select
      provider,
      model,
      role,
      content_text,
      conversation_id,
      cwd,
      client_version,
      entrypoint,
      user_type,
      permission_mode,
      is_sidechain,
      request_id,
      prompt_id,
      JSON_VALUE(attributes, '$.gateway.path') as path,
      JSON_VALUE(attributes, '$.gateway.status_code') as status_code,
      JSON_VALUE(attributes, '$.gateway.is_sse') as is_sse,
      JSON_VALUE(attributes, '$.gateway.stream_event_count') as stream_event_count,
      JSON_VALUE(attributes, '$.codex.thread_id') as codex_thread_id,
      JSON_VALUE(attributes, '$.codex.workspace') as codex_workspace,
      JSON_VALUE(attributes, '$.codex.git_origin_url') as codex_git_origin_url
    from ai_gateway_messages
    where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'
    order by message_created_at, message_index, part_index
  `.trim().replace(/\s+/g, ' ')
  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
    { stdout: stdoutBuf, stderr: stderrBuf, env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath } },
  )
  expect.that('dispatch: query sql exited 0', code, (v) => v === 0)
  expect.that('stderr: query sql had no errors', stderrBuf.text(), (v) => v === '')

  /** @type {any[]} */
  const rows = JSON.parse(stdoutBuf.text())
  expect.that(
    'query: ai_gateway_messages has exactly four normalized rows for the dev_run_id',
    rows,
    (v) => Array.isArray(v) && v.length === 4,
  )

  const chatRows = rows.filter((r) => r.path === '/v1/chat/completions')
  const responseRows = rows.filter((r) => r.path === '/backend-api/codex/responses')
  expect.that(
    'query: /v1/chat/completions rows carry provider=openai',
    chatRows.map((r) => r.provider),
    (v) => Array.isArray(v) && v.length === 2 && v.every((provider) => provider === 'openai'),
  )
  expect.that(
    'query: /backend-api/codex/responses rows carry provider=chatgpt',
    responseRows.map((r) => r.provider),
    (v) => Array.isArray(v) && v.length === 2 && v.every((provider) => provider === 'chatgpt'),
  )
  expect.that(
    'query: /v1/chat/completions has user and assistant rows',
    chatRows.map((r) => r.role).sort(),
    (v) => Array.isArray(v) && v.join(',') === 'assistant,user',
  )
  expect.that(
    'query: /v1/chat/completions rows have status_code=200 and is_sse=false',
    chatRows,
    (v) => v.length === 2 && v.every((r) => Number(r.status_code) === 200 && (r.is_sse === false || r.is_sse === 0 || r.is_sse === 'false')),
  )
  expect.that(
    'query: /backend-api/codex/responses has user and assistant rows',
    responseRows.map((r) => r.role).sort(),
    (v) => Array.isArray(v) && v.join(',') === 'assistant,user',
  )
  expect.that(
    'query: /backend-api/codex/responses rows have is_sse=true',
    responseRows,
    (v) => v.length === 2 && v.every((r) => r.is_sse === true || r.is_sse === 1 || r.is_sse === 'true'),
  )
  expect.that(
    'query: /backend-api/codex/responses rows have stream_event_count > 0',
    responseRows,
    (v) => v.length === 2 && v.every((r) => Number(r.stream_event_count) > 0),
  )
  expect.that(
    'query: /backend-api/codex/responses rows have projected Codex columns',
    responseRows,
    (v) => v.length === 2 && v.every((r) =>
      r.conversation_id === codexThreadId &&
      r.cwd === codexWorkspace &&
      r.client_version === '0.133.0-alpha.1' &&
      r.entrypoint === 'Codex Desktop' &&
      r.user_type === 'user' &&
      r.permission_mode === 'seatbelt' &&
      (r.is_sidechain === false || r.is_sidechain === 0 || r.is_sidechain === 'false') &&
      r.request_id === 'oai-request-codex-smoke' &&
      r.prompt_id === codexTurnId &&
      r.codex_thread_id === codexThreadId &&
      r.codex_workspace === codexWorkspace &&
      r.codex_git_origin_url === 'https://github.com/hyparam/hypaware.git'
    ),
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
    'logs: aigw.exchange for /backend-api/codex/responses carries is_sse=true',
    exchangeLogs.find((/** @type {any} */ l) => l.attributes?.path === '/backend-api/codex/responses')?.attributes?.is_sse,
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
 *   - `POST /responses` and `/backend-api/codex/responses`
 *                              — SSE stream with three events ending in
 *                                `response.completed`.
 *
 * The fake upstream accepts both the OpenAI `/v1` paths and the
 * ChatGPT Codex backend path because the gateway preserves the
 * request path when forwarding.
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
      if (
        req.url === '/v1/responses' ||
        req.url === '/responses' ||
        req.url === '/backend-api/codex/responses'
      ) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'x-oai-request-id': 'oai-request-codex-smoke',
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
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postJson(url, runId, body, extraHeaders = {}) {
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
          ...extraHeaders,
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
