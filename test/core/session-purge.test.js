// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { createSessionPurgeStore, sessionGraphNodeId } from '../../src/core/cache/session-purges.js'
import { runPurge } from '../../src/core/commands/purge.js'
import { appendRowsToTable, deleteMatchingRows, listLiveDataFiles, scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'

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
    assert.equal(String(url), 'https://hypaware.hyperparam.app/v1/sessions/purge')
    calls++
    return Response.json({ status: 'completed', session_id: 'delete' })
  }
  assert.equal(await runPurge(['--session', 'delete', '--yes'], ctx), 0)
  assert.equal(calls, 1)
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
