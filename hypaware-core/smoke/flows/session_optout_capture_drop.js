// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

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
 * Hermetic smoke: the ephemeral session opt-out (LLP 0066) end-to-end
 * through the gateway control path and the Claude adapter drop.
 *
 * @ref LLP 0066#requirements [tests]: R1/R2/R4/R5/R8 end-to-end - POSTing a
 *   session id to `/_hypaware/ignore/session` suppresses every subsequent
 *   exchange for that session at the capture seam, without altering the
 *   live (already streamed) call; DELETEing it resumes recording.
 * @ref LLP 0067#tests: mirrors `hypignore_capture_drop.js`, swapping the
 *   `.hypignore` cwd match for the gateway's in-memory ignored-session set.
 * @ref LLP 0068#tasks: implements plan task T3 (the hermetic smoke).
 *
 * Boots `runDaemon` with `@hypaware/ai-gateway` AND `@hypaware/claude` against
 * an in-process Anthropic-flavored echo upstream, then drives three exchanges
 * from the SAME session id, ignoring it in between:
 *
 *   1. `POST /_hypaware/ignore/session` for the fixture session.
 *   2. One exchange from the ignored session (dropped) and one from a
 *      different, clean session (recorded).
 *   3. `DELETE /_hypaware/ignore/session` for the fixture session.
 *   4. A second exchange from the SAME (now unignored) session id, with
 *      distinct content, to prove recording resumed rather than staying
 *      suppressed.
 *
 * Assertions:
 *
 *   - **Only the clean row and the post-unignore row land.** A query over
 *     `ai_gateway_messages` for this run finds the clean session's rows and
 *     the resumed session's rows, but never the dropped exchange's content.
 *   - **A `usage_policy_drop` event is emitted exactly once** (for the
 *     dropped exchange only), carrying `policy_source: 'session_opt_out'`.
 *   - **The live call was untouched.** The gateway returned 200 for every
 *     exchange, including the dropped one, and its `aigw.exchange` log
 *     records `rows_written = 0` only for the dropped exchange.
 *
 * Every phase runs under a `smoke_step`-tagged root span so a failure points
 * at the broken step, per the repo's log-driven ethos.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'session_optout_capture_drop: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
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

  // Track the upstream + daemon + the env keys setup mutates in an OUTER scope
  // so the finally below always tears them down, even when an assertion throws
  // mid-flow. Otherwise a failed run leaks a live daemon and echo server plus an
  // unflushed telemetry pipeline into the next smoke (and leaves HYP_HOME /
  // HYP_CONFIG / HOME pointing at this run's temp dirs).
  const envSnapshot = {
    HYP_HOME: process.env.HYP_HOME,
    HYP_CONFIG: process.env.HYP_CONFIG,
    HOME: process.env.HOME,
  }
  /** @type {Awaited<ReturnType<typeof startAnthropicEchoUpstream>> | undefined} */
  let echo
  /** @type {Awaited<ReturnType<typeof runDaemon>> | undefined} */
  let handle
  let obsShutDown = false

  try {
    // ----- smoke_step: setup -----
    // Stage the echo upstream, a Claude HOME with an (empty) projects dir, and
    // the v2 config. No `.hypignore` and no session-context hook records are
    // needed here: the session opt-out drop keys on the resolved session_id
    // ALONE (resolveClaudeSessionId from metadata.user_id.session_id), before
    // any cwd/transcript work.
    const setup = await step('setup', async () => {
      echo = await startAnthropicEchoUpstream()

      const claudeHome = path.join(harness.hypHome, 'home')
      const claudeProjectsDir = path.join(claudeHome, '.claude', 'projects', 'some-repo')
      await fs.mkdir(claudeProjectsDir, { recursive: true })

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

      const ignoredSession = `optout-${harness.devRunId}`
      const cleanSession = `clean-${harness.devRunId}`
      return { configPath, ignoredSession, cleanSession }
    })

    const { configPath, ignoredSession, cleanSession } = setup

    // ----- smoke_step: drive_exchanges -----
    // Boot the daemon, ignore the fixture session, drive the dropped + clean
    // exchanges, unignore, then drive a third exchange from the SAME (now
    // unignored) session to prove recording resumes.
    await step('drive_exchanges', async () => {
      handle = await runDaemon({
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

      const ignoreRes = await controlRequest(gatewayUrl, 'POST', ignoredSession)
      expect.that('control: POST ignore/session returned 200', ignoreRes.statusCode, (v) => v === 200)
      expect.that(
        'control: POST ignore/session reports ignored:true, total:1',
        ignoreRes.body,
        (v) => v.ignored === true && v.total === 1,
      )

      const droppedResp = await postJson(`${gatewayUrl}/v1/messages`, harness.devRunId, JSON.stringify({
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: ignoredSession }) },
        messages: [{ role: 'user', content: `dropped ${harness.devRunId}` }],
      }), {
        id: 'msg_dropped',
        role: 'assistant',
        content: [{ type: 'text', text: 'dropped reply' }],
        stop_reason: 'end_turn',
      })
      expect.that('gateway: ignored-session exchange still returned 200 (pass-through)', droppedResp.statusCode, (v) => v === 200)

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
      expect.that('gateway: clean-session exchange returned 200', cleanResp.statusCode, (v) => v === 200)

      const unignoreRes = await controlRequest(gatewayUrl, 'DELETE', ignoredSession)
      expect.that('control: DELETE ignore/session returned 200', unignoreRes.statusCode, (v) => v === 200)
      expect.that(
        'control: DELETE ignore/session reports ignored:false, total:0',
        unignoreRes.body,
        (v) => v.ignored === false && v.total === 0,
      )

      const resumedResp = await postJson(`${gatewayUrl}/v1/messages`, harness.devRunId, JSON.stringify({
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: ignoredSession }) },
        messages: [{ role: 'user', content: `resumed ${harness.devRunId}` }],
      }), {
        id: 'msg_resumed',
        role: 'assistant',
        content: [{ type: 'text', text: 'resumed reply' }],
        stop_reason: 'end_turn',
      })
      expect.that('gateway: resumed exchange (same session, post-unignore) returned 200', resumedResp.statusCode, (v) => v === 200)

      // Let at least one sink tick fire so the recorder drains before stop.
      await sleep(120)
    })

    // ----- Shut down + flush so the JSONL artifacts are complete -----
    // The assert steps below read the on-disk logs/traces, so the daemon must
    // stop and obs must flush FIRST. The finally backstops the case where a
    // failure prevents reaching here. Null out each handle as it is released so
    // the finally only acts on what the normal path left running.
    await handle?.stop()
    await handle?.done
    handle = undefined
    await obs.shutdown()
    obsShutDown = true
    await echo?.close()
    echo = undefined

    // ----- smoke_step: assert_cache (only the clean + resumed rows land) -----
    await step('assert_cache', async () => {
      const sql = `
        select role, content_text, session_id
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

      // 4 rows total: 2 (user+assistant) for the clean session, 2 for the
      // resumed exchange on the formerly-ignored session. The dropped
      // exchange contributes nothing.
      expect.that(
        'query: ai_gateway_messages has exactly 4 rows (clean session + resumed exchange)',
        rows,
        (v) => Array.isArray(v) && v.length === 4,
      )
      expect.that(
        'query: no landed row carries the dropped exchange\'s content',
        rows,
        (v) => Array.isArray(v) && v.every((r) => typeof r.content_text !== 'string' || !r.content_text.includes('dropped')),
      )
      const cleanRows = rows.filter((r) => r.session_id === cleanSession)
      expect.that('query: exactly 2 rows for the clean session', cleanRows, (v) => v.length === 2)
      const resumedRows = rows.filter((r) => r.session_id === ignoredSession)
      expect.that('query: exactly 2 rows for the formerly-ignored session (the resumed exchange)', resumedRows, (v) => v.length === 2)
      expect.that(
        'query: the formerly-ignored session\'s rows are the RESUMED exchange, not the dropped one',
        resumedRows,
        (v) => v.some((r) => typeof r.content_text === 'string' && r.content_text.includes('resumed')),
      )
    })

    // ----- smoke_step: assert_drop (usage_policy_drop event emitted once) -----
    await step('assert_drop', async () => {
      const logs = await expect.logs()

      const drops = logs.filter(
        (/** @type {any} */ l) =>
          l.body === 'plugin.claude.usage_policy_drop' &&
          l.attributes?.operation === 'usage_policy_drop',
      )
      expect.that(
        'logs: exactly one usage_policy_drop event, for the ignored exchange only',
        drops,
        (v) => Array.isArray(v) && v.length === 1,
      )
      expect.that(
        'logs: the drop carries policy_source: session_opt_out',
        drops[0]?.attributes?.policy_source,
        (v) => v === 'session_opt_out',
      )
      expect.that(
        'logs: the drop names the ignored session id',
        drops[0]?.attributes?.session_id,
        (v) => v === ignoredSession,
      )

      const gatewayDrops = logs.filter((/** @type {any} */ l) => l.body === 'aigw.usage_policy_drop')
      expect.that(
        'logs: the gateway also logs exactly one aigw.usage_policy_drop (not a no_projector_match miss)',
        gatewayDrops,
        (v) => Array.isArray(v) && v.length === 1,
      )

      // The live call was pass-through for all three exchanges: the gateway
      // recorded the dropped one with zero rows, the other two with rows.
      const exchanges = logs.filter(
        (/** @type {any} */ l) =>
          l.body === 'aigw.exchange' && l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
      )
      expect.that(
        'logs: all three exchanges logged an aigw.exchange record',
        exchanges,
        (v) => Array.isArray(v) && v.length === 3,
      )
      expect.that(
        'logs: exactly one exchange wrote zero rows (the dropped one)',
        exchanges.filter((/** @type {any} */ l) => l.attributes?.rows_written === 0),
        (v) => Array.isArray(v) && v.length === 1,
      )
      expect.that(
        'logs: the other two exchanges wrote rows (clean + resumed)',
        exchanges.filter((/** @type {any} */ l) => Number(l.attributes?.rows_written) > 0),
        (v) => Array.isArray(v) && v.length === 2,
      )
    })

    // ----- smoke_step: assert_telemetry (daemon self-signal) -----
    await step('assert_telemetry', async () => {
      const traces = await expect.traces()
      const cacheAppends = traces.filter(
        (/** @type {any} */ t) =>
          t.name === 'cache.append' && t.attributes?.hyp_dataset === 'ai_gateway_messages',
      )
      // Only the clean + resumed exchanges ever append; the dropped one never
      // reaches the cache, so there are appends but never for the drop.
      expect.that(
        'traces: at least one cache.append for ai_gateway_messages (clean + resumed exchanges only)',
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
  } finally {
    // Always release the daemon + upstream + env, even when a step threw before
    // the normal teardown ran. A failed assertion must never leave the daemon
    // or echo server running, the telemetry pipeline unflushed, or HYP_HOME /
    // HYP_CONFIG / HOME leaked into the next smoke. Each release is best-effort
    // so the original failure (not teardown noise) is what surfaces.
    if (handle) {
      try { await handle.stop() } catch { /* already stopping or stopped */ }
      try { await handle.done } catch { /* surface the original failure */ }
    }
    if (!obsShutDown) {
      try { await obs.shutdown() } catch { /* best-effort flush */ }
    }
    if (echo) {
      try { await echo.close() } catch { /* best-effort close */ }
    }
    restoreEnv('HYP_HOME', envSnapshot.HYP_HOME)
    restoreEnv('HYP_CONFIG', envSnapshot.HYP_CONFIG)
    restoreEnv('HOME', envSnapshot.HOME)
  }
}

/**
 * Restore a `process.env` key to a snapshot value, deleting it when the
 * snapshot was unset (assigning `undefined` coerces to the string "undefined").
 *
 * @param {string} key
 * @param {string | undefined} value
 */
function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

// ---------------------------------------------------------------------
// Test upstream + helpers (mirrors hypignore_capture_drop / gateway_claude_capture)
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
 * Issue one POST/DELETE against `/_hypaware/ignore/session` and return the
 * parsed `{ session_id, ignored, total }` body.
 *
 * @param {string} gatewayUrl
 * @param {'POST' | 'DELETE'} method
 * @param {string} sessionId
 * @returns {Promise<{ statusCode: number, body: any }>}
 */
function controlRequest(gatewayUrl, method, sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ session_id: sessionId })
    const parsed = new URL(`${gatewayUrl}/_hypaware/ignore/session`)
    const req = http.request(
      {
        method,
        hostname: parsed.hostname,
        port: Number.parseInt(parsed.port, 10),
        path: parsed.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: safeJson(Buffer.concat(chunks).toString('utf8')) })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
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
