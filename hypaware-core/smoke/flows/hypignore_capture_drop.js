// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'

import {
  Attr,
  installObservability,
  getLogger,
  runRoot,
} from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * Hermetic smoke: the `.hypignore` usage policy drops capture at the seam.
 *
 * @ref LLP 0049#requirements [tests]: R1/R2 end-to-end - an exchange whose
 *   resolved cwd has an ancestor .hypignore of class ignore is never written to
 *   the cache, while the live (already streamed) call is untouched.
 * @ref LLP 0050 [tests]: enforcement lives in the client adapter (the
 *   @hypaware/claude projector), proved end-to-end through the daemon.
 * @ref LLP 0053#tasks: implements plan task T5 (the hermetic smoke).
 *
 * Boots `runDaemon` with `@hypaware/ai-gateway` AND `@hypaware/claude` against
 * an in-process Anthropic-flavored echo upstream, stages two Claude sessions
 * via the session-context hook (one whose `cwd` sits under a `.hypignore`, one
 * clean), then drives one exchange from each through the gateway and asserts:
 *
 *   - **Only the clean row lands.** A query over `ai_gateway_messages` returns
 *     exactly the clean session's rows; no row carries the ignored `cwd`, and
 *     the ignored session id produced nothing.
 *   - **A `usage_policy_drop` event is emitted.** The claude projector logs
 *     `plugin.claude.usage_policy_drop` (`operation = usage_policy_drop`,
 *     `governed_by` = the ignored `.hypignore`) for the dropped exchange.
 *   - **The live call was untouched.** The gateway returned 200 for the ignored
 *     exchange and its `aigw.exchange` log records `rows_written = 0`.
 *
 * Every phase runs under a `smoke_step`-tagged root span so a failure points at
 * the broken step, per the repo's log-driven ethos.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'hypignore_capture_drop: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }
  const log = getLogger('smoke')

  /**
   * Stable `smoke_step` attribute bag for a phase.
   * @param {string} name
   * @returns {Record<string, string>}
   */
  const stepBag = (name) => ({
    [Attr.COMPONENT]: 'smoke',
    [Attr.OPERATION]: 'step',
    [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name,
    [Attr.DEV_RUN_ID]: harness.devRunId,
    status: 'ok',
  })

  /**
   * Run one phase under a `smoke_step`-tagged root span so a failure names
   * the broken step, per the repo's log-driven ethos.
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const step = (name, fn) =>
    runRoot(`smoke.step.${name}`, stepBag(name), async () => {
      log.info(`smoke step ${name}`, stepBag(name))
      return fn()
    })

  // ----- smoke_step: setup -----
  // Stage the echo upstream, the two cwds (ignored vs clean), the v2 config,
  // and the two session-context records the projector reads back per exchange.
  const setup = await step('setup', async () => {
    const echo = await startAnthropicEchoUpstream()

    // A Claude HOME with an (empty) projects dir so the plugin never reaches
    // for the developer's real `~/.claude`. Neither session has a transcript:
    // the clean one takes the gateway fallback identity, which is enough to
    // prove a row lands; the ignored one is dropped before identity matters.
    const claudeHome = path.join(harness.hypHome, 'home')
    const claudeProjectsDir = path.join(claudeHome, '.claude', 'projects', 'some-repo')
    await fs.mkdir(claudeProjectsDir, { recursive: true })

    // The ignored scope: a `.hypignore` (self-documenting, `ignore` token) at
    // the root of one repo. The clean scope is a sibling with no governing
    // file, so the ancestor walk from it resolves to `full`.
    const ignoredCwd = path.join(harness.tmpDir, 'ignored-repo')
    const cleanCwd = path.join(harness.tmpDir, 'clean-repo')
    await fs.mkdir(ignoredCwd, { recursive: true })
    await fs.mkdir(cleanCwd, { recursive: true })
    const hypignorePath = path.join(ignoredCwd, '.hypignore')
    await fs.writeFile(
      hypignorePath,
      '# HypAware: do not record work done in this directory subtree.\nignore\n',
      'utf8'
    )

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
              // Distinct name + high priority so routing prefers this echo
              // over the claude preset (which would rewrite base_url to
              // api.anthropic.com); the projector still matches on path +
              // headers and processes the captured exchange.
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

    // The kernel resolves the claude plugin's state dir to
    // `<HYP_HOME>/hypaware/plugins/<name>`; mirror that recipe and drive the
    // hook (as Claude Code would on SessionStart) once per session so the
    // projector reads each session's `cwd` back from session-context.
    const stateFile = path.join(
      harness.hypHome,
      'hypaware', 'plugins', '@hypaware/claude',
      'session-context.jsonl'
    )
    await fs.mkdir(path.dirname(stateFile), { recursive: true })

    const ignoredSession = `ignored-${harness.devRunId}`
    const cleanSession = `clean-${harness.devRunId}`
    for (const { session, cwd } of [
      { session: ignoredSession, cwd: ignoredCwd },
      { session: cleanSession, cwd: cleanCwd },
    ]) {
      const hookCode = await dispatch(
        ['claude-hook', 'session-context', '--state-file', stateFile],
        {
          stdout: makeBuf(),
          stderr: makeBuf(),
          stdin: stdinFor({
            session_id: session,
            cwd,
            hook_event_name: 'SessionStart',
          }),
          env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath },
        }
      )
      expect.that(`hook: session-context for ${session} exited 0`, hookCode, (v) => v === 0)
    }
    const stateLines = (await fs.readFile(stateFile, 'utf8'))
      .split('\n').filter((l) => l.length > 0).length
    expect.that('hook: state file got both session-context records', stateLines, (v) => v === 2)

    return { echo, configPath, ignoredCwd, cleanCwd, hypignorePath, ignoredSession, cleanSession }
  })

  const { echo, configPath, ignoredCwd, cleanCwd, hypignorePath, ignoredSession, cleanSession } = setup

  // ----- smoke_step: drive_exchanges -----
  // Boot the daemon, then send one exchange from the ignored cwd and one from
  // the clean cwd. Both must return 200 (the gateway is pass-through, R2).
  const handle = await step('drive_exchanges', async () => {
    const handle = await runDaemon({
      hypHome: harness.hypHome,
      configPath,
      env: process.env,
      runId: harness.devRunId,
      tickIntervalMs: 50,
      installSignalHandlers: false,
    })

    const snapshot = handle.snapshot()
    const gatewayDetails = /** @type {{ host: string, port: number, projectors: string[] }} */ (
      snapshot.sources.find((s) => s.name === 'ai-gateway')?.details
    )
    expect.that(
      'snapshot: claude exchange projector registered against the gateway',
      gatewayDetails?.projectors,
      (v) => Array.isArray(v) && v.includes('claude-anthropic-messages'),
    )
    const gatewayUrl = `http://${gatewayDetails.host}:${gatewayDetails.port}`

    const ignoredResp = await postJson(`${gatewayUrl}/v1/messages`, harness.devRunId, JSON.stringify({
      model: 'claude-3-opus',
      metadata: { user_id: JSON.stringify({ session_id: ignoredSession }) },
      messages: [{ role: 'user', content: `ignored ${harness.devRunId}` }],
    }), {
      id: 'msg_ignored',
      role: 'assistant',
      content: [{ type: 'text', text: 'ignored reply' }],
      stop_reason: 'end_turn',
    })
    expect.that('gateway: ignored-cwd exchange still returned 200 (pass-through)', ignoredResp.statusCode, (v) => v === 200)

    const cleanResp = await postJson(`${gatewayUrl}/v1/messages`, harness.devRunId, JSON.stringify({
      model: 'claude-3-opus',
      metadata: { user_id: JSON.stringify({ session_id: cleanSession }) },
      messages: [{ role: 'user', content: `clean ${harness.devRunId}` }],
    }), {
      id: 'msg_clean',
      role: 'assistant',
      content: [{ type: 'text', text: 'clean reply' }],
      stop_reason: 'end_turn',
    })
    expect.that('gateway: clean-cwd exchange returned 200', cleanResp.statusCode, (v) => v === 200)

    // Let at least one sink tick fire so the recorder drains before stop.
    await sleep(120)
    return handle
  })

  // ----- Shut down + flush so the JSONL artifacts are complete -----
  await handle.stop()
  await handle.done
  await obs.shutdown()
  await echo.close()

  // ----- smoke_step: assert_cache (only the clean row lands) -----
  await step('assert_cache', async () => {
    const sql = `
      select role, content_text, cwd, session_id
      from ai_gateway_messages
      where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'
      order by session_id, message_index
    `.trim().replace(/\s+/g, ' ')
    const stdoutBuf = makeBuf()
    const stderrBuf = makeBuf()
    const code = await dispatch(
      ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
      { stdout: stdoutBuf, stderr: stderrBuf, env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath } },
    )
    expect.that('dispatch: query sql exited 0', code, (v) => v === 0)
    expect.that('stderr: query sql had no errors', stderrBuf.text(), (v) => typeof v === 'string' && v.length === 0)

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

    // Exactly the clean session's two rows (user + assistant). The ignored
    // exchange was dropped at the capture seam, so it contributes nothing.
    expect.that(
      'query: ai_gateway_messages has exactly the clean session rows (2)',
      rows,
      (v) => Array.isArray(v) && v.length === 2,
    )
    expect.that(
      'query: every landed row belongs to the clean session',
      rows,
      (v) => Array.isArray(v) && v.every((r) => r.session_id === cleanSession),
    )
    expect.that(
      'query: no landed row belongs to the ignored session',
      rows,
      (v) => Array.isArray(v) && v.every((r) => r.session_id !== ignoredSession),
    )
    expect.that(
      'query: every landed row carries the clean cwd, never the ignored cwd',
      rows,
      (v) => Array.isArray(v) && v.every((r) => r.cwd === cleanCwd && r.cwd !== ignoredCwd),
    )
  })

  // ----- smoke_step: assert_drop (usage_policy_drop event emitted) -----
  await step('assert_drop', async () => {
    const logs = await expect.logs()

    const drops = logs.filter(
      (/** @type {any} */ l) =>
        l.body === 'plugin.claude.usage_policy_drop' &&
        l.attributes?.operation === 'usage_policy_drop',
    )
    expect.that(
      'logs: exactly one usage_policy_drop event for the ignored exchange',
      drops,
      (v) => Array.isArray(v) && v.length === 1,
    )
    expect.that(
      'logs: usage_policy_drop names the governing .hypignore',
      drops[0]?.attributes?.governed_by,
      (v) => v === hypignorePath,
    )

    // The live call was pass-through: the gateway recorded the ignored
    // exchange with zero rows written, and the clean one with rows.
    const exchanges = logs.filter(
      (/** @type {any} */ l) =>
        l.body === 'aigw.exchange' && l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'logs: both exchanges logged an aigw.exchange record',
      exchanges,
      (v) => Array.isArray(v) && v.length === 2,
    )
    expect.that(
      'logs: the dropped exchange wrote zero rows (capture suppressed)',
      exchanges.filter((/** @type {any} */ l) => l.attributes?.rows_written === 0),
      (v) => Array.isArray(v) && v.length === 1,
    )
    expect.that(
      'logs: the clean exchange wrote rows',
      exchanges.filter((/** @type {any} */ l) => Number(l.attributes?.rows_written) > 0),
      (v) => Array.isArray(v) && v.length === 1,
    )
  })

  // ----- smoke_step: assert_telemetry (daemon self-signal) -----
  await step('assert_telemetry', async () => {
    const traces = await expect.traces()
    const cacheAppends = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'cache.append' && t.attributes?.hyp_dataset === 'ai_gateway_messages',
    )
    // Only the clean exchange ever appends; the ignored one never reaches the
    // cache, so there is at least one append and it is for the clean session.
    expect.that(
      'traces: at least one cache.append for ai_gateway_messages (clean exchange only)',
      cacheAppends,
      (v) => Array.isArray(v) && v.length >= 1,
    )
    const shutdownSpans = traces.filter((/** @type {any} */ t) => t.name === 'daemon.shutdown')
    expect.that(
      'traces: daemon.shutdown span recorded under the daemon boot path',
      shutdownSpans,
      (v) => Array.isArray(v) && v.length >= 1,
    )
  })
}

// ---------------------------------------------------------------------
// Test upstream + helpers (mirrors gateway_claude_capture)
// ---------------------------------------------------------------------

/**
 * Echo upstream that returns the requested assistant body (set via a base64
 * header) so the projector's `responseBody` path is exercised.
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

/** @param {http.Server} server */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve(undefined))
    server.listen(0, '127.0.0.1')
  })
}

/** @param {http.Server} server */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve(undefined)))
  })
}

/**
 * Issue one POST through the gateway carrying the contract header and a
 * scripted assistant body the upstream echo plays back.
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

/** @param {string | Record<string, unknown>} value */
function stdinFor(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return /** @type {NodeJS.ReadStream} */ (Readable.from([body]))
}

/** @param {string} raw */
function safeJson(raw) {
  try { return JSON.parse(raw) } catch { return undefined }
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
