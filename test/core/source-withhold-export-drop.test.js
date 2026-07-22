// @ts-check

// Export-seam source-scoped withholding (LLP 0132 #source-scoped-withholding,
// task T5): the shared export read (`storage.readRowsSince`) withholds a row
// attributed (via the dataset's declared `attribution_column`) to a picker
// source classified `'local'` on a machine with a central layer, but still
// surfaces its `after` so the cursor advances across it (drop-but-advance,
// mirroring the existing `cwd`/`local-only` filter's continuation semantics).
// A dataset with no declared `attribution_column` is never subject to this
// withholding, the conservative default (LLP 0132, `PluginDatasetManifest
// .attribution_column`).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createSourceWithholdResolver } from '../../src/core/cache/source-withhold.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.d.ts'
 */

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-source-withhold-'))
}

/** @type {ColumnSpec[]} */
const COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
]

test('readRowsSince: rows attributed to a withheld source are dropped from the payload but the cursor advances across them', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['hermes'],
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'claude' }, // not withheld -> shipped
    { id: 2, client_name: 'hermes' }, // withheld -> dropped
    { id: 3, client_name: 'hermes' }, // withheld -> dropped
    { id: 4, client_name: '' }, // empty attribution -> passes (never matches a withheld id)
    { id: 5, client_name: null }, // no attribution -> passes
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const shippedIds = []
  let droppedCount = 0
  let prev = -1n
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      const cur = BigInt(entry.after.seq)
      assert.ok(cur >= prev, 'the `after` cursor never regresses, even across a drop')
      prev = cur
      if (entry.dropped) {
        droppedCount += 1
        assert.equal(entry.row, undefined, 'a drop-only entry carries no row payload')
      } else {
        shippedIds.push(Number(entry.row.id))
      }
    }
  }

  assert.deepEqual(shippedIds.sort((a, b) => a - b), [1, 4, 5], 'only rows not attributed to a withheld source reach the payload')
  assert.equal(droppedCount, 2, 'both hermes-attributed rows are withheld')

  // Cache-but-never-forward, not a capture-time drop: withheld rows stay
  // fully queryable locally through the unfiltered `readRows` scan.
  /** @type {number[]} */
  const cachedIds = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const row of svc.readRows(part.path)) cachedIds.push(Number(row.id))
  }
  assert.deepEqual(cachedIds.sort((a, b) => a - b), [1, 2, 3, 4, 5], 'all rows remain locally queryable in the cache')

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: a dataset with no declared attribution_column is never subject to source-scoped withholding', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    // `hermes` is withheld, but `datasetAttributionColumns` has no entry for
    // the `demo` dataset this test writes to, the conservative default.
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['hermes'],
      datasetAttributionColumns: new Map([['some-other-dataset', 'client_name']]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'claude' },
    { id: 2, client_name: 'hermes' }, // would be withheld under a governed dataset, but this one isn't governed
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const shippedIds = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      assert.ok(!entry.dropped && entry.row, 'no attribution_column for this dataset ⇒ nothing is ever withheld')
      shippedIds.push(Number(entry.row.id))
    }
  }
  assert.deepEqual(shippedIds.sort((a, b) => a - b), [1, 2])

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: with no sourceWithholdResolver configured, nothing is ever withheld on attribution', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({ cacheRoot }) // no sourceWithholdResolver
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'claude' },
    { id: 2, client_name: 'hermes' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const ids = []
  for (const part of await svc.discoverCachePartitions()) {
    for await (const entry of svc.readRowsSince(part.path, {})) {
      assert.ok(!entry.dropped && entry.row, 'no resolver ⇒ every entry is a payload row')
      ids.push(Number(entry.row.id))
    }
  }
  assert.deepEqual(ids.sort((a, b) => a - b), [1, 2])

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: a `columns` projection omitting the attribution column still withholds, and shipped rows come back without it', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({
    cacheRoot,
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['hermes'],
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, client_name: 'claude' },
    { id: 2, client_name: 'hermes' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {Record<string, unknown>[]} */
  const shipped = []
  let droppedCount = 0
  for (const part of await svc.discoverCachePartitions()) {
    // Caller asks for `id` only, NOT `client_name`. Withholding must not
    // depend on the caller remembering to project the attribution column in.
    for await (const entry of svc.readRowsSince(part.path, { columns: ['id'] })) {
      if (entry.dropped) {
        droppedCount += 1
      } else {
        shipped.push(entry.row)
      }
    }
  }

  assert.equal(droppedCount, 1, 'the hermes-attributed row is still withheld despite the projection')
  assert.deepEqual(shipped, [{ id: 1n }], 'the shipped row is the projected columns only')
  assert.ok(!('client_name' in shipped[0]), "the forced-in attribution column is stripped back off, the caller's projection contract is honored")

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince: cwd-based and source-scoped withholding compose independently', async () => {
  const cacheRoot = await makeTmpDir()
  /** @type {ColumnSpec[]} */
  const cols = [
    { name: 'id', type: 'INT64', nullable: false },
    { name: 'client_name', type: 'STRING', nullable: true },
    { name: 'cwd', type: 'STRING', nullable: true },
  ]
  const svc = createQueryStorageService({
    cacheRoot,
    usagePolicyResolver: {
      resolve: (cwd) => (cwd === '/work/secret' ? { class: 'local-only', governedBy: '/list', declared: 'local-only' } : { class: 'full', governedBy: null, declared: null }),
      isIgnored: () => false,
    },
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: ['hermes'],
      datasetAttributionColumns: new Map([['demo', 'client_name']]),
    }),
  })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, cols, [
    { id: 1, client_name: 'claude', cwd: '/work/public' }, // shipped
    { id: 2, client_name: 'hermes', cwd: '/work/public' }, // withheld by source
    { id: 3, client_name: 'claude', cwd: '/work/secret' }, // withheld by cwd
    { id: 4, client_name: 'hermes', cwd: '/work/secret' }, // withheld by both
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
  assert.deepEqual(shippedIds, [1], 'only the row cleared by both filters ships')
  assert.equal(droppedCount, 3)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})
