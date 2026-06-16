// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { aiGatewayDatasetRegistration, DATASET_NAME } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createClaudeSettlementEnricher } from '../../hypaware-core/plugins-workspace/claude/src/settle.js'
import { matchKey } from '../../hypaware-core/plugins-workspace/claude/src/transcripts.js'

/**
 * Re-settle sweep (LLP 0027 "Re-settle sweep"): the finalize-vs-transcript
 * race can commit a fallback-hash row ALONE — its transcript line not yet
 * on disk — and the uuid twin lands in a SEPARATE later flush. Flush-time
 * settlement only collapses twins that co-batch, so this split pair is a
 * permanent duplicate the flush path can never revisit. The maintenance
 * sweep re-runs the dataset's own settleBatch over the committed fallback
 * row during compaction, upgrades it to native identity, and dedupes it
 * against the committed uuid twin — collapsing the pair after the fact.
 *
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Minimal `ai_gateway_messages` column set sufficient to exercise the
 * partition declaration (conversation_id/cwd/date), the enricher's
 * transcript match (conversation_id, agent_id, attributes.claude.match_key)
 * and the part_id dedupe.
 *
 * @type {ColumnSpec[]}
 */
const COLUMNS = [
  { name: 'conversation_id', type: 'STRING', nullable: false },
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
const SESSION = 'sess-resettle'

test('re-settle sweep collapses a split fallback/uuid twin pair after the fact', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    // --- Reproduce the race: fallback row flushes ALONE while its
    // transcript line is NOT yet on disk, so the enricher can't upgrade it
    // at flush time and it commits as a provisional fallback. ---
    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })

    // The transcript line lands a few ms later, and the NEXT exchange
    // replays the message, writing it again under its native uuid in a
    // SEPARATE flush. settleBatch is a no-op for this batch (no fallback),
    // so the uuid twin commits alongside the orphaned fallback row.
    await writeTranscript(env, SESSION, [nativeAssistantLine()])
    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })

    // Pre-condition: flush-time settle could NOT fix the split — both the
    // fallback and the uuid twin are committed.
    const before = await readPartIds(storage, tablePath)
    assert.deepEqual(before.sort(), ['fallbackhash16ab#0', 'u-assist#0'].sort(),
      'the split leaves a permanent duplicate twin pair that flush-time settle never collapsed')

    // --- The sweep: maintenance compaction re-settles the committed
    // fallback row, upgrades it to u-assist#0, and collapses it onto the
    // committed uuid twin. ---
    const report = await maintainCache({
      cacheRoot: storage.cacheRoot,
      force: true,
      compactOnly: true,
      storage,
      getSettleHook,
    })
    assert.ok(report.totalCompacted > 0, 'the partition is rewritten')

    const after = await readPartIds(storage, tablePath)
    assert.deepEqual(after, ['u-assist#0'],
      'the pair collapses to the single native uuid row')

    // No fallback marker survives — the surviving row is fully native.
    const rows = await readRows(storage, tablePath)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].message_id, 'u-assist')
    const attrs = parseAttrs(rows[0].attributes)
    assert.equal(attrs?.gateway?.identity_source, undefined, 'fallback marker is cleared on the survivor')

    // --- Idempotency: a second sweep is a no-op (no fallback rows left). ---
    await maintainCache({ cacheRoot: storage.cacheRoot, force: true, compactOnly: true, storage, getSettleHook })
    const afterTwice = await readPartIds(storage, tablePath)
    assert.deepEqual(afterTwice, ['u-assist#0'], 're-running the sweep does not drop or duplicate the survivor')
  } finally {
    await env.cleanup()
  }
})

test('re-settle sweep upgrades a lone fallback row even when its twin never arrived', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    // Fallback flushes alone; the uuid twin never lands (e.g. the replay
    // exchange never happened), but the transcript line is now present.
    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    await writeTranscript(env, SESSION, [nativeAssistantLine()])

    await maintainCache({ cacheRoot: storage.cacheRoot, force: true, compactOnly: true, storage, getSettleHook })

    const after = await readPartIds(storage, tablePath)
    assert.deepEqual(after, ['u-assist#0'],
      'the lone fallback is upgraded to native identity (kept, not dropped — no twin to collapse onto)')
  } finally {
    await env.cleanup()
  }
})

test('re-settle sweep leaves the fallback row untouched when the transcript is unavailable', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    // Fallback flushes alone and the transcript line never lands. The
    // sweep must degrade safely: never drop a row it cannot prove is a
    // twin, leaving it as a provisional fallback for a later sweep.
    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })

    await maintainCache({ cacheRoot: storage.cacheRoot, force: true, compactOnly: true, storage, getSettleHook })

    const after = await readPartIds(storage, tablePath)
    assert.deepEqual(after, ['fallbackhash16ab#0'],
      'an unmatchable fallback survives unchanged (conservative degrade)')
    const rows = await readRows(storage, tablePath)
    const attrs = parseAttrs(rows[0].attributes)
    assert.equal(attrs?.gateway?.identity_source, 'gateway_fallback', 'still a provisional fallback')
  } finally {
    await env.cleanup()
  }
})

// Config under which the file-count/avg-size heuristics never fire, so the
// ONLY thing that can trigger a compaction is the fallback-marker auto-sweep.
const NO_NATURAL_COMPACTION = { compact_file_count: 1000, compact_avg_file_bytes: 1 }

test('a fallback marker auto-triggers compaction without force; a no-marker partition does not', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    // No-marker partition: a lone native row. needsCompaction is false here,
    // so without a fallback marker nothing should rewrite it.
    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })

    const noMarker = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.equal(noMarker.totalCompacted, 0, 'a partition with no fallback marker is left alone')

    // Now add a fallback marker in the SAME partition. It must commit
    // provisionally (transcript absent at flush time, or flush-time settle
    // would upgrade it and leave no marker); the transcript lands afterward.
    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    await writeTranscript(env, SESSION, [nativeAssistantLine()])

    const withMarker = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.ok(withMarker.totalCompacted > 0, 'the fallback marker alone triggers a non-force sweep')
    const after = await readPartIds(storage, tablePath)
    assert.deepEqual(after, ['u-assist#0'], 'the matched fallback collapsed onto the native twin')
  } finally {
    await env.cleanup()
  }
})

test('an unmatchable fallback does not force a rewrite every tick — only on new data', async () => {
  // Regression for the forced-rewrite loop: a fallback whose transcript never
  // lands stays a candidate forever. Without the re-settle baseline it would
  // force a full rewrite on every maintenance tick. The baseline makes the
  // sweep retry only when new data has flushed since the last rewrite.
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    // Unmatchable fallback (no transcript), flushed alone.
    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })

    const first = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.ok(first.totalCompacted > 0, 'first sweep rewrites once to attempt the re-settle')

    // No new data: the sweep must NOT rewrite again (the loop this fixes).
    const second = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.equal(second.totalCompacted, 0, 'an unchanged unmatchable fallback does not re-trigger a rewrite')

    // New data flushes in: the sweep is retried (the transcript may now exist).
    await storage.appendRows(tablePath, COLUMNS, [nativeRow()])
    await storage.flushTable(tablePath, { force: true })
    const third = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.ok(third.totalCompacted > 0, 'genuine new data re-triggers the sweep')

    // ...and once that rewrite settles, a further idle tick is again a no-op.
    const fourth = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.equal(fourth.totalCompacted, 0, 'no further rewrites without new data')
  } finally {
    await env.cleanup()
  }
})

// --- helpers ---------------------------------------------------------

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
    // The flush path still uses settleBatch (committed-scan dedupe);
    // maintenance uses resettleBatch (upgrade-only, de-twin in compaction).
    getSettleHook: (dataset) => dataset === DATASET_NAME ? registration.settleBatch : undefined,
  })
  return { storage, getSettleHook: (/** @type {string} */ dataset) => dataset === DATASET_NAME ? registration.resettleBatch : undefined }
}

function fallbackRow() {
  return {
    conversation_id: SESSION,
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
    conversation_id: SESSION,
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
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-resettle-'))
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

/**
 * Read every committed `ai_gateway_messages` row across all source-table
 * partitions. Rows flush to `source=<client_name>` (the declaration's
 * source columns), not the spool key, so the read discovers partitions
 * rather than assuming a path.
 *
 * @param {ReturnType<typeof createQueryStorageService>} storage
 * @param {string} _tablePath
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readRows(storage, _tablePath) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  const partitions = await storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
  for (const part of partitions) {
    if (typeof part.rowCount === 'number' && part.rowCount === 0) continue
    for await (const row of storage.readRows(part.path, ['conversation_id', 'message_id', 'part_id', 'attributes'])) {
      rows.push(row)
    }
  }
  return rows
}

/**
 * @param {ReturnType<typeof createQueryStorageService>} storage
 * @param {string} tablePath
 * @returns {Promise<string[]>}
 */
async function readPartIds(storage, tablePath) {
  const rows = await readRows(storage, tablePath)
  return rows.map((r) => String(r.part_id)).sort()
}

/** @param {unknown} attributes */
function parseAttrs(attributes) {
  if (typeof attributes === 'string') {
    try { return JSON.parse(attributes) } catch { return undefined }
  }
  return attributes
}
