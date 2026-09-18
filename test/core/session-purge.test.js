// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { createSessionPurgeStore } from '../../src/core/cache/session-purges.js'
import { runPurge } from '../../src/core/commands/purge.js'
import { deleteMatchingRows, listLiveDataFiles, scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'

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
