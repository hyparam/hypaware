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
  assert.deepEqual(result, { compacted: false, dataFilesBefore: 0, dataFilesAfter: 0 })
  await fs.rm(dir, { recursive: true, force: true })
})

test('compactExportTable rewrites a v3 table once the data-file threshold is reached', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maint-'))
  const tableDir = path.join(dir, 'rows')
  const tableUrl = tableUrlForDir(tableDir)
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

  const below = await compactExportTable({ tableUrl, resolver, lister, compactFileCount: 3 })
  assert.equal(below.compacted, false, 'threshold not reached -> no rewrite')
  assert.equal(below.dataFilesBefore, 2)

  const dry = await compactExportTable({ tableUrl, resolver, lister, compactFileCount: 2, dryRun: true })
  assert.equal(dry.compacted, true, 'dryRun reports the rewrite without committing')
  assert.equal(dry.dataFilesAfter, dry.dataFilesBefore, 'dryRun does not rewrite')

  const result = await compactExportTable({ tableUrl, resolver, lister, compactFileCount: 2 })
  assert.equal(result.compacted, true)
  assert.equal(result.dataFilesBefore, 2)
  assert.equal(result.dataFilesAfter, 1, 'live rows consolidated into one data file')

  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  assert.equal(metadata['format-version'], 3, 'rewrite preserves format-version 3')

  await fs.rm(dir, { recursive: true, force: true })
})
