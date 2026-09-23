// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import sync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { createSessionPurgeStore, sessionGraphNodeId } from '../../src/core/cache/session-purges.js'
import { runPurge } from '../../src/core/commands/purge.js'
import { appendRowsToTable, deleteMatchingRows, listLiveDataFiles, scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { cacheCleanupId } from '../../src/core/cache/purge-cleanup.js'
import { discoverCachePartitions, PARTITION_MUTATION_BUSY_ERROR_KIND } from '../../src/core/cache/partition.js'
import { Attr } from '../../src/core/observability/attrs.js'
import { withLogRecords } from '../helpers/log_records.js'

/** @import { ColumnSpec, CommandRunContext } from '../../hypaware-plugin-kernel-types.js' */
/** @type {ColumnSpec[]} */
const columns = ['session_id', 'org', 'body'].map(name => ({ name, type: 'STRING', nullable: true }))

/** @param {string} root */
function fixture(root) {
  const storage = createQueryStorageService({ cacheRoot: path.join(root, 'cache') })
  let output = ''
  let error = ''
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    storage, env: { HYP_HOME: root }, stdin: { isTTY: false }, cwd: root,
    stdout: { write(value) { output += value } }, stderr: { write(value) { error += value } },
  }))
  return { storage, ctx, output: () => output, error: () => error }
}

test('session purge drains active and rotated spools, survives restart, and preserves neighbors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage, ctx, error } = fixture(root)
  const table = storage.cacheTablePath('events', ['source=unknown'])
  await storage.appendRows(table, columns, [{ session_id: 'delete', body: 'rotated secret' }, { session_id: 'keep', body: 'neighbor' }])
  const dir = path.join(table, '_hypaware_spool')
  await fs.rename(path.join(dir, 'active.jsonl'), path.join(dir, 'flush-fixture.jsonl'))
  await storage.appendRows(table, columns, [{ session_id: 'delete', body: 'active secret' }])
  assert.equal(await runPurge(['--session', 'delete', '--yes', '--json'], ctx), 0, error())
  assert.equal((await storage.pendingInfo(table)).pendingBytes, 0)
  const reopened = createQueryStorageService({ cacheRoot: storage.cacheRoot })
  await reopened.appendRows(table, columns, [{ session_id: 'delete', body: 'replay' }, { session_id: 'keep', body: 'new neighbor' }])
  await reopened.flushAll({ force: true })
  const rows = []
  for await (const row of scanRowsFromTable(resolveIcebergDir(table))) rows.push(row)
  assert.deepEqual(rows.map(row => row.body).sort(), ['neighbor', 'new neighbor'])
})

test('org-scoped fence does not suppress a same-id session in another org, including projected reads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-org-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage } = fixture(root)
  const table = storage.cacheTablePath('events', ['source=unknown'])
  await storage.appendRows(table, columns, [
    { session_id: 'same', org: 'a', body: 'secret' }, { session_id: 'same', org: 'b', body: 'visible' },
  ])
  await storage.flushAll({ force: true })
  createSessionPurgeStore(storage.cacheRoot).add('same', 'a')
  const rows = []
  for await (const row of storage.readRows(table, ['body'])) rows.push(row)
  assert.deepEqual(rows, [{ body: 'visible' }])
  const exports = []
  for await (const row of storage.readRowsSince(table, { columns: ['body'] })) exports.push(row)
  assert.equal(exports.filter(entry => entry.dropped).length, 1)
  assert.deepEqual(exports.flatMap(entry => entry.row ? [entry.row] : []), [{ body: 'visible' }])
  const source = await storage.dataSourceForTable(table)
  assert.ok(source)
  const results = []
  for await (const row of source.scan({ columns: ['body'], limit: 1 }).rows()) results.push(row.resolved?.body ?? await row.cells?.body?.())
  assert.deepEqual(results, ['visible'])
})

test('purge refuses unreadable table data instead of reporting zero deletions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-corrupt-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage } = fixture(root)
  const table = storage.cacheTablePath('events', ['source=unknown'])
  await storage.appendRows(table, columns, [{ session_id: 'delete', body: 'secret' }])
  await storage.flushAll({ force: true })
  const iceberg = resolveIcebergDir(table)
  const [file] = await listLiveDataFiles(iceberg)
  await fs.writeFile(new URL(file.filePath), 'broken parquet')
  await assert.rejects(deleteMatchingRows(iceberg, row => row.session_id === 'delete', { columns: ['session_id'] }))
})

test('remote purge sends only the named session, validates receipt, and reports partial failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-remote-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx, output, error } = fixture(root)
  ctx.config = /** @type {any} */ ({ query: { remotes: { dev: { url: 'https://example.test/prefix/v1/mcp' } } } })
  ctx.env.HYP_REMOTE_TOKEN_DEV = 'test-token'
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  let success = true
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://example.test/prefix/v1/sessions/purge')
    assert.deepEqual(JSON.parse(String(options?.body)), { session_id: 'delete' })
    return success ? Response.json({ status: 'completed', session_id: 'delete' }) : new Response(null, { status: 503 })
  }
  assert.equal(await runPurge(['--session', 'delete', '--remote', 'dev', '--yes', '--json'], ctx), 0)
  assert.equal(JSON.parse(output()).remote.status, 'completed')
  success = false
  assert.equal(await runPurge(['--session', 'delete', '--remote', 'dev', '--yes'], ctx), 1)
  assert.match(error(), /remote purge incomplete/)
})

test('a corrupt exclusion fails capture closed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-store-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage } = fixture(root)
  createSessionPurgeStore(storage.cacheRoot).add('delete')
  const directory = path.join(storage.cacheRoot, 'session-purges')
  const [name] = await fs.readdir(directory)
  await fs.writeFile(path.join(directory, name), '{}')
  await assert.rejects(storage.appendRows(storage.cacheTablePath('events'), columns, [{ session_id: 'other' }]))
})

test('refresh re-reads a store written within the last second and memoizes an older one', async t => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-stamp-'))
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }))
  const store = createSessionPurgeStore(cacheRoot)
  store.add('fresh')
  const directory = path.join(cacheRoot, 'session-purges')
  const opendir = sync.opendirSync
  let reads = 0
  sync.opendirSync = /** @type {typeof sync.opendirSync} */ (function (...args) {
    reads++
    return opendir.apply(sync, /** @type {any} */ (args))
  })
  try {
    store.refresh()
    assert.equal(reads, 1, 'a stamp the coarse clock may still be sitting on is re-read')
    const old = new Date(Date.now() - 5000)
    await fs.utimes(directory, old, old)
    store.refresh()
    store.refresh()
    assert.equal(reads, 2, 'an aged stamp is read once and then memoized')
  } finally { sync.opendirSync = opendir }
  assert.equal(store.size, 1)
})

test('refresh ignores foreign filenames in the purge store but still fails closed on a malformed marker', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-foreign-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage } = fixture(root)
  createSessionPurgeStore(storage.cacheRoot).add('delete')
  const directory = path.join(storage.cacheRoot, 'session-purges')
  await fs.writeFile(path.join(directory, '.DS_Store'), 'not json')
  await fs.writeFile(path.join(directory, 'notes.txt'), 'not json')
  const fence = createSessionPurgeStore(storage.cacheRoot)
  fence.refresh()
  assert.equal(fence.size, 1)
  assert.equal(fence.has({ session_id: 'delete' }), true)

  const [name] = (await fs.readdir(directory)).filter(entry => /^[a-f0-9]{64}\.json$/.test(entry))
  await fs.writeFile(path.join(directory, name), '{}')
  assert.throws(() => createSessionPurgeStore(storage.cacheRoot).refresh())
})

test('a local failure does not strand the authorized remote purge', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-partial-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx, storage, output } = fixture(root)
  storage.flushAll = async () => { throw new Error('local spool unavailable') }
  ctx.config = /** @type {any} */ ({ query: { remotes: { dev: { url: 'https://example.test' } } } })
  ctx.env.HYP_REMOTE_TOKEN_DEV = 'test-token'
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  globalThis.fetch = async () => Response.json({ status: 'completed', session_id: 'delete' })
  assert.equal(await runPurge(['--session', 'delete', '--remote', 'dev', '--yes', '--json'], ctx), 1)
  const receipt = JSON.parse(output())
  assert.equal(receipt.local.status, 'incomplete')
  assert.equal(receipt.remote.status, 'completed')
  assert.equal(receipt.rowsDeleted, null)
})


test('position deletes span commit batches and remain idempotent without hiding neighbors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-batches-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage } = fixture(root)
  const table = storage.cacheTablePath('events', ['source=unknown'])
  const rows = Array.from({ length: 6002 }, (_, i) => ({
    session_id: i === 0 || i === 6001 ? 'keep' : 'delete', body: String(i),
  }))
  await storage.appendRows(table, columns, rows)
  await storage.flushAll({ force: true })
  const iceberg = resolveIcebergDir(table)
  const predicate = row => row.session_id === 'delete'
  const result = await deleteMatchingRows(iceberg, predicate, { columns: ['session_id'] })
  assert.equal(result.rowsDeleted, 6000)
  assert.equal(result.batchCount, 2)
  const surviving = []
  for await (const row of scanRowsFromTable(iceberg)) surviving.push(row.body)
  assert.deepEqual(surviving, ['0', '6001'])
  assert.equal((await deleteMatchingRows(iceberg, predicate, { columns: ['session_id'] })).rowsDeleted, 0)
})


test('session purge automatically attempts every configured remote despite an earlier failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-default-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx, output } = fixture(root)
  ctx.config = /** @type {any} */ ({ query: { remotes: {
    first: { url: 'https://first.test' }, second: { url: 'https://second.test' },
  } } })
  ctx.env.HYP_REMOTE_TOKEN_FIRST = 'test-token'
  ctx.env.HYP_REMOTE_TOKEN_SECOND = 'test-token'
  const calls = []
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  globalThis.fetch = async url => {
    calls.push(String(url))
    return String(url).includes('first.test') ? new Response(null, { status: 503 }) :
      Response.json({ status: 'completed', session_id: 'delete' })
  }
  assert.equal(await runPurge(['--session', 'delete', '--yes', '--json'], ctx), 1)
  assert.deepEqual(calls, ['https://first.test/v1/sessions/purge', 'https://second.test/v1/sessions/purge'])
  const receipt = JSON.parse(output())
  assert.equal(receipt.remotes.first.status, 'incomplete')
  assert.equal(receipt.remotes.second.status, 'completed')
  assert.equal(receipt.remotes.second.physical_cleanup.status, 'unverified')
  assert.equal(receipt.local.physical_cleanup.status, 'not_implemented')
})

test('local-only explicitly skips remotes and incompatible scope flags fail before purging', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-local-only-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx } = fixture(root)
  ctx.config = /** @type {any} */ ({ query: { remotes: { dev: { url: 'https://example.test' } } } })
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  globalThis.fetch = async () => { assert.fail('local-only contacted a remote') }
  assert.equal(await runPurge(['--session', 'delete', '--local-only', '--yes'], ctx), 0)
  assert.equal(await runPurge(['--session', 'delete', '--local-only', '--remote', 'dev', '--yes'], ctx), 2)
  assert.equal(await runPurge(['--all', '--local-only', '--yes'], ctx), 2)
  assert.equal(await runPurge(['--all', '--yes'], ctx), 0)
})

test('an enrolled server without human credentials is incomplete, while explicit remote narrows scope', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-enrolled-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx, output } = fixture(root)
  ctx.config = /** @type {any} */ ({ sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://enrolled.test' } } } })
  assert.equal(await runPurge(['--session', 'delete', '--yes', '--json'], ctx), 1)
  assert.equal(JSON.parse(output()).remotes['sink:central'].status, 'incomplete')
  ctx.config.query = { remotes: { dev: { url: 'https://example.test' } } }
  ctx.env.HYP_REMOTE_TOKEN_DEV = 'test-token'
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  let calls = 0
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://example.test/v1/sessions/purge')
    calls++
    return Response.json({ status: 'completed', session_id: 'delete' })
  }
  assert.equal(await runPurge(['--session', 'delete', '--remote', 'dev', '--yes'], ctx), 0)
  assert.equal(calls, 1)
})

test('a signed-in built-in remote is included without adding it to config', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-builtin-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx } = fixture(root)
  ctx.env.HYP_REMOTE_TOKEN_HYPERPARAM = 'test-token'
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  let calls = 0
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://api.hypaware.ai/v1/sessions/purge')
    calls++
    return Response.json({ status: 'completed', session_id: 'delete' })
  }
  assert.equal(await runPurge(['--session', 'delete', '--yes'], ctx), 0)
  assert.equal(calls, 1)
})

test('a sink saved under the built-in target\'s previous host is the built-in target, purged once with its credential', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-alias-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx, output } = fixture(root)
  ctx.config = /** @type {any} */ ({ sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://hypaware.hyperparam.app' } } } })
  ctx.env.HYP_REMOTE_TOKEN_HYPERPARAM = 'test-token'
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  let calls = 0
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://api.hypaware.ai/v1/sessions/purge')
    calls++
    return Response.json({ status: 'completed', session_id: 'delete' })
  }
  assert.equal(await runPurge(['--session', 'delete', '--yes', '--json'], ctx), 0)
  assert.equal(calls, 1)
  assert.deepEqual(Object.keys(JSON.parse(output()).remotes), ['hyperparam'])
})

test('two targets on one server that differ only by a registered selector stay distinct purge targets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-selectors-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { ctx, output } = fixture(root)
  ctx.config = /** @type {any} */ ({
    query: { remotes: { teamA: { url: 'https://hyp.internal/v1/mcp?org=a' }, teamB: { url: 'https://hyp.internal/v1/mcp?org=b' } } },
    sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://hyp.internal' } } },
  })
  ctx.env.HYP_REMOTE_TOKEN_TEAMA = 'a'
  ctx.env.HYP_REMOTE_TOKEN_TEAMB = 'b'
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  /** @type {string[]} */
  const urls = []
  globalThis.fetch = async url => {
    urls.push(String(url))
    return Response.json({ status: 'completed', session_id: 'delete' })
  }
  // The sink names no selector, so it is a third target (without a credential).
  assert.equal(await runPurge(['--session', 'delete', '--yes', '--json'], ctx), 1)
  assert.deepEqual(Object.keys(JSON.parse(output()).remotes).sort(), ['sink:central', 'teamA', 'teamB'])
  assert.deepEqual(urls.sort(), ['https://hyp.internal/v1/sessions/purge?org=a', 'https://hyp.internal/v1/sessions/purge?org=b'])
})


test('purge covers retired epochs and graph identifiers without deleting other orgs or shared nodes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-retired-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage } = fixture(root)
  const table = storage.cacheTablePath('events', ['source=unknown'])
  await storage.appendRows(table, columns, [{ session_id: 'delete', org: 'a', body: 'current' }])
  await storage.flushAll({ force: true })
  const retired = path.join(table, 'epoch=999')
  await appendRowsToTable(retired, columns, [
    { session_id: 'delete', org: 'a', body: 'old secret' },
    { session_id: 'delete', org: 'b', body: 'other org' },
    { session_id: 'keep', org: 'a', body: 'neighbor' },
  ])
  const graphColumns = ['node_id', 'src_id', 'dst_id', 'org'].map(name => ({ name, type: /** @type {const} */ ('STRING'), nullable: true }))
  const graph = storage.cacheTablePath('node', ['source=unknown'])
  const id = sessionGraphNodeId('delete')
  await storage.appendRows(graph, graphColumns, [
    { node_id: id, org: 'a' }, { src_id: id, dst_id: 'shared', org: 'a' },
    { node_id: id, org: 'b' }, { node_id: 'shared', org: 'a' },
  ])
  await storage.flushAll({ force: true })
  await storage.flushTable(graph, { force: true })
  const { purgeCache } = await import('../../src/core/cache/purge.js')
  createSessionPurgeStore(storage.cacheRoot).add('delete', 'a')
  const fence = createSessionPurgeStore(storage.cacheRoot)
  fence.refresh()
  assert.equal(fence.has({ src_id: id, org: 'a' }), true)
  assert.equal(fence.has({ node_id: id, org: 'b' }), false)
  const projected = []
  for await (const row of storage.readRows(graph, ['org'])) projected.push(row)
  assert.deepEqual(projected, [{ org: 'b' }, { org: 'a' }])
  const result = await purgeCache({ cacheRoot: storage.cacheRoot, target: { kind: 'session', id: 'delete', org: 'a' } })
  assert.equal(result.rowsDeleted, 4)
  const old = []
  for await (const row of scanRowsFromTable(retired)) old.push(row.body)
  assert.deepEqual(old.sort(), ['neighbor', 'other org'])
  const nodes = []
  for await (const row of scanRowsFromTable(resolveIcebergDir(graph))) nodes.push(row.node_id)
  assert.deepEqual(nodes, [id, 'shared'])
  assert.equal((await purgeCache({ cacheRoot: storage.cacheRoot, target: { kind: 'session', id: 'delete', org: 'a' } })).rowsDeleted, 0)
})

test('an unmanaged legacy partition does not abort a session purge over later managed partitions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-legacy-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage } = fixture(root)
  const cacheRoot = storage.cacheRoot

  // Legacy layout: an Iceberg table living directly in the partition dir,
  // with no cursor.json, exactly as discoverCachePartitions finds an
  // unmigrated partition (see test/core/cache-migrate.test.js).
  const legacyDir = path.join(cacheRoot, 'datasets', 'events', 'legacy_v1')
  await fs.mkdir(legacyDir, { recursive: true })
  await appendRowsToTable(legacyDir, columns, [
    { session_id: 'delete', org: 'a', body: 'legacy secret' },
    { session_id: 'keep', org: 'a', body: 'legacy neighbor' },
  ])

  // Managed partition, via the normal storage service.
  const table = storage.cacheTablePath('events', ['source=unknown'])
  await storage.appendRows(table, columns, [
    { session_id: 'delete', org: 'a', body: 'managed secret' },
    { session_id: 'keep', org: 'a', body: 'managed neighbor' },
  ])
  await storage.flushAll({ force: true })

  const { purgeCache } = await import('../../src/core/cache/purge.js')
  const result = await purgeCache({ cacheRoot, target: { kind: 'session', id: 'delete', org: 'a' } })

  assert.equal(result.rowsDeleted, 2)
  assert.equal(result.partitionsAffected, 2)
  assert.deepEqual(result.cacheCleanup, [cacheCleanupId(cacheRoot, table)])

  const legacyRows = []
  for await (const row of scanRowsFromTable(legacyDir)) legacyRows.push(row.body)
  assert.deepEqual(legacyRows, ['legacy neighbor'])

  const managedRows = []
  for await (const row of scanRowsFromTable(resolveIcebergDir(table))) managedRows.push(row.body)
  assert.deepEqual(managedRows, ['managed neighbor'])
})

// @ref LLP 0417#operation [tests]: all storage streams refresh across first and subsequent fences
for (const existing of [false, true]) for (const method of ['rows', 'where', 'since', 'spool']) {
  test(`streaming purge fence: ${method}, existing=${existing}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-stream-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const { storage } = fixture(root)
    const table = storage.cacheTablePath('events', ['source=unknown'])
    const marker = createSessionPurgeStore(storage.cacheRoot)
    if (existing) marker.add('unrelated', 'a')
    await storage.appendRows(table, columns, [
      ...Array.from({ length: 1024 }, () => ({ session_id: 'keep', org: 'a', body: 'prefix' })),
      ...Array.from({ length: 2050 }, () => ({ session_id: 'target', org: 'a', body: 'sensitive' })),
      { session_id: 'target', org: 'b', body: 'foreign survivor' },
    ])
    if (method !== 'spool') await storage.flushAll({ force: true })
    assert(storage.readRowsWhere)
    const stream = (method === 'rows' ? storage.readRows(table, ['body'])
      : method === 'where' ? storage.readRowsWhere(table, ['body'], {})
        : method === 'since' ? storage.readRowsSince(table, { columns: ['body'] })
          : storage.readSpooledRows('events', ['body']))[Symbol.asyncIterator]()
    for (let i = 0; i < 1024; i++) assert.equal((await stream.next()).done, false)
    marker.add('target', 'a')
    const result = []
    let dropped = 0
    let lastSeq = 0n
    for await (const item of { [Symbol.asyncIterator]: () => stream }) {
      if (method === 'since') {
        const entry = /** @type {any} */ (item)
        assert(BigInt(entry.after.seq) >= lastSeq)
        lastSeq = BigInt(entry.after.seq)
        if (entry.dropped) dropped++
        else result.push(entry.row)
      } else result.push(item)
    }
    assert.deepEqual(result, [{ body: 'foreign survivor' }])
    if (method === 'since') {
      assert.equal(dropped, 2050)
      assert(lastSeq > 0n, 'dropping rows must advance the export watermark')
    }
  })
}

test('a busy partition mutation guard skips that partition and still purges the rest', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-busy-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage, ctx, output, error } = fixture(root)
  const sources = ['a', 'b', 'c']
  for (const source of sources) {
    await storage.appendRowsToPartition('events', [`source=${source}`], columns, [
      { session_id: 'delete', body: `secret ${source}` }, { session_id: 'keep', body: `neighbor ${source}` },
    ])
  }
  // A live owner this process did not claim: claimPartitionMutation refuses on
  // sight, with no polling and no waiter queue (LLP 0417 #cache-mutation-guard).
  const busy = storage.cacheTablePath('events', ['source=a'])
  const lock = path.join(path.dirname(busy), `.${path.basename(busy)}.mutation-lock`)
  await fs.mkdir(lock, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(lock, `${process.pid}-${randomUUID()}`), '')
  t.after(() => fs.rm(lock, { recursive: true, force: true }))

  assert.equal(await runPurge(['--session', 'delete', '--yes', '--json'], ctx), 1)

  /** @param {string} source */
  const bodies = async source => {
    const rows = []
    for await (const row of scanRowsFromTable(resolveIcebergDir(storage.cacheTablePath('events', [`source=${source}`])))) rows.push(row.body)
    return rows.sort()
  }
  assert.deepEqual(await bodies('a'), ['neighbor a', 'secret a'], 'the refused partition keeps its rows')
  assert.deepEqual(await bodies('b'), ['neighbor b'], 'a partition behind the refusal is still purged')
  assert.deepEqual(await bodies('c'), ['neighbor c'], 'a partition behind the refusal is still purged')

  const receipt = JSON.parse(output())
  assert.equal(receipt.rowsDeleted, 2)
  assert.equal(receipt.partitionsAffected, 2)
  assert.deepEqual(receipt.partitionsSkipped.map(entry => entry.partition), [busy])
  assert.match(receipt.partitionsSkipped[0].error, /mutation busy/)
  assert.equal(receipt.local.status, 'incomplete')
  assert.match(error(), /1 cache partition could not be purged/)
})

// Until hyparam/hypaware#2044 the skip list lived only in `purgeCache`'s
// return value, so a non-busy throw discarded it and every operator channel
// then reported zero partitions skipped over a run that skipped one.
test('a non-busy failure after a busy skip still names the skipped partition', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-busy-then-error-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage, ctx, output, error } = fixture(root)
  for (const source of ['a', 'b', 'c']) {
    await storage.appendRowsToPartition('events', [`source=${source}`], columns, [
      { session_id: 'delete', body: `secret ${source}` }, { session_id: 'keep', body: `neighbor ${source}` },
    ])
  }
  await storage.flushAll({ force: true })

  // Read the order the purge itself will walk, so the busy skip is recorded
  // before the aborting failure whatever order the filesystem lists in.
  const partitions = (await discoverCachePartitions(storage.cacheRoot)).map(part => part.path)
  assert.equal(partitions.length, 3)
  const busy = partitions[0]
  const corrupt = partitions[partitions.length - 1]

  // A live owner this process did not claim: the guard refuses on sight.
  const lock = path.join(path.dirname(busy), `.${path.basename(busy)}.mutation-lock`)
  await fs.mkdir(lock, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(lock, `${process.pid}-${randomUUID()}`), '')
  t.after(() => fs.rm(lock, { recursive: true, force: true }))
  // A published generation with no table metadata: not a busy guard, so it
  // aborts the run.
  const metadata = path.join(resolveIcebergDir(corrupt), 'metadata')
  for (const name of await fs.readdir(metadata)) {
    if (name.endsWith('.metadata.json')) await fs.rm(path.join(metadata, name))
  }

  const { result, records } = await withLogRecords(() => runPurge(['--session', 'delete', '--yes', '--json'], ctx))
  assert.equal(result, 1, 'a failed purge still exits 1')
  assert.match(error(), /purge failed: Purge found a published generation without table metadata/)
  assert.match(error(), /1 cache partition could not be purged/)
  assert.ok(error().includes(busy), 'the busy-skipped partition is named on stderr')

  const receipt = JSON.parse(output())
  assert.deepEqual(receipt.partitionsSkipped.map((/** @type {any} */ entry) => entry.partition), [busy])
  assert.match(receipt.partitionsSkipped[0].error, /mutation busy/)
  assert.equal(receipt.rowsDeleted, null, 'an aborted run reports no row total')
  assert.equal(receipt.local.status, 'incomplete')
  assert.match(receipt.local.error, /published generation without table metadata/)

  const purgeResult = records.filter((/** @type {any} */ record) => record.body === 'purge.result')
  assert.equal(purgeResult.length, 1)
  assert.equal(purgeResult[0].attributes.partitions_skipped, 1)
  // `incomplete` is off the fixed status set, so the attribute contract
  // normalizes it (LLP 0021 #the-attribute-contract).
  assert.equal(purgeResult[0].attributes.status, 'failed')
  // The log states no total either, matching the receipt's nulled counts
  // above: the middle partition below proves the abort's default zeros would
  // be a count over a run that deleted rows.
  assert.equal(purgeResult[0].attributes.rows_deleted, undefined, 'a failed run logs no row total')
  assert.equal(purgeResult[0].attributes.partitions_affected, undefined, 'a failed run logs no partition total')
  const survivors = []
  for await (const row of scanRowsFromTable(resolveIcebergDir(partitions[1]))) survivors.push(row.body)
  assert.equal(survivors.length, 1, 'the partition reached before the abort lost its matching row')
  const skipWarn = records.filter((/** @type {any} */ record) => record.body === 'purge.partition_skipped')
  assert.equal(skipWarn.length, 1)
  assert.equal(skipWarn[0].attributes[Attr.ERROR_KIND], PARTITION_MUTATION_BUSY_ERROR_KIND)
  for (const record of records) {
    assert.ok(!JSON.stringify(record.attributes).includes(root), 'telemetry carries no local filesystem path')
  }
})

// A thrown value's display string is not evidence that nothing was thrown:
// `new Error('')` reads as no error at all when a gate takes its message for
// truth (#2044), and so does an Error with no name either once `err.name` is
// the fallback (#2064). Both shapes must exit 1 over the surviving row.
for (const { shape, thrown, named } of [
  { shape: 'an empty error message', thrown: () => { throw new Error('') }, named: 'Error' },
  { shape: 'neither a message nor a name', thrown: () => { const err = new Error(''); err.name = ''; throw err }, named: 'unknown error' },
]) {
  test(`a local failure with ${shape} still fails and claims nothing`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-purge-opaque-failure-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    // A session purge drains the spool before it deletes, so the throw lands in
    // `flushAll`; `--all` skips that step, so there it lands on the cache root
    // the run reads next.
    /**
     * @param {ReturnType<typeof fixture>} made
     * @param {string} [trap]
     */
    const failing = (made, trap = 'flushAll') => {
      made.ctx.storage = new Proxy(made.storage, {
        get(target, key) {
          if (key === trap) return key === 'flushAll' ? async () => thrown() : thrown()
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return made
    }
    const seed = async (/** @type {any} */ storage) => {
      await storage.appendRowsToPartition('events', ['source=a'], columns, [{ session_id: 'delete', body: 'secret' }])
      await storage.flushAll({ force: true })
    }

    const plain = failing(fixture(root))
    await seed(plain.storage)
    assert.equal(await runPurge(['--session', 'delete', '--yes'], plain.ctx), 1, 'a failed purge exits 1')
    assert.doesNotMatch(plain.output(), /purged \d+ row/, 'nothing claims a completed deletion')
    assert.ok(plain.error().includes(`purge failed: ${named}\n`), 'the failure is still named on stderr')

    const json = failing(fixture(path.join(root, 'json')))
    await seed(json.storage)
    assert.equal(await runPurge(['--session', 'delete', '--yes', '--json'], json.ctx), 1)
    const receipt = JSON.parse(json.output())
    assert.equal(receipt.rowsDeleted, null, 'an aborted run reports no row total')
    assert.equal(receipt.local.status, 'incomplete')
    assert.equal(receipt.local.error, named, 'the receipt names a failure even with no message to name it by')

    // #2065: presence, not just the message. The equality above still holds
    // when the message is the only thing holding the block up, so this is the
    // assertion that pins the claim to the boolean rather than to the chain.
    assert.equal(typeof receipt.local.error, 'string', 'an incomplete local purge always carries an error field')
    assert.ok(receipt.local.error.length > 0, 'and that field always names a reason')

    // Off the session path the whole `local` block is conditional and its
    // absence is the shape of a clean run, so a claim keyed on the message
    // does not merely lose the reason, it loses the failure (#2065).
    const all = failing(fixture(path.join(root, 'all')), 'cacheRoot')
    await seed(all.storage)
    assert.equal(await runPurge(['--all', '--yes', '--json'], all.ctx), 1)
    const allReceipt = JSON.parse(all.output())
    assert.equal(allReceipt.local?.status, 'incomplete', 'a failed non-session purge still reports a local block')
    assert.equal(typeof allReceipt.local?.error, 'string', 'and an error field in it')
    assert.ok(allReceipt.local.error.length > 0, 'and that field always names a reason')

    // The point of the exit code: the row the user asked to be gone is still here.
    const rows = []
    for await (const row of scanRowsFromTable(resolveIcebergDir(json.storage.cacheTablePath('events', ['source=a'])))) rows.push(row.body)
    assert.deepEqual(rows, ['secret'], 'targeted rows survived, so no channel may report success')
  })
}
