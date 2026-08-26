// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createLocalIcebergIO } from '../../src/core/cache/iceberg/resolver.js'
import { appendRowsToTable, readRowsFromTable } from '../../src/core/cache/iceberg/store.js'

/**
 * @import { WriterOptions } from 'icebird/src/types.js'
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
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
  let landedInWindow = false
  /** @type {unknown} */
  let winnerError = null
  /** @type {Promise<void> | null} */
  let winnerFinish = null
  /** @param {unknown} dest */
  const raceIn = (dest) => {
    if (raced || String(dest) !== target) return
    raced = true
    // `finish()` is async in signature but synchronous in body, so the
    // winner's file is on disk before this hook returns. Record that
    // rather than assume it, and assert it below once the real syscalls
    // are back: throwing from inside the patched syscall would be caught
    // by the resolver's own error path and resurface as a status
    // mismatch, which reports that the test failed but not why. If
    // `finish()` ever stops being synchronous, the assertion below fails
    // on its own message instead.
    // Settle the winner's outcome here rather than letting it reject out of
    // the `await` below: an async `finish()` would leave the winner racing
    // the loser for real and reject with its own 412, which would surface
    // before the guard below and report the wrong failure.
    winnerFinish = Promise.resolve(winner.finish()).catch((err) => {
      winnerError = err
    })
    landedInWindow = fs.existsSync(target)
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
  assert.ok(landedInWindow, 'the competing commit landed inside the publish window')
  assert.equal(winnerError, null, 'the committer that got there first published')
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

// Every errno a filesystem without hard links can answer `link` with. Node
// surfaces libuv's spelling, and libuv names errno 95 `ENOTSUP`: there is no
// `EOPNOTSUPP` in `util.getSystemErrorMap()`, so a mapping that recognized
// only the POSIX spelling would let the common case fall through to a bare
// errno, which is the thing the message exists to replace.
for (const code of ['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']) {
  test(`a filesystem that answers link with ${code} fails the commit loudly, and not as a conflict`, async () => {
    const dir = await tempDir('hyp-iceberg-race-')
    const newWriter = await localWriterFactory()
    const target = path.join(dir, 'metadata', 'v2.metadata.json')

    const writer = newWriter(url(target), { ifNoneMatch: '*' })
    writer.appendBytes(new TextEncoder().encode('{"committer":"only"}'))

    const realLink = fs.linkSync
    /** @type {unknown} */
    let failure = null
    try {
      fs.linkSync = () => {
        throw Object.assign(new Error(`${code}: link not supported`), { code })
      }
      try {
        await writer.finish()
      } catch (err) {
        failure = err
      }
    } finally {
      fs.linkSync = realLink
    }

    assert.ok(failure, 'a link the filesystem refuses cannot report a published commit')
    assert.equal(/** @type {{ code?: string }} */ (failure).code, code)
    assert.match(/** @type {Error} */ (failure).message, /hard links/)
    assert.ok(/** @type {{ cause?: unknown }} */ (failure).cause, 'the original errno survives as the cause')
    // A 412 would send `commitWithRetry` around the retry loop up to 50
    // times against a filesystem that will refuse every one of them.
    assert.equal(/** @type {{ status?: number }} */ (failure).status, undefined)
    assert.equal(fs.existsSync(target), false, 'nothing was published')

    const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.tmp.'))
    assert.deepEqual(leftovers, [], 'the failed commit leaves no temp file behind')

    await fsp.rm(dir, { recursive: true, force: true })
  })
}

test('a cleanup failure after a losing link still reports the collision, not the cleanup', async () => {
  const dir = await tempDir('hyp-iceberg-race-')
  const newWriter = await localWriterFactory()
  const target = path.join(dir, 'metadata', 'v2.metadata.json')

  const first = newWriter(url(target), { ifNoneMatch: '*' })
  first.appendBytes(new TextEncoder().encode('{"committer":"first"}'))
  await first.finish()

  const second = newWriter(url(target), { ifNoneMatch: '*' })
  second.appendBytes(new TextEncoder().encode('{"committer":"second"}'))

  // The staged file the loser cleans up is the same file an indexer or a
  // scanner can be holding, so this rm can fail exactly like the one on the
  // success path. If it did, the 412 would be replaced by an EBUSY, and
  // `commitWithRetry` rethrows a non-412 instead of reloading - the loser
  // would get a hard commit failure out of a race it is supposed to retry.
  const realRm = fs.rmSync
  /** @type {unknown} */
  let failure = null
  try {
    fs.rmSync = (/** @type {any} */ at, /** @type {any} */ options) => {
      if (String(at).includes('.tmp.')) throw new Error('EBUSY: resource busy or locked, unlink')
      return realRm(at, options)
    }
    try {
      await second.finish()
    } catch (err) {
      failure = err
    }
  } finally {
    fs.rmSync = realRm
  }

  assert.equal(/** @type {{ status?: number }} */ (failure).status, 412)
  assert.equal(fs.readFileSync(target, 'utf8'), '{"committer":"first"}')

  await fsp.rm(dir, { recursive: true, force: true })
})

test('a cleanup failure after the link does not turn a published commit into a failed one', async () => {
  const dir = await tempDir('hyp-iceberg-race-')
  const newWriter = await localWriterFactory()
  const target = path.join(dir, 'metadata', 'v2.metadata.json')

  const writer = newWriter(url(target), { ifNoneMatch: '*' })
  writer.appendBytes(new TextEncoder().encode('{"committer":"only"}'))

  // The link is the commit point. Unlinking the staged second name to the
  // same inode is cleanup after the fact, so if it fails the caller must
  // still be told the snapshot landed - reporting a failure would leave
  // the table advanced and the writer convinced it was not.
  const realRm = fs.rmSync
  try {
    fs.rmSync = (/** @type {any} */ at, /** @type {any} */ options) => {
      if (String(at).includes('.tmp.')) throw new Error('EBUSY: resource busy or locked, unlink')
      return realRm(at, options)
    }
    await writer.finish()
  } finally {
    fs.rmSync = realRm
  }

  assert.equal(fs.readFileSync(target, 'utf8'), '{"committer":"only"}')
  const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.tmp.'))
  assert.equal(leftovers.length, 1, 'the cleanup really did fail, so the case is not vacuous')

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

test('a create that loses the race to another creator is the table existing, not a failed append', async () => {
  const dir = await tempDir('hyp-iceberg-race-')
  const table = path.join(dir, 'events')
  /** @type {ColumnSpec[]} */
  const columns = [{ name: 'id', type: 'INT32', nullable: false }]

  // `icebergCreate` has no retry: its contract hands a 412 back to the caller
  // to read as "the table already exists". Until the resolver enforced the
  // create-only precondition that 412 was unreachable, because the losing
  // creator simply overwrote the winner's `v1` and carried on. Now it is
  // reachable, so build the competing table for real and drop it into the
  // window between this append's `tableExists` probe and its create.
  await appendRowsToTable(table, columns, [{ id: 1 }])
  const saved = path.join(dir, 'saved')
  fs.cpSync(table, saved, { recursive: true })
  fs.rmSync(table, { recursive: true, force: true })

  const realLink = fs.linkSync
  let raced = false
  try {
    fs.linkSync = (from, to) => {
      if (!raced && String(to).endsWith(`v1.metadata.json`)) {
        raced = true
        fs.cpSync(saved, table, { recursive: true })
      }
      return realLink(from, to)
    }
    await appendRowsToTable(table, columns, [{ id: 2 }])
  } finally {
    fs.linkSync = realLink
  }

  assert.ok(raced, 'the competing table was created inside the create window')
  const ids = (await readRowsFromTable(table)).map((row) => row.id).sort()
  assert.deepEqual(ids, [1, 2], 'the loser appends onto the winner\'s table instead of failing')

  await fsp.rm(dir, { recursive: true, force: true })
})
