// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createLocalIcebergIO } from '../../src/core/cache/iceberg/resolver.js'

/**
 * @import { WriterOptions } from 'icebird/src/types.js'
 * @import { AbortableWriter } from '../../src/core/cache/types.js'
 */

/**
 * The local Iceberg resolver is the atomicity primitive under every
 * conditional cache commit: `icebird`'s file catalog asks for the next
 * `v(N+1).metadata.json` with `ifNoneMatch: '*'` and treats a 412 as the
 * signal to reload and re-stage. The daemon maintenance tick, a hand-run
 * `hyp query maintain`, and the sidecar build can all be committing at
 * once, so "the destination did not exist a moment ago" is not the same
 * claim as "I created it".
 */

/**
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function tempDir(prefix) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function url(filePath) {
  return pathToFileURL(filePath).href
}

/**
 * The resolver contract types `writer` as optional, so pull it out once
 * and hand the tests a callable.
 *
 * @returns {Promise<(url: string, options?: WriterOptions) => AbortableWriter>}
 */
async function localWriterFactory() {
  const { resolver } = await createLocalIcebergIO()
  const { writer } = resolver
  if (!writer) throw new Error('the local iceberg resolver must expose a writer')
  return (target, options) => /** @type {AbortableWriter} */ (writer(target, options))
}

test('a conditional commit whose target appears mid-publish fails the precondition instead of clobbering', async () => {
  const dir = await tempDir('hyp-iceberg-race-')
  const newWriter = await localWriterFactory()
  const target = path.join(dir, 'metadata', 'v2.metadata.json')

  const winnerBytes = new TextEncoder().encode('{"committer":"winner"}')
  const loserBytes = new TextEncoder().encode('{"committer":"loser"}')

  const winner = newWriter(url(target), { ifNoneMatch: '*' })
  winner.appendBytes(winnerBytes)
  const loser = newWriter(url(target), { ifNoneMatch: '*' })
  loser.appendBytes(loserBytes)

  // Force the interleaving rather than hope for it. Every publish shape
  // this writer can take ends in one syscall that moves the temp file
  // onto the target (`rename` for the check-then-act version, `link` for
  // an atomic exclusive create), so wrapping both puts the competing
  // commit exactly in the window between "the guard decided" and "the
  // publish happened". The competitor commits through the same real
  // resolver, so both sides of the race are real syscalls.
  const realRename = fs.renameSync
  const realLink = fs.linkSync
  let raced = false
  /** @type {Promise<void> | null} */
  let winnerFinish = null
  /** @param {unknown} dest */
  const raceIn = (dest) => {
    if (raced || String(dest) !== target) return
    raced = true
    // `finish()` is async in signature but synchronous in body, so the
    // winner's file is on disk before this hook returns. Assert that
    // rather than assume it: if it ever stops holding, this test must
    // fail loudly instead of quietly stopping to test anything.
    winnerFinish = /** @type {Promise<void>} */ (winner.finish())
    assert.ok(fs.existsSync(target), 'the competing commit landed inside the window')
  }

  /** @type {unknown} */
  let loserError = null
  try {
    fs.renameSync = (from, to) => {
      raceIn(to)
      return realRename(from, to)
    }
    fs.linkSync = (from, to) => {
      raceIn(to)
      return realLink(from, to)
    }
    try {
      await loser.finish()
    } catch (err) {
      loserError = err
    }
  } finally {
    fs.renameSync = realRename
    fs.linkSync = realLink
  }
  await winnerFinish

  assert.ok(raced, 'the competing commit was injected in front of the publish syscall')
  assert.ok(
    loserError,
    'the second committer must observe a precondition failure, not a silent success'
  )
  assert.equal(/** @type {{ status?: number }} */ (loserError).status, 412)
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    '{"committer":"winner"}',
    'the snapshot the winner committed survives'
  )

  const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.tmp.'))
  assert.deepEqual(leftovers, [], 'the failed commit leaves no temp file behind')

  await fsp.rm(dir, { recursive: true, force: true })
})

test('a conditional commit onto an existing target is a 412 that leaves the target untouched', async () => {
  const dir = await tempDir('hyp-iceberg-race-')
  const newWriter = await localWriterFactory()
  const target = path.join(dir, 'metadata', 'v2.metadata.json')

  const first = newWriter(url(target), { ifNoneMatch: '*' })
  first.appendBytes(new TextEncoder().encode('{"committer":"first"}'))
  await first.finish()

  const second = newWriter(url(target), { ifNoneMatch: '*' })
  second.appendBytes(new TextEncoder().encode('{"committer":"second"}'))
  await assert.rejects(
    () => /** @type {Promise<void>} */ (second.finish()),
    /** @param {Error & { status?: number }} err */
    (err) => err.status === 412
  )
  assert.equal(fs.readFileSync(target, 'utf8'), '{"committer":"first"}')

  const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.tmp.'))
  assert.deepEqual(leftovers, [], 'the failed commit leaves no temp file behind')

  await fsp.rm(dir, { recursive: true, force: true })
})

test('an unconditional write still publishes over whatever is there', async () => {
  const dir = await tempDir('hyp-iceberg-race-')
  const newWriter = await localWriterFactory()
  const target = path.join(dir, 'metadata', 'version-hint.text')

  const first = newWriter(url(target))
  first.appendBytes(new TextEncoder().encode('1'))
  await first.finish()

  const second = newWriter(url(target))
  second.appendBytes(new TextEncoder().encode('2'))
  await second.finish()

  assert.equal(fs.readFileSync(target, 'utf8'), '2')

  await fsp.rm(dir, { recursive: true, force: true })
})

test('a conditional commit that flushed row groups still publishes atomically', async () => {
  const dir = await tempDir('hyp-iceberg-race-')
  const newWriter = await localWriterFactory()
  const target = path.join(dir, 'data', 'part-0.parquet')

  const writer = newWriter(url(target), { ifNoneMatch: '*' })
  writer.appendBytes(new TextEncoder().encode('abc'))
  writer.flush?.()
  writer.park?.()
  writer.appendBytes(new TextEncoder().encode('def'))
  await writer.finish()

  assert.equal(fs.readFileSync(target, 'utf8'), 'abcdef')

  const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.tmp.'))
  assert.deepEqual(leftovers, [], 'the published commit leaves no temp file behind')

  await fsp.rm(dir, { recursive: true, force: true })
})
