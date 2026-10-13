// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createIngestSeqAllocator } from '../../src/core/cache/ingest-seq.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.d.ts'
 * @import { SinkContinuation } from '../../hypaware-plugin-kernel-types.d.ts'
 */

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-seq-xproc-'))
}

/** @type {ColumnSpec[]} */
const COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'msg', type: 'STRING', nullable: false },
]

/**
 * Read a partition the way the central sink does: every row above `since`,
 * returning the ids delivered and the continuation to resume from.
 *
 * @param {ReturnType<typeof createQueryStorageService>} svc
 * @param {string} tablePath
 * @param {SinkContinuation | null} since
 */
async function sinkTick(svc, tablePath, since) {
  /** @type {number[]} */
  const ids = []
  let after = since
  for await (const item of svc.readRowsSince(tablePath, { since: since ?? undefined, includeLegacy: since === null })) {
    after = item.after
    if ('row' in item && item.row) ids.push(Number(item.row.id))
  }
  return { ids, after }
}

// Two storage services over one cache root stand in for two processes (the
// daemon and a `hyp query` that flushes the spool itself): each has its own
// allocator state, exactly as two processes do. Issue #2578.
test('rows committed by a second process after a sink tick are still above the watermark', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const daemon = createQueryStorageService({ cacheRoot })
    const query = createQueryStorageService({ cacheRoot })
    const tablePath = daemon.cacheTablePath('demo', ['all'])

    await daemon.appendRows(tablePath, COLS, [{ id: 1, msg: 'daemon' }])
    await daemon.flushTable(tablePath, { reason: 'manual' })
    await query.appendRows(tablePath, COLS, [{ id: 2, msg: 'query' }])
    await query.flushTable(tablePath, { reason: 'query_always' })

    const partition = (await daemon.discoverCachePartitions({ datasets: ['demo'] }))[0]
    const first = await sinkTick(daemon, partition.path, null)
    assert.deepEqual(first.ids.sort(), [1, 2])

    // The daemon's next flush lands after the sink has advanced past the
    // query's rows. Those rows must still sit above the watermark.
    await daemon.appendRows(tablePath, COLS, [{ id: 3, msg: 'daemon again' }])
    await daemon.flushTable(tablePath, { reason: 'manual' })
    const second = await sinkTick(daemon, partition.path, first.after)
    assert.deepEqual(second.ids, [3], 'the row flushed after the tick is forwarded on the next tick')

    await query.appendRows(tablePath, COLS, [{ id: 4, msg: 'query again' }])
    await query.flushTable(tablePath, { reason: 'query_always' })
    const third = await sinkTick(daemon, partition.path, second.after)
    assert.deepEqual(third.ids, [4])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('two allocators over one cache root never hand out the same seq, even when called at once', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const a = createIngestSeqAllocator({ cacheRoot })
    const b = createIngestSeqAllocator({ cacheRoot })
    const [sa, sb] = await Promise.all([a.reserve(3), b.reserve(5)])
    const ranges = [[sa, sa + 3n], [sb, sb + 5n]].sort((x, y) => (x[0] < y[0] ? -1 : 1))
    assert.ok(ranges[0][1] <= ranges[1][0], `ranges overlap: ${ranges.map(r => r.join('..')).join(' and ')}`)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('seqs reserved by alternating allocators increase in reservation order', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const a = createIngestSeqAllocator({ cacheRoot })
    const b = createIngestSeqAllocator({ cacheRoot })
    const first = await a.reserve(1)
    const second = await b.reserve(1)
    const third = await a.reserve(1)
    assert.ok(second > first)
    assert.ok(third > second, `a seq reserved later (${third}) must be above every earlier one (${second})`)
    const persisted = JSON.parse(await fs.readFile(path.join(cacheRoot, '_hyp_ingest_seq.json'), 'utf8'))
    assert.equal(persisted.nextSeq, (third + 1n).toString())
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// Real processes this time: the in-process promise chain cannot stand in for
// the on-disk guard, and it was a real four-process run that caught the guard
// reporting a vanished lock directory as an error instead of contention.
test('allocators in separate processes reserve disjoint runs with no gap and leave no lock behind', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const allocatorUrl = pathToFileURL(path.resolve('src/core/cache/ingest-seq.js')).href
    const child = `
      import { createIngestSeqAllocator } from ${JSON.stringify(allocatorUrl)}
      const alloc = createIngestSeqAllocator({ cacheRoot: process.argv[1] })
      const runs = []
      for (let i = 0; i < 60; i++) {
        const count = 1 + i % 4
        runs.push([(await alloc.reserve(count)).toString(), count])
      }
      process.stdout.write(JSON.stringify(runs))
    `
    const children = 3
    const outputs = await Promise.all(Array.from({ length: children }, () => new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', child, cacheRoot], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      proc.stdout.on('data', (chunk) => { out += chunk })
      proc.on('error', reject)
      proc.on('exit', (code) => code === 0 ? resolve(/** @type {[string, number][]} */ (JSON.parse(out))) : reject(new Error(`child exited ${code}`)))
    })))
    const runs = outputs.flat()
      .map(([start, count]) => ({ start: BigInt(start), end: BigInt(start) + BigInt(count) }))
      .sort((a, b) => (a.start < b.start ? -1 : 1))
    assert.equal(runs.length, children * 60)
    for (let i = 1; i < runs.length; i++) {
      assert.ok(runs[i].start >= runs[i - 1].end, `runs overlap at ${runs[i - 1].start}..${runs[i - 1].end} and ${runs[i].start}`)
    }
    const reserved = runs.reduce((sum, run) => sum + (run.end - run.start), 0n)
    const persisted = JSON.parse(await fs.readFile(path.join(cacheRoot, '_hyp_ingest_seq.json'), 'utf8'))
    assert.equal(persisted.nextSeq, (reserved + 1n).toString(), 'every reserved seq is accounted for and none was reserved twice')
    const leftovers = (await fs.readdir(cacheRoot)).filter((name) => name.includes('mutation-lock'))
    assert.deepEqual(leftovers, [])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
