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
 * `llp/` paths stand for `scripts/llp-numbers.js`, and they are a proxy rather
 * than that script's own list: `claimsByNumber` keys on `basename(file)`, so
 * what `collisions` actually sorts is the bare `NNNN-slug.type.md` names of the
 * documents claiming one number. The tracked paths carry the same alphabet plus
 * `/` and the directory prefixes, and the two lists sort identically here, so
 * the wider corpus is the safe side of the approximation. Blob keys are
 * deliberately absent and the last rule in this file says why.
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
  corpora.set('llp paths', trackedFiles(REPO_ROOT).filter((rel) => rel.startsWith('llp/')))
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
