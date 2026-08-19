// @ts-check

// The shared grep-search matcher (LLP 0264 #shared): literal and regex
// compile, the per-cell `test`, the `locate` offsets a snippet window is
// cut from, and the whole-row predicate every scan path shares. The
// client and the server run the identical matcher, so what counts as a
// hit cannot differ between `hyp query grep` and `hyp query grep
// --remote`.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_MATCH_COLUMNS,
  MAX_QUERY_LENGTH,
  SNIPPET_AFTER,
  SNIPPET_BEFORE,
  cellText,
  compileMatcher,
  makeSnippet,
} from '../../src/core/search/matcher.js'

test('a literal query matches case-insensitively as a substring', () => {
  const matcher = compileMatcher('Needle', false)
  assert.equal(matcher.hypQuery, 'Needle')
  assert.equal(matcher.test('a needle in a haystack'), true)
  assert.equal(matcher.test('A NEEDLE IN A HAYSTACK'), true)
  assert.equal(matcher.test('no match here'), false)
})

test('a regex query compiles case-insensitively', () => {
  const matcher = compileMatcher('nee[dr]le', true)
  assert.ok(matcher.hypQuery instanceof RegExp)
  assert.equal(/** @type {RegExp} */ (matcher.hypQuery).flags, 'i')
  assert.equal(matcher.test('a NEEDLE'), true)
  assert.equal(matcher.test('a nerdle'), false)
})

test('an empty or oversized query is refused, not treated as match-everything', () => {
  assert.throws(() => compileMatcher('', false), /non-empty/)
  assert.throws(() => compileMatcher(/** @type {any} */ (undefined), false), /non-empty/)
  const tooLong = 'x'.repeat(MAX_QUERY_LENGTH + 1)
  assert.throws(() => compileMatcher(tooLong, false), /at most/)
  assert.doesNotThrow(() => compileMatcher('x'.repeat(MAX_QUERY_LENGTH), false))
})

test('locate reports the first match offset and its length', () => {
  const literal = compileMatcher('needle', false)
  assert.deepEqual(literal.locate('01234NEEDLE and needle'), { index: 5, length: 6 })
  // A cell the row predicate accepted through another column still has to
  // produce an offset here, so a miss degrades to the head of the value.
  assert.deepEqual(literal.locate('nothing'), { index: 0, length: 6 })

  const regex = compileMatcher('n[e]+dle', true)
  assert.deepEqual(regex.locate('__ neeedle __'), { index: 3, length: 7 })
  assert.deepEqual(regex.locate('nothing'), { index: 0, length: 1 })
})

test('a zero-width regex match still reports a non-zero length', () => {
  const matcher = compileMatcher('x*', true)
  assert.deepEqual(matcher.locate('abc'), { index: 0, length: 1 })
})

test('rowTest matches only through allowlisted columns', () => {
  const matcher = compileMatcher('needle', false)
  assert.equal(matcher.rowTest({ content_text: 'a needle here' }), true)
  assert.equal(matcher.rowTest({ git_remote: 'git@example.com/needle.git' }), true)
  // system_text is out of the allowlist, so it cannot produce a hit even
  // when it plainly contains the query.
  assert.equal(matcher.rowTest({ system_text: 'a needle here' }), false)
  assert.equal(matcher.rowTest({ content_text: '' }), false)
  assert.equal(matcher.rowTest({ content_text: null, tool_name: 42 }), false)
  assert.equal(matcher.rowTest({}), false)
})

test('a snippet at the head of a value carries no leading ellipsis', () => {
  const value = 'needle' + 'z'.repeat(1000)
  const snippet = makeSnippet(value, compileMatcher('needle', false))
  assert.equal(snippet.startsWith('needle'), true)
  assert.equal(snippet.endsWith('...'), true)
  assert.equal(snippet, value.slice(0, 6 + SNIPPET_AFTER) + '...')
})

test('a snippet at the tail of a value carries no trailing ellipsis', () => {
  const value = 'z'.repeat(1000) + 'needle'
  const snippet = makeSnippet(value, compileMatcher('needle', false))
  assert.equal(snippet.startsWith('...'), true)
  assert.equal(snippet.endsWith('needle'), true)
  assert.equal(snippet, '...' + value.slice(value.length - 6 - SNIPPET_BEFORE))
})

test('a match mid-buffer is windowed on both sides', () => {
  const value = 'a'.repeat(500) + 'needle' + 'b'.repeat(500)
  const snippet = makeSnippet(value, compileMatcher('needle', false))
  assert.equal(snippet, '...' + 'a'.repeat(SNIPPET_BEFORE) + 'needle' + 'b'.repeat(SNIPPET_AFTER) + '...')
})

test('a value shorter than the window is returned whole', () => {
  const value = 'a needle in a haystack'
  assert.equal(makeSnippet(value, compileMatcher('needle', false)), value)
})

test('the reported-column cap is a positive shared constant', () => {
  assert.equal(MAX_MATCH_COLUMNS, 3)
  assert.equal(SNIPPET_BEFORE, 80)
  assert.equal(SNIPPET_AFTER, 160)
})

test('a malformed regex is refused the same way an empty query is', () => {
  // The serving surface has to be able to tell a bad request from an
  // internal fault; a raw SyntaxError escaping the compile makes
  // `grep --regex '('` a 500 instead of a 400.
  assert.throws(() => compileMatcher('(', true), /not a valid regular expression/)
  assert.throws(() => compileMatcher('a{2,1}', true), /not a valid regular expression/)
  assert.doesNotThrow(() => compileMatcher('(', false))
  assert.equal(compileMatcher('(', false).test('a ( here'), true)
})

test('a literal query is matched without regex metacharacters', () => {
  const matcher = compileMatcher('a.c', false)
  assert.equal(matcher.test('a.c'), true)
  assert.equal(matcher.test('abc'), false)
})

test('literal offsets index the original value, not a lowercased copy', () => {
  // U+0130 lowercases to two code units, so an offset taken from
  // value.toLowerCase() drifts past every later character and the snippet
  // window opens mid-word.
  const value = 'İİİ needle'
  assert.deepEqual(compileMatcher('needle', false).locate(value), { index: 4, length: 6 })
  assert.equal(makeSnippet(value, compileMatcher('needle', false)), value)
})

test('a JSON cell is searchable, not silently skipped', () => {
  // tool_args is a JSON column (iceberg variant), so it reads back from
  // parquet as an object. It is in the allowlist, so it has to be able to
  // produce a hit; a typeof-string gate would make it dead weight that is
  // still decoded on every brute scan.
  const matcher = compileMatcher('src/core/search', false)
  assert.equal(matcher.rowTest({ tool_args: { file_path: 'src/core/search/matcher.js' } }), true)
  assert.equal(matcher.rowTest({ tool_args: '{"file_path":"src/core/search/matcher.js"}' }), true)
  assert.equal(matcher.rowTest({ tool_args: { file_path: 'elsewhere.js' } }), false)
  // An excluded column stays excluded whatever shape it holds.
  assert.equal(matcher.rowTest({ attributes: { path: 'src/core/search/matcher.js' } }), false)
})

test('cellText renders only the shapes a searchable cell can hold', () => {
  assert.equal(cellText('plain'), 'plain')
  assert.equal(cellText({ a: 1 }), '{"a":1}')
  assert.equal(cellText([1, 'two']), '[1,"two"]')
  assert.equal(cellText(null), '')
  assert.equal(cellText(undefined), '')
  assert.equal(cellText(42), '')
  const cyclic = /** @type {Record<string, unknown>} */ ({})
  cyclic.self = cyclic
  assert.equal(cellText(cyclic), '')
})

test('a snippet edge never cuts a surrogate pair in half', () => {
  const pad = '\u{1F600}'.repeat(200)
  const value = pad + 'needle' + pad
  const snippet = makeSnippet(value, compileMatcher('needle', false))
  // A lone surrogate survives a JSON round trip but renders as a
  // replacement glyph, so assert the payload is well formed instead.
  assert.equal(snippet.isWellFormed(), true)
  assert.equal(snippet.includes('needle'), true)
})
