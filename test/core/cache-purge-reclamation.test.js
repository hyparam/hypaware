// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import sync from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileCatalog, icebergSetRef, loadLatestFileCatalogMetadata } from 'icebird'
import { stringifyIcebergJson } from 'icebird/src/json.js'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { createSessionPurgeStore } from '../../src/core/cache/session-purges.js'
import { purgeCache } from '../../src/core/cache/purge.js'
import { maintainCache } from '../../src/core/cache/maintenance.js'
import { cachePurgeCleanupStatus, CACHE_PURGE_GRACE_MS } from '../../src/core/cache/purge-cleanup.js'
import { appendRowsToTable, deleteMatchingRows, scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import { writeCursor, withPartitionMutationLock } from '../../src/core/cache/partition.js'

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


test('unpublished generation does not strand purge or retirement', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-abandoned-'))
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  const storage = createQueryStorageService({ cacheRoot })
  const partition = storage.cacheTablePath('events', ['source=unknown'])
  await storage.appendRows(partition, columns, [{ session_id: 'target', org: 'a', body: 'target' }, { session_id: 'keep', org: 'a', body: 'neighbor' }])
  await storage.flushTable(partition, { force: true })
  const original = resolveIcebergDir(partition)
  const abandoned = path.join(partition, 'table-interrupted')
  await fs.mkdir(path.join(abandoned, 'data'), { recursive: true })
  await fs.writeFile(path.join(abandoned, 'data', 'partial.parquet'), 'interrupted write')
  const purged = await purgeCache({ cacheRoot, target: { kind: 'session', id: 'target', org: 'a' } })
  assert.equal(purged.rowsDeleted, 1)
  assert(purged.cacheCleanup?.length)
  const id = purged.cacheCleanup[0]
  await maintainCache({ cacheRoot })
  await fs.stat(abandoned)
  await age(cacheRoot, id, [original])
  const old = new Date(Date.now() - CACHE_PURGE_GRACE_MS - 10000)
  await fs.utimes(abandoned, old, old)
  await maintainCache({ cacheRoot })
  await assert.rejects(fs.stat(abandoned), { code: 'ENOENT' })
  assert.equal((await cachePurgeCleanupStatus(cacheRoot, id)).status, 'completed')
  assert.equal((await rows(resolveIcebergDir(partition)))[0].session_id, 'keep')
  assert.equal((await purgeCache({ cacheRoot, target: { kind: 'session', id: 'target', org: 'a' } })).rowsDeleted, 0)

  // A hint proves publication: missing metadata must not be treated as staging.
  await fs.mkdir(path.join(abandoned, 'metadata'), { recursive: true })
  await fs.writeFile(path.join(abandoned, 'metadata', 'version-hint.text'), '1')
  await assert.rejects(purgeCache({ cacheRoot, target: { kind: 'session', id: 'keep', org: 'a' } }))
})

// @ref LLP 0417#cache-mutation-guard [tests]: a separate CLI cannot certify an old snapshot's replacement
test('cross-process purge refuses an active rewrite, then reclaims its output on retry', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-process-race-'))
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  const storage = createQueryStorageService({ cacheRoot })
  const partition = storage.cacheTablePath('events', ['source=unknown'])
  await storage.appendRows(partition, columns, [
    { session_id: 'target', org: 'a', body: 'synthetic sensitive' },
    { session_id: 'keep', org: 'a', body: 'neighbor' },
  ])
  await storage.flushAll({ force: true })
  const original = resolveIcebergDir(partition)
  const child = `
    import { purgeCache } from ${JSON.stringify(new URL('../../src/core/cache/purge.js', import.meta.url).href)}
    import { createSessionPurgeStore } from ${JSON.stringify(new URL('../../src/core/cache/session-purges.js', import.meta.url).href)}
    const cacheRoot = process.argv[1]
    createSessionPurgeStore(cacheRoot).add('target', 'a')
    try {
      const result = await purgeCache({ cacheRoot, target: { kind: 'session', id: 'target', org: 'a' } })
      console.log(JSON.stringify({ status: 'completed', result }))
    } catch (error) { console.log(JSON.stringify({ status: 'incomplete', error: error.message })) }
  `
  const runChild = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child, cacheRoot], { encoding: 'utf8', timeout: 10000 }))
  const mkdir = sync.mkdirSync
  let attempted = false
  // Run the CLI while old rows are buffered, immediately before the first
  // output directory exists. A journal taken here cannot name that output.
  sync.mkdirSync = /** @type {typeof sync.mkdirSync} */ (function (directory, options) {
    if (!attempted && String(directory).startsWith(`${partition}/table-`)) {
      attempted = true
      const result = runChild()
      assert.equal(result.status, 'incomplete')
      assert.match(result.error, /mutation busy/)
    }
    return mkdir(directory, options)
  })
  try { assert.equal((await maintainCache({ cacheRoot, force: true })).totalFailed, 0) }
  finally { sync.mkdirSync = mkdir }
  assert(attempted)
  const rewritten = resolveIcebergDir(partition)
  assert.notEqual(rewritten, original)
  assert.equal((await rows(rewritten)).length, 2, 'the refused purge cannot claim those buffered bytes were removed')
  const retried = runChild()
  assert.equal(retried.status, 'completed')
  const id = retried.result.cacheCleanup[0]
  const job = JSON.parse(await fs.readFile(path.join(cacheRoot, '.purge-cleanup', `${id}.json`), 'utf8'))
  assert(job.generations.includes(path.basename(rewritten)))
  await maintainCache({ cacheRoot })
  assert.deepEqual((await rows(resolveIcebergDir(partition))).map(row => row.session_id), ['keep'])
  await age(cacheRoot, id, [original, rewritten])
  await maintainCache({ cacheRoot })
  assert.equal((await cachePurgeCleanupStatus(cacheRoot, id)).status, 'completed')
  await assert.rejects(fs.stat(original), { code: 'ENOENT' })
  await assert.rejects(fs.stat(rewritten), { code: 'ENOENT' })
  assert.deepEqual((await rows(resolveIcebergDir(partition))).map(row => row.session_id), ['keep'])
})

test('mutation guard never expires a live owner, recovers a dead owner, and fails closed on missing ownership', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-guard-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const partition = path.join(root, 'partition')
  const guard = path.join(root, '.partition.mutation-lock')
  const module = JSON.stringify(new URL('../../src/core/cache/partition.js', import.meta.url).href)
  const child = `import { withPartitionMutationLock } from ${module}
    try { await withPartitionMutationLock(process.argv[1], async () => {})
      console.log('acquired')
    } catch { console.log('refused') }`
  await withPartitionMutationLock(partition, async () => {
    const old = new Date(0)
    await fs.utimes(guard, old, old)
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', child, partition], { encoding: 'utf8' }).trim(), 'refused')
  })
  // Exit without unwinding the guard, as after a daemon crash.
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { withPartitionMutationLock } from ${module}
    await withPartitionMutationLock(process.argv[1], async () => { process.exit(0) })`, partition])
  await withPartitionMutationLock(partition, async () => {})
  await assert.rejects(fs.stat(guard), { code: 'ENOENT' })
  await assert.rejects(withPartitionMutationLock(partition, async () => { throw new Error('injected') }), /injected/)
  await withPartitionMutationLock(partition, async () => {})
  await fs.mkdir(guard)
  await assert.rejects(withPartitionMutationLock(partition, async () => assert.fail('must refuse')), /unverifiable/)
})

for (const source of [false, true]) test(`buffered append rechecks under the guard, source=${source}`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-guard-append-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const storage = createQueryStorageService({ cacheRoot: root })
  const partition = storage.cacheTablePath('events', ['source=unknown'])
  const input = [
    { session_id: 'target', org: 'a', body: 'sensitive' },
    { session_id: 'keep', org: 'a', body: 'neighbor' },
  ]
  if (source) await storage.appendRows(partition, columns, input)
  const mkdir = sync.mkdirSync
  let fenced = false
  sync.mkdirSync = /** @type {typeof sync.mkdirSync} */ (function (directory, options) {
    const result = mkdir(directory, options)
    if (!fenced && String(directory).endsWith('.mutation-lock')) {
      fenced = true
      createSessionPurgeStore(root).add('target', 'a')
    }
    return result
  })
  try {
    if (source) assert.equal((await storage.flushAll({ force: true })).droppedCount, 1)
    else await storage.appendRowsToPartition('events', ['source=unknown'], columns, input)
  } finally { sync.mkdirSync = mkdir }
  assert(fenced, 'marker arrives after the storage precheck but before mutation')
  assert.deepEqual((await rows(resolveIcebergDir(partition))).map(row => row.session_id), ['keep'])
})
