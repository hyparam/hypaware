// @ts-check

// The other half of the cursor-gate refusal set. Every destructive reader
// goes through `tryReadCursorSync` (LLP 0323#one-gate), and it refuses in
// two ways: a `tableDir` that escapes its partition, and bytes that do not
// read as a cursor at all. The first has said so out loud since LLP 0323
// and at a bounded rate since LLP 0332; the second returned null and said
// nothing, so a torn or edited `cursor.json` stopped that partition
// compacting, stopped it being swept, and had it read as empty, permanently
// and with no line on any channel to say why.
//
// The refusal now carries the same standing report as its sibling, and
// these controls are counted in the direction of silence: the failure they
// guard against is a partition an operator never hears about.
//
// @ref LLP 0323#say-it [tests]: neither corrupt-cursor exit through the shared gate degrades silently.
// @ref LLP 0332#testable [tests]: the added line is throttled to a rate, and the throttle is a floor rather than a mute.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { tryReadCursorSync } from '../../src/core/cache/partition.js'
import { createRetentionEnforcer } from '../../src/core/cache/retention.js'
import { stderrLinesFrom } from '../helpers/stderr_lines.js'

// Kept equal to ESCAPE_REWARN_MS in src/core/cache/partition.js, which is
// deliberately not exported: the window is a reporting detail, not API.
const REWARN_MS = 10 * 60 * 1000

const REFUSAL = 'cursor_unreadable'
const RECOVERY = 'cursor_unreadable_recovered'
const ESCAPE_REFUSAL = 'cursor_table_dir_escapes_partition'
const ESCAPE_RECOVERY = 'cursor_escape_recovered'
// Both refusals and both retractions carry it, so one capture sees every
// line a single read emitted, which is what the handover below needs.
const CURSOR_READ = 'cache.cursor_read'

/**
 * The shared stderr capture, with this suite's one scoped exclusion.
 *
 * The recovery line carries the refusal token as a substring
 * (`cursor_unreadable_recovered`), so a count of refusals has to exclude it
 * or a heal would read as a fresh warning. Only that token needs the
 * exclusion: a capture of every line one read emitted (`CURSOR_READ`) wants
 * the retractions in it, and dropping them silently would let an assertion
 * that none went out pass without looking.
 *
 * @param {() => unknown} fn
 * @param {string} token
 * @returns {Promise<string[]>}
 */
function linesFrom(fn, token) {
  return stderrLinesFrom(fn, token, token === REFUSAL ? RECOVERY : undefined)
}

/** @returns {Promise<string>} */
async function makePartition() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-unreadable-'))
  const partition = path.join(root, 'source=claude')
  await fs.mkdir(partition, { recursive: true })
  return partition
}

/**
 * @param {string} partitionDir
 * @param {string} bytes
 */
async function writeRawCursor(partitionDir, bytes) {
  await fs.writeFile(path.join(partitionDir, 'cursor.json'), bytes)
}

/**
 * A readable cursor naming the generation that is really there.
 *
 * @param {string} partitionDir
 */
async function writeGoodCursor(partitionDir) {
  await fs.mkdir(path.join(partitionDir, 'table'), { recursive: true })
  await writeRawCursor(
    partitionDir,
    JSON.stringify({ epoch: 1, rowCount: 3, compaction: null, layout: 'source-table', tableDir: 'table' })
  )
}

test('a cursor.json that does not parse is refused out loud, once per condition', async () => {
  const partition = await makePartition()
  try {
    await writeRawCursor(partition, '{ not json')

    const first = await linesFrom(() => {
      assert.equal(tryReadCursorSync(partition), null, 'the partition is still skipped')
    }, REFUSAL)
    assert.equal(first.length, 1, 'the refusal that skips this partition forever is said exactly once')
    assert.ok(first[0].includes(partition), 'and it names the partition, which is the only way to act on it')

    // The gate is shared, so one poisoned cursor is read by many callers in
    // a tick. The line is per condition, not per read (LLP 0332).
    const repeat = await linesFrom(() => {
      tryReadCursorSync(partition)
      tryReadCursorSync(partition)
    }, REFUSAL)
    assert.equal(repeat.length, 0, 'a standing refusal does not repeat itself per read')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a standing unreadable cursor rewarns once the window expires', async (t) => {
  const partition = await makePartition()
  try {
    await writeRawCursor(partition, '{ not json')
    t.mock.timers.enable({ apis: ['Date'], now: 4 * REWARN_MS })
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1)

    t.mock.timers.setTime(4 * REWARN_MS + REWARN_MS - 1)
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 0,
      'inside the window the condition is already said')

    t.mock.timers.setTime(4 * REWARN_MS + REWARN_MS)
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1,
      'a throttle is a floor on the rate, never a mute for the process lifetime')
  } finally {
    t.mock.timers.reset()
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a cursor that fails differently is a new fact, not a repeat', async () => {
  const partition = await makePartition()
  try {
    await writeRawCursor(partition, '{ not json')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1)

    // Valid JSON, and still not a cursor: `null` has no fields to read.
    // Well inside the window, and a different failure, so it warns.
    await writeRawCursor(partition, 'null')
    assert.equal((await linesFrom(() => {
      assert.equal(tryReadCursorSync(partition), null)
    }, REFUSAL)).length, 1, 'a failure that changed is a transition, not a repeat')

    // And that one is standing too, so it does not repeat per read.
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 0)
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a readable cursor and an absent cursor are both silent', async () => {
  const partition = await makePartition()
  try {
    assert.equal((await linesFrom(() => {
      assert.equal(tryReadCursorSync(partition), null, 'no cursor file is not a refusal')
    }, REFUSAL)).length, 0, 'a partition with no cursor is not a corrupt one')

    await writeGoodCursor(partition)
    assert.equal((await linesFrom(() => {
      assert.notEqual(tryReadCursorSync(partition), null)
    }, REFUSAL)).length, 0, 'a healthy cache is exactly as quiet as it was')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, RECOVERY)).length, 0,
      'and it retracts nothing, because it armed nothing')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a heal after an unreadable refusal is retracted exactly once', async () => {
  const partition = await makePartition()
  try {
    await writeRawCursor(partition, '{ not json')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1)

    await writeGoodCursor(partition)
    const healed = await linesFrom(() => {
      assert.notEqual(tryReadCursorSync(partition), null, 'the read now returns a cursor')
    }, RECOVERY)
    assert.equal(healed.length, 1, 'the read that clears an armed refusal retracts it')
    assert.match(healed[0], /INFO/, 'nothing is wrong, so it is not a second WARN')

    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, RECOVERY)).length, 0,
      'and it retracts it once, not on every healthy read after it')

    // The window went with the entry, so the same bytes coming back warn
    // again rather than waiting out a window armed for a condition that
    // had already ended.
    await writeRawCursor(partition, '{ not json')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1,
      'a refusal that reappears after a heal is a transition, not a repeat')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a retraction is not counted as a fresh refusal', async () => {
  // The one control over the exclusion `linesFrom` passes, and the reason
  // the argument is there: the retraction token is the refusal token plus a
  // suffix (`cursor_unreadable` inside `cursor_unreadable_recovered`), so a
  // substring filter for refusals reads a heal as one. The one other test
  // that meets that overlap ('an escaping cursor that degrades to garbage')
  // hand-rolls the same predicate inline over a `CURSOR_READ` capture, so
  // nothing but this routes the overlap through the argument. Without it the
  // argument could be dropped and all three suites would stay green while a
  // cleared condition counted as a fresh warning: the exact inversion of the
  // signal these controls count in the direction of.
  const partition = await makePartition()
  try {
    await writeRawCursor(partition, '{ not json')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1,
      'the refusal is armed, so the next healthy read has something to retract')

    await writeGoodCursor(partition)
    // That read is not silent - 'a heal after an unreadable refusal is
    // retracted exactly once' counts the line it emits on RECOVERY. What is
    // counted here is that the same line is not also read as a refusal.
    const healing = await linesFrom(() => {
      assert.notEqual(tryReadCursorSync(partition), null, 'the read now returns a cursor')
    }, REFUSAL)
    assert.equal(healing.length, 0, 'a heal is a retraction, never a refusal counted a second time')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('an escaping cursor that degrades to garbage leaves a refusal standing', async () => {
  // The retraction on its own was the hole: the escape report is cleared by
  // any read that does not refuse for escape, and a parse failure is one of
  // those, so a poisoned cursor that rotted further took its warning with
  // it and left the partition skipped in silence.
  const partition = await makePartition()
  try {
    await writeRawCursor(
      partition,
      JSON.stringify({ epoch: 1, rowCount: 3, compaction: null, layout: 'source-table', tableDir: '../out' })
    )
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, ESCAPE_REFUSAL)).length, 1)

    await writeRawCursor(partition, '{ not json')
    const degraded = await linesFrom(() => {
      assert.equal(tryReadCursorSync(partition), null, 'still skipped, for a different reason')
    }, CURSOR_READ)
    // Both halves of the handover, from the one read that performs it. The
    // arming alone is also counted by the tests above; only the pairing
    // pins that the retraction does not go out on its own.
    assert.equal(degraded.filter((line) => line.includes(ESCAPE_RECOVERY)).length, 1,
      'the escape refusal the bytes no longer prove is retracted')
    assert.equal(degraded.filter((line) => line.includes(REFUSAL) && !line.includes(RECOVERY)).length, 1,
      'and the same read arms the refusal that now stands')

    // The escape entry went with its retraction rather than staying armed,
    // so the same escaping value coming back warns as the transition it is
    // instead of waiting out a window opened before the bytes stopped
    // proving it.
    await writeRawCursor(
      partition,
      JSON.stringify({ epoch: 1, rowCount: 3, compaction: null, layout: 'source-table', tableDir: '../out' })
    )
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, ESCAPE_REFUSAL)).length, 1,
      'an escape refusal that comes back after a retraction is a transition, not a repeat')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a partition evicted while unreadable warns again when it comes back', async () => {
  // The strand LLP 0334#eviction-clears closed for the escape report, at
  // the same sites and for the same reason: the entry is keyed by path, the
  // eviction deletes the path, and a partition recreated there would
  // otherwise be throttled against a window armed for a directory that no
  // longer exists.
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-unreadable-evict-'))
  try {
    const partition = path.join(cacheRoot, 'datasets', 'logs', 'date=2026-01-01')
    // `epoch=0/`, not a table directly under the partition: with the cursor
    // unreadable the tick reads the layout-less epoch-0 default, and
    // `epoch=0` is the only live generation name that default matches. It is
    // also the one shape a real cache holds that this site can reach - an
    // epoch-layout partition never yet compacted - where a bare `metadata/`
    // beside a `cursor.json` is a shape no writer in the tree mints.
    const live = path.join(partition, 'epoch=0')
    await fs.mkdir(path.join(live, 'metadata'), { recursive: true })
    await fs.writeFile(path.join(live, 'metadata', 'v1.metadata.json'), '{}')
    await writeRawCursor(partition, '{ not json')
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
    await fs.utimes(live, old, old)
    await fs.utimes(partition, old, old)

    const enforcer = createRetentionEnforcer({ cacheRoot, config: undefined })
    const evicting = await linesFrom(() => enforcer.tick(), REFUSAL)
    assert.equal(evicting.length, 1, 'the evicting tick still says the cursor it read was unreadable')
    await assert.rejects(() => fs.stat(partition), 'and the eviction really removed the partition')

    await fs.mkdir(partition, { recursive: true })
    await writeRawCursor(partition, '{ not json')
    const reborn = await linesFrom(() => {
      assert.equal(tryReadCursorSync(partition), null)
    }, REFUSAL)
    assert.equal(reborn.length, 1, 'garbage on a partition this process never read is a transition, not a repeat')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a cursor.json that parses to anything but an object is unreadable', async () => {
  // Only `null` makes the field reads throw. An array, a number, a string
  // and a boolean all answer `undefined` to `.epoch`, so without a guard
  // they read as an epoch-0 cursor: `walkForRetired` then takes `epoch=0`
  // for the live generation, the real `table/` matches no live name, and
  // the orphan sweep removes it. Silently, and in the deleting direction.
  for (const bytes of ['[]', '5', '"x"', 'true', 'null']) {
    const partition = await makePartition()
    try {
      await fs.mkdir(path.join(partition, 'table'), { recursive: true })
      await writeRawCursor(partition, bytes)
      const lines = await linesFrom(() => {
        assert.equal(tryReadCursorSync(partition), null, `${bytes} is not a cursor`)
      }, REFUSAL)
      assert.equal(lines.length, 1, `${bytes} is refused out loud, not read as epoch 0`)
    } finally {
      await fs.rm(path.dirname(partition), { recursive: true, force: true })
    }
  }
})

test('a read failure that is not ENOENT leaves the refusal standing', async () => {
  // The bytes are still whatever they were, so the condition has not ended
  // and nothing may retract it. Only an absent cursor is "no cursor".
  const partition = await makePartition()
  try {
    await writeRawCursor(partition, '{ not json')
    assert.equal((await linesFrom(() => { tryReadCursorSync(partition) }, REFUSAL)).length, 1)

    // A directory in the cursor's place, not a chmod: EISDIR means the same
    // thing to a suite running as root, where mode bits do not.
    await fs.rm(path.join(partition, 'cursor.json'))
    await fs.mkdir(path.join(partition, 'cursor.json'))
    const failed = await linesFrom(() => {
      assert.equal(tryReadCursorSync(partition), null)
    }, CURSOR_READ)
    assert.equal(failed.filter((line) => line.includes(RECOVERY)).length, 0,
      'a read that itself failed retracts nothing')
    // Both halves, or the branch is only half pinned: an exit that retracts
    // nothing and reports nothing is the silent permanent skip this refusal
    // exists to remove, and it satisfies the assertion above on its own.
    assert.equal(failed.filter((line) => line.includes(REFUSAL) && !line.includes(RECOVERY)).length, 1,
      'the read that failed says so, as the new fact it is')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})
