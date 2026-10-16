// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { inventoryDay, inventoryKey, inventoryBucket, summarizeInventoryKeys } from '../../src/core/sinks/sync-inventory.js'
import { compareSyncInventory } from '../../src/core/commands/sync-check.js'
/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */
/** @import { AddressInfo } from 'node:net' */
/** @import { InventoryRequest } from '../../src/core/sinks/sync-inventory-types.js' */
import { runSync } from '../../src/core/commands/sync.js'

test('inventory identity vectors, dates, replay order and same-count replacements', () => {
  assert.equal(inventoryKey('part-a'), 'c0348eebd0b673a8a6471896e75277113a3fd1b1e250e74043ba048f70ef9f94')
  assert.equal(inventoryDay('2026-02-30'), 'undated')
  assert.equal(inventoryDay('2024-02-29'), '2024-02-29')
  assert.throws(() => inventoryKey(null), /part_id/)
  const a = inventoryKey('a'), b = inventoryKey('b')
  assert.deepEqual(summarizeInventoryKeys([a, b, a]), summarizeInventoryKeys([b, a]))
  assert.notEqual(summarizeInventoryKeys([a]).fingerprint, summarizeInventoryKeys([b]).fingerprint)
})

test('server extras reconcile once, then reuse a content-bound subset proof', async () => {
  const a = inventoryKey('a'), b = inventoryKey('b')
  const bucket = inventoryBucket('2020-01-01', a)
  const local = new Map([[bucket, new Set([a])]])
  let server = summarizeInventoryKeys([a, b])
  let pageReads = 0
  /** @param {InventoryRequest} body */
  const read = async body => {
    if (body.bucket) pageReads++
    return { version: 1, dataset: 'ai_gateway_messages', revision: 'a'.repeat(64), next: null,
      summaries: body.buckets.map(bucket => ({ bucket, count: server.count, fingerprint: server.fingerprint })),
      keys: body.bucket ? server.keys : undefined }
  }
  const proofs = new Set()
  assert.equal((await compareSyncInventory(local, read, proofs)).absent, 0)
  assert.equal(pageReads, 1)
  assert.equal((await compareSyncInventory(local, read, proofs)).absent, 0)
  assert.equal(pageReads, 1, 'unchanged org superset must not download keys again')
  server = summarizeInventoryKeys([b])
  assert.equal((await compareSyncInventory(local, read, proofs)).absent, 1)
  assert.equal(pageReads, 2, 'same-count replacement invalidates proof')
})

test('truncated pages and changing revisions cannot produce success', async () => {
  const a = inventoryKey('a'), b = inventoryKey('b')
  const bucket = inventoryBucket('2020-01-01', a)
  const summary = summarizeInventoryKeys([a, b])
  const local = new Map([[bucket, new Set([a])]])
  await assert.rejects(compareSyncInventory(local, async body => ({ version: 1, dataset: 'ai_gateway_messages', revision: 'a'.repeat(64), next: null,
    summaries: body.buckets.map(bucket => ({ bucket, count: summary.count, fingerprint: summary.fingerprint })), keys: [a] })), /incomplete/)
  let calls = 0
  await assert.rejects(compareSyncInventory(new Map(), async () => ({ version: 1, dataset: 'ai_gateway_messages', revision: (++calls === 1 ? 'a' : 'b').repeat(64), next: null, summaries: [] })), /changed/)
})

test('missing-row selection returns only verified day-bucket gaps', async () => {
  const present = inventoryKey('present'), absent = inventoryKey('absent')
  const extra = inventoryKey('other-machine')
  const day = '2020-01-01'
  const local = new Map()
  for (const key of [present, absent]) {
    const bucket = inventoryBucket(day, key)
    const keys = local.get(bucket) ?? new Set()
    keys.add(key)
    local.set(bucket, keys)
  }
  let revision = 'a'.repeat(64)
  /** @param {InventoryRequest} body */
  const read = async body => {
    const summary = bucket => summarizeInventoryKeys([present, extra].filter(key => inventoryBucket(day, key) === bucket))
    return { version: 1, dataset: 'ai_gateway_messages', revision, next: null,
      summaries: body.buckets.map(bucket => ({ bucket, ...summary(bucket) })),
      keys: body.bucket ? summary(body.bucket).keys : undefined }
  }
  const proofs = new Set()
  const plan = await compareSyncInventory(local, read, proofs, { includeMissing: true })
  assert.equal(plan.revision, revision)
  assert.equal(plan.absent, 1)
  assert.deepEqual([...plan.missing ?? []], [[inventoryBucket(day, absent), [absent]]])
  assert.equal((await compareSyncInventory(local, read, proofs)).missing, undefined, 'ordinary checks do not retain a repair selection')
  assert.deepEqual((await compareSyncInventory(local, read, proofs, { includeMissing: true })).missing, plan.missing,
    'cached subset proofs must not hide missing IDs')

  await assert.rejects(compareSyncInventory(local, async body => {
    if (body.buckets.length === 0) revision = 'b'.repeat(64)
    return read(body)
  }, proofs, { includeMissing: true }), /changed/, 'no selection escapes final revision validation')
})

test('check flags never enter upload or clear the first-sync hold', async () => {
  let output = ''
  const ctx = /** @type {any} */ ({ stdout: { write: s => { output += s } }, stderr: { write: s => { output += s } },
    sinks: { listHandles() { throw new Error('unexpected export handle access') } } })
  assert.equal(await runSync(['--check', '--json'], ctx), 2)
  assert.match(output, /unsupported/)
  for (const flags of [['--check', '--yes'], ['--check', '--missing'], ['--missing', '--history', 'codex'], ['--check', '--history', 'codex'], ['--from', '2020-01-01']]) {
    assert.equal(await runSync(flags, ctx), 2)
  }
})

test('CLI checks real retained history through privacy filters without uploading', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-check-cli-'))
  const storage = createQueryStorageService({ cacheRoot: path.join(tmp, 'cache'), usagePolicyResolver: {
    resolve: cwd => cwd === '/private' ? { class: 'local-only', governedBy: '/policy', declared: 'local-only' }
      : { class: 'full', governedBy: null, declared: null }, isIgnored: () => false,
  } })
  const tablePath = storage.cacheTablePath('ai_gateway_messages', ['all'])
  const columns = /** @type {ColumnSpec[]} */ ([{ name: 'part_id', type: 'STRING' }, { name: 'date', type: 'STRING' }, { name: 'cwd', type: 'STRING' }, { name: 'session_id', type: 'STRING' }])
  await storage.appendRows(tablePath, columns, [
    { part_id: 'pre-join', date: '2020-01-01', cwd: '/public' },
    { part_id: 'withheld', date: '2020-01-01', cwd: '/private' },
  ])
  await storage.flushTable(tablePath, { force: true })
  let requests = 0
  const routes = []
  const key = inventoryKey('pre-join'), bucket = inventoryBucket('2020-01-01', key)
  const server = createServer(async (req, res) => {
    routes.push(req.url)
    requests++
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ version: 1, dataset: 'ai_gateway_messages', org: 'test-org', revision: 'a'.repeat(64), next: null,
      summaries: body.buckets.map(b => ({ bucket: b, ...summarizeInventoryKeys(b === bucket ? [key] : []) })),
      keys: body.bucket === bucket ? [key] : [] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`
  let output = ''
  const sent = []
  const ctx = /** @type {any} */ ({ env: { HYP_HOME: tmp, HYP_REMOTE_TOKEN_TEST: 'test-read-token' },
    config: { version: 2, query: { remotes: { test: { url } } } }, storage,
    stdout: { write: s => { output += s } }, stderr: { write: s => { output += s } },
    query: { getDataset: () => ({ discoverPartitions: async () => [{ dataset: 'ai_gateway_messages', tablePath },
      ...(await storage.discoverCachePartitions()).map(part => ({ dataset: part.dataset, tablePath: part.path }))] }) },
    sinks: { listHandles: () => [{ instanceName: 'central', config: { url }, export() { throw new Error('must not upload') },
      sink: { async restoreMissingRows(request) {
        await request.validate()
        assert.equal(request.org, 'test-org')
        assert.equal(request.revision, 'a'.repeat(64))
        sent.push(...request.rows)
        return { syncRestore: 1, status: 'accepted', restored: request.rows.length, present: 0, purged: 0 }
      } } }] },
  })
  const argv = ['central', '--check', '--dataset', 'ai_gateway_messages', '--json']
  try {
    assert.equal(await runSync(argv, ctx), 0, output)
    assert.equal(JSON.parse(output).local, 1, 'pre-join included and private row excluded')
    assert.equal(JSON.parse(output).status, 'matched')
    const before = requests
    await storage.appendRows(tablePath, columns, [{ part_id: 'absent', date: '2020-01-01', cwd: '/public', session_id: 's' }])
    output = ''
    assert.equal(await runSync(argv, ctx), 2, output)
    assert.equal(requests, before, 'pending spool blocks the check before any HTTP call')
    await storage.flushTable(tablePath, { force: true })
    output = ''
    assert.equal(await runSync(argv, ctx), 1, output)
    assert.equal(JSON.parse(output).absent, 1)
    assert.ok(routes.every(route => route === '/v1/sync-inventory'), 'no ingest or refresh requests')
    const repair = ['central', '--missing', '--dataset', 'ai_gateway_messages', '--json']
    output = ''
    assert.equal(await runSync([...repair, '--dry-run'], ctx), 0, output)
    assert.equal(JSON.parse(output).candidates, 1)
    assert.equal(sent.length, 0)
    output = ''
    assert.equal(await runSync(repair, ctx), 2, 'noninteractive upload requires --yes')
    assert.equal(sent.length, 0)
    output = ''
    assert.equal(await runSync([...repair, '--yes'], ctx), 0, output)
    assert.deepEqual(sent.map(row => row.part_id), ['absent'], 'only missing export-eligible rows reach the sink')
    assert.equal(JSON.parse(output).restored, 1)
    output = ''
    assert.equal(await runSync([...argv, '--from', 'undated'], ctx), 2)
    const [part] = await storage.discoverCachePartitions()
    await fs.writeFile(path.join(part.path, 'cursor.json'), '{')
    output = ''
    assert.equal(await runSync(argv, ctx), 2, 'an unreadable cursor cannot mean empty history')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
