// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import { installObservability } from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { centralSeedPath, readConfigControlStatus, resolveCentralLayerPath } from '../../../src/core/config/apply.js'
import { DAEMON_RESTART_EXIT_CODE, runDaemon } from '../../../src/core/daemon/runtime.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * @import { AddressInfo } from 'node:net'
 */

/**
 * Join-flow smoke (LLP 0025): drives the full remote-config lifecycle
 * against a stub central server —
 *
 *   join (seed write) → seed boot → identity bootstrap → config pull
 *   (200) → kernel apply → staged restart → relaunch on the served
 *   config → probation cleared by the first successful poll (304).
 *
 * The daemon runs in-process and the smoke plays the role of the
 * foreground invoker: it relaunches `runDaemon` when `handle.done`
 * resolves with the restart exit code, exactly as a dev shell or the
 * service manager would.
 *
 * Under layering (LLP 0031) the seed is the **central** layer, written
 * to config-control/ — never to the user's `hypaware-config.json`. This
 * smoke seeds a pre-existing local config to prove `join` leaves it
 * intact (#111) and that its colliding entry drops at the boot-time
 * merge.
 *
 * Asserted signals (Log-Driven Development):
 *  - external: central layer replaced wholesale (token retired), seed
 *    preserved as the rollback slot, local config untouched by join,
 *    otlp source running on the served config, `If-None-Match`
 *    convergence transitions on the stub server.
 *  - internal: `config.apply` span (status=ok), `config.applied`,
 *    `config.probation_cleared`, and `config.local_entry_dropped` log
 *    rows, `join.run` span.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0025#the-join-sequence [tests] — seed → bootstrap → pull → apply → restart → operational, end to end against a stub server
 * @ref LLP 0031#physical-layout [tests] — join writes the central seed (not the local layer); boot merges central ⊕ local
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'join_flow_remote_config: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  process.env.HYP_HOME = harness.hypHome
  delete process.env.HYP_CONFIG
  const localConfigPath = defaultConfigPath(harness.hypHome)
  const stateRoot = path.join(harness.hypHome, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)

  // ----- smoke_step: stub_server_up -----
  const server = await startStubCentralServer()
  try {
    // The served revision: a full v2 config. The otel pin exercises
    // the bundled-plugin strict version check on the apply path.
    const otelManifest = JSON.parse(await fs.readFile(
      path.join(
        path.dirname(new URL(import.meta.url).pathname),
        '..', '..', 'plugins-workspace', 'otel', 'hypaware.plugin.json'
      ),
      'utf8'
    ))
    server.setConfig({
      version: 2,
      plugins: [
        { name: '@hypaware/central' },
        { name: '@hypaware/otel', version: otelManifest.version, config: { listen_host: '127.0.0.1', listen_port: 0 } },
      ],
      sinks: {
        central: {
          plugin: '@hypaware/central',
          config: {
            url: server.baseUrl,
            identity: {},
            schedule: '0 * * * *',
            poll_interval_seconds: 5,
          },
        },
      },
      query: { cache: { retention: { default_days: 30 } } },
    }, 'rev-1')

    // A pre-existing local install (LLP 0031 / #111): `join` must not
    // touch this file. Its `@hypaware/central` entry collides with the
    // central layer, so it is dropped at the boot-time merge — surfaced
    // as a structured `config.local_entry_dropped` log asserted below.
    const localConfig = { version: 2, plugins: [{ name: '@hypaware/central' }] }
    await fs.writeFile(localConfigPath, JSON.stringify(localConfig, null, 2) + '\n')

    // ----- smoke_step: join (write central seed + skip daemon install) -----
    const joinOut = makeBuf()
    const joinErr = makeBuf()
    const joinCode = await dispatch(
      ['join', server.baseUrl, 'policy-token-smoke', '--no-daemon'],
      {
        stdout: joinOut,
        stderr: joinErr,
        env: { ...process.env, HYP_HOME: harness.hypHome },
      }
    )
    expect.that(
      `join: exits 0 (stderr: ${joinErr.text()})`,
      joinCode,
      (v) => v === 0
    )
    const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'))
    expect.that(
      'join: the central seed carries the policy token',
      seed.sinks?.central?.config?.identity?.bootstrap_token,
      (v) => v === 'policy-token-smoke'
    )
    expect.that(
      'join: the pre-existing local config is untouched (#111)',
      JSON.parse(await fs.readFile(localConfigPath, 'utf8')).plugins?.[0]?.name,
      (v) => v === '@hypaware/central'
    )

    // ----- smoke_step: seed_boot (bootstrap → pull → apply → restart) -----
    const first = await runDaemon({
      hypHome: harness.hypHome,
      env: process.env,
      runId: harness.devRunId,
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })
    const firstExit = await withTimeout(
      first.done,
      30_000,
      'seed boot did not request a staged restart within 30s'
    )
    expect.that(
      `seed boot: daemon exited with the restart code (got ${firstExit})`,
      firstExit,
      (v) => v === DAEMON_RESTART_EXIT_CODE
    )

    // The apply replaced the central layer wholesale and preserved the
    // seed as the rollback slot. The central layer now resolves through
    // the relocated config-control pointer, not the user-owned local file.
    const operative = JSON.parse(await fs.readFile(
      /** @type {string} */ (resolveCentralLayerPath({ stateRoot })), 'utf8'
    ))
    expect.that(
      'apply: central layer no longer carries the policy token',
      operative.sinks?.central?.config?.identity?.bootstrap_token,
      (v) => v === undefined
    )
    expect.that(
      'apply: central layer names the otel plugin from the served revision',
      operative.plugins?.some((/** @type {any} */ p) => p.name === '@hypaware/otel'),
      (v) => v === true
    )
    const slotA = JSON.parse(
      await fs.readFile(path.join(stateRoot, 'config-control', 'config.a.json'), 'utf8')
    )
    expect.that(
      'apply: the seed survives in the rollback slot',
      slotA.sinks?.central?.config?.identity?.bootstrap_token,
      (v) => v === 'policy-token-smoke'
    )
    const midStatus = readConfigControlStatus({ stateRoot })
    expect.that(
      'apply: probation marker armed for the served revision',
      midStatus.probation?.etag,
      (v) => v === 'rev-1'
    )

    // ----- smoke_step: relaunch (service-manager role) -----
    const second = await runDaemon({
      hypHome: harness.hypHome,
      env: process.env,
      runId: harness.devRunId,
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })
    try {
      // Probation clears on the first successful poll (304 here).
      await waitFor(
        () => readConfigControlStatus({ stateRoot }).probation === null,
        10_000,
        'probation did not clear within 10s of relaunch'
      )
      const cleared = readConfigControlStatus({ stateRoot })
      expect.that(
        'probation: cleared with the served revision running',
        cleared.runningEtag,
        (v) => v === 'rev-1'
      )
      expect.that(
        'probation: no rollback was recorded',
        cleared.lastRollback,
        (v) => v === null
      )

      const snapshot = second.snapshot()
      expect.that(
        `relaunch: daemon state is healthy (got ${snapshot.state})`,
        snapshot.state,
        (v) => v === 'healthy'
      )
      expect.that(
        'relaunch: otlp source from the served config is started',
        snapshot.sources.find((/** @type {any} */ s) => s.name === 'otlp')?.state,
        (v) => v === 'started'
      )

      // Convergence semantics on the wire: the first GET presented no
      // etag (seed has none), the post-apply GET presented rev-1 and
      // was answered 304.
      const configGets = server.requests.filter((r) => r.path === '/v1/config')
      expect.that(
        `stub server: at least two config pulls observed (got ${configGets.length})`,
        configGets.length,
        (v) => typeof v === 'number' && v >= 2
      )
      expect.that(
        'stub server: the seed-boot pull presented no If-None-Match',
        configGets[0]?.ifNoneMatch,
        (v) => v === undefined
      )
      expect.that(
        'stub server: a post-apply pull presented the running etag and converged',
        configGets.some((r) => r.ifNoneMatch === 'rev-1' && r.responseStatus === 304),
        (v) => v === true
      )
      expect.that(
        'stub server: exactly one bootstrap happened (policy token not re-spent)',
        server.requests.filter((r) => r.path === '/v1/identity/bootstrap').length,
        (v) => v === 1
      )
    } finally {
      await second.stop()
      await second.done
    }
  } finally {
    await server.close()
  }

  await obs.shutdown()

  // ----- smoke_step: telemetry -----
  const traces = await expect.traces()
  const applySpans = traces.filter((/** @type {any} */ t) => t.name === 'config.apply')
  expect.that(
    'traces: a config.apply span was emitted with status=ok and apply_action=applied',
    applySpans.some((/** @type {any} */ s) =>
      s.attributes?.status === 'ok' && s.attributes?.apply_action === 'applied'
    ),
    (v) => v === true
  )
  expect.that(
    'traces: a join.run span was emitted',
    traces.some((/** @type {any} */ t) => t.name === 'join.run'),
    (v) => v === true
  )

  const logs = await expect.logs()
  expect.that(
    'logs: config.applied recorded for rev-1',
    logs.some((/** @type {any} */ l) =>
      l.body === 'config.applied' && l.attributes?.config_etag === 'rev-1'
    ),
    (v) => v === true
  )
  expect.that(
    'logs: config.local_entry_dropped recorded for the colliding local central entry (LLP 0031)',
    logs.some((/** @type {any} */ l) =>
      l.body === 'config.local_entry_dropped' && l.attributes?.key === '@hypaware/central'
    ),
    (v) => v === true
  )
  expect.that(
    'logs: config.probation_cleared recorded for rev-1',
    logs.some((/** @type {any} */ l) =>
      l.body === 'config.probation_cleared' && l.attributes?.config_etag === 'rev-1'
    ),
    (v) => v === true
  )
  expect.that(
    'logs: central.config.poll observed both a 200 and a 304',
    [200, 304].every((status) =>
      logs.some((/** @type {any} */ l) =>
        l.body === 'central.config.poll' && l.attributes?.http_status === status
      )
    ),
    (v) => v === true
  )
}

/* ---------- stub central server ---------- */

/**
 * Minimal `@hypaware/server` stand-in: identity bootstrap/refresh,
 * etag-aware config serving, and an ingest acceptor. Every request is
 * recorded for convergence assertions.
 */
async function startStubCentralServer() {
  /** @type {Array<{ method: string, path: string, ifNoneMatch?: string, responseStatus: number }>} */
  const requests = []
  /** @type {unknown} */
  let configDoc = null
  /** @type {string} */
  let configEtag = ''

  const jwt = buildFakeJwt('gateway-smoke-1')
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    /** @param {number} status @param {Record<string, string>} headers @param {string} [body] */
    function reply(status, headers, body) {
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        ...(req.headers['if-none-match']
          ? { ifNoneMatch: String(req.headers['if-none-match']) }
          : {}),
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
      reply(
        200,
        { 'content-type': 'application/json', etag: configEtag },
        JSON.stringify(configDoc)
      )
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

/**
 * Unsigned JWT with the `sub` claim the identity client decodes. The
 * gateway never verifies signatures (it trusts TLS), so a fake
 * signature is wire-faithful enough for the smoke.
 *
 * @param {string} sub
 */
function buildFakeJwt(sub) {
  /** @param {object} obj */
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub })}.smoke`
}

/* ---------- helpers ---------- */

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
      timer = setTimeout(() => reject(new Error(`join_flow_remote_config: ${message}`)), ms)
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
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`join_flow_remote_config: ${message}`)
}
