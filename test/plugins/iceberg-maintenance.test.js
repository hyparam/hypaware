// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  fileCatalog,
  icebergAppend,
  icebergCreateTable,
  icebergRead,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import {
  compactExportTable,
  normalizeExportRetentionConfig,
} from '../../hypaware-core/plugins-workspace/format-iceberg/src/maintenance.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'

test('normalizeExportRetentionConfig fills defaults', () => {
  const cfg = normalizeExportRetentionConfig(undefined)
  assert.equal(cfg.min_snapshots_to_keep, 10)
  assert.equal(cfg.max_snapshot_age_hours, 24)
  assert.equal(cfg.compact_file_count, 32)
  assert.equal(cfg.compact_max_bytes, 128 * 1024 * 1024)
})

test('normalizeExportRetentionConfig honors overrides', () => {
  const cfg = normalizeExportRetentionConfig({ compact_file_count: 2, min_snapshots_to_keep: 1 })
  assert.equal(cfg.compact_file_count, 2)
  assert.equal(cfg.min_snapshots_to_keep, 1)
  assert.equal(cfg.max_snapshot_age_hours, 24)
})

test('compactExportTable reports no compaction for a missing table', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maint-'))
  const { resolver, lister } = await createLocalIcebergIO()
  const result = await compactExportTable({
    tableUrl: tableUrlForDir(path.join(dir, 'missing')),
    resolver,
    lister,
    compactFileCount: 2,
  })
  assert.deepEqual(result, { compacted: false, reason: 'no-table', dataFilesBefore: 0, dataFilesAfter: 0 })
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * Create a 2-data-file, 3-row v3 table for the compaction tests.
 *
 * @param {string} dir
 * @returns {Promise<{ tableUrl: string, resolver: any, lister: any, rows: { id: bigint, value: string }[] }>}
 */
async function createTwoFileTable(dir) {
  const tableUrl = tableUrlForDir(path.join(dir, 'rows'))
  const { resolver, lister } = await createLocalIcebergIO()
  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })

  const schema = {
    type: /** @type {const} */ ('struct'),
    'schema-id': 0,
    fields: [
      { id: 1, name: 'id', required: true, type: /** @type {const} */ ('long') },
      { id: 2, name: 'value', required: false, type: /** @type {const} */ ('string') },
    ],
  }
  await icebergCreateTable({ catalog, tableUrl, schema, formatVersion: 3 })
  // Two appends -> two data files.
  await icebergAppend({ catalog, tableUrl, records: [{ id: 1n, value: 'a' }, { id: 2n, value: 'b' }] })
  await icebergAppend({ catalog, tableUrl, records: [{ id: 3n, value: 'c' }] })
  return {
    tableUrl,
    resolver,
    lister,
    rows: [{ id: 1n, value: 'a' }, { id: 2n, value: 'b' }, { id: 3n, value: 'c' }],
  }
}

/**
 * Read the table back and project to user columns, sorted by id, so a
 * rewrite that dropped or mangled rows fails a deep-equal (v3 reads also
 * carry `_row_id` / `_last_updated_sequence_number` lineage columns).
 *
 * @param {{ tableUrl: string, resolver: any, lister: any }} opts
 * @returns {Promise<{ id: bigint, value: string }[]>}
 */
async function readUserRows({ tableUrl, resolver, lister }) {
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  const rows = await icebergRead({ tableUrl, metadata, resolver })
  return rows
    .map((r) => ({ id: r.id, value: r.value }))
    .sort((a, b) => Number(a.id - b.id))
}

test('compactExportTable rewrites a v3 table once the data-file threshold is reached', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maint-'))
  const { tableUrl, resolver, lister, rows } = await createTwoFileTable(dir)

  const below = await compactExportTable({ tableUrl, resolver, lister, compactFileCount: 3 })
  assert.equal(below.compacted, false, 'threshold not reached -> no rewrite')
  assert.equal(below.reason, 'below-threshold')
  assert.equal(below.dataFilesBefore, 2)

  const dry = await compactExportTable({ tableUrl, resolver, lister, compactFileCount: 2, dryRun: true })
  assert.equal(dry.compacted, true, 'dryRun reports the rewrite without committing')
  assert.equal(dry.dataFilesAfter, dry.dataFilesBefore, 'dryRun does not rewrite')

  const result = await compactExportTable({ tableUrl, resolver, lister, compactFileCount: 2 })
  assert.equal(result.compacted, true)
  assert.equal(result.reason, undefined)
  assert.equal(result.dataFilesBefore, 2)
  assert.equal(result.dataFilesAfter, 1, 'live rows consolidated into one data file')

  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  assert.equal(metadata['format-version'], 3, 'rewrite preserves format-version 3')
  assert.deepEqual(
    await readUserRows({ tableUrl, resolver, lister }),
    rows,
    'every appended row survives the rewrite byte-for-byte'
  )

  await fs.rm(dir, { recursive: true, force: true })
})

test('compactExportTable skips a table whose total-files-size exceeds compact_max_bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maint-'))
  const { tableUrl, resolver, lister } = await createTwoFileTable(dir)

  const result = await compactExportTable({
    tableUrl, resolver, lister, compactFileCount: 2, compactMaxBytes: 1,
  })
  assert.equal(result.compacted, false)
  assert.equal(result.reason, 'above-byte-cap')
  assert.ok(typeof result.totalBytes === 'number' && result.totalBytes > 1, 'reports the offending size')
  assert.equal(result.dataFilesAfter, 2, 'table untouched')

  await fs.rm(dir, { recursive: true, force: true })
})

test('compactExportTable reports a commit conflict and cleans up the staged files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maint-'))
  const { tableUrl, resolver, lister, rows } = await createTwoFileTable(dir)
  const before = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })

  // Fail the conditional metadata write (the commit point) the way a lost
  // race does, while data/manifest staging goes through the real resolver.
  /** @type {string[]} */
  const deleted = []
  const conflictResolver = {
    ...resolver,
    /** @param {string} url @param {{ ifNoneMatch?: string }} [options] */
    writer(url, options) {
      if (options?.ifNoneMatch === '*' && url.endsWith('.metadata.json')) {
        const err = /** @type {Error & { statusCode: number }} */ (new Error('conditional write collision'))
        err.statusCode = 412
        throw err
      }
      return resolver.writer(url, options)
    },
    /** @param {string} url */
    async deleter(url) {
      deleted.push(url)
      await resolver.deleter(url)
    },
  }

  const result = await compactExportTable({
    tableUrl, resolver: conflictResolver, lister, compactFileCount: 2,
  })
  assert.equal(result.compacted, false)
  assert.equal(result.reason, 'conflict')
  assert.ok(result.error, 'conflict carries the underlying error message')

  // Staged data file + manifest + manifest list were all reclaimed.
  assert.ok(deleted.length >= 3, `staged files deleted (got ${deleted.length})`)
  for (const url of deleted) {
    await assert.rejects(fs.access(new URL(url).pathname), 'deleted file is gone from disk')
  }

  const after = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  assert.equal(after.version, before.version, 'failed commit leaves table metadata untouched')
  assert.deepEqual(await readUserRows({ tableUrl, resolver, lister }), rows, 'original rows intact')

  await fs.rm(dir, { recursive: true, force: true })
})

test('compactExportTable reports a non-conflict rewrite failure as reason=error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maint-'))
  const { tableUrl, resolver, lister } = await createTwoFileTable(dir)

  const failingResolver = {
    ...resolver,
    /** @param {string} url @param {{ ifNoneMatch?: string }} [options] */
    writer(url, options) {
      if (options?.ifNoneMatch === '*' && url.endsWith('.metadata.json')) {
        throw new Error('disk full')
      }
      return resolver.writer(url, options)
    },
  }

  const result = await compactExportTable({
    tableUrl, resolver: failingResolver, lister, compactFileCount: 2,
  })
  assert.equal(result.compacted, false)
  assert.equal(result.reason, 'error')
  assert.match(result.error ?? '', /disk full/)

  await fs.rm(dir, { recursive: true, force: true })
})
