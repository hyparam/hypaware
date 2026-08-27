// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { readCursorSync, writeCursor } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { aiGatewayDatasetRegistration, DATASET_NAME } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createClaudeSettlementEnricher } from '../../hypaware-core/plugins-workspace/claude/src/settle.js'
import { matchKey } from '../../hypaware-core/plugins-workspace/claude/src/transcripts.js'

/**
 * `cursor.pendingFallbacks` (LLP 0027 "Re-settle sweep", cursor-gated): the
 * count of committed rows still carrying the gateway provisional-identity
 * marker, maintained by the flush path and reset to the exact remainder by
 * every settle-bearing rewrite. It exists so the hourly maintenance tick
 * answers "does this partition hold a fallback row?" from the cursor
 * instead of decoding the table's whole attributes column - measured live,
 * that uncached scan OOMed the daemon every tick on a large gateway cache.
 *
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'conversation_id', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'conversation_source', type: 'STRING', nullable: true },
  { name: 'provider', type: 'STRING', nullable: true },
  { name: 'agent_id', type: 'STRING', nullable: true },
  { name: 'role', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'provider_uuid', type: 'STRING', nullable: true },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'part_index', type: 'INT32', nullable: false },
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'attributes', type: 'JSON', nullable: true },
]

const CONTENT = 'the answer is 42'
const SESSION = 'sess-pending'

// Heuristics never fire under this config, so the fallback gate is the only
// thing that can trigger a compaction (mirrors cache-resettle-sweep.test.js).
const NO_NATURAL_COMPACTION = { compact_file_count: 1000, compact_avg_file_bytes: 1 }

test('the flush path counts marker rows into the cursor; a fresh clean table starts at zero', async () => {
  const env = await stageEnv()
  try {
    const { storage } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    // Fresh partition, no marker rows: the first flush starts the count at a
    // concrete zero, so a table born after the field existed never pays the
    // legacy seeding scan.
    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })
    assert.equal(readCursorSync((await partitionDir(storage)).path).pendingFallbacks, 0)

    // A provisional fallback flushes (no transcript on disk, so flush-time
    // settle cannot upgrade it): the count follows.
    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    assert.equal(readCursorSync((await partitionDir(storage)).path).pendingFallbacks, 1)
  } finally {
    await env.cleanup()
  }
})

test('a settle-bearing rewrite resets the count to the exact remainder', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })

    // Unmatchable (no transcript): the sweep's rewrite keeps the row
    // provisional, and the cursor records exactly one survivor.
    await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.equal(readCursorSync((await partitionDir(storage)).path).pendingFallbacks, 1,
      'an unsettleable fallback survives the rewrite and stays counted')

    // The transcript lands, new data flushes (re-arming the baseline gate):
    // the next sweep collapses the pair and the count returns to zero.
    await writeTranscript(env, SESSION, [nativeAssistantLine()])
    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })
    await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.equal(readCursorSync((await partitionDir(storage)).path).pendingFallbacks, 0,
      'the settled partition reads back as clean')
  } finally {
    await env.cleanup()
  }
})

test('a legacy cursor is classified by one seeding scan whose verdict is written back', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })
    const part = await partitionDir(storage)

    // Simulate a cursor written before the field existed.
    const cursor = readCursorSync(part.path)
    delete cursor.pendingFallbacks
    await writeCursor(part.path, cursor)

    const report = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.equal(report.totalCompacted, 0, 'a clean legacy table triggers no rewrite')
    assert.equal(readCursorSync(part.path).pendingFallbacks, 0,
      'the not-found verdict is cached so the scan never re-runs')
  } finally {
    await env.cleanup()
  }
})

test('a legacy cursor over a marker row still routes to the sweep', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    await writeTranscript(env, SESSION, [nativeAssistantLine()])
    const part = await partitionDir(storage)

    const cursor = readCursorSync(part.path)
    delete cursor.pendingFallbacks
    await writeCursor(part.path, cursor)

    const report = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.ok(report.totalCompacted > 0, 'the seeding scan finds the marker and forces the sweep')
    assert.equal(readCursorSync(part.path).pendingFallbacks, 0,
      'the rewrite settles the row and records the exact remainder')
  } finally {
    await env.cleanup()
  }
})

test('the cursor is the gate: a count of zero skips the sweep the table would otherwise earn', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    // A committed, settleable marker row and its transcript: the old
    // attributes scan would find it and force a rewrite on every growth
    // tick. Flushed before the transcript lands so flush-time settle cannot
    // upgrade it away.
    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    await writeTranscript(env, SESSION, [nativeAssistantLine()])
    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })
    const part = await partitionDir(storage)

    // Now say the partition holds none. Nothing but the cursor changes, so
    // a tick that still consulted the table would compact; one that reads
    // the count does not. This is the whole point of the field, and the
    // reason a count that can drift low is the failure mode to fear.
    await writeCursor(part.path, { ...readCursorSync(part.path), pendingFallbacks: 0 })

    const report = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.equal(report.totalCompacted, 0, 'the cursor answered, the attributes column was never read')
    assert.equal(readCursorSync(part.path).pendingFallbacks, 0)
  } finally {
    await env.cleanup()
  }
})

test('a dry run classifies a legacy cursor without persisting the verdict', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })
    const part = await partitionDir(storage)
    const cursor = readCursorSync(part.path)
    delete cursor.pendingFallbacks
    await writeCursor(part.path, cursor)

    // A preview writes nothing, exactly as the rebaseline and the rewrite
    // do not. Seeding here would also make the preview unrepeatable: the
    // next run would read the cached answer instead of classifying.
    await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, dryRun: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.equal(readCursorSync(part.path).pendingFallbacks, undefined,
      'the dry run left the cursor exactly as it found it')
  } finally {
    await env.cleanup()
  }
})

test('an unreadable cursor is unknown, not a fresh partition claiming zero', async () => {
  const env = await stageEnv()
  try {
    const { storage } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    const part = await partitionDir(storage)

    // A torn or truncated cursor.json reads back as null, same as a missing
    // one. The table underneath still holds the marker row, so an append
    // that treated this as a brand-new partition would write a concrete
    // zero over it and strand the row: the seeding scan never runs again.
    await fs.writeFile(path.join(part.path, 'cursor.json'), '{ not json', 'utf8')
    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })

    assert.equal(readCursorSync(part.path).pendingFallbacks, undefined,
      'unknown survives the append; maintenance still owes this partition its one scan')
  } finally {
    await env.cleanup()
  }
})

test('a lost cursor over a live table is unknown too, not a fresh partition', async () => {
  const env = await stageEnv()
  try {
    const { storage } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    const part = await partitionDir(storage)

    // A crash between an append and its cursor write leaves the Iceberg
    // table committed and no cursor.json at all. The absence of the file is
    // not proof the partition is new: the marker row is still down there,
    // and a source-table partition without a cursor is not even discovered,
    // so nothing but the next append can restore one.
    await fs.rm(path.join(part.path, 'cursor.json'))
    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })

    assert.equal(readCursorSync(part.path).pendingFallbacks, undefined,
      'the restored cursor claims no count it cannot vouch for')
  } finally {
    await env.cleanup()
  }
})

// --- helpers ---------------------------------------------------------

/** @param {ReturnType<typeof createQueryStorageService>} storage */
async function partitionDir(storage) {
  const [part] = await storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
  assert.ok(part, 'the flush created a partition')
  return part
}

/**
 * @param {{ homeDir: string, stateFile: string, cacheRoot: string }} env
 */
function buildGateway(env) {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  api.registerSettlementEnricher(createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile }))
  const registration = aiGatewayDatasetRegistration(state)
  const storage = createQueryStorageService({
    cacheRoot: env.cacheRoot,
    getDeclaration: (dataset) => dataset === DATASET_NAME ? registration.cachePartitioning : undefined,
    getSettleHook: (dataset) => dataset === DATASET_NAME ? registration.settleBatch : undefined,
  })
  return { storage, getSettleHook: (/** @type {string} */ dataset) => dataset === DATASET_NAME ? registration.resettleBatch : undefined }
}

function fallbackRow() {
  return {
    session_id: SESSION,
    conversation_id: null,
    cwd: '/repo',
    date: '2026-05-22',
    client_name: 'claude',
    conversation_source: 'live',
    provider: 'anthropic',
    agent_id: 'ag1',
    role: 'assistant',
    message_id: 'fallbackhash16ab',
    provider_uuid: null,
    part_id: 'fallbackhash16ab#0',
    part_index: 0,
    content_text: CONTENT,
    attributes: {
      gateway: { identity_source: 'gateway_fallback', exchange_id: 'ex1' },
      claude: { match_key: matchKey('assistant', [{ type: 'text', text: CONTENT }]) },
    },
  }
}

function nativeRow() {
  return {
    session_id: SESSION,
    conversation_id: null,
    cwd: '/repo',
    date: '2026-05-22',
    client_name: 'claude',
    conversation_source: 'live',
    provider: 'anthropic',
    agent_id: 'ag1',
    role: 'assistant',
    message_id: 'u-assist',
    provider_uuid: 'u-assist',
    part_id: 'u-assist#0',
    part_index: 0,
    content_text: CONTENT,
    attributes: { gateway: { exchange_id: 'ex2' } },
  }
}

function nativeAssistantLine() {
  return JSON.stringify({
    sessionId: SESSION, uuid: 'u-assist', parentUuid: 'u-prompt', agentId: 'ag1', isSidechain: true,
    type: 'assistant',
    message: { id: 'msg_a', role: 'assistant', content: [{ type: 'text', text: CONTENT }] },
    timestamp: '2026-05-22T10:00:01.000Z',
  })
}

/** @returns {Promise<{ homeDir: string, cacheRoot: string, stateFile: string, cleanup: () => Promise<void> }>} */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-pending-'))
  const stateDir = path.join(homeDir, 'state')
  const cacheRoot = path.join(homeDir, 'cache')
  await fs.mkdir(stateDir, { recursive: true })
  await fs.mkdir(cacheRoot, { recursive: true })
  return {
    homeDir,
    cacheRoot,
    stateFile: path.join(stateDir, 'session-context.jsonl'),
    cleanup: async () => { await fs.rm(homeDir, { recursive: true, force: true }) },
  }
}

/** @param {{ homeDir: string }} env @param {string} sessionId @param {string[]} lines */
async function writeTranscript(env, sessionId, lines) {
  const dir = path.join(env.homeDir, '.claude', 'projects', 'repo')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8')
}
