// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ByteWriter } from 'hyparquet-writer'
import { createIndex } from 'hypgrep'

import { urlToPath } from '../../src/core/cache/iceberg/resolver.js'
import { deleteMatchingRows, listLiveDataFiles } from '../../src/core/cache/iceberg/store.js'
import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { executeGrepSearch } from '../../src/core/search/grep_service.js'
import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

const DATASET = 'ai_gateway_messages'

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'conversation_id', type: 'STRING', nullable: true },
  { name: 'agent_id', type: 'STRING', nullable: true },
  { name: 'model', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'git_branch', type: 'STRING', nullable: true },
  { name: 'git_remote', type: 'STRING', nullable: true },
  { name: 'tool_name', type: 'STRING', nullable: true },
  { name: 'tool_args', type: 'JSON', nullable: true },
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
]

let rowSeq = 0

/**
 * A gateway-shaped row; `message_created_at` increases with insertion order
 * within a day so newest-first assertions are deterministic.
 *
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function mkRow(over = {}) {
  rowSeq += 1
  const date = typeof over.date === 'string' ? over.date : '2026-08-10'
  return {
    session_id: 's1',
    conversation_id: null,
    agent_id: null,
    model: 'claude-fable-5',
    cwd: '/home/open-proj',
    git_branch: null,
    git_remote: null,
    tool_name: null,
    tool_args: null,
    content_text: null,
    date,
    part_id: `m${rowSeq}#0`,
    message_id: `m${rowSeq}`,
    message_created_at: new Date(`${date}T00:00:00Z`).getTime() + rowSeq * 1000,
    client_name: 'test',
    ...over,
  }
}

/**
 * Build a real single-source cache: each batch is one Iceberg append, so
 * rows with distinct identity-partition tuples land in distinct data files.
 *
 * @param {Record<string, unknown>[][]} batches
 */
async function makeCache(batches) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-grep-service-'))
  const declaration = aiGatewayDatasetRegistration().cachePartitioning
  for (const batch of batches) {
    await appendRowsToSourceTable(cacheRoot, DATASET, ['source=test'], COLUMNS, batch, { declaration })
  }
  const storage = createQueryStorageService({
    cacheRoot,
    getDeclaration: (dataset) => (dataset === DATASET ? declaration : undefined),
  })
  return { cacheRoot, storage, tableDir: () => resolveIcebergDir(path.join(cacheRoot, 'datasets', DATASET, 'source=test')) }
}

/**
 * @param {ReturnType<typeof createQueryStorageService>} storage
 * @param {Record<string, unknown>} [over]
 */
function grep(storage, over = {}) {
  return executeGrepSearch(/** @type {any} */ ({
    storage,
    query: 'needle',
    limit: 10,
    includeLocalOnly: true,
    ...over,
  }))
}

/**
 * Build a hypgrep sidecar beside every live data file of the table, the
 * shape T6's maintenance pass will produce.
 *
 * @param {string} tableDir
 * @returns {Promise<number>} how many sidecars were written
 */
async function buildSidecars(tableDir) {
  const files = await listLiveDataFiles(tableDir)
  for (const file of files) {
    const sourcePath = urlToPath(file.filePath)
    const bytes = await fs.readFile(sourcePath)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const sourceFile = {
      byteLength: buffer.byteLength,
      /** @param {number} start @param {number} [end] */
      slice: (start, end) => buffer.slice(start, end),
    }
    const writer = new ByteWriter()
    await createIndex({ sourceFile, indexFile: writer })
    await fs.writeFile(sourcePath.replace(/\.parquet$/, '.index.parquet'), Buffer.from(writer.getBuffer()))
  }
  return files.length
}

const OLD = mkRow({ date: '2026-08-10', session_id: 's1', content_text: 'alpha needle one' })
const NEW = mkRow({
  date: '2026-08-12',
  session_id: 's2',
  conversation_id: 'c2',
  agent_id: 'a2',
  content_text: 'the needle two',
})

test('scan tier: hits carry locators and snippets, newest day first', async () => {
  const { storage } = await makeCache([[OLD], [NEW]])
  const res = await grep(storage)
  assert.equal(res.hits.length, 2)
  assert.equal(res.truncated, false)
  assert.equal(res.exhausted, true)
  assert.equal(res.indexedFiles, 0)
  assert.ok(res.scannedFiles >= 2, 'both files took the scan tier')
  const [first, second] = res.hits
  assert.equal(first.date, '2026-08-12')
  assert.equal(first.sessionId, 's2')
  assert.equal(first.conversationId, 'c2')
  assert.equal(first.agentId, 'a2')
  assert.equal(typeof first.messageId, 'string')
  assert.equal(typeof first.partId, 'string')
  assert.ok(first.messageCreatedAt, 'creation time surfaces on the hit')
  assert.equal(first.matches[0].column, 'content_text')
  assert.match(first.matches[0].snippet, /needle/)
  assert.equal(second.date, '2026-08-10')
})

test('scan tier: the limit truncates to the newest matches', async () => {
  const { storage } = await makeCache([[OLD], [NEW]])
  const res = await grep(storage, { limit: 1 })
  assert.equal(res.hits.length, 1)
  assert.equal(res.hits[0].date, '2026-08-12', 'the newest match survives truncation')
  assert.equal(res.truncated, true)
  assert.equal(res.exhausted, false)
})

test('scan tier: from/to narrow by day at the file walk', async () => {
  const { storage } = await makeCache([[OLD], [NEW]])
  const fromOnly = await grep(storage, { from: '2026-08-11' })
  assert.deepEqual(fromOnly.hits.map((h) => h.date), ['2026-08-12'])
  const toOnly = await grep(storage, { to: '2026-08-11' })
  assert.deepEqual(toOnly.hits.map((h) => h.date), ['2026-08-10'])
})

test('scan tier: session and chain predicates scope the walk', async () => {
  const { storage } = await makeCache([[OLD], [NEW]])
  const bySession = await grep(storage, { sessionId: 's1' })
  assert.deepEqual(bySession.hits.map((h) => h.sessionId), ['s1'])
  const byChain = await grep(storage, { sessionId: 's2', chainId: 'a2' })
  assert.deepEqual(byChain.hits.map((h) => h.sessionId), ['s2'])
  const wrongChain = await grep(storage, { sessionId: 's2', chainId: 'zz' })
  assert.equal(wrongChain.hits.length, 0)
})

test('literal matching is case-insensitive; regex mode is operator-shaped', async () => {
  const { storage } = await makeCache([[OLD], [NEW]])
  const upper = await grep(storage, { query: 'NEEDLE' })
  assert.equal(upper.hits.length, 2)
  const rx = await grep(storage, { query: 'ne+dle t.o', regex: true })
  assert.deepEqual(rx.hits.map((h) => h.sessionId), ['s2'])
})

test('the JSON column matches through cellText, and reports as the matched column', async () => {
  const toolRow = mkRow({
    date: '2026-08-11',
    session_id: 's3',
    tool_name: 'Read',
    tool_args: { file_path: '/repo/hidden_needle_path.js' },
  })
  const { storage } = await makeCache([[toolRow]])
  const res = await grep(storage, { query: 'hidden_needle_path' })
  assert.equal(res.hits.length, 1)
  assert.equal(res.hits[0].matches[0].column, 'tool_args')
  assert.match(res.hits[0].matches[0].snippet, /hidden_needle_path/)
})

test('local-only rows are withheld from lower-rank callers, and only from them', async () => {
  const openRow = mkRow({ date: '2026-08-10', session_id: 'open', cwd: '/home/open-proj', content_text: 'needle open' })
  const privateRow = mkRow({ date: '2026-08-12', session_id: 'priv', cwd: '/home/private-proj', content_text: 'needle private' })
  const { storage } = await makeCache([[openRow], [privateRow]])
  /** @type {UsagePolicyResolver} */
  const resolver = {
    resolve: (cwd) => ({
      class: cwd.includes('private') ? 'local-only' : 'full',
      governedBy: null,
      declared: null,
    }),
    isIgnored: () => false,
  }

  const fullCaller = await grep(storage, {
    includeLocalOnly: false, callerCwd: '/home/open-proj', usagePolicyResolver: resolver,
  })
  assert.deepEqual(fullCaller.hits.map((h) => h.sessionId), ['open'])
  assert.equal(fullCaller.localOnly.callerClass, 'full')
  assert.equal(fullCaller.localOnly.filtered, true)
  assert.equal(fullCaller.localOnly.withheldRows, 1)

  const noCwdCaller = await grep(storage, { includeLocalOnly: false, usagePolicyResolver: resolver })
  assert.deepEqual(noCwdCaller.hits.map((h) => h.sessionId), ['open'], 'no derivable cwd fails closed')
  assert.equal(noCwdCaller.localOnly.callerClass, 'unknown')

  const localOnlyCaller = await grep(storage, {
    includeLocalOnly: false, callerCwd: '/home/private-proj', usagePolicyResolver: resolver,
  })
  assert.equal(localOnlyCaller.hits.length, 2, 'an equal-rank caller sees the local-only row')
  assert.equal(localOnlyCaller.localOnly.withheldRows, 0)

  const withOverride = await grep(storage, {
    includeLocalOnly: true, callerCwd: '/home/open-proj', usagePolicyResolver: resolver,
  })
  assert.equal(withOverride.hits.length, 2, 'the override surfaces every row')
  assert.equal(withOverride.localOnly.filtered, false)
})

test('a purged row cannot surface from the scan tier', async () => {
  const { storage, tableDir } = await makeCache([[OLD], [NEW]])
  const deleted = await deleteMatchingRows(
    tableDir(),
    (row) => row.session_id === 's2',
    { columns: ['session_id'] }
  )
  assert.equal(deleted.rowsDeleted, 1)
  const res = await grep(storage)
  assert.deepEqual(res.hits.map((h) => h.sessionId), ['s1'])
})

test('indexed tier: sidecars serve every file with identical hits', async () => {
  const { storage, tableDir } = await makeCache([[OLD], [NEW]])
  const before = await grep(storage)
  const sidecars = await buildSidecars(tableDir())
  assert.ok(sidecars >= 2)
  const res = await grep(storage)
  assert.equal(res.indexedFiles, sidecars, 'every file was served through its sidecar')
  assert.equal(res.scannedFiles, 0)
  assert.deepEqual(res.hits, before.hits, 'the two tiers answer identically')
})

test('indexed tier: a query below the ngram length still answers exactly', async () => {
  const { storage, tableDir } = await makeCache([[OLD], [NEW]])
  await buildSidecars(tableDir())
  // 'dle' is shorter than hypgrep's default ngram, so the index proposes
  // every block and the shared matcher does the real work: slower, never
  // wrong (the LLP 0265 T7 "literal cliff" is performance, not truth).
  const res = await grep(storage, { query: 'dle' })
  assert.equal(res.hits.length, 2)
  assert.equal(res.indexedFiles >= 2, true)
})

test('indexed tier: a stale sidecar cannot resurrect a purged row', async () => {
  const { storage, tableDir } = await makeCache([[OLD], [NEW]])
  await buildSidecars(tableDir())
  await deleteMatchingRows(tableDir(), (row) => row.session_id === 's2', { columns: ['session_id'] })
  const res = await grep(storage)
  assert.ok(res.indexedFiles >= 1, 'the walk still ran through the sidecars')
  assert.deepEqual(res.hits.map((h) => h.sessionId), ['s1'], 'the purged row is filtered by position')
})

test('rows captured into the spool are found after the freshness flush', async () => {
  const { storage } = await makeCache([[OLD]])
  const spooled = mkRow({ date: '2026-08-13', session_id: 'spooled', content_text: 'fresh needle from the spool' })
  const labelTable = storage.cacheTablePath(DATASET, ['proxy_messages_v5'])
  await storage.appendRows(labelTable, COLUMNS, [spooled])
  const res = await grep(storage)
  assert.ok(
    res.hits.some((h) => h.sessionId === 'spooled'),
    'the spool was flushed by the search itself'
  )
})

test('an empty cache answers empty and exhausted', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-grep-empty-'))
  const storage = createQueryStorageService({ cacheRoot })
  const res = await grep(storage)
  assert.deepEqual(res.hits, [])
  assert.equal(res.truncated, false)
  assert.equal(res.exhausted, true)
})

test('an empty or oversized query refuses up front', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-grep-refuse-'))
  const storage = createQueryStorageService({ cacheRoot })
  await assert.rejects(() => grep(storage, { query: '' }), /non-empty/)
  await assert.rejects(() => grep(storage, { query: 'x'.repeat(2000) }), /at most/)
  await assert.rejects(() => grep(storage, { query: '(', regex: true }), /not a valid regular expression/)
})
