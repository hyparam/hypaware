// @ts-check

// The human-facing query formats must not hand a captured control sequence to
// the terminal, and the machine-facing ones must not alter a single byte. Both
// halves are asserted here, because the whole decision is that the *format*,
// and nothing else, picks between them.
//
// @ref LLP 0224#decision [tests]: table/markdown escape, json/jsonl stay byte-exact
// @ref LLP 0224#format-not-tty [tests]: no assertion here touches isTTY, and none needs to

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildQuerySqlOutput, renderResult } from '../../src/core/query/format.js'

const ESC = '\u001b'
const RLO = '\u202e'
const CSI = '\u009b' // C1 control introducer: JSON.stringify leaves it raw

/** @param {Record<string, unknown>[]} rows */
const set = (rows) => ({ columns: rows[0] ? Object.keys(rows[0]) : [], rows })

// A hidden row, an overwritten row, and a reordered row: the three effects the
// issue names, in one cell each.
const attacks = set([
  { id: 1, content_text: `hide${ESC}[8m me${ESC}[0m` },
  { id: 2, content_text: `overwrite${ESC}[1A` },
  { id: 3, content_text: `reorder ${RLO}txetdesrever` },
])

test('table format escapes every control and bidi character in a cell', () => {
  const out = renderResult(attacks, 'table')
  assert.equal(out.includes(ESC), false, 'no raw ESC reaches the rendered table')
  assert.equal(out.includes(RLO), false, 'no raw bidi override reaches the rendered table')
  assert.match(out, /hide\\u001b\[8m me\\u001b\[0m/)
  assert.match(out, /overwrite\\u001b\[1A/)
  assert.match(out, /reorder \\u202etxetdesrever/)
})

test('markdown format escapes control and bidi, and still escapes pipes', () => {
  const out = renderResult(set([{ c: `a${ESC}[31mb|c${RLO}d` }]), 'markdown')
  assert.equal(out.includes(ESC), false)
  assert.equal(out.includes(RLO), false)
  assert.match(out, /\| a\\u001b\[31mb\\\|c\\u202ed \|/)
})

test('a newline in a table cell cannot forge a row', () => {
  const out = renderResult(set([{ id: 1, c: 'real\nnot-a-row' }]), 'table')
  // Three lines only: header, divider, one row.
  assert.equal(out.trimEnd().split('\n').length, 3)
  assert.match(out, /real\\nnot-a-row/)
})

test('tab and carriage return get their familiar spellings', () => {
  const out = renderResult(set([{ c: 'a\tb\rc' }]), 'table')
  assert.match(out, /a\\tb\\rc/)
})

test('json and jsonl stay byte-exact, control characters included', () => {
  const rows = [{ c: `x${ESC}[8m${RLO}${CSI}y` }]
  const jsonl = renderResult(set(rows), 'jsonl')
  assert.deepEqual(JSON.parse(jsonl.trimEnd()), rows[0])
  const json = renderResult(set(rows), 'json')
  assert.deepEqual(JSON.parse(json), rows)
  // Byte-for-byte: exactly what JSON.stringify produces, with nothing added.
  assert.equal(jsonl, JSON.stringify(rows[0]) + '\n')
  assert.equal(json, JSON.stringify(rows, null, 2) + '\n')
  // And the bidi override really is still in there, unescaped by JSON.
  assert.equal(jsonl.includes(RLO), true)
})

test('ordinary non-ASCII text is not touched by either human format', () => {
  // Accents, CJK, RTL letters (not overrides), a ZWJ family emoji, and an
  // emoji whose colour depends on a variation selector. All of this is
  // legitimate captured prose and must survive verbatim.
  const legit = 'caf\u00e9 \u65e5\u672c\u8a9e \u05e9\u05dc\u05d5\u05dd \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 \u2764\ufe0f'
  for (const format of /** @type {const} */ (['table', 'markdown', 'json', 'jsonl'])) {
    assert.equal(renderResult(set([{ c: legit }]), format).includes(legit), true, format)
  }
})

test('column widths and alignment survive an escaped cell', () => {
  const out = renderResult(
    set([
      { flag: `${ESC}[8m`, tail: 'A' },
      { flag: 'short', tail: 'B' },
    ]),
    'table'
  )
  const [header, divider, first, second] = out.trimEnd().split('\n')
  // The escaped cell is the widest, so it sets the column width.
  const width = '\\u001b[8m'.length
  assert.equal(divider.split('  ')[0].length, width)
  assert.equal(header.indexOf('tail'), width + 2)
  assert.equal(first.indexOf('A'), width + 2)
  assert.equal(second.indexOf('B'), width + 2)
})

test('the spill receipt escapes its preview but the file it wrote does not', () => {
  const rows = [{ c: `a${RLO}b` }, { c: `d${ESC}e` }]
  const out = buildQuerySqlOutput(set(rows), {
    format: 'jsonl',
    output: '/tmp/spill-752.jsonl',
    maxCell: 200,
    maxBytes: 0,
  })
  assert.equal(out.stdout.includes(RLO), false)
  assert.equal(out.stdout.includes(ESC), false)
  assert.match(out.stdout, /a\\u202eb/)
  assert.match(out.stdout, /d\\u001be/)
  // One preview line per row: the structural newlines are not escaped away.
  assert.equal(out.stdout.trimEnd().split('\n').length, 5)
  // The file is the machine copy and keeps every byte.
  assert.equal(out.file?.content.includes(RLO), true)
})
