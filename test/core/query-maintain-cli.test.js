// @ts-check

// @ref LLP 0220#tick-reports-degraded [tests]: `maintainCache` stopped
// rejecting when a partition throws (it reports the failure instead), so a
// caller that only captures stderr - a cron wrapper, `>/dev/null` - needs a
// line there on a degraded tick, or it never learns the walk lost a
// partition. These pin that the line appears exactly when it should
// (round-1 review finding 3).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runQueryMaintain } from '../../src/core/commands/query.js'
import { appendRowsToSourceTable, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'

/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */
/** @import { PartitionCursor } from '../../src/core/cache/types.js' */

/** @type {ColumnSpec[]} */
const SESSION_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'attributes', type: 'STRING', nullable: true },
]

const SESSION_DECLARATION = {
  source: { columns: ['source'] },
  iceberg: { fields: [{ column: 'session_id', transform: 'identity' }] },
}

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A minimal `CommandRunContext` stand-in: `runQueryMaintain` only reaches
 * `ctx.storage.cacheRoot`, `ctx.config?.query?.cache?.maintenance`,
 * `ctx.query.getDataset(...)?.resettleBatch`, and the two stream sinks.
 *
 * @param {string} cacheRoot
 */
function ctxFor(cacheRoot) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  return {
    stdout,
    stderr,
    ctx: /** @type {any} */ ({
      stdout,
      stderr,
      storage: { cacheRoot },
      config: { version: 2 },
      query: { getDataset: () => null },
      env: {},
      cwd: '/w/project',
    }),
  }
}

/** @param {string} dir @param {number} baselineFiles */
async function plantStamplessRecord(dir, baselineFiles) {
  const cursor = readCursorSync(dir)
  /** @type {PartitionCursor} */
  const next = {
    ...cursor,
    compaction: {
      previousTableDir: 'table',
      compactedAt: '2026-08-12T21:55:35.168Z',
      resettleBaselineFiles: baselineFiles,
    },
  }
  await writeCursor(dir, next)
}

/** @param {string} dir */
async function tearOneDataFile(dir) {
  const cursor = readCursorSync(dir)
  const dataDir = path.join(dir, cursor.tableDir ?? 'table', 'data')
  const entries = await fs.readdir(dataDir, { withFileTypes: true })
  const [torn] = entries
    .filter((e) => e.isFile() && e.name.endsWith('.parquet'))
    .map((e) => path.join(dataDir, e.name))
  assert.ok(torn, 'fixture invariant: the partition must hold a live data file to tear')
  await fs.truncate(torn, 4)
}

test('hyp query maintain writes a stderr line when the walk loses a partition', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maintain-cli-degraded-'))
  try {
    // Two waves over the same sessions, so the owed retry is an in-place
    // merge (LLP 0310) that reads the torn file instead of a floor
    // reassessment that reads no data.
    for (const wave of [0, 1]) {
      const rows = Array.from({ length: 2 }, (_, i) => ({
        id: wave * 2 + i,
        session_id: `s-${i}`,
        attributes: `{"gateway":{"session":"s-${i}","wave":${wave}}}`,
      }))
      await appendRowsToSourceTable(
        cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS, rows,
        { declaration: SESSION_DECLARATION }
      )
    }
    const dir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    await plantStamplessRecord(dir, 4)
    await tearOneDataFile(dir)

    const { stderr, ctx } = ctxFor(cacheRoot)
    const exitCode = await runQueryMaintain(['--compact-only'], ctx)

    assert.equal(exitCode, 1, 'a degraded tick must still exit non-zero')
    assert.match(
      stderr.text(),
      /^hyp query maintain: 1 partition\(s\) failed; the walk continued$/m,
      'a caller that only captures stderr must see the walk lost a partition'
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('hyp query maintain writes nothing to stderr on a clean tick', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maintain-cli-clean-'))
  try {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: i,
      session_id: `s-${i}`,
      attributes: `{"gateway":{"session":"s-${i}"}}`,
    }))
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS, rows,
      { declaration: SESSION_DECLARATION }
    )

    const { stderr, ctx } = ctxFor(cacheRoot)
    const exitCode = await runQueryMaintain(['--compact-only'], ctx)

    assert.equal(exitCode, 0, 'a clean tick must exit zero')
    assert.equal(stderr.text(), '', 'a clean tick must not write anything to stderr')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
