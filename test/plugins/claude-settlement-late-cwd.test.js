// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createClaudeSettlementEnricher } from '../../hypaware-core/plugins-workspace/claude/src/settle.js'
import { appendSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createUsagePolicyResolver, USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'

/**
 * Regression for issue #258: the Claude session-start race writes the opening
 * exchange(s) with `cwd = NULL` (the session-context hook record hadn't landed
 * yet), so the projector's `.hypignore` check is skipped (fail-open) and the
 * row is never revisited. The flush-time settlement enricher (LLP 0027) now
 * gives a null-cwd row a SECOND look: it re-reads the (now-present) session
 * context, fills `cwd`, and applies the usage-policy resolver late.
 *
 * Per the repo-owner decision on #258 (minted as LLP 0085): a row whose
 * late-resolved cwd is `.hypignore`d is DROPPED at flush (before partition
 * write, before export); a clean cwd is enriched, not dropped; a row whose
 * context never arrives settles unchanged.
 */

const IGNORED_ROOT = '/work/ignored-repo'
const CLEAN_ROOT = '/work/clean-repo'

// ---------------------------------------------------------------------------
// Enricher unit level
// ---------------------------------------------------------------------------

test('enricher drops a null-cwd row whose late-resolved cwd is .hypignore-governed', async () => {
  const env = await stageEnv()
  try {
    // The hook record landed AFTER the row was projected (the race): at flush
    // it now carries the ignored cwd for the session.
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-late-ign',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(IGNORED_ROOT, 'src'),
      ts: '2026-05-22T10:02:00.000Z',
    })
    const { entries, logger } = captureLog()
    const enricher = createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
      logger,
    })

    const row = nullCwdRow({ session_id: 'sess-late-ign' })
    const [out] = await enricher.settle([row], settleCtx())

    assert.equal(out, USAGE_POLICY_DROP, 'a late-resolved ignore row is marked for removal')
    const drop = entries.find((e) => e.message === 'plugin.claude.usage_policy_drop')
    assert.ok(drop, 'the drop is observable as a structured usage_policy_drop event')
    assert.equal(drop.fields?.policy_source, 'settlement_late_resolve')
    assert.equal(drop.fields?.session_id, 'sess-late-ign')
    assert.ok(typeof drop.fields?.cwd_hash === 'string' && drop.fields.cwd_hash.length > 0, 'hashed cwd, never a raw path')
    // The cwd itself is hashed; only `governed_by` (the .hypignore file path,
    // as the projector's own capture-seam drop event also emits) references the
    // dir. The raw cwd VALUE never appears.
    assert.ok(!JSON.stringify(drop.fields).includes(path.join(IGNORED_ROOT, 'src')), 'the raw cwd value never appears in telemetry')
  } finally {
    await env.cleanup()
  }
})

test('enricher enriches a null-cwd row whose late-resolved cwd is not ignored', async () => {
  const env = await stageEnv()
  try {
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-late-clean',
      transcript_path: undefined,
      git_branch: 'feature/x',
      cwd: path.join(CLEAN_ROOT, 'src'),
      repo_root: CLEAN_ROOT,
      ts: '2026-05-22T10:02:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    })

    const row = nullCwdRow({ session_id: 'sess-late-clean' })
    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))

    assert.notEqual(out, USAGE_POLICY_DROP, 'a clean cwd is not dropped')
    assert.notEqual(out, row, 'the enriched row is a new object so the dispatcher detects the change')
    assert.equal(out.cwd, path.join(CLEAN_ROOT, 'src'), 'cwd is filled from the late session context')
    assert.equal(out.git_branch, 'feature/x')
    assert.equal(out.repo_root, CLEAN_ROOT)
  } finally {
    await env.cleanup()
  }
})

test('enricher leaves a null-cwd row unchanged when its session context never arrives (SDK/headless)', async () => {
  const env = await stageEnv()
  try {
    // No session-context record is ever written for this session.
    const enricher = createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    })

    const row = nullCwdRow({ session_id: 'sess-headless' })
    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))

    assert.equal(out, row, 'no context => settle unchanged, no drop, no crash')
    assert.equal(out.cwd, undefined)
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Per-row-time context selection (LLP 0085): a session can hold several records
// with DIFFERENT cwds (a mid-session dir change). The null-cwd opening rows must
// resolve against the record live at each row's OWN time, not the session's
// latest. Selecting the latest would leak an ignored opening row or drop a clean
// one - and because settlement DROPS, that mis-selection is destructive.
// ---------------------------------------------------------------------------

test('ignore-then-clean: the opening row resolves against the EARLIER ignored record and is DROPPED', async () => {
  const env = await stageEnv()
  try {
    // Session starts in an ignored dir; a later fire records a clean dir.
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-ord-ic',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(IGNORED_ROOT, 'src'),
      ts: '2026-05-22T10:00:00.000Z',
    })
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-ord-ic',
      transcript_path: undefined,
      git_branch: 'main',
      cwd: path.join(CLEAN_ROOT, 'src'),
      repo_root: CLEAN_ROOT,
      ts: '2026-05-22T10:05:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    })

    // Opening row created just after session start (before the dir change).
    const row = nullCwdRow({ session_id: 'sess-ord-ic', message_index: 0, message_created_at: '2026-05-22T10:00:01.000Z' })
    const [out] = await enricher.settle([row], settleCtx())

    assert.equal(out, USAGE_POLICY_DROP, 'resolved against the ignored session-start cwd, not the later clean one')
  } finally {
    await env.cleanup()
  }
})

test('clean-then-ignore: the opening row resolves against the EARLIER clean record and is KEPT (not dropped)', async () => {
  const env = await stageEnv()
  try {
    // Session starts clean; a later fire moves into an ignored dir. The OLD
    // session-latest selection would resolve the opening row against the ignored
    // record and DROP it - a data loss the per-row selection prevents.
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-ord-ci',
      transcript_path: undefined,
      git_branch: 'feature/x',
      cwd: path.join(CLEAN_ROOT, 'src'),
      repo_root: CLEAN_ROOT,
      ts: '2026-05-22T10:00:00.000Z',
    })
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-ord-ci',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(IGNORED_ROOT, 'src'),
      ts: '2026-05-22T10:05:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    })

    const row = nullCwdRow({ session_id: 'sess-ord-ci', message_index: 0, message_created_at: '2026-05-22T10:00:01.000Z' })
    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))

    assert.notEqual(out, USAGE_POLICY_DROP, 'the clean opening row is not dropped against the later ignored cwd')
    assert.equal(out.cwd, path.join(CLEAN_ROOT, 'src'), 'enriched with the session-start clean cwd')
    assert.equal(out.git_branch, 'feature/x')
    assert.equal(out.repo_root, CLEAN_ROOT)
  } finally {
    await env.cleanup()
  }
})

test('per-row selection within one batch: a later row takes the later record, an opening row the earlier one', async () => {
  const env = await stageEnv()
  try {
    // Clean at start, ignored after the dir change.
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-mixed',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(CLEAN_ROOT, 'src'),
      ts: '2026-05-22T10:00:00.000Z',
    })
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-mixed',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(IGNORED_ROOT, 'src'),
      ts: '2026-05-22T10:05:00.000Z',
    })
    const enricher = createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    })

    const opening = nullCwdRow({ session_id: 'sess-mixed', message_index: 0, message_created_at: '2026-05-22T10:00:30.000Z' })
    // A row whose ts is AFTER the later record resolves against that (correct,
    // at-or-before) record - the ignored one - and is dropped.
    const later = nullCwdRow({ session_id: 'sess-mixed', message_index: 6, message_created_at: '2026-05-22T10:06:00.000Z' })
    const out = /** @type {any[]} */ (await enricher.settle([opening, later], settleCtx()))

    assert.notEqual(out[0], USAGE_POLICY_DROP, 'the opening row resolves against the earlier clean record and is kept')
    assert.equal(out[0].cwd, path.join(CLEAN_ROOT, 'src'))
    assert.equal(out[1], USAGE_POLICY_DROP, 'the later row resolves against the later ignored record and is dropped')
  } finally {
    await env.cleanup()
  }
})

test('ts tie-break: the enriched record wins over the minimal one from the same fire', async () => {
  const env = await stageEnv()
  try {
    // Part (a) writes a minimal {session_id, cwd, ts} record, then an enriched
    // one; on a millisecond tie the enriched (git identity) record must win so
    // the git columns still land.
    const tie = '2026-05-22T10:00:00.000Z'
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-tie',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(CLEAN_ROOT, 'src'),
      ts: tie,
    })
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-tie',
      transcript_path: undefined,
      git_branch: 'main',
      cwd: path.join(CLEAN_ROOT, 'src'),
      repo_root: CLEAN_ROOT,
      ts: tie,
    })
    const enricher = createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    })

    const row = nullCwdRow({ session_id: 'sess-tie', message_index: 0, message_created_at: '2026-05-22T10:00:01.000Z' })
    const [out] = /** @type {any[]} */ (await enricher.settle([row], settleCtx()))

    assert.notEqual(out, USAGE_POLICY_DROP)
    assert.equal(out.cwd, path.join(CLEAN_ROOT, 'src'))
    assert.equal(out.git_branch, 'main', 'the enriched record wins the tie so git_branch lands')
    assert.equal(out.repo_root, CLEAN_ROOT)
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// settleBatch (the production flush dispatch): removal must be honored
// ---------------------------------------------------------------------------

test('settleBatch REMOVES a null-cwd row whose late-resolved cwd is ignored', async () => {
  const env = await stageEnv()
  try {
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-batch-ign',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(IGNORED_ROOT, 'pkg'),
      ts: '2026-05-22T10:02:00.000Z',
    })
    const state = createGatewayState()
    const api = createAiGatewayApi(state)
    api.registerSettlementEnricher(createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    }))
    const registration = aiGatewayDatasetRegistration(state)

    const row = nullCwdRow({ session_id: 'sess-batch-ign' })
    const out = await /** @type {any} */ (registration).settleBatch([row], settleCtx())

    assert.equal(out.length, 0, 'the late-resolved ignore row is dropped from the flush batch, before partition write')
  } finally {
    await env.cleanup()
  }
})

test('settleBatch keeps and enriches a null-cwd row whose late-resolved cwd is clean', async () => {
  const env = await stageEnv()
  try {
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-batch-clean',
      transcript_path: undefined,
      git_branch: 'main',
      cwd: path.join(CLEAN_ROOT, 'pkg'),
      ts: '2026-05-22T10:02:00.000Z',
    })
    const state = createGatewayState()
    const api = createAiGatewayApi(state)
    api.registerSettlementEnricher(createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    }))
    const registration = aiGatewayDatasetRegistration(state)

    const row = nullCwdRow({ session_id: 'sess-batch-clean' })
    const out = await /** @type {any} */ (registration).settleBatch([row], settleCtx())

    assert.equal(out.length, 1, 'a clean row survives the flush')
    assert.equal(out[0].cwd, path.join(CLEAN_ROOT, 'pkg'), 'and is enriched with the now-known cwd')
    assert.equal(out[0].git_branch, 'main')
  } finally {
    await env.cleanup()
  }
})

test('settleBatch dispatches null-cwd rows even when no row is a gateway fallback', async () => {
  const env = await stageEnv()
  try {
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-native-ign',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(IGNORED_ROOT, 'x'),
      ts: '2026-05-22T10:02:00.000Z',
    })
    const state = createGatewayState()
    const api = createAiGatewayApi(state)
    api.registerSettlementEnricher(createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    }))
    const registration = aiGatewayDatasetRegistration(state)

    // A native-identity row (NOT a gateway_fallback) but with null cwd: the
    // transcript landed while the session-context record raced. It must still
    // reach the settlement pass and be dropped.
    const row = nullCwdRow({ session_id: 'sess-native-ign', native: true })
    const out = await /** @type {any} */ (registration).settleBatch([row], settleCtx())

    assert.equal(out.length, 0, 'a native-identity null-cwd ignore row is still dropped at settle')
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// resettle (maintenance compaction path): NEVER drops (LLP 0085 is
// flush-scoped; an already-committed row is not re-dropped as an after-the-fact
// purge).
// ---------------------------------------------------------------------------

test('resettleBatch never drops a late-resolved ignore row (compaction is not a purge)', async () => {
  const env = await stageEnv()
  try {
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-resettle-ign',
      transcript_path: undefined,
      git_branch: undefined,
      cwd: path.join(IGNORED_ROOT, 'y'),
      ts: '2026-05-22T10:02:00.000Z',
    })
    const state = createGatewayState()
    const api = createAiGatewayApi(state)
    api.registerSettlementEnricher(createClaudeSettlementEnricher({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      resolver: resolverIgnoring(IGNORED_ROOT),
    }))
    const registration = aiGatewayDatasetRegistration(state)

    const row = nullCwdRow({ session_id: 'sess-resettle-ign' })
    const out = await /** @type {any} */ (registration).resettleBatch([row], settleCtx())

    assert.equal(out.length, 1, 'resettle keeps the row: the flush-time drop decision (LLP 0085) does not purge committed rows')
  } finally {
    await env.cleanup()
  }
})

// --- helpers ---------------------------------------------------------

/**
 * A projected `ai_gateway_messages` row with `cwd` unset - the session-start
 * race shape. `native: true` gives it real transcript identity (no
 * `gateway_fallback` marker) to exercise the broadened settle selection.
 * `message_created_at` / `message_index` drive the per-row context selection
 * (LLP 0085); omit them for the single-record cases that predate the fix.
 *
 * @param {{ session_id: string, native?: boolean, message_created_at?: string, message_index?: number }} f
 */
function nullCwdRow(f) {
  /** @type {Record<string, unknown>} */
  const row = {
    message_id: f.native ? 'u-native-uuid-0001' : 'fallbackhash16ab',
    part_id: f.native ? 'u-native-uuid-0001#0' : 'fallbackhash16ab#0',
    part_index: 0,
    role: 'user',
    session_id: f.session_id,
    conversation_id: null,
    client_name: 'claude',
    content_text: 'the opening prompt',
    cwd: undefined,
  }
  if (f.message_created_at !== undefined) row.message_created_at = f.message_created_at
  if (f.message_index !== undefined) row.message_index = f.message_index
  row.attributes = f.native
    ? { gateway: { exchange_id: 'ex' } }
    : { gateway: { identity_source: 'gateway_fallback' }, claude: { match_key: 'user the opening prompt' } }
  return row
}

/**
 * A resolver whose only governing `.hypignore` lives at `<ignoredRoot>/.hypignore`
 * and resolves to `ignore`. Built on the REAL core matcher with an injected fs.
 *
 * @param {string} ignoredRoot
 */
function resolverIgnoring(ignoredRoot) {
  const marker = path.join(ignoredRoot, '.hypignore')
  return createUsagePolicyResolver({
    existsSync: (p) => p === marker,
    readFileSync: () => 'ignore\n',
  })
}

/** @param {{ discoverCachePartitions?: Function, readRows?: Function }} [storage] */
function settleCtx(storage) {
  return /** @type {any} */ ({ storage: storage ?? {} })
}

function captureLog() {
  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const entries = []
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ message, /** @type {Record<string, unknown>=} */ fields) => {
    entries.push({ level, message, fields })
  }
  return { entries, logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } }
}

/** @returns {Promise<{ homeDir: string, stateFile: string, cleanup: () => Promise<void> }>} */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-settle-latecwd-'))
  const stateDir = path.join(homeDir, 'state')
  await fs.mkdir(stateDir, { recursive: true })
  return {
    homeDir,
    stateFile: path.join(stateDir, 'session-context.jsonl'),
    cleanup: async () => { await fs.rm(homeDir, { recursive: true, force: true }) },
  }
}
