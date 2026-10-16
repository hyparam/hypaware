// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { createQueryRegistry } from '../../src/core/registry/datasets.js'

// `registerDataset` validates `dataset.name` and then stores the registration
// **by reference**, so every later read runs the plugin's property again.
// Sorting `listDatasets()` by `a.name` put one of those reads inside a
// comparator, where a throw escapes before a single dataset has been handed
// back: one hostile contribution emptied the listing for `hyp query`, `hyp
// status`, the sync preview and the sink driver's partition discovery, which
// runs on the daemon's own tick (#1524). Same shape as #1518 and #1519 in the
// backfill registries next door.
//
// The hostile registrations below are written as object literals rather than
// through `dataset()`: an object spread reads a getter once and copies the
// value, which would leave the accessor behind and the test proving nothing.

const SCHEMA = { columns: [{ name: 'ts', type: 'TIMESTAMP', nullable: false }] }

/** @param {Record<string, unknown>} [overrides] */
function dataset(overrides = {}) {
  return /** @type {any} */ ({
    name: 'logs',
    plugin: '@hypaware/otel',
    schema: SCHEMA,
    discoverPartitions() { return [] },
    createDataSource() { return /** @type {any} */ ({}) },
    ...overrides,
  })
}

test('the query registry registers, gets, and lists datasets sorted by name', () => {
  const reg = createQueryRegistry()
  reg.registerDataset(dataset({ name: 'traces', plugin: '@hypaware/otel' }))
  reg.registerDataset(dataset({ name: 'ai_gateway_messages', plugin: '@hypaware/ai-gateway' }))
  reg.registerDataset(dataset({ name: 'logs' }))

  assert.deepEqual(reg.listDatasets().map((d) => d.name), ['ai_gateway_messages', 'logs', 'traces'])
  assert.equal(reg.getDataset('logs')?.plugin, '@hypaware/otel')
  assert.equal(reg.getDataset('missing'), undefined)
})

test('the query registry rejects a nameless dataset and a duplicate name', () => {
  const reg = createQueryRegistry()
  assert.throws(() => reg.registerDataset(/** @type {any} */ (null)), /dataset.name is required/)
  assert.throws(() => reg.registerDataset(dataset({ name: '' })), /dataset.name is required/)
  reg.registerDataset(dataset())
  assert.throws(() => reg.registerDataset(dataset()), /dataset 'logs' already registered/)
})

test('listDatasets() survives a name that stops being readable', () => {
  const reg = createQueryRegistry()
  let armed = false
  reg.registerDataset(/** @type {any} */ ({
    get name() {
      if (armed) throw new TypeError('name is not readable')
      return 'a_hostile'
    },
    plugin: '@third-party/hostile-name',
    schema: SCHEMA,
    discoverPartitions() { return [] },
  }))
  reg.registerDataset(dataset({ name: 'z_readable' }))
  armed = true

  const listed = reg.listDatasets()

  assert.equal(listed.length, 2, 'one unreadable name emptied the whole listing')
  assert.equal(listed[0]?.plugin, '@third-party/hostile-name')
  assert.equal(listed[1]?.plugin, '@hypaware/otel')
})

test('listDatasets() survives a name that stops being a string', () => {
  // `compareStrings` refuses a non-string rather than answering `0` from it, so
  // an accessor that merely stopped answering was the same outage as a throw.
  const reg = createQueryRegistry()
  let armed = false
  reg.registerDataset(/** @type {any} */ ({
    get name() { return armed ? undefined : 'a_hostile' },
    plugin: '@third-party/vanishing-name',
    schema: SCHEMA,
    discoverPartitions() { return [] },
  }))
  reg.registerDataset(dataset({ name: 'z_readable' }))
  armed = true

  assert.deepEqual(reg.listDatasets().map((d) => d.plugin), ['@third-party/vanishing-name', '@hypaware/otel'])
})

test('registerDataset keys a dataset by the name it validated', () => {
  // What the ordering rests on, and more than that: the duplicate check and the
  // Map key used to come from different reads, so a getter answering one way
  // for `datasets.has()` and another for `datasets.set()` registered under a
  // name nothing validated - and, when the second answer was a name already
  // taken, silently displaced another plugin's dataset.
  const reg = createQueryRegistry()
  reg.registerDataset(dataset({ name: 'logs' }))
  let reads = 0
  reg.registerDataset(/** @type {any} */ ({
    get name() {
      reads += 1
      return reads > 3 ? 'logs' : 'a_hostile'
    },
    plugin: '@third-party/mutating-name',
    schema: SCHEMA,
    discoverPartitions() { return [] },
  }))

  assert.equal(reads, 1, 'registerDataset read the plugin\'s `name` more than once')
  assert.equal(reg.getDataset('logs')?.plugin, '@hypaware/otel', 'a later read displaced a registered dataset')
  assert.equal(reg.getDataset('a_hostile')?.plugin, '@third-party/mutating-name')
  assert.deepEqual(reg.listDatasets().map((d) => d.plugin), ['@third-party/mutating-name', '@hypaware/otel'])
})

test('registerDataset validates the cachePartitioning declaration it stores', () => {
  // `cachePartitioning` was read twice, once for the `if` and once for the
  // validation, so a declaration could pass the truthiness check and a
  // different one be the one checked.
  const reg = createQueryRegistry()
  let reads = 0
  const declaration = {
    source: { columns: ['ts'] },
    iceberg: { fields: [{ column: 'ts', transform: 'identity' }] },
  }
  reg.registerDataset(/** @type {any} */ ({
    name: 'counted',
    plugin: '@third-party/counted-declaration',
    schema: SCHEMA,
    discoverPartitions() { return [] },
    get cachePartitioning() { reads += 1; return declaration },
  }))

  assert.equal(reads, 1, 'registerDataset read the plugin\'s `cachePartitioning` more than once')
})
