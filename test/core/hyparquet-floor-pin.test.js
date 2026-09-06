// @ts-check

// LLP 0222 settled one WHERE-to-parquet-filter converter, icebird's, and its
// #hyparquet-floor makes hyparquet 1.28.2 a floor: icebird pushes bare
// relational bounds, which only answer correctly because 1.28.2's
// `matchFilter` rejects null cells in `$lt`/`$lte`/`$gt`/`$gte`. A hyparquet
// *below* that floor resolved anywhere on the query read path silently
// reintroduces the leak the floor removed, and it fails as wrong rows rather
// than as an error. The root pin is exact (so every override can name one
// version), but the correctness requirement is the floor, so that is what the
// checks below compare against.
//
// `hypgrep` (LLP 0264 #dependency) was the first read-path dependency to
// declare a hyparquet below the floor: 0.5.1 pinned 1.27.1, adopted behind a
// root `overrides` entry. 0.5.2 declares the root pin itself, so that entry now
// only restates what hypgrep already asks for, and `icebird` is the entry doing
// the work: 0.8.28 declares 1.29.2, which the 1.30.0 root pin does not satisfy.
// The two swap roles as upstream moves, which is why the checks below are
// written against the pins rather than against either package by name. Three
// kinds of check live here and they prove different things:
//
//   - The manifest half (the first two tests) reads only the checked-in root
//     `package.json`, so it runs on any checkout: the root pins are exact, and
//     the override that holds hypgrep to them exists and names those versions.
//     Deleting the override reddens here with nothing installed.
//   - The resolved half (the installed-tree tests after those two) reads what
//     npm actually placed, which is the only place a *dependency's own*
//     declaration and npm's actual placement can be seen. It has no answer
//     without `node_modules`, so it skips there rather than passing silently.
//   - The synthetic half (the two tests over declarations and overrides
//     written here) drives the shared predicates on inputs no installed tree
//     happens to carry, so those shapes are checked anyway. It reads neither
//     the manifest nor the tree, so it never skips.
//
// What neither half reaches: npm honours `overrides` only for the root
// project, so the entries govern this checkout and any install that treats
// hypaware as the root, and are ignored when hypaware is itself installed as a
// dependency (`npm i -g hypaware`, `npx hypaware`), where icebird still gets
// its own 1.29.2. That gap now costs a second reader rather than a wrong row:
// the below-floor version of it closed when hypgrep 0.5.2 stopped declaring
// 1.27.1. Moving the declaration upstream, which LLP 0264 #dependency already
// names as the durable fix, is what closes the rest; a check on it would have
// to pack and install this package, which is not a job for the traditional
// suite.
//
// Scope is the root `dependencies`, which is the query read path: the kernel
// reads parquet through icebird and (from LLP 0264) hypgrep. The
// optionalDependencies are write-side and vector-side (`hyparquet-writer`,
// `hypvector`); neither runs icebird's converter, so neither is checked here.
// The root `overrides` do name one of them, and not as part of any floor: no
// published `hyparquet-writer` declares 1.30.0, so once the root pin moved
// there npm bound the hoisted writer to it regardless and then reported the
// tree invalid. The entry says that binding is intended. Its key is
// version-scoped (`hyparquet-writer@0.16.9`) on purpose: a bare key would also
// reach the 0.16.1 copy nested under `hypvector` and drag it from 1.26.1 to
// 1.30.0, which is a change to the vector path with nothing asking for it.
//
// @ref LLP 0222#hyparquet-floor [tests]: a floor only holds if nothing below it resolves beside the pin, and the deduping the same section claims is a separate property that has to be held separately
// @ref LLP 0264#dependency [tests]: hypgrep enters as a plain root dependency, held to the floor by an override

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchesSemverRange, isValidRange } from '../../src/core/semver.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules')

const manifest = readJson(path.join(REPO_ROOT, 'package.json'))
if (!manifest) throw new Error('root package.json is unreadable')

const dependencies = manifest.dependencies ?? {}
const optionalDependencies = manifest.optionalDependencies ?? {}
const devDependencies = manifest.devDependencies ?? {}
const peerDependencies = manifest.peerDependencies ?? {}
const overrides = manifest.overrides ?? {}

/** The version LLP 0222 #hyparquet-floor requires, below which bounds leak NULL rows. */
const HYPARQUET_FLOOR = '1.28.2'

// The pins are read off the manifest rather than written here twice: a bump of
// the root pin should move every override with it, and the assertions below are
// what make that true. The floor is a separate constant because it is a
// property of hyparquet's behaviour, not of what this repo happens to pin, so
// bumping the root pin must not redden a dependency that is already correct.
const ROOT_PINS = {
  hyparquet: dependencies.hyparquet,
  'hyparquet-writer': optionalDependencies['hyparquet-writer'],
}

/** The lowest version of each governed package that is still correct here. */
const FLOORS = {
  hyparquet: HYPARQUET_FLOOR,
  'hyparquet-writer': ROOT_PINS['hyparquet-writer'],
}

/** Whether the resolved half has a tree to read. */
const INSTALLED = readJson(path.join(NODE_MODULES, 'hyparquet', 'package.json')) !== undefined

test('the root hyparquet pin is exact and at or above the floor', () => {
  assert.match(ROOT_PINS.hyparquet ?? '', /^\d+\.\d+\.\d+$/,
    'the root hyparquet pin is exact, not a range, so the overrides can name one version')
  assert.ok(atOrAboveFloor(ROOT_PINS.hyparquet, HYPARQUET_FLOOR),
    `LLP 0222 #hyparquet-floor: hyparquet must be >= ${HYPARQUET_FLOOR}, ` +
    `and the root pin is ${ROOT_PINS.hyparquet}`)
  assert.match(ROOT_PINS['hyparquet-writer'] ?? '', /^\d+\.\d+\.\d+$/,
    'the hyparquet-writer pin is exact too, so the overrides can name one version')
  // A version-scoped key stops applying the moment the version it names is no
  // longer the one installed, and nothing else here notices: npm still resolves
  // the same tree, every check in this file stays green, and only a `npm ls`
  // nobody runs in CI reports it invalid. So the key is checked against the pin
  // rather than written out twice. Existence is not required - the entry is
  // worth having only while no published writer declares the root pin, which is
  // the same rule the icebird entry is held to - but a key that is present and
  // stale is a decoration, and this is what says so.
  for (const key of Object.keys(overrides)) {
    if (!key.startsWith('hyparquet-writer@')) continue
    assert.equal(key, `hyparquet-writer@${ROOT_PINS['hyparquet-writer']}`,
      `\`${key}\` no longer names the hyparquet-writer pin, so npm applies nothing for it`)
    assert.equal(overrides[key].hyparquet, ROOT_PINS.hyparquet,
      `\`${key}\` exists to say the writer's binding to the root hyparquet is intended, ` +
      'so it names that pin')
  }
  // The premise `pinsRoot` reads `$hyparquet` on. npm resolves an override's
  // `$name` reference against the root's own declarations in its own order
  // (devDependencies, then optionalDependencies, then dependencies, then
  // peerDependencies), and takes the first it finds. Each governed package is
  // declared once above, so that order cannot reach past the pin this file
  // compares against; a second declaration elsewhere would win it silently, and
  // an override reading `$hyparquet` would then hold hypgrep at *that* version
  // while every check here still called it the root pin.
  for (const [dep, pin] of Object.entries(ROOT_PINS)) {
    assert.equal(referencedSpec(dep), pin,
      `npm resolves an \`overrides\` "$${dep}" reference to ${referencedSpec(dep)}, not the root ` +
      `pin ${pin}: ${dep} is declared in more than one place, so drop the declaration that is not the pin`)
  }
})

test('hypgrep is a plain dependency, held at the floor by an override', () => {
  // LLP 0264 #dependency: the client both builds and reads indexes, so hypgrep
  // is a root dependency rather than an optional one.
  assert.ok(dependencies.hypgrep,
    'LLP 0264 #dependency: hypgrep belongs in `dependencies`')
  assert.match(dependencies.hypgrep, /^\d+\.\d+\.\d+$/,
    'hypgrep is pinned exactly, in the idiom of every other dependency here')
  // The override was the whole of the adoption while hypgrep 0.5.1 declared
  // hyparquet 1.27.1: without the entry npm resolved that older copy privately
  // under `node_modules/hypgrep`. 0.5.2 declares the root pin itself, so today
  // the entry only restates what hypgrep already asks for, and it is asserted
  // anyway because this is the one dependency whose declaration has already
  // gone below the floor once. The header above says why the roles swap: a
  // later hypgrep that declares below the pin resolves onto the hoisted copy
  // with the entry in place and nests a private one without it, and that
  // regression is silent. Asserted straight off the manifest so a dropped or
  // misspelled entry reddens on a checkout with nothing installed, not only
  // where the resolved half below can run. It names the root pin rather than
  // the floor so the copy it forces is the one already hoisted, not a second
  // correct one.
  assert.ok(pinsRoot(overrides.hypgrep?.hyparquet, 'hyparquet', ROOT_PINS),
    'LLP 0222 #hyparquet-floor: the hypgrep override holds hyparquet at the root pin, ' +
    `and it names ${overrides.hypgrep?.hyparquet}`)
  assert.ok(pinsRoot(overrides.hypgrep?.['hyparquet-writer'], 'hyparquet-writer', ROOT_PINS),
    'the hypgrep override holds hyparquet-writer at the root pin, ' +
    `and it names ${overrides.hypgrep?.['hyparquet-writer']}`)
  // Index writes ride the existing optionalDependency exactly as the cache
  // write path does. Pinning the writer inside an override must not promote it
  // to a hard root dependency: an install with `--omit=optional` still has to
  // boot and read.
  assert.equal(dependencies['hyparquet-writer'], undefined,
    'hyparquet-writer is an optionalDependency; the overrides pin must not promote it')
  assert.ok(optionalDependencies['hyparquet-writer'],
    'hyparquet-writer stays in optionalDependencies')
})

// The floor above is correctness. This pair is hygiene, and it is here because
// the corpus asserts it: LLP 0222 #hyparquet-floor records the 1.28.1 -> 1.28.2
// bump as "resolving to a single deduped copy shared with icebird". That was
// true when written and stopped being true without a sound: icebird 0.8.25
// began declaring its own exact hyparquet, npm nested a second copy under it,
// and nothing reddened because both copies sit above the floor and only a
// below-floor copy changes an answer. Kept separate from the floor tests for
// exactly that reason - this pair can go red while every query is still right,
// and reading a dedupe failure as a correctness failure is how the floor tests
// would start lying.
//
// icebird carries an override entry again: it declared the root pins itself
// while the root pinned hyparquet 1.29.2, and 0.8.28 still declares 1.29.2 now
// that the root pin is 1.30.0, so npm nests a private copy without one. An
// entry is worth having only while it names something the dependency does not
// already ask for; one that merely restates the declaration is a second place
// to forget to bump. That is why this check reads icebird's own installed
// declaration when no override names the pin, and why it sits in the resolved
// half rather than the manifest half above. The remedy when it goes red is
// still directional: if icebird declares a parquet package ABOVE the root pin,
// move the ROOT pin up; only a declaration BELOW the pin wants the override
// back. Holding a dependency down onto an older reader to win a dedupe would
// trade the property that matters for the one that does not.
test('icebird uses the root parquet pins directly or through overrides', t => {
  assert.ok(dependencies.icebird, 'icebird is the read path; it belongs in `dependencies`')
  if (!INSTALLED) {
    t.skip('no node_modules, so icebird\'s own declaration is not readable')
    return
  }
  // A resolved tree that is missing icebird fails rather than skips: the one
  // package this test is about did not install, so nothing verified the pin.
  // `installedDeclarations` rather than a bare `dependencies` read for the
  // reason that helper exists - a package may declare a parquet reader as a
  // peer or optional dependency, and reading one key would call that absent.
  const declared = installedDeclarations('icebird')
  assert.ok(declared, 'icebird is not installed beside the resolved tree - run `npm i`')
  const offenders = dedupeOffenders('icebird', declared, overrides.icebird, ROOT_PINS)
  assert.deepEqual(offenders, [], 'LLP 0222 #hyparquet-floor claims one deduped copy ' +
    `shared with icebird:\n  ${offenders.join('\n  ')}`)
})

// Synthetic declarations rather than the installed tree, so the shapes that are
// hypothetical today are checked anyway and a later pin bump cannot change what
// this proves.
test('a declaration dedupes when the root pin satisfies it, not when it matches it', () => {
  const pins = { hyparquet: '1.29.2' }
  const against = spec => dedupeOffenders('dep', { hyparquet: spec }, undefined, pins).join('\n')
  // Every range the pin satisfies resolves onto the hoisted copy, so none of
  // these nests anything. The exact pin is only the narrowest of them.
  for (const spec of ['1.29.2', '^1.29.2', '^1.28.2', '~1.29.0', '>=1.28.2', '*']) {
    assert.equal(against(spec), '', `${spec} dedupes onto the root pin`)
  }
  // A declaration the pin cannot satisfy is the failure this check is for, in
  // both directions. One message serves both, so what is asserted is that it
  // carries each remedy beside the direction that wants it: matching only
  // "move the ROOT pin up" on an above-pin spec passes just as well against a
  // template whose two remedies have been swapped.
  for (const spec of ['^1.30.0', '1.27.1', '~1.28.2']) {
    assert.match(against(spec), /does not satisfy/, `${spec} is out of range for the root pin`)
    assert.match(against(spec), /ABOVE the root pin, move the ROOT pin up/)
    assert.match(against(spec), /BELOW it wants an `overrides` entry naming 1\.29\.2/)
  }
  // An unfamiliar range shape says that is what happened rather than claiming
  // the declaration is out of range.
  assert.match(against('>=1.28.0 <2.0.0'), /cannot judge/)
  // A declaration with nothing in it is unreadable, not satisfied: the matcher
  // answers `true` for an empty or null range, so judging satisfaction first
  // would wave these through as deduped.
  for (const spec of ['', null]) {
    assert.match(dedupeOffenders('dep', { hyparquet: spec }, undefined, pins).join('\n'),
      /cannot judge/, 'a declaration with no range in it is unreadable, not satisfied')
  }
  // An absent declaration is nothing to nest, and an override forces the root
  // copy whatever is declared.
  assert.deepEqual(dedupeOffenders('dep', {}, undefined, pins), [])
  assert.deepEqual(dedupeOffenders('dep', { hyparquet: '1.27.1' }, { hyparquet: '1.29.2' }, pins), [])
  // An override naming anything but the root pin is what installs the second
  // copy, so it is judged on its own version rather than read past to a
  // declaration the root pin happens to satisfy.
  assert.match(dedupeOffenders('dep', { hyparquet: '^1.29.0' }, { hyparquet: '1.27.1' }, pins).join('\n'),
    /entry pinning hyparquet@1\.27\.1/)
  // npm resolves `$hyparquet` to the root's own spec, so an entry in that form
  // is the root pin written by reference and forces the same hoisted copy.
  assert.deepEqual(dedupeOffenders('dep', { hyparquet: '1.27.1' }, { hyparquet: '$hyparquet' }, pins), [])
  assert.match(dedupeOffenders('dep', { hyparquet: '1.27.1' }, { hyparquet: '$hyparquet-writer' }, pins).join('\n'),
    /entry pinning hyparquet@\$hyparquet-writer/)
  assert.match(dedupeOffenders('dep', { hyparquet: '1.27.1' }, undefined, { hyparquet: undefined }).join('\n'),
    /no root pin/)
})

test('no root dependency nests a hyparquet of its own', t => {
  if (!INSTALLED) {
    t.skip('no node_modules, so nothing has been resolved to inspect')
    return
  }
  // Scoped to hyparquet, and to the root `dependencies`, for the same reason
  // the floor checks are: the optionalDependencies are write-side and
  // vector-side, `hypvector` carries its own nested pair today, and neither
  // runs icebird's converter.
  const nested = []
  for (const name of Object.keys(dependencies)) {
    for (const copy of nestedCopies(path.join(NODE_MODULES, name))) {
      if (copy.dep !== 'hyparquet') continue
      nested.push(`${copy.where} is hyparquet@${copy.version}, beside the root ${ROOT_PINS.hyparquet}`)
    }
  }
  assert.deepEqual(nested, [], 'LLP 0222 #hyparquet-floor claims one deduped hyparquet ' +
    `shared across the read path; these are second copies:\n  ${nested.join('\n  ')}`)
})

test('every read-path dependency that carries hyparquet is held at the floor', t => {
  if (!INSTALLED) {
    // A dependency's own declaration only exists in its published
    // package.json, and this repo checks in no lockfile, so there is nothing to
    // read here. Skipping says so; returning green would claim a check that
    // never ran.
    t.skip('no node_modules, so no dependency declarations are readable')
    return
  }
  // The lint that outlives this change: a future direct dependency shipping its
  // own hyparquet either already resolves at or above the floor or needs an
  // override, and this names which one it is instead of leaving a second copy
  // to be found by a wrong row count.
  const offenders = floorOffenders(dependencies, overrides, installedDeclarations, FLOORS, ROOT_PINS)
  assert.deepEqual(offenders, [], 'LLP 0222 #hyparquet-floor: an older copy resolving ' +
    `beside the floor answers relational bounds wrong:\n  ${offenders.join('\n  ')}`)
})

// A made-up manifest, because nothing here carries npm's `$name` override form
// today and only a synthetic input can hold the property: an entry that names
// the root pin by reference is the same pin, and reading it as a literal
// version reports it as an offender pinning `hyparquet@$hyparquet`.
test('an overrides entry may name the root pin by npm\'s $name reference', () => {
  const declarationsOf = () => ({ hyparquet: '1.27.1' })
  const deps = { hypgrep: '0.5.1' }
  const floors = { hyparquet: '1.28.2' }
  const pins = { hyparquet: '1.29.2' }
  const against = entries => floorOffenders(deps, entries, declarationsOf, floors, pins)
  assert.deepEqual(against({ hypgrep: { hyparquet: '$hyparquet' } }), [],
    '`$hyparquet` resolves to the root pin, so it holds hypgrep at the floor')
  assert.deepEqual(against({ hypgrep: { hyparquet: pins.hyparquet } }), [],
    'the same entry written by value reads as green too')
  assert.equal(against({ hypgrep: { hyparquet: '$hyparquet-writer' } }).length, 1,
    'a reference to another package is not a reference to this one')
  assert.equal(against({}).length, 1,
    'a below-floor declaration with no entry at all is still an offender')
  // npm throws `Unable to resolve reference $hyparquet` on a reference with no
  // root declaration behind it, so a green here would claim a floor held by an
  // install that cannot run.
  assert.equal(
    floorOffenders(deps, { hypgrep: { hyparquet: '$hyparquet' } }, declarationsOf, floors, { hyparquet: undefined })
      .length, 1,
    'a reference to a package the root no longer pins is not the root pin')
})

test('the read path resolves the one root hyparquet, not a nested copy', t => {
  if (!INSTALLED) {
    t.skip('no node_modules, so nothing has been resolved to inspect')
    return
  }
  // `npm ls hyparquet` in assertion form, and the half a manifest read cannot
  // give you: an override with the wrong shape (nested under the wrong key, or
  // naming a version no longer at the root) still parses as valid JSON and
  // still lets npm install a private copy underneath the dependency.
  assert.equal(installedVersion(NODE_MODULES, 'hyparquet'), ROOT_PINS.hyparquet,
    'the hoisted hyparquet is the pinned one')

  const nested = []
  for (const name of Object.keys(dependencies)) {
    for (const copy of nestedCopies(path.join(NODE_MODULES, name))) {
      // A copy npm left in place at or above the floor is a duplicate file
      // tree, not a floor violation, and failing on it would report a
      // correctness problem that is not there. Only a below-floor copy changes
      // an answer.
      const floor = FLOORS[copy.dep]
      if (floor !== undefined && atOrAboveFloor(copy.version, floor)) continue
      nested.push(`${copy.where} is ${copy.dep}@${copy.version}, below the floor ${floor}`)
    }
  }
  assert.deepEqual(nested, [], 'LLP 0222 #hyparquet-floor: the overrides exist so ' +
    `these dedupe to the root copy:\n  ${nested.join('\n  ')}`)
})

/**
 * The read-path dependencies that resolve a governed package below its floor
 * with nothing holding them to the root copy instead, plus the ones an entry
 * holds *below* their own declaration. One line per offender, empty when every
 * one is held. A function of its arguments and nothing else,
 * for the same reason `dedupeOffenders` takes its pins: a manifest shape this
 * repo does not carry can then be held to the same reading as the one it does,
 * and a later pin bump cannot change what the synthetic caller proves.
 *
 * @param {Record<string, string>} deps the root `dependencies`
 * @param {Record<string, Record<string, string>>} entries the root `overrides`
 * @param {(name: string) => Record<string, string> | undefined} declarationsOf
 *   what a dependency declares, or undefined when it is not installed
 * @param {Record<string, string | undefined>} floors the lowest correct version, by package
 * @param {Record<string, string | undefined>} pins the root pins, by package
 * @returns {string[]}
 */
function floorOffenders(deps, entries, declarationsOf, floors, pins) {
  const offenders = []
  for (const [dep, floor] of Object.entries(floors)) {
    // A pin read off the manifest as undefined would make every comparison below
    // vacuous, so it is reported once here rather than skipped per dependency.
    if (floor === undefined) offenders.push(`no root pin for ${dep}, so nothing can be checked against its floor`)
  }
  for (const name of Object.keys(deps)) {
    if (name === 'hyparquet') continue
    const declared = declarationsOf(name)
    if (!declared) {
      // Only for a dependency an override governs: that entry is the whole of
      // its adoption, and an absent package means the one check that could
      // have proved the entry took never ran.
      if (entries[name]) {
        offenders.push(`${name} has an overrides entry but is not installed, so nothing verified it - run \`npm i\``)
      }
      continue
    }
    for (const [dep, floor] of Object.entries(floors)) {
      if (floor === undefined) continue
      if (declared[dep] === undefined) continue
      // An override forces the root copy whatever the dependency declares, so it
      // holds a dependency DOWN exactly as readily as it holds one up, and the
      // floor comparison below cannot see that: it judges the declaration, which
      // is above the floor precisely in the case that goes wrong. The direction
      // is what separates the two, so it is asked here rather than inferred.
      // Live at this head: hypgrep 0.5.2 declares hyparquet 1.30.0 because it
      // imports `rowIndex`, which 1.29.2 does not export, so a root pin moved
      // back under it would leave every check in this file green and break the
      // first grep at module link, which no floor can catch because the floor is
      // a property of hyparquet's behaviour and this is a property of hypgrep's
      // imports. The remedy is the one the resolved half already names for an
      // above-pin declaration - move the ROOT pin up - and not dropping the
      // entry, which nests a second copy instead.
      if (pinsRoot(entries[name]?.[dep], dep, pins) &&
          isValidRange(declared[dep]) &&
          !matchesSemverRange(pins[dep] ?? '', declared[dep]) &&
          atOrAboveFloor(declared[dep], pins[dep])) {
        offenders.push(`${name} declares ${dep}@${declared[dep]}, ABOVE the root pin ` +
          `${pins[dep]}, and its overrides entry forces that older pin on it anyway: ` +
          'move the ROOT pin up')
        continue
      }
      if (atOrAboveFloor(declared[dep], floor)) continue
      // An override is the other way to be safe: it forces the root copy, so a
      // below-floor declaration never resolves.
      if (pinsRoot(entries[name]?.[dep], dep, pins)) continue
      offenders.push(`${name} declares ${dep}@${declared[dep]}, below the ${dep} floor ${floor}, ` +
        `and no overrides entry pins it to ${pins[dep]}`)
    }
  }
  return offenders
}

/**
 * Why a package's own declarations would not all resolve onto the hoisted root
 * copies. Empty when every governed pin dedupes.
 *
 * The question is range satisfaction, not string equality: npm dedupes a
 * declaration onto the hoisted copy whenever the root pin satisfies it, so an
 * ordinary `^1.29.2` beside a 1.29.2 pin nests nothing, and failing on it would
 * report a dedupe failure that is not there and name a remedy (move the root
 * pin) that would not fix it. The matcher is the kernel's own rather than a
 * fresh one written here.
 *
 * `atOrAboveFloor` below is the other predicate in this file and deliberately
 * not this one: the floor asks what a range's *lowest* admitted version is, so
 * `^1.27.1` reads as below a 1.28.2 floor there while deduping onto the root
 * pin here. The two disagree because they ask different questions, and the
 * floor's answer is the conservative one on purpose.
 *
 * @param {string} name the package being judged
 * @param {Record<string, string | null>} declared what it declares
 * @param {Record<string, string> | undefined} overridden the root `overrides` entry for it
 * @param {Record<string, string | undefined>} pins the root pins, by package
 * @returns {string[]}
 */
function dedupeOffenders(name, declared, overridden, pins) {
  const offenders = []
  for (const [dep, pin] of Object.entries(pins)) {
    // A pin read off the manifest as undefined satisfies nothing, so it would
    // read as every declaration being out of range.
    if (pin === undefined) {
      offenders.push(`no root pin for ${dep}, so nothing can be checked against it`)
      continue
    }
    // An override forces the version it names, whatever the declaration says,
    // so it is the override and not the declaration that decides what resolves.
    // One naming the root pin, by value or by npm's `$name` reference, is the
    // whole point; one naming anything else installs the second copy rather
    // than preventing it, and reading past it to the declaration would call
    // that green.
    const override = overridden?.[dep]
    if (override !== undefined) {
      if (pinsRoot(override, dep, pins)) continue
      offenders.push(`${name} has an \`overrides\` entry pinning ${dep}@${override}, not the root ` +
        `pin ${pin}, so npm resolves that copy under ${name} instead of the hoisted one`)
      continue
    }
    // Nothing declared is nothing to nest, which is how the floor check below
    // reads an absent declaration too. Calling it a violation would report a
    // package the dependency has dropped as a dedupe failure.
    const spec = declared[dep]
    if (spec === undefined) continue
    // The shape is judged before the satisfaction, because the matcher answers
    // `true` for a range it was given nothing to judge: an empty or null
    // declaration would otherwise short-circuit as deduped and never reach the
    // branch that says the shape was unreadable.
    if (!isValidRange(spec)) {
      offenders.push(`${name} declares ${dep}@${spec}, a range shape this check cannot ` +
        `judge against the root pin ${pin} - read it before trusting either answer`)
      continue
    }
    if (matchesSemverRange(pin, spec)) continue
    offenders.push(`${name} declares ${dep}@${spec}, which the root pin ${pin} does not ` +
      'satisfy, so npm nests a second copy: if that declaration is ABOVE the root pin, move the ' +
      `ROOT pin up; only one BELOW it wants an \`overrides\` entry naming ${pin}`)
  }
  return offenders
}

/**
 * Everything a package declares that npm may install for it, read from the
 * installed tree. Optional and peer declarations resolve copies just as plain
 * ones do, so a floor check that reads only `dependencies` has a blind spot.
 *
 * @param {string} name
 * @returns {Record<string, string> | undefined} undefined when not installed
 */
function installedDeclarations(name) {
  const pkg = readJson(path.join(NODE_MODULES, name, 'package.json'))
  if (!pkg) return undefined
  return { ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.dependencies }
}

/**
 * Every pinned-package copy npm could not hoist, anywhere in the subtree under
 * `pkgDir`. Depth matters: an override that failed to take can leave the
 * private copy a level below the dependency that pulled it in, where a
 * one-level look never sees it.
 *
 * @param {string} pkgDir
 * @param {Set<string>} [seen] real paths already walked, so the symlink farms
 *   pnpm and `npm link` build cannot send this round a cycle
 * @returns {{ dep: string, version: string, where: string }[]}
 */
function nestedCopies(pkgDir, seen = new Set()) {
  const found = []
  const nodeModules = path.join(pkgDir, 'node_modules')
  const real = realPath(nodeModules)
  if (!real || seen.has(real)) return found
  seen.add(real)
  for (const name of packagesIn(nodeModules)) {
    const dir = path.join(nodeModules, name)
    const version = installedVersion(nodeModules, name)
    if (version && name in FLOORS) {
      found.push({ dep: name, version, where: path.relative(NODE_MODULES, dir) })
    }
    found.push(...nestedCopies(dir, seen))
  }
  return found
}

/**
 * The package directory names directly inside a `node_modules`, with scoped
 * packages expanded to `@scope/name`. Empty when the directory is absent.
 *
 * Symlinks count: under pnpm, and under `npm link` while a dependency is
 * developed locally, every package here is a link to the real tree, and a
 * directories-only walk would find nothing and pass vacuously.
 *
 * @param {string} nodeModules
 * @returns {string[]}
 */
function packagesIn(nodeModules) {
  let entries
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      for (const scoped of packagesIn(path.join(nodeModules, entry.name))) {
        names.push(`${entry.name}/${scoped}`)
      }
      continue
    }
    names.push(entry.name)
  }
  return names
}

/**
 * The version of the package installed at `nodeModules/name`.
 *
 * @param {string} nodeModules
 * @param {string} name
 * @returns {string | undefined} undefined when nothing is installed there
 */
function installedVersion(nodeModules, name) {
  return readJson(path.join(nodeModules, name, 'package.json'))?.version
}

/**
 * The spec npm resolves an `overrides` `$name` reference to, read off the root
 * manifest in npm's own lookup order: devDependencies, then
 * optionalDependencies, then dependencies, then peerDependencies, first match
 * wins. Undefined when the root declares nothing by that name, which is what
 * npm refuses the install over.
 *
 * The chain is truthy rather than nullish because npm's is: it reads each map
 * as `if (pkg.devDependencies?.[ref])`, so a declaration of `""` (npm's "any
 * version") is skipped rather than returned. Reading it as a match would fail
 * the premise assertion above on a manifest npm resolves correctly, and blame a
 * second declaration that is not there.
 *
 * @param {string} name the package a `$name` reference points at
 * @returns {string | undefined}
 */
function referencedSpec(name) {
  return devDependencies[name] || optionalDependencies[name] || dependencies[name] || peerDependencies[name]
}

/**
 * Whether an `overrides` entry holds `dep` at the root pin.
 *
 * npm resolves the `$name` reference form against the root's own declarations,
 * so `"$hyparquet"` is the root pin written by reference: the same version, and
 * one that still names the pin after a bump moves it. The name has to match the
 * package the entry governs, because a reference to a different one resolves to
 * a different pin. It also has to name a package the root still declares: npm
 * throws `Unable to resolve reference $name` otherwise, so reading a reference
 * with no pin behind it as the pin would call an install that cannot run held
 * at the floor.
 *
 * That `$dep` names *this* pin is a premise rather than a reading, because npm
 * resolves the reference through a lookup order (dev, then optional, then
 * plain, then peer) that a second declaration of the same name can win. The
 * root-pin test above holds the manifest to one declaration per governed
 * package, which is what makes the premise true here.
 *
 * @param {string | undefined} entry the version an overrides entry names
 * @param {string} dep the package that entry governs
 * @param {Record<string, string | undefined>} pins the root pins, by package
 * @returns {boolean}
 */
function pinsRoot(entry, dep, pins) {
  if (typeof entry !== 'string') return false
  if (pins[dep] === undefined) return false
  return entry === `$${dep}` || entry === pins[dep]
}

/**
 * Whether `spec` can only resolve at or above `floor`.
 *
 * A range is judged by the lowest version it admits, so `^1.27.1` counts as
 * below a 1.28.2 floor even though npm would dedupe it to the root pin: the
 * remedy the message names (an overrides entry) is correct either way. An
 * upper-bounded or compound range is not judged at all, and reads as below the
 * floor, so an unfamiliar shape gets looked at rather than waved through.
 *
 * @param {string | undefined} spec a version or a simple lower-bounded range
 * @param {string | undefined} floor an exact version
 * @returns {boolean}
 */
function atOrAboveFloor(spec, floor) {
  const low = lowestVersion(spec)
  const bound = lowestVersion(floor)
  if (!low || !bound) return false
  for (let i = 0; i < 3; i++) {
    if (low[i] !== bound[i]) return low[i] > bound[i]
  }
  return true
}

/**
 * The `[major, minor, patch]` of a version, or of the lowest version a simple
 * range admits. Prerelease and build metadata are dropped; nothing in this
 * dependency set ships one.
 *
 * @param {string | undefined} spec
 * @returns {number[] | undefined} undefined when the shape is not a plain
 *   version or a lower-bounded range
 */
function lowestVersion(spec) {
  if (typeof spec !== 'string') return undefined
  if (/[<|\s-]/.test(spec.trim())) return undefined
  const match = /^[\^~>=v]*(\d+)\.(\d+)\.(\d+)$/.exec(spec.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * @param {string} dir
 * @returns {string | undefined} undefined when the path does not exist
 */
function realPath(dir) {
  try {
    return fs.realpathSync(dir)
  } catch {
    return undefined
  }
}

/**
 * @param {string} file
 * @returns {any} undefined when the file is missing
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
