// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import { installObservability } from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { readConfigControlStatus } from '../../../src/core/config/apply.js'
import { readClientActionStatus } from '../../../src/core/config/action_reconciler.js'
import { DAEMON_RESTART_EXIT_CODE, runDaemon } from '../../../src/core/daemon/runtime.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * @import { AddressInfo } from 'node:net'
 */

/**
 * End-to-end auto-attach / reverse smoke (LLP 0044 / LLP 0045 §Part 5, T7).
 *
 * Drives the headline client-attach lifecycle against a stub central server,
 * proving the daemon wiring (T7) carries the attach handler end to end:
 *
 *   1. join → seed boot → pull rev-1 (central + ai-gateway + claude) → apply →
 *      staged restart.
 *   2. relaunch on rev-1 → first poll clears probation → the confirmation edge
 *      schedules a reconcile pass → **claude auto-attaches**: the `_hypaware`
 *      marker + the gateway `ANTHROPIC_BASE_URL` land in the client settings,
 *      and the `attach.claude` client-action marker reads `done`.
 *   3. a second confirmed boot pass (a fresh relaunch on the same rev-1) is a
 *      **no-op** — the `done` marker short-circuits, so the attach is not
 *      re-applied (the marker timestamp is unchanged).
 *   4. the server drops `@hypaware/claude` (rev-2) → apply → staged restart →
 *      relaunch without the adapter → the reconcile **reverse gap** runs the
 *      disk-driven undo: the marker is removed and the client settings are
 *      restored to their pre-attach state — the Part 5 config-drop trigger,
 *      exercised post-restart with the adapter already unloaded.
 *
 * The daemon runs in-process; the smoke plays the foreground invoker, relaunching
 * `runDaemon` whenever `handle.done` resolves with the restart exit code.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0045#part-1--the-client-seam-in-the-reconcile-context [tests] — the daemon threads clientDescriptors/clients/endpoint onto the reconcile context; a confirm-edge pass reaches the attach handler
 * @ref LLP 0045#part-5--reverse-triggers-config-drop-not-hyp-leave [tests] — a central config drop reverses the attach post-restart via the disk-driven undo
 * @ref LLP 0044#consent--join-implies-consent-default-on [tests] — a joined host confirming a config that names @hypaware/claude auto-attaches (default-on)
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'client_attach_on_join: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const fakeHome = path.join(harness.tmpDir, 'home')
  await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true })
  const claudeSettingsPath = path.join(fakeHome, '.claude', 'settings.json')
  // Seed unrelated user content so the round-trip can prove attach/reverse
  // preserves it byte-for-byte.
  const seedClaudeBody = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-seed' } }, null, 2) + '\n'
  await fs.writeFile(claudeSettingsPath, seedClaudeBody, 'utf8')

  const previousHome = process.env.HOME
  const previousClaudeHome = process.env.CLAUDE_HOME
  process.env.HOME = fakeHome
  delete process.env.CLAUDE_HOME

  process.env.HYP_HOME = harness.hypHome
  delete process.env.HYP_CONFIG
  const localConfigPath = defaultConfigPath(harness.hypHome)
  const stateRoot = path.join(harness.hypHome, 'hypaware')

  const server = await startStubCentralServer()
  try {
    // rev-1: a joined fleet config that enables the gateway + the claude client
    // adapter. Confirming it must auto-attach claude.
    server.setConfig(rev1Config(server.baseUrl), 'rev-1')

    // An empty local layer so `join` has something to leave untouched.
    await fs.writeFile(localConfigPath, JSON.stringify({ version: 2, plugins: [] }, null, 2) + '\n')

    // ----- smoke_step: join (seed the central layer) -----
    const joinOut = makeBuf()
    const joinErr = makeBuf()
    const joinCode = await dispatch(
      ['join', server.baseUrl, 'policy-token-attach', '--no-daemon'],
      { stdout: joinOut, stderr: joinErr, env: { ...process.env, HYP_HOME: harness.hypHome } }
    )
    expect.that(`join: exits 0 (stderr: ${joinErr.text()})`, joinCode, (v) => v === 0)

    // ----- smoke_step: seed_boot (bootstrap → pull → apply → restart) -----
    const firstExit = await bootOnceForRestart(harness)
    expect.that(
      `seed boot: daemon exited with the restart code (got ${firstExit})`,
      firstExit,
      (v) => v === DAEMON_RESTART_EXIT_CODE
    )

    // ----- smoke_step: auto_attach (relaunch rev-1 → confirm → attach) -----
    const attachHandle = await runDaemonHandle(harness)
    try {
      await waitFor(
        () => readConfigControlStatus({ stateRoot }).probation === null,
        15_000,
        'probation did not clear within 15s of the rev-1 relaunch'
      )
      // The confirmation edge schedules the reconcile pass that attaches claude.
      await waitFor(
        () => attachMarker(stateRoot)?.status === 'done',
        15_000,
        'the attach.claude marker did not reach done after the confirmation edge'
      )

      const attached = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8'))
      expect.that(
        'auto-attach: the _hypaware marker was written to the client settings',
        attached?._hypaware,
        (v) => v !== null && typeof v === 'object' && typeof v.port === 'number'
      )
      expect.that(
        'auto-attach: env.ANTHROPIC_BASE_URL points at the local gateway',
        attached?.env?.ANTHROPIC_BASE_URL,
        (v) => typeof v === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(v)
      )
      expect.that(
        'auto-attach: the unrelated seed key (ANTHROPIC_API_KEY) survived attach',
        attached?.env?.ANTHROPIC_API_KEY,
        (v) => v === 'sk-seed'
      )
      const doneMarker = attachMarker(stateRoot)
      expect.that(
        'auto-attach: the client-action marker reads done for the claude request key',
        doneMarker?.request_key,
        (v) => v === 'claude'
      )
    } finally {
      await attachHandle.stop()
      await attachHandle.done
    }

    // Snapshot the post-attach state for the idempotency assertion below.
    const attachedAt = attachMarker(stateRoot)?.at
    const attachedBody = await fs.readFile(claudeSettingsPath, 'utf8')

    // ----- smoke_step: no_reattach (a second confirmed boot pass is a no-op) -----
    // A fresh relaunch on the *same* rev-1 runs the after-activation
    // already-confirmed pass (probation is cleared), so desired() names claude
    // again — but the `done` marker short-circuits, so nothing is re-applied.
    const steadyHandle = await runDaemonHandle(harness)
    try {
      await waitFor(
        () => readConfigControlStatus({ stateRoot }).probation === null,
        15_000,
        'probation was unexpectedly re-armed on the steady relaunch'
      )
      // Give the boot-already-confirmed pass time to run (and prove it does not
      // re-attach): the marker timestamp must be identical.
      await sleep(500)
      expect.that(
        'no re-attach: the attach.claude marker timestamp is unchanged (done short-circuits)',
        attachMarker(stateRoot)?.at,
        (v) => v === attachedAt
      )
      expect.that(
        'no re-attach: the client settings are byte-for-byte unchanged',
        await fs.readFile(claudeSettingsPath, 'utf8'),
        (v) => v === attachedBody
      )

      // ----- smoke_step: drop_claude (serve rev-2 → apply → restart) -----
      // rev-2 drops @hypaware/claude fleet-wide; the running daemon's next poll
      // applies it and requests a staged restart.
      server.setConfig(rev2Config(server.baseUrl), 'rev-2')
      const dropExit = await withTimeout(
        steadyHandle.done,
        30_000,
        'the rev-2 drop did not request a staged restart within 30s'
      )
      expect.that(
        `drop: daemon exited with the restart code (got ${dropExit})`,
        dropExit,
        (v) => v === DAEMON_RESTART_EXIT_CODE
      )
    } finally {
      // `steadyHandle.done` already resolved (restart) — stop() is idempotent.
      await steadyHandle.stop()
    }

    // ----- smoke_step: reverse (relaunch rev-2 → reverse gap → restore) -----
    const reverseHandle = await runDaemonHandle(harness)
    try {
      await waitFor(
        () => readConfigControlStatus({ stateRoot }).probation === null,
        15_000,
        'probation did not clear within 15s of the rev-2 relaunch'
      )
      // The reverse gap removes the marker once the disk-driven undo succeeds.
      await waitFor(
        () => attachMarker(stateRoot) === undefined,
        15_000,
        'the attach.claude marker was not removed by the reverse gap'
      )

      const restored = await fs.readFile(claudeSettingsPath, 'utf8')
      expect.that(
        'reverse: the _hypaware marker was stripped from the client settings',
        JSON.parse(restored)?._hypaware,
        (v) => v === undefined
      )
      expect.that(
        'reverse: the managed ANTHROPIC_BASE_URL was removed (no prior to restore)',
        JSON.parse(restored)?.env?.ANTHROPIC_BASE_URL,
        (v) => v === undefined
      )
      expect.that(
        'reverse: the unrelated seed key (ANTHROPIC_API_KEY) survived the round-trip',
        JSON.parse(restored)?.env?.ANTHROPIC_API_KEY,
        (v) => v === 'sk-seed'
      )
    } finally {
      await reverseHandle.stop()
      await reverseHandle.done
    }
  } finally {
    await server.close()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_HOME
    else process.env.CLAUDE_HOME = previousClaudeHome
  }

  await obs.shutdown()

  // ----- smoke_step: telemetry -----
  const logs = await expect.logs()
  expect.that(
    'logs: the reconciler recorded a done attach for the claude request key',
    logs.some((/** @type {any} */ l) =>
      l.body === 'client_action.done' &&
      l.attributes?.kind === 'attach' &&
      l.attributes?.request_key === 'claude'
    ),
    (v) => v === true
  )
  expect.that(
    'logs: the reconciler recorded a reversed attach for the claude request key',
    logs.some((/** @type {any} */ l) =>
      l.body === 'client_action.reversed' &&
      l.attributes?.kind === 'attach' &&
      l.attributes?.request_key === 'claude'
    ),
    (v) => v === true
  )
}

/* ---------- served revisions ---------- */

/** @param {string} baseUrl */
function rev1Config(baseUrl) {
  return {
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:0',
          upstreams: [
            { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' },
          ],
        },
      },
      { name: '@hypaware/claude' },
    ],
    sinks: centralSink(baseUrl),
    query: { cache: { retention: { default_days: 30 } } },
  }
}

/** rev-2 is rev-1 minus the claude client plugin — the fleet-drop trigger. @param {string} baseUrl */
function rev2Config(baseUrl) {
  return {
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:0',
          upstreams: [
            { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' },
          ],
        },
      },
    ],
    sinks: centralSink(baseUrl),
    query: { cache: { retention: { default_days: 30 } } },
  }
}

/** @param {string} baseUrl */
function centralSink(baseUrl) {
  return {
    central: {
      plugin: '@hypaware/central',
      config: {
        url: baseUrl,
        identity: {},
        schedule: '0 * * * *',
        poll_interval_seconds: 5,
      },
    },
  }
}

/* ---------- daemon lifecycle helpers ---------- */

/**
 * Boot the daemon once and await its `done` — used for a boot that is expected
 * to apply a served revision and request a staged restart.
 * @param {{ hypHome: string, devRunId: string }} harness
 * @returns {Promise<number>}
 */
async function bootOnceForRestart(harness) {
  const handle = await runDaemonHandle(harness)
  return withTimeout(
    handle.done,
    30_000,
    'the boot did not request a staged restart within 30s'
  )
}

/**
 * @param {{ hypHome: string, devRunId: string }} harness
 */
async function runDaemonHandle(harness) {
  return runDaemon({
    hypHome: harness.hypHome,
    env: process.env,
    runId: harness.devRunId,
    tickIntervalMs: 0,
    installSignalHandlers: false,
  })
}

/**
 * Read the `attach.claude` client-action marker, or `undefined` when absent.
 * @param {string} stateRoot
 * @returns {{ status?: string, request_key?: string, at?: string } | undefined}
 */
function attachMarker(stateRoot) {
  const byKind = readClientActionStatus({ stateRoot }).byKind
  const attach = /** @type {Record<string, any> | undefined} */ (byKind.attach)
  return attach?.claude
}

/* ---------- stub central server (mirrors join_flow_remote_config) ---------- */

async function startStubCentralServer() {
  /** @type {Array<{ method: string, path: string, ifNoneMatch?: string, responseStatus: number }>} */
  const requests = []
  /** @type {unknown} */
  let configDoc = null
  /** @type {string} */
  let configEtag = ''

  const jwt = buildFakeJwt('gateway-attach-1')
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    /** @param {number} status @param {Record<string, string>} headers @param {string} [body] */
    function reply(status, headers, body) {
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        ...(req.headers['if-none-match'] ? { ifNoneMatch: String(req.headers['if-none-match']) } : {}),
        responseStatus: status,
      })
      res.writeHead(status, headers)
      res.end(body ?? '')
    }

    if (req.method === 'POST' && (url.pathname === '/v1/identity/bootstrap' || url.pathname === '/v1/identity/refresh')) {
      reply(200, { 'content-type': 'application/json' }, JSON.stringify({ jwt, expires_at: expiresAt }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/config') {
      if (!configDoc) {
        reply(404, { 'content-type': 'application/json' }, JSON.stringify({ error: 'no_config' }))
        return
      }
      if (req.headers['if-none-match'] === configEtag) {
        reply(304, { etag: configEtag })
        return
      }
      reply(200, { 'content-type': 'application/json', etag: configEtag }, JSON.stringify(configDoc))
      return
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/ingest/')) {
      reply(202, {})
      return
    }
    reply(404, { 'content-type': 'application/json' }, JSON.stringify({ error: 'not_found' }))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {AddressInfo} */ (server.address())

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    /** @param {unknown} doc @param {string} etag */
    setConfig(doc, etag) {
      configDoc = doc
      configEtag = etag
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

/** @param {string} sub */
function buildFakeJwt(sub) {
  /** @param {object} obj */
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub })}.smoke`
}

/* ---------- generic helpers ---------- */

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
  /** @type {NodeJS.Timeout} */
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`client_attach_on_join: ${message}`)), ms)
    }),
  ])
}

/**
 * @param {() => boolean} predicate
 * @param {number} ms
 * @param {string} message
 */
async function waitFor(predicate, ms, message) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error(`client_attach_on_join: ${message}`)
}
