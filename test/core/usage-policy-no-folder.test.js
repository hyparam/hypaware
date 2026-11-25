// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import {
  createUsagePolicyResolver,
  folderAskPath,
  localOnlyListPath,
  writeFolderAskMode,
} from '../../src/core/usage-policy/index.js'
import { Attr } from '../../src/core/observability/index.js'
import { withLogRecords } from '../helpers/log_records.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { ResolveResult, UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

// LLP 0625: with the folder ask in force, a chat that carries no folder is not
// recorded. The rule lives at the cache's commit points, so these drive the
// storage service directly, the way every adapter's rows reach it.

/** @type {ColumnSpec[]} */
const CHAT_COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
]

/** @type {ColumnSpec[]} */
const NO_FOLDER_COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'value', type: 'STRING', nullable: true },
]

/** @type {ResolveResult} */
const FULL = { class: 'full', governedBy: null, declared: null }
/** @type {ResolveResult} */
const WAITING = { class: 'ignore', governedBy: null, declared: null }

/**
 * A resolver whose only opinion is whether the ask is in force.
 *
 * @param {{ ask: boolean }} opts
 * @returns {UsagePolicyResolver}
 */
function askResolver({ ask }) {
  return { resolve: () => FULL, isIgnored: () => false, resolveNoFolder: () => (ask ? WAITING : FULL) }
}

async function makeCacheRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-no-folder-'))
}

/**
 * Every committed row id in the cache, sorted.
 *
 * @param {ReturnType<typeof createQueryStorageService>} svc
 * @returns {Promise<number[]>}
 */
async function committedIds(svc) {
  /** @type {number[]} */
  const ids = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const row of svc.readRows(part.path, ['id'])) ids.push(Number(row.id))
  }
  return ids.sort((a, b) => a - b)
}

const MIXED_ROWS = [
  { id: 1, cwd: '/work/app' },
  { id: 2, cwd: '' },
  { id: 3, cwd: null },
  { id: 4 },
  { id: 5, cwd: '/work/other' },
]

test('with the ask in force, rows that carry no folder are never committed', async () => {
  const cacheRoot = await makeCacheRoot()
  try {
    const svc = createQueryStorageService({ cacheRoot, usagePolicyResolver: askResolver({ ask: true }) })
    const table = svc.cacheTablePath('chats', ['all'])
    const { records } = await withLogRecords(async () => {
      await svc.appendRows(table, CHAT_COLUMNS, MIXED_ROWS.map((row) => ({ ...row })))
      await svc.flushTable(table, { reason: 'manual' })
    })
    assert.deepEqual(await committedIds(svc), [1, 5])

    // The drop is observable, as a count and a dataset and nothing else.
    const drops = records.filter((r) => r.body === 'usage_policy.no_folder_drop')
    assert.equal(drops.length, 1)
    assert.equal(drops[0].attributes.dropped_count, 3)
    assert.equal(drops[0].attributes[Attr.DATASET], 'chats')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('with the ask off, a row with no folder is recorded as before', async () => {
  const cacheRoot = await makeCacheRoot()
  try {
    const svc = createQueryStorageService({ cacheRoot, usagePolicyResolver: askResolver({ ask: false }) })
    const table = svc.cacheTablePath('chats', ['all'])
    await svc.appendRows(table, CHAT_COLUMNS, MIXED_ROWS.map((row) => ({ ...row })))
    await svc.flushTable(table, { reason: 'manual' })
    assert.deepEqual(await committedIds(svc), [1, 2, 3, 4, 5])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a storage service with no resolver, or one that has no opinion, drops nothing', async () => {
  for (const usagePolicyResolver of [undefined, /** @type {UsagePolicyResolver} */ ({ resolve: () => FULL, isIgnored: () => false })]) {
    const cacheRoot = await makeCacheRoot()
    try {
      const svc = createQueryStorageService({ cacheRoot, ...(usagePolicyResolver ? { usagePolicyResolver } : {}) })
      const table = svc.cacheTablePath('chats', ['all'])
      await svc.appendRows(table, CHAT_COLUMNS, MIXED_ROWS.map((row) => ({ ...row })))
      await svc.flushTable(table, { reason: 'manual' })
      assert.deepEqual(await committedIds(svc), [1, 2, 3, 4, 5])
    } finally {
      await fs.rm(cacheRoot, { recursive: true, force: true })
    }
  }
})

test('a dataset that declares no folder column is left alone, even with the ask in force', async () => {
  const cacheRoot = await makeCacheRoot()
  try {
    const svc = createQueryStorageService({ cacheRoot, usagePolicyResolver: askResolver({ ask: true }) })
    const table = svc.cacheTablePath('metrics', ['all'])
    await svc.appendRows(table, NO_FOLDER_COLUMNS, [{ id: 1, value: 'a' }, { id: 2, value: 'b' }])
    await svc.flushTable(table, { reason: 'manual' })
    assert.deepEqual(await committedIds(svc), [1, 2])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a folder that arrives at settlement counts: the row is judged after the settle hook', async () => {
  const cacheRoot = await makeCacheRoot()
  try {
    // The owning dataset learns row 2's folder late, as the Claude and Codex
    // enrichers do from the transcript. Row 3 never gets one.
    const getSettleHook = () => async (/** @type {Record<string, unknown>[]} */ rows) =>
      rows.map((row) => (row.id === 2 ? { ...row, cwd: '/work/late' } : row))
    const svc = createQueryStorageService({ cacheRoot, getSettleHook, usagePolicyResolver: askResolver({ ask: true }) })
    const table = svc.cacheTablePath('chats', ['all'])
    await svc.appendRows(table, CHAT_COLUMNS, [{ id: 1, cwd: '/work/app' }, { id: 2, cwd: null }, { id: 3, cwd: null }])
    await svc.flushTable(table, { reason: 'manual' })
    assert.deepEqual(await committedIds(svc), [1, 2])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('the mode decides at commit, so a row spooled before the ask was turned on is not committed after', async () => {
  const cacheRoot = await makeCacheRoot()
  try {
    let ask = false
    /** @type {UsagePolicyResolver} */
    const resolver = { resolve: () => FULL, isIgnored: () => false, resolveNoFolder: () => (ask ? WAITING : FULL) }
    const svc = createQueryStorageService({ cacheRoot, usagePolicyResolver: resolver })
    const table = svc.cacheTablePath('chats', ['all'])
    await svc.appendRows(table, CHAT_COLUMNS, [{ id: 1, cwd: '/work/app' }, { id: 2, cwd: null }])
    ask = true
    await svc.flushTable(table, { reason: 'manual' })
    assert.deepEqual(await committedIds(svc), [1])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// LLP 0625 #never-deletes: some writers replace a session with a snapshot,
// and a stored row the snapshot does not carry is deleted. The rule must
// never be the reason a stored row goes away.

/** @type {ColumnSpec[]} */
const SESSION_COLUMNS = [
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
]

/**
 * @param {string} session
 * @param {Array<[string, string | null]>} rows message id and folder
 */
const snapshotOf = (session, rows) =>
  rows.map(([id, cwd]) => ({ message_id: id, client_name: 'hermes', session_id: session, cwd }))

/** @param {string} session */
const scopeOf = (session) => ({ where: { client_name: 'hermes', session_id: session }, key: 'message_id' })

/**
 * Every committed `session:message` pair, sorted.
 * @param {ReturnType<typeof createQueryStorageService>} svc
 */
async function committedMessages(svc) {
  /** @type {string[]} */
  const out = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const row of svc.readRows(part.path, ['message_id', 'session_id'])) out.push(`${row.session_id}:${row.message_id}`)
  }
  return out.sort()
}

test('turning the ask on never deletes rows a snapshot reconcile already stored', async () => {
  const cacheRoot = await makeCacheRoot()
  try {
    let ask = false
    /** @type {UsagePolicyResolver} */
    const resolver = { resolve: () => FULL, isIgnored: () => false, resolveNoFolder: () => (ask ? WAITING : FULL) }
    const svc = createQueryStorageService({ cacheRoot, usagePolicyResolver: resolver })
    const reconcile = /** @type {NonNullable<typeof svc.reconcileRows>} */ (svc.reconcileRows)

    // Ask off: a session with no folder at all, and one where one row lacks it.
    await reconcile('ai_gateway_messages', SESSION_COLUMNS, snapshotOf('A', [['a1', null], ['a2', null]]), scopeOf('A'))
    await reconcile('ai_gateway_messages', SESSION_COLUMNS, snapshotOf('B', [['b1', '/work/app'], ['b2', null], ['b3', '/work/app']]), scopeOf('B'))
    const stored = ['A:a1', 'A:a2', 'B:b1', 'B:b2', 'B:b3']
    assert.deepEqual(await committedMessages(svc), stored)

    // Ask on: each session gets one more message and is reconciled again.
    ask = true
    const wroteA = await reconcile('ai_gateway_messages', SESSION_COLUMNS, snapshotOf('A', [['a1', null], ['a2', null], ['a3', null]]), scopeOf('A'))
    const wroteB = await reconcile('ai_gateway_messages', SESSION_COLUMNS, snapshotOf('B', [['b1', '/work/app'], ['b2', null], ['b3', '/work/app'], ['b4', '/work/app']]), scopeOf('B'))

    // Nothing stored was deleted, and nothing was written from a snapshot the
    // rule would have had to shrink.
    assert.deepEqual([wroteA, wroteB], [0, 0])
    assert.deepEqual(await committedMessages(svc), stored)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('with the ask on, a snapshot whose rows all carry a folder still reconciles', async () => {
  const cacheRoot = await makeCacheRoot()
  try {
    const svc = createQueryStorageService({ cacheRoot, usagePolicyResolver: askResolver({ ask: true }) })
    const reconcile = /** @type {NonNullable<typeof svc.reconcileRows>} */ (svc.reconcileRows)
    await reconcile('ai_gateway_messages', SESSION_COLUMNS, snapshotOf('C', [['c1', '/work/app'], ['c2', '/work/app']]), scopeOf('C'))
    // A real replace still works: c2 is gone from the snapshot, so it goes.
    await reconcile('ai_gateway_messages', SESSION_COLUMNS, snapshotOf('C', [['c1', '/work/app'], ['c3', '/work/app']]), scopeOf('C'))
    assert.deepEqual(await committedMessages(svc), ['C:c1', 'C:c3'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('with the ask on, a batch of snapshots skips only the ones the rule refuses', async () => {
  const cacheRoot = await makeCacheRoot()
  try {
    const svc = createQueryStorageService({ cacheRoot, usagePolicyResolver: askResolver({ ask: true }) })
    const reconcileBatch = /** @type {NonNullable<typeof svc.reconcileRowsBatch>} */ (svc.reconcileRowsBatch)
    await reconcileBatch('ai_gateway_messages', SESSION_COLUMNS, [
      { rows: snapshotOf('D', [['d1', '/work/app']]), scope: scopeOf('D') },
      { rows: snapshotOf('E', [['e1', null]]), scope: scopeOf('E') },
    ])
    assert.deepEqual(await committedMessages(svc), ['D:d1'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// LLP 0625 #scope: the rule is about chats.

test('a row that names no session is not a chat, and is kept with the ask on', async () => {
  const cacheRoot = await makeCacheRoot()
  try {
    const svc = createQueryStorageService({ cacheRoot, usagePolicyResolver: askResolver({ ask: true }) })
    const table = svc.cacheTablePath('events', ['all'])
    await svc.appendRows(table, SESSION_COLUMNS, [
      // A content-free counter: no session, no folder. Kept.
      { message_id: 'counter', client_name: 'claude', session_id: null, cwd: null },
      // A chat with no folder. Not recorded.
      { message_id: 'chat', client_name: 'claude', session_id: 's1', cwd: null },
      { message_id: 'foldered', client_name: 'claude', session_id: 's2', cwd: '/work/app' },
    ])
    await svc.flushTable(table, { reason: 'manual' })
    assert.deepEqual(await committedMessages(svc), ['null:counter', 's2:foldered'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// The real resolver's answer for "no folder", which the storage rule reads.

test('the resolver answers no-folder from the mode alone', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-no-folder-mode-'))
  try {
    const stateDir = path.join(root, 'state')
    const listPath = localOnlyListPath(stateDir)

    assert.equal(createUsagePolicyResolver({ localOnlyListPath: listPath }).resolveNoFolder?.().class, 'full')
    // No machine-local state at all: there is no mode to read.
    assert.equal(createUsagePolicyResolver().resolveNoFolder?.().class, 'full')

    await writeFolderAskMode({ stateDir, mode: 'ask' })
    const waiting = createUsagePolicyResolver({ localOnlyListPath: listPath }).resolveNoFolder?.()
    assert.deepEqual(waiting, WAITING)

    await writeFolderAskMode({ stateDir, mode: 'sync' })
    assert.equal(createUsagePolicyResolver({ localOnlyListPath: listPath }).resolveNoFolder?.().class, 'full')

    // An ask an older version wrote is a question, not yet the rule (LLP 0626).
    await fs.writeFile(folderAskPath(stateDir), JSON.stringify({ version: 1, mode: 'ask' }))
    assert.equal(createUsagePolicyResolver({ localOnlyListPath: listPath }).resolveNoFolder?.().class, 'full')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
