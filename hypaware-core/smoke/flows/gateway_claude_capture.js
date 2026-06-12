// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'

import { Attr, installObservability } from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * Phase 2 smoke — Claude exchange capture through the daemon.
 *
 * Boots `runDaemon` with `@hypaware/ai-gateway@2.0.0` AND
 * `@hypaware/claude@2.0.0` activated against an in-process echo
 * upstream that mimics the Anthropic Messages API. Then drives three
 * Anthropic-shaped exchanges through the gateway and asserts the
 * phase-2 contract:
 *
 *   - **Native DAG identity (transcript present)**: for the session
 *     whose JSONL transcript is staged under
 *     `<HOME>/.claude/projects/`, the projector pulls
 *     `message_id = provider_uuid = uuid`; `previous_message_id` is
 *     the gateway-filled full prior-message chain (root → `[]`, the
 *     assistant here → `[u-user-1]`).
 *   - **Fallback identity (transcript missing)**: for a different
 *     session with no transcript file, the row carries
 *     `attributes.claude.identity_source = "gateway_fallback"` and the
 *     gateway-computed hash `message_id`.
 *   - **Session-context state file**: the Claude hook (driven via
 *     `dispatch()` since this smoke doesn't run a real Claude Code
 *     install) writes `cwd` / `git_branch` into the plugin's
 *     session-context JSONL; the projector reads them back and stamps
 *     them onto every row for that session.
 *   - **Daemon self-telemetry**: `source.start` for ai-gateway,
 *     `sink.tick`, `cache.append` for `ai_gateway_messages`,
 *     `daemon.shutdown`, and the `aigw.exchange` log tagged with the
 *     contract `dev_run_id` header.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'gateway_claude_capture: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  // ----- Spin up an Anthropic-flavored echo upstream -----
  // The upstream returns a plausible Anthropic response envelope so
  // the projector's `responseBody` parse path is exercised. The id we
  // use here also doubles as the "message id hint" for the assistant
  // row when the projector matches against the transcript.
  const echo = await startAnthropicEchoUpstream()

  // ----- HOME with a Claude transcript fixture -----
  // The bead's first acceptance: native DAG identity when transcript
  // fixtures are present. Stage one transcript file with a user/assistant
  // pair whose `uuid`s we'll assert show up on the rows verbatim.
  const claudeHome = path.join(harness.hypHome, 'home')
  const claudeProjectsDir = path.join(claudeHome, '.claude', 'projects', 'some-repo')
  await fs.mkdir(claudeProjectsDir, { recursive: true })
  const transcriptSession = `tr-${harness.devRunId}`
  await fs.writeFile(
    path.join(claudeProjectsDir, `${transcriptSession}.jsonl`),
    [
      JSON.stringify({
        sessionId: transcriptSession,
        uuid: 'u-user-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: `transcript ${harness.devRunId}` },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
      JSON.stringify({
        sessionId: transcriptSession,
        uuid: 'u-assistant-1',
        parentUuid: 'u-user-1',
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_assist_1',
          content: [{ type: 'text', text: 'transcript reply' }],
        },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ].join('\n') + '\n',
    'utf8'
  )

  // ----- Stage a v2 config that picks ai-gateway + claude -----
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
            // Use a distinct name so the merge in source.js does NOT
            // collapse this entry into the Claude plugin's preset
            // (which would replace the base_url with api.anthropic.com).
            // Higher priority + identical path_prefix wins routing over
            // the preset; the projector still matches and processes
            // the captured exchange because match() looks at path +
            // headers, not the resolved upstream.
            {
              name: 'echo-anthropic',
              base_url: echo.url,
              path_prefix: '/v1/messages',
              priority: 1000,
            },
          ],
        },
      },
      { name: '@hypaware/claude' },
    ],
    query: { cache: { retention: { default_days: 30 } } },
  }, null, 2))

  process.env.HYP_HOME = harness.hypHome
  process.env.HYP_CONFIG = configPath
  process.env.HOME = claudeHome

  // ----- Compute the plugin state-file path that the Claude plugin
  // will use, then drive the hook command to populate it. This
  // mirrors how Claude Code itself would call the hook on
  // SessionStart — only the entry path differs. The kernel resolves
  // `ctx.paths.stateDir` to `<HYP_HOME>/hypaware/plugins/<name>` (see
  // `src/core/runtime/paths.js`), so we mirror that recipe here.
  const stateFile = path.join(
    harness.hypHome,
    'hypaware', 'plugins', '@hypaware/claude',
    'session-context.jsonl'
  )
  await fs.mkdir(path.dirname(stateFile), { recursive: true })

  const hookStdout = makeBuf()
  const hookStderr = makeBuf()
  const hookCode = await dispatch(
    ['claude-hook', 'session-context', '--state-file', stateFile],
    {
      stdout: hookStdout,
      stderr: hookStderr,
      stdin: stdinFor({
        session_id: transcriptSession,
        cwd: harness.tmpDir,
        transcript_path: path.join(claudeProjectsDir, `${transcriptSession}.jsonl`),
        hook_event_name: 'SessionStart',
      }),
      env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath },
    }
  )
  expect.that('hook: --state-file invocation exited 0', hookCode, (v) => v === 0)
  expect.that(
    'hook: state file got one record',
    (await fs.readFile(stateFile, 'utf8')).split('\n').filter((l) => l.length > 0).length,
    (v) => v === 1
  )

  // ----- Boot the daemon (under the new boot path) -----
  // tickIntervalMs=50 so at least one `sink.tick` span fires before stop.
  const handle = await runDaemon({
    hypHome: harness.hypHome,
    configPath,
    env: process.env,
    runId: harness.devRunId,
    tickIntervalMs: 50,
    installSignalHandlers: false,
  })

  const snapshot = handle.snapshot()
  expect.that(
    'snapshot: ai-gateway source bound to a loopback host',
    snapshot.sources.find((s) => s.name === 'ai-gateway')?.details,
    (v) => v !== undefined &&
      typeof /** @type {any} */ (v).host === 'string' &&
      typeof /** @type {any} */ (v).port === 'number',
  )
  const gatewayDetails = /** @type {{ host: string, port: number, projectors: string[] }} */ (
    snapshot.sources.find((s) => s.name === 'ai-gateway')?.details
  )
  expect.that(
    'snapshot: claude exchange projector registered against the gateway',
    gatewayDetails.projectors,
    (v) => Array.isArray(v) && v.includes('claude-anthropic-messages'),
  )

  const gatewayUrl = `http://${gatewayDetails.host}:${gatewayDetails.port}`

  // ----- Drive three exchanges through the gateway -----
  // 1. Native-DAG identity: session has a transcript fixture on disk.
  // 2. Missing-log identity: session has no transcript file.
  // 3. Context propagation: same session as #1, asserts cwd/git_branch
  //    are stamped on every row tied to the staged state-file entry.

  const transcriptBody = JSON.stringify({
    model: 'claude-3-opus',
    metadata: { user_id: JSON.stringify({ session_id: transcriptSession }) },
    messages: [{ role: 'user', content: `transcript ${harness.devRunId}` }],
  })
  const transcriptResp = await postJson(`${gatewayUrl}/v1/messages`, harness.devRunId, transcriptBody, {
    id: 'msg_assist_1',
    role: 'assistant',
    content: [{ type: 'text', text: 'transcript reply' }],
    stop_reason: 'end_turn',
  })
  expect.that('gateway: transcript-session upstream returned 200', transcriptResp.statusCode, (v) => v === 200)

  const fallbackSession = `nb-${harness.devRunId}`
  const fallbackBody = JSON.stringify({
    model: 'claude-3-opus',
    metadata: { user_id: JSON.stringify({ session_id: fallbackSession }) },
    messages: [{ role: 'user', content: `fallback ${harness.devRunId}` }],
  })
  const fallbackResp = await postJson(`${gatewayUrl}/v1/messages`, harness.devRunId, fallbackBody, {
    id: 'msg_fallback',
    role: 'assistant',
    content: [{ type: 'text', text: 'fallback reply' }],
    stop_reason: 'end_turn',
  })
  expect.that('gateway: fallback-session upstream returned 200', fallbackResp.statusCode, (v) => v === 200)

  // Wait for the in-flight sink tick interval to fire at least once so
  // the JSONL exporter captures a `sink.tick` span before shutdown.
  await sleep(120)

  // ----- Shut down the daemon (drains the gateway's recorder) -----
  await handle.stop()
  await handle.done

  // Flush observability before booting a fresh dispatch kernel for
  // the query so the JSONL files contain every daemon-emitted span
  // when `expect.traces()` reads them.
  await obs.shutdown()
  await echo.close()

  // ----- Query ai_gateway_messages -----
  const sql = `
    select
      role,
      content_text,
      message_id,
      provider_uuid,
      previous_message_id,
      cwd,
      git_branch,
      client_name,
      JSON_VALUE(attributes, '$.claude.identity_source') as claude_identity_source,
      JSON_VALUE(attributes, '$.gateway.identity_source') as gateway_identity_source,
      JSON_VALUE(attributes, '$.gateway.upstream') as upstream,
      JSON_VALUE(attributes, '$.gateway.status_code') as status_code
    from ai_gateway_messages
    where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'
    order by conversation_id, message_index
  `.trim().replace(/\s+/g, ' ')
  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
    { stdout: stdoutBuf, stderr: stderrBuf, env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath } },
  )
  expect.that('dispatch: query sql exited 0', code, (v) => v === 0)
  expect.that(
    'stderr: query sql had no errors',
    stderrBuf.text(),
    (v) => typeof v === 'string' && v.length === 0,
  )

  /** @type {any[]} */
  let rows
  try {
    rows = JSON.parse(stdoutBuf.text())
  } catch (err) {
    expect.that(
      `stdout: query sql --format json was valid JSON (${err instanceof Error ? err.message : String(err)})`,
      false,
      (v) => v === true,
    )
    return
  }

  // Expect 4 rows total: 2 per exchange (user + assistant) × 2 exchanges.
  expect.that(
    'query: ai_gateway_messages has four projected rows (2 messages × 2 exchanges)',
    rows,
    (v) => Array.isArray(v) && v.length === 4,
  )

  const transcriptRows = rows.filter((r) => r.message_id === 'u-user-1' || r.message_id === 'u-assistant-1')
  expect.that(
    'query: transcript session produced two rows with native uuid identity',
    transcriptRows,
    (v) => Array.isArray(v) && v.length === 2,
  )
  const transcriptUser = transcriptRows.find((r) => r.role === 'user')
  const transcriptAssistant = transcriptRows.find((r) => r.role === 'assistant')

  expect.that(
    'query: transcript user row → message_id == provider_uuid == "u-user-1"',
    [transcriptUser?.message_id, transcriptUser?.provider_uuid],
    (v) => Array.isArray(v) && v[0] === 'u-user-1' && v[1] === 'u-user-1',
  )
  expect.that(
    'query: transcript user row → previous_message_id is [] (root)',
    parseJson(transcriptUser?.previous_message_id),
    (v) => Array.isArray(v) && v.length === 0,
  )
  expect.that(
    'query: transcript assistant row → message_id == provider_uuid == "u-assistant-1"',
    [transcriptAssistant?.message_id, transcriptAssistant?.provider_uuid],
    (v) => Array.isArray(v) && v[0] === 'u-assistant-1' && v[1] === 'u-assistant-1',
  )
  expect.that(
    'query: transcript assistant row → previous_message_id is ["u-user-1"]',
    parseJson(transcriptAssistant?.previous_message_id),
    (v) => Array.isArray(v) && v.length === 1 && v[0] === 'u-user-1',
  )

  // Both transcript rows must carry the cwd/git_branch from the state
  // file the hook populated above.
  for (const row of transcriptRows) {
    expect.that(
      `query: transcript ${row.role} row carries cwd from state file`,
      row.cwd,
      (v) => v === harness.tmpDir,
    )
    expect.that(
      `query: transcript ${row.role} row has no claude.identity_source (native DAG path)`,
      row.claude_identity_source,
      (v) => v === undefined || v === null,
    )
    expect.that(
      `query: transcript ${row.role} row has no gateway.identity_source (projector supplied message_id)`,
      row.gateway_identity_source,
      (v) => v === undefined || v === null,
    )
  }

  // The fallback session's rows must have hash message_ids, no
  // provider_uuid, AND both fallback markers set.
  const fallbackRows = rows.filter((r) => r.message_id !== 'u-user-1' && r.message_id !== 'u-assistant-1')
  expect.that(
    'query: fallback session produced two rows',
    fallbackRows,
    (v) => Array.isArray(v) && v.length === 2,
  )
  for (const row of fallbackRows) {
    expect.that(
      `query: fallback ${row.role} row has hash message_id (not a uuid)`,
      row.message_id,
      (v) => typeof v === 'string' && v.length > 0 && v !== 'u-user-1' && v !== 'u-assistant-1',
    )
    expect.that(
      `query: fallback ${row.role} row has no provider_uuid`,
      row.provider_uuid,
      (v) => v === undefined || v === null,
    )
    expect.that(
      `query: fallback ${row.role} row marked claude.identity_source=gateway_fallback`,
      row.claude_identity_source,
      (v) => v === 'gateway_fallback',
    )
    expect.that(
      `query: fallback ${row.role} row marked gateway.identity_source=gateway_fallback`,
      row.gateway_identity_source,
      (v) => v === 'gateway_fallback',
    )
  }

  // ----- Partition layout assertions -----
  for (const row of rows) {
    expect.that(
      `query: ${row.role} row has client_name populated`,
      row.client_name,
      (v) => typeof v === 'string' && v.length > 0,
    )
  }

  // Verify rows land in new per-client/date partition layout
  const { discoverCachePartitions } = await import('../../../src/core/cache/partition.js')
  const cacheRoot = path.join(harness.hypHome, 'hypaware', 'cache')
  const partitions = await discoverCachePartitions(cacheRoot, {
    datasets: ['ai_gateway_messages'],
  })
  const clientPartitions = partitions.filter(
    (p) => p.partition.client && p.partition.date,
  )
  expect.that(
    'partitions: at least one client=*/date=* partition exists for ai_gateway_messages',
    clientPartitions,
    (v) => Array.isArray(v) && v.length >= 1,
  )
  const today = new Date().toISOString().slice(0, 10)
  const claudeToday = clientPartitions.find(
    (p) => p.partition.client === 'claude' && p.partition.date === today,
  )
  expect.that(
    `partitions: client=claude/date=${today} partition exists with rows`,
    claudeToday,
    (v) => v !== undefined && v.rowCount > 0,
  )

  // ----- Daemon-self-telemetry assertions (JSONL) -----
  const traces = await expect.traces()

  const sourceStart = traces.filter(
    (/** @type {any} */ t) => t.name === 'source.start' && t.attributes?.hyp_source === 'ai-gateway',
  )
  expect.that(
    'traces: source.start span for ai-gateway emitted under daemon boot',
    sourceStart,
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  const sinkTicks = traces.filter((/** @type {any} */ t) => t.name === 'sink.tick')
  expect.that(
    'traces: at least one sink.tick span fired during the daemon run',
    sinkTicks,
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  const cacheAppends = traces.filter(
    (/** @type {any} */ t) =>
      t.name === 'cache.append' && t.attributes?.hyp_dataset === 'ai_gateway_messages',
  )
  expect.that(
    'traces: at least two cache.append spans for ai_gateway_messages (one per exchange)',
    cacheAppends,
    (rows) => Array.isArray(rows) && rows.length >= 2,
  )

  const shutdownSpans = traces.filter((/** @type {any} */ t) => t.name === 'daemon.shutdown')
  expect.that(
    'traces: daemon.shutdown span recorded under the daemon boot path',
    shutdownSpans,
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  const logs = await expect.logs()
  const exchanges = logs.filter(
    (/** @type {any} */ l) =>
      l.body === 'aigw.exchange' && l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
  )
  expect.that(
    'logs: aigw.exchange tagged with dev_run_id for every captured request',
    exchanges,
    (rows) => Array.isArray(rows) && rows.length === 2,
  )
}

// ---------------------------------------------------------------------
// Test upstream + helpers
// ---------------------------------------------------------------------

/**
 * Echo upstream that returns the requested assistant body when the
 * caller supplies one. Mirrors Anthropic's response envelope shape so
 * the projector's `responseBody` path is exercised.
 *
 * The caller sets the assistant payload via a base64 header on the
 * request (`x-test-assistant-b64`) so the same listener can serve
 * multiple scripted responses without per-request server config.
 */
async function startAnthropicEchoUpstream() {
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const assistantHeader = req.headers['x-test-assistant-b64']
      const assistant = typeof assistantHeader === 'string'
        ? safeJson(Buffer.from(assistantHeader, 'base64').toString('utf8'))
        : { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(assistant))
    })
    req.on('error', () => res.end())
  })
  await listen(server)
  const addr = server.address()
  if (!addr || typeof addr !== 'object') throw new Error('echo: failed to bind')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => closeServer(server),
  }
}

/**
 * @param {http.Server} server
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve(undefined))
    server.listen(0, '127.0.0.1')
  })
}

/**
 * @param {http.Server} server
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve(undefined)))
  })
}

/**
 * Issue one POST through the gateway carrying the contract header
 * and (optionally) a scripted assistant body the upstream echo will
 * play back.
 *
 * @param {string} url
 * @param {string} runId
 * @param {string} body
 * @param {Record<string, unknown> | undefined} assistant
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postJson(url, runId, body, assistant) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'x-hyp-dev-run-id': runId,
      'anthropic-version': '2023-06-01',
      'user-agent': 'claude-cli/1.0',
    }
    if (assistant) {
      headers['x-test-assistant-b64'] = Buffer.from(JSON.stringify(assistant), 'utf8').toString('base64')
    }
    const req = http.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: Number.parseInt(parsed.port, 10),
        path: parsed.pathname + parsed.search,
        headers,
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

/**
 * @param {string | Record<string, unknown>} value
 */
function stdinFor(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return /** @type {NodeJS.ReadStream} */ (Readable.from([body]))
}

/** @param {string} raw */
function safeJson(raw) {
  try { return JSON.parse(raw) } catch { return undefined }
}

/** @param {unknown} raw */
function parseJson(raw) {
  if (raw == null) return raw
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return raw }
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
