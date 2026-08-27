// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { aiGatewayDatasetRegistration, DATASET_NAME, dedupeStoredPartIds } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'

/**
 * `readRows`'s `partitionWhere` hint and its consumer, the telemetry
 * dedupe (`dedupeStoredPartIds`): the dedupe question "is this part_id
 * already committed?" only needs the date partitions the batch's rows
 * live in, so the scan is pruned to those dates (plus the previous day,
 * absorbing producer timestamp skew around midnight) instead of
 * re-reading the whole table per telemetry POST.
 *
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'role', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'part_index', type: 'INT32', nullable: false },
  { name: 'content_text', type: 'STRING', nullable: true },
]

/**
 * @param {string} date
 * @param {string} messageId
 */
function row(date, messageId) {
  return {
    session_id: 'sess-1',
    date,
    client_name: 'claude',
    role: 'assistant',
    message_id: messageId,
    part_id: `${messageId}#0`,
    part_index: 0,
    content_text: `content of ${messageId}`,
  }
}

/** @returns {Promise<{ storage: ReturnType<typeof createQueryStorageService>, tablePath: string, cleanup: () => Promise<void> }>} */
async function stageStorage() {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-pwhere-'))
  const registration = aiGatewayDatasetRegistration(createGatewayState())
  const storage = createQueryStorageService({
    cacheRoot,
    getDeclaration: (dataset) => dataset === DATASET_NAME ? registration.cachePartitioning : undefined,
  })
  const tablePath = storage.cacheTablePath(DATASET_NAME, ['proxy_messages_v4'])
  return {
    storage,
    tablePath,
    cleanup: async () => { await fs.rm(cacheRoot, { recursive: true, force: true }) },
  }
}

test('readRows with a partitionWhere hint yields only the hinted date', async () => {
  const env = await stageStorage()
  try {
    await env.storage.appendRows(env.tablePath, COLUMNS, [row('2026-05-01', 'm-a'), row('2026-05-02', 'm-b')])
    await env.storage.flushTable(env.tablePath, { force: true })
    const [part] = await env.storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
    assert.ok(part, 'the flush created a partition')

    const all = []
    for await (const r of env.storage.readRows(part.path, ['message_id'])) all.push(r.message_id)
    assert.deepEqual(all.sort(), ['m-a', 'm-b'], 'an unhinted scan reads everything')

    const hinted = []
    for await (const r of env.storage.readRows(part.path, ['message_id'], { partitionWhere: { date: ['2026-05-02'] } })) {
      hinted.push(r.message_id)
    }
    assert.deepEqual(hinted, ['m-b'], 'the hint prunes the other date')
  } finally {
    await env.cleanup()
  }
})

test('the telemetry dedupe still catches committed rows inside its pruned window', async () => {
  const env = await stageStorage()
  try {
    await env.storage.appendRows(env.tablePath, COLUMNS, [row('2026-05-01', 'm-old'), row('2026-05-02', 'm-new')])
    await env.storage.flushTable(env.tablePath, { force: true })

    const batch = [
      row('2026-05-02', 'm-new'), // duplicate, same date
      row('2026-05-02', 'm-old'), // duplicate committed a day earlier (midnight skew)
      row('2026-05-02', 'm-fresh'), // genuinely new
    ]
    const fresh = await dedupeStoredPartIds(batch, env.storage)
    assert.deepEqual(fresh.map((r) => r.message_id), ['m-fresh'],
      'same-date and previous-day duplicates are dropped; the fresh row survives')
  } finally {
    await env.cleanup()
  }
})

test('a batch row without a date disables pruning rather than guessing', async () => {
  const env = await stageStorage()
  try {
    await env.storage.appendRows(env.tablePath, COLUMNS, [row('2026-05-01', 'm-old')])
    await env.storage.flushTable(env.tablePath, { force: true })

    const dateless = { ...row('2026-05-10', 'm-old'), date: undefined }
    const fresh = await dedupeStoredPartIds([dateless], env.storage)
    assert.equal(fresh.length, 0, 'the unpruned fallback scan still finds the committed part_id')
  } finally {
    await env.cleanup()
  }
})
