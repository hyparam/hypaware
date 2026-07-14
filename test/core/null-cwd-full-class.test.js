// @ts-check

// Pinning test: a row with a null/empty `cwd` in a plain `cwd`-bearing dataset
// (e.g. `ai_gateway_messages`, which declares NO content columns) is treated as
// `full`-class at BOTH privacy seams - visible to every query caller (even the
// fail-closed `unknown` caller) and forwarded by the export read. This is the
// intended design, not a leak: an unattributable row is treated `full`
// everywhere, mirroring the export seam, and the Codex fail-open traffic class
// deliberately records `cwd = NULL`. The two seams must never diverge on this
// polarity, so this test locks it in against a future "tighten the null case"
// change that would silently drop legitimately-forwarded rows.
//
// @ref LLP 0105#unknown [tests]: a cwd-less row in a content-free dataset passes to every caller, including unknown
// @ref LLP 0070#enforce [tests]: the export seam forwards a cwd-less row (full by construction); the query seam must match

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { asyncRow } from 'squirreling'
import { executeQuerySql } from '../../src/core/query/sql.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'

/**
 * @import { AsyncDataSource, SqlPrimitive } from 'squirreling/src/types.js'
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.d.ts'
 * @import { ResolveResult, UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

// `ai_gateway_messages` is cwd-bearing but declares no localOnlyContentColumns,
// so the query seam has no columns to suppress: a cwd-less row hits the plain
// `else { yield passed }` pass-through branch (visibility.js).
const MESSAGE_COLUMNS = ['id', 'cwd', 'role', 'content_text']

const ROWS = [
  { id: 1, cwd: '/w/full', role: 'user', content_text: 'full-row' },
  { id: 2, cwd: '/w/lo', role: 'user', content_text: 'local-only-row' },
  { id: 3, cwd: null, role: 'user', content_text: 'null-cwd-row' },
]

const CLASSES = /** @type {Record<string, 'ignore' | 'local-only' | 'full'>} */ ({
  '/w/lo': 'local-only',
})

/**
 * A resolver over a fixed cwd->class map; anything unmapped (and, by the seam
 * logic, any null/empty cwd never reaches it) is `full`.
 *
 * @param {Record<string, 'ignore' | 'local-only' | 'full'>} classes
 * @returns {UsagePolicyResolver}
 */
function fakeResolver(classes) {
  /** @type {(cwd: string) => ResolveResult} */
  const resolve = (cwd) => ({ class: classes[cwd] ?? 'full', governedBy: null, declared: null })
  return { resolve, isIgnored: (cwd) => resolve(cwd).class === 'ignore' }
}

/**
 * @param {Record<string, SqlPrimitive>[]} rows
 * @returns {AsyncDataSource}
 */
function memorySource(rows) {
  const columns = MESSAGE_COLUMNS
  return {
    columns,
    numRows: rows.length,
    scan(options) {
      const rowColumns = options?.columns ?? columns
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const row of rows) yield asyncRow(row, rowColumns)
        },
      }
    },
  }
}

/**
 * @param {AsyncDataSource} source
 */
function registryFor(source) {
  // No localOnlyContentColumns: ai_gateway_messages declares none.
  const dataset = { discoverPartitions: async () => [], createDataSource: async () => source }
  return /** @type {any} */ ({ getDataset: () => dataset, listDatasets: () => [] })
}

/**
 * @param {string | null} callerCwd
 */
async function runQuery(callerCwd) {
  return executeQuerySql({
    query: 'SELECT id, content_text FROM ai_gateway_messages ORDER BY id',
    registry: registryFor(memorySource(ROWS)),
    storage: /** @type {any} */ ({}),
    refresh: 'never',
    usagePolicyResolver: fakeResolver(CLASSES),
    callerCwd,
  })
}

test('query seam: a null-cwd ai_gateway_messages row is visible to the fail-closed unknown caller', async () => {
  // callerCwd null == the unknown caller (fail-closed backstop): it withholds
  // the local-only row, but the null-cwd row is full-class and passes.
  const out = await runQuery(null)
  assert.equal(out.localOnly.callerClass, 'unknown')
  assert.deepEqual(
    out.rows.map((r) => r.content_text),
    ['full-row', 'null-cwd-row'],
    'the null-cwd row passes to an unknown caller; only the local-only row is withheld'
  )
  assert.equal(out.localOnly.withheldRows, 1, 'exactly the local-only row is withheld, never the null-cwd row')
  assert.equal(out.localOnly.suppressedRows, 0, 'no content columns declared, so nothing is suppressed')
})

test('query seam: a null-cwd ai_gateway_messages row is visible to a restricted full-class caller', async () => {
  const out = await runQuery('/w/full')
  assert.deepEqual(
    out.rows.map((r) => r.content_text),
    ['full-row', 'null-cwd-row'],
    'a full-class caller sees full and null-cwd rows; the local-only row is withheld'
  )
  assert.equal(out.localOnly.withheldRows, 1)
})

test('export seam: a null-cwd ai_gateway_messages row is forwarded (full by construction)', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-null-cwd-'))
  try {
    const svc = createQueryStorageService({
      cacheRoot,
      usagePolicyResolver: fakeResolver(CLASSES),
    })
    /** @type {ColumnSpec[]} */
    const cols = [
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'cwd', type: 'STRING', nullable: true },
      { name: 'content_text', type: 'STRING', nullable: true },
    ]
    const spoolPath = svc.cacheTablePath('ai_gateway_messages', ['all'])
    await svc.appendRows(spoolPath, cols, [
      { id: 1, cwd: '/w/full', content_text: 'full-row' },
      { id: 2, cwd: '/w/lo', content_text: 'local-only-row' },
      { id: 3, cwd: null, content_text: 'null-cwd-row' },
    ])
    await svc.flushTable(spoolPath, { reason: 'manual' })

    /** @type {number[]} */
    const shippedIds = []
    let droppedCount = 0
    for (const part of await svc.discoverCachePartitions()) {
      for await (const entry of svc.readRowsSince(part.path, {})) {
        if (entry.dropped) droppedCount += 1
        else shippedIds.push(Number(entry.row.id))
      }
    }
    assert.deepEqual(shippedIds.sort((a, b) => a - b), [1, 3], 'the full and null-cwd rows are forwarded')
    assert.equal(droppedCount, 1, 'only the local-only row is withheld from the export payload')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
