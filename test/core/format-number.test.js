// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { groupThousands } from '../../src/core/util/format_number.js'

// The one grouping both the `hyp sync` consent prompt and the overview tables
// render counts through. Its whole point is that the string does not depend on
// the machine: #1117 was a locale pin that a US-locale box could not tell from
// no pin at all, and the substitution helper written to see that (deleted with
// #1121) could only reach one of the two ways to ask the host for grouping.
// So these cases assert exact strings and never consult a locale - a pin that
// reads the same on every box and under every ICU build, including the
// `small-icu` and `--without-intl` ones that have no `de-DE` to substitute.

test('groupThousands: separates thousands and leaves shorter runs alone', () => {
  assert.equal(groupThousands(0), '0')
  assert.equal(groupThousands(7), '7')
  assert.equal(groupThousands(999), '999')
  assert.equal(groupThousands(1000), '1,000')
  assert.equal(groupThousands(1234), '1,234')
  assert.equal(groupThousands(200000), '200,000')
  assert.equal(groupThousands(1234567), '1,234,567')
  assert.equal(groupThousands(Number.MAX_SAFE_INTEGER), '9,007,199,254,740,991')
})

test('groupThousands: the minus sign is not a group boundary', () => {
  assert.equal(groupThousands(-1), '-1')
  assert.equal(groupThousands(-1234), '-1,234')
  assert.equal(groupThousands(-1234567), '-1,234,567')
})

test('groupThousands: a count is rendered as a whole number', () => {
  // Both callers count things, so a fraction reaching here is already a bug
  // upstream and rendering it would carry the bug into the output.
  //
  // This is also the assertion that reds on *every* machine if the grouping is
  // ever handed back to the host. `toLocaleString()`, `toLocaleString('en-US')`
  // and `new Intl.NumberFormat().format()` all render `1,234.5` or `1.234,5`
  // here, and none of them renders `1,235`. #1117's pin could only catch the
  // first of those, and only on a box whose locale it had substituted.
  assert.equal(groupThousands(1234.4), '1,234')
  assert.equal(groupThousands(1234.5), '1,235')
  assert.equal(groupThousands(999.6), '1,000')
})

test('groupThousands: past the integer range the digits run out, and it says so', () => {
  // `String(1e21)` is already exponential, so there are no thousands to group
  // and none are invented. Documented rather than fixed: neither caller can
  // reach it (a pending count stops at the 200,000-row scan limit, and a token
  // sum is bounded by what a provider reported), and this is the second
  // assertion no locale can satisfy - every `Intl` route spells 1e21 out in
  // full digits.
  assert.equal(groupThousands(1e21), '1e+21')
})

// The assertions above pin `groupThousands`. They cannot pin that the two
// surfaces which render counts to a person still go through it: `formatCount`
// in `src/core/commands/sync.js` is a one-line delegation, and rewriting it as
// `n.toLocaleString()` (the "drop the redundant wrapper" edit) leaves the whole
// suite green on any box whose locale groups like `en-US`, which is every CI
// runner and the machine that would make the edit. A German-locale user then
// reads `1.234 rows pending` on the surface that asks for egress consent.
//
// That is #1117 exactly, moved up one level from the formatter to its caller,
// so it needs a gate one level up too. Written as a property of the source
// rather than of a rendered string on purpose: an assertion that reads the
// output can only tell the two spellings apart on a box whose locale differs
// from `en-US`, which is the environment-conditional pin #1121 set out to
// retire. This one reds on every machine and under every ICU build, including
// the `small-icu` and `--without-intl` ones that have no `de-DE` to render
// differently.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The modules that render a count for a reader. Both already spell their
 * timestamps with `toISOString`, and the one deliberately local-time rendering
 * in `hyp sync` lives behind `formatFirstSyncDeadline` in
 * `src/core/usage-policy/first_sync_hold.js`, so neither module has a standing
 * reason to ask the host how to format anything.
 */
const COUNT_RENDERERS = ['src/core/commands/sync.js', 'src/core/query/overview.js']

/**
 * Every route from these modules to the host's own formatting.
 *
 * Named at the object rather than at one member of it. A pattern spelling out
 * `Intl.NumberFormat` wants that dot literally, so `const { NumberFormat } =
 * Intl` walks straight past it, and that mutant is green on every `en-US` box
 * exactly the way the unpinned delegation was. Any mention of `Intl` at all,
 * inside a module whose job is to render the same string everywhere, deserves
 * a human, so the gate asks for the object; the `toLocale` prefix covers the
 * date and time spellings alongside `toLocaleString` for the same reason.
 *
 * A string match cannot follow an alias it never sees. `n['toLocale' +
 * 'String']()`, or a helper imported from a third module that formats through
 * the host, still gets past this, and no regex closes that. The gate is a
 * lint against the edit someone actually makes, not a proof.
 */
const HOST_FORMATTING = /toLocale|\bIntl\b/

/**
 * `source` with its comments blanked, line count preserved so the report can
 * still say `file:line`.
 *
 * A scan for a name cannot tell a call from a mention, and a mention is what a
 * module like this attracts: `overview.js` carried the JSDoc line "Thousands
 * separators without `toLocaleString`" until #1121 rewrote it, and that
 * comment would have failed this gate while the code under it was already
 * correct - a maintainer sent to fix code that was never broken. The sibling
 * lint in `house-style-em-dash.test.js` avoids this by spelling its needle as
 * an escape, which is not available here because the needles sit in the
 * scanned files rather than in this one. So the comments come out instead, and
 * the file stays free to explain why it does not do the thing.
 *
 * Deliberately crude: whole-line comments and the tail after a `//`. It can
 * only ever drop coverage from the tail of a line that carries a `//` inside a
 * string, which no `toLocale` call is reachable behind.
 *
 * @param {string} source
 * @returns {string[]}
 */
function codeLines(source) {
  return source.split('\n').map((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
    const comment = line.indexOf('//')
    return comment === -1 ? line : line.slice(0, comment)
  })
}

test('the surfaces that render counts ask the host nothing', async () => {
  for (const rel of COUNT_RENDERERS) {
    const source = await fs.readFile(path.join(REPO_ROOT, rel), 'utf8')
    const offenders = codeLines(source)
      .map((line, i) => ({ line, at: `${rel}:${i + 1}` }))
      .filter(({ line }) => HOST_FORMATTING.test(line))
    assert.deepEqual(
      offenders.map(({ at, line }) => `${at}: ${line.trim()}`),
      [],
      `${rel} formats through the host, so its output moves with the machine; ` +
        'render counts through groupThousands, and give any deliberate local-time ' +
        'rendering its own named helper the way formatFirstSyncDeadline is one'
    )
  }
})

test('the gate reads code and not the comments about it', () => {
  // A scan that had stopped matching, or that had started matching prose,
  // would leave the rule above passing forever and say nothing. Both halves
  // are pinned here rather than against the tree, so this stays a statement
  // about the gate even after the scanned files change.
  const flagged = (/** @type {string} */ source) =>
    codeLines(source).filter((line) => HOST_FORMATTING.test(line))

  assert.deepEqual(flagged('  return n.toLocaleString()'), ['  return n.toLocaleString()'])
  assert.deepEqual(flagged('  const { NumberFormat } = Intl'), ['  const { NumberFormat } = Intl'])
  assert.deepEqual(flagged('  return d.toLocaleDateString()'), ['  return d.toLocaleDateString()'])
  assert.deepEqual(flagged('  return f(n) // not n.toLocaleString(), see #1121'), [])
  assert.deepEqual(flagged(' * Thousands separators without `toLocaleString`.'), [])
  assert.deepEqual(flagged('// Intl is not consulted here.'), [])

  // Blanking keeps the line numbering, so a report still points at the line.
  assert.equal(codeLines('// a\n// b\nreturn n.toLocaleString()').length, 3)
})
