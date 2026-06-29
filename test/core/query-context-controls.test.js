// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyContextControls, renderResult } from '../../src/core/query/format.js'

/** @param {Record<string, unknown>[]} rows */
const set = (rows) => ({ columns: rows[0] ? Object.keys(rows[0]) : [], rows })

test('cell truncation clips long strings with a sized marker, leaves short ones', () => {
  const long = 'x'.repeat(250)
  const { result, notice } = applyContextControls(
    set([{ id: 1, content: long, role: 'user' }]),
    { maxCell: 200, maxBytes: 0 }
  )
  const cell = /** @type {string} */ (result.rows[0].content)
  assert.equal(cell, 'x'.repeat(200) + '…(+50)')
  assert.equal(result.rows[0].role, 'user') // short string untouched
  assert.equal(result.rows[0].id, 1) // number type preserved
  assert.equal(notice, undefined)
})

test('cell truncation recurses into nested objects/arrays and preserves JSON validity', () => {
  const { result } = applyContextControls(
    set([{ args: { command: 'y'.repeat(300), nested: ['z'.repeat(10)] } }]),
    { maxCell: 50, maxBytes: 0 }
  )
  const args = /** @type {{ command: string, nested: string[] }} */ (result.rows[0].args)
  assert.equal(args.command, 'y'.repeat(50) + '…(+250)')
  assert.equal(args.nested[0], 'z'.repeat(10)) // under cap, untouched
  // Still serializes as valid JSON (truncation only shrinks string leaves).
  assert.doesNotThrow(() => JSON.parse(renderResult(result, 'jsonl').trim()))
})

test('cell truncation counts code points, never splitting a multibyte char', () => {
  const { result } = applyContextControls(set([{ s: '😀'.repeat(10) }]), { maxCell: 4, maxBytes: 0 })
  assert.equal(result.rows[0].s, '😀'.repeat(4) + '…(+6)')
})

test('maxCell = 0 disables truncation', () => {
  const long = 'x'.repeat(500)
  const { result } = applyContextControls(set([{ c: long }]), { maxCell: 0, maxBytes: 0 })
  assert.equal(result.rows[0].c, long)
})

test('byte budget drops trailing rows and emits a notice naming the counts', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ i, blob: 'b'.repeat(100) }))
  const { result, notice } = applyContextControls(set(rows), { maxCell: 0, maxBytes: 1000 })
  assert.ok(result.rows.length < 100)
  assert.ok(result.rows.length >= 1)
  assert.match(notice ?? '', new RegExp(`showing ${result.rows.length} of 100 rows`))
  assert.match(notice ?? '', /--output/)
})

test('byte budget always keeps at least one row even if it alone exceeds the budget', () => {
  const { result, notice } = applyContextControls(
    set([{ huge: 'h'.repeat(5000) }, { huge: 'h'.repeat(5000) }]),
    { maxCell: 0, maxBytes: 10 }
  )
  assert.equal(result.rows.length, 1)
  assert.match(notice ?? '', /showing 1 of 2 rows/)
})

test('no notice when nothing is dropped', () => {
  const { notice } = applyContextControls(set([{ a: 1 }]), { maxCell: 200, maxBytes: 32768 })
  assert.equal(notice, undefined)
})

test('input result is not mutated', () => {
  const input = set([{ c: 'x'.repeat(300) }])
  applyContextControls(input, { maxCell: 50, maxBytes: 100 })
  assert.equal(input.rows[0].c, 'x'.repeat(300))
  assert.equal(input.rows.length, 1)
})

test('truncation is lazy: rows past the budget are never touched', () => {
  // A row whose field throws on access: clipping or serializing it would
  // throw. It sits past the cutoff (row 0 fills the budget, row 1 triggers
  // the break), so a lazy implementation must never reach row 2.
  const r0 = { a: 'small' }
  const r1 = { a: 'small' }
  const r2 = { a: 'small' }
  Object.defineProperty(r2, 'boom', {
    enumerable: true,
    get() { throw new Error('row past budget was truncated') },
  })
  // Row 0 alone exceeds the 3-byte budget, so only it is kept.
  const { result } = applyContextControls({ columns: ['a'], rows: [r0, r1, r2] }, { maxCell: 10, maxBytes: 3 })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].a, 'small')
})
