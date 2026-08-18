// @ts-check

import fs from 'node:fs/promises'
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
import { claudeBodySpoolDir } from '../../plugins-workspace/claude/src/telemetry/spool.js'

/**
 * Hermetic smoke: the per-session opt-out (LLP 0066) reaching the claude
 * telemetry listener (LLP 0256) end to end, beside the gateway.
 *
 * Boots the real daemon with `@hypaware/ai-gateway` + `@hypaware/claude`
 * (telemetry listener on a dynamic port), then:
 *
 *   1. `hyp session ignore <id> --json` - the receipt must report BOTH
 *      recorders (the gateway by its own resolution, the listener by its
 *      `control_routes` advertisement in the live snapshot), and a direct
 *      `GET` on each control route must confirm membership, proving the
 *      gateway's own route is unaffected by the second host.
 *   2. POST the ignored session's OTLP/JSON events (content, behavioral,
 *      and body-pointer events naming a staged spool file) plus a metrics
 *      batch. NOTHING may land: zero `ai_gateway_messages` rows, zero
 *      `claude_telemetry_events` rows, and the spooled body DELETED unread
 *      (LLP 0253 #delete-on-drop), with the `usage_policy_drop` signal
 *      naming `session_opt_out`.
 *   3. A clean session's batch lands normally, isolating the drop.
 *   4. `hyp session unignore <id> --json` (both recorders again), then a
 *      resumed batch for the SAME session: its rows land and its body is
 *      projected-then-deleted, proving capture restores.
 *
 * The gateway's own capture-seam drop under this route stays pinned by
 * `session_optout_capture_drop`, which runs unchanged.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0257#testing [tests]: S25 - the privacy smoke for the control
 *   route: only clean rows land, the drop signal fires, and the ignored
 *   session's bodies are gone from the spool
 * @ref LLP 0256#cli-posts-to-both [tests]: ignoring via the CLI reaches both
 *   servers and reports each outcome
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'claude_telemetry_session_ignore: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }
  const log = getLogger('smoke')

  /**
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

  const envSnapshot = {
    HYP_HOME: process.env.HYP_HOME,
    HYP_CONFIG: process.env.HYP_CONFIG,
    HOME: process.env.HOME,
  }
  /** @type {Awaited<ReturnType<typeof runDaemon>> | undefined} */
  let handle
  let obsShutDown = false

  const ignoredSession = `optout-otel-${harness.devRunId}`
  const cleanSession = `clean-otel-${harness.devRunId}`

  try {
    // ----- smoke_step: setup -----
    const setup = await step('setup', async () => {
      const claudeHome = path.join(harness.hypHome, 'home')
      await fs.mkdir(path.join(claudeHome, '.claude', 'projects'), { recursive: true })

      const configPath = defaultConfigPath(harness.hypHome)
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, JSON.stringify({
        version: 2,
        plugins: [
          { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0' } },
          {
            name: '@hypaware/claude',
            config: { telemetry: { listen_host: '127.0.0.1', listen_port: 0 } },
          },
        ],
        query: { cache: { retention: { default_days: 30 } } },
      }, null, 2))

      process.env.HYP_HOME = harness.hypHome
      process.env.HYP_CONFIG = configPath
      process.env.HOME = claudeHome

      return { configPath }
    })
    const { configPath } = setup
    const env = { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath }
    const spoolDir = claudeBodySpoolDir(harness.hypHome)
    const stateRoot = path.join(harness.hypHome, 'hypaware')
    const sessionContextFile = path.join(
      stateRoot, 'plugins', '@hypaware/claude', 'session-context.jsonl'
    )

    // ----- smoke_step: boot_and_ignore -----
    const endpoints = await step('boot_and_ignore', async () => {
      handle = await runDaemon({
        hypHome: harness.hypHome,
        configPath,
        env: process.env,
        runId: harness.devRunId,
        tickIntervalMs: 50,
        installSignalHandlers: false,
      })
      const snapshot = handle.snapshot()
      const gatewayDetails = /** @type {{ host: string, port: number }} */ (
        snapshot.sources.find((s) => s.name === 'ai-gateway')?.details
      )
      const listenerDetails = /** @type {{ listen_host: string, listen_port: number, control_routes?: string[] }} */ (
        snapshot.sources.find((s) => s.name === 'claude-telemetry')?.details
      )
      expect.that(
        'snapshot: the gateway reports a bound port',
        gatewayDetails,
        (v) => v !== undefined && typeof v.port === 'number' && v.port > 0,
      )
      expect.that(
        'snapshot: the claude listener reports a bound port and advertises the ignore route',
        listenerDetails,
        (v) => v !== undefined && typeof v.listen_port === 'number' && v.listen_port > 0 &&
          Array.isArray(v.control_routes) && v.control_routes.includes('ignore/session'),
      )
      const gatewayUrl = `http://${gatewayDetails.host}:${gatewayDetails.port}`
      const listenerUrl = `http://${listenerDetails.listen_host}:${listenerDetails.listen_port}`

      // SessionStart hook records for both sessions, exactly as an attached
      // Claude Code would have written them (the source of cwd identity).
      for (const sessionId of [ignoredSession, cleanSession]) {
        const hookOut = makeBuf()
        const hookCode = await dispatch(
          ['claude-hook', 'session-context', '--state-file', sessionContextFile],
          {
            stdout: hookOut,
            stderr: makeBuf(),
            stdin: /** @type {any} */ (streamOf(JSON.stringify({
              session_id: sessionId,
              cwd: harness.tmpDir,
              hook_event_name: 'SessionStart',
            }))),
            env,
          }
        )
        expect.that(`hook: session-context for ${sessionId} exited 0`, hookCode, (v) => v === 0)
      }

      // The CLI mutation must reach BOTH recorders and say so.
      const ignoreOut = makeBuf()
      const ignoreErr = makeBuf()
      const ignoreCode = await dispatch(
        ['session', 'ignore', ignoredSession, '--json'],
        { stdout: ignoreOut, stderr: ignoreErr, env }
      )
      expect.that('cli: hyp session ignore exited 0', ignoreCode, (v) => v === 0)
      const receipt = JSON.parse(ignoreOut.text())
      expect.that(
        'cli: the receipt is ok with set_membership as its guarantee',
        receipt,
        (v) => v.status === 'ok' && v.guarantee === 'set_membership' && v.ignored === true,
      )
      expect.that(
        'cli: the receipt reports BOTH recorders, gateway first',
        receipt.recorders,
        (v) => Array.isArray(v) && v.length === 2 &&
          v[0].recorder === 'gateway' && v[0].status === 'ok' && v[0].endpoint === gatewayUrl &&
          v[1].recorder === 'claude-telemetry' && v[1].status === 'ok' && v[1].endpoint === listenerUrl,
      )

      // Membership confirmed on each route directly: the second host did not
      // disturb the gateway's own route, and the listener really holds the id.
      const onGateway = await controlGet(gatewayUrl, ignoredSession)
      expect.that(
        'control: the gateway route confirms membership',
        onGateway,
        (v) => v.status === 200 && v.body.ignored === true && v.body.total === 1,
      )
      const onListener = await controlGet(listenerUrl, ignoredSession)
      expect.that(
        'control: the listener route confirms membership',
        onListener,
        (v) => v.status === 200 && v.body.ignored === true && v.body.total === 1,
      )

      return { gatewayUrl, listenerUrl }
    })
    const { listenerUrl } = endpoints

    // ----- smoke_step: dropped_batch -----
    await step('dropped_batch', async () => {
      // The ignored session's body, staged the way Claude Code drops it.
      const droppedBodyPath = path.join(spoolDir, `${ignoredSession}-req.json`)
      await fs.mkdir(spoolDir, { recursive: true })
      await fs.writeFile(droppedBodyPath, JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        system: [{ type: 'text', text: 'You are the ignored session.' }],
        messages: [{ role: 'user', content: `dropped ${harness.devRunId}` }],
      }), 'utf8')

      const posted = await postJson(`${listenerUrl}/v1/logs`, turnBatch({
        sessionId: ignoredSession,
        userUuid: `u-drop-user-${harness.devRunId}`,
        assistantUuid: `u-drop-asst-${harness.devRunId}`,
        requestId: `req-drop-${harness.devRunId}`,
        promptText: `dropped ${harness.devRunId}`,
        responseText: 'dropped reply',
        bodyPath: droppedBodyPath,
        withToolDecision: true,
      }))
      expect.that('listener: the ignored session\'s POST returned 200', posted.status, (v) => v === 200)
      expect.that(
        'spool: the ignored session\'s body was DELETED, not skipped',
        await fileExists(droppedBodyPath),
        (v) => v === false,
      )

      const postedMetrics = await postJson(`${listenerUrl}/v1/metrics`, metricsBatch({
        sessionId: ignoredSession,
      }))
      expect.that('listener: the ignored session\'s metrics POST returned 200', postedMetrics.status, (v) => v === 200)

      // The clean session lands normally beside the drop.
      const cleanPosted = await postJson(`${listenerUrl}/v1/logs`, turnBatch({
        sessionId: cleanSession,
        userUuid: `u-clean-user-${harness.devRunId}`,
        assistantUuid: `u-clean-asst-${harness.devRunId}`,
        requestId: `req-clean-${harness.devRunId}`,
        promptText: `clean ${harness.devRunId}`,
        responseText: 'clean reply',
      }))
      expect.that('listener: the clean session\'s POST returned 200', cleanPosted.status, (v) => v === 200)
    })

    // ----- smoke_step: unignore_and_resume -----
    await step('unignore_and_resume', async () => {
      const unignoreOut = makeBuf()
      const unignoreCode = await dispatch(
        ['session', 'unignore', ignoredSession, '--json'],
        { stdout: unignoreOut, stderr: makeBuf(), env }
      )
      expect.that('cli: hyp session unignore exited 0', unignoreCode, (v) => v === 0)
      const receipt = JSON.parse(unignoreOut.text())
      expect.that(
        'cli: the unignore receipt reports both recorders released the id',
        receipt,
        (v) => v.status === 'ok' && Array.isArray(v.recorders) && v.recorders.length === 2 &&
          v.recorders.every((/** @type {any} */ r) => r.status === 'ok' && r.ignored === false),
      )
      const onListener = await controlGet(listenerUrl, ignoredSession)
      expect.that(
        'control: the listener route confirms the removal',
        onListener,
        (v) => v.status === 200 && v.body.ignored === false && v.body.total === 0,
      )

      // The SAME session records again: capture restored, body projected
      // then deleted like any other.
      const resumedBodyPath = path.join(spoolDir, `${ignoredSession}-resumed-req.json`)
      await fs.writeFile(resumedBodyPath, JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        system: [{ type: 'text', text: 'You are the resumed session.' }],
        messages: [{ role: 'user', content: `resumed ${harness.devRunId}` }],
      }), 'utf8')
      const resumed = await postJson(`${listenerUrl}/v1/logs`, turnBatch({
        sessionId: ignoredSession,
        userUuid: `u-resume-user-${harness.devRunId}`,
        assistantUuid: `u-resume-asst-${harness.devRunId}`,
        requestId: `req-resume-${harness.devRunId}`,
        promptText: `resumed ${harness.devRunId}`,
        responseText: 'resumed reply',
        bodyPath: resumedBodyPath,
      }))
      expect.that('listener: the resumed POST returned 200', resumed.status, (v) => v === 200)
      expect.that(
        'spool: the resumed body was projected then deleted',
        await fileExists(resumedBodyPath),
        (v) => v === false,
      )
    })

    // ----- Shut down + flush so the cache and JSONL artifacts are complete -----
    await handle?.stop()
    await handle?.done
    handle = undefined
    await obs.shutdown()
    obsShutDown = true

    // ----- smoke_step: assert_cache -----
    await step('assert_cache', async () => {
      const messageRows = await queryRows({
        sql: `
          select session_id, role, content_text, system_text
          from ai_gateway_messages
          where session_id in ('${ignoredSession}', '${cleanSession}')
          order by session_id, message_index
        `.trim().replace(/\s+/g, ' '),
        env,
        expect,
        label: 'message rows',
      })
      // 2 clean rows + 2 resumed rows; the dropped exchange contributes
      // NOTHING, in content or in system text.
      expect.that(
        'query: exactly four rows landed (clean turn + resumed turn)',
        messageRows,
        (v) => Array.isArray(v) && v.length === 4,
      )
      expect.that(
        'query: no landed row carries the dropped content or its system text',
        messageRows,
        (v) => v.every((/** @type {any} */ r) =>
          !(r.content_text ?? '').includes('dropped') &&
          !(r.system_text ?? '').includes('ignored session')),
      )
      const resumedRows = messageRows.filter((/** @type {any} */ r) => r.session_id === ignoredSession)
      expect.that(
        'query: the formerly ignored session recorded the RESUMED turn only',
        resumedRows,
        (v) => v.length === 2 && v.some((r) => (r.content_text ?? '').includes('resumed')) &&
          v.every((r) => (r.system_text ?? '') === 'You are the resumed session.'),
      )

      const eventRows = await queryRows({
        sql: `
          select session_id, event_name
          from claude_telemetry_events
          where session_id in ('${ignoredSession}', '${cleanSession}')
          order by session_id, event_name
        `.trim().replace(/\s+/g, ' '),
        env,
        expect,
        label: 'behavioral rows',
      })
      // One api_request per landed turn. The dropped batch's tool_decision,
      // api_request, and metric data point never became rows.
      expect.that(
        'events: only the clean and resumed api_request rows landed',
        eventRows.map((/** @type {any} */ r) => `${r.session_id}:${r.event_name}`),
        (v) => JSON.stringify(v) === JSON.stringify([
          `${cleanSession}:api_request`,
          `${ignoredSession}:api_request`,
        ]),
      )
    })

    // ----- smoke_step: assert_signals -----
    await step('assert_signals', async () => {
      const logs = await expect.logs()

      // @ref LLP 0257#observability [tests]: the policy drop and the
      // control-route mutation both emit structured signals.
      const drops = logs.filter(
        (/** @type {any} */ l) =>
          l.body === 'claude.telemetry.usage_policy_drop' &&
          l.attributes?.session_id === ignoredSession,
      )
      expect.that(
        'logs: the listener logged the opt-out drop for the events batch and the metrics batch',
        drops,
        (v) => Array.isArray(v) && v.length === 2 &&
          v.every((l) => l.attributes?.policy_source === 'session_opt_out'),
      )
      const eventsDrop = drops.find((/** @type {any} */ l) => Number(l.attributes?.events_dropped) === 5)
      expect.that(
        'logs: the events-batch drop counted five events and one deleted body',
        eventsDrop,
        (v) => v !== undefined && Number(v.attributes?.bodies_deleted) === 1,
      )
      const metricsDrop = drops.find((/** @type {any} */ l) => Number(l.attributes?.events_dropped) === 1)
      expect.that(
        'logs: the metrics-batch drop counted its one data point',
        metricsDrop,
        (v) => v !== undefined && Number(v.attributes?.bodies_deleted) === 0,
      )

      const mutations = logs.filter(
        (/** @type {any} */ l) => l.body === 'claude.telemetry.control.ignore_session',
      )
      expect.that(
        'logs: the listener logged both control mutations (POST then DELETE)',
        mutations.map((/** @type {any} */ l) => l.attributes?.method),
        (v) => JSON.stringify(v) === JSON.stringify(['POST', 'DELETE']),
      )

      const traces = await expect.traces()
      const dropSpans = traces.filter(
        (/** @type {any} */ t) =>
          t.name === 'claude.telemetry.receive' && Number(t.attributes?.events_dropped) > 0,
      )
      expect.that(
        'traces: the receive spans carry the drop counts (events batch + metrics batch)',
        dropSpans,
        (v) => Array.isArray(v) && v.length === 2,
      )
      const eventsSpan = dropSpans.find((/** @type {any} */ t) => t.attributes?.signal === 'logs')
      expect.that(
        'traces: the dropped events batch wrote zero rows',
        eventsSpan?.attributes,
        (v) => v !== undefined && Number(v.events_dropped) === 5 &&
          Number(v.bodies_dropped) === 1 && Number(v.row_count) === 0,
      )
    })
  } finally {
    if (handle) {
      try { await handle.stop() } catch { /* already stopping or stopped */ }
      try { await handle.done } catch { /* surface the original failure */ }
    }
    if (!obsShutDown) {
      try { await obs.shutdown() } catch { /* best-effort flush */ }
    }
    restoreEnv('HYP_HOME', envSnapshot.HYP_HOME)
    restoreEnv('HYP_CONFIG', envSnapshot.HYP_CONFIG)
    restoreEnv('HOME', envSnapshot.HOME)
  }
}

/**
 * @param {string} key
 * @param {string | undefined} value
 */
function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

// ---------------------------------------------------------------------
// Fixtures + helpers (mirrors claude_telemetry_capture)
// ---------------------------------------------------------------------

/**
 * One turn as Claude Code exports it: content events, the `api_request`
 * that carries usage, optionally an `api_request_body` pointing into the
 * spool and a `tool_decision` behavioral event.
 *
 * @param {{
 *   sessionId: string,
 *   userUuid: string,
 *   assistantUuid: string,
 *   requestId: string,
 *   promptText: string,
 *   responseText: string,
 *   bodyPath?: string,
 *   withToolDecision?: boolean,
 * }} args
 */
function turnBatch(args) {
  const common = {
    'session.id': args.sessionId,
    'app.version': '2.1.233',
    'app.entrypoint': 'sdk-cli',
    'user.account_uuid': 'c9f39145-595f-4b31-9c66-c5c658a80aed',
    'terminal.type': 'ghostty',
    'prompt.id': `p-${args.sessionId}`,
  }
  const records = [
    logRecord('user_prompt', '2026-08-17T20:30:24.450Z', {
      ...common,
      prompt_length: String(args.promptText.length),
      prompt: args.promptText,
      'message.uuid': args.userUuid,
    }),
    ...(args.bodyPath
      ? [logRecord('api_request_body', '2026-08-17T20:30:26.000Z', {
          ...common,
          body_ref: args.bodyPath,
          request_id: args.requestId,
        })]
      : []),
    ...(args.withToolDecision
      ? [logRecord('tool_decision', '2026-08-17T20:30:26.500Z', {
          ...common,
          tool_name: 'Read',
          decision: 'reject',
          source: 'user_reject',
        })]
      : []),
    logRecord('api_request', '2026-08-17T20:30:31.009Z', {
      ...common,
      model: 'claude-haiku-4-5-20251001',
      input_tokens: 73,
      output_tokens: 113,
      request_id: args.requestId,
      query_source: 'sdk',
    }),
    logRecord('assistant_response', '2026-08-17T20:30:31.100Z', {
      ...common,
      response_length: args.responseText.length,
      response: args.responseText,
      request_id: args.requestId,
      'message.uuid': args.assistantUuid,
      model: 'claude-haiku-4-5-20251001',
      query_source: 'sdk',
    }),
  ]
  return {
    resourceLogs: [
      {
        resource: { attributes: kv({ 'service.name': 'claude-code', 'service.version': '2.1.233' }) },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.233' },
            logRecords: records,
          },
        ],
      },
    ],
  }
}

/**
 * One cost data point under the Claude Code meter scope.
 *
 * @param {{ sessionId: string }} args
 */
function metricsBatch(args) {
  const nanos = String(BigInt(Date.parse('2026-08-17T20:31:00.000Z')) * 1_000_000n)
  return {
    resourceMetrics: [
      {
        resource: { attributes: kv({ 'service.name': 'claude-code', 'service.version': '2.1.233' }) },
        scopeMetrics: [
          {
            scope: { name: 'com.anthropic.claude_code', version: '2.1.233' },
            metrics: [
              {
                name: 'claude_code.cost.usage',
                unit: 'USD',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: kv({ 'session.id': args.sessionId, model: 'claude-haiku-4-5-20251001' }),
                      timeUnixNano: nanos,
                      asDouble: 0.0047732,
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
 * @param {string} name
 * @param {string} timestamp
 * @param {Record<string, unknown>} attrs
 */
function logRecord(name, timestamp, attrs) {
  const nanos = String(BigInt(Date.parse(timestamp)) * 1_000_000n)
  return {
    timeUnixNano: nanos,
    observedTimeUnixNano: nanos,
    body: { stringValue: `claude_code.${name}` },
    attributes: kv({ ...attrs, 'event.name': name, 'event.timestamp': timestamp }),
  }
}

/** @param {Record<string, unknown>} attrs */
function kv(attrs) {
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { key, value: { intValue: value } }
        : { key, value: { doubleValue: value } }
    }
    if (typeof value === 'boolean') return { key, value: { boolValue: value } }
    return { key, value: { stringValue: String(value) } }
  })
}

/**
 * @param {string} base
 * @param {string} sessionId
 * @returns {Promise<{ status: number, body: any }>}
 */
async function controlGet(base, sessionId) {
  const url = `${base}/_hypaware/ignore/session?${new URLSearchParams({ session_id: sessionId })}`
  const res = await fetch(url)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: res.status, body }
}

/**
 * @param {string} url
 * @param {unknown} payload
 */
async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  // Drain so the socket is released before the listener closes.
  await response.text()
  return response
}

/** @param {string} file */
async function fileExists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

/** @param {string} text */
function streamOf(text) {
  return Readable.from([text])
}

/**
 * @param {{ sql: string, env: any, expect: any, label: string }} args
 * @returns {Promise<any[]>}
 */
async function queryRows({ sql, env, expect, label }) {
  const out = makeBuf()
  const err = makeBuf()
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json', '--max-bytes', '0'],
    { stdout: out, stderr: err, env }
  )
  expect.that(`dispatch: query (${label}) exited 0`, code, (v) => v === 0)
  expect.that(`stderr: query (${label}) had no errors`, err.text(), (v) => typeof v === 'string' && v.length === 0)
  try {
    return JSON.parse(out.text())
  } catch (e) {
    expect.that(
      `stdout: query (${label}) was valid JSON (${e instanceof Error ? e.message : String(e)})`,
      false,
      (v) => v === true,
    )
    return []
  }
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
