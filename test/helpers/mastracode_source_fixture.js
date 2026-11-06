// @ts-check

/**
 * Shared harness for the mastracode poll source tests: one `mastra.db` in
 * Mastra Code 0.49.0's shape under a temp app-data dir, named through
 * `MASTRA_DB_PATH`, and a fake ctx that runs the REAL ai_gateway
 * materializer over a storage that keeps committed rows. Synthetic rows only.
 */

import path from 'node:path'

import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../src/core/backfill/scan_util.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createFakeStorage } from './goose_source_fixture.js'
import {
  assistantContent,
  createMastraDb,
  insertMessage,
  insertThread,
  textPart,
  tmpDir,
  updateThread,
  userContent,
} from './mastracode_db_fixture.js'

/** @import { DatabaseSync as SqliteDatabase } from 'node:sqlite' */

let clock = 0
/** A strictly increasing ISO `updatedAt`, as Mastra Code writes it. */
export function nextUpdatedAt() {
  clock += 1
  return new Date(Date.UTC(2026, 10, 6, 0, 0, 0) + clock * 1000).toISOString()
}

/**
 * @param {{ config?: Record<string, unknown>, env?: Record<string, string>,
 *   hooks?: Parameters<typeof createFakeStorage>[0] }} [opts]
 */
export async function createMastracodeHarness(opts = {}) {
  const dir = await tmpDir()
  const dbPath = await createMastraDb(path.join(dir, 'appdata'))
  const projectDir = path.join(dir, 'project')

  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const logs = []
  const log = {
    debug(/** @type {string} */ message, /** @type {any} */ fields) { logs.push({ level: 'debug', message, fields }) },
    info(/** @type {string} */ message, /** @type {any} */ fields) { logs.push({ level: 'info', message, fields }) },
    warn(/** @type {string} */ message, /** @type {any} */ fields) { logs.push({ level: 'warn', message, fields }) },
    error(/** @type {string} */ message, /** @type {any} */ fields) { logs.push({ level: 'error', message, fields }) },
  }
  const fake = createFakeStorage(opts.hooks)
  const materializers = new Map([[PROJECTED_EXCHANGE_KIND, aiGatewayBackfillMaterializer()]])
  const ctx = /** @type {any} */ ({
    config: { ...opts.config },
    env: { HOME: dir, HYP_HOME: dir, MASTRA_DB_PATH: dbPath, ...opts.env },
    paths: { rootDir: dir, stateDir: dir, cacheDir: dir, tempDir: dir },
    log,
    storage: fake.storage,
    query: {
      getDataset(/** @type {string} */ name) {
        if (name !== AI_GATEWAY_MESSAGES_DATASET) return undefined
        return { name, plugin: '@hypaware/ai-gateway', schema: { columns: AI_GATEWAY_MESSAGE_COLUMNS } }
      },
    },
    backfillMaterializers: { get(/** @type {string} */ kind) { return materializers.get(kind) } },
  })
  return { dir, dbPath, projectDir, ctx, logs, ...fake }
}

/**
 * A thread whose `projectPath` is `projectDir`.
 *
 * @param {SqliteDatabase} w
 * @param {string} id
 * @param {string} projectDir
 * @param {{ title?: string, updatedAt?: string }} [opts]
 */
export function addThread(w, id, projectDir, opts = {}) {
  const updatedAt = opts.updatedAt ?? nextUpdatedAt()
  insertThread(w, {
    id,
    title: opts.title ?? '',
    metadata: { projectPath: projectDir, currentModelId: 'mastracode/openai/gpt-fixture' },
    createdAt: updatedAt,
    updatedAt,
  })
}

/**
 * One finished user-and-assistant turn, then the `updatedAt` bump Mastra
 * Code writes with it. `bump: false` leaves `updatedAt` alone.
 *
 * @param {SqliteDatabase} w
 * @param {string} threadId
 * @param {string} tag
 * @param {{ bump?: boolean }} [opts]
 */
export function addTurn(w, threadId, tag, opts = {}) {
  insertMessage(w, { id: `${threadId}-${tag}-u`, thread_id: threadId, role: 'signal', type: 'user', content: userContent(`${threadId}-${tag}-sig`, `${tag} prompt`) })
  insertMessage(w, {
    id: `${threadId}-${tag}-a`, thread_id: threadId, role: 'assistant', type: 'v2',
    content: assistantContent([textPart(`${tag} reply`)], { modelId: 'openai/gpt-fixture', provider: 'openai' }),
  })
  if (opts.bump !== false) updateThread(w, threadId, { updatedAt: nextUpdatedAt() })
}

/**
 * The `content_text` of one thread's committed message rows, in commit
 * order. The title row (`session_metadata`) carries no `content_text`.
 *
 * @param {Record<string, unknown>[]} committed
 * @param {string} threadId
 */
export function texts(committed, threadId) {
  return committed
    .filter(row => row.session_id === `mastracode-${threadId}` && row.part_type !== 'session_metadata')
    .map(row => row.content_text)
}

/**
 * The `mastracode.poll` info logs, optionally only those with one `poll_status`.
 *
 * @param {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} logs
 * @param {string} [status]
 */
export function mastracodePollLogs(logs, status) {
  return logs.filter(entry => entry.message === 'mastracode.poll' && entry.level === 'info'
    && (status === undefined || entry.fields?.poll_status === status))
}
