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
import { readStatusFile, resolveLiveGatewayEndpointFromStatus } from '../../../src/core/daemon/status.js'
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
 *      marker + the LLP 0258 telemetry env block land in the client settings
 *      (`otel` mode: the base URL is never written), and the `attach.claude`
 *      client-action marker reads `done`.
 *   3. a second confirmed boot pass (a fresh relaunch on the same rev-1) hits
 *      the **drift** branch of the freshness check: rev-1 lets the gateway bind
 *      an ephemeral port, so the relaunch is at a *new* endpoint, the `done`
 *      marker is stale, and the forward gap re-attaches at the new port.
 *   4. rev-1b pins the gateway's `listen` to the port the drifted daemon is
 *      already bound to (read back from its own `status.json`) → apply →
 *      staged restart → the relaunch reclaims that same port, so it is the
 *      **no-op** branch: the `done` marker short-circuits and nothing is
 *      re-applied (the marker timestamp and the client settings are unchanged).
 *   5. the server drops `@hypaware/claude` (rev-2) → apply → staged restart →
 *      relaunch without the adapter → the reconcile **reverse gap** runs the
 *      disk-driven undo: the marker is removed and the client settings are
 *      restored to their pre-attach state, the Part 5 config-drop trigger,
 *      exercised post-restart with the adapter already unloaded.
 *
 * The daemon runs in-process; the smoke plays the foreground invoker, relaunching
 * `runDaemon` whenever `handle.done` resolves with the restart exit code.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0045#part-1-the-client-seam-in-the-reconcile-context [tests]: the daemon threads clientDescriptors/clients/endpoint onto the reconcile context; a confirm-edge pass reaches the attach handler
 * @ref LLP 0045#part-5-reverse-triggers-config-drop-not-hyp-leave [tests]: a central config drop reverses the attach post-restart via the disk-driven undo
 * @ref LLP 0044#consent-join-implies-consent-default-on [tests]: a joined host confirming a config that names @hypaware/claude auto-attaches (default-on)
 * @ref LLP 0086#re-attach-on-drift [tests]: both branches of the freshness check, a relaunch at a rebound ephemeral port re-attaches, a relaunch at a pinned one short-circuits
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'client_attach_on_join: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
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
  // Pin the version the LLP 0258 floor check sees: the daemon's auto-attach
  // runs the same adapter, and the flow must not depend on whatever `claude`
  // binary the machine running it carries.
  const previousClaudeVersion = process.env.HYP_CLAUDE_CODE_VERSION
  process.env.HYP_CLAUDE_CODE_VERSION = '2.1.233'

  process.env.HYP_HOME = harness.hypHome
  delete process.env.HYP_CONFIG
  const localConfigPath = defaultConfigPath(harness.hypHome)
  const stateRoot = path.join(harness.hypHome, 'hypaware')

  // The freshness check watches the gateway's live endpoint, so the smoke needs
  // both a moving one (rev-1's ephemeral bind) and a stable one (rev-1b's pin).
  // The pinned value is deliberately *not* reserved up front: it is read back
  // from the running daemon's status.json below, so rev-1b pins a port the
  // daemon is already holding rather than one this process probed and released.
  /** @type {string} */
  let pinnedListen = ''
  /** @type {string} */
  let pinnedEndpoint = ''
  /** @type {string | undefined} */
  let driftStartedAt

  const server = await startStubCentralServer()
  try {
    // rev-1: a joined fleet config that enables the gateway + the claude client
    // adapter. Confirming it must auto-attach claude. Its gateway binds an
    // ephemeral port, which is what makes the relaunch below drift.
    server.setConfig(rev1Config(server.baseUrl, EPHEMERAL_LISTEN), 'rev-1')

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
      // `otel` mode: the telemetry block lands and no routing key is written,
      // so the fleet path delivers the same env block a manual attach does.
      // @ref LLP 0258#settings-env [tests]: managed settings deliver the same block
      expect.that(
        'auto-attach: the telemetry env block points at the loopback listener',
        attached?.env?.OTEL_EXPORTER_OTLP_ENDPOINT,
        (v) => typeof v === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(v)
      )
      expect.that(
        'auto-attach: mode=otel on the marker, and no base URL was written',
        attached,
        (v) =>
          v?._hypaware?.mode === 'otel' &&
          !Object.hasOwn(v?.env ?? {}, 'ANTHROPIC_BASE_URL')
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

    // Snapshot the post-attach state for the drift assertions below.
    const attachedAt = attachMarker(stateRoot)?.at
    const attachedEndpoint = attachMarker(stateRoot)?.endpoint

    // ----- smoke_step: reattach_on_drift (relaunch rev-1 → new port → re-attach) -----
    // A fresh relaunch on the *same* rev-1 runs the after-activation
    // already-confirmed pass (probation is cleared), so desired() names claude
    // again and the `done` marker is consulted. rev-1's gateway binds an
    // ephemeral port, so this boot is at a *different* endpoint: the marker is
    // stale, the unit is a forward gap, and the attach re-performs at the new
    // port instead of short-circuiting forever.
    // @ref LLP 0086#re-attach-on-drift [tests]: a done marker at a moved endpoint re-performs, which is what keeps the settings marker recording a bound port
    const driftHandle = await runDaemonHandle(harness)
    try {
      await waitFor(
        () => readConfigControlStatus({ stateRoot }).probation === null,
        15_000,
        'probation was unexpectedly re-armed on the drift relaunch'
      )
      await waitFor(
        () => {
          const marker = attachMarker(stateRoot)
          return marker?.status === 'done' && marker.at !== attachedAt
        },
        15_000,
        'the attach.claude marker was not refreshed after the gateway rebound to a new port'
      )
      const drifted = attachMarker(stateRoot)
      expect.that(
        'drift: the refreshed marker records the newly bound endpoint',
        drifted?.endpoint,
        (v) => typeof v === 'string' && v.length > 0 && v !== attachedEndpoint
      )
      const rewritten = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8'))
      // In `otel` mode no env key carries the gateway port; the settings
      // marker's `port` is what the freshness check compares, so it is what
      // must follow the rebound endpoint.
      expect.that(
        'drift: the settings marker port was rewritten to the newly bound port',
        rewritten?._hypaware?.port,
        (v) =>
          typeof v === 'number' &&
          typeof drifted?.endpoint === 'string' &&
          drifted.endpoint.endsWith(`:${v}`)
      )
      expect.that(
        'drift: the unrelated seed key (ANTHROPIC_API_KEY) survived the re-attach',
        rewritten?.env?.ANTHROPIC_API_KEY,
        (v) => v === 'sk-seed'
      )

      // ----- smoke_step: pin_port (serve rev-1b → apply → restart) -----
      // rev-1b is rev-1 with the gateway's `listen` pinned, so every later boot
      // binds the same port: the input the freshness check watches stops moving.
      //
      // The port it pins is the one *this* daemon is bound to right now, read
      // back out of its own status.json. That is what keeps the pin race-free:
      // probing a free port by binding and releasing it would hand rev-1b a
      // port nobody holds and hope it is still free seconds later (any
      // co-resident process, including this smoke's own stub server, could take
      // it), whereas a port the daemon already owns is simply reclaimed across
      // the staged restart.
      // @ref LLP 0086#endpoint-discovery [tests]: the live bound port is readable from status.json, which is what lets the pin name a port the daemon already holds
      driftStartedAt = statusStartedAt(stateRoot)
      const liveEndpoint = resolveLiveGatewayEndpointFromStatus({ stateRoot })
      expect.that(
        'pin: the drifted gateway reports its live bound endpoint in status.json',
        liveEndpoint,
        (v) => typeof v === 'string' && v === drifted?.endpoint
      )
      // Not decoration: the relaunch below is told apart from this boot's
      // leftover snapshot by `startedAt`, so an unread one would make that
      // check pass on stale data.
      expect.that(
        'pin: this boot is identifiable in status.json by its startedAt',
        driftStartedAt,
        (v) => typeof v === 'string' && v.length > 0
      )
      pinnedEndpoint = String(liveEndpoint)
      pinnedListen = pinnedEndpoint.slice('http://'.length)
      server.setConfig(rev1Config(server.baseUrl, pinnedListen), 'rev-1b')
      const pinExit = await withTimeout(
        driftHandle.done,
        30_000,
        'the rev-1b pinned-port revision did not request a staged restart within 30s'
      )
      expect.that(
        `pin: daemon exited with the restart code (got ${pinExit})`,
        pinExit,
        (v) => v === DAEMON_RESTART_EXIT_CODE
      )
    } finally {
      // `driftHandle.done` already resolved (restart): stop() is idempotent.
      await driftHandle.stop()
    }

    // Snapshot the post-drift state for the no-op assertions below. `pinnedAt`
    // is a genuinely fresh timestamp, not a leftover: the drift step above
    // asserted the re-attach moved the marker off `attachedAt`.
    const pinnedAt = attachMarker(stateRoot)?.at
    const pinnedBody = await fs.readFile(claudeSettingsPath, 'utf8')

    // ----- smoke_step: no_reattach (a boot at an unchanged endpoint is a no-op) -----
    // The complement of the drift branch: rev-1b pins the port the drift boot
    // bound, so this relaunch resolves the same endpoint the marker records,
    // the freshness check calls the marker current, and the `done` marker
    // short-circuits as it always did.
    // @ref LLP 0086#re-attach-on-drift [tests]: the guard side of the same check, an unmoved endpoint still short-circuits rather than churning the attach every boot
    const steadyHandle = await runDaemonHandle(harness)
    try {
      await waitFor(
        () => readConfigControlStatus({ stateRoot }).probation === null,
        15_000,
        'probation was unexpectedly re-armed on the steady relaunch'
      )
      // The pin only holds the endpoint still if the gateway actually reclaimed
      // the port it released on the staged restart, so read that back off *this*
      // boot's status.json (`startedAt` moved) before calling the no-op below a
      // no-op. A gateway that failed to rebind, or fell back to another port
      // (LLP 0114), would otherwise look identical to a clean short-circuit.
      await waitFor(
        () => {
          const startedAt = statusStartedAt(stateRoot)
          if (startedAt === undefined || startedAt === driftStartedAt) return false
          return resolveLiveGatewayEndpointFromStatus({ stateRoot }) === pinnedEndpoint
        },
        15_000,
        `the relaunched gateway did not reclaim the pinned endpoint ${pinnedEndpoint}`
      )
      // Give the boot-already-confirmed pass time to run (and prove it does not
      // re-attach): the marker timestamp must be identical.
      await sleep(500)
      expect.that(
        'no re-attach: the attach.claude marker timestamp is unchanged (done short-circuits)',
        attachMarker(stateRoot)?.at,
        (v) => v === pinnedAt
      )
      expect.that(
        'no re-attach: the client settings are byte-for-byte unchanged',
        await fs.readFile(claudeSettingsPath, 'utf8'),
        (v) => v === pinnedBody
      )

      // ----- smoke_step: drop_claude (serve rev-2 → apply → restart) -----
      // rev-2 drops @hypaware/claude fleet-wide; the running daemon's next poll
      // applies it and requests a staged restart.
      server.setConfig(rev2Config(server.baseUrl, pinnedListen), 'rev-2')
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
      // `steadyHandle.done` already resolved (restart): stop() is idempotent.
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
        'reverse: the managed telemetry keys were removed (no prior to restore)',
        JSON.parse(restored)?.env,
        (v) =>
          v !== null &&
          typeof v === 'object' &&
          !Object.hasOwn(v, 'OTEL_EXPORTER_OTLP_ENDPOINT') &&
          !Object.hasOwn(v, 'CLAUDE_CODE_ENABLE_TELEMETRY') &&
          !Object.hasOwn(v, 'OTEL_LOG_RAW_API_BODIES')
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
    if (previousClaudeVersion === undefined) delete process.env.HYP_CLAUDE_CODE_VERSION
    else process.env.HYP_CLAUDE_CODE_VERSION = previousClaudeVersion
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

// The default gateway bind: a port the kernel picks fresh on every boot, which
// is what makes a relaunch on an unchanged revision drift (LLP 0086).
const EPHEMERAL_LISTEN = '127.0.0.1:0'

/** @param {string} baseUrl @param {string} listen */
function rev1Config(baseUrl, listen) {
  return {
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway', config: gatewayConfig(listen) },
      { name: '@hypaware/claude' },
    ],
    sinks: centralSink(baseUrl),
    query: { cache: { retention: { default_days: 30 } } },
  }
}

/**
 * rev-2 is rev-1 minus the claude client plugin: the fleet-drop trigger.
 * @param {string} baseUrl
 * @param {string} listen
 */
function rev2Config(baseUrl, listen) {
  return {
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway', config: gatewayConfig(listen) },
    ],
    sinks: centralSink(baseUrl),
    query: { cache: { retention: { default_days: 30 } } },
  }
}

/** @param {string} listen */
function gatewayConfig(listen) {
  return {
    listen,
    upstreams: [
      { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' },
    ],
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
 * Boot the daemon once and await its `done`, used for a boot that is expected
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
 * The `startedAt` of the daemon boot that wrote the current `status.json`, or
 * `undefined` when there is no readable status file yet.
 *
 * Which boot wrote a status file matters here because a pinned port makes two
 * consecutive boots report the *same* endpoint: an endpoint read on its own
 * cannot tell a fresh bind from the outgoing daemon's leftover snapshot.
 * @param {string} stateRoot
 * @returns {string | undefined}
 */
function statusStartedAt(stateRoot) {
  try {
    return readStatusFile(stateRoot)?.startedAt
  } catch {
    return undefined
  }
}

/**
 * Read the `attach.claude` client-action marker, or `undefined` when absent.
 * @param {string} stateRoot
 * @returns {{ status?: string, request_key?: string, at?: string, endpoint?: string } | undefined}
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
      reply(200, { 'content-type': 'application/json' }, JSON.stringify({ jwt, expires_at: expiresAt, org: 'smoke.test' }))
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
