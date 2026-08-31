// @ts-check

// LLP 0334: the per-partition escape report LLP 0332 introduced now tracks
// the partition it is keyed on. It is dropped where retention deletes the
// directory, so no entry outlives its partition and a partition recreated
// at that path warns as the transition it is; the read that drops an armed
// entry says so once, so silence after a refusal means the condition still
// stands; and the window compares the rejected value rather than its
// rendering, so a poison that changes only its JSON type is a new fact.
//
// Every assertion here is counted in the direction of silence: the failure
// these guard against is a refusal an operator never sees.
//
// @ref LLP 0334#testable [tests]: eviction clears, recovery is announced once, and a type change is a changed value.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendRowsToTable } from '../../src/core/cache/iceberg/store.js'
import { migrateLegacyPartitions } from '../../src/core/cache/migrate.js'
import { tryReadCursorSync } from '../../src/core/cache/partition.js'
import { createRetentionEnforcer } from '../../src/core/cache/retention.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/**
 * The narrowest legacy table the migration will carry rows out of.
 *
 * @type {ColumnSpec[]}
 */
const MIGRATE_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
]

/**
 * A cursor whose `tableDir` is the given value. `"../out"` fails the
 * bare-segment rule and is refused at every read (LLP 0323), so no symlink
 * needs planting: these tests are about the report, not the gate.
 *
 * @param {string} partitionDir
 * @param {unknown} tableDir
 */
async function writePoisonedCursor(partitionDir, tableDir) {
  await fs.writeFile(
    path.join(partitionDir, 'cursor.json'),
    JSON.stringify({ epoch: 1, rowCount: 3, compaction: null, layout: 'source-table', tableDir })
  )
}

/**
 * Capture what `fn` writes to the real `process.stderr`, where the mirror
 * deliberately writes (LLP 0329#consequences), and return the lines that
 * carry `token`.
 *
 * @param {() => unknown} fn
 * @param {string} token
 * @returns {Promise<string[]>}
 */
async function linesFrom(fn, token) {
  const realWrite = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = /** @type {typeof process.stderr.write} */ ((chunk) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })
  try {
    await fn()
  } finally {
    process.stderr.write = realWrite
  }
  return captured.split('\n').filter((line) => line.includes(token))
}

const REFUSAL = 'cursor_table_dir_escapes_partition'
const RECOVERY = 'cursor_escape_recovered'

test('a partition retention evicted while poisoned warns again when it comes back', async () => {
  // The strand LLP 0332#transition-plus-rewarn accepted: the entry is keyed
  // by path, the eviction deletes the path, and nothing left reads that
  // partition to clear it. A partition recreated at the same path then
  // reuses the stale key and its refusal is throttled against a window
  // armed for a directory that no longer exists - silence over a live
  // poison, for up to the rewarn interval.
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-escape-evict-'))
  try {
    const partition = path.join(cacheRoot, 'datasets', 'logs', 'date=2026-01-01')
    await fs.mkdir(path.join(partition, 'metadata'), { recursive: true })
    await fs.writeFile(path.join(partition, 'metadata', 'v1.metadata.json'), '{}')
    await writePoisonedCursor(partition, '../out')
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
    await fs.utimes(partition, old, old)

    const enforcer = createRetentionEnforcer({ cacheRoot, config: undefined })
    const evicting = await linesFrom(() => enforcer.tick(), REFUSAL)
    assert.equal(evicting.length, 1, 'the evicting tick still says the partition it read was poisoned')
    await assert.rejects(() => fs.stat(partition), 'and the eviction really removed the partition')

    // The same path, poisoned the same way, well inside the rewarn window.
    await fs.mkdir(partition, { recursive: true })
    await writePoisonedCursor(partition, '../out')
    const reborn = await linesFrom(() => { assert.equal(tryReadCursorSync(partition), null) }, REFUSAL)
    assert.equal(reborn.length, 1, 'a poison on a partition this process never resolved is a transition, not a repeat')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a heal after a refusal says so exactly once', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-escape-recover-'))
  try {
    const partition = path.join(root, 'source=claude')
    await fs.mkdir(partition, { recursive: true })
    await writePoisonedCursor(partition, '../out')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1)

    await fs.mkdir(path.join(partition, 'table'), { recursive: true })
    await writePoisonedCursor(partition, 'table')
    const healed = await linesFrom(() => {
      assert.notEqual(tryReadCursorSync(partition), null, 'the read now returns a cursor')
    }, RECOVERY)
    assert.equal(healed.length, 1, 'the read that clears an armed refusal retracts it')
    assert.match(healed[0], /INFO/, 'nothing is wrong, so it is not a second WARN')
    assert.ok(healed[0].includes(partition), 'and it names the partition the refusal named')

    const again = await linesFrom(() => { tryReadCursorSync(partition) }, RECOVERY)
    assert.equal(again.length, 0, 'the retraction is per cleared refusal, not per healthy read')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a partition that never refused is silent on both channels when it reads', async () => {
  // The property LLP 0332#consequences was protecting when it left recovery
  // unannounced: a healthy cache must not acquire a line per cursor read.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-escape-quiet-'))
  try {
    const partition = path.join(root, 'source=claude')
    await fs.mkdir(path.join(partition, 'table'), { recursive: true })
    await writePoisonedCursor(partition, 'table')
    const lines = await linesFrom(() => {
      assert.notEqual(tryReadCursorSync(partition), null)
      assert.notEqual(tryReadCursorSync(partition), null)
    }, '[hypaware:')
    assert.deepEqual(lines, [], 'no refusal was armed, so there is nothing to retract')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a cursor that vanishes under a warned refusal retracts it too', async () => {
  // Not a heal: the partition still reads as unreadable. What ended is the
  // escape condition, which is the whole of what the entry held, so it is
  // the whole of what the line retracts (LLP 0334#recovery-is-announced).
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-escape-vanish-'))
  try {
    const partition = path.join(root, 'source=claude')
    await fs.mkdir(partition, { recursive: true })
    await writePoisonedCursor(partition, '../out')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1)

    await fs.rm(path.join(partition, 'cursor.json'))
    const cleared = await linesFrom(() => {
      assert.equal(tryReadCursorSync(partition), null, 'an absent cursor still reads as unreadable')
    }, RECOVERY)
    assert.equal(cleared.length, 1, 'the armed refusal is retracted once')

    await writePoisonedCursor(partition, '../out')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1,
      'and the refusal that follows the retraction still warns immediately')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a poison that changes only its JSON type is a changed value', async () => {
  // The line reports `JSON.stringify` for a non-string `tableDir`, so a
  // window that compares renderings cannot tell the array `["a/b"]` from
  // the string `'["a/b"]'`: both are refused, both report the same
  // `table_dir`, and the second is absorbed into the first's window against
  // LLP 0332#transition-plus-rewarn's rule that a poison which changes shape
  // is a new fact. (Both spellings escape: a non-string is refused outright,
  // and that string is not a bare segment.)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-escape-type-'))
  try {
    const partition = path.join(root, 'source=claude')
    await fs.mkdir(partition, { recursive: true })
    await writePoisonedCursor(partition, ['a/b'])
    const first = await linesFrom(() => { assert.equal(tryReadCursorSync(partition), null) }, REFUSAL)
    assert.equal(first.length, 1, 'a non-string tableDir is refused and reported')

    await writePoisonedCursor(partition, '["a/b"]')
    const second = await linesFrom(() => { assert.equal(tryReadCursorSync(partition), null) }, REFUSAL)
    assert.equal(second.length, 1, 'the string is a different rejected value from the array that renders as it')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a refusal that follows a retraction the log channel dropped still warns', async () => {
  // The delete happens before the emit and regardless of it. An entry kept
  // alive because the channel threw would throttle the next genuine refusal
  // against a condition that had already ended, which is silence over a live
  // poison - the one degradation this series may never have
  // (LLP 0334#recovery-is-announced). Counted here rather than asserted in
  // prose: with no provider installed the mirror IS the emit, so a stderr
  // that throws is the whole retraction failing.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-escape-throw-'))
  try {
    const partition = path.join(root, 'source=claude')
    await fs.mkdir(partition, { recursive: true })
    await writePoisonedCursor(partition, '../out')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1)

    await fs.mkdir(path.join(partition, 'table'), { recursive: true })
    await writePoisonedCursor(partition, 'table')
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = /** @type {typeof process.stderr.write} */ (() => {
      throw new Error('EPIPE')
    })
    try {
      assert.notEqual(tryReadCursorSync(partition), null, 'the read survives a channel that throws')
    } finally {
      process.stderr.write = realWrite
    }

    // The same poison, well inside the rewarn window. It is a transition
    // because the entry went with the retraction that never got out.
    await writePoisonedCursor(partition, '../out')
    const after = await linesFrom(() => { assert.equal(tryReadCursorSync(partition), null) }, REFUSAL)
    assert.equal(after.length, 1, 'losing the retraction line does not cost the operator the next refusal')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a legacy partition the migration retires while poisoned warns again when it comes back', async () => {
  // The same strand as retention's, at the third site where a whole
  // partition directory stops existing: `migrateLegacyPartitions` scans
  // every legacy cursor (arming the report) and then renames the directory
  // into `.retired/` (LLP 0334#eviction-clears).
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-escape-migrate-'))
  try {
    const partition = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'proxy_messages_v4')
    await fs.mkdir(path.join(partition, 'epoch=0'), { recursive: true })
    await appendRowsToTable(path.join(partition, 'epoch=0'), MIGRATE_COLUMNS, [
      { id: 1, client_name: 'claude' },
    ])
    await writePoisonedCursor(partition, '../out')

    const migrating = await linesFrom(
      () => migrateLegacyPartitions({ cacheRoot, force: true }),
      REFUSAL
    )
    assert.equal(migrating.length, 1, 'the migrating scan still says the cursor it read was poisoned')
    await assert.rejects(() => fs.stat(partition), 'and the migration really retired the partition')

    await fs.mkdir(partition, { recursive: true })
    await writePoisonedCursor(partition, '../out')
    const reborn = await linesFrom(() => { assert.equal(tryReadCursorSync(partition), null) }, REFUSAL)
    assert.equal(reborn.length, 1, 'a poison on a partition this process no longer holds is a transition')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
