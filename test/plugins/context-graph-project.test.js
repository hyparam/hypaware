// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { firstSeenTime, mergeRow } from '../../hypaware-core/plugins-workspace/context-graph/src/project.js'

/**
 * @param {Partial<Record<string, unknown>>} overrides
 * @returns {any}
 */
function row(overrides) {
  return {
    node_id: 'n-1',
    node_type: 'Session',
    natural_key: 'conv-1',
    label: null,
    props: null,
    first_seen: '2026-06-01T00:00:00.000Z',
    source_dataset: 'ai_gateway_messages',
    source_keys: null,
    projector: 'ai-gateway.t0',
    projector_version: 1,
    ...overrides,
  }
}

/**
 * Fold rows into a fresh accumulator in the given order.
 *
 * @param {any[]} rows
 * @returns {any}
 */
function fold(rows) {
  const acc = { ...rows[0] }
  for (let i = 1; i < rows.length; i++) mergeRow(acc, rows[i])
  return acc
}

test('mergeRow keeps the earliest first_seen and unions disjoint props', () => {
  const merged = fold([
    row({ first_seen: '2026-06-03T00:00:00.000Z', props: { cwd: '/late' } }),
    row({ first_seen: '2026-06-01T00:00:00.000Z', props: { git_branch: 'main' } }),
  ])
  assert.equal(merged.first_seen, '2026-06-01T00:00:00.000Z')
  assert.deepEqual(merged.props, { cwd: '/late', git_branch: 'main' })
})

test('mergeRow resolves props conflicts in favor of the earliest row, in any merge order', () => {
  const early = row({ first_seen: '2026-06-01T00:00:00.000Z', props: { cwd: '/early', git_branch: 'main' } })
  const late = row({ first_seen: '2026-06-02T00:00:00.000Z', props: { cwd: '/late', git_branch: 'feature' } })

  const ab = fold([{ ...early }, { ...late }])
  const ba = fold([{ ...late }, { ...early }])
  assert.deepEqual(ab.props, { cwd: '/early', git_branch: 'main' })
  assert.deepEqual(ba.props, ab.props, 'merge order does not change the result')
  assert.equal(ab.first_seen, '2026-06-01T00:00:00.000Z')
  assert.equal(ba.first_seen, '2026-06-01T00:00:00.000Z')
})

test('mergeRow is order-independent when a key is absent from the earliest row', () => {
  const a = row({ first_seen: '2026-06-01T00:00:00.000Z', props: {} })
  const b = row({ first_seen: '2026-06-02T00:00:00.000Z', props: { cwd: '/b' } })
  const c = row({ first_seen: '2026-06-03T00:00:00.000Z', props: { cwd: '/c' } })

  const orders = [
    [a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a],
  ].map((order) => fold(order.map((r) => ({ ...r }))))

  for (const merged of orders) {
    assert.deepEqual(merged.props, { cwd: '/b' }, 'value from the earliest row that defines the key wins')
    assert.equal(merged.first_seen, '2026-06-01T00:00:00.000Z')
  }
})

test('mergeRow breaks equal-timestamp conflicts by value, order-independently', () => {
  const x = row({ first_seen: '2026-06-01T00:00:00.000Z', props: { cwd: '/a' } })
  const y = row({ first_seen: '2026-06-01T00:00:00.000Z', props: { cwd: '/b' } })
  const xy = fold([{ ...x }, { ...y }])
  const yx = fold([{ ...y }, { ...x }])
  assert.deepEqual(xy.props, yx.props, 'tie-break is symmetric')
  assert.deepEqual(xy.props, { cwd: '/a' })
})

test('mergeRow tolerates rows with unparseable or missing first_seen', () => {
  const known = row({ first_seen: '2026-06-01T00:00:00.000Z', props: { cwd: '/known' } })
  const unknown = row({ first_seen: null, props: { cwd: '/unknown' } })
  const ab = fold([{ ...known }, { ...unknown }])
  const ba = fold([{ ...unknown }, { ...known }])
  assert.deepEqual(ab.props, { cwd: '/known' }, 'a known time beats an unknown one')
  assert.deepEqual(ba.props, ab.props)
  assert.equal(ab.first_seen, '2026-06-01T00:00:00.000Z')
  assert.equal(ba.first_seen, '2026-06-01T00:00:00.000Z')
})

test('firstSeenTime normalizes strings, Dates, and epoch numbers', () => {
  const t = Date.UTC(2026, 5, 1)
  assert.equal(firstSeenTime('2026-06-01T00:00:00.000Z'), t)
  assert.equal(firstSeenTime(new Date(t)), t)
  assert.equal(firstSeenTime(t), t)
  assert.equal(firstSeenTime('not a date'), undefined)
  assert.equal(firstSeenTime(null), undefined)
  assert.equal(firstSeenTime(Infinity), undefined)
})
