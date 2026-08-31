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
  // Exhausted, because the walk covered everything that could have changed
  // the answer: the day-descending break fires only once the buffer holds
  // hits strictly newer than every file left, which is a proof, not a
  // surrender. Reporting it as unexhausted made the verb's "results may be
  // incomplete" line the answer to an ordinary capped search.
  assert.equal(res.exhausted, true)
})

test('the limit keeps the newest matches inside one file, not the first ones walked', async () => {
  // One append, so all ten rows share a data file and the newest-day file
  // walk cannot order them: only sort-order truncation can. Rows land in
  // insertion order, which is oldest first, so a walk-order cut would answer
  // m1..m3.
  const batch = []
  for (let i = 0; i < 10; i++) batch.push(mkRow({ date: '2026-08-14', content_text: `needle body ${i}` }))
  const { storage } = await makeCache([batch])
  const all = await grep(storage, { limit: 100 })
  assert.equal(all.hits.length, 10)
  const newest = all.hits.slice(0, 3).map((h) => h.messageId)
  const capped = await grep(storage, { limit: 3 })
  assert.deepEqual(capped.hits.map((h) => h.messageId), newest, 'the newest three survive the limit')
  assert.equal(capped.truncated, true)
  assert.equal(capped.exhausted, true, 'one file, read whole: the limit cut the answer, the walk did not')
})

test('truncation and interruption are two facts, and a search can carry both', async () => {
  // `exhausted: exhausted && !truncated` collapsed them, so a search that
  // filled its limit AND stopped early reported only "raise --limit" -
  // advice that cannot reach the files the walk never opened. The newest
  // file alone overfills a limit of 1, and the abort is observed at the
  // next file boundary, where `throwIfAborted` runs ahead of the
  // day-descending break: so the walk really does leave a file unread.
  const controller = new AbortController()
  // One session and one day, so the identity partition puts both rows in
  // ONE data file: the file has to overfill the limit by itself for the
  // abort at the next boundary to leave a genuinely unread file behind.
  const newest = [
    mkRow({ date: '2026-08-13', session_id: 'a', cwd: '/home/rows', content_text: 'needle one' }),
    mkRow({ date: '2026-08-13', session_id: 'a', cwd: '/home/rows', content_text: 'needle two' }),
  ]
  const older = [mkRow({ date: '2026-08-10', session_id: 'c', cwd: '/home/rows', content_text: 'needle three' })]
  const { storage } = await makeCache([newest, older])
  /** @type {UsagePolicyResolver} */
  const resolver = {
    // The visibility predicate runs per matched row, which makes it the one
    // deterministic place to land an abort mid-walk: it fires inside the
    // first file, and the walk observes it at the next file boundary.
    resolve: (cwd) => {
      if (cwd === '/home/rows') controller.abort()
      return { class: 'full', governedBy: null, declared: null }
    },
    isIgnored: () => false,
  }
  const res = await grep(storage, {
    limit: 1,
    includeLocalOnly: false,
    callerCwd: '/home/caller',
    usagePolicyResolver: resolver,
    signal: controller.signal,
  })
  assert.equal(res.truncated, true, 'the first file alone overfilled the limit')
  assert.equal(res.exhausted, false, 'and the abort left files unread')
})

test('a chain id alone scopes the walk, with no session id beside it', async () => {
  const { storage } = await makeCache([[OLD], [NEW]])
  const byChain = await grep(storage, { chainId: 'a2' })
  assert.deepEqual(byChain.hits.map((h) => h.sessionId), ['s2'])
  const byConversation = await grep(storage, { chainId: 'c2' })
  assert.deepEqual(byConversation.hits.map((h) => h.sessionId), ['s2'])
  const unknownChain = await grep(storage, { chainId: 'zz' })
  assert.equal(unknownChain.hits.length, 0, 'an unmatched chain id filters, it does not fall open')
})

test('a deadline signal returns the partial answer rather than throwing', async () => {
  const { storage } = await makeCache([[OLD], [NEW]])
  // AbortSignal.timeout's reason is a DOMException named TimeoutError, not
  // AbortError: the deadline shape the service is built for.
  const deadline = AbortSignal.timeout(1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const res = await grep(storage, { signal: deadline })
  assert.equal(res.exhausted, false, 'an aborted walk is not exhausted')
  const controller = new AbortController()
  controller.abort()
  const plain = await grep(storage, { signal: controller.signal })
  assert.equal(plain.exhausted, false)
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

test('a row matching only in tool_args returns zero hits from BOTH tiers', async () => {
  // The invariant is tier agreement, not coverage. `tool_args` is VARIANT,
  // the index worker filters it out, so an indexed file can never answer a
  // match through it; the scan tier must therefore not answer one either.
  // Dropping the column from the allowlist is what makes the two agree, and
  // hyparam/hypaware#977 is where they would agree the other way instead.
  const toolRow = mkRow({
    date: '2026-08-11',
    session_id: 's3',
    tool_name: 'Read',
    tool_args: { file_path: '/repo/hidden_needle_path.js' },
  })
  const { storage, tableDir } = await makeCache([[toolRow]])

  const scanned = await grep(storage, { query: 'hidden_needle_path' })
  assert.equal(scanned.hits.length, 0)
  assert.equal(scanned.indexedFiles, 0)
  assert.ok(scanned.scannedFiles >= 1, 'the scan tier really read the file')

  assert.ok(await buildSidecars(tableDir()) >= 1, 'a sidecar was built')
  const indexed = await grep(storage, { query: 'hidden_needle_path' })
  assert.equal(indexed.hits.length, 0)
  assert.equal(indexed.scannedFiles, 0)
  assert.ok(indexed.indexedFiles >= 1, 'the indexed tier really served the file')

  // The row itself is still reachable, so the zero above is the column
  // being unsearchable rather than the row being missing.
  const byName = await grep(storage, { query: 'Read' })
  assert.deepEqual(byName.hits.map((h) => h.sessionId), ['s3'])
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

// The sidecar is the whole answer for a file it prunes to zero blocks, so
// nothing should open the source: not to read it, and not to read its footer
// for the physical projection. Deleting the data files and keeping the
// sidecars is how that is observable from outside - it is also the real
// failure it prevents, since a concurrent compaction or purge unlinks data
// files under a running walk. On a tree that opens the source first this
// fails the whole query with ENOENT before the index is ever consulted.
test('indexed tier: a file the index prunes to nothing is answered without opening it', async () => {
  const { storage, tableDir } = await makeCache([[OLD], [NEW]])
  await buildSidecars(tableDir())
  const files = await listLiveDataFiles(tableDir())
  for (const file of files) await fs.rm(urlToPath(file.filePath))
  // Long enough to yield n-grams, and present in no block of either file.
  const res = await grep(storage, { query: 'quixotic-haberdashery' })
  assert.deepEqual(res.hits, [])
  assert.equal(res.indexedFiles, files.length, 'the sidecar served every file whole')
  assert.equal(res.scannedFiles, 0, 'nothing fell through to the scan tier')
})

test('indexed tier: a poisoned sidecar degrades that file, it does not fail the search', async () => {
  const { storage, tableDir } = await makeCache([[OLD], [NEW]])
  const before = await grep(storage)
  await buildSidecars(tableDir())
  // A half-written index: the file exists, so the existence probe accepts
  // it, and the footer parse inside parquetFind is what fails. LLP 0264
  // #lifecycle makes index state a performance property only, so this one
  // file falls back to the scan tier and the answer is unchanged.
  const files = await listLiveDataFiles(tableDir())
  const poisoned = urlToPath(files[0].filePath).replace(/\.parquet$/, '.index.parquet')
  await fs.writeFile(poisoned, 'PAR1 not really an index')
  const res = await grep(storage)
  assert.deepEqual(res.hits, before.hits, 'the poisoned file still answers, through the scan tier')
  assert.equal(res.scannedFiles, 1, 'exactly the poisoned file degraded')
  assert.equal(res.indexedFiles, files.length - 1)
})

test('indexed tier: an unreadable sidecar degrades that file rather than throwing', async () => {
  const { storage, tableDir } = await makeCache([[NEW]])
  const before = await grep(storage)
  await buildSidecars(tableDir())
  const files = await listLiveDataFiles(tableDir())
  const sidecar = urlToPath(files[0].filePath).replace(/\.parquet$/, '.index.parquet')
  // A directory where the sidecar should be: the probe sees it, the read
  // fails with EISDIR rather than the ENOENT the delete race produces.
  await fs.rm(sidecar)
  await fs.mkdir(sidecar)
  const res = await grep(storage)
  assert.deepEqual(res.hits, before.hits)
  assert.equal(res.indexedFiles, 0)
  assert.equal(res.scannedFiles, files.length)
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

test('automatic refresh searches confirmed rows when the spool cannot enter the hot cache', async () => {
  // The blocked write is produced, not stubbed. A stubbed `flushTable` never
  // rotates the spool or reaches `appendChunk`, so the retention assertion
  // below would hold by construction rather than by the code under test.
  // Here the committed table carries the shipped date-only spec while the
  // running declaration still calls session_id a partition field, which is
  // the exact 1.27-to-1.28 spec-evolution rejection LLP 0321 quotes.
  const { cacheRoot } = await makeCache([[OLD]])
  const shipped = aiGatewayDatasetRegistration().cachePartitioning
  assert.ok(shipped, 'the gateway dataset declares cache partitioning')
  const preDatePartition = {
    source: shipped.source,
    iceberg: {
      fields: shipped.iceberg.fields.map((field) => (
        field.column === 'session_id'
          ? { column: 'session_id', transform: /** @type {const} */ ('identity'), required: true }
          : field
      )),
    },
  }
  const storage = createQueryStorageService({
    cacheRoot,
    getDeclaration: (dataset) => (dataset === DATASET ? preDatePartition : undefined),
  })
  const spooled = mkRow({
    date: '2026-08-13',
    session_id: 'waiting',
    content_text: 'waiting needle blocked by the old cache layout',
  })
  const labelTable = storage.cacheTablePath(DATASET, ['proxy_messages_v5'])
  await storage.appendRows(labelTable, COLUMNS, [spooled])

  const automatic = await grep(storage, { refresh: 'auto' })
  assert.deepEqual(automatic.hits.map((hit) => hit.sessionId), ['s1'])
  assert.equal(
    automatic.freshnessMessages[0],
    'cache: refresh failed; using previously saved data; newer waiting rows may be missing'
  )
  // The real rejection's message rides beside the warning, bounded; matched
  // rather than equalled because it is produced by the real cache, not a
  // fixture this file wrote.
  // @ref LLP 0330#query-quotes-the-reason [tests]:
  assert.equal(automatic.freshnessMessages.length, 2)
  assert.match(
    automatic.freshnessMessages[1],
    /^cache: last refresh attempt failed: .*partition field "session_id" is new/
  )
  assert.equal((await storage.pendingInfo(labelTable)).pending, true, 'the failed flush leaves its rows in the spool')
  /** @type {unknown[]} */
  const retained = []
  for await (const row of storage.readSpooledRows(DATASET)) retained.push(row.message_id)
  assert.deepEqual(retained, [spooled.message_id], 'the waiting row is neither dropped nor acknowledged')

  await assert.rejects(
    () => grep(storage, { refresh: 'always' }),
    /partition field "session_id" is new/
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

test('a missing or non-positive limit refuses up front', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-grep-limit-'))
  const storage = createQueryStorageService({ cacheRoot })
  await assert.rejects(() => grep(storage, { limit: undefined }), /positive integer/)
  await assert.rejects(() => grep(storage, { limit: 0 }), /positive integer/)
  await assert.rejects(() => grep(storage, { limit: -1 }), /positive integer/)
  await assert.rejects(() => grep(storage, { limit: 2.5 }), /positive integer/)
})

test('unreadable table metadata fails the search rather than answering zero', async () => {
  const { storage, cacheRoot } = await makeCache([[OLD], [NEW]])
  const metadataDir = path.join(resolveIcebergDir(path.join(cacheRoot, 'datasets', DATASET, 'source=test')), 'metadata')
  for (const name of await fs.readdir(metadataDir)) {
    if (name.endsWith('.metadata.json')) await fs.writeFile(path.join(metadataDir, name), '{ truncated')
  }
  await assert.rejects(() => grep(storage), 'a corrupt table raises, matching the SQL read path')
})
