// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fsSync from 'node:fs'
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
 * @import { PartitionCursor } from '../../src/core/cache/types.js'
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

test('a seeding scan that could not read the table caches no verdict; a later tick still sweeps', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    // A committed, settleable marker row and its transcript, under a cursor
    // from before the count existed: this partition is owed a seeding scan,
    // and the sweep that scan would force.
    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    await writeTranscript(env, SESSION, [nativeAssistantLine()])
    const part = await partitionDir(storage)
    const cursor = readCursorSync(part.path)
    delete cursor.pendingFallbacks
    await writeCursor(part.path, cursor)

    // The seeding tick cannot read the data files: the manifest still lists
    // them, but reading one throws (an EACCES on a live file, a torn write,
    // a half-copied cache). "Could not look" is not "looked and found
    // none", and only the second may be cached: the cached verdict is
    // permanent, so a zero written here strands the provisional row until
    // some later append happens to flip the count off zero.
    const dataFiles = await parquetFiles(part.path)
    assert.ok(dataFiles.length > 0, 'the flush committed at least one data file')
    const saved = new Map(dataFiles.map((file) => [file, fsSync.readFileSync(file)]))
    for (const file of dataFiles) await fs.writeFile(file, 'not a parquet file')
    /** @type {Awaited<ReturnType<typeof maintainCache>>} */
    let report
    try {
      report = await maintainCache({
        cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
        config: NO_NATURAL_COMPACTION,
      })
    } finally {
      for (const [file, bytes] of saved) await fs.writeFile(file, bytes)
    }
    assert.equal(report.totalCompacted, 0, 'an unreadable table is not rewritten')
    assert.equal(readCursorSync(part.path).pendingFallbacks, undefined,
      'a scan that failed must not be cached at all, as a zero or as anything else')

    // Nothing was cached, so the partition is still owed that scan. The
    // failed attempt is on a cooldown (LLP 0319) and an on-disk repair
    // changes nothing a cheap check could read, so the retry comes when
    // the window is up rather than on the very next tick; what matters
    // here is that it comes at all, and then routes to the sweep.
    await ageResettleScanStamp(part.path)
    const after = await maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    assert.ok(after.totalCompacted > 0, 'the retried scan finds the marker and forces the sweep')
    assert.equal(readCursorSync(part.path).pendingFallbacks, 0,
      'the rewrite settles the row and records the exact remainder')
  } finally {
    await env.cleanup()
  }
})

test('a scan that could not read the table is retried on a cooldown, never on every tick', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    // As above: a committed marker row and its transcript under a cursor
    // from before the count existed, so every tick owes this partition the
    // seeding scan.
    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    await writeTranscript(env, SESSION, [nativeAssistantLine()])
    const part = await partitionDir(storage)
    const legacy = readCursorSync(part.path)
    delete legacy.pendingFallbacks
    await writeCursor(part.path, legacy)

    // Permanently unreadable, not transiently: the bytes stay torn for the
    // whole run. A never-compacted partition has no re-settle baseline, so
    // the growth gate is permanently open and nothing else throttles the
    // retry.
    const dataFiles = await parquetFiles(part.path)
    assert.ok(dataFiles.length > 0, 'the flush committed at least one data file')
    const saved = new Map(dataFiles.map((file) => [file, fsSync.readFileSync(file)]))
    for (const file of dataFiles) await fs.writeFile(file, 'not a parquet file')

    // Count decode attempts at the only place they can happen: the local
    // Iceberg resolver reads a data file whole before hyparquet can throw
    // on it, so one read of a torn file is one attempted scan.
    const torn = new Set(dataFiles)
    const realReadFileSync = fsSync.readFileSync
    let scans = 0
    // @ts-ignore - test double over the resolver's one read seam
    fsSync.readFileSync = (target, ...rest) => {
      if (typeof target === 'string' && torn.has(target)) scans++
      // @ts-ignore
      return realReadFileSync(target, ...rest)
    }
    const tick = () => maintainCache({
      cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
      config: NO_NATURAL_COMPACTION,
    })
    try {
      for (let i = 0; i < 4; i++) {
        await tick()
        assert.equal(readCursorSync(part.path).pendingFallbacks, undefined,
          'a scan that could not look caches no verdict, on any tick')
      }
      assert.equal(scans, 1, 'four ticks, one attempted scan: the failure is on cooldown, not re-decoded hourly')

      // The cooldown delays the retry; it does not end it. Age the stamp
      // past the window and the next tick looks again - still unreadable,
      // still cached as nothing, and the window restarts.
      await ageResettleScanStamp(part.path)
      await tick()
      assert.equal(scans, 2, 'an aged-out stamp buys another look')
      assert.equal(readCursorSync(part.path).pendingFallbacks, undefined,
        'the second failure caches no verdict either')
      await tick()
      assert.equal(scans, 2, 'and the fresh stamp cools the retry down again')
    } finally {
      fsSync.readFileSync = realReadFileSync
      for (const [file, bytes] of saved) await fs.writeFile(file, bytes)
    }

    // Readable again: the partition resumes normal behaviour once its
    // window is up - the scan finds the marker and the sweep it forces
    // settles the row.
    await ageResettleScanStamp(part.path)
    const after = await tick()
    assert.ok(after.totalCompacted > 0, 'the retried scan finds the marker and forces the sweep')
    assert.equal(readCursorSync(part.path).pendingFallbacks, 0,
      'the rewrite settles the row and records the exact remainder')
    assert.equal(resettleScanStamp(readCursorSync(part.path)), undefined,
      'and the failure stamp is gone with the record that superseded it')
  } finally {
    await env.cleanup()
  }
})

test('a failure stamp that cannot be written costs a re-scan, not the partition\'s tick', async () => {
  const env = await stageEnv()
  try {
    const { storage, getSettleHook } = buildGateway(env)
    const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])

    await storage.appendRows(tablePath, COLUMNS, [fallbackRow()])
    await storage.flushTable(tablePath, { force: true })
    await writeTranscript(env, SESSION, [nativeAssistantLine()])
    const part = await partitionDir(storage)
    const legacy = readCursorSync(part.path)
    delete legacy.pendingFallbacks
    await writeCursor(part.path, legacy)

    const dataFiles = await parquetFiles(part.path)
    const saved = new Map(dataFiles.map((file) => [file, fsSync.readFileSync(file)]))
    for (const file of dataFiles) await fs.writeFile(file, 'not a parquet file')

    // The scan cannot read the table AND the cursor cannot be written: a
    // read-only partition directory, which is what an ENOSPC or a lost
    // write permission looks like from here - and one of the ways the torn
    // parquet got torn in the first place. The scan already swallows its
    // own error so an unreadable table cannot fail the partition's tick;
    // the stamp is bookkeeping on top of that and must not undo it.
    let report
    try {
      await fs.chmod(part.path, 0o555)
      report = await maintainCache({
        cacheRoot: storage.cacheRoot, compactOnly: true, storage, getSettleHook,
        config: NO_NATURAL_COMPACTION,
      })
    } finally {
      await fs.chmod(part.path, 0o755)
      for (const [file, bytes] of saved) await fs.writeFile(file, bytes)
    }

    assert.equal(report.totalFailed, 0, 'a stamp that could not be written is not a failed partition')
    assert.equal(report.partitions[0]?.failed, undefined, 'and the partition report says so too')
    assert.equal(report.totalCompacted, 0, 'an unreadable table is still not rewritten')
    // Unstamped, so the next tick simply re-scans: the pre-cooldown
    // behaviour, and still no verdict cached either way.
    assert.equal(resettleScanStamp(readCursorSync(part.path)), undefined, 'nothing was stamped')
    assert.equal(readCursorSync(part.path).pendingFallbacks, undefined,
      'and the failed scan cached no verdict')
  } finally {
    await env.cleanup()
  }
})

// --- helpers ---------------------------------------------------------

/**
 * The failure stamp a scan that could not read the table leaves on the
 * cursor, or undefined when there is none.
 * @param {PartitionCursor} cursor
 * @returns {string | undefined}
 */
function resettleScanStamp(cursor) {
  const c = cursor.compaction
  if (!c || typeof c !== 'object') return undefined
  const at = /** @type {Record<string, unknown>} */ (c).resettleScanFailedAt
  return typeof at === 'string' ? at : undefined
}

/**
 * Backdate that stamp past any plausible cooldown window, which is how a
 * test reaches "the window is up" without waiting for wall-clock hours.
 * @param {string} partitionPath
 */
async function ageResettleScanStamp(partitionPath) {
  const cursor = readCursorSync(partitionPath)
  assert.ok(resettleScanStamp(cursor), 'the failed scan stamped the cursor')
  const compaction = /** @type {Record<string, unknown>} */ (cursor.compaction)
  await writeCursor(partitionPath, {
    ...cursor,
    compaction: { ...compaction, resettleScanFailedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
  })
}

/**
 * Every committed parquet data file under a partition directory.
 * @param {string} partitionPath
 * @returns {Promise<string[]>}
 */
async function parquetFiles(partitionPath) {
  /** @type {string[]} */
  const found = []
  for (const entry of await fs.readdir(partitionPath, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.parquet')) found.push(path.join(entry.parentPath, entry.name))
  }
  return found
}

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
