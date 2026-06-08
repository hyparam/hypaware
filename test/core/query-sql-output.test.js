// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildQuerySqlOutput } from '../../src/core/cli/core_commands.js'

/** @type {Parameters<typeof buildQuerySqlOutput>[1]} */
const baseOpts = { format: 'json', output: undefined, maxCell: 200, maxBytes: 32_768 }
/** @param {Record<string, unknown>[]} rows */
const set = (rows) => ({ columns: rows[0] ? Object.keys(rows[0]) : [], rows })

test('spill mode: file content is the full lossless result, stdout is a receipt', () => {
  const long = 'x'.repeat(500)
  const full = set([{ id: 1, content: long }, { id: 2, content: 'short' }])
  const out = buildQuerySqlOutput(full, { ...baseOpts, format: 'jsonl', output: '/tmp/spill.jsonl' })

  assert.ok(out.file)
  assert.equal(out.file.path, '/tmp/spill.jsonl')
  // Lossless: the long cell survives in full, with no truncation marker.
  const fileRows = out.file.content.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(fileRows.length, 2)
  assert.equal(fileRows[0].content, long)
  assert.doesNotMatch(out.file.content, /…\(\+/)
  // Receipt on stdout names the shape; stderr stays empty.
  assert.match(out.stdout, /wrote 2 rows · 2 cols · \d+B → \/tmp\/spill\.jsonl/)
  // The receipt's byte count reflects the actual file content (single render).
  assert.match(out.stdout, new RegExp(`· ${Buffer.byteLength(out.file.content)}B →`))
  assert.match(out.stdout, /schema: id, content/)
  assert.match(out.stdout, /preview \(first 2, cells clipped\):/)
  assert.equal(out.stderr, '')
})

test('spill receipt preview clips cells even though the file does not', () => {
  const out = buildQuerySqlOutput(set([{ c: 'y'.repeat(300) }]), {
    ...baseOpts,
    format: 'jsonl',
    output: '/tmp/x.jsonl',
  })
  assert.match(out.stdout, /…\(\+/) // preview clipped
  assert.doesNotMatch(out.file?.content ?? '', /…\(\+/) // file intact
})

test('inline mode: small result renders in full to stdout, no notice', () => {
  const full = set([{ a: 1, b: 'hi' }])
  const out = buildQuerySqlOutput(full, baseOpts)
  assert.equal(out.stderr, '')
  assert.equal(out.file, undefined)
  assert.deepEqual(JSON.parse(out.stdout), [{ a: 1, b: 'hi' }])
})

test('inline mode: over-budget result caps rows, stdout stays valid JSON, notice to stderr', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ i, blob: 'b'.repeat(200) }))
  const out = buildQuerySqlOutput(set(rows), { ...baseOpts, maxBytes: 4_000 })

  const parsed = JSON.parse(out.stdout) // must be valid despite capping
  assert.ok(parsed.length < 500)
  assert.ok(parsed.length >= 1)
  assert.match(out.stderr, /notice: showing \d+ of 500 rows/)
  assert.match(out.stderr, /--output/)
  assert.equal(out.file, undefined)
})

test('inline mode: long cells are truncated in stdout with a marker', () => {
  const out = buildQuerySqlOutput(set([{ c: 'z'.repeat(400) }]), baseOpts)
  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed[0].c, 'z'.repeat(200) + '…(+200)')
  assert.equal(out.stderr, '') // one small row, under budget
})
