// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import { installObservability } from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { SECRET_MASK } from '../../../src/core/secret_rules.js'

/**
 * Record-time redaction smoke (LLP 0568).
 *
 * Boots `runDaemon` with `@hypaware/ai-gateway` and `@hypaware/claude`
 * against an in-process Anthropic-shaped echo upstream, then drives one
 * exchange whose prompt carries a GitHub token and whose reply carries
 * an OpenAI key. After shutdown, a local `hyp query sql` over
 * `ai_gateway_messages` must return the rows with both values masked:
 * nothing configured an export, so the only place the mask can come
 * from is the cache write. The `cache.append` span for the dataset
 * must report the redacted rows.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('record_time_redaction: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
  }

  // Built at runtime so no literal here looks like a live credential.
  const promptSecret = 'gh' + 'p_' + 'aB3'.repeat(12)
  const replySecret = 'sk-' + 'proj-' + 'aB3'.repeat(14)

  const echo = await startAnthropicEchoUpstream()
  const home = path.join(harness.hypHome, 'home')
  await fs.mkdir(home, { recursive: true })

  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:0',
          upstreams: [{ name: 'echo-anthropic', base_url: echo.url, path_prefix: '/v1/messages', priority: 1000 }],
        },
      },
      { name: '@hypaware/claude' },
    ],
    query: { cache: { retention: { default_days: 30 } } },
  }, null, 2))

  process.env.HYP_HOME = harness.hypHome
  process.env.HYP_CONFIG = configPath
  process.env.HOME = home

  const handle = await runDaemon({
    hypHome: harness.hypHome,
    configPath,
    env: process.env,
    runId: harness.devRunId,
    tickIntervalMs: 50,
    installSignalHandlers: false,
  })
  const gateway = /** @type {{ host: string, port: number }} */ (
    handle.snapshot().sources.find((s) => s.name === 'ai-gateway')?.details
  )

  const session = `redact-${harness.devRunId}`
  const resp = await postJson(`http://${gateway.host}:${gateway.port}/v1/messages`, harness.devRunId, JSON.stringify({
    model: 'claude-3-opus',
    metadata: { user_id: JSON.stringify({ session_id: session }) },
    messages: [{ role: 'user', content: `deploy with token ${promptSecret} please` }],
  }), {
    id: 'msg_redact',
    role: 'assistant',
    content: [{ type: 'text', text: `set OPENAI_API_KEY to ${replySecret} first` }],
    stop_reason: 'end_turn',
  })
  expect.that('gateway: upstream returned 200', resp.statusCode, (v) => v === 200)

  await handle.stop()
  await handle.done
  await obs.shutdown()
  await echo.close()

  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const sql = `select role, content_text, raw_frame from ai_gateway_messages where session_id = '${session}' order by message_index`
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
    { stdout: stdoutBuf, stderr: stderrBuf, env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath } },
  )
  expect.that('dispatch: query sql exited 0', code, (v) => v === 0)
  const out = stdoutBuf.text()
  /** @type {any[]} */
  let rows = []
  try { rows = JSON.parse(out) } catch { /* asserted below */ }

  expect.that('query: the exchange recorded a user and an assistant row', rows.map((r) => r.role), (v) => v.includes('user') && v.includes('assistant'))
  expect.that('query: no recorded column holds either secret', out, (v) => !v.includes(promptSecret) && !v.includes(replySecret))
  expect.that(
    'query: the user prompt is recorded with the token masked',
    rows.find((r) => r.role === 'user')?.content_text,
    (v) => v === `deploy with token ${SECRET_MASK} please`,
  )
  expect.that(
    'query: the assistant reply is recorded with the key masked',
    rows.find((r) => r.role === 'assistant')?.content_text,
    (v) => v === `set OPENAI_API_KEY to ${SECRET_MASK} first`,
  )

  // No file the cache wrote holds a secret, spool and committed data alike.
  const leaks = []
  for (const file of await listFiles(path.join(harness.hypHome, 'hypaware'))) {
    const bytes = await fs.readFile(file)
    if (bytes.includes(promptSecret) || bytes.includes(replySecret)) leaks.push(path.relative(harness.hypHome, file))
  }
  expect.that('files: nothing under the cache root holds a secret', leaks, (v) => v.length === 0)

  const traces = await expect.traces()
  expect.that(
    'traces: cache.append for ai_gateway_messages reported redacted rows',
    traces.filter((/** @type {any} */ t) => t.name === 'cache.append' && t.attributes?.hyp_dataset === 'ai_gateway_messages'),
    (spans) => spans.some((/** @type {any} */ t) => Number(t.attributes?.redacted_row_count) > 0),
  )
}

/** @param {string} dir @returns {Promise<string[]>} */
async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name))
}

/** Anthropic-shaped echo upstream playing back the assistant body from a header. */
async function startAnthropicEchoUpstream() {
  const server = http.createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      const header = req.headers['x-test-assistant-b64']
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(typeof header === 'string' ? Buffer.from(header, 'base64').toString('utf8') : '{}')
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const addr = server.address()
  if (!addr || typeof addr !== 'object') throw new Error('echo: failed to bind')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}

/**
 * @param {string} url
 * @param {string} runId
 * @param {string} body
 * @param {Record<string, unknown>} assistant
 * @returns {Promise<{ statusCode: number }>}
 */
function postJson(url, runId, body, assistant) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: Number.parseInt(parsed.port, 10),
      path: parsed.pathname,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-hyp-dev-run-id': runId,
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-cli/1.0',
        'x-test-assistant-b64': Buffer.from(JSON.stringify(assistant), 'utf8').toString('base64'),
      },
    }, (res) => {
      res.on('data', () => undefined)
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
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
