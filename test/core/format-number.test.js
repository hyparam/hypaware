// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { trackedFiles } from '../helpers/tracked_files.js'
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
  // `String(1e21)` is already exponential, so there are no thousands left to
  // group. Documented rather than fixed: neither caller can reach it (a
  // pending count stops at the 200,000-row scan limit, and a token sum is
  // bounded by what a provider reported), and this is the second assertion no
  // locale can satisfy - every `Intl` route spells 1e21 out in full digits.
  assert.equal(groupThousands(1e21), '1e+21')

  // What a mantissa of three or more digits gets is worse than nothing, and
  // pinned here because the range limit is easy to read as "leaves the string
  // alone", which it does not: the separator lands inside the mantissa. This
  // is inherited unchanged from the overview table's private helper and stays
  // unreachable from both callers, but the helper now has a general name and a
  // bare `@param {number}`, so the shape of the edge belongs in writing.
  assert.equal(groupThousands(1.2345e25), '1.2,345e+25')
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
 *
 * A hand-kept list of two is a list that goes stale the day a third count
 * surface lands, and the surface that most needs the pin is the one nobody
 * remembered to add. So membership is not left to memory: the last test in
 * this file holds this array to the set of shipped modules that import
 * `groupThousands`, and a third importer reds until it is named here.
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
 * A string match cannot follow an alias it never sees. Only a split that
 * leaves no fragment spelling the needle gets past, so `n['toLocale' +
 * 'String']()` is still reported and `n['toLoc' + 'aleString']()` is not, and
 * no regex closes the second. The gate is a lint against the edit someone
 * actually makes, not a proof.
 *
 * What it no longer misses is the helper imported from a third module. The
 * same needle runs over every shipped module further down, so relocating a
 * host call out of these two files does not hide it, it only changes which
 * line the report names.
 *
 * `localeCompare` is here for the same reason as the rest, one step over from
 * spelling to order. A bare `a.localeCompare(b)` asks the host's locale and
 * ICU build how two strings sort, so a listing ordered by it prints one way on
 * an `en-US` box, another on a `de-DE` one, and a third under `--without-intl`
 * where it collapses to code unit order. That was the shape of 19 shipped
 * comparators until #1142 moved them to `compareStrings`, several of them
 * ordering what `hyp status` and `hyp --help` put on screen. Sorting is not
 * formatting, but "what this prints moves with the machine" is the same
 * hazard and wants the same gate, so the constant's name is read as host
 * *presentation* rather than host spelling.
 *
 * Each alternative carries a left `\b`. Without one, `toLocale` matches inside
 * any identifier that happens to contain it, and a module holding
 * `const autoLocaleDetect = opts.autoLocaleDetect === true` reds twice while
 * consulting nothing (#1142 item 2). Every real call has a non-word character
 * before the `t` or the `l` (`n.toLocaleString`, `d.toLocaleDateString`,
 * `n['toLocale' + 'String']`, `a.localeCompare`), so the boundary frees
 * identifier substrings and costs no coverage. The cases below pin both
 * halves of that.
 */
const HOST_FORMATTING = /\btoLocale|\bIntl\b|\blocaleCompare\b/

/**
 * The index of the `//` that opens a line comment in `line`, or -1.
 *
 * Quote-aware, because the plain `indexOf('//')` truncates at the `//` inside a
 * URL and reads `return 'https://hyparam.dev/rows ' + n.toLocaleString()` as
 * clean. 218 lines of the shipped tree carry a `//` inside a string literal, so
 * that is a hole shaped like the tree rather than a curiosity.
 *
 * Still not a tokenizer. A line that opens a quote it never closes, which is
 * what a continuation line of a multi-line template usually is, keeps its whole
 * self, so it can only over-report, and an over-report fails loud with a file
 * and a line to look at.
 *
 * @param {string} line
 * @returns {number}
 */
function lineCommentAt(line) {
  let quote = ''
  for (let i = 0; i < line.length - 1; i += 1) {
    const c = line[i]
    if (quote !== '') {
      if (c === '\\') i += 1
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '/' && line[i + 1] === '/') return i
  }
  return -1
}

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
 * A line that opens a block comment and also closes it on the same line keeps
 * whatever follows the close. That is not a nicety: an inline `@type` cast,
 * opened and closed before the value it casts, is this repo's own way of
 * spelling a type on an expression. 24 shipped modules already write a line
 * that way and `src/core/commands/sync.js:73` is one of them, so blanking such
 * a line whole hid real code in one of the two files the scan above reads.
 *
 * What is left is still crude, and still wrong in both directions on code it
 * was not built for. It drops coverage inside a multi-line template literal,
 * where a line opening with `*` or `//` is blanked whole and a `//` later in
 * the line still truncates, because the backtick that would have said "string"
 * was on an earlier line. It over-reports when a block comment's continuation
 * lines are not `*`-prefixed, when a runtime string names the call it forbids,
 * and when a line leaves a quote open. Neither direction is closed here:
 * closing them wants a tokenizer, and the `*`-blanking is what saves the JSDoc
 * line above. They are the same class as the computed access named on
 * `HOST_FORMATTING` - this is a lint against the edit someone makes, not a
 * proof - except that the over-reporting three fail loud, with the file and
 * line to look at.
 *
 * @param {string} source
 * @returns {string[]}
 */
function codeLines(source) {
  return source.split('\n').map((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return ''
    let code = line
    if (trimmed.startsWith('/*')) {
      const close = line.indexOf('*/')
      if (close === -1) return ''
      code = ' '.repeat(close + 2) + line.slice(close + 2)
    }
    const comment = lineCommentAt(code)
    return comment === -1 ? code : code.slice(0, comment)
  })
}

test('the surfaces that render counts ask the host nothing', async () => {
  for (const rel of COUNT_RENDERERS) {
    // The allowlist below binds here too. Without this skip, this scan and the
    // `COUNT_RENDERERS` rule at the bottom of the file hand out contradictory
    // remedies the day an allowlisted module wants the grouping: register it
    // and this rule reds on the very host call it is exempted for, leave it
    // unregistered and that rule reds, and there is no third state. That is the
    // red-lock the delegation pin was already fixed for, in the other rule.
    if (Object.hasOwn(HOST_FORMATTING_ALLOWED, rel)) continue
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

  // The repo's own cast idiom is code, not a comment, and a URL is a string
  // rather than the start of one. Both used to be blanked whole.
  const trimmedFlags = (/** @type {string} */ source) => flagged(source).map((line) => line.trim())
  assert.deepEqual(trimmedFlags('  /** @type {number} */ (n).toLocaleString()'), [
    '(n).toLocaleString()',
  ])
  assert.deepEqual(trimmedFlags("  return 'https://hyparam.dev/rows ' + n.toLocaleString()"), [
    "return 'https://hyparam.dev/rows ' + n.toLocaleString()",
  ])
  assert.deepEqual(flagged('  /** @returns {string} the toLocaleString spelling */'), [])

  // Order is presentation too, so the host's collation is in the needle.
  assert.deepEqual(flagged('  rows.sort((a, b) => a.name.localeCompare(b.name))'), [
    '  rows.sort((a, b) => a.name.localeCompare(b.name))',
  ])

  // Each alternative is left-anchored on a word boundary, so an identifier
  // that merely carries one as an interior substring is not a host call and is
  // not reported. Without the boundary this module reds twice while consulting
  // nothing, which is a maintainer sent to fix correct code (#1142 item 2).
  assert.deepEqual(flagged('  const autoLocaleDetect = opts.autoLocaleDetect === true'), [])
  assert.deepEqual(flagged('  return autoLocaleDetect'), [])
  // Case-correct, and it has to be: the needle carries no `i` flag, so a
  // camelCased `nonLocaleCompare` spells `LocaleCompare` and cannot match with
  // the boundary or without it - a pin that would stay green on a needle that
  // had lost its boundaries, which is the one thing a pin may not do. These two
  // spell the name the way the needle does, and red without the boundaries.
  assert.deepEqual(flagged('  const xlocaleCompare = compareStrings'), [])
  assert.deepEqual(flagged('  const localeCompareStrings = compareStrings'), [])
  // The boundary frees identifier substrings and nothing else: every real call
  // has a non-word character in front of it, including the split-string one.
  assert.deepEqual(flagged("  return n['toLocale' + 'String']()"), [
    "  return n['toLocale' + 'String']()",
  ])

  // Blanking keeps the line numbering, so a report still points at the line.
  assert.equal(codeLines('// a\n// b\nreturn n.toLocaleString()').length, 3)
})

/**
 * The body of `formatCount` in `source`, from its `function` line to the first
 * line that is a bare `}`, or `null` if the module declares no such function.
 * Both spellings are top-level declarations closed at column zero, so nothing
 * subtler is needed to find where one ends when one is found.
 *
 * `null` also when the declaration is there but this crude delimiter cannot
 * bound it. `function formatCount(n) { return groupThousands(n) }` is valid,
 * correct, and one line, the repo runs no formatter that would expand it, and
 * reddening on it with "expected formatCount to close at column zero" is
 * another block on correct code. Either way the module falls through to the
 * per-module check below, which every registered module gets.
 *
 * `null` rather than a failure, because `COUNT_RENDERERS` is no longer a
 * hand-kept pair: the rule at the bottom of this file derives it from the tree
 * and tells a new count surface to register itself. If registration then
 * demanded a function called `formatCount`, the gate's own remedy would leave
 * the suite red until an unrelated renderer was renamed, and a re-export that
 * declares no function at all could never satisfy it. What the skip gives up is
 * small and covered elsewhere: a differently named renderer that formats
 * through the host still reds on the tree-wide scan, at its own line, and one
 * that groups digits by hand is the case this file already states is not the
 * hazard.
 *
 * @param {string} source
 * @returns {string | null}
 */
function formatCountBody(source) {
  const lines = codeLines(source)
  const start = lines.findIndex((line) => /^(export )?function formatCount\(/.test(line))
  if (start === -1) return null
  const end = lines.findIndex((line, i) => i > start && line === '}')
  if (end === -1) return null
  return lines.slice(start, end + 1).join('\n')
}

/**
 * A module that hands the grouping on rather than rendering with it. It has no
 * renderer to pin, so the per-module fallback below lets it through: the trap
 * to avoid is a registration the gate's own message asks for and then cannot
 * accept.
 */
const GROUPING_REEXPORT = /\bexport\s*(?:\*|\{[^}]*\})\s*from\s*['"][^'"]*format_number\.js['"]/

test('the surfaces that render counts still route the digits through the one grouping', async () => {
  // The scan above is a two-file grep, so it only sees a host call that stays
  // in one of those two files. The regression it cannot see is relocation:
  // move the digits into `src/core/util/pretty.js` spelled `toLocaleString()`,
  // import it here, and both files are clean while a German-locale user reads
  // `1.234 rows pending` on the surface that asks for egress consent. That is
  // not a hypothetical shape - `formatFirstSyncDeadline` in
  // `src/core/usage-policy/first_sync_hold.js` is exactly a host-formatting
  // helper one module over that `hyp sync` already calls, deliberately, for a
  // local time.
  //
  // The deleted `onAmbientLocale` shim caught relocation for free, because it
  // moved the ambient locale under the whole call and read the real output. It
  // could only reach `Number.prototype.toLocaleString`, and it went because a
  // one-locale ICU build resolves its substitute back and turns it green
  // (#1121 item 3). What replaces that reach is this: the grouping is proven
  // locale-free by the exact strings at the top of this file, and the two
  // callers are proven to be the ones asking for it. A third module cannot get
  // between them without reddening here, on every machine.
  for (const rel of COUNT_RENDERERS) {
    const source = await fs.readFile(path.join(REPO_ROOT, rel), 'utf8')
    const body = formatCountBody(source)
    if (body !== null) {
      assert.match(
        body,
        /\bgroupThousands\(/,
        `formatCount in ${rel} no longer renders its digits with groupThousands; ` +
          'whatever replaced it is unpinned, and a formatter that reads the host ' +
          'is invisible to the scan above once it lives in another module'
      )
      continue
    }
    // Every registered module is covered, not only the ones that spell their
    // renderer `formatCount`. A global "something was pinned" counter cannot do
    // that: it passes while one registered module silently drops out of the
    // rule, and it reds on the day both renderers are correctly renamed at
    // once, which is a block on correct code of exactly the kind the skip above
    // was written to remove. So the weaker statement is made per module
    // instead. It is weaker on purpose - it says the grouping is called here,
    // not that the renderer is what calls it - and the strong statement is
    // still made wherever the delimiter can find a body.
    //
    // A module that only re-exports the grouping declares no renderer and calls
    // nothing, so it is the one registered shape with nothing to pin.
    const code = codeLines(source).join('\n')
    if (GROUPING_REEXPORT.test(code)) continue
    assert.match(
      code,
      /\bgroupThousands\(/,
      `${rel} is registered as a count surface and imports the grouping without ` +
        'ever calling it, so whatever renders its digits is unpinned; render them ' +
        'through groupThousands, or drop the import and the COUNT_RENDERERS entry'
    )
  }
})

// The two rules above are a closed pair only for the two modules they name.
// #1133 item 3 left the rest open: nothing stopped a *third* count surface, a
// new command that renders a row tally to a person, from spelling its digits
// `n.toLocaleString()` and shipping green, because a gate never looks at a file
// it was not told about. The pins below are the maintenance half of that, and
// they are lints over the tree rather than checks of behaviour. One holds the
// set of modules allowed to ask the host how to format anything; the other
// holds `COUNT_RENDERERS` to the set of modules that actually import the
// grouping. Between them a new count surface has three ways to go and two of
// them red: format through the host anywhere in the shipped tree and the first
// rule names the file and line, wherever the call was moved to; route through
// `groupThousands` and the second rule makes you register the module, which is
// what puts it under the scan and the delegation pin. The third way, digits
// grouped by hand from a helper that consults nothing, stays uncaught, and it
// is the one that is not the hazard: it may not match its neighbours, but it
// reads the same on every machine.

/**
 * Every tracked JavaScript module outside `test/`, repo-relative, with its
 * comments already blanked by `codeLines`. Read once and reused, since both
 * rules below walk the same few hundred files.
 *
 * All three ES suffixes, not just `.js`: `scripts/` already holds an `.mjs`,
 * and a scan that named one suffix would let the next count surface out through
 * a rename.
 *
 * Listed through the shared `trackedFiles` helper, which is where the repo's
 * other tree-wide gates get the one guarantee this needs: `git ls-files` reports
 * the index, so a module deleted or renamed in the working tree and not yet
 * staged is still named, and reading it blind fails both rules below with a raw
 * ENOENT about a file the reader never touched. Reading the index also means a
 * brand new module is invisible until it is added, so the local run that first
 * sees a new count surface is the one after `git add`, not the one before.
 *
 * `test/` is out of scope on purpose, and this file is the reason: a gate has
 * to be free to name the thing it forbids, and here the needle sits in code
 * (the regex, and the cases that pin it) where blanking cannot reach it.
 * Everything else is in scope, not just `src/`: the bundled plugins, `bin/`,
 * the smoke flows, `scripts/`, and also `x/` and `benchmarks/`, which the
 * published `files` list does not carry. Wider than what ships, deliberately.
 * A count rendered by a plugin command reads the machine exactly as hard as one
 * rendered by `hyp sync`, scoping this to core would have exempted most of the
 * tree a new command can land in, and the alternative to "everything but
 * `test/`" is a second list of directories to keep in step with the first. The
 * price is that a throwaway repro under `x/` is held to the same rule as a
 * command, which is a sentence in a scratch file rather than a block on
 * anything a user sees.
 *
 * @type {{ rel: string, lines: string[] }[] | null}
 */
let shippedCache = null

/** @returns {Promise<{ rel: string, lines: string[] }[]>} */
async function shippedModules() {
  if (shippedCache) return shippedCache
  const paths = trackedFiles(REPO_ROOT, new Set(['.js', '.mjs', '.cjs'])).filter(
    (rel) => !rel.startsWith('test/')
  )
  // A pathspec that stopped matching would leave both rules passing over an
  // empty tree and say nothing, which is the failure mode a lint cannot afford.
  assert.ok(paths.length > 100, `expected the shipped tree, got ${paths.length} modules`)
  // That count cannot see a *narrowed* extension set: drop `.mjs` and the 479
  // `.js` modules still clear the floor, which is how the eight `.mjs` files
  // went unscanned until #1140. So the suffixes are held to the tree as well,
  // and the next count surface cannot leave through a rename of the file.
  const covered = new Set(paths)
  const uncovered = trackedFiles(REPO_ROOT).filter(
    (rel) => !rel.startsWith('test/') && /\.[cm]?js$/.test(rel) && !covered.has(rel)
  )
  assert.deepEqual(
    uncovered,
    [],
    'these JavaScript modules are outside the scan; widen the extension set it lists by'
  )
  shippedCache = await Promise.all(
    paths.map(async (rel) => ({
      rel,
      lines: codeLines(await fs.readFile(path.join(REPO_ROOT, rel), 'utf8')),
    }))
  )
  return shippedCache
}

/**
 * The shipped modules allowed to ask the host how to format something, and
 * why.
 *
 * One entry, and its reason is the shape of the whole exemption. A deadline is
 * the one value on these surfaces that *should* move with the machine: it is a
 * wall-clock time the reader has to act on in the zone they are standing in,
 * which is why that helper renders it locally and then names the zone. A count
 * is the opposite. It is the same number everywhere, so a locale cannot change
 * what it means, only whether the reader recognises it.
 *
 * Held to equality rather than containment, so a stale entry cannot outlive the
 * call it excused: take the host call out and this list loses its line in the
 * same diff. Entries are files rather than lines, because a module that spells
 * a time for a person tends to do it more than once.
 */
const HOST_FORMATTING_ALLOWED = {
  'src/core/usage-policy/first_sync_hold.js':
    'formatFirstSyncDeadline renders the hold deadline in the zone the reader is in, and names that zone (LLP 0100)',
}

test('the only shipped module that asks the host how to format is the one that means to', async () => {
  const modules = await shippedModules()
  const offenders = []
  for (const { rel, lines } of modules) {
    if (Object.hasOwn(HOST_FORMATTING_ALLOWED, rel)) continue
    lines.forEach((line, i) => {
      if (HOST_FORMATTING.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    'a shipped module presents through the host, so what it prints moves with ' +
      'the machine it runs on. Render counts through groupThousands, and order ' +
      'strings through compareStrings. If the value really is meant to be ' +
      'local, give it a named helper the way formatFirstSyncDeadline is one, ' +
      'and add the module to HOST_FORMATTING_ALLOWED with the reason'
  )

  // The other half of equality. An exemption that no longer excuses a call is
  // a hole nobody is holding open on purpose, so the diff that removes the
  // call has to remove the line.
  const stale = Object.keys(HOST_FORMATTING_ALLOWED).filter((allowed) => {
    const module = modules.find(({ rel }) => rel === allowed)
    // Absent is not the same as no longer formatting. `trackedFiles` drops a
    // path the index names but the working tree does not have, which is the
    // ordinary mid-rename or mid-rebase state, so asking whether any *listed*
    // module still matches reports a merely-moved file as a stale exemption and
    // tells the reader to delete a live one. Say nothing until it is readable
    // again: that is the same transient the helper was adopted for, and the
    // helper turns it from a loud ENOENT into quiet bad advice unless the
    // caller asks the question this way.
    return module !== undefined && !module.lines.some((line) => HOST_FORMATTING.test(line))
  })
  assert.deepEqual(
    stale,
    [],
    'these modules no longer format through the host; drop them from HOST_FORMATTING_ALLOWED'
  )
})

test('every shipped module that renders counts through the grouping is named in COUNT_RENDERERS', async () => {
  // The scan at the top of this file and the delegation pin under it are both
  // driven by COUNT_RENDERERS, so a third command that imports groupThousands
  // gets neither by default - and the module nobody thought to add is the one
  // that most needs them. Holding the array to the tree makes registration the
  // only way forward: import the grouping, or the suite says so.
  //
  // Matched on the module path rather than the exported name, so a renaming
  // re-export counts too, and so this stays true if a second helper is ever
  // added to that file. Both quote styles, and `await import(` alongside a
  // static `from`: dozens of shipped modules already load something that way,
  // so a count surface reaching for the grouping dynamically is the house
  // idiom rather than an exotic, and it would register itself nowhere.
  const importers = (await shippedModules())
    .filter(({ lines }) =>
      lines.some((line) => /(?:\bfrom|\bimport\s*\()\s*['"][^'"]*format_number\.js['"]/.test(line))
    )
    .map(({ rel }) => rel)
  assert.deepEqual(
    importers.slice().sort(),
    COUNT_RENDERERS.slice().sort(),
    'COUNT_RENDERERS no longer names exactly the shipped modules that import ' +
      'groupThousands, so a count surface is either uncovered by the scan and ' +
      'the delegation pin or registered for a module that no longer renders ' +
      'one. The diff says which side gained: if the tree gained the importer, ' +
      'add it to COUNT_RENDERERS and give whatever renders its digits the same ' +
      'delegation pin formatCount has; if COUNT_RENDERERS holds a module that ' +
      'has stopped importing the grouping, drop the entry'
  )
})
