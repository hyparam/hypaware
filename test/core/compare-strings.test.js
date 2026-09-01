// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { trackedFiles } from '../helpers/tracked_files.js'
import { compareStrings } from '../../src/core/util/compare_strings.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// `compareStrings` is `groupThousands` for order. The grouping was written
// because a rendered count moved with the host; this exists because a rendered
// *list* did, through the 19 bare `localeCompare` comparators #1142 migrated,
// several of them ordering what `hyp status` and `hyp --help` print.
//
// So this file has two jobs, and they pull in opposite directions. The pins
// below say the comparator answers from the characters, including on the three
// pairs where the host's collation answers differently, so a comparator handed
// back to the host reds here on any box with ICU data. The rules further down
// say the migration did not reorder anything a person reads, which is a claim
// about the names this repo actually ships rather than about the comparator.

test('compareStrings orders by the characters, and reports a sign', () => {
  assert.equal(compareStrings('a', 'b'), -1)
  assert.equal(compareStrings('b', 'a'), 1)
  assert.equal(compareStrings('a', 'a'), 0)
  assert.equal(compareStrings('', ''), 0)
  assert.equal(compareStrings('', 'a'), -1)
  // A prefix sorts before what extends it, which is the property the CLI's
  // grouped help leans on: `cache` heads `cache status`.
  assert.equal(compareStrings('cache', 'cache status'), -1)
})

test('compareStrings refuses a non-string rather than ordering from one', () => {
  // The one answer this comparator may not give is a plausible one. Without
  // the guard `<` and `>` are both false for a non-string, so
  // `compareStrings(undefined, 'x')` came back `0`: a stable tie that sorts a
  // mis-shaped row into an arbitrary place and reports nothing, which is the
  // failure class the migration to this comparator existed to remove. Every
  // other `@param {string}` helper on the published barrel already refuses the
  // same input, out of what its body happens to do rather than by choice; a
  // comparison raises nothing on its own, so this one says so out loud
  // (LLP 0340 #refuse).
  for (const bad of [undefined, null, 10, {}, ['a'], Symbol('a')]) {
    assert.throws(() => compareStrings(/** @type {any} */ (bad), 'x'), TypeError)
    assert.throws(() => compareStrings('x', /** @type {any} */ (bad)), TypeError)
  }
  // The types, never the values. These comparators sort blob keys, file paths
  // and session ids, and an error message is a string that reaches a log.
  assert.throws(
    () => compareStrings(/** @type {any} */ ('s3://bucket/secret-key'.length), 'x'),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /got number and string/)
      return true
    }
  )
  assert.throws(
    () => compareStrings('x', /** @type {any} */ ({ key: 'do-not-print-me' })),
    (/** @type {Error} */ err) => {
      assert.equal(err.message.includes('do-not-print-me'), false)
      return true
    }
  )
  // A String object is not a string. It compares correctly through `<`, so
  // letting it past would be harmless here and would still be the barrel
  // answering a question it was not asked; `typeof` is the line every other
  // guard in `json_util.js` draws too.
  assert.throws(() => compareStrings(/** @type {any} */ (new String('a')), 'b'), TypeError)
})

test('sort() never hands the guard a hole or an undefined, so a sparse list is not a way in', () => {
  // The reason the guard costs nothing at the 19 sites the migration touched
  // is not only that their names are validated. `Array.prototype.sort` moves
  // `undefined` elements and holes to the end without ever calling the
  // comparator, so the commonest shape of "a list with a gap in it" cannot
  // reach the throw at all.
  assert.deepEqual(['b', undefined, 'a'].sort(compareStrings), ['a', 'b', undefined])
  // A hole is not the same thing as an `undefined` element and gets its own
  // case: `sort` moves holes past even the undefineds, still without asking.
  // Built by assignment rather than as an array literal, because spreading a
  // sparse array fills its holes with `undefined` and would quietly turn this
  // into the assertion above.
  const holey = new Array(3)
  holey[0] = 'b'
  holey[2] = 'a'
  assert.deepEqual(holey.sort(compareStrings).slice(0, 2), ['a', 'b'])
})

test('compareStrings sorts a list the way a bare sort() would', () => {
  const names = ['traces', 'ai_gateway_messages', 'metrics', 'logs']
  assert.deepEqual(
    [...names].sort(compareStrings),
    ['ai_gateway_messages', 'logs', 'metrics', 'traces']
  )
  assert.deepEqual([...names].sort(compareStrings), [...names].sort())
})

test('compareStrings answers from the characters where the host collation would not', () => {
  // The three disagreements that matter for this repo's strings, asserted as
  // constants so the statement holds on every box and under every ICU build,
  // including `--without-intl` where `localeCompare` collapses onto this
  // comparison and no test could tell the two apart by running them.
  //
  // Case. The root collation puts `a` before `B`; the characters put `B`
  // first. Any comparator handed back to `localeCompare` reverses these on a
  // box with ICU data.
  assert.ok(compareStrings('B', 'a') < 0)
  assert.ok(compareStrings('Z', 'a') < 0)

  // Underscore against hyphen and dot. The root collation orders `_` before
  // `-` and `-` before `.`; the characters order `-`, `.`, then `_`. This is
  // the pair that decides a list holding both `ai-gateway` and
  // `ai_gateway_messages`, which is why the corpus rules below exist.
  assert.ok(compareStrings('a-b', 'a_b') < 0)
  assert.ok(compareStrings('a.b', 'a_b') < 0)
  assert.ok(compareStrings('a0', 'a_b') < 0)
})

/**
 * Every `contributes` name a bundled plugin declares, bucketed by the kind of
 * list it lands in.
 *
 * Read from the manifests rather than listed here, because the point of these
 * rules is to red on the *next* name rather than to record the current ones. A
 * plugin that contributes a dataset called `AI_Gateway` alongside the existing
 * `ai-gateway` source is the edit that reorders a listing, and nobody making
 * it would think to come here.
 *
 * Bucketed, because that is the granularity the comparators sort at: the
 * source registry never sorts a dataset name next to a source name, so a
 * disagreement across two buckets is not a disagreement any list can show.
 *
 * @returns {Map<string, string[]>}
 */
function manifestNames() {
  const workspace = path.join(REPO_ROOT, 'hypaware-core/plugins-workspace')
  /** @type {Map<string, Set<string>>} */
  const buckets = new Map()
  for (const dir of fs.readdirSync(workspace)) {
    const manifest = path.join(workspace, dir, 'hypaware.plugin.json')
    if (!fs.existsSync(manifest)) continue
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    const contributes = parsed?.contributes ?? {}
    for (const [kind, entries] of Object.entries(contributes)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        // `config_sections` names its key `section`; everything else uses
        // `name`. Anything with neither is a contribution nothing sorts.
        const name = entry?.name ?? entry?.section
        if (typeof name !== 'string' || name === '') continue
        const bucket = buckets.get(kind) ?? new Set()
        bucket.add(name)
        buckets.set(kind, bucket)
      }
    }
  }
  return new Map([...buckets].map(([kind, set]) => [kind, [...set]]))
}

/**
 * Every command name the core table declares, plus every one contributed by a
 * bundled plugin. `hyp --help` sorts the union inside one section, so the
 * union is the list to check.
 *
 * Read off the source with a pattern rather than by booting the kernel, which
 * would want a config, a cache root, and every plugin entrypoint imported. The
 * floor assertion below is what keeps a pattern that stopped matching from
 * turning this into a rule about nothing.
 *
 * @returns {string[]}
 */
function commandNames() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/cli/core_commands.js'), 'utf8')
  const names = new Set()
  for (const match of source.matchAll(/name: '([a-z][a-z0-9 _-]*)'/g)) names.add(match[1])
  for (const name of manifestNames().get('commands') ?? []) names.add(name)
  return [...names]
}

/**
 * The name corpora this repo can harvest, bucketed the way the comparators
 * sort.
 *
 * `llp/` stands for `scripts/llp-numbers.js`, and it is harvested twice
 * because the script sorts one of the two lists and the other one is what this
 * file can see. `claimsByNumber` keys on `basename(file)`, so what
 * `collisions` actually sorts is the bare `NNNN-slug.type.md` names; the
 * tracked paths carry the same alphabet plus `/` and the directory prefixes.
 * Both buckets are here rather than one standing in for the other: the
 * basenames are the corpus the migrated comparator really orders, the paths are
 * the wider alphabet, and holding them separately means the claim that the two
 * agree is checked by the rule below rather than asserted in this comment
 * (#1148 item 4). Blob keys are deliberately absent and the last rule in this
 * file says why.
 *
 * Not a one-to-one map onto the migrated sites, in either direction, and
 * saying so is what keeps the failure message below honest.
 *
 * Wider than the sites in one direction: `sources`, `datasets`, `commands`,
 * `init_presets` and the `llp/` paths are each sorted by a migrated
 * comparator, but nothing sorts `config_sections`, `picker`, `skills` or
 * `agents` today (the picker has its own rank order in
 * `src/core/cli/walkthrough.js`, and the skill and agent registries do not
 * sort at all). They are kept because a registry that starts sorting its
 * bucket is a two-line change nobody would come here for, and because the
 * remedy the message offers - rename, or accept the reorder on purpose - is
 * still available on a bucket nothing prints in order.
 *
 * Narrower in the other: three migrated sites sort names no manifest declares,
 * so no harvest here can cover them. `createSinkRegistry().list()`
 * (`src/core/registry/sinks.js`) sorts the `instanceName`s a user writes in
 * their own config, and the backfill and verb registries sort names their
 * plugins register in code. The `sinks` bucket below harvests contribution
 * names (`forward`, `local-fs`, `s3`), which is a different list from the
 * one that registry sorts; it is not a stand-in for it.
 *
 * That last gap is the one place the migration is known to reorder a listing a
 * user reads, and it is worth saying plainly rather than leaving as an absence.
 * Sink instance names are free text, so a config holding both `nightly-export`
 * and `nightly_export` lists them one way in `hyp sync`'s destination table
 * before this change and the other way after, on the same `_` against `-` pair
 * the rule above exists to catch. No harvest can pin a name a user has not
 * written yet. What is claimed is narrower than "nothing reordered": every
 * corpus this repo *ships* is unchanged, and where a user's own names decide,
 * the order is now the machine-independent one, which is the same direction the
 * blob keys moved in.
 *
 * @returns {Map<string, string[]>}
 */
function sortedCorpora() {
  const corpora = new Map(manifestNames())
  corpora.set('commands', commandNames())
  const llpPaths = trackedFiles(REPO_ROOT).filter((rel) => rel.startsWith('llp/'))
  corpora.set('llp paths', llpPaths)
  corpora.set('llp basenames', llpPaths.map((rel) => path.basename(rel)))
  return corpora
}

test('the corpora these comparators sort are big enough to be corpora', () => {
  // A harvest that quietly stopped finding anything leaves the rule below
  // passing over empty lists and saying nothing, which is the one thing a lint
  // may not do.
  const corpora = sortedCorpora()
  assert.ok(corpora.size >= 8, `expected the manifest buckets, got ${corpora.size}`)
  const commands = /** @type {string[]} */ (corpora.get('commands'))
  assert.ok(commands.length > 90, `expected the command table, got ${commands.length} names`)
  assert.ok(commands.includes('sink'), 'the core command table stopped being read')
  assert.ok(commands.includes('session ignore'), 'the plugin command list stopped being read')
  const datasets = /** @type {string[]} */ (corpora.get('datasets'))
  assert.ok(datasets.includes('ai_gateway_messages'), 'the manifest datasets stopped being read')
  // The two `llp/` buckets are one harvest read two ways, so a filter that
  // stopped matching empties both at once and neither would say so.
  const llpPaths = /** @type {string[]} */ (corpora.get('llp paths'))
  const llpBasenames = /** @type {string[]} */ (corpora.get('llp basenames'))
  assert.ok(llpPaths.length > 100, `expected the llp corpus, got ${llpPaths.length} documents`)
  assert.equal(llpBasenames.length, llpPaths.length)
  assert.ok(llpBasenames.includes('0000-hypaware.explainer.md'), 'the llp basenames stopped being read')
})

test('moving these lists off the host collation did not reorder any of them', () => {
  // What the migration owed its users: the same listing, in the same order, on
  // the machines this repo runs on. That is a claim about the names, not about
  // the comparator - swap `ai_gateway_messages` for `ai-gateway-messages` in
  // the dataset list and the two orders come apart at once, because the root
  // collation puts `_` before `-` and the characters put `-` first.
  //
  // Pinned against an explicitly named locale rather than the box's own. The
  // reference order is the one CI and every en-US dev box have been printing,
  // so naming it is what turns this into a statement about the corpus; reading
  // the ambient locale instead would make a Lithuanian contributor's clean
  // checkout red for the collation this change exists to stop consulting.
  //
  // Skipped whole, loudly, on a runtime built without ICU: there is no
  // collation there to compare against, `localeCompare` is already this
  // comparator, and the gate that actually stops a regression is the source
  // scan in `format-number.test.js`, which reds on every build.
  //
  // Asked as `typeof Intl === 'undefined'` first, and repeated in that shape
  // at the two guards below. `typeof` only swallows a ReferenceError for a
  // bare identifier: `typeof Intl?.Collator` is a member expression, so it
  // still evaluates `Intl` and throws where the global is absent, which is
  // the `--without-intl` build these guards exist for. The short spelling
  // reads as a skip and behaves as a crash on the one runtime it is about.
  if (typeof Intl === 'undefined' || typeof Intl.Collator !== 'function') {
    assert.ok(true, 'no ICU on this runtime, so there is no host collation to differ from')
    return
  }
  const reference = new Intl.Collator('en-US').compare
  for (const [name, corpus] of sortedCorpora()) {
    assert.deepEqual(
      [...corpus].sort(compareStrings),
      [...corpus].sort(reference),
      `the ${name} list sorts differently under compareStrings than it did under ` +
        'the host collation, so any listing ordered by this bucket is about to ' +
        'print in a new order (see the note on sortedCorpora for which buckets ' +
        'a comparator actually sorts today). Either the new name mixes `_` with ' +
        '`-`, `.` or `/` against a sibling, or it carries an uppercase letter; ' +
        'rename it, or accept the reorder here on purpose'
    )
  }
})

test('the collation these lists came off really does move with the machine', () => {
  // Lithuanian makes `y` a secondary variant of `i` rather than a letter of
  // its own, so `sink` and `sync` tie on those two positions at the primary
  // strength and the later `c` against `k` decides: `sync` first, where the
  // characters put `sink` first. Worth stating that way round, because "y
  // sorts just after i" on its own would predict the opposite answer.
  //
  // That pair lives in the `commands` corpus above, which holds both names.
  // Of the corpora harvested here, `commands` and `skills` are the only two
  // the two orders disagree on under any locale probed - `commands` under
  // Lithuanian, `skills` under Azerbaijani, which sorts `q` before `p` and so
  // swaps `hypaware-privacy` with `hypaware-query`. Neither is a shipped
  // symptom: nothing sorts the `skills` bucket at all (see `sortedCorpora`),
  // and `hyp --help` does not sort the pair below.
  //
  // Being exact about `hyp --help`, because it is the surface this pin used to
  // claim was broken. `orderedHelpNames` in `src/core/cli/dispatch.js` does not
  // sort the 102 command names; it sorts the top-level *heads*, split by
  // section, and only as a tiebreak after a per-section `preferred` rank. Two
  // separate things keep the collation out of it today:
  //
  //  - `sync` is declared `capture-movement` and `sink` `additional`, so the
  //    two never appear in the same `available` list and no comparator in that
  //    renderer ever sees the pair. It is not "the pair reaches the tiebreak
  //    eventually"; on the current categories it cannot reach it at all.
  //  - the tiebreak runs only between two heads of *equal* rank, which means
  //    two heads that are both absent from their section's `preferred` list. A
  //    single unranked command does not do it: its rank is MAX_SAFE_INTEGER
  //    against every ranked neighbour's index, so `ar - br` decides every pair
  //    it takes part in. Every non-hidden head the bundled plugins can
  //    contribute is ranked, and the four heads that are not (`claude-hook`,
  //    `codex-hook`, `claude-account`, `gascity`) come only from commands
  //    marked `hidden`, which never reach a help row.
  //
  // Both halves are observable rather than argued: with every bundled plugin
  // config-active, `hyp --help` is byte-identical before and after this change
  // and across `en_US`, `lt_LT`, `az_AZ`, `lv_LV` and `tr_TR`. Stage one
  // unranked plugin command and it stays identical; stage two and the
  // pre-migration renderer orders them differently under `lt_LT` than under
  // `en_US`. So the live hazard is a plugin shipping a second unranked
  // top-level command, not the first, and the names at risk are that plugin's,
  // not `sink` and `sync`.
  //
  // What is asserted below is therefore the collation's disagreement itself,
  // which is the thing the migration removed the dependency on, and not a
  // claim about what the help text prints.
  //
  // Conditional on the runtime actually having Lithuanian data: a `small-icu`
  // build resolves `lt` back to English and would show no disagreement, which
  // says nothing about Lithuanian and must not be read as saying the hazard is
  // gone. Asked of the *resolved* tag rather than the requested one, because
  // ICU canonicalises `lt-LT` to `lt` (LT is Lithuanian's likely region), so
  // a guard comparing against the requested tag returns early on every
  // full-ICU box and the two assertions below never run.
  //
  // Two predicates, deliberately not one, and neither of them is the
  // interesting question. The first asks whether this runtime has `Intl` at
  // all, the second whether it gave back Lithuanian rather than a substitute;
  // whether Lithuanian actually *differs* from the characters is not guarded,
  // it is the assertion. A build that answered `lt` from degraded data would
  // red here rather than skip, which is the direction this pin wants. Folding
  // the two guards into one shared `hasLocale` helper, here or across files,
  // is how a resolution check quietly becomes the whole test again.
  if (typeof Intl === 'undefined' || typeof Intl.Collator !== 'function') return
  const collator = new Intl.Collator('lt-LT')
  const resolved = collator.resolvedOptions().locale
  if (resolved !== 'lt' && !resolved.startsWith('lt-')) return
  assert.ok(compareStrings('sink', 'sync') < 0)
  assert.ok(collator.compare('sink', 'sync') > 0)
})

test('the second disagreement the corpora hold is real too, and it is not Lithuanian', () => {
  // The rule two tests up pins the corpora against `en-US`, so it is silent
  // about every locale that is not that one. Two of the harvested buckets
  // disagree with the characters under some locale, and only one of them was
  // written down as an assertion: `commands` under Lithuanian, above. This is
  // the other one, so the prose about it stops being the only record (#1148
  // item 4).
  //
  // Azerbaijani orders `q` before `p`, which swaps the two skill names below;
  // the characters put `hypaware-privacy` first. Nothing sorts the `skills`
  // bucket today (see `sortedCorpora`), so this is not a shipped symptom, and
  // that is the point of pinning it: the day a registry starts sorting its
  // skills is a two-line change nobody would come here for, and this is what
  // says the pair was already known to move.
  //
  // Guarded in the same two-predicate shape as the Lithuanian pin, and for the
  // same reason: `typeof Intl` first because it is the only spelling that
  // survives a `--without-intl` build, then the resolved tag, because a
  // `small-icu` build answers `az` with English data and would show no
  // disagreement at all.
  if (typeof Intl === 'undefined' || typeof Intl.Collator !== 'function') return
  const collator = new Intl.Collator('az')
  const resolved = collator.resolvedOptions().locale
  if (resolved !== 'az' && !resolved.startsWith('az-')) return
  assert.ok(compareStrings('hypaware-privacy', 'hypaware-query') < 0)
  assert.ok(collator.compare('hypaware-privacy', 'hypaware-query') > 0)
  // Both names are really in the bucket, so this stays a statement about the
  // corpus rather than about two strings that happen to differ.
  const skills = sortedCorpora().get('skills') ?? []
  assert.ok(skills.includes('hypaware-privacy') && skills.includes('hypaware-query'))
})

test('blob keys are the one migrated corpus whose order does change, and it changes toward S3', () => {
  // `local-fs`'s `listObjects`, the S3 dataset's partition discovery, the
  // two S3 fixtures under `hypaware-core/smoke/flows` and the three
  // `listObjects` doubles under `test/` all sort object keys, and object keys
  // are not identifiers: they are paths, they carry uppercase (the S3 key
  // renderer's segment allowlist is `[A-Za-z0-9._=,-]`), and the tracked tree
  // already holds a pair that the two orders disagree on. So this corpus is
  // excluded from the rule above rather than quietly asserted to be stable.
  //
  // The reorder is the right one. Every one of those sites implements or
  // emulates `listObjects`, and for a general-purpose bucket S3 returns keys
  // in lexicographical UTF-8 byte order, which for these keys is what
  // `compareStrings` gives and what the host collation did not: collation puts
  // `_` before `-` and lowercase before uppercase, so a store holding
  // `ds/A.parquet` and `ds/a.parquet` listed them in an order no bucket would.
  // The fixtures got closer to the service they stand in for.
  assert.ok(compareStrings('CLAUDE.md', 'bin/hypaware.js') < 0)
  if (typeof Intl === 'undefined' || typeof Intl.Collator !== 'function') return
  const reference = new Intl.Collator('en-US').compare
  assert.ok(reference('CLAUDE.md', 'bin/hypaware.js') > 0)
})

/**
 * The inline shape of this comparator, written out at a call site instead of
 * called: `x < y ? -1 : x > y ? 1 : 0`, and its descending twin
 * `x < y ? 1 : x > y ? -1 : ...`.
 *
 * Thirteen of these were in the tree when `compareStrings` landed, all of them
 * already correct and locale-free, which is exactly why they were left alone at
 * the time: #1145 was about taking nineteen comparators *off* the host, and a
 * mechanical rewrite of thirteen that were never on it would have buried that
 * in noise (#1148 item 2).
 *
 * They are worth collecting anyway, and not for tidiness. Every one of them is
 * a comparator that no longer passes through the one function this repo pins,
 * documents and now guards, so each is its own small answer to "what happens
 * when this gets a non-string" and each is a place the next reader has to
 * re-derive that the ordering is code-unit rather than collated. Written out
 * inline the shape also has a cheap wrong neighbour: drop the `> ` arm and
 * `x < y ? -1 : 1` is a comparator that never returns 0 and is not a total
 * order, which is a one-character edit away and reads fine.
 *
 * Both `-1` and `1` are required, so the two-way `x < y ? -1 : 1` spellings
 * that sit under an explicit `!==` guard are out of scope: under their guard
 * those are correct, they are not this shape, and reddening on them would be a
 * rule about something else. One of them moved to the helper anyway, in
 * `context-graph/src/maintenance.js`, because it sat two lines from one this
 * rule did catch; the rule did not ask for it and would not have.
 *
 * The descending spelling was out of scope when this rule landed, and that was
 * a boundary rather than a judgement: #1148 enumerated the thirteen ascending
 * ones, and a comparator is not a thing to rewrite in a file nobody asked
 * about. Rather than describe the exclusion, this file held the five shipped
 * descending sites as a list, so that the scope note was checked rather than
 * asserted: a count in a comment is the shape of claim this file exists to
 * stop making. #1156 migrated all five to `compareStrings(b, a)`, over values
 * that are strings by the time they are sorted, and an inventory of nothing is
 * not an inventory. So the descending pair joined the needle below and the
 * list left with the sites it named. What still separates the two spellings is
 * the `: 0` tail, for the reason the limits paragraph gives.
 *
 * A number legitimately written this way reds here as a false positive, and
 * that is any number, not only the BigInt pair where `a - b` is a BigInt
 * rather than a sort result: `bytesA < bytesB ? -1 : bytesA > bytesB ? 1 : 0`
 * is the same punctuation. There is none in the tree today. The remedy when
 * one lands is the allowlist below with its reason, not a looser needle: no
 * regex can tell a string comparison from a numeric one, and a needle that
 * tried would stop catching the case this rule is for.
 *
 * That remedy is module-scoped, and the cost of it should be visible rather
 * than discovered: allowlisting a module for one numeric comparator exempts
 * every later string comparator in the same file too. It is the sibling gate's
 * bargain as well, and it is why the reason is written next to the entry - the
 * entry has to be re-read when the file changes shape, because nothing else
 * will notice.
 *
 * Both operand orders are matched, in both directions, because
 * `a > b ? 1 : a < b ? -1 : 0` is the same comparator with the arms swapped and
 * a rule that caught only one of the two spellings would be a rule about
 * punctuation rather than about the comparison. There is no site in either
 * operand order today; the swapped alternatives are here so that the cheapest
 * way past this gate is not to type the operands the other way round.
 *
 * Two limits are left standing, and both are stated rather than fixed because
 * closing either needs a tokenizer and this file has already declined to be
 * one. A comparator wrapped across physical lines by a formatter evades the
 * per-line scan below; and the ascending alternatives require the `: 0` tail,
 * so an ascending chain that ends in a tiebreak rather than a tie
 * (`a < b ? -1 : a > b ? 1 : compareStrings(x, y)`) is not caught, where the
 * descending alternatives do not require it and do catch their tiebreak form.
 * Neither shape exists in the tree today, which is what makes them limits
 * rather than misses.
 */
const INLINE_CODE_UNIT_COMPARATOR =
  /<[^?]*\?\s*-1\s*:[^?]*>[^?]*\?\s*1\s*:\s*0|>[^?]*\?\s*1\s*:[^?]*<[^?]*\?\s*-1\s*:\s*0|<[^?]*\?\s*1\s*:[^?]*>[^?]*\?\s*-1\s*:|>[^?]*\?\s*-1\s*:[^?]*<[^?]*\?\s*1\s*:/

/**
 * The shipped modules allowed to spell the comparison out, and why.
 *
 * Held to equality rather than containment, the way the sibling gate in
 * `format-number.test.js` holds its own exemption list: a stale entry cannot
 * outlive the line it excuses.
 */
const INLINE_COMPARATOR_ALLOWED = {
  'src/core/util/compare_strings.js':
    'the definition, which is the one place the comparison is written out',
}

test('no shipped module writes the comparison out instead of calling it', () => {
  // Scanned raw rather than through a comment-blanking pass. The sibling gate
  // in `format-number.test.js` needs one because the names it forbids are the
  // names a module explaining itself would naturally write; this needle is a
  // punctuation shape nobody types in prose, and the only comment in the tree
  // that could carry it is one quoting the definition. The `*` and `//` skip
  // below covers that much without pretending to be a tokenizer, and anything
  // it misses over-reports with a file and a line to look at.
  const paths = trackedFiles(REPO_ROOT, new Set(['.js', '.mjs', '.cjs'])).filter(
    (rel) => !rel.startsWith('test/')
  )
  // A pathspec that stopped matching would leave this passing over an empty
  // tree and say nothing, which is the one failure a lint cannot afford.
  assert.ok(paths.length > 100, `expected the shipped tree, got ${paths.length} modules`)
  const offenders = []
  for (const rel of paths) {
    if (Object.hasOwn(INLINE_COMPARATOR_ALLOWED, rel)) continue
    const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n')
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      if (INLINE_CODE_UNIT_COMPARATOR.test(line)) offenders.push(`${rel}:${i + 1}: ${trimmed}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    'these comparators write out the code-unit comparison instead of calling ' +
      'compareStrings, so each one answers for itself what a non-string sorts ' +
      'as and each one re-states an ordering the repo pins in one place; call ' +
      'compareStrings, or add the module to INLINE_COMPARATOR_ALLOWED with the ' +
      'reason it cannot'
  )
})

test('the allowlist above names only modules that exist and still spell it out', () => {
  // The equality the exemption list is held to runs the other way as well: an
  // entry for a file that no longer carries the shape is an exemption for
  // nothing, and it would go on excusing a line the next edit puts back.
  // "Exist" is checked before "still spells it out", and separately, because
  // a renamed or deleted allowlisted module read straight through
  // `readFileSync` dies as a raw ENOENT rather than as this rule: the exact
  // failure `trackedFiles` was written to keep out of the sibling gate above.
  // An allowlist key is a hand-written path, so it is the likeliest one here.
  const present = new Set(trackedFiles(REPO_ROOT, new Set(['.js', '.mjs', '.cjs'])))
  for (const rel of Object.keys(INLINE_COMPARATOR_ALLOWED)) {
    assert.ok(
      present.has(rel),
      `${rel} is allowlisted but is not a readable tracked module; the file moved, so move the entry`
    )
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    assert.ok(
      INLINE_CODE_UNIT_COMPARATOR.test(source),
      `${rel} is allowlisted but no longer writes the comparison out; drop the entry`
    )
  }
})
