// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createQueryStorageService } from '../../src/core/cache/storage.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'msg', type: 'STRING', nullable: false },
]

const storageUrl = pathToFileURL(path.resolve('src/core/cache/storage.js')).href
const partitionUrl = pathToFileURL(path.resolve('src/core/cache/partition.js')).href

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-drain-xproc-'))
}

/**
 * @param {string} script
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function runChild(script, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    proc.stdout.on('data', (chunk) => { out += chunk })
    proc.on('error', reject)
    proc.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`child exited ${code}`)))
  })
}

/**
 * Every committed id in the demo dataset, in commit order.
 *
 * @param {ReturnType<typeof createQueryStorageService>} svc
 */
async function committedIds(svc) {
  /** @type {number[]} */
  const ids = []
  const partitions = await svc.discoverCachePartitions({ datasets: ['demo'] })
  if (partitions.length === 0) return ids
  for await (const item of svc.readRowsSince(partitions[0].path, { includeLegacy: true })) {
    if ('row' in item && item.row) ids.push(Number(item.row.id))
  }
  return ids
}

// Real processes: the in-process flush lock already serializes flushes within
// one process, so only separate processes can take the same rotated file.
// Each child stands in for the daemon or a `hyp query --refresh always`:
// it spools its own rows and force-flushes after every append. Issue #2580.
test('concurrent forced flushes in separate processes commit every spooled row exactly once', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const child = `
      import { createQueryStorageService } from ${JSON.stringify(storageUrl)}
      const [cacheRoot, base] = process.argv.slice(1)
      const svc = createQueryStorageService({ cacheRoot })
      const tablePath = svc.cacheTablePath('demo', ['all'])
      const cols = ${JSON.stringify(COLS)}
      for (let round = 0; round < 25; round++) {
        const rows = Array.from({ length: 4 }, (_, i) => ({ id: Number(base) + round * 4 + i, msg: 'r' + round }))
        await svc.appendRows(tablePath, cols, rows)
        // A busy partition guard is the contention callers already retry.
        for (let attempt = 0; ; attempt++) {
          try {
            await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
            break
          } catch (error) {
            if (error?.error_kind !== 'cache_partition_mutation_busy' || attempt >= 200) throw error
            await new Promise(resolve => setTimeout(resolve, 10))
          }
        }
      }
    `
    const children = 4
    await Promise.all(Array.from({ length: children }, (_, i) => runChild(child, [cacheRoot, String(i * 1000)])))

    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    const ids = await committedIds(svc)
    const expected = children * 25 * 4
    assert.equal(new Set(ids).size, ids.length, `${ids.length - new Set(ids).size} rows were committed more than once`)
    assert.equal(ids.length, expected, 'every spooled row is committed')
    const spool = await fs.readdir(path.join(tablePath, '_hypaware_spool'))
    assert.deepEqual(spool.filter((name) => name.startsWith('flush-') || name.endsWith('.mutation-lock')), [], 'no rotated file or claim is left behind')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a drain claim left by a killed process does not wedge the next flush', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'waiting' }])

    // A pid that was alive a moment ago and is not now, published the way a
    // holder publishes itself.
    const deadPid = Number(await runChild('process.stdout.write(String(process.pid))', []))
    const claim = path.join(tablePath, '_hypaware_spool', '.drain.mutation-lock')
    await fs.mkdir(claim)
    await fs.writeFile(path.join(claim, `${deadPid}-${randomUUID()}`), '')

    const result = await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.equal(result.rowCount, 1)
    assert.deepEqual(await committedIds(svc), [1])
    await assert.rejects(fs.stat(claim), { code: 'ENOENT' }, 'the dead holder\'s claim is reclaimed and released')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a forced flush waits out a live holder instead of returning before its rows commit', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'waiting' }])

    const key = path.join(tablePath, '_hypaware_spool', 'drain')
    const holder = runChild(`
      import { withPartitionMutationLock } from ${JSON.stringify(partitionUrl)}
      await withPartitionMutationLock(process.argv[1], async () => {
        process.stdout.write('held')
        await new Promise(resolve => setTimeout(resolve, 400))
      })
    `, [key])
    const claim = path.join(tablePath, '_hypaware_spool', '.drain.mutation-lock')
    while (!(await fs.stat(claim).then(() => true, () => false))) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    // Measured when the flush settles, not after joining the holder, or an
    // unclaimed flush that returned at once would pass too.
    const started = Date.now()
    const result = await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    const waited = Date.now() - started
    assert.equal(await holder, 'held')
    assert.ok(waited >= 200, `the flush waited for the holder to let go (settled after ${waited} ms)`)
    assert.equal(result.rowCount, 1)
    assert.deepEqual(await committedIds(svc), [1])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// A spool that is missing when a flush starts holds nothing that flush owes,
// and one another process creates a moment later is that process's to drain
// under its own claim. Draining it here, unclaimed, raced the other drainer
// for the same batch.
test('a flush that finds no spool does not drain one another process creates meanwhile', async () => {
  const cacheRoot = await makeTmpDir()
  const exists = fsSync.existsSync
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    const dir = path.join(tablePath, '_hypaware_spool')
    const child = `
      import { createQueryStorageService } from ${JSON.stringify(storageUrl)}
      const svc = createQueryStorageService({ cacheRoot: process.argv[1] })
      await svc.appendRows(svc.cacheTablePath('demo', ['all']), ${JSON.stringify(COLS)}, [{ id: 1, msg: 'other process' }])
    `
    let crossed = false
    fsSync.existsSync = (p) => {
      const result = exists(p)
      if (!crossed && p === dir && !result) {
        crossed = true
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', child, cacheRoot], { stdio: 'inherit' })
        assert.equal(run.status, 0)
      }
      return result
    }
    const result = await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    fsSync.existsSync = exists
    assert.ok(crossed, 'the spool was created after the flush looked for it')
    assert.equal(result.rowCount, 0)
    assert.deepEqual(await committedIds(svc), [])
    assert.ok((await svc.pendingInfo(tablePath)).pending, 'the row waits for a claimed drain')
  } finally {
    fsSync.existsSync = exists
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
