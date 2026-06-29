// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { validateEnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/config.js'
import { collectCurateJob, pollUntilEnded, runCurateBatch, submitCurateJob } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/batch.js'
import { readState, writeState } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/state.js'

/**
 * @import { EnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/types.js'
 */

/** @returns {EnrichConfig} */
function cfg(overrides = {}) {
  const result = validateEnrichConfig(overrides)
  if (!result.ok) throw new Error('test config invalid')
  return result.config
}

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-batch-'))
}

/** @param {Record<string, unknown>} [o] */
function prospectRow(o = {}) {
  return {
    prospect_id: 'pid',
    prospect_type: 'Decision',
    label: 'X',
    props: null,
    confidence: null,
    anchor_type: 'Session',
    anchor_key: 'A',
    source_dataset: 'ai_gateway_messages',
    source_keys: { message_id: ['m1'] },
    ...o,
  }
}

/**
 * @param {string} query
 * @param {Record<string, Record<string, unknown>[]>} tables
 */
function fakeQuery(query, tables) {
  const m = /FROM\s+(\w+)/i.exec(query)
  const name = m ? m[1] : ''
  return tables[name] ? [...tables[name]] : []
}

/** Build a CompletionResult carrying a curate_decisions tool call. */
function decisionResult(decisions) {
  return { model: 'm', stopReason: 'tool_use', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'curate_decisions', input: { decisions } }] } }
}

/**
 * Fake batch capability. `poll` returns `status`; `results` maps each customId
 * to the decisions configured for it. Records submitted requests.
 *
 * @param {{ status?: string, decisionsByCustom?: Record<string, Array<Record<string, unknown>>> }} [opts]
 */
function fakeBatch(opts = {}) {
  const status = opts.status ?? 'ended'
  /** @type {Array<Array<{ customId: string }>>} */
  const submitted = []
  let polls = 0
  return {
    _submitted: submitted,
    getPolls: () => polls,
    async submit(/** @type {Array<{ customId: string }>} */ requests) {
      submitted.push(requests)
      return { id: 'batch_1', status: 'in_progress' }
    },
    async poll() {
      polls++
      return { id: 'batch_1', status }
    },
    async results() {
      const d = opts.decisionsByCustom ?? {}
      return Object.keys(d).map((customId) => ({ customId, result: decisionResult(d[customId]) }))
    },
  }
}

/**
 * Fake EnrichRuntime for the batch paths: in-memory tables + a stub completion
 * carrying the fake `batch`, plus a stub embedder returning identical vectors so
 * the no-recall pool collapses into a single cluster (customId `c0`).
 *
 * @param {{ cfg: EnrichConfig, stateDir: string, prospects: Record<string, unknown>[], batch?: any, syncDecisions?: Array<Record<string, unknown>> }} args
 */
function batchRuntime({ cfg, stateDir, prospects, batch, syncDecisions }) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {
    enrichment_prospects: [...prospects],
    enrichment_resolutions: [],
    enrichment_committed: [],
    [cfg.source_dataset]: [],
  }
  let syncCalls = 0
  const completion = {
    provider: 'anthropic',
    ...(batch ? { batch } : {}),
    async complete() {
      syncCalls++
      return decisionResult(syncDecisions ?? [])
    },
  }
  const runtime = /** @type {any} */ ({
    config: cfg,
    stateDir,
    _completion: completion,
    _vector: { async search() { return [] } },
    _embedder: { async embed(/** @type {string[]} */ texts) { return { vectors: texts.map(() => new Float32Array([1, 0, 0])), dimension: 3, model: 'fake' } } },
    log: { info() {}, warn() {}, error() {} },
    storage: {
      cacheTablePath: (/** @type {string} */ dataset) => dataset,
      appendRows: async (/** @type {string} */ p, /** @type {unknown} */ _cols, /** @type {Record<string, unknown>[]} */ rows) => {
        ;(tables[p] ??= []).push(...rows)
      },
    },
    execSql: async (/** @type {{ query: string }} */ { query }) => ({ rows: fakeQuery(query, tables) }),
  })
  return { runtime, tables, getSyncCalls: () => syncCalls }
}

// --- pollUntilEnded ----------------------------------------------------------

test('pollUntilEnded polls until the job ends, reporting progress', async () => {
  let n = 0
  /** @type {string[]} */
  const seen = []
  const batch = /** @type {any} */ ({
    async poll() {
      n++
      return { id: 'b', status: n >= 2 ? 'ended' : 'in_progress' }
    },
  })
  const final = await pollUntilEnded(batch, 'b', { intervalMs: 1, onProgress: (s) => seen.push(s.status) })
  assert.equal(final.status, 'ended')
  assert.deepEqual(seen, ['in_progress', 'ended'])
})

// --- runCurateBatch (backfill: submit → poll → collect in one run) -----------

test('runCurateBatch submits the whole pool as a batch, collects, and routes the results', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [
      prospectRow({ prospect_id: 'p1', label: 'Use Redis', anchor_key: 'A', source_keys: { message_id: ['mA'] } }),
      prospectRow({ prospect_id: 'p2', label: 'Use Redis', anchor_key: 'B', source_keys: { message_id: ['mB'] } }),
    ]
    // Identical embeddings → one cluster (c0). Curator commits p1, merges p2.
    const batch = fakeBatch({ decisionsByCustom: { c0: [{ index: 1, decision: 'commit', item_key: 'redis-key', item_type: 'Decision' }, { index: 2, decision: 'merge', merge_into: 'redis-key', item_type: 'Decision' }] } })
    const { runtime, tables } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch })

    const r = await runCurateBatch(runtime, { intervalMs: 1 })

    assert.equal(r.batched, true)
    assert.equal(r.clusters, 1)
    assert.equal(r.committed, 2, 'commit + merge each write a committed row')
    assert.equal(r.merged, 1)
    assert.equal(batch._submitted.length, 1, 'one batch submitted')
    assert.equal(batch._submitted[0].length, 1, 'one request (one cluster)')
    assert.deepEqual(tables.enrichment_committed.map((c) => c.anchor_key).sort(), ['A', 'B'])
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runCurateBatch falls back to a synchronous tick when the provider has no batch API', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [prospectRow({ prospect_id: 'p1', label: 'X' })]
    const { runtime, tables, getSyncCalls } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch: undefined, syncDecisions: [{ index: 1, decision: 'commit' }] })

    const r = await runCurateBatch(runtime, {})

    assert.equal(r.batched, false)
    assert.equal(getSyncCalls(), 1, 'fell back to the synchronous complete() path')
    assert.equal(tables.enrichment_committed.length, 1)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

// --- runCurateBatch: --dry-run, resume, and cross-regime ownership ----------

test('runCurateBatch --dry-run reports the scoped pool + clusters and writes nothing', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [
      prospectRow({ prospect_id: 'p1', label: 'Use Redis', anchor_key: 'A' }),
      prospectRow({ prospect_id: 'p2', label: 'Use Redis', anchor_key: 'B' }),
    ]
    const batch = fakeBatch({ decisionsByCustom: { c0: [{ index: 1, decision: 'commit' }] } })
    const { runtime, tables } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch })

    const r = await runCurateBatch(runtime, { dryRun: true })

    assert.equal(r.dryRun, true)
    assert.equal(r.batched, false)
    assert.equal(r.pending, 2, 'both pending prospects counted')
    assert.equal(r.clusters, 1, 'identical embeddings → one cluster')
    assert.equal(batch._submitted.length, 0, 'dry run submits no batch')
    assert.equal(tables.enrichment_committed.length, 0, 'dry run commits nothing')
    assert.equal(tables.enrichment_resolutions.length, 0, 'dry run writes no resolutions')
    assert.equal(readState(stateDir).curate_job, null, 'dry run persists no job')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runCurateBatch --dry-run scopes the pool to --since anchorKeys', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [
      prospectRow({ prospect_id: 'p1', label: 'X', anchor_key: 'in' }),
      prospectRow({ prospect_id: 'p2', label: 'Y', anchor_key: 'out' }),
    ]
    const { runtime } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch: fakeBatch() })

    const r = await runCurateBatch(runtime, { dryRun: true, anchorKeys: new Set(['in']) })

    assert.equal(r.pending, 1, 'only the in-window prospect is counted')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runCurateBatch resumes a pre-persisted backfill job (collects, does not re-submit)', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [prospectRow({ prospect_id: 'p1', label: 'Use Redis', anchor_key: 'A' })]
    // A backfill job already submitted (the crash-before-collect state).
    writeState(stateDir, {
      schema_version: 4,
      session_marks: {},
      curate_job: { id: 'batch_1', submitted_at: '2026-06-15T00:00:00.000Z', source: 'backfill', clusters: [{ customId: 'c0', prospectIds: ['p1'] }] },
    })
    const batch = fakeBatch({ status: 'ended', decisionsByCustom: { c0: [{ index: 1, decision: 'commit', item_key: 'k', item_type: 'Decision' }] } })
    const { runtime, tables } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch })

    const r = await runCurateBatch(runtime, { intervalMs: 1 })

    assert.equal(r.batched, true)
    assert.equal(batch._submitted.length, 0, 'resume collects the existing job - no second (re-billed) submit')
    assert.equal(r.pending, 1, 'pending recomputed from the scoped pool, not a placeholder 0')
    assert.equal(r.processed, 1)
    assert.equal(tables.enrichment_committed.length, 1, 'the resumed job committed its result')
    assert.equal(readState(stateDir).curate_job, null, 'the resumed job is cleared after collection')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runCurateBatch refuses to run while a daemon curate job is in flight (no clobber)', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [prospectRow({ prospect_id: 'p1', label: 'X' })]
    writeState(stateDir, {
      schema_version: 4,
      session_marks: {},
      curate_job: { id: 'daemon_99', submitted_at: '2026-06-15T00:00:00.000Z', source: 'daemon', clusters: [{ customId: 'c0', prospectIds: ['p1'] }] },
    })
    const batch = fakeBatch({ decisionsByCustom: { c0: [{ index: 1, decision: 'commit' }] } })
    const { runtime } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch })

    await assert.rejects(() => runCurateBatch(runtime, { intervalMs: 1 }), /daemon curate batch job is in flight/)
    assert.equal(batch._submitted.length, 0, 'refusal submits nothing')
    assert.equal(readState(stateDir).curate_job?.id, 'daemon_99', "the daemon's job is left untouched")
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a daemon tick (collectCurateJob) leaves a backfill job untouched', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [prospectRow({ prospect_id: 'p1', label: 'X' })]
    writeState(stateDir, {
      schema_version: 4,
      session_marks: {},
      curate_job: { id: 'backfill_7', submitted_at: '2026-06-15T00:00:00.000Z', source: 'backfill', clusters: [{ customId: 'c0', prospectIds: ['p1'] }] },
    })
    const batch = fakeBatch({ status: 'ended', decisionsByCustom: { c0: [{ index: 1, decision: 'commit' }] } })
    const { runtime, tables } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch })

    // Daemon owner (the default) must not collect or clear a backfill-owned job.
    const r = await collectCurateJob(runtime)

    assert.equal(r.phase, 'foreign')
    assert.equal(tables.enrichment_committed.length, 0, "the daemon commits nothing from someone else's job")
    assert.equal(readState(stateDir).curate_job?.id, 'backfill_7', 'the backfill job is left for the backfill command to collect')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

// --- submit-and-collect (ongoing daemon: across ticks) ----------------------

test('submitCurateJob records the job in the sidecar without collecting; collectCurateJob routes it once ended', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [prospectRow({ prospect_id: 'p1', label: 'Use Redis' })]
    const batch = fakeBatch({ status: 'ended', decisionsByCustom: { c0: [{ index: 1, decision: 'commit', item_key: 'k', item_type: 'Decision' }] } })
    const { runtime, tables } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch })

    const sub = await submitCurateJob(runtime)
    assert.equal(sub.phase, 'submitted')
    assert.equal(sub.id, 'batch_1')
    assert.equal(readState(stateDir).curate_job?.id, 'batch_1', 'job persisted to the sidecar')
    assert.equal(tables.enrichment_committed.length, 0, 'submit does not collect')

    const col = await collectCurateJob(runtime)
    assert.equal(col.phase, 'collected')
    assert.equal(col.committed, 1)
    assert.equal(tables.enrichment_committed.length, 1)
    assert.equal(readState(stateDir).curate_job, null, 'job cleared after collection')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('submitCurateJob is a no-op while a job is already in flight', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [prospectRow({ prospect_id: 'p1', label: 'X' })]
    const batch = fakeBatch({ decisionsByCustom: { c0: [{ index: 1, decision: 'commit' }] } })
    const { runtime } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch })

    await submitCurateJob(runtime)
    const again = await submitCurateJob(runtime)
    assert.equal(again.phase, 'in_flight')
    assert.equal(batch._submitted.length, 1, 'no second submit while in flight')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('collectCurateJob waits (no append, job kept) while the batch is still running', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [prospectRow({ prospect_id: 'p1', label: 'X' })]
    const batch = fakeBatch({ status: 'in_progress', decisionsByCustom: { c0: [{ index: 1, decision: 'commit' }] } })
    const { runtime, tables } = batchRuntime({ cfg: cfg(), stateDir, prospects, batch })

    await submitCurateJob(runtime)
    const col = await collectCurateJob(runtime)

    assert.equal(col.phase, 'pending')
    assert.equal(tables.enrichment_committed.length, 0, 'nothing committed while pending')
    assert.equal(readState(stateDir).curate_job?.id, 'batch_1', 'job kept for a later tick')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('submitCurateJob writes skip resolutions but submits no batch when everything is below salience', async () => {
  const stateDir = tmpStateDir()
  try {
    const prospects = [prospectRow({ prospect_id: 'p1', label: 'Known' })]
    const batch = fakeBatch({})
    // recall_index + a near-duplicate hit (novelty 0.05 < threshold 0.9) → skipped.
    const { runtime, tables } = batchRuntime({ cfg: cfg({ recall_index: 'idx', curate: { salience_threshold: 0.9 } }), stateDir, prospects, batch })
    // override the vector stub to return a high-score hit
    runtime._vector = { async search() { return [{ id: 'x', score: 0.95 }] } }

    const sub = await submitCurateJob(runtime)
    assert.equal(sub.phase, 'idle')
    assert.equal(batch._submitted.length, 0, 'no batch submitted')
    assert.equal(tables.enrichment_resolutions.length, 1)
    assert.equal(tables.enrichment_resolutions[0].decision, 'skip')
    assert.equal(readState(stateDir).curate_job, null)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
