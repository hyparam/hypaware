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
 * Hermetic smoke: with the folder ask on, a folder nobody has marked is not
 * collected, a folder already recorded keeps being collected, and answering
 * a waiting folder imports its saved history.
 *
 * @ref LLP 0622#rule [tests]: end to end through the daemon, an exchange from
 *   an unmarked folder is dropped at the capture seam while the ask is on.
 * @ref LLP 0623#rule [tests]: turning the ask on marks the folder the cache
 *   already holds rows for, so its next exchange is still recorded.
 * @ref LLP 0624#rule [tests]: `hyp privacy set <folder> sync` on a waiting
 *   folder starts a real background import that lands a finished session the
 *   scheduled sweep would have left behind.
 * @ref LLP 0625#rule [tests]: a chat with no folder is recorded in the default
 *   mode and not recorded once the ask is on, dropped at the cache commit.
 *
 * Boots `runDaemon` with `@hypaware/ai-gateway` and `@hypaware/claude` against
 * an in-process Anthropic-flavored echo upstream, in three daemon phases:
 *
 *   1. **Before the ask.** One exchange from the "kept" folder is recorded
 *      under the default mode.
 *   2. **Ask on.** `hyp privacy folders ask` reports one folder kept. A second
 *      exchange from the kept folder lands; one from a brand-new folder does
 *      not, and the projector logs a `usage_policy_drop` that names no
 *      governor. Then the new folder is answered `sync`, and the saved
 *      transcript staged for it arrives through the detached import.
 *   3. **After the answer.** A fresh exchange from the answered folder lands.
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
      'ask_mode_folder_gate: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
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
  /** @type {Awaited<ReturnType<typeof startAnthropicEchoUpstream>> | undefined} */
  let echo
  /** @type {Awaited<ReturnType<typeof runDaemon>> | undefined} */
  let handle
  let obsShutDown = false

  const keptCwd = path.join(harness.tmpDir, 'kept-repo')
  const waitingCwd = path.join(harness.tmpDir, 'waiting-repo')
  const claudeHome = path.join(harness.hypHome, 'home')
  const configPath = defaultConfigPath(harness.hypHome)
  const sessions = {
    keptBefore: `kept-before-${harness.devRunId}`,
    keptAfter: `kept-after-${harness.devRunId}`,
    waitingLive: `waiting-live-${harness.devRunId}`,
    waitingSaved: `waiting-saved-${harness.devRunId}`,
    answeredLive: `answered-live-${harness.devRunId}`,
    // Neither of these ever gets a session-context record, so the projector
    // has no folder for them: they stand in for a chat with no folder.
    noFolderBefore: `no-folder-before-${harness.devRunId}`,
    noFolderAfter: `no-folder-after-${harness.devRunId}`,
  }

  /** The env every in-process CLI dispatch runs under. */
  const cliEnv = () => ({ ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath })

  /**
   * @param {string[]} argv
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
   */
  const cli = async (argv) => {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(argv, { stdout, stderr, env: cliEnv() })
    return { code, stdout: stdout.text(), stderr: stderr.text() }
  }

  /** @returns {Promise<Array<{ session_id: string, cwd: string }>>} */
  const recordedRows = async () => {
    const ids = Object.values(sessions).map((id) => `'${id}'`).join(', ')
    const res = await cli([
      'query', 'sql',
      `select session_id, cwd from ai_gateway_messages where session_id in (${ids})`,
      '--refresh', 'always', '--format', 'json',
    ])
    if (res.code !== 0) throw new Error(`query sql exited ${res.code}: ${res.stderr}`)
    return JSON.parse(res.stdout)
  }

  /** @returns {Promise<string>} the gateway URL of a freshly booted daemon */
  const bootDaemon = async () => {
    handle = await runDaemon({
      hypHome: harness.hypHome,
      configPath,
      env: process.env,
      runId: harness.devRunId,
      tickIntervalMs: 50,
      installSignalHandlers: false,
    })
    const details = /** @type {{ host: string, port: number }} */ (
      handle.snapshot().sources.find((s) => s.name === 'ai-gateway')?.details
    )
    return `http://${details.host}:${details.port}`
  }

  const stopDaemon = async () => {
    await handle?.stop()
    await handle?.done
    handle = undefined
  }

  /**
   * One exchange through the gateway for a session, then a beat so the
   * recorder drains.
   * @param {string} gatewayUrl
   * @param {string} session
   */
  const exchange = async (gatewayUrl, session) => {
    const resp = await postJson(`${gatewayUrl}/v1/messages`, harness.devRunId, JSON.stringify({
      model: 'claude-3-opus',
      metadata: { user_id: JSON.stringify({ session_id: session }) },
      messages: [{ role: 'user', content: `hello from ${session}` }],
    }), {
      id: `msg_${session}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      stop_reason: 'end_turn',
    })
    await sleep(120)
    return resp.statusCode
  }

  try {
    // ----- smoke_step: setup -----
    await step('setup', async () => {
      echo = await startAnthropicEchoUpstream()
      await fs.mkdir(path.join(claudeHome, '.claude', 'projects'), { recursive: true })
      await fs.mkdir(keptCwd, { recursive: true })
      await fs.mkdir(waitingCwd, { recursive: true })

      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, JSON.stringify({
        version: 2,
        plugins: [
          {
            name: '@hypaware/ai-gateway',
            config: {
              listen: '127.0.0.1:0',
              upstreams: [
                { name: 'echo-anthropic', base_url: echo.url, path_prefix: '/v1/messages', priority: 1000 },
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

      const stateFile = path.join(
        harness.hypHome, 'hypaware', 'plugins', '@hypaware/claude', 'session-context.jsonl'
      )
      await fs.mkdir(path.dirname(stateFile), { recursive: true })
      for (const [session, cwd] of /** @type {const} */ ([
        [sessions.keptBefore, keptCwd],
        [sessions.keptAfter, keptCwd],
        [sessions.waitingLive, waitingCwd],
        [sessions.answeredLive, waitingCwd],
      ])) {
        const code = await dispatch(
          ['claude-hook', 'session-context', '--state-file', stateFile],
          {
            stdout: makeBuf(),
            stderr: makeBuf(),
            stdin: stdinFor({ session_id: session, cwd, hook_event_name: 'SessionStart' }),
            env: cliEnv(),
          }
        )
        expect.that(`hook: session-context for ${session} exited 0`, code, (v) => v === 0)
      }
    })

    // ----- smoke_step: record_before_ask (default mode) -----
    await step('record_before_ask', async () => {
      const gatewayUrl = await bootDaemon()
      expect.that('gateway: kept-folder exchange returned 200', await exchange(gatewayUrl, sessions.keptBefore), (v) => v === 200)
      expect.that('gateway: no-folder exchange returned 200', await exchange(gatewayUrl, sessions.noFolderBefore), (v) => v === 200)
      await stopDaemon()
      const rows = await recordedRows()
      expect.that(
        'cache: the kept folder has rows before the ask is turned on',
        rows.filter((r) => r.session_id === sessions.keptBefore),
        (v) => v.length > 0 && v.every((r) => r.cwd === keptCwd),
      )
      expect.that(
        'cache: in the default mode a chat with no folder is recorded, with no folder',
        rows.filter((r) => r.session_id === sessions.noFolderBefore),
        (v) => v.length > 0 && v.every((r) => !r.cwd),
      )
    })

    // ----- smoke_step: turn_ask_on (LLP 0623: the recorded folder is kept) -----
    await step('turn_ask_on', async () => {
      const res = await cli(['privacy', 'folders', 'ask', '--json'])
      expect.that('cli: privacy folders ask exited 0', res.code, (v) => v === 0)
      /** @type {any} */
      let parsed = {}
      try { parsed = JSON.parse(res.stdout) } catch { /* asserted below */ }
      expect.that('cli: the switch reports the mode and one folder kept', parsed, (v) => v.mode === 'ask' && v.marked === 1)

      const kept = await cli(['privacy', 'show', keptCwd, '--json'])
      expect.that('cli: the kept folder is an explicit sync entry', safeJson(kept.stdout), (v) => v?.class === 'full' && v?.source === 'machine-local')
      const waiting = await cli(['privacy', 'show', waitingCwd, '--json'])
      expect.that('cli: the new folder is uncollected and governed by nothing', safeJson(waiting.stdout), (v) => v?.class === 'ignore' && v?.source === 'none')
    })

    // ----- smoke_step: gate_new_folder (LLP 0622: the unmarked folder is dropped) -----
    const gatewayUrl = await step('gate_new_folder', async () => {
      // A finished session saved on disk for the waiting folder. Staged only
      // now: under the default mode an import would rightly have taken it.
      const projectsDir = path.join(claudeHome, '.claude', 'projects', 'waiting-repo')
      await fs.mkdir(projectsDir, { recursive: true })
      const userTs = new Date(Date.now() - 60_000)
      await fs.writeFile(
        path.join(projectsDir, `${sessions.waitingSaved}.jsonl`),
        [
          JSON.stringify({
            sessionId: sessions.waitingSaved, uuid: 'u-user-1', parentUuid: null, type: 'user',
            entrypoint: 'cli', version: '1.2.3', cwd: waitingCwd,
            message: { role: 'user', content: 'an earlier question' },
            timestamp: userTs.toISOString(),
          }),
          JSON.stringify({
            sessionId: sessions.waitingSaved, uuid: 'u-asst-1', parentUuid: 'u-user-1', type: 'assistant',
            entrypoint: 'cli', requestId: 'req-saved', cwd: waitingCwd,
            message: { id: 'msg-saved', role: 'assistant', content: [{ type: 'text', text: 'an earlier answer' }], usage: { input_tokens: 3, output_tokens: 4 } },
            timestamp: new Date(userTs.getTime() + 5_000).toISOString(),
          }),
        ].join('\n') + '\n',
        'utf8'
      )

      const url = await bootDaemon()
      expect.that('gateway: kept-folder exchange still returned 200', await exchange(url, sessions.keptAfter), (v) => v === 200)
      expect.that('gateway: waiting-folder exchange returned 200 (pass-through)', await exchange(url, sessions.waitingLive), (v) => v === 200)
      expect.that('gateway: no-folder exchange returned 200 with the ask on (pass-through)', await exchange(url, sessions.noFolderAfter), (v) => v === 200)

      const rows = await recordedRows()
      expect.that(
        'cache: the kept folder is still collected with the ask on',
        rows.filter((r) => r.session_id === sessions.keptAfter),
        (v) => v.length > 0,
      )
      expect.that(
        'cache: nothing from the waiting folder was collected, live or saved',
        rows.filter((r) => r.cwd === waitingCwd),
        (v) => v.length === 0,
      )
      return url
    })

    // ----- smoke_step: answer_and_import (LLP 0624: the answer imports history) -----
    await step('answer_and_import', async () => {
      const res = await cli(['privacy', 'set', waitingCwd, 'sync'])
      expect.that('cli: privacy set exited 0', res.code, (v) => v === 0)
      expect.that('cli: the answer says the import started', res.stdout, (v) => /importing this folder's saved history in the background/.test(v))

      // The import is a real detached process. Wait for its rows, bounded.
      const deadline = Date.now() + 45_000
      /** @type {Array<{ session_id: string, cwd: string }>} */
      let saved = []
      while (Date.now() < deadline) {
        saved = (await recordedRows()).filter((r) => r.session_id === sessions.waitingSaved)
        if (saved.length > 0) break
        await sleep(500)
      }
      expect.that(
        'cache: the saved session of the answered folder was imported',
        saved,
        (v) => v.length === 2 && v.every((r) => r.cwd === waitingCwd),
      )
    })

    // ----- smoke_step: collect_after_answer (a fresh daemon collects the folder) -----
    await step('collect_after_answer', async () => {
      await stopDaemon()
      const url = await bootDaemon()
      expect.that('gateway: answered-folder exchange returned 200', await exchange(url, sessions.answeredLive), (v) => v === 200)
      await stopDaemon()
      void gatewayUrl
    })

    await obs.shutdown()
    obsShutDown = true
    await echo?.close()
    echo = undefined

    // ----- smoke_step: assert_cache -----
    await step('assert_cache', async () => {
      const rows = await recordedRows()
      const bySession = (/** @type {string} */ id) => rows.filter((r) => r.session_id === id).length
      expect.that('cache: kept folder, before the ask', bySession(sessions.keptBefore), (v) => v === 2)
      expect.that('cache: kept folder, after the ask', bySession(sessions.keptAfter), (v) => v === 2)
      expect.that('cache: the exchange sent while the folder waited was never collected', bySession(sessions.waitingLive), (v) => v === 0)
      expect.that('cache: the saved session arrived through the import', bySession(sessions.waitingSaved), (v) => v === 2)
      expect.that('cache: the answered folder is collected live', bySession(sessions.answeredLive), (v) => v === 2)
      // LLP 0625: the chat with no folder is recorded before the ask, never after.
      expect.that('cache: the no-folder chat from before the ask is still there', bySession(sessions.noFolderBefore), (v) => v === 2)
      expect.that('cache: with the ask on, the chat with no folder was not recorded', bySession(sessions.noFolderAfter), (v) => v === 0)
    })

    // ----- smoke_step: assert_signals -----
    await step('assert_signals', async () => {
      const logs = await expect.logs()
      const drops = logs.filter(
        (/** @type {any} */ l) =>
          l.body === 'plugin.claude.usage_policy_drop' && l.attributes?.operation === 'usage_policy_drop',
      )
      expect.that('logs: exactly one live exchange was dropped by the ask', drops, (v) => v.length === 1)
      expect.that(
        'logs: the drop names no governor, because nobody marked the folder',
        drops[0]?.attributes?.governed_by,
        (v) => v === undefined || v === null,
      )
      const noFolderDrops = logs.filter((/** @type {any} */ l) => l.body === 'usage_policy.no_folder_drop')
      expect.that(
        'logs: the no-folder rows were dropped at the cache commit, as a count',
        noFolderDrops,
        (v) => v.length >= 1 && v.every((/** @type {any} */ l) => Number(l.attributes?.dropped_count) > 0 && l.attributes?.session_id === undefined),
      )
      expect.that(
        'logs: the answer started a folder import',
        logs.filter((/** @type {any} */ l) => l.body === 'usage_policy.folder_import_start' && l.attributes?.status === 'ok'),
        (v) => v.length === 1,
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
