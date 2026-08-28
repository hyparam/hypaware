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
// `hypgrep` (LLP 0264 #dependency) is the first read-path dependency that
// declares a hyparquet below the floor: 0.5.1 pins 1.27.1. It is adopted
// behind a root `overrides` entry, so this is the gate on that entry. Two kinds
// of check live here and they prove different things:
//
//   - The manifest half (the first two tests) reads only the checked-in root
//     `package.json`, so it runs on any checkout: the root pins are exact, and
//     the override that holds hypgrep to them exists and names those versions.
//     Deleting the override reddens here with nothing installed.
//   - The resolved half (the last two tests) reads the installed tree, which is
//     the only place a *dependency's own* declaration and npm's actual
//     placement can be seen. It has no answer without `node_modules`, so it
//     skips there rather than passing silently.
//
// What neither half reaches: npm honours `overrides` only for the root
// project, so the entry governs this checkout and any install that treats
// hypaware as the root, and is ignored when hypaware is itself installed as a
// dependency (`npm i -g hypaware`, `npx hypaware`), where hypgrep still gets
// its own 1.27.1. Widening the range upstream in hypgrep, which LLP 0264
// #dependency already names as the durable fix, is what closes that; a check
// on it would have to pack and install this package, which is not a job for
// the traditional suite.
//
// Scope is the root `dependencies`, which is the query read path: the kernel
// reads parquet through icebird and (from LLP 0264) hypgrep. The
// optionalDependencies are write-side and vector-side (`hyparquet-writer`,
// `hypvector`); each carries its own nested hyparquet today, neither runs
// icebird's converter, and neither is this task's business.
//
// @ref LLP 0222#hyparquet-floor [tests]: a floor only holds if nothing below it resolves beside the pin, and the deduping the same section claims is a separate property that has to be held separately
// @ref LLP 0264#dependency [tests]: hypgrep enters as a plain root dependency, held to the floor by an override

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules')

const manifest = readJson(path.join(REPO_ROOT, 'package.json'))
if (!manifest) throw new Error('root package.json is unreadable')

const dependencies = manifest.dependencies ?? {}
const optionalDependencies = manifest.optionalDependencies ?? {}
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
})

test('hypgrep is a plain dependency, held at the floor by an override', () => {
  // LLP 0264 #dependency: the client both builds and reads indexes, so hypgrep
  // is a root dependency rather than an optional one.
  assert.ok(dependencies.hypgrep,
    'LLP 0264 #dependency: hypgrep belongs in `dependencies`')
  assert.match(dependencies.hypgrep, /^\d+\.\d+\.\d+$/,
    'hypgrep is pinned exactly, in the idiom of every other dependency here')
  // The override is the whole of the adoption: hypgrep 0.5.1 declares hyparquet
  // 1.27.1, so without this entry npm resolves that older copy privately under
  // `node_modules/hypgrep`. Asserted straight off the manifest so a dropped or
  // misspelled entry reddens on a checkout with nothing installed, not only
  // where the resolved half below can run. It names the root pin rather than
  // the floor so the copy it forces is the one already hoisted, not a second
  // correct one.
  assert.equal(overrides.hypgrep?.hyparquet, ROOT_PINS.hyparquet,
    'LLP 0222 #hyparquet-floor: the hypgrep override holds hyparquet at the root pin')
  assert.equal(overrides.hypgrep?.['hyparquet-writer'], ROOT_PINS['hyparquet-writer'],
    'the hypgrep override holds hyparquet-writer at the root pin')
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
// The override that holds it is cheaper than it looks. icebird declares an
// exact hyparquet, so the override moves it between two adjacent patch
// releases and nothing else; hyparquet 1.29.1 -> 1.29.2 changed package.json
// alone (it added `default` export conditions), with no `src/` delta. The
// remedy when this goes red is therefore directional: if a dependency declares
// a hyparquet ABOVE the root pin, move the ROOT pin up. Holding a dependency
// down onto an older reader to win a dedupe would trade the property that
// matters for the one that does not.
test('icebird is held at the root hyparquet pin, not left to nest its own', () => {
  assert.ok(dependencies.icebird, 'icebird is the read path; it belongs in `dependencies`')
  assert.equal(overrides.icebird?.hyparquet, ROOT_PINS.hyparquet,
    'LLP 0222 #hyparquet-floor: the icebird override holds hyparquet at the root pin, ' +
    'which is what makes "a single deduped copy shared with icebird" true')
  assert.equal(overrides.icebird?.['hyparquet-writer'], ROOT_PINS['hyparquet-writer'],
    'the icebird override holds hyparquet-writer at the root pin')
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
  const offenders = []
  for (const [dep, floor] of Object.entries(FLOORS)) {
    // A pin read off the manifest as undefined would make every comparison below
    // vacuous, so it is reported once here rather than skipped per dependency.
    if (floor === undefined) offenders.push(`no root pin for ${dep}, so nothing can be checked against its floor`)
  }
  for (const name of Object.keys(dependencies)) {
    if (name === 'hyparquet') continue
    const declared = installedDeclarations(name)
    if (!declared) {
      // Only for a dependency an override governs: that entry is the whole of
      // its adoption, and an absent package means the one check that could
      // have proved the entry took never ran.
      if (overrides[name]) {
        offenders.push(`${name} has an overrides entry but is not installed, so nothing verified it - run \`npm i\``)
      }
      continue
    }
    for (const [dep, floor] of Object.entries(FLOORS)) {
      if (floor === undefined) continue
      if (declared[dep] === undefined) continue
      if (atOrAboveFloor(declared[dep], floor)) continue
      // An override is the other way to be safe: it forces the root copy, so a
      // below-floor declaration never resolves.
      if (overrides[name]?.[dep] === ROOT_PINS[dep]) continue
      offenders.push(`${name} declares ${dep}@${declared[dep]}, below the ${dep} floor ${floor}, ` +
        `and no overrides entry pins it to ${ROOT_PINS[dep]}`)
    }
  }
  assert.deepEqual(offenders, [], 'LLP 0222 #hyparquet-floor: an older copy resolving ' +
    `beside the floor answers relational bounds wrong:\n  ${offenders.join('\n  ')}`)
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
