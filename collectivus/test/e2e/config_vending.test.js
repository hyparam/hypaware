import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError } from '../../src/config.js'
import { ConfigClient } from '../../src/gateway/config_client.js'
import { applyDiff, diffConfig } from '../../src/gateway/hot_reload.js'
import { IdentityClient } from '../../src/gateway/identity.js'
import { createConfigRegistry, setConfig } from '../../src/server/config_registry.js'
import { ControlPlane } from '../../src/server/control_plane.js'
import { BootstrapStore } from '../../src/server/identity.js'

/**
 * @import { CollectivusConfig, ListenerFactory, StartedListener } from '../../src/types.js'
 * @import { ConfigChangedEvent } from '../../src/gateway/types.d.ts'
 * @import { ConfigRegistry } from '../../src/server/types.d.ts'
 */

const PLACEHOLDER_SECRET = 'a'.repeat(32)

/**
 * @returns {{ write(s: string): void, value(): string, lines(): string[] }}
 */
function memoStream() {
  let buf = ''
  return {
    write(/** @type {string} */ s) { buf += s },
    value() { return buf },
    lines() { return buf.split('\n').filter((l) => l.length > 0) },
  }
}

/**
 * Build a stub `StartedListener` whose `stop()` flips a flag the test asserts
 * on. The hot-reload e2e cares about which sections restart, not what the
 * listeners do, so a thin counter is enough; the real otel/proxy listeners
 * are tested elsewhere.
 *
 * @param {string} name
 * @returns {StartedListener & { name: string, stops: number }}
 */
function stubListener(name) {
  return {
    name,
    description: `${name} listener (stub)`,
    stops: 0,
    stop() { this.stops++; return Promise.resolve() },
  }
}

/**
 * Build a factory builder that returns successive stub listeners per section.
 * The returned `byName` map records every listener instance ever produced so a
 * test can verify which sections restarted (instance count > 1) and which
 * stayed put.
 *
 * @returns {{
 *   factoryBuilder: (cfg: CollectivusConfig) => Map<string, ListenerFactory>,
 *   instances: Map<string, ReturnType<typeof stubListener>[]>,
 * }}
 */
function makeFactoryBuilder() {
  /** @type {Map<string, ReturnType<typeof stubListener>[]>} */
  const instances = new Map()
  /**
   * @param {Map<string, ListenerFactory>} factories
   * @param {string} section
   */
  function seed(factories, section) {
    factories.set(section, () => {
      const list = instances.get(section) ?? []
      const inst = stubListener(`${section}#${list.length + 1}`)
      list.push(inst)
      instances.set(section, list)
      return Promise.resolve(inst)
    })
  }
  return {
    instances,
    factoryBuilder(cfg) {
      /** @type {Map<string, ListenerFactory>} */
      const factories = new Map()
      if (cfg.otel) seed(factories, 'otel')
      if (cfg.proxy) seed(factories, 'proxy')
      if (cfg.upload) seed(factories, 'upload')
      return factories
    },
  }
}

/**
 * Wait for `client.activeTick` to settle. The poll loop schedules ticks via
 * `setTimeout`; when we drive `tick()` directly we don't need this, but if a
 * future test wants to start the loop it can chain on this helper.
 *
 * @param {ConfigClient} client
 * @returns {Promise<void>}
 */
async function settle(client) {
  await client.whenIdle()
}

/**
 * Shape a valid gateway config the registry will accept. Tests vary the
 * `proxy.listen` port and `otel.listen` port to produce diffs that exercise
 * `applyDiff`'s section-level restart logic.
 *
 * @param {{
 *   proxy?: { listen: string } | null,
 *   otel?: { listen: string } | null,
 *   upload?: { bucket: string, prefix?: string, time?: string } | null,
 * }} [overrides]
 * @returns {CollectivusConfig}
 */
function gatewayCfg(overrides = {}) {
  /** @type {CollectivusConfig} */
  const cfg = {
    version: 1,
    role: 'gateway',
    sink: { type: 'file', dir: '/tmp/cfg-vending-e2e-sink' },
    central_server: {
      url: 'https://placeholder.example',
      identity: { bootstrap_token: 'placeholder' },
    },
  }
  if (overrides.otel === undefined) {
    cfg.otel = { listen: '127.0.0.1:14318' }
  } else if (overrides.otel !== null) {
    cfg.otel = overrides.otel
  }
  if (overrides.proxy === undefined) {
    cfg.proxy = {
      listen: '127.0.0.1:18787',
      upstreams: [{
        name: 'anthropic',
        base_url: 'https://api.anthropic.com',
        match: { path_prefix: '/v1/messages' },
      }],
    }
  } else if (overrides.proxy !== null) {
    cfg.proxy = {
      listen: overrides.proxy.listen,
      upstreams: [{
        name: 'anthropic',
        base_url: 'https://api.anthropic.com',
        match: { path_prefix: '/v1/messages' },
      }],
    }
  }
  if (overrides.upload === undefined) {
    // Default off; most diffs only care about otel/proxy.
  } else if (overrides.upload !== null) {
    cfg.upload = overrides.upload
  }
  return cfg
}

describe('config vending e2e: bootstrap → vend → hot reload', () => {
  /** @type {string} */
  let tmpDir
  /** @type {ControlPlane} */
  let plane
  /** @type {string} */
  let baseUrl
  /** @type {BootstrapStore} */
  let store
  /** @type {ConfigRegistry} */
  let registry
  /** @type {string} */
  let configsDir
  /** @type {string} */
  let bootstrapStorePath

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-e2e-cv-'))
    configsDir = path.join(tmpDir, 'configs')
    bootstrapStorePath = path.join(tmpDir, 'bootstrap.json')
    store = new BootstrapStore({ path: bootstrapStorePath })
    registry = createConfigRegistry({ configsDir })
    plane = new ControlPlane(
      {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret: PLACEHOLDER_SECRET, bootstrap_store_path: bootstrapStorePath },
      },
      { bootstrapStore: store, configRegistry: registry }
    )
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await plane.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full pipeline: bootstrap → JWT → operator config set → gateway picks up → section diff restarts only changed listener', async () => {
    // === 1. Operator: provision a bootstrap token for gw-e2e on the server. ===
    const { token } = store.register({ gatewayId: 'gw-e2e', ttlSeconds: 60 })

    // === 2. Gateway start: IdentityClient.acquire() exchanges the token for a JWT. ===
    const persistedPath = path.join(tmpDir, 'identity.json')
    const identityClient = new IdentityClient({
      url: baseUrl,
      identity: { bootstrap_token: token, persisted_path: persistedPath },
    })
    const source = await identityClient.acquire()
    expect(source).toBe('bootstrapped')
    expect(fs.existsSync(persistedPath)).toBe(true)
    const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf8'))
    expect(persisted.gateway_id).toBe('gw-e2e')
    expect(typeof persisted.jwt).toBe('string')
    expect(persisted.jwt.length).toBeGreaterThan(0)

    // === 3. Gateway: ConfigClient with a 1s poll interval; we drive tick() directly. ===
    const stderr = memoStream()
    const etagPath = path.join(tmpDir, 'config-etag.json')
    const configClient = new ConfigClient(
      { url: baseUrl, identity: { bootstrap_token: token }, poll_interval_seconds: 1 },
      identityClient,
      { etagPath, stderr }
    )

    /** @type {ConfigChangedEvent[]} */
    const events = []
    configClient.on('config-changed', (e) => { events.push(e) })

    // === 4. Pre-config tick: 404 with NOT_REGISTERED_BACKOFF backoff. ===
    const firstDelay = await configClient.tick()
    // The 404 path returns NOT_REGISTERED_BACKOFF_SECONDS (5 min); we don't
    // assert the exact value here (covered in unit tests); we only care that
    // no event fires and stderr surfaces the operator-friendly hint once.
    expect(firstDelay).toBeGreaterThan(0)
    expect(events).toHaveLength(0)
    expect(stderr.value()).toMatch(/no config registered for this gateway/)

    // === 5. Operator: write the gateway's config via the registry (the
    // operator CLI uses this same path; this is the in-process equivalent of
    // `collectivus config set gw-e2e --file ...`). ===
    const cfgV1 = gatewayCfg()
    const setResult = setConfig(registry, 'gw-e2e', cfgV1)
    expect(setResult.etag).toMatch(/^[0-9a-f]{64}$/)

    // === 6. Gateway picks up the config on the next tick. ===
    const secondDelay = await configClient.tick()
    expect(secondDelay).toBe(1) // back to the configured poll interval
    expect(events).toHaveLength(1)
    expect(events[0].newConfig).toEqual(cfgV1)
    expect(events[0].etag).toBe(setResult.etag)
    // Etag persisted to disk so a restart short-circuits to 304.
    const cachedEtag = JSON.parse(fs.readFileSync(etagPath, 'utf8'))
    expect(cachedEtag.etag).toBe(setResult.etag)

    // === 7. Operator changes ONE section (proxy.listen port). The other
    // sections (otel, sink, central_server) are byte-identical. ===
    const cfgV2 = gatewayCfg({
      proxy: { listen: '127.0.0.1:18999' },
    })
    setConfig(registry, 'gw-e2e', cfgV2)

    // === 8. Hot reload pipeline: feed every config-changed event through
    // applyDiff against a stub listener registry. After cfgV1 lands, all
    // configured sections start; after cfgV2 lands, ONLY proxy restarts. ===
    /** @type {Map<string, StartedListener>} */
    const liveRegistry = new Map()
    const { factoryBuilder, instances } = makeFactoryBuilder()
    const stdout = memoStream()
    const stderr2 = memoStream()

    // Initial start (synthetic; `cli.js` does this on launch from the
    // boot-time config; we simulate by feeding an "empty → cfgV1" diff).
    /** @type {CollectivusConfig} */
    const emptyCfg = { version: 1, role: 'gateway' }
    await applyDiff(
      diffConfig(emptyCfg, cfgV1),
      emptyCfg,
      cfgV1,
      liveRegistry,
      factoryBuilder,
      { stdout, stderr: stderr2 }
    )
    expect(liveRegistry.has('otel')).toBe(true)
    expect(liveRegistry.has('proxy')).toBe(true)
    expect(instances.get('otel')).toHaveLength(1)
    expect(instances.get('proxy')).toHaveLength(1)
    // Pull these from `instances` rather than `liveRegistry` so the stub-
    // listener fields (`stops`, `name`) survive; `liveRegistry` is typed as
    // the public `StartedListener` interface only.
    const otelInstance1 = instances.get('otel')?.[0]
    const proxyInstance1 = instances.get('proxy')?.[0]

    // Fetch cfgV2 (third tick: cfgV2 is in the registry from step 7).
    const thirdDelay = await configClient.tick()
    expect(thirdDelay).toBe(1)
    expect(events).toHaveLength(2)
    expect(events[1].newConfig).toEqual(cfgV2)
    expect(events[1].etag).not.toBe(setResult.etag)

    // Apply the cfgV1 → cfgV2 diff: only proxy should restart.
    await applyDiff(
      diffConfig(cfgV1, cfgV2),
      cfgV1,
      cfgV2,
      liveRegistry,
      factoryBuilder,
      { stdout, stderr: stderr2 }
    )
    expect(instances.get('otel')).toHaveLength(1) // unchanged, same instance
    expect(instances.get('proxy')).toHaveLength(2) // restarted, new instance
    expect(liveRegistry.get('otel')).toBe(otelInstance1)
    expect(liveRegistry.get('proxy')).not.toBe(proxyInstance1)
    if (!proxyInstance1) throw new Error('proxyInstance1 missing')
    expect(proxyInstance1.stops).toBe(1) // old proxy was stopped exactly once

    // === 9. Fourth tick: nothing changed, server returns 304, no event. ===
    const fourthDelay = await configClient.tick()
    expect(fourthDelay).toBe(1)
    expect(events).toHaveLength(2)

    configClient.stop()
    await settle(configClient)
  })

  it('rejects an invalid config at server-write time (operator does not need to ship it to the gateway to find out)', () => {
    // The bead spec calls this out as part of B.1 acceptance, but the e2e
    // surface lives at the operator-CLI / registry boundary, re-asserted
    // here so a regression in either layer is caught by the e2e suite, not
    // just the per-component unit tests.
    expect(() => setConfig(registry, 'gw-e2e', { version: 999 })).toThrow(ConfigError)
    // Filesystem must remain empty: no half-written file from a rejected
    // setConfig.
    expect(fs.existsSync(path.join(configsDir, 'gw-e2e.json'))).toBe(false)
  })

  it('cross-gateway authz: gw-a JWT cannot read gw-b config across the wire', async () => {
    // Operator provisions both gateways and writes both configs.
    const { token: tokA } = store.register({ gatewayId: 'gw-a', ttlSeconds: 60 })
    store.register({ gatewayId: 'gw-b', ttlSeconds: 60 })
    setConfig(registry, 'gw-a', gatewayCfg())
    setConfig(registry, 'gw-b', gatewayCfg({ proxy: { listen: '127.0.0.1:18800' } }))

    // gw-a bootstraps, gets its JWT.
    const idA = new IdentityClient({
      url: baseUrl,
      identity: {
        bootstrap_token: tokA,
        persisted_path: path.join(tmpDir, 'identity-a.json'),
      },
    })
    await idA.acquire()

    // ConfigClient pulls gw-a's config (the JWT subject is gw-a; the server
    // never reads a gateway_id query/path param).
    const stderr = memoStream()
    const clientA = new ConfigClient(
      { url: baseUrl, identity: { bootstrap_token: tokA }, poll_interval_seconds: 1 },
      idA,
      { etagPath: path.join(tmpDir, 'etag-a.json'), stderr }
    )
    /** @type {ConfigChangedEvent[]} */
    const events = []
    clientA.on('config-changed', (e) => { events.push(e) })
    await clientA.tick()
    expect(events).toHaveLength(1)
    // The proxy listen we got back must be gw-a's, not gw-b's.
    expect(events[0].newConfig.proxy?.listen).toBe('127.0.0.1:18787')
  })
})
