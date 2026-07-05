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

test('atomicWriteFile applies the requested file mode', async () => {
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

test('atomicWriteFile enforces expectedMtimeMs (CONCURRENT_EDIT)', async () => {
  const dir = await makeTmpDir()
  try {
    const target = path.join(dir, 'settings.json')
    await fs.writeFile(target, 'v1')
    const { mtimeMs } = await fs.stat(target)

    // Matching mtime: write goes through.
    await atomicWriteFile(target, 'v2', { expectedMtimeMs: mtimeMs })
    assert.equal(await fs.readFile(target, 'utf8'), 'v2')

    // Stale mtime: rejected, file untouched.
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
    await assert.rejects(readFileIfExists(path.join(file, 'child')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
