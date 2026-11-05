// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { claimPartitionMutation, isPartitionMutationBusy } from '../../src/core/util/mutation_guard.js'

/**
 * Stage a held lock directory so the guard's own `mkdir` hits EEXIST and falls
 * into the inspect-the-holder path, where the injected `readdir` fires.
 *
 * @param {import('node:test').TestContext} t
 */
async function stagedContention(t) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hyp-mutation-guard-'))
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 10 }))
  const partitionDir = path.join(base, 'datasets', 'ds', 'source=a')
  fs.mkdirSync(path.dirname(partitionDir), { recursive: true })
  const lockDir = path.join(path.dirname(partitionDir), `.${path.basename(partitionDir)}.mutation-lock`)
  fs.mkdirSync(lockDir, { recursive: true })
  return partitionDir
}

// On win32, readdir of a lock directory another process is concurrently
// removing reports EPERM (delete-pending) or EBUSY (a handle lingers), not the
// ENOENT POSIX gives. The guard must read all of them as contention - a
// retryable busy refusal - not crash the caller with a raw errno, which is the
// regression that exited a cross-process allocator child with code 1 on win32.
for (const code of ['EPERM', 'EBUSY', 'ENOENT']) {
  test(`claimPartitionMutation treats a ${code} reading the lock directory as busy, not a raw throw`, async (t) => {
    const partitionDir = await stagedContention(t)
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
  const partitionDir = await stagedContention(t)
  t.mock.method(fs, 'readdirSync', () => { throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }) })
  assert.throws(
    () => claimPartitionMutation(partitionDir),
    (err) => !isPartitionMutationBusy(err) && /** @type {NodeJS.ErrnoException} */ (err).code === 'EIO',
    'a non-contention fault must not be folded into busy',
  )
})
