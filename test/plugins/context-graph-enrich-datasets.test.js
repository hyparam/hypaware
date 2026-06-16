// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { columnsFor, COMMITTED_DATASET, PROSPECTS_DATASET, prospectId, unionSources } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/datasets.js'

test('prospectId is deterministic for the same inputs', () => {
  const a = prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-1', candidateKey: 'Decision Use Redis' })
  const b = prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-1', candidateKey: 'Decision Use Redis' })
  assert.equal(a, b)
  assert.equal(a.length, 24)
})

test('prospectId changes with any input (anchor, candidate, version)', () => {
  const base = prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-1', candidateKey: 'Decision X' })
  assert.notEqual(base, prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-2', candidateKey: 'Decision X' }))
  assert.notEqual(base, prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-1', candidateKey: 'Decision Y' }))
  assert.notEqual(base, prospectId({ extractor: 'enrich.t1', extractorVersion: 2, anchorKey: 'conv-1', candidateKey: 'Decision X' }))
})

test('columnsFor returns the schema for known datasets and throws otherwise', () => {
  assert.ok(columnsFor(PROSPECTS_DATASET).some((c) => c.name === 'prospect_id'))
  assert.ok(columnsFor(COMMITTED_DATASET).some((c) => c.name === 'item_id'))
  assert.throws(() => columnsFor('nope'))
})

test('unionSources concatenates rows, unions columns, sums numRows, and strips limit/offset from sub-scans', async () => {
  /** @type {any[]} */
  const captured = []
  /** @param {string[]} columns @param {Record<string, unknown>[]} rows */
  const src = (columns, rows) => /** @type {any} */ ({
    columns,
    numRows: rows.length,
    /** @param {Record<string, unknown>} [options] */
    scan(options) {
      captured.push(options)
      return { appliedWhere: false, appliedLimitOffset: false, async *rows() { for (const r of rows) yield r } }
    },
  })

  const u = unionSources([src(['a', 'b'], [{ a: 1 }]), src(['b', 'c'], [{ c: 2 }, { c: 3 }])])
  assert.deepEqual([...u.columns].sort(), ['a', 'b', 'c'], 'columns are the union')
  assert.equal(u.numRows, 3, 'numRows is the sum')

  const scan = u.scan(/** @type {any} */ ({ limit: 5, offset: 2, where: 'x' }))
  assert.equal(scan.appliedLimitOffset, false, 'the engine must apply limit/offset once over the concatenated stream')
  /** @type {any[]} */
  const out = []
  for await (const r of scan.rows()) out.push(r)
  assert.deepEqual(out, [{ a: 1 }, { c: 2 }, { c: 3 }], 'rows are concatenated in source order')

  assert.equal(captured.length, 2)
  for (const o of captured) {
    assert.equal(o.limit, undefined, 'limit is stripped so it is not applied twice')
    assert.equal(o.offset, undefined, 'offset is stripped so it is not applied twice')
    assert.equal(o.where, 'x', 'other scan options still pass through')
  }
})
