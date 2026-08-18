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
import { localOnlyListPath, writeLocalOnlyEntries } from '../../../src/core/usage-policy/index.js'
import { claudeBodySpoolDir } from '../../plugins-workspace/claude/src/telemetry/spool.js'

/**
 * Hermetic smoke: the OTEL-path analog of `hypignore_capture_drop`. The folder
 * usage policy decides at INGEST on the telemetry listener, before a row
 * exists, and a dropped session's spooled bodies are deleted rather than left
 * to age out of the cap.
 *
 * Boots the real daemon with `@hypaware/ai-gateway` + `@hypaware/claude`
 * (telemetry listener on a dynamic port) and drives four sessions, each with a
 * body staged in the spool the way Claude Code drops it:
 *
 *   1. `clean` - a cwd nothing governs. Its rows land and its body is
 *      projected then deleted, which is what makes the three negatives below
 *      mean something.
 *   2. `ignored` - a cwd under a `.hypignore` holding `ignore`. Zero rows in
 *      either dataset, body gone, drop signal naming the governing file.
 *   3. `private` - a cwd on the MACHINE-LOCAL list (LLP 0103) with no dotfile
 *      anywhere near it. Same outcome, governed by the list file, which is
 *      only reachable if the listener reads the list from the SHARED state
 *      root rather than its own per-plugin one.
 *   4. `hookless` - no SessionStart record at all, so no cwd and no verdict.
 *      Withheld, not recorded: this is the fail-open window LLP 0085 patches,
 *      proven closed on this path rather than reopened.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0257#testing [tests]: S25 - the privacy smoke for `.hypignore`: only
 *   clean rows land, the drop signal fires, and the ignored session's bodies
 *   are gone from the spool
 * @ref LLP 0254#policy-inline [tests]: the check runs at ingest with cwd in
 *   hand, so no row is written before the policy resolves
 * @ref LLP 0253#delete-on-drop [tests]: a dropped session's bodies are deleted,
 *   never merely skipped
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'claude_telemetry_hypignore_drop: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
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

  const cleanSession = `clean-${harness.devRunId}`
  const ignoredSession = `ignored-${harness.devRunId}`
  const privateSession = `private-${harness.devRunId}`
  const hooklessSession = `hookless-${harness.devRunId}`

  try {
    // ----- smoke_step: setup -----
    const setup = await step('setup', async () => {
      const claudeHome = path.join(harness.hypHome, 'home')
      await fs.mkdir(path.join(claudeHome, '.claude', 'projects'), { recursive: true })

      // Three scopes: one governed by a committed dotfile, one governed by the
      // machine-local list only, one governed by nothing.
      const ignoredCwd = path.join(harness.tmpDir, 'ignored-repo')
      const privateCwd = path.join(harness.tmpDir, 'private-repo')
      const cleanCwd = path.join(harness.tmpDir, 'clean-repo')
      await fs.mkdir(ignoredCwd, { recursive: true })
      await fs.mkdir(privateCwd, { recursive: true })
      await fs.mkdir(cleanCwd, { recursive: true })
      const governingFile = path.join(ignoredCwd, '.hypignore')
      await fs.writeFile(governingFile, '# self-documenting\nignore\n', 'utf8')

      // The machine-local half, written where `hyp ignore --private` writes it:
      // the SHARED state root, not the plugin's own state directory.
      const stateRoot = path.join(harness.hypHome, 'hypaware')
      await writeLocalOnlyEntries({
        stateDir: stateRoot,
        entries: [{ dir: privateCwd, class: 'ignore' }],
      })

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

      return { configPath, stateRoot, ignoredCwd, privateCwd, cleanCwd, governingFile }
    })
    const { configPath, stateRoot, ignoredCwd, privateCwd, cleanCwd, governingFile } = setup
    const env = { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath }
    const spoolDir = claudeBodySpoolDir(harness.hypHome)
    const sessionContextFile = path.join(
      stateRoot, 'plugins', '@hypaware/claude', 'session-context.jsonl'
    )

    // ----- smoke_step: boot_and_stage -----
    const listenerUrl = await step('boot_and_stage', async () => {
      handle = await runDaemon({
        hypHome: harness.hypHome,
        configPath,
        env: process.env,
        runId: harness.devRunId,
        tickIntervalMs: 50,
        installSignalHandlers: false,
      })
      const snapshot = handle.snapshot()
      const details = /** @type {{ listen_host: string, listen_port: number }} */ (
        snapshot.sources.find((s) => s.name === 'claude-telemetry')?.details
      )
      expect.that(
        'snapshot: the claude listener reports a bound port',
        details,
        (v) => v !== undefined && typeof v.listen_port === 'number' && v.listen_port > 0,
      )

      // The SessionStart hook records, exactly as an attached Claude Code would
      // have written them. `hookless` deliberately gets none.
      for (const [sessionId, cwd] of [
        [cleanSession, cleanCwd],
        [ignoredSession, ignoredCwd],
        [privateSession, privateCwd],
      ]) {
        const hookCode = await dispatch(
          ['claude-hook', 'session-context', '--state-file', sessionContextFile],
          {
            stdout: makeBuf(),
            stderr: makeBuf(),
            stdin: /** @type {any} */ (streamOf(JSON.stringify({
              session_id: sessionId,
              cwd,
              hook_event_name: 'SessionStart',
            }))),
            env,
          }
        )
        expect.that(`hook: session-context for ${sessionId} exited 0`, hookCode, (v) => v === 0)
      }

      return `http://${details.listen_host}:${details.listen_port}`
    })

    // ----- smoke_step: post_batches -----
    await step('post_batches', async () => {
      /** @type {Record<string, string>} */
      const bodies = {}
      for (const sessionId of [cleanSession, ignoredSession, privateSession, hooklessSession]) {
        const bodyPath = path.join(spoolDir, `${sessionId}-req.json`)
        await fs.mkdir(spoolDir, { recursive: true })
        await fs.writeFile(bodyPath, JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          system: [{ type: 'text', text: `system prompt for ${sessionId}` }],
          messages: [{ role: 'user', content: `body text for ${sessionId}` }],
        }), 'utf8')
        bodies[sessionId] = bodyPath
      }

      for (const sessionId of [cleanSession, ignoredSession, privateSession, hooklessSession]) {
        const posted = await postJson(`${listenerUrl}/v1/logs`, turnBatch({
          sessionId,
          userUuid: `u-${sessionId}-user`,
          assistantUuid: `u-${sessionId}-asst`,
          requestId: `req-${sessionId}`,
          promptText: `prompt from ${sessionId}`,
          responseText: `reply to ${sessionId}`,
          bodyPath: bodies[sessionId],
          withToolDecision: true,
        }))
        expect.that(`listener: the POST for ${sessionId} returned 200`, posted.status, (v) => v === 200)
      }

      // A cost data point for the ignored session: the behavioral half of the
      // record is governed by the same verdict.
      const postedMetrics = await postJson(`${listenerUrl}/v1/metrics`, metricsBatch({
        sessionId: ignoredSession,
      }))
      expect.that('listener: the ignored session\'s metrics POST returned 200', postedMetrics.status, (v) => v === 200)

      // The three suppressed sessions' bodies are GONE; the clean one's was
      // projected and then deleted, which is the same file state reached two
      // different ways - so the cache assertions below are what tell them apart.
      for (const sessionId of [ignoredSession, privateSession, hooklessSession]) {
        expect.that(
          `spool: ${sessionId}'s body was deleted unread`,
          await fileExists(bodies[sessionId]),
          (v) => v === false,
        )
      }
      expect.that(
        'spool: the clean session\'s body was projected then deleted',
        await fileExists(bodies[cleanSession]),
        (v) => v === false,
      )
      expect.that(
        'spool: nothing is left in the spool directory',
        await fs.readdir(spoolDir),
        (v) => Array.isArray(v) && v.length === 0,
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
          select session_id, role, content_text, system_text, cwd
          from ai_gateway_messages
          order by session_id, message_index
        `.trim().replace(/\s+/g, ' '),
        env,
        expect,
        label: 'message rows',
      })
      expect.that(
        'query: only the clean session recorded',
        [...new Set(messageRows.map((/** @type {any} */ r) => r.session_id))],
        (v) => JSON.stringify(v) === JSON.stringify([cleanSession]),
      )
      expect.that(
        'query: the clean rows carry the cwd the hook recorded',
        messageRows,
        (v) => v.length > 0 && v.every((/** @type {any} */ r) => r.cwd === cleanCwd),
      )
      expect.that(
        'query: no row carries a suppressed session\'s content or system text',
        messageRows,
        (v) => v.every((/** @type {any} */ r) =>
          !(r.content_text ?? '').includes(ignoredSession) &&
          !(r.content_text ?? '').includes(privateSession) &&
          !(r.content_text ?? '').includes(hooklessSession) &&
          !(r.system_text ?? '').includes(ignoredSession) &&
          !(r.system_text ?? '').includes(privateSession) &&
          !(r.system_text ?? '').includes(hooklessSession)),
      )

      const eventRows = await queryRows({
        sql: 'select session_id, event_name from claude_telemetry_events order by session_id, event_name',
        env,
        expect,
        label: 'behavioral rows',
      })
      expect.that(
        'events: only the clean session\'s behavioral rows landed',
        [...new Set(eventRows.map((/** @type {any} */ r) => r.session_id))],
        (v) => JSON.stringify(v) === JSON.stringify([cleanSession]),
      )
    })

    // ----- smoke_step: assert_signals -----
    await step('assert_signals', async () => {
      const logs = await expect.logs()
      const drops = logs.filter(
        (/** @type {any} */ l) => l.body === 'claude.telemetry.usage_policy_drop',
      )

      // @ref LLP 0257#observability [tests]: the policy drop emits a structured
      // signal naming what governed it.
      const dotfileDrops = drops.filter(
        (/** @type {any} */ l) => l.attributes?.session_id === ignoredSession,
      )
      expect.that(
        'logs: the .hypignore drop fired for the events batch and the metrics batch, naming the governing file',
        dotfileDrops,
        (v) => v.length === 2 && v.every((/** @type {any} */ l) =>
          l.attributes?.policy_source === 'usage_policy' &&
          l.attributes?.governed_by === governingFile),
      )
      expect.that(
        'logs: the .hypignore drop deleted the session\'s body',
        dotfileDrops.find((/** @type {any} */ l) => Number(l.attributes?.bodies_deleted) === 1),
        (v) => v !== undefined,
      )

      const listDrop = drops.find(
        (/** @type {any} */ l) => l.attributes?.session_id === privateSession,
      )
      expect.that(
        'logs: the machine-local list drop names the list at the SHARED state root',
        listDrop,
        (v) => v !== undefined && v.attributes?.policy_source === 'usage_policy' &&
          v.attributes?.governed_by === localOnlyListPath(stateRoot) &&
          Number(v.attributes?.bodies_deleted) === 1,
      )

      const withheld = drops.find(
        (/** @type {any} */ l) => l.attributes?.session_id === hooklessSession,
      )
      expect.that(
        'logs: the session with no hook record was withheld as undetermined, not recorded',
        withheld,
        (v) => v !== undefined && v.attributes?.policy_source === 'undetermined_cwd' &&
          v.attributes?.recovery === 'transcript_backfill',
      )

      const traces = await expect.traces()
      const receives = traces.filter((/** @type {any} */ t) => t.name === 'claude.telemetry.receive')
      const suppressed = receives.filter(
        (/** @type {any} */ t) =>
          Number(t.attributes?.events_dropped ?? 0) > 0 ||
          Number(t.attributes?.events_undetermined ?? 0) > 0,
      )
      expect.that(
        'traces: three suppressed batches plus the ignored session\'s metrics batch',
        suppressed,
        (v) => v.length === 4,
      )
      expect.that(
        'traces: every suppressed batch wrote zero message rows',
        suppressed,
        (v) => v.every((/** @type {any} */ t) => Number(t.attributes?.row_count) === 0),
      )
      expect.that(
        'traces: the clean batch wrote rows and dropped nothing',
        receives.filter((/** @type {any} */ t) => Number(t.attributes?.row_count) > 0),
        (v) => v.length === 1 && v[0].attributes?.events_dropped === undefined &&
          v[0].attributes?.events_undetermined === undefined,
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
// Fixtures + helpers (mirrors claude_telemetry_session_ignore)
// ---------------------------------------------------------------------

/**
 * One turn as Claude Code exports it: content events, the `api_request` that
 * carries usage, an `api_request_body` pointing into the spool, and a
 * behavioral event.
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
          decision: 'accept',
          source: 'config',
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
