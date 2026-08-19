// @ts-check

// LLP 0222 settled one WHERE-to-parquet-filter converter, icebird's, and its
// #hyparquet-floor makes hyparquet 1.28.2 an *exact* floor rather than a
// minimum: icebird pushes bare relational bounds, which only answer correctly
// because 1.28.2's `matchFilter` rejects null cells in `$lt`/`$lte`/`$gt`/
// `$gte`. A second, older hyparquet resolved anywhere on the query read path
// silently reintroduces the leak the floor removed, and it fails as wrong rows
// rather than as an error.
//
// `hypgrep` (LLP 0264 #dependency) is the first read-path dependency that
// declares a hyparquet *below* the floor: 0.5.1 pins 1.27.1. It is adopted
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
// Scope is the root `dependencies`, which is the query read path: the kernel
// reads parquet through icebird and (from LLP 0264) hypgrep. The
// optionalDependencies are write-side and vector-side (`hyparquet-writer`,
// `hypvector`); each carries its own nested hyparquet today, neither runs
// icebird's converter, and neither is this task's business.
//
// @ref LLP 0222#hyparquet-floor [tests]: an exact floor is only exact if nothing else resolves a copy beside it
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

// The floor is read from the root pin rather than written twice: a bump of the
// root pin should move every override with it, and the assertions below are
// what make that true.
const FLOOR = dependencies.hyparquet
const WRITER_PIN = optionalDependencies['hyparquet-writer']

/** The two packages the floor governs, and the version each is held at. */
const PINNED = { hyparquet: FLOOR, 'hyparquet-writer': WRITER_PIN }

/** Whether the resolved half has a tree to read. */
const INSTALLED = readJson(path.join(NODE_MODULES, 'hyparquet', 'package.json')) !== undefined

test('the root hyparquet pin is exact', () => {
  assert.equal(FLOOR, '1.28.2',
    'LLP 0222 #hyparquet-floor: 1.28.2 is a floor and an exact pin, not a range')
  assert.match(WRITER_PIN ?? '', /^\d+\.\d+\.\d+$/,
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
  // where the resolved half below can run.
  assert.equal(overrides.hypgrep?.hyparquet, FLOOR,
    'LLP 0222 #hyparquet-floor: the hypgrep override holds hyparquet at the root pin')
  assert.equal(overrides.hypgrep?.['hyparquet-writer'], WRITER_PIN,
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
  // own hyparquet either already agrees with the floor or needs an override,
  // and this names which one it is instead of leaving a second copy to be found
  // by a wrong row count.
  const offenders = []
  for (const name of Object.keys(dependencies)) {
    if (name === 'hyparquet') continue
    const declared = installedDeclarations(name)
    if (!declared) continue
    for (const [dep, pin] of Object.entries(PINNED)) {
      if (declared[dep] === undefined) continue
      if (declared[dep] === pin) continue
      if (overrides[name]?.[dep] === pin) continue
      offenders.push(`${name} declares ${dep}@${declared[dep]}, not ${pin}, and no overrides entry pins it`)
    }
  }
  assert.deepEqual(offenders, [], 'LLP 0222 #hyparquet-floor: an unpinned older copy ' +
    `resolves beside the floor and answers relational bounds wrong:\n  ${offenders.join('\n  ')}`)
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
  assert.equal(installedVersion(NODE_MODULES, 'hyparquet'), FLOOR,
    'the hoisted hyparquet is the pinned one')

  const nested = []
  for (const name of Object.keys(dependencies)) {
    for (const copy of nestedCopies(path.join(NODE_MODULES, name))) {
      // A copy npm left in place at the pinned version is a duplicate file
      // tree, not a floor violation, and failing on it would report a version
      // skew that is not there. Only an off-pin copy changes an answer.
      if (copy.version === PINNED[copy.dep]) continue
      nested.push(`${copy.where} is ${copy.dep}@${copy.version}, not ${PINNED[copy.dep]}`)
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
 * @returns {{ dep: string, version: string, where: string }[]}
 */
function nestedCopies(pkgDir) {
  const found = []
  const nodeModules = path.join(pkgDir, 'node_modules')
  for (const name of packagesIn(nodeModules)) {
    const dir = path.join(nodeModules, name)
    const version = installedVersion(nodeModules, name)
    if (version && name in PINNED) {
      found.push({ dep: name, version, where: path.relative(NODE_MODULES, dir) })
    }
    found.push(...nestedCopies(dir))
  }
  return found
}

/**
 * The package directory names directly inside a `node_modules`, with scoped
 * packages expanded to `@scope/name`. Empty when the directory is absent.
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
    if (!entry.isDirectory() || entry.name === '.bin') continue
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
