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
