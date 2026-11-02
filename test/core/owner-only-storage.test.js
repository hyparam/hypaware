// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { openDaemonLog } from '../../src/core/daemon/logs.js'
import { bootKernel } from '../../src/core/runtime/boot.js'
import { secureOwnerRoot, secureStorageRoots } from '../../src/core/runtime/owner_only.js'
import { cacheRootOf, createPluginPaths, stateRootOf } from '../../src/core/runtime/paths.js'
import { withLogRecords } from '../helpers/log_records.js'

/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */

const posixOnly = { skip: process.platform === 'win32' && 'no POSIX mode bits on win32' }

/** @type {ColumnSpec[]} */
const COLUMNS = [{ name: 'id', type: 'STRING', nullable: true }, { name: 'content_text', type: 'STRING', nullable: true }]

/** @param {string} p */
async function modeOf(p) {
  return (await fs.lstat(p)).mode & 0o777
}

/** @param {any} t @param {string} prefix */
async function tempBase(t, prefix) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-owner-only-${prefix}-`))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  return base
}

/**
 * Every directory and file under `root`, with its mode.
 * @param {string} root
 * @returns {Promise<Array<{ rel: string, dir: boolean, mode: number }>>}
 */
async function walk(root) {
  /** @type {Array<{ rel: string, dir: boolean, mode: number }>} */
  const out = []
  for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name)
    out.push({ rel: path.relative(root, full), dir: entry.isDirectory(), mode: await modeOf(full) })
  }
  return out
}

/**
 * @template T
 * @param {number} mask
 * @param {() => Promise<T>} fn
 */
async function withUmask(mask, fn) {
  const previous = process.umask(mask)
  try {
    return await fn()
  } finally {
    process.umask(previous)
  }
}

/** @param {ReturnType<typeof createQueryStorageService>} storage @param {string} id */
async function appendAndFlush(storage, id) {
  const table = storage.cacheTablePath('messages', ['source=synthetic'])
  await storage.appendRows(table, COLUMNS, [{ id, content_text: `synthetic ${id}` }])
  await storage.flushAll({ force: true })
  return table
}

// Recorded content: the spool, the committed data and metadata. The
// bookkeeping JSON beside them (flush stamps, cursors, the ingest counter)
// holds no content and sits inside an owner-only directory.
const CONTENT_FILE = /(active\.jsonl|flush-.*\.jsonl|\.parquet|\.avro|metadata\.json)$/

for (const mask of [0o022, 0o077, 0o000]) {
  // @ref LLP 0569#new-files [tests]: new storage is owner-only whatever the umask
  test(`a fresh cache is created owner-only under umask ${mask.toString(8).padStart(3, '0')}`, posixOnly, async t => {
    const base = await tempBase(t, `fresh-${mask}`)
    const cacheRoot = cacheRootOf(stateRootOf(path.join(base, '.hyp')))
    await withUmask(mask, async () => {
      const storage = createQueryStorageService({ cacheRoot })
      const table = await appendAndFlush(storage, 'fresh')
      // A second append leaves an active spool file to check as well.
      await storage.appendRows(table, COLUMNS, [{ id: 'waiting', content_text: 'synthetic waiting' }])
    })
    const entries = await walk(path.join(base, '.hyp'))
    assert.ok(entries.some(e => e.rel.endsWith('active.jsonl')), 'an active spool file exists')
    assert.ok(entries.some(e => e.rel.endsWith('.parquet')), 'a committed data file exists')
    for (const e of entries) {
      if (e.dir) assert.equal(e.mode, 0o700, e.rel)
      else if (CONTENT_FILE.test(e.rel)) assert.equal(e.mode, 0o600, e.rel)
    }
    assert.equal(await modeOf(path.join(base, '.hyp')), 0o700)
  })
}

// @ref LLP 0569#roots [tests]: an existing install is tightened at its roots and on the active spool file, nothing walked
test('an existing 0755/0644 install is tightened at its roots and its active spool, across a restart', posixOnly, async t => {
  const base = await tempBase(t, 'existing')
  const hypHome = path.join(base, '.hyp')
  const stateRoot = stateRootOf(hypHome)
  const cacheRoot = cacheRootOf(stateRoot)
  // What an earlier version left: everything world-readable.
  const table = await withUmask(0o022, async () => {
    const storage = createQueryStorageService({ cacheRoot })
    const table = await appendAndFlush(storage, 'old')
    await storage.appendRows(table, COLUMNS, [{ id: 'old-waiting', content_text: 'synthetic old waiting' }])
    return table
  })
  const active = path.join(table, '_hypaware_spool', 'active.jsonl')
  for (const dir of [hypHome, stateRoot, cacheRoot]) await fs.chmod(dir, 0o755)
  await fs.chmod(active, 0o644)
  const parquet = (await walk(cacheRoot)).find(e => e.rel.endsWith('.parquet'))
  assert.ok(parquet)
  await fs.chmod(path.join(cacheRoot, parquet.rel), 0o644)

  // Restart: a new process boots, then a new storage service appends.
  const outcomes = await secureStorageRoots({ hypHome, stateRoot, cacheRoot })
  assert.deepEqual(outcomes, { hyp_home: 'secured', state_root: 'secured' })
  assert.equal(await modeOf(hypHome), 0o700)
  assert.equal(await modeOf(stateRoot), 0o700)
  // The default cache is contained by the state root, so it is not a root of its own.
  assert.equal(await modeOf(cacheRoot), 0o755)
  // No recursion: an old committed file keeps its mode, behind the 0700 root.
  assert.equal(await modeOf(path.join(cacheRoot, parquet.rel)), 0o644)

  const storage = createQueryStorageService({ cacheRoot })
  await withUmask(0o022, () => storage.appendRows(table, COLUMNS, [{ id: 'new', content_text: 'synthetic new' }]))
  assert.equal(await modeOf(active), 0o600, 'the existing active spool file is repaired on its first open')
  await withUmask(0o022, () => storage.flushAll({ force: true }))
  const rows = await Array.fromAsync(storage.readSpooledRows('messages'))
  assert.equal(rows.length, 0, 'the old waiting rows and the new one were committed')
  const committed = []
  for (const part of await storage.discoverCachePartitions()) for await (const row of storage.readRows(part.path)) committed.push(row.id)
  assert.deepEqual(committed.sort(), ['new', 'old', 'old-waiting'])
  for (const e of await walk(cacheRoot)) {
    if (e.rel === parquet.rel) continue
    if (CONTENT_FILE.test(e.rel) && !e.dir) assert.equal(e.mode, 0o600, e.rel)
  }

  // Once per process: a second boot in the same process does nothing more.
  await fs.chmod(hypHome, 0o755)
  assert.deepEqual(await secureStorageRoots({ hypHome, stateRoot, cacheRoot }), {})
  assert.equal(await modeOf(hypHome), 0o755)
})

test('a custom HYP_HOME is tightened only when it holds nothing but HypAware entries', posixOnly, async t => {
  const base = await tempBase(t, 'custom')
  const dedicated = path.join(base, 'hyp-data')
  await fs.mkdir(path.join(dedicated, 'hypaware'), { recursive: true, mode: 0o755 })
  await fs.writeFile(path.join(dedicated, 'hypaware-config.json'), '{}')
  await fs.mkdir(path.join(dedicated, 'spool'), { mode: 0o755 })
  await fs.chmod(dedicated, 0o755)
  await fs.chmod(stateRootOf(dedicated), 0o755)
  const out = await secureStorageRoots({ hypHome: dedicated, stateRoot: stateRootOf(dedicated), cacheRoot: cacheRootOf(stateRootOf(dedicated)) })
  assert.deepEqual(out, { hyp_home: 'secured', state_root: 'secured' })
  assert.equal(await modeOf(dedicated), 0o700)

  // A shared location: left exactly as found, one warning, the state root still tightened.
  const shared = path.join(base, 'shared')
  await fs.mkdir(path.join(shared, 'hypaware'), { recursive: true, mode: 0o755 })
  await fs.writeFile(path.join(shared, 'notes.txt'), 'not ours')
  await fs.chmod(shared, 0o755)
  await fs.chmod(stateRootOf(shared), 0o755)
  const { result, records } = await withLogRecords(() => secureStorageRoots({ hypHome: shared, stateRoot: stateRootOf(shared), cacheRoot: cacheRootOf(stateRootOf(shared)) }))
  assert.deepEqual(result, { hyp_home: 'not_dedicated', state_root: 'secured' })
  assert.equal(await modeOf(shared), 0o755)
  assert.equal(await modeOf(stateRootOf(shared)), 0o700)
  const warnings = records.filter(r => r.body === 'storage.root_not_secured')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].attributes.error_kind, 'not_dedicated')
  assert.equal(warnings[0].attributes.hyp_root, 'hyp_home')
})

test('a separate cache root is tightened after a real flush, and left alone when shared', posixOnly, async t => {
  const base = await tempBase(t, 'separate')
  const hypHome = path.join(base, '.hyp')
  const cacheRoot = path.join(base, 'big-disk', 'hyp-cache')
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o755 })
  await withUmask(0o022, () => appendAndFlush(createQueryStorageService({ cacheRoot }), 'separate'))
  await fs.chmod(cacheRoot, 0o755)
  const out = await secureStorageRoots({ hypHome, stateRoot: stateRootOf(hypHome), cacheRoot })
  assert.equal(out.cache_root, 'secured', 'what a flush writes counts as the cache\'s own')
  assert.equal(out.hyp_home, 'missing', 'nothing is created')
  await assert.rejects(fs.stat(hypHome), { code: 'ENOENT' })
  assert.equal(await modeOf(cacheRoot), 0o700)

  const sharedCache = path.join(base, 'big-disk')
  await fs.chmod(sharedCache, 0o755)
  const again = await secureStorageRoots({ hypHome: path.join(base, 'other', '.hyp'), stateRoot: stateRootOf(path.join(base, 'other', '.hyp')), cacheRoot: sharedCache })
  assert.equal(again.cache_root, 'not_dedicated')
  assert.equal(await modeOf(sharedCache), 0o755)
})

// @ref LLP 0569#verified-root [tests]: ancestors may be links; a linked root is tightened at its target
test('ancestor symlinks are permitted and a symlinked root is tightened at its target', posixOnly, async t => {
  const base = await tempBase(t, 'links')
  await fs.mkdir(path.join(base, 'real', '.hyp'), { recursive: true, mode: 0o755 })
  await fs.chmod(path.join(base, 'real', '.hyp'), 0o755)
  await fs.symlink(path.join(base, 'real'), path.join(base, 'via'))
  assert.equal(await secureOwnerRoot(path.join(base, 'via', '.hyp')), 'secured')
  assert.equal(await modeOf(path.join(base, 'real', '.hyp')), 0o700)

  await fs.mkdir(path.join(base, 'target'), { mode: 0o755 })
  await fs.chmod(path.join(base, 'target'), 0o755)
  await fs.symlink(path.join(base, 'target'), path.join(base, 'linked-root'))
  assert.equal(await secureOwnerRoot(path.join(base, 'linked-root')), 'secured')
  assert.equal(await modeOf(path.join(base, 'target')), 0o700)
  assert.ok((await fs.lstat(path.join(base, 'linked-root'))).isSymbolicLink())
})

test('a root swapped for a link after it was resolved is not followed', posixOnly, async t => {
  const base = await tempBase(t, 'swap-link')
  const root = path.join(base, '.hyp')
  const victim = path.join(base, 'victim')
  await fs.mkdir(root, { mode: 0o755 })
  await fs.mkdir(victim, { mode: 0o755 })
  await fs.chmod(root, 0o755)
  await fs.chmod(victim, 0o755)
  const realRealpath = fs.realpath
  // @ts-expect-error - a test double for the resolve step
  fs.realpath = async (/** @type {string} */ p) => {
    const resolved = await realRealpath(p)
    await fs.rename(root, path.join(base, 'moved'))
    await fs.symlink(victim, root)
    return resolved
  }
  try {
    assert.equal(await secureOwnerRoot(root), 'replaced')
  } finally {
    fs.realpath = realRealpath
  }
  assert.equal(await modeOf(victim), 0o755)
  assert.equal(await modeOf(path.join(base, 'moved')), 0o755)
})

test('a root replaced between its listing and the chmod is left alone', posixOnly, async t => {
  const base = await tempBase(t, 'swap-dir')
  const root = path.join(base, 'hyp-data')
  await fs.mkdir(path.join(root, 'hypaware'), { recursive: true, mode: 0o755 })
  await fs.chmod(root, 0o755)
  const realReaddir = fs.readdir
  fs.readdir = async (/** @type {any[]} */ ...args) => {
    // @ts-expect-error - forwarded verbatim
    const names = await realReaddir(...args)
    await fs.rename(root, path.join(base, 'moved'))
    await fs.mkdir(root, { mode: 0o755 })
    await fs.chmod(root, 0o755)
    return names
  }
  try {
    assert.equal(await secureOwnerRoot(root, { knownEntries: name => name === 'hypaware' }), 'replaced')
  } finally {
    fs.readdir = realReaddir
  }
  assert.equal(await modeOf(root), 0o755)
  assert.equal(await modeOf(path.join(base, 'moved')), 0o755)
})

test('a root owned by another user is left alone with a warning', posixOnly, async t => {
  const base = await tempBase(t, 'foreign')
  const hypHome = path.join(base, '.hyp')
  await fs.mkdir(hypHome, { mode: 0o755 })
  await fs.chmod(hypHome, 0o755)
  const realGetuid = process.getuid
  const uid = realGetuid?.call(process) ?? 0
  process.getuid = () => uid + 1
  try {
    const { result, records } = await withLogRecords(() => secureStorageRoots({ hypHome, stateRoot: stateRootOf(hypHome), cacheRoot: cacheRootOf(stateRootOf(hypHome)) }))
    assert.deepEqual(result, { hyp_home: 'foreign_owner', state_root: 'missing' })
    assert.deepEqual(records.filter(r => r.body === 'storage.root_not_secured').map(r => r.attributes.error_kind), ['foreign_owner'])
  } finally {
    process.getuid = realGetuid
  }
  assert.equal(await modeOf(hypHome), 0o755)
})

test('a root that is a file, or already owner-only, is not changed', posixOnly, async t => {
  const base = await tempBase(t, 'shapes')
  await fs.writeFile(path.join(base, 'file'), '')
  assert.equal(await secureOwnerRoot(path.join(base, 'file')), 'not_directory')
  await fs.mkdir(path.join(base, 'tight'), { mode: 0o700 })
  assert.equal(await secureOwnerRoot(path.join(base, 'tight'), { knownEntries: () => false }), 'unchanged')
  assert.equal(await secureOwnerRoot(path.join(base, 'absent')), 'missing')
})

test('win32 is documented, not protected', async t => {
  const base = await tempBase(t, 'win32')
  const real = Object.getOwnPropertyDescriptor(process, 'platform')
  assert.ok(real)
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' })
  try {
    assert.equal(await secureOwnerRoot(base), 'unsupported')
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
})

test('bootKernel tightens the roots, and a preview boot leaves them as found', posixOnly, async t => {
  const base = await tempBase(t, 'boot')
  const workspaceDir = path.join(base, 'no-bundled')
  for (const name of ['live', 'preview']) {
    const hypHome = path.join(base, name, '.hyp')
    await fs.mkdir(stateRootOf(hypHome), { recursive: true, mode: 0o755 })
    await fs.chmod(hypHome, 0o755)
    await fs.chmod(stateRootOf(hypHome), 0o755)
    await bootKernel({ hypHome, mode: 'smoke', runId: `owner-only-${name}`, env: { ...process.env, HYP_HOME: hypHome }, workspaceDir, preview: name === 'preview' })
    const expected = name === 'preview' ? 0o755 : 0o700
    assert.equal(await modeOf(hypHome), expected, name)
    assert.equal(await modeOf(stateRootOf(hypHome)), expected, name)
  }
})

test('plugin dirs and the daemon log are created owner-only', posixOnly, async t => {
  const base = await tempBase(t, 'writers')
  const stateRoot = stateRootOf(path.join(base, '.hyp'))
  await withUmask(0o000, async () => {
    const paths = await createPluginPaths({ pluginName: '@hypaware/synthetic', rootDir: base, stateRoot, runId: 'r1', tmpRoot: path.join(base, 'tmp') })
    assert.equal(await modeOf(paths.stateDir), 0o700)
    assert.equal(await modeOf(paths.cacheDir), 0o700)
    assert.equal(await modeOf(paths.tempDir), 0o700)
    assert.equal(await modeOf(path.join(stateRoot, 'plugins', '@hypaware')), 0o700, 'intermediate dirs too')
    const log = openDaemonLog({ stateRoot, runId: 'r1', mode: 'smoke' })
    log.info('synthetic', {})
    await new Promise(resolve => setTimeout(resolve, 20))
    log.close()
  })
  const logDir = path.join(stateRoot, 'logs')
  assert.equal(await modeOf(logDir), 0o700)
  assert.equal(await modeOf(path.join(logDir, 'daemon.log')), 0o600)
})
