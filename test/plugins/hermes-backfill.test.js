// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createHermesBackfillProvider, defaultHermesStateDbPath } from '../../hypaware-core/plugins-workspace/hermes/src/backfill.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/index.js'

/**
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

/**
 * Tests for the `@hypaware/hermes` backfill provider (T3).
 *
 * @ref LLP 0122#backfill [tests]: `ctx.backfills.register` contribution
 *   shape, `--since` windowing, one item per session, provenance carrying
 *   the state.db path.
 */

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

// ---------------------------------------------------------------------------
// Fixture: the same small state.db shape T1's reader test builds, so this
// exercises the real backfill provider against a real SQLite file the way
// `hyp backfill hermes` does in production.
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = [
  'id', 'source', 'model', 'cwd', 'parent_session_id', 'started_at', 'ended_at',
  'end_reason', 'billing_provider', 'billing_base_url', 'system_prompt',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'reasoning_tokens', 'estimated_cost_usd', 'actual_cost_usd', 'api_call_count',
]

const MESSAGE_COLUMNS = [
  'id', 'session_id', 'role', 'content', 'tool_calls', 'tool_name',
  'tool_call_id', 'reasoning', 'timestamp', 'token_count', 'finish_reason',
]

/**
 * @param {string} dbPath
 */
function createEmptyStateDb(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      model TEXT,
      cwd TEXT,
      parent_session_id INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      billing_provider TEXT,
      billing_base_url TEXT,
      system_prompt TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      api_call_count INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      tool_call_id TEXT,
      reasoning TEXT,
      timestamp TEXT NOT NULL,
      token_count INTEGER,
      finish_reason TEXT
    )
  `)
  return db
}

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function buildFixtureStateDb(dir) {
  const dbPath = path.join(dir, 'state.db')
  const db = createEmptyStateDb(dbPath)

  const insertSession = db.prepare(
    `INSERT INTO sessions (${SESSION_COLUMNS.join(', ')}) VALUES (${SESSION_COLUMNS.map(() => '?').join(', ')})`
  )
  const insertMessage = db.prepare(
    `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')}) VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})`
  )

  // Session 1: old (started before the window), interactive, one message.
  insertSession.run(
    1, 'cli', 'gpt-4o', '/home/dev/project', null, '2026-05-01T10:00:00Z', null,
    null, 'openai', 'https://api.openai.com/v1', null,
    null, null, null, null, null, null, null, null
  )
  insertMessage.run(1, 1, 'user', 'an old question', null, null, null, null, '2026-05-01T10:00:01Z', null, null)

  // Session 2: recent (inside the window), interactive, one message.
  insertSession.run(
    2, 'cli', 'gpt-4o', '/home/dev/project', null, '2026-07-20T10:00:00Z', null,
    null, 'openai', 'https://api.openai.com/v1', null,
    null, null, null, null, null, null, null, null
  )
  insertMessage.run(2, 2, 'user', 'a recent question', null, null, null, null, '2026-07-20T10:00:01Z', null, null)

  // Session 3: ended, recent, with final totals.
  insertSession.run(
    3, 'cli', 'o3', '/home/dev/other', null, '2026-07-20T09:00:00Z', '2026-07-20T09:05:00Z',
    'completed', 'openai', 'https://api.openai.com/v1', null,
    120, 80, 10, 0, 200, 0.0041, 0.0039, 2
  )
  insertMessage.run(3, 3, 'user', 'why is the sky blue', null, null, null, null, '2026-07-20T09:00:01Z', null, null)

  db.close()
  return dbPath
}

/** @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>} */
async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-backfill-'))
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

function captureLog() {
  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const entries = []
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ message, /** @type {Record<string, unknown>=} */ fields) => {
    entries.push({ level, message, fields })
  }
  return {
    entries,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  }
}

/**
 * @param {{ since?: string, until?: string, retentionDays?: number, log?: any }} [overrides]
 * @returns {{ ctx: BackfillRunContext, entries: any[] }}
 */
function runContext(overrides = {}) {
  const { entries, log } = captureLog()
  /** @type {BackfillRunContext} */
  const ctx = {
    env: {},
    cacheRoot: path.join(os.tmpdir(), 'hermes-backfill-cache-unused'),
    dryRun: false,
    log: overrides.log ?? log,
    storage: /** @type {any} */ ({}),
    ...(overrides.since !== undefined ? { since: overrides.since } : {}),
    ...(overrides.until !== undefined ? { until: overrides.until } : {}),
    ...(overrides.retentionDays !== undefined ? { retentionDays: overrides.retentionDays } : {}),
  }
  return { ctx, entries }
}

/**
 * @param {AsyncIterable<BackfillItem | BackfillEvent>} iterable
 * @returns {Promise<{ items: BackfillItem[], events: BackfillEvent[] }>}
 */
async function collect(iterable) {
  /** @type {BackfillItem[]} */
  const items = []
  /** @type {BackfillEvent[]} */
  const events = []
  for await (const yielded of iterable) {
    if (yielded.type === 'event') events.push(/** @type {BackfillEvent} */ (yielded))
    else items.push(/** @type {BackfillItem} */ (yielded))
  }
  return { items, events }
}

/** @param {BackfillItem} item */
function value(item) {
  return /** @type {any} */ (item.value)
}

// ---------------------------------------------------------------------------
// Contribution shape
// ---------------------------------------------------------------------------

test('provider advertises a stable contribution shape', async () => {
  const provider = createHermesBackfillProvider({ homeDir: '/tmp/nope-home' })
  assert.equal(provider.name, 'hermes')
  assert.equal(provider.plugin, '@hypaware/hermes')
  assert.deepEqual(provider.datasets, ['ai_gateway_messages'])
  assert.equal(typeof provider.run, 'function')
})

test('defaultHermesStateDbPath resolves under <homeDir>/.hermes/state.db', () => {
  assert.equal(defaultHermesStateDbPath('/home/tester'), path.join('/home/tester', '.hermes', 'state.db'))
})

// ---------------------------------------------------------------------------
// One item per session, provenance shape
// ---------------------------------------------------------------------------

test('every session projects into one item, addressed to the projected-exchange materializer', async () => {
  const { dir, cleanup } = await tmpDir()
  try {
    const stateDbPath = await buildFixtureStateDb(dir)
    const provider = createHermesBackfillProvider({ homeDir: dir, stateDbPath })
    const { items } = await collect(provider.run(runContext().ctx))

    assert.equal(items.length, 3, 'three sessions, three items')
    const byId = new Map(items.map((item) => [value(item).session_id, item]))
    assert.deepEqual([...byId.keys()].sort(), ['hermes-1', 'hermes-2', 'hermes-3'])
  } finally {
    await cleanup()
  }
})

test('provenance carries the state.db path, client name, and native session id', async () => {
  const { dir, cleanup } = await tmpDir()
  try {
    const stateDbPath = await buildFixtureStateDb(dir)
    const provider = createHermesBackfillProvider({ homeDir: dir, stateDbPath })
    const { items } = await collect(provider.run(runContext().ctx))

    const item = items.find((candidate) => value(candidate).session_id === 'hermes-2')
    assert.ok(item)
    assert.deepEqual(item.provenance, {
      client_name: 'hermes',
      native_id: '2',
      source_path: stateDbPath,
    })
    assert.equal(item.dataset, 'ai_gateway_messages')
    assert.equal(item.kind, 'ai_gateway.projected_exchange')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// --since window filtering (LLP 0122#backfill)
// ---------------------------------------------------------------------------

test('since bound keeps only sessions started on or after the window, by session (not by message)', async () => {
  const { dir, cleanup } = await tmpDir()
  try {
    const stateDbPath = await buildFixtureStateDb(dir)
    const provider = createHermesBackfillProvider({ homeDir: dir, stateDbPath })
    const { ctx, entries: logs } = runContext({ since: '2026-06-01T00:00:00Z' })
    const { items } = await collect(provider.run(ctx))

    // Session 1 started 2026-05-01 (before the window) and is excluded
    // WHOLE: the window selects sessions, not a session's individual
    // messages, so a stale session is left for a wider run rather than
    // imported split across runs.
    const ids = items.map((item) => value(item).session_id).sort()
    assert.deepEqual(ids, ['hermes-2', 'hermes-3'])

    const scanDone = logs.find((e) => e.message === 'hermes.backfill.scan_complete')
    assert.equal(scanDone?.fields?.sessions_seen, 3)
    assert.equal(scanDone?.fields?.sessions_skipped_window, 1)
    assert.equal(scanDone?.fields?.sessions_projected, 2)
  } finally {
    await cleanup()
  }
})

test('until bound excludes sessions started after the window', async () => {
  const { dir, cleanup } = await tmpDir()
  try {
    const stateDbPath = await buildFixtureStateDb(dir)
    const provider = createHermesBackfillProvider({ homeDir: dir, stateDbPath })
    const { ctx } = runContext({ until: '2026-06-01T00:00:00Z' })
    const { items } = await collect(provider.run(ctx))

    assert.deepEqual(items.map((item) => value(item).session_id), ['hermes-1'])
  } finally {
    await cleanup()
  }
})

test('no window (no since/until/retentionDays) imports every session', async () => {
  const { dir, cleanup } = await tmpDir()
  try {
    const stateDbPath = await buildFixtureStateDb(dir)
    const provider = createHermesBackfillProvider({ homeDir: dir, stateDbPath })
    const { items } = await collect(provider.run(runContext().ctx))
    assert.equal(items.length, 3)
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// Empty-store no-op
// ---------------------------------------------------------------------------

test('a state.db with zero sessions yields nothing, without throwing', async () => {
  const { dir, cleanup } = await tmpDir()
  try {
    const dbPath = path.join(dir, 'state.db')
    createEmptyStateDb(dbPath).close()

    const provider = createHermesBackfillProvider({ homeDir: dir, stateDbPath: dbPath })
    const { ctx, entries: logs } = runContext()
    const { items, events } = await collect(provider.run(ctx))

    assert.equal(items.length, 0)
    assert.equal(events.length, 0)
    const scanDone = logs.find((e) => e.message === 'hermes.backfill.scan_complete')
    assert.equal(scanDone?.fields?.sessions_seen, 0)
    assert.equal(scanDone?.fields?.status, 'ok')
  } finally {
    await cleanup()
  }
})

test('a missing state.db (no hermes installation) yields nothing, without throwing', async () => {
  const { dir, cleanup } = await tmpDir()
  try {
    const missingPath = path.join(dir, 'state.db')
    const provider = createHermesBackfillProvider({ homeDir: dir, stateDbPath: missingPath })
    const { ctx, entries: logs } = runContext()
    const { items, events } = await collect(provider.run(ctx))

    assert.equal(items.length, 0)
    assert.equal(events.length, 0)
    const noStore = logs.find((e) => e.message === 'hermes.backfill.no_store')
    assert.ok(noStore, 'a missing state.db is logged as a clean no-op, not an error')
    assert.equal(noStore?.fields?.status, 'skipped')
    // No scan_complete: the run returns before the scan starts.
    assert.equal(logs.find((e) => e.message === 'hermes.backfill.scan_complete'), undefined)
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// Usage-policy skip (delegated to projectHermesSession, LLP 0050)
// ---------------------------------------------------------------------------

test('a session whose cwd is .hypignore-ignored is skipped, others still import', async () => {
  const { dir, cleanup } = await tmpDir()
  try {
    const stateDbPath = await buildFixtureStateDb(dir)
    const ignoredDir = '/home/dev/project'
    const hypignore = path.join(ignoredDir, '.hypignore')
    const resolver = createUsagePolicyResolver({
      existsSync: (p) => p === hypignore,
      readFileSync: () => 'ignore\n',
    })

    const provider = createHermesBackfillProvider({ homeDir: dir, stateDbPath, resolver })
    const { ctx, entries: logs } = runContext()
    const { items } = await collect(provider.run(ctx))

    // Sessions 1 and 2 share the ignored cwd; session 3 does not.
    assert.deepEqual(items.map((item) => value(item).session_id), ['hermes-3'])
    const drop = logs.filter((e) => e.message === 'plugin.hermes.usage_policy_drop')
    assert.equal(drop.length, 2)
    const scanDone = logs.find((e) => e.message === 'hermes.backfill.scan_complete')
    assert.equal(scanDone?.fields?.sessions_projected, 1)
    assert.equal(scanDone?.fields?.sessions_skipped, 2)
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// Idempotence (spec R2)
// ---------------------------------------------------------------------------

test('reruns are deterministic: identical items across runs', async () => {
  const { dir, cleanup } = await tmpDir()
  try {
    const stateDbPath = await buildFixtureStateDb(dir)
    const provider = createHermesBackfillProvider({ homeDir: dir, stateDbPath })

    const first = await collect(provider.run(runContext().ctx))
    const second = await collect(provider.run(runContext().ctx))
    assert.deepEqual(first.items, second.items)
  } finally {
    await cleanup()
  }
})
