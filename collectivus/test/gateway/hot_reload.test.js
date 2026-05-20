import { describe, expect, it } from 'vitest'
import { HOT_RELOAD_SECTIONS, applyDiff, diffConfig } from '../../src/gateway/hot_reload.js'

/**
 * @import { CollectivusConfig, ListenerFactory, StartedListener } from '../../src/types.js'
 */

/**
 * Capture stdout/stderr writes for assertion.
 *
 * @returns {{ write(s: string): void, value(): string, lines(): string[] }}
 */
function memoStream() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
    lines() { return buf.split('\n').filter((l) => l.length > 0) },
  }
}

/**
 * Build a stub `StartedListener`. The returned object exposes counters and a
 * resolver hook that lets a test stall the `stop()` call so we can probe the
 * registry mid-restart.
 *
 * @param {string} name
 * @param {{ stopThrows?: () => Error, stopHangs?: boolean }} [opts]
 * @returns {StartedListener & { stops: number, stopped: boolean, releaseStop: () => void }}
 */
function stubListener(name, opts = {}) {
  /** @type {(() => void) | undefined} */
  let release
  return {
    description: `${name} listener (stub)`,
    stops: 0,
    stopped: false,
    releaseStop() { if (release) { release(); release = undefined } },
    async stop() {
      this.stops++
      if (opts.stopThrows) throw opts.stopThrows()
      if (opts.stopHangs) {
        await new Promise(resolve => { release = () => resolve() })
      }
      this.stopped = true
    },
  }
}

/**
 * Build a stub factory that returns successive `StartedListener` instances on
 * each call. `instances` is mutated so a test can later assert on the
 * lifecycle of any specific instance.
 *
 * @param {string} name
 * @param {{ throwsOnCall?: number, throws?: Error }} [opts]
 *   `throwsOnCall: 1` makes the factory's first invocation throw; `throws`
 *   makes every invocation throw.
 * @returns {{
 *   factory: ListenerFactory,
 *   calls: number,
 *   instances: ReturnType<typeof stubListener>[],
 * }}
 */
function stubFactory(name, opts = {}) {
  /** @type {ReturnType<typeof stubListener>[]} */
  const instances = []
  const state = { factory: /** @type {ListenerFactory} */ (() => Promise.reject(new Error('placeholder'))), calls: 0, instances }
  state.factory = () => {
    state.calls++
    if (opts.throws) return Promise.reject(opts.throws)
    if (opts.throwsOnCall !== undefined && state.calls === opts.throwsOnCall) {
      return Promise.reject(new Error(`${name} factory throws on call #${opts.throwsOnCall}`))
    }
    const listener = stubListener(`${name}#${state.calls}`)
    instances.push(listener)
    return Promise.resolve(listener)
  }
  return state
}

/**
 * Compose a CollectivusConfig fragment focused on the four hot-reloadable
 * sections. Defaults are picked so the validator-shaped check
 * `oldCfg.proxy ?? newCfg.proxy` works without surprises in tests that
 * never look at non-section fields.
 *
 * @param {{
 *   otel?: { listen: string } | null,
 *   proxy?: { listen: string, upstreams: Array<{ name: string, base_url: string, match: { path_prefix: string } }>, redact_headers?: string[] } | null,
 *   sink?: { dir: string } | null,
 *   upload?: { bucket: string, prefix?: string, time?: string } | null,
 * }} [overrides] `null` removes the section; an object overrides the default;
 *   `undefined` keeps the default.
 * @returns {CollectivusConfig}
 */
function gatewayConfig(overrides = {}) {
  /** @type {CollectivusConfig} */
  const cfg = {
    version: 1,
    role: 'gateway',
    central_server: { url: 'https://central.example/', identity: { bootstrap_token: 'x' } },
    sink: { type: 'file', dir: '/tmp/sink-default' },
    proxy: {
      listen: '127.0.0.1:8080',
      upstreams: [{ name: 'a', base_url: 'https://x.test', match: { path_prefix: '/v1' } }],
    },
  }
  if (overrides.otel === null) delete cfg.otel
  else if (overrides.otel) cfg.otel = overrides.otel
  if (overrides.proxy === null) delete cfg.proxy
  else if (overrides.proxy) cfg.proxy = overrides.proxy
  if (overrides.sink === null) delete cfg.sink
  else if (overrides.sink) cfg.sink = { type: 'file', dir: overrides.sink.dir }
  if (overrides.upload === null) delete cfg.upload
  else if (overrides.upload) cfg.upload = overrides.upload
  return cfg
}

describe('HOT_RELOAD_SECTIONS', () => {
  it('exposes the four sections the spec calls out', () => {
    expect([...HOT_RELOAD_SECTIONS]).toEqual(['otel', 'proxy', 'sink', 'upload'])
  })

  it('is frozen so callers cannot mutate the canonical list', () => {
    expect(Object.isFrozen(HOT_RELOAD_SECTIONS)).toBe(true)
  })
})

describe('diffConfig', () => {
  it('returns all unchanged when configs are structurally identical', () => {
    const a = gatewayConfig({ otel: { listen: '127.0.0.1:4318' }, upload: { bucket: 'b' } })
    const b = gatewayConfig({ otel: { listen: '127.0.0.1:4318' }, upload: { bucket: 'b' } })
    expect(diffConfig(a, b)).toEqual({
      otel: 'unchanged', proxy: 'unchanged', sink: 'unchanged', upload: 'unchanged',
    })
  })

  it('detects added sections (was undefined, now present)', () => {
    const a = gatewayConfig({ proxy: null, otel: null })
    const b = gatewayConfig({ otel: { listen: '0.0.0.0:4318' }, upload: { bucket: 'b' } })
    const d = diffConfig(a, b)
    expect(d.otel).toBe('added')
    expect(d.upload).toBe('added')
  })

  it('detects removed sections (was present, now undefined)', () => {
    const a = gatewayConfig({ upload: { bucket: 'b' } })
    const b = gatewayConfig({ upload: null })
    expect(diffConfig(a, b).upload).toBe('removed')
  })

  it('detects changed proxy.upstreams nested array swaps', () => {
    const a = gatewayConfig()
    const b = gatewayConfig({
      proxy: {
        listen: '127.0.0.1:8080',
        upstreams: [{ name: 'b', base_url: 'https://y.test', match: { path_prefix: '/v2' } }],
      },
    })
    expect(diffConfig(a, b).proxy).toBe('changed')
  })

  it('treats sink.dir change as `changed` even when other sections are equal', () => {
    const a = gatewayConfig({ sink: { dir: '/tmp/old' } })
    const b = gatewayConfig({ sink: { dir: '/tmp/new' } })
    const d = diffConfig(a, b)
    expect(d.sink).toBe('changed')
    expect(d.proxy).toBe('unchanged')
  })

  it('does not confuse `unchanged` with `added` when both configs lack a section', () => {
    const a = gatewayConfig({ otel: null, upload: null })
    const b = gatewayConfig({ otel: null, upload: null })
    const d = diffConfig(a, b)
    expect(d.otel).toBe('unchanged')
    expect(d.upload).toBe('unchanged')
  })

  it('handles deep equality on nested redact_headers arrays', () => {
    const a = gatewayConfig({
      proxy: {
        listen: '127.0.0.1:8080',
        upstreams: [{ name: 'a', base_url: 'https://x.test', match: { path_prefix: '/v1' } }],
        redact_headers: ['authorization', 'cookie'],
      },
    })
    const b = gatewayConfig({
      proxy: {
        listen: '127.0.0.1:8080',
        upstreams: [{ name: 'a', base_url: 'https://x.test', match: { path_prefix: '/v1' } }],
        redact_headers: ['authorization', 'cookie'],
      },
    })
    expect(diffConfig(a, b).proxy).toBe('unchanged')
    const c = gatewayConfig({
      proxy: {
        listen: '127.0.0.1:8080',
        upstreams: [{ name: 'a', base_url: 'https://x.test', match: { path_prefix: '/v1' } }],
        redact_headers: ['cookie', 'authorization'], // different order
      },
    })
    expect(diffConfig(a, c).proxy).toBe('changed')
  })
})

describe('applyDiff: only proxy changes', () => {
  it('restarts proxy and leaves otel + upload untouched', async () => {
    const oldCfg = gatewayConfig({
      otel: { listen: '127.0.0.1:4318' },
      upload: { bucket: 'b' },
    })
    const newCfg = gatewayConfig({
      otel: { listen: '127.0.0.1:4318' },
      upload: { bucket: 'b' },
      proxy: {
        listen: '127.0.0.1:8080',
        upstreams: [{ name: 'b', base_url: 'https://y.test', match: { path_prefix: '/v2' } }],
      },
    })
    const otel = stubFactory('otel')
    const proxy = stubFactory('proxy')
    const upload = stubFactory('upload')

    /** @type {Map<string, StartedListener>} */
    const registry = new Map([
      ['otel', stubListener('otel-original')],
      ['proxy', stubListener('proxy-original')],
      ['upload', stubListener('upload-original')],
    ])
    const otelOriginal = /** @type {ReturnType<typeof stubListener>} */ (registry.get('otel'))
    const uploadOriginal = /** @type {ReturnType<typeof stubListener>} */ (registry.get('upload'))
    const proxyOriginal = /** @type {ReturnType<typeof stubListener>} */ (registry.get('proxy'))

    const stdout = memoStream()
    const stderr = memoStream()
    function factoryBuilder() {
      return new Map([
        ['otel', otel.factory], ['proxy', proxy.factory], ['upload', upload.factory],
      ])
    }
    await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder, { stdout, stderr })

    // Only proxy was rebuilt.
    expect(otel.calls).toBe(0)
    expect(upload.calls).toBe(0)
    expect(proxy.calls).toBe(1)
    expect(proxyOriginal.stopped).toBe(true)
    expect(otelOriginal.stopped).toBe(false)
    expect(uploadOriginal.stopped).toBe(false)
    // Registry now points at the new proxy instance.
    expect(registry.get('proxy')).toBe(proxy.instances[0])
    expect(registry.get('otel')).toBe(otelOriginal)
    expect(registry.get('upload')).toBe(uploadOriginal)
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toMatch(/proxy restarted/)
  })
})

describe('applyDiff: sink swap cascades to consumers', () => {
  it('restarts otel + proxy + upload when sink.dir changes (each owns a FileSink rooted there)', async () => {
    const oldCfg = gatewayConfig({
      otel: { listen: '127.0.0.1:4318' },
      sink: { dir: '/tmp/old' },
      upload: { bucket: 'b' },
    })
    const newCfg = gatewayConfig({
      otel: { listen: '127.0.0.1:4318' },
      sink: { dir: '/tmp/new' },
      upload: { bucket: 'b' },
    })
    const otel = stubFactory('otel')
    const proxy = stubFactory('proxy')
    const upload = stubFactory('upload')

    /** @type {Map<string, StartedListener>} */
    const registry = new Map([
      ['otel', stubListener('otel-original')],
      ['proxy', stubListener('proxy-original')],
      ['upload', stubListener('upload-original')],
    ])
    const otelOriginal = /** @type {ReturnType<typeof stubListener>} */ (registry.get('otel'))
    const proxyOriginal = /** @type {ReturnType<typeof stubListener>} */ (registry.get('proxy'))
    const uploadOriginal = /** @type {ReturnType<typeof stubListener>} */ (registry.get('upload'))

    function factoryBuilder() {
      return new Map([
        ['otel', otel.factory], ['proxy', proxy.factory], ['upload', upload.factory],
      ])
    }
    await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder, { stdout: memoStream(), stderr: memoStream() })

    expect(otel.calls).toBe(1)
    expect(proxy.calls).toBe(1)
    expect(upload.calls).toBe(1)
    expect(otelOriginal.stopped).toBe(true)
    expect(proxyOriginal.stopped).toBe(true)
    expect(uploadOriginal.stopped).toBe(true)
    expect(registry.size).toBe(3)
  })

  it('skips a non-existent consumer when sink changes (otel disabled)', async () => {
    const oldCfg = gatewayConfig({ otel: null, sink: { dir: '/tmp/old' } })
    const newCfg = gatewayConfig({ otel: null, sink: { dir: '/tmp/new' } })
    const proxy = stubFactory('proxy')
    /** @type {Map<string, StartedListener>} */
    const registry = new Map([['proxy', stubListener('proxy-original')]])
    function factoryBuilder() { return new Map([['proxy', proxy.factory]]) }
    await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder)
    expect(proxy.calls).toBe(1)
    expect(registry.has('otel')).toBe(false)
  })
})

describe('applyDiff: section removal', () => {
  it('removes a stopped listener from the registry when its section is removed', async () => {
    const oldCfg = gatewayConfig({ upload: { bucket: 'b' } })
    const newCfg = gatewayConfig({ upload: null })
    /** @type {Map<string, StartedListener>} */
    const registry = new Map([
      ['proxy', stubListener('proxy-original')],
      ['upload', stubListener('upload-original')],
    ])
    const uploadOriginal = /** @type {ReturnType<typeof stubListener>} */ (registry.get('upload'))
    const proxyOriginal = /** @type {ReturnType<typeof stubListener>} */ (registry.get('proxy'))
    const proxy = stubFactory('proxy')
    function factoryBuilder() { return new Map([['proxy', proxy.factory]]) }
    const stdout = memoStream()
    await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder, { stdout, stderr: memoStream() })

    expect(uploadOriginal.stopped).toBe(true)
    expect(registry.has('upload')).toBe(false)
    expect(proxyOriginal.stopped).toBe(false) // proxy untouched
    expect(proxy.calls).toBe(0)
    expect(stdout.value()).toMatch(/upload stopped/)
  })

  it('starts a freshly-added section without an old listener to stop', async () => {
    const oldCfg = gatewayConfig({ otel: null })
    const newCfg = gatewayConfig({ otel: { listen: '127.0.0.1:4318' } })
    /** @type {Map<string, StartedListener>} */
    const registry = new Map([['proxy', stubListener('proxy-original')]])
    const otel = stubFactory('otel')
    const proxy = stubFactory('proxy')
    function factoryBuilder() { return new Map([['otel', otel.factory], ['proxy', proxy.factory]]) }
    await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder)

    expect(otel.calls).toBe(1)
    expect(registry.get('otel')).toBe(otel.instances[0])
    // Proxy untouched: only the otel diff entry is non-unchanged.
    expect(proxy.calls).toBe(0)
  })
})

describe('applyDiff: failure modes', () => {
  it('keeps the old listener bound when the new factory throws on a different-port restart', async () => {
    const oldCfg = gatewayConfig({
      proxy: {
        listen: '127.0.0.1:8080',
        upstreams: [{ name: 'a', base_url: 'https://x.test', match: { path_prefix: '/v1' } }],
      },
    })
    const newCfg = gatewayConfig({
      proxy: {
        listen: '127.0.0.1:9090', // different port → start-before-stop path
        upstreams: [{ name: 'a', base_url: 'https://x.test', match: { path_prefix: '/v1' } }],
      },
    })
    const proxyOriginal = stubListener('proxy-original')
    /** @type {Map<string, StartedListener>} */
    const registry = new Map([['proxy', proxyOriginal]])
    const proxy = stubFactory('proxy', { throwsOnCall: 1 })
    function factoryBuilder() { return new Map([['proxy', proxy.factory]]) }
    const stderr = memoStream()
    await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder, { stdout: memoStream(), stderr })

    // Old listener never stopped.
    expect(proxyOriginal.stopped).toBe(false)
    expect(registry.get('proxy')).toBe(proxyOriginal)
    expect(stderr.value()).toMatch(/failed to start new proxy, keeping old/)
  })

  it('falls back to stop-then-start when the listen address is unchanged, and reports the empty section if the new bind fails', async () => {
    const oldCfg = gatewayConfig() // proxy on 127.0.0.1:8080
    const newCfg = gatewayConfig({
      proxy: {
        listen: '127.0.0.1:8080', // same listen
        upstreams: [{ name: 'b', base_url: 'https://y.test', match: { path_prefix: '/v2' } }],
      },
    })
    const proxyOriginal = stubListener('proxy-original')
    /** @type {Map<string, StartedListener>} */
    const registry = new Map([['proxy', proxyOriginal]])
    const proxy = stubFactory('proxy', { throwsOnCall: 1 })
    function factoryBuilder() { return new Map([['proxy', proxy.factory]]) }
    const stderr = memoStream()
    await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder, { stdout: memoStream(), stderr })

    expect(proxyOriginal.stopped).toBe(true) // we had to release the port first
    expect(registry.has('proxy')).toBe(false)
    expect(stderr.value()).toMatch(/failed to start new proxy after stopping old/)
  })

  it('logs and continues when the old stop() throws (best-effort drain)', async () => {
    const oldCfg = gatewayConfig({ upload: { bucket: 'b' } })
    const newCfg = gatewayConfig({ upload: { bucket: 'c' } })
    const uploadOriginal = stubListener('upload-original', { stopThrows: () => new Error('flush failed') })
    /** @type {Map<string, StartedListener>} */
    const registry = new Map([['upload', uploadOriginal]])
    const upload = stubFactory('upload')
    function factoryBuilder() { return new Map([['upload', upload.factory]]) }
    const stderr = memoStream()
    await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder, { stdout: memoStream(), stderr })

    // Upload doesn't bind a port → start-before-stop. Old throws on stop;
    // restart still completes.
    expect(upload.calls).toBe(1)
    expect(registry.get('upload')).toBe(upload.instances[0])
    expect(stderr.value()).toMatch(/error stopping upload: flush failed/)
  })

  it('returns immediately and rebuilds nothing when the diff is all-unchanged', async () => {
    const cfg = gatewayConfig({ upload: { bucket: 'b' } })
    /** @type {Map<string, StartedListener>} */
    const registry = new Map([
      ['proxy', stubListener('proxy-original')],
      ['upload', stubListener('upload-original')],
    ])
    let builderCalls = 0
    function factoryBuilder() {
      builderCalls++
      return new Map()
    }
    await applyDiff(diffConfig(cfg, cfg), cfg, cfg, registry, factoryBuilder)
    expect(builderCalls).toBe(0)
    expect(registry.size).toBe(2)
  })
})

describe('applyDiff: sequential restarts', () => {
  it('applies five back-to-back proxy changes without leaking listeners', async () => {
    /** @type {Map<string, StartedListener>} */
    const registry = new Map([['proxy', stubListener('proxy-0')]])
    const proxy = stubFactory('proxy')
    function factoryBuilder() { return new Map([['proxy', proxy.factory]]) }

    /** @type {ReturnType<typeof stubListener>[]} */
    const observedOriginals = [/** @type {ReturnType<typeof stubListener>} */ (registry.get('proxy'))]

    let oldCfg = gatewayConfig()
    for (let i = 0; i < 5; i++) {
      const newCfg = gatewayConfig({
        proxy: {
          listen: '127.0.0.1:8080',
          upstreams: [{
            name: `u${i}`,
            base_url: `https://h${i}.test`,
            match: { path_prefix: `/v${i}` },
          }],
        },
      })
      await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder)
      observedOriginals.push(/** @type {ReturnType<typeof stubListener>} */ (registry.get('proxy')))
      oldCfg = newCfg
    }

    expect(proxy.calls).toBe(5)
    // The boot listener plus the four intermediates were all stopped exactly
    // once; only the final instance is still in the registry.
    for (let i = 0; i < observedOriginals.length - 1; i++) {
      expect(observedOriginals[i].stopped).toBe(true)
      expect(observedOriginals[i].stops).toBe(1)
    }
    const final = observedOriginals[observedOriginals.length - 1]
    expect(final.stopped).toBe(false)
    expect(registry.size).toBe(1)
    expect(registry.get('proxy')).toBe(final)
  })
})

describe('applyDiff: factoryBuilder failure', () => {
  it('logs and leaves the old registry intact when factoryBuilder throws', async () => {
    const oldCfg = gatewayConfig()
    const newCfg = gatewayConfig({
      proxy: {
        listen: '127.0.0.1:9090',
        upstreams: [{ name: 'b', base_url: 'https://y.test', match: { path_prefix: '/v2' } }],
      },
    })
    const proxyOriginal = stubListener('proxy-original')
    /** @type {Map<string, StartedListener>} */
    const registry = new Map([['proxy', proxyOriginal]])
    /** @returns {Map<string, ListenerFactory>} */
    function factoryBuilder() { throw new Error('builder boom') }
    const stderr = memoStream()
    await applyDiff(diffConfig(oldCfg, newCfg), oldCfg, newCfg, registry, factoryBuilder, { stdout: memoStream(), stderr })

    expect(proxyOriginal.stopped).toBe(false)
    expect(registry.get('proxy')).toBe(proxyOriginal)
    expect(stderr.value()).toMatch(/failed to build new factories: builder boom/)
  })
})
