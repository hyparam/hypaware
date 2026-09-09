// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createBackfillMaterializerRegistry,
  createBackfillRegistry,
} from '../../src/core/registry/backfills.js'

/** @param {Record<string, unknown>} [overrides] */
function provider(overrides = {}) {
  return {
    name: 'claude',
    plugin: '@hypaware/claude',
    datasets: ['ai_gateway_messages'],
    summary: 'Backfill Claude transcripts',
    async *run() {},
    ...overrides,
  }
}

/** @param {Record<string, unknown>} [overrides] */
function materializer(overrides = {}) {
  return {
    kind: 'ai_gateway.projected_exchange',
    dataset: 'ai_gateway_messages',
    plugin: '@hypaware/ai-gateway',
    materialize() { return [] },
    ...overrides,
  }
}

test('BackfillRegistry registers, gets, and lists providers sorted by name', () => {
  const reg = createBackfillRegistry()
  reg.register(provider({ name: 'codex', plugin: '@hypaware/codex' }))
  reg.register(provider({ name: 'claude' }))
  assert.deepEqual(reg.list().map((p) => p.name), ['claude', 'codex'])
  assert.equal(reg.get('claude')?.plugin, '@hypaware/claude')
  assert.equal(reg.get('codex')?.plugin, '@hypaware/codex')
  assert.equal(reg.get('missing'), undefined)
})

test('BackfillRegistry rejects a duplicate provider name', () => {
  const reg = createBackfillRegistry()
  reg.register(provider())
  assert.throws(() => reg.register(provider()), /duplicate provider 'claude'/)
})

test('BackfillRegistry validates the contribution shape', () => {
  const reg = createBackfillRegistry()
  assert.throws(() => reg.register(/** @type {any} */ (null)), /must be an object/)
  assert.throws(() => reg.register(/** @type {any} */ (provider({ name: '' }))), /name/)
  assert.throws(() => reg.register(/** @type {any} */ (provider({ plugin: '' }))), /missing plugin/)
  assert.throws(() => reg.register(/** @type {any} */ (provider({ datasets: [] }))), /datasets/)
  assert.throws(() => reg.register(/** @type {any} */ (provider({ run: undefined }))), /missing run/)
  assert.throws(() => reg.register(/** @type {any} */ (provider({ plan: 'nope' }))), /plan must be a function/)
})

test('BackfillRegistry accepts a provider with an optional plan() hook', () => {
  const reg = createBackfillRegistry()
  assert.doesNotThrow(() => reg.register(provider({ async plan() { return undefined } })))
})

test('BackfillMaterializerRegistry registers, gets, lists, and rejects duplicate kinds', () => {
  const reg = createBackfillMaterializerRegistry()
  reg.register(materializer())
  assert.equal(reg.get('ai_gateway.projected_exchange')?.dataset, 'ai_gateway_messages')
  assert.deepEqual(reg.list().map((m) => m.kind), ['ai_gateway.projected_exchange'])
  assert.equal(reg.get('unknown.kind'), undefined)
  assert.throws(() => reg.register(materializer()), /duplicate kind 'ai_gateway.projected_exchange'/)
})

test('BackfillMaterializerRegistry validates the contribution shape', () => {
  const reg = createBackfillMaterializerRegistry()
  assert.throws(() => reg.register(/** @type {any} */ (null)), /must be an object/)
  assert.throws(() => reg.register(/** @type {any} */ (materializer({ kind: '' }))), /kind/)
  assert.throws(() => reg.register(/** @type {any} */ (materializer({ dataset: '' }))), /missing dataset/)
  assert.throws(() => reg.register(/** @type {any} */ (materializer({ plugin: '' }))), /missing plugin/)
  assert.throws(() => reg.register(/** @type {any} */ (materializer({ materialize: undefined }))), /missing materialize/)
})

// `kind` is validated once and the registry then stores the contribution by
// reference, so every later read is a plugin accessor running again. Sorting
// `list()` by `a.kind` put one of those reads inside a comparator, where a
// throw escapes before a single entry has been handed back and costs every
// materializer rather than the hostile one (#1519). Same shape as #1518, one
// function up.

test('BackfillMaterializerRegistry.list() survives a kind that stops being readable', () => {
  const reg = createBackfillMaterializerRegistry()
  let armed = false
  reg.register(/** @type {any} */ ({
    get kind() {
      if (armed) throw new TypeError('kind is not readable')
      return 'a_hostile.kind'
    },
    dataset: 'ai_gateway_messages',
    plugin: '@third-party/hostile-kind',
    materialize() { return [] },
  }))
  reg.register(materializer({ kind: 'z_readable.kind' }))
  armed = true

  const listed = reg.list()

  assert.equal(listed.length, 2, 'one unreadable kind emptied the whole listing')
  assert.equal(listed[0]?.dataset, 'ai_gateway_messages')
  assert.equal(listed[1]?.plugin, '@hypaware/ai-gateway')
})

test('BackfillMaterializerRegistry keys a materializer by the kind it validated', () => {
  // What the ordering rests on. A getter that answers once and then
  // differently must not be validated under one string and stored under
  // another: the runner looks materializers up by `BackfillItem.kind` and
  // nothing else, so a key nobody validated is a materializer nobody reaches.
  const reg = createBackfillMaterializerRegistry()
  let reads = 0
  reg.register(/** @type {any} */ ({
    get kind() { reads += 1; return reads === 1 ? 'a_honest.kind' : 'z_mutated.kind' },
    dataset: 'ai_gateway_messages',
    plugin: '@third-party/mutating-kind',
    materialize() { return [] },
  }))

  assert.equal(reads, 1, 'register read the plugin\'s `kind` more than once')
  assert.notEqual(reg.get('a_honest.kind'), undefined, 'the validated kind no longer addresses the materializer')
  assert.equal(reg.get('z_mutated.kind'), undefined)
  assert.deepEqual(reg.list().map((m) => m.dataset), ['ai_gateway_messages'])
})

test('BackfillMaterializerRegistry reads dataset and plugin before it stores anything', () => {
  // A `dataset` that raises only on its second read must not raise from the
  // log record below the `set`: that leaves the registry holding a
  // materializer while the loader catches the throw and fails the plugin's
  // whole activation.
  const reg = createBackfillMaterializerRegistry()
  let reads = 0
  assert.doesNotThrow(() => reg.register(/** @type {any} */ ({
    kind: 'ai_gateway.projected_exchange',
    get dataset() {
      reads += 1
      if (reads > 1) throw new TypeError('dataset is not readable')
      return 'ai_gateway_messages'
    },
    plugin: '@third-party/late-dataset',
    materialize() { return [] },
  })))
  assert.equal(reg.get('ai_gateway.projected_exchange')?.plugin, '@third-party/late-dataset')
})
