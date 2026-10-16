// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { createSourceRegistry } from '../../src/core/registry/sources.js'

// `SourceRegistry.register` validates `contribution.name` and then stores the
// contribution **by reference**, so every later read runs the plugin's
// property again. The duplicate check and the Map key came from two different
// reads, which is not a refusal a hostile accessor has to beat: it answers an
// unclaimed name for `contributions.has()` and a claimed one for
// `contributions.set()`, and takes the claimed source over (#1530). Same shape
// as #1518 / #1519 in the backfill registries and #1524 in the dataset one.
//
// The hostile registrations below are written as object literals rather than
// through `source()`: an object spread reads a getter once and copies the
// value, which would leave the accessor behind and the test proving nothing.

/** @param {Record<string, unknown>} [overrides] */
function source(overrides = {}) {
  return /** @type {any} */ ({
    name: 'ai_gateway',
    plugin: '@hypaware/ai-gateway',
    async start() { return { async stop() {} } },
    ...overrides,
  })
}

test('the source registry registers, gets, and lists sources sorted by name', () => {
  const reg = createSourceRegistry()
  reg.register(source({ name: 'otel_listener', plugin: '@hypaware/otel' }))
  reg.register(source({ name: 'B_source', plugin: '@third-party/upper' }))
  reg.register(source({ name: 'ai_gateway' }))

  // Character order, not the host's collation: an ICU root collation puts
  // `B_source` after `ai_gateway`, and `compareStrings` must not.
  assert.deepEqual(reg.list().map((c) => c.name), ['B_source', 'ai_gateway', 'otel_listener'])
  assert.equal(reg.get('ai_gateway')?.plugin, '@hypaware/ai-gateway')
  assert.equal(reg.get('missing'), undefined)
})

test('the source registry rejects a malformed contribution and a duplicate name', () => {
  const reg = createSourceRegistry()
  assert.throws(() => reg.register(/** @type {any} */ (null)), /contribution must be an object/)
  assert.throws(() => reg.register(source({ name: '' })), /contribution.name must be a non-empty string/)
  assert.throws(() => reg.register(source({ plugin: '' })), /missing plugin/)
  assert.throws(() => reg.register(source({ start: undefined })), /missing start\(\)/)
  reg.register(source())
  assert.throws(() => reg.register(source()), /duplicate source name 'ai_gateway'/)
})

test('register keys a source by the name it validated', () => {
  // The reported defect. `contributions.has()` and `contributions.set()` used
  // to read `contribution.name` separately, so a getter answering an unclaimed
  // name for the check and `ai_gateway` for the write was not refused as a
  // duplicate: it replaced the honest registration, and with it whatever the
  // kernel starts under that name.
  const reg = createSourceRegistry()
  reg.register(source())
  let reads = 0
  reg.register(/** @type {any} */ ({
    get name() {
      reads += 1
      return reads >= 4 ? 'ai_gateway' : 'a_hostile'
    },
    plugin: '@evil/x',
    async start() { return { async stop() {} } },
  }))

  assert.equal(reads, 1, 'register read the plugin\'s `name` more than once')
  assert.equal(reg.get('ai_gateway')?.plugin, '@hypaware/ai-gateway', 'a later read displaced a registered source')
  assert.equal(reg.get('a_hostile')?.plugin, '@evil/x')
  assert.deepEqual(reg.list().map((c) => c.plugin), ['@evil/x', '@hypaware/ai-gateway'])
})

test('the takeover flip point is a result, not an artefact', () => {
  // Controls for the case above: move the getter's boundary either way and the
  // attack has to fail on master too, which is what makes the middle case the
  // finding. At flip 3 the claimed name reaches `has()` and is refused; at
  // flip 5 the write already happened under the hostile name. Only flip 4,
  // between the check and the write, was the takeover.
  for (const flip of [3, 5]) {
    const reg = createSourceRegistry()
    reg.register(source())
    let reads = 0
    const hostile = /** @type {any} */ ({
      get name() {
        reads += 1
        return reads >= flip ? 'ai_gateway' : 'a_hostile'
      },
      plugin: '@evil/x',
      async start() { return { async stop() {} } },
    })
    try {
      reg.register(hostile)
    } catch {
      // flip 3 is refused as a duplicate, which is the point of the control
    }
    assert.equal(reg.get('ai_gateway')?.plugin, '@hypaware/ai-gateway', `flip ${flip} displaced the honest source`)
  }
})

test('register reads every plugin property before the Map is touched', () => {
  // `plugin` was read a third time, and `configSection` for the first time,
  // in the `source.register` record below the `set`. An accessor that raises
  // there left this registry holding the contribution while the loader caught
  // the throw and marked the whole plugin's activation failed, so the kernel
  // reported a plugin that had not loaded and a source it would still start.
  const reg = createSourceRegistry()
  let pluginReads = 0
  assert.doesNotThrow(() => reg.register(/** @type {any} */ ({
    name: 'counted',
    get plugin() {
      pluginReads += 1
      if (pluginReads >= 3) throw new TypeError('plugin is not readable')
      return '@third-party/counted'
    },
    async start() { return { async stop() {} } },
  })))
  assert.equal(pluginReads, 1, 'register read the plugin\'s `plugin` more than once')

  const other = createSourceRegistry()
  assert.throws(() => other.register(/** @type {any} */ ({
    name: 'half',
    plugin: '@third-party/raising-section',
    async start() { return { async stop() {} } },
    get configSection() { throw new TypeError('configSection is not readable') },
  })), /configSection is not readable/)
  assert.equal(other.get('half'), undefined, 'a refused registration was left in the registry')
})

test('list() survives a name that stops being readable', () => {
  const reg = createSourceRegistry()
  let armed = false
  reg.register(/** @type {any} */ ({
    get name() {
      if (armed) throw new TypeError('name is not readable')
      return 'a_hostile'
    },
    plugin: '@third-party/hostile-name',
    async start() { return { async stop() {} } },
  }))
  reg.register(source({ name: 'z_readable', plugin: '@hypaware/otel' }))
  armed = true

  const listed = reg.list()

  assert.equal(listed.length, 2, 'one unreadable name emptied the whole listing')
  assert.deepEqual(listed.map((c) => c.plugin), ['@third-party/hostile-name', '@hypaware/otel'])
})

test('list() survives a name that stops being a string', () => {
  // `compareStrings` refuses a non-string rather than answering `0` from it,
  // so an accessor that merely stopped answering was the same outage as a
  // throw.
  const reg = createSourceRegistry()
  let armed = false
  reg.register(/** @type {any} */ ({
    get name() { return armed ? undefined : 'a_hostile' },
    plugin: '@third-party/vanishing-name',
    async start() { return { async stop() {} } },
  }))
  reg.register(source({ name: 'z_readable', plugin: '@hypaware/otel' }))
  armed = true

  assert.deepEqual(reg.list().map((c) => c.plugin), ['@third-party/vanishing-name', '@hypaware/otel'])
})

test('start attributes its span and its counter from one read of plugin', async () => {
  // `start` read `contribution.plugin` twice, once for the `source.start` span
  // and once for the `hyp_sources_started` counter, so the two could name
  // different plugins for one start.
  const reg = createSourceRegistry()
  let reads = 0
  let counting = false
  reg.register(/** @type {any} */ ({
    name: 'counted',
    get plugin() {
      if (counting) reads += 1
      return '@third-party/counted'
    },
    async start() { return { async stop() {} } },
  }))
  counting = true
  await reg.start('counted', /** @type {any} */ ({}))

  assert.equal(reads, 1, 'start read the plugin\'s `plugin` more than once')
  await reg.stop('counted')
})
