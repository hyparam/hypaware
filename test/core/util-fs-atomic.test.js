// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ConcurrentEditError,
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJson,
  atomicWriteJsonSync,
  readFileIfExists,
  readFileIfExistsSync,
  readJsonIfExists,
  readJsonIfExistsSync,
} from '../../src/core/util/fs_atomic.js'

/** @import { TestContext } from 'node:test' */

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-fs-atomic-'))
}

test('atomicWriteFile writes content and creates parent directories', async () => {
  const dir = await makeTmpDir()
  try {
    const target = path.join(dir, 'a', 'b', 'out.txt')
    await atomicWriteFile(target, 'hello')
    assert.equal(await fs.readFile(target, 'utf8'), 'hello')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('atomicWriteFile leaves no temp file behind on success or failure', async () => {
  const dir = await makeTmpDir()
  try {
    const target = path.join(dir, 'out.txt')
    await atomicWriteFile(target, 'ok')
    assert.deepEqual(await fs.readdir(dir), ['out.txt'])

    // Force the rename to fail by making the target an occupied directory.
    const asDir = path.join(dir, 'occupied')
    await fs.mkdir(path.join(asDir, 'child'), { recursive: true })
    await assert.rejects(atomicWriteFile(asDir, 'nope'))
    const entries = await fs.readdir(dir)
    assert.ok(!entries.some((e) => e.endsWith('.tmp')), `temp file leaked: ${entries}`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('atomicWriteFile applies the requested file mode', { skip: process.platform === 'win32' && 'no POSIX mode bits on win32' }, async () => {
  const dir = await makeTmpDir()
  try {
    const target = path.join(dir, 'secret.json')
    await atomicWriteFile(target, '{}', { mode: 0o600 })
    const stat = await fs.stat(target)
    assert.equal(stat.mode & 0o777, 0o600)

    const synced = path.join(dir, 'synced.json')
    await atomicWriteFile(synced, '{}', { mode: 0o600, fsync: true })
    assert.equal((await fs.stat(synced)).mode & 0o777, 0o600)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('every atomic write path sets the requested mode exactly under a restrictive umask (#2594)', { skip: process.platform === 'win32' && 'no POSIX mode bits on win32' }, async () => {
  const dir = await makeTmpDir()
  const previous = process.umask(0o077)
  try {
    /** @type {Array<[string, (target: string, mode: number) => unknown]>} */
    const writers = [
      ['atomicWriteFile', (target, mode) => atomicWriteFile(target, '{}', { mode })],
      ['atomicWriteFile fsync', (target, mode) => atomicWriteFile(target, '{}', { mode, fsync: true })],
      ['atomicWriteFileSync', (target, mode) => atomicWriteFileSync(target, '{}', { mode })],
      ['atomicWriteJson', (target, mode) => atomicWriteJson(target, {}, { mode })],
      ['atomicWriteJsonSync', (target, mode) => atomicWriteJsonSync(target, {}, { mode })],
    ]
    for (const [name, write] of writers) {
      for (const mode of [0o600, 0o640, 0o644]) {
        const target = path.join(dir, `${name.replace(' ', '-')}-${mode.toString(8)}.json`)
        // A rewrite of a file whose mode differs, as the Ollama setup does.
        await fs.writeFile(target, 'old', { mode: 0o600 })
        await write(target, mode)
        assert.equal((await fs.stat(target)).mode & 0o777, mode, `${name} ${mode.toString(8)}`)
      }
    }
  } finally {
    process.umask(previous)
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('atomicWriteFile enforces expectedMtimeMs (CONCURRENT_EDIT)', async () => {
  const dir = await makeTmpDir()
  try {
    const target = path.join(dir, 'settings.json')
    await fs.writeFile(target, 'v1')
    const { mtimeMs } = await fs.stat(target)

    // Matching mtime: write goes through.
    await atomicWriteFile(target, 'v2', { expectedMtimeMs: mtimeMs })
    assert.equal(await fs.readFile(target, 'utf8'), 'v2')

    // Stale mtime: rejected, file untouched. Force a guaranteed-distinct
    // on-disk mtime instead of relying on the write above having landed in
    // a later filesystem mtime tick: on a fast runner both writes can share
    // one tick, leaving the mtime unchanged so the guard never fires (#272).
    const bumped = new Date(mtimeMs + 1000)
    await fs.utimes(target, bumped, bumped)
    await assert.rejects(
      atomicWriteFile(target, 'v3', { expectedMtimeMs: mtimeMs }),
      (err) => err instanceof ConcurrentEditError && err.code === 'CONCURRENT_EDIT'
    )
    assert.equal(await fs.readFile(target, 'utf8'), 'v2')

    // Missing target: also a concurrent edit.
    await assert.rejects(
      atomicWriteFile(path.join(dir, 'gone.json'), 'v', { expectedMtimeMs: 1 }),
      (err) => err instanceof ConcurrentEditError
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('atomicWriteFileSync writes atomically and cleans up on failure', async () => {
  const dir = await makeTmpDir()
  try {
    const target = path.join(dir, 'nested', 'out.txt')
    atomicWriteFileSync(target, 'sync', { mode: 0o644 })
    assert.equal(fsSync.readFileSync(target, 'utf8'), 'sync')

    const asDir = path.join(dir, 'occupied')
    fsSync.mkdirSync(path.join(asDir, 'child'), { recursive: true })
    assert.throws(() => atomicWriteFileSync(asDir, 'nope'))
    const entries = fsSync.readdirSync(dir)
    assert.ok(!entries.some((e) => e.endsWith('.tmp')), `temp file leaked: ${entries}`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('atomicWriteJson round-trips through readJsonIfExists', async () => {
  const dir = await makeTmpDir()
  try {
    const target = path.join(dir, 'state.json')
    await atomicWriteJson(target, { a: 1 })
    assert.ok((await fs.readFile(target, 'utf8')).endsWith('\n'))
    assert.deepEqual(await readJsonIfExists(target), { a: 1 })

    atomicWriteJsonSync(target, { b: 2 })
    assert.deepEqual(readJsonIfExistsSync(target), { b: 2 })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('readFileIfExists/readJsonIfExists return null only for ENOENT', async () => {
  const dir = await makeTmpDir()
  try {
    const missing = path.join(dir, 'missing.json')
    assert.equal(await readFileIfExists(missing), null)
    assert.equal(readFileIfExistsSync(missing), null)
    assert.equal(await readJsonIfExists(missing), null)
    assert.equal(readJsonIfExistsSync(missing), null)

    // Corrupt JSON propagates instead of masquerading as missing.
    const corrupt = path.join(dir, 'corrupt.json')
    await fs.writeFile(corrupt, '{nope')
    await assert.rejects(readJsonIfExists(corrupt), SyntaxError)
    assert.throws(() => readJsonIfExistsSync(corrupt), SyntaxError)

    // A non-ENOENT error (path through a file) propagates.
    const file = path.join(dir, 'plain.txt')
    await fs.writeFile(file, 'x')
    // win32 reports a path through a file as ENOENT, not ENOTDIR, so this
    // scenario cannot probe the non-ENOENT contract there.
    if (process.platform !== 'win32') await assert.rejects(readFileIfExists(path.join(file, 'child')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// @ref LLP 0417#cache-reclamation [tests]: admission rejects failed directory durability
test('durable publication syncs file before rename and the immediate parent directory afterward, and a failing parent sync propagates', async t => {
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'new', 'nested', 'journal.json')
  const events = []
  let failDirectory = true
  const io = { ...fs,
    async rename(from, to) {
      events.push('rename')
      return fs.rename(from, to)
    },
    async open(file, flags, mode) {
      const handle = await fs.open(file, flags, mode)
      return {
        writeFile: (data, encoding) => handle.writeFile(data, encoding),
        async sync() {
          events.push(flags === 'w' ? 'file-sync' : `dir-sync:${file}`)
          if (flags === 'r' && failDirectory) throw new Error('injected directory sync failure')
          await handle.sync()
        },
        async close() { await handle.close() },
      }
    },
  }
  const options = { fsync: true, fs: /** @type {typeof fs} */ (io) }
  if (process.platform === 'win32') {
    // Windows has no directory fsync, so the parent sync is skipped there:
    // the injected failure never fires and the file sync still happens.
    await atomicWriteJson(target, { admitted: true }, options)
    assert.deepEqual(events, ['file-sync', 'rename'])
    return
  }
  await assert.rejects(atomicWriteJson(target, { admitted: true }, options), /directory sync failure/)
  assert.deepEqual(events, ['file-sync', 'rename', `dir-sync:${path.dirname(target)}`])
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['journal.json'])
  failDirectory = false
  events.length = 0
  await atomicWriteJson(target, { admitted: true }, options)
  // Exactly one directory sync, of the immediate parent only, not every ancestor.
  assert.deepEqual(events, ['file-sync', 'rename', `dir-sync:${path.dirname(target)}`])
})

/**
 * Report `platform` as `process.platform` for the rest of the test.
 *
 * @param {TestContext} t
 * @param {NodeJS.Platform} platform
 */
function forcePlatform(t, platform) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')
  assert.ok(real)
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  t.after(() => Object.defineProperty(process, 'platform', real))
}

/**
 * A rename that throws `code` for its first `failures` calls, then renames.
 *
 * @param {string} code
 * @param {number} failures
 * @param {(from: string, to: string) => unknown} rename
 */
function flakyRename(code, failures, rename) {
  const calls = { count: 0 }
  /** @param {string} from @param {string} to */
  const fn = (from, to) => {
    calls.count++
    if (calls.count <= failures) throw Object.assign(new Error(`${code}: injected`), { code })
    return rename(from, to)
  }
  return { calls, fn }
}

/**
 * The async write with its rename failing `code` for the first `failures` calls.
 *
 * @param {string} target
 * @param {string} code
 * @param {number} failures
 */
async function writeWithFlakyRename(target, code, failures) {
  const { calls, fn } = flakyRename(code, failures, (from, to) => fs.rename(from, to))
  const io = { ...fs, async rename(/** @type {string} */ from, /** @type {string} */ to) { return fn(from, to) } }
  try {
    await atomicWriteFile(target, 'after', { fs: /** @type {typeof fs} */ (io) })
    return { calls: calls.count, error: undefined }
  } catch (error) {
    return { calls: calls.count, error }
  }
}

// On win32 the rename over a destination another handle still holds (the
// delete-pending cursor a compaction rename just replaced, or an AV scan)
// fails EPERM, EBUSY or EACCES until that handle closes. The write retries
// rather than failing the flush (#2899).
for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`atomicWriteFile retries a win32 ${code} rename until the holder lets go`, async (t) => {
    forcePlatform(t, 'win32')
    const dir = await makeTmpDir()
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const target = path.join(dir, 'cursor.json')
    await fs.writeFile(target, 'before')
    const result = await writeWithFlakyRename(target, code, 2)
    assert.equal(result.error, undefined)
    assert.equal(result.calls, 3)
    assert.equal(await fs.readFile(target, 'utf8'), 'after')
    assert.deepEqual(await fs.readdir(dir), ['cursor.json'])
  })

  test(`atomicWriteFileSync retries a win32 ${code} rename until the holder lets go`, async (t) => {
    forcePlatform(t, 'win32')
    const dir = await makeTmpDir()
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const target = path.join(dir, 'cursor.json')
    fsSync.writeFileSync(target, 'before')
    const { calls, fn } = flakyRename(code, 2, fsSync.renameSync.bind(fsSync))
    t.mock.method(fsSync, 'renameSync', fn)
    atomicWriteFileSync(target, 'after')
    t.mock.restoreAll()
    assert.equal(calls.count, 3)
    assert.equal(fsSync.readFileSync(target, 'utf8'), 'after')
    assert.deepEqual(fsSync.readdirSync(dir), ['cursor.json'])
  })
}

// The retry is bounded: a holder that never lets go still fails the write,
// after the first attempt plus 10 retries, and the temp file is removed.
test('atomicWriteFile gives up on a win32 rename that stays EPERM', async (t) => {
  forcePlatform(t, 'win32')
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'cursor.json')
  await fs.writeFile(target, 'before')
  const result = await writeWithFlakyRename(target, 'EPERM', Infinity)
  assert.equal(/** @type {NodeJS.ErrnoException} */ (result.error)?.code, 'EPERM')
  assert.equal(result.calls, 11)
  assert.equal(await fs.readFile(target, 'utf8'), 'before')
  assert.deepEqual(await fs.readdir(dir), ['cursor.json'])
})

test('atomicWriteFileSync gives up on a win32 rename that stays EPERM', async (t) => {
  forcePlatform(t, 'win32')
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'cursor.json')
  fsSync.writeFileSync(target, 'before')
  const { calls, fn } = flakyRename('EPERM', Infinity, fsSync.renameSync.bind(fsSync))
  t.mock.method(fsSync, 'renameSync', fn)
  assert.throws(() => atomicWriteFileSync(target, 'after'), { code: 'EPERM' })
  t.mock.restoreAll()
  assert.equal(calls.count, 11)
  assert.equal(fsSync.readFileSync(target, 'utf8'), 'before')
  assert.deepEqual(fsSync.readdirSync(dir), ['cursor.json'])
})

// Only the holder codes retry, and only on win32: a different fault on win32,
// or EPERM on POSIX (a real permission problem there), fails on the first call.
for (const [platform, code] of /** @type {const} */ ([['win32', 'EIO'], ['linux', 'EPERM'], ['darwin', 'EBUSY']])) {
  test(`atomicWriteFile does not retry a ${platform} ${code} rename`, async (t) => {
    forcePlatform(t, platform)
    const dir = await makeTmpDir()
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const target = path.join(dir, 'cursor.json')
    const result = await writeWithFlakyRename(target, code, 1)
    assert.equal(/** @type {NodeJS.ErrnoException} */ (result.error)?.code, code)
    assert.equal(result.calls, 1)
    assert.deepEqual(await fs.readdir(dir), [])
  })

  test(`atomicWriteFileSync does not retry a ${platform} ${code} rename`, async (t) => {
    forcePlatform(t, platform)
    const dir = await makeTmpDir()
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const target = path.join(dir, 'cursor.json')
    const { calls, fn } = flakyRename(code, 1, fsSync.renameSync.bind(fsSync))
    t.mock.method(fsSync, 'renameSync', fn)
    assert.throws(() => atomicWriteFileSync(target, 'after'), { code })
    t.mock.restoreAll()
    assert.equal(calls.count, 1)
    assert.deepEqual(fsSync.readdirSync(dir), [])
  })
}
