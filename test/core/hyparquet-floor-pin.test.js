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
// behind a root `overrides` entry, so this is the gate on that entry. Both
// halves matter and they check different things: the manifest half pins the
// declaration, the resolved half proves npm actually deduped rather than
// nesting a private copy.
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

test('the root hyparquet pin is exact', () => {
  assert.equal(FLOOR, '1.28.2',
    'LLP 0222 #hyparquet-floor: 1.28.2 is a floor and an exact pin, not a range')
  assert.match(WRITER_PIN ?? '', /^\d+\.\d+\.\d+$/,
    'the hyparquet-writer pin is exact too, so the overrides can name one version')
})

test('hypgrep is a plain dependency, and its writer stays optional', () => {
  // LLP 0264 #dependency: the client both builds and reads indexes, so hypgrep
  // is a root dependency rather than an optional one.
  assert.ok(dependencies.hypgrep,
    'LLP 0264 #dependency: hypgrep belongs in `dependencies`')
  assert.match(dependencies.hypgrep, /^\d+\.\d+\.\d+$/,
    'hypgrep is pinned exactly, in the idiom of every other dependency here')
  // Index writes ride the existing optionalDependency exactly as the cache
  // write path does. Pinning the writer inside an override must not promote it
  // to a hard root dependency: an install with `--omit=optional` still has to
  // boot and read.
  assert.equal(dependencies['hyparquet-writer'], undefined,
    'hyparquet-writer is an optionalDependency; the overrides pin must not promote it')
  assert.ok(optionalDependencies['hyparquet-writer'],
    'hyparquet-writer stays in optionalDependencies')
})

test('every read-path dependency that carries hyparquet is held at the floor', () => {
  // The lint that outlives this change: a future direct dependency shipping its
  // own hyparquet either already agrees with the floor or needs an override,
  // and this names which one it is instead of leaving a second copy to be found
  // by a wrong row count.
  const offenders = []
  for (const name of Object.keys(dependencies)) {
    if (name === 'hyparquet') continue
    const declared = installedDependencies(name)
    if (!declared) continue
    for (const [dep, pin] of [['hyparquet', FLOOR], ['hyparquet-writer', WRITER_PIN]]) {
      if (declared[dep] === undefined) continue
      if (declared[dep] === pin) continue
      if (overrides[name]?.[dep] === pin) continue
      offenders.push(`${name} declares ${dep}@${declared[dep]}, not ${pin}, and no overrides entry pins it`)
    }
  }
  assert.deepEqual(offenders, [], 'LLP 0222 #hyparquet-floor: an unpinned older copy ' +
    `resolves beside the floor and answers relational bounds wrong:\n  ${offenders.join('\n  ')}`)
})

test('the read path resolves the one root hyparquet, not a nested copy', () => {
  // `npm ls hyparquet` in assertion form, and the half a manifest read cannot
  // give you: an override with the wrong shape (nested under the wrong key, or
  // naming a version no longer at the root) still parses as valid JSON and
  // still lets npm install a private copy underneath the dependency.
  const rootHyparquet = installedVersion('hyparquet')
  if (!rootHyparquet) {
    // Deps are not installed (a clean checkout, or a docs-only CI job). The
    // manifest half above is the part that runs everywhere.
    return
  }
  assert.equal(rootHyparquet, FLOOR, 'the hoisted hyparquet is the pinned one')

  const nested = []
  for (const name of Object.keys(dependencies)) {
    for (const dep of ['hyparquet', 'hyparquet-writer']) {
      const version = installedVersion(dep, name)
      if (version) nested.push(`${name} resolved a private ${dep}@${version}`)
    }
  }
  assert.deepEqual(nested, [], 'LLP 0222 #hyparquet-floor: the overrides exist so ' +
    `these dedupe to the root copy:\n  ${nested.join('\n  ')}`)
})

/**
 * The dependency block a package declares, read from the installed tree.
 *
 * @param {string} name
 * @returns {Record<string, string> | undefined} undefined when not installed
 */
function installedDependencies(name) {
  const pkg = readJson(path.join(REPO_ROOT, 'node_modules', name, 'package.json'))
  return pkg ? pkg.dependencies ?? {} : undefined
}

/**
 * The version of `name` as resolved, optionally inside `parent`'s own
 * `node_modules` (which is where npm puts a copy it could not hoist).
 *
 * @param {string} name
 * @param {string} [parent]
 * @returns {string | undefined} undefined when nothing is installed there
 */
function installedVersion(name, parent) {
  const base = parent
    ? path.join(REPO_ROOT, 'node_modules', parent, 'node_modules')
    : path.join(REPO_ROOT, 'node_modules')
  return readJson(path.join(base, name, 'package.json'))?.version
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
