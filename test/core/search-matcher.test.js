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

test('a non-string cell is coerced, not silently skipped', () => {
  // Every allowlisted column holds STRING today, so the coercion is not
  // there to cover a JSON column any more (tool_args is out: #977). It is
  // there so the row predicate is never wider than the per-cell one for
  // whatever a cell actually decodes to.
  const matcher = compileMatcher('src/core/search', false)
  assert.equal(matcher.rowTest({ content_text: { file_path: 'src/core/search/matcher.js' } }), true)
  assert.equal(matcher.rowTest({ content_text: '{"file_path":"src/core/search/matcher.js"}' }), true)
  assert.equal(matcher.rowTest({ content_text: { file_path: 'elsewhere.js' } }), false)
  // An excluded column stays excluded whatever shape it holds, tool_args
  // now included: the coercion never widens the allowlist.
  assert.equal(matcher.rowTest({ attributes: { path: 'src/core/search/matcher.js' } }), false)
  assert.equal(matcher.rowTest({ tool_args: { file_path: 'src/core/search/matcher.js' } }), false)
})

test('cellText renders only the shapes a searchable cell can hold', () => {
  assert.equal(cellText('plain'), 'plain')
  // A decoded JSON cell renders as its keys and primitive leaves, one per
  // line, not as serialized text: the serialization carries the escapes
  // rather than the characters the user searched for.
  assert.equal(cellText({ a: 1 }), 'a\n1')
  assert.equal(cellText([1, 'two']), '1\ntwo')
  assert.equal(cellText({ outer: { inner: 'leaf' } }), 'outer\ninner\nleaf')
  assert.equal(cellText(null), '')
  assert.equal(cellText(undefined), '')
  assert.equal(cellText(42), '')
  // A cycle costs the branch that revisits, not the whole cell.
  const cyclic = /** @type {Record<string, unknown>} */ ({ file_path: 'a.js' })
  cyclic.self = cyclic
  assert.equal(cellText(cyclic), 'file_path\na.js\nself')
})

test('an object cell is searched as its decoded text, escapes and all', () => {
  // JSON.stringify would store a Windows path as C:\\Users\\me and a
  // shell command's newline as the two characters \\n, so a literal query
  // for either would miss the very cell it names.
  const args = { path: 'C:\\Users\\me', command: 'cd /repo\nnpm test', quoted: 'say "hi"' }
  assert.equal(compileMatcher('C:\\Users\\me', false).rowTest({ content_text: args }), true)
  assert.equal(compileMatcher('cd /repo\nnpm test', false).rowTest({ content_text: args }), true)
  assert.equal(compileMatcher('say "hi"', false).rowTest({ content_text: args }), true)
  // The keys are rendered too, so a query naming one finds the cell.
  assert.equal(compileMatcher('command', false).rowTest({ content_text: args }), true)
})

test('test, locate and makeSnippet agree with rowTest on a non-string cell', () => {
  // The consumer loop is: rowTest the row, then test each allowlisted cell
  // and snippet the ones that matched. A per-cell predicate that only takes
  // strings makes that loop report a hit with no matched columns, or throw
  // on value.slice, for exactly the column the row matched through.
  const matcher = compileMatcher('file_path', false)
  const cell = { file_path: 'src/core/search/matcher.js' }
  assert.equal(matcher.rowTest({ content_text: cell }), true)
  assert.equal(matcher.test(cell), true)
  assert.deepEqual(matcher.locate(cell), { index: 0, length: 9 })
  assert.equal(makeSnippet(cell, matcher), 'file_path\nsrc/core/search/matcher.js')
  // A cell shape that carries no text stays a clean miss rather than a throw.
  assert.equal(matcher.test(null), false)
  assert.equal(makeSnippet(undefined, matcher), '')
})

test('a snippet stays bounded when the match itself is unbounded', () => {
  // .*needle.* is what an rg-trained user types, and it matches the whole
  // cell. The window is the promise, so the matched run is clamped before
  // it opens: a megabyte body must not be serialized into the hit.
  const value = 'x'.repeat(5000) + 'needle' + 'y'.repeat(5000)
  const greedy = makeSnippet(value, compileMatcher('.*needle.*', true))
  // The window opens at the match, which a greedy pattern starts at the
  // head of the cell, and the clamp closes it a bounded distance later.
  assert.ok(greedy.length <= SNIPPET_BEFORE + SNIPPET_AFTER * 2 + 3, `snippet was ${greedy.length} chars`)
  assert.equal(greedy.endsWith('...'), true)
  // A pattern that matches at the needle still windows around the needle.
  const narrow = makeSnippet(value, compileMatcher('n[e]+dle', true))
  assert.ok(narrow.length <= SNIPPET_BEFORE + SNIPPET_AFTER * 2 + 6)
  assert.equal(narrow.includes('needle'), true)
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
