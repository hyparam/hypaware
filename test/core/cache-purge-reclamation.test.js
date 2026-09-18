// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileCatalog, icebergSetRef, loadLatestFileCatalogMetadata } from 'icebird'
import { stringifyIcebergJson } from 'icebird/src/json.js'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { purgeCache } from '../../src/core/cache/purge.js'
import { maintainCache } from '../../src/core/cache/maintenance.js'
import { cachePurgeCleanupStatus, CACHE_PURGE_GRACE_MS } from '../../src/core/cache/purge-cleanup.js'
import { appendRowsToTable, deleteMatchingRows, scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import { writeCursor } from '../../src/core/cache/partition.js'

/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */
const columns = /** @type {ColumnSpec[]} */ (['session_id', 'org', 'body'].map(name => ({ name, type: 'STRING', nullable: true })))
/** @param {string} dir */
async function rows(dir) {
  const result = []
  for await (const row of scanRowsFromTable(dir)) result.push(row)
  return result
}
/** @param {string} cacheRoot @param {string} id @param {string[]} generations */
async function age(cacheRoot, id, generations) {
  const file = path.join(cacheRoot, '.purge-cleanup', `${id}.json`)
  const job = JSON.parse(await fs.readFile(file, 'utf8'))
  job.requestedAt = Date.now() - CACHE_PURGE_GRACE_MS - 10000
  await fs.writeFile(file, JSON.stringify(job))
  for (const dir of generations) await fs.writeFile(path.join(dir, '.retired'), new Date(job.requestedAt).toISOString())
}

for (const legacy of [false, true]) test(`purge reclaims cache history and sidecars, legacy=${legacy}`, async t => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-purge-reclaim-'))
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  const storage = createQueryStorageService({ cacheRoot })
  const partition = storage.cacheTablePath('events', ['source=unknown'])
  const input = [
    { session_id: 'target', org: 'a', body: 'sensitive fixture' },
    { session_id: 'neighbor', org: 'a', body: 'surviving neighbor' },
    { session_id: 'target', org: 'b', body: 'other tenant' },
  ]
  if (legacy) {
    await appendRowsToTable(path.join(partition, 'epoch=0'), columns, input)
    await writeCursor(partition, { epoch: 0, rowCount: 3, compaction: null })
  } else {
    await storage.appendRows(partition, columns, input)
    await storage.flushTable(partition, { force: true })
  }
  const original = resolveIcebergDir(partition)
  const before = await rows(original)
  const retired = path.join(partition, 'table-older')
  await appendRowsToTable(retired, columns, [input[0]])
  await fs.writeFile(path.join(retired, 'sensitive.index.parquet'), 'synthetic index bytes')
  const purged = await purgeCache({ cacheRoot, target: { kind: 'session', id: 'target', org: 'a' } })
  assert.equal(purged.rowsDeleted, 2, 'current and retired source-table generations are purged')
  assert.equal(purged.cacheCleanup?.length, 1)
  const id = /** @type {string} */ (purged.cacheCleanup?.[0])
  assert.equal((await cachePurgeCleanupStatus(cacheRoot, id)).stage, 'rewrite')
  const dry = await maintainCache({ cacheRoot, dryRun: true })
  assert.equal(dry.totalCompacted, 1)
  assert.equal(resolveIcebergDir(partition), original)
  const maintained = await maintainCache({ cacheRoot })
  assert.equal(maintained.totalFailed, 0, JSON.stringify(maintained))
  assert.equal(maintained.totalCompacted, 1, 'one-file partitions are still rewritten')
  const current = resolveIcebergDir(partition)
  assert.notEqual(current, original)
  assert.deepEqual(await rows(current), before.filter(row => !(row.session_id === 'target' && row.org === 'a')), 'identities and ingest sequences survive')
  assert.equal((await cachePurgeCleanupStatus(cacheRoot, id)).stage, 'reclaim')
  await fs.stat(original)
  await fs.stat(retired)
  assert.equal((await maintainCache({ cacheRoot })).totalCompacted, 0, 'restart does not repeat a successful swap')
  // Even a very old directory must not bypass the purge reader grace.
  const old = new Date(Date.now() - 2 * CACHE_PURGE_GRACE_MS)
  await fs.utimes(original, old, old)
  await maintainCache({ cacheRoot })
  await fs.stat(original)
  await age(cacheRoot, id, [original, retired])
  await maintainCache({ cacheRoot })
  await assert.rejects(fs.stat(original), { code: 'ENOENT' })
  await assert.rejects(fs.stat(retired), { code: 'ENOENT' })
  assert.equal((await cachePurgeCleanupStatus(cacheRoot, id)).status, 'completed')
  assert.equal((await rows(resolveIcebergDir(partition))).length, 2)
  // A subsequent purge must schedule the new live generation too.
  const second = await purgeCache({ cacheRoot, target: { kind: 'session', id: 'neighbor', org: 'a' } })
  assert.deepEqual(second.cacheCleanup, [id])
  assert.equal((await cachePurgeCleanupStatus(cacheRoot, id)).stage, 'rewrite')
  await maintainCache({ cacheRoot })
  assert.equal((await rows(resolveIcebergDir(partition))).length, 1)
})

test('empty output, pinned snapshot retry, and admission failure stay honest', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-purge-empty-'))
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  const storage = createQueryStorageService({ cacheRoot })
  const partition = storage.cacheTablePath('events', ['source=unknown'])
  await storage.appendRows(partition, columns, [{ session_id: 'target', org: 'a', body: 'last row' }])
  await storage.flushTable(partition, { force: true })
  const original = resolveIcebergDir(partition)
  await assert.rejects(deleteMatchingRows(original, () => true, { columns: ['session_id'], beforeDelete: async () => { throw new Error('journal unavailable') } }), /journal unavailable/)
  assert.equal((await rows(original)).length, 1)
  await assert.rejects(purgeCache({ cacheRoot, target: { kind: 'session', id: 'target', org: 'a' },
    onCleanupQueued: async () => { throw new Error('receipt unavailable') } }), /receipt unavailable/)
  assert.equal((await rows(original)).length, 1, 'receipt admission also precedes logical deletion')
  const io = await createLocalIcebergIO()
  const tableUrl = tableUrlForDir(original)
  const catalog = fileCatalog({ ...io, conditionalCommits: true })
  const { metadata } = await loadLatestFileCatalogMetadata({ ...io, tableUrl })
  await icebergSetRef({ catalog, tableUrl, ref: 'hold', type: 'tag', snapshotId: /** @type {number | bigint} */ (metadata['current-snapshot-id']) })
  const result = await purgeCache({ cacheRoot, target: { kind: 'session', id: 'target', org: 'a' } })
  const id = /** @type {string} */ (result.cacheCleanup?.[0])
  assert.equal((await maintainCache({ cacheRoot })).totalFailed, 1)
  assert.equal(resolveIcebergDir(partition), original)
  assert.equal((await cachePurgeCleanupStatus(cacheRoot, id)).status, 'pending')
  const held = await loadLatestFileCatalogMetadata({ ...io, tableUrl })
  if (held.metadata.refs) delete held.metadata.refs.hold
  await fs.writeFile(path.join(original, 'metadata', held.metadataFileName), stringifyIcebergJson(held.metadata))
  assert.equal((await maintainCache({ cacheRoot })).totalFailed, 0)
  assert.notEqual(resolveIcebergDir(partition), original)
  assert.deepEqual(await rows(resolveIcebergDir(partition)), [])
  await age(cacheRoot, id, [original])
  await maintainCache({ cacheRoot })
  assert.equal((await cachePurgeCleanupStatus(cacheRoot, id)).status, 'completed')
})
