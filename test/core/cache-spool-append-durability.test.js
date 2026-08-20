// @ts-check

/**
 * `spool.append` is the cache write seam: every source row lands in the
 * spool before anything commits it (LLP 0013). Its callers read a
 * rejection as "the record is not in the spool" and re-derive what to
 * write from the spool itself - `dedupeStoredPartIds` in the AI gateway's
 * exchange writer rescans the committed partitions plus the spool on
 * every call - so a rejection that leaves a TORN record behind costs the
 * next record too, and a rejection over a durable one reports landed rows
 * as lost.
 *
 * These tests pin the contract the callers assume: `append` resolves when
 * the record is in the spool, rejects only when it is not, and never
 * tidies up by discarding bytes that are not its own.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createCacheSpool } from '../../src/core/cache/spool.js'

/**
 * @import { FileHandle } from 'node:fs/promises'
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [{ name: 'id', type: 'INT32', nullable: false }]

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-spool-append-${prefix}-`))
}

/**
 * Build a spool whose `appendChunk` records everything a flush commits, so
 * a test can ask what actually reached a partition.
 *
 * @param {string} cacheRoot
 */
function spoolWithCommitLog(cacheRoot) {
  /** @type {Record<string, unknown>[]} */
  const committed = []
  const spool = createCacheSpool({
    cacheRoot,
    async appendChunk(_tablePath, _columns, rows) {
      committed.push(...rows)
      return { bytesWritten: 0 }
    },
  })
  return { spool, committed }
}

/**
 * Swap `fs.open` for one that hands back a handle whose `active.jsonl`
 * writes misbehave the way a failing device does, and return the restore
 * function. Only the spool's own data file is touched, so the flush
 * bookkeeping files keep working.
 *
 * @param {(handle: FileHandle) => void} sabotage
 */
function interceptActiveFile(sabotage) {
  const realOpen = fs.open
  fs.open = async (/** @type {any[]} */ ...openArgs) => {
    // @ts-expect-error - forwarded verbatim to the real implementation
    const handle = await realOpen(...openArgs)
    if (typeof openArgs[0] === 'string' && openArgs[0].endsWith('active.jsonl')) sabotage(handle)
    return handle
  }
  return () => { fs.open = realOpen }
}

/** @param {string} which */
function failWith(which) {
  return Object.assign(new Error(`simulated ${which} failure`), { code: 'EIO' })
}

test('append that fails at sync() leaves no record for a later flush to commit', async () => {
  const cacheRoot = await makeTmpDir('sync')
  const restore = interceptActiveFile((handle) => {
    handle.sync = async () => { throw failWith('sync') }
  })
  try {
    const { spool, committed } = spoolWithCommitLog(cacheRoot)
    const tablePath = path.join(cacheRoot, 'datasets', 'test_data', 'source=claude')

    await assert.rejects(
      () => spool.append(tablePath, COLUMNS, [{ id: 1 }]),
      /simulated sync failure/
    )
    restore()

    // The caller has been told the write did not land, so it will replay
    // these rows. Anything the flush commits from this append is a
    // duplicate of that replay.
    await spool.flushTable(tablePath, { reason: 'test' })
    assert.deepEqual(committed.map((row) => row.id), [])
  } finally {
    restore()
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('append that only fails at close() reports the durable record as written', async () => {
  const cacheRoot = await makeTmpDir('close')
  const restore = interceptActiveFile((handle) => {
    const realClose = handle.close.bind(handle)
    handle.close = async () => {
      await realClose()
      throw failWith('close')
    }
  })
  try {
    const { spool, committed } = spoolWithCommitLog(cacheRoot)
    const tablePath = path.join(cacheRoot, 'datasets', 'test_data', 'source=claude')

    // write() and sync() both succeeded: the record is durable and the
    // flush will commit it, so reporting a failure here would make the
    // caller replay rows that already landed.
    const result = await spool.append(tablePath, COLUMNS, [{ id: 1 }])
    assert.ok(result.bytesWritten > 0)
    restore()

    await spool.flushTable(tablePath, { reason: 'test' })
    assert.deepEqual(committed.map((row) => row.id), [1])
  } finally {
    restore()
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('append that fails part-way through the write leaves no torn line behind', async () => {
  const cacheRoot = await makeTmpDir('partial')
  const restore = interceptActiveFile((handle) => {
    const realWriteFile = handle.writeFile.bind(handle)
    handle.writeFile = async (/** @type {any} */ data, /** @type {any} */ options) => {
      await realWriteFile(String(data).slice(0, 12), options)
      throw failWith('write')
    }
  })
  try {
    const { spool, committed } = spoolWithCommitLog(cacheRoot)
    const tablePath = path.join(cacheRoot, 'datasets', 'test_data', 'source=claude')

    await assert.rejects(
      () => spool.append(tablePath, COLUMNS, [{ id: 1 }]),
      /simulated write failure/
    )
    restore()

    // A half-written line carries no newline, so leaving it in place also
    // costs the NEXT record: the two concatenate into one malformed line
    // the flush reader drops.
    await spool.append(tablePath, COLUMNS, [{ id: 2 }])
    await spool.flushTable(tablePath, { reason: 'test' })
    assert.deepEqual(committed.map((row) => row.id), [2])
  } finally {
    restore()
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a failing append does not truncate away a concurrent writer\'s durable line', async () => {
  const cacheRoot = await makeTmpDir('foreign')
  // Nothing locks `active.jsonl` across processes, so another `hyp` run can
  // land a complete record between this append's size probe and its write.
  const foreignLine = JSON.stringify({ version: 1, columns: COLUMNS, rows: [{ id: 9 }] }) + '\n'
  const restore = interceptActiveFile((handle) => {
    const realWriteFile = handle.writeFile.bind(handle)
    handle.writeFile = async (/** @type {any} */ data, /** @type {any} */ options) => {
      await realWriteFile(foreignLine, options)
      await realWriteFile(String(data).slice(0, 12), options)
      throw failWith('write')
    }
  })
  try {
    const { spool, committed } = spoolWithCommitLog(cacheRoot)
    const tablePath = path.join(cacheRoot, 'datasets', 'test_data', 'source=claude')

    await assert.rejects(
      // Padded so the foreign line plus this append's torn prefix still fit
      // inside one line's worth of bytes: a size ceiling would wave that
      // through and truncate the foreign row away with it.
      () => spool.append(tablePath, COLUMNS, [{ id: 1, pad: 'x'.repeat(400) }]),
      /simulated write failure/
    )
    restore()

    await spool.flushTable(tablePath, { reason: 'test' })
    assert.deepEqual(committed.map((row) => row.id), [9])
  } finally {
    restore()
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('an append whose rollback truncate is refused still spares the next record', async () => {
  const cacheRoot = await makeTmpDir('truncate')
  const restore = interceptActiveFile((handle) => {
    const realWriteFile = handle.writeFile.bind(handle)
    let torn = false
    handle.writeFile = async (/** @type {any} */ data, /** @type {any} */ options) => {
      if (torn) return realWriteFile(data, options)
      torn = true
      await realWriteFile(String(data).slice(0, 12), options)
      throw failWith('write')
    }
    handle.truncate = async () => { throw failWith('truncate') }
  })
  try {
    const { spool, committed } = spoolWithCommitLog(cacheRoot)
    const tablePath = path.join(cacheRoot, 'datasets', 'test_data', 'source=claude')

    await assert.rejects(
      () => spool.append(tablePath, COLUMNS, [{ id: 1 }]),
      /simulated write failure/
    )
    restore()

    // The remnant survives, but terminated: it is one malformed line the
    // flush reader drops on its own rather than a prefix that swallows the
    // record appended after it.
    await spool.append(tablePath, COLUMNS, [{ id: 2 }])
    await spool.flushTable(tablePath, { reason: 'test' })
    assert.deepEqual(committed.map((row) => row.id), [2])
  } finally {
    restore()
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('an append whose whole record survives a refused rollback is reported as written', async () => {
  const cacheRoot = await makeTmpDir('retained')
  // The write lands in full and only `sync()` fails, so the rollback has a
  // complete, newline-terminated line to take back - and the same device
  // refuses the truncate. The record is committable either way, so the one
  // outcome that costs anything is telling the caller it was lost.
  const restore = interceptActiveFile((handle) => {
    handle.sync = async () => { throw failWith('sync') }
    handle.truncate = async () => { throw failWith('truncate') }
  })
  try {
    const { spool, committed } = spoolWithCommitLog(cacheRoot)
    const tablePath = path.join(cacheRoot, 'datasets', 'test_data', 'source=claude')

    const result = await spool.append(tablePath, COLUMNS, [{ id: 1 }])
    assert.ok(result.bytesWritten > 0)
    restore()

    // Exactly one copy: a rejection here would have the caller replay the
    // batch on top of the one the flush is about to commit.
    await spool.flushTable(tablePath, { reason: 'test' })
    assert.deepEqual(committed.map((row) => row.id), [1])
  } finally {
    restore()
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
