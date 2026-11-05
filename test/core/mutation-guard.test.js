// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { claimPartitionMutation, isPartitionMutationBusy } from '../../src/core/util/mutation_guard.js'

/** @import { TestContext } from 'node:test' */

/**
 * Stage a held lock directory so the guard's own `mkdir` hits EEXIST and falls
 * into the inspect-the-holder path, where the injected `readdir` fires.
 *
 * @param {TestContext} t
 */
async function stagedContention(t) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hyp-mutation-guard-'))
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 10 }))
  const partitionDir = path.join(base, 'datasets', 'ds', 'source=a')
  fs.mkdirSync(path.dirname(partitionDir), { recursive: true })
  const lockDir = path.join(path.dirname(partitionDir), `.${path.basename(partitionDir)}.mutation-lock`)
  fs.mkdirSync(lockDir, { recursive: true })
  return { partitionDir, lockDir }
}

// On win32, readdir of a lock directory another process is concurrently
// removing reports EPERM (delete-pending) or EBUSY (a handle lingers), not the
// ENOENT POSIX gives. The guard must read all of them as contention - a
// retryable busy refusal - not crash the caller with a raw errno, which is the
// regression that exited a cross-process allocator child with code 1 on win32.
for (const code of ['EPERM', 'EBUSY', 'ENOENT']) {
  test(`claimPartitionMutation treats a ${code} reading the lock directory as busy, not a raw throw`, async (t) => {
    const { partitionDir } = await stagedContention(t)
    t.mock.method(fs, 'readdirSync', () => { throw Object.assign(new Error(`${code}: injected`), { code }) })
    assert.throws(
      () => claimPartitionMutation(partitionDir),
      (err) => isPartitionMutationBusy(err),
      `${code} should surface as a busy refusal`,
    )
  })
}

// The broadening is a filter on known contention codes, not a blanket catch: a
// genuine fault reading the lock still propagates raw, so a real problem is
// never masked as retryable contention.
test('claimPartitionMutation still rethrows a non-contention readdir error raw', async (t) => {
  const { partitionDir } = await stagedContention(t)
  t.mock.method(fs, 'readdirSync', () => { throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }) })
  assert.throws(
    () => claimPartitionMutation(partitionDir),
    (err) => !isPartitionMutationBusy(err) && /** @type {NodeJS.ErrnoException} */ (err).code === 'EIO',
    'a non-contention fault must not be folded into busy',
  )
})

/**
 * Stage a lock left by a dead owner: an entry naming this process's PID that it
 * does not hold, which the guard reads as dead, so the claim reaches the
 * unlink-then-rmdir recovery path.
 *
 * @param {TestContext} t
 */
async function stagedDeadOwner(t) {
  const { partitionDir, lockDir } = await stagedContention(t)
  fs.writeFileSync(path.join(lockDir, `${process.pid}-${randomUUID()}`), '')
  return { partitionDir, lockDir }
}

// Recovery that loses its race reads as busy and stops: a competing reclaimer
// took the dead owner's entry (ENOENT), win32 left it delete-pending
// (EPERM/EBUSY), or the directory is not empty at rmdir (ENOTEMPTY). The guard
// never force-removes the lock directory on the way out.
for (const [step, code] of /** @type {const} */ ([
  ['unlinkSync', 'ENOENT'], ['unlinkSync', 'EPERM'], ['unlinkSync', 'EBUSY'], ['rmdirSync', 'ENOTEMPTY'],
])) {
  test(`claimPartitionMutation treats a ${code} from ${step} during dead-owner recovery as busy`, async (t) => {
    const { partitionDir, lockDir } = await stagedDeadOwner(t)
    t.mock.method(fs, step, () => { throw Object.assign(new Error(`${code}: injected`), { code }) })
    assert.throws(
      () => claimPartitionMutation(partitionDir),
      (err) => isPartitionMutationBusy(err),
      `${code} from ${step} should surface as a busy refusal`,
    )
    t.mock.restoreAll()
    assert.ok(fs.existsSync(lockDir), 'a lost recovery must leave the lock directory in place')
  })
}

test('claimPartitionMutation still rethrows a non-contention recovery error raw', async (t) => {
  const { partitionDir } = await stagedDeadOwner(t)
  t.mock.method(fs, 'unlinkSync', () => { throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }) })
  assert.throws(
    () => claimPartitionMutation(partitionDir),
    (err) => !isPartitionMutationBusy(err) && /** @type {NodeJS.ErrnoException} */ (err).code === 'EIO',
    'a non-contention recovery fault must not be folded into busy',
  )
})

test('claimPartitionMutation reclaims a dead owner and takes the guard', async (t) => {
  const { partitionDir, lockDir } = await stagedDeadOwner(t)
  const release = claimPartitionMutation(partitionDir)
  const entries = fs.readdirSync(lockDir)
  assert.equal(entries.length, 1)
  assert.match(entries[0], new RegExp(`^${process.pid}-`))
  release()
  assert.equal(fs.existsSync(lockDir), false)
})

/**
 * Fail the guard's own claim `mkdir` of the lock directory with `code`, leaving
 * the recursive parent mkdir alone, with `process.platform` set to `platform`.
 *
 * @param {TestContext} t
 * @param {string} code
 * @param {NodeJS.Platform} platform
 */
async function failedClaimMkdir(t, code, platform) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hyp-mutation-guard-'))
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 10 }))
  const partitionDir = path.join(base, 'datasets', 'ds', 'source=a')
  const real = Object.getOwnPropertyDescriptor(process, 'platform')
  assert.ok(real)
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  t.after(() => Object.defineProperty(process, 'platform', real))
  const mkdirSync = fs.mkdirSync
  t.mock.method(fs, 'mkdirSync', (/** @type {fs.PathLike} */ dir, /** @type {any} */ options) => {
    if (options?.recursive) return mkdirSync(dir, options)
    throw Object.assign(new Error(`${code}: injected`), { code })
  })
  return partitionDir
}

// On win32, the claim mkdir of a lock directory another process is removing
// fails EPERM (delete-pending) or ENOENT rather than EEXIST. That is the same
// lost race as the recovery path, so it must surface as busy for the caller's
// bounded retry, not a raw throw that exits a cross-process allocator child
// (the second sighting on #2886).
for (const code of ['EPERM', 'ENOENT', 'EBUSY']) {
  test(`claimPartitionMutation treats a win32 ${code} from the claim mkdir as busy`, async (t) => {
    const partitionDir = await failedClaimMkdir(t, code, 'win32')
    assert.throws(
      () => claimPartitionMutation(partitionDir),
      (err) => isPartitionMutationBusy(err),
      `${code} from the claim mkdir should surface as a busy refusal on win32`,
    )
  })
}

// POSIX has no delete-pending state, so EPERM from the claim mkdir is a real
// permission fault and stays raw rather than reading as retryable contention.
test('claimPartitionMutation rethrows a POSIX EPERM from the claim mkdir raw', async (t) => {
  const partitionDir = await failedClaimMkdir(t, 'EPERM', 'linux')
  assert.throws(
    () => claimPartitionMutation(partitionDir),
    (err) => !isPartitionMutationBusy(err) && /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM',
    'a POSIX permission fault must not be folded into busy',
  )
})
