// @ts-check

// LLP 0332: the cursor containment refusal warns per condition, not per
// read. Every destructive reader shares `tryReadCursorSync` (LLP
// 0323#one-gate), so one poisoned cursor used to cost one identical stderr
// line per caller that happened to read it: two per `hyp purge --all`, up
// to seven per daemon maintenance tick. The report now warns on transition,
// rewarns at most once per interval while the condition stands, and resets
// the moment a read stops refusing.
//
// Both directions are pinned, because the dangerous failure mode of any
// throttle is suppressing the signal outright: the window dedups, and the
// transition, the changed value, and the interval expiry all still warn.
//
// @ref LLP 0332#testable [tests]: the rate is counted in both directions; the throttle is a floor, never a lifetime mute.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { tryReadCursorSync } from '../../src/core/cache/partition.js'

// Kept equal to ESCAPE_REWARN_MS in src/core/cache/partition.js, which is
// deliberately not exported: the window is a reporting detail, not API.
const ESCAPE_REWARN_MS = 10 * 60 * 1000

/**
 * A fresh partition directory carrying a cursor whose `tableDir` is the
 * given value. A value like `"../out"` fails the bare-segment rule and is
 * refused at every read (LLP 0323); no symlink needs planting for the rate
 * tests, which are about the report, not the gate.
 *
 * @param {string} partitionDir
 * @param {unknown} tableDir
 */
async function writeCursor(partitionDir, tableDir) {
  await fs.writeFile(
    path.join(partitionDir, 'cursor.json'),
    JSON.stringify({ epoch: 1, rowCount: 3, compaction: null, layout: 'source-table', tableDir })
  )
}

/** @returns {Promise<string>} */
async function makePartition() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cursor-rewarn-'))
  const partition = path.join(root, 'source=claude')
  await fs.mkdir(partition, { recursive: true })
  return partition
}

/**
 * Capture what `fn` writes to the real `process.stderr`, where the mirror
 * deliberately writes (LLP 0329#consequences), and return the refusal lines.
 *
 * @param {() => void} fn
 * @returns {string[]}
 */
function refusalLines(fn) {
  const realWrite = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = /** @type {typeof process.stderr.write} */ ((chunk) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })
  try {
    fn()
  } finally {
    process.stderr.write = realWrite
  }
  return captured.split('\n').filter((line) => line.includes('cursor_table_dir_escapes_partition'))
}

test('two reads of one standing refusal cost one line, and never zero', async () => {
  const partition = await makePartition()
  try {
    await writeCursor(partition, '../out')
    const lines = refusalLines(() => {
      assert.equal(tryReadCursorSync(partition), null)
      assert.equal(tryReadCursorSync(partition), null)
    })
    assert.equal(lines.length, 1, 'the second read of the same condition is the same fact, not a second line')
    assert.match(lines[0], /WARN/, 'the one line is still the refusal at its own severity')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a heal resets the window: a repoisoned partition warns afresh', async () => {
  const partition = await makePartition()
  try {
    await writeCursor(partition, '../out')
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1)

    // The self-heal path in practice: the next append rewrites cursor.json
    // with a contained tableDir. A healthy read says nothing and clears.
    await writeCursor(partition, 'table')
    await fs.mkdir(path.join(partition, 'table'), { recursive: true })
    assert.equal(refusalLines(() => {
      assert.notEqual(tryReadCursorSync(partition), null)
    }).length, 0, 'a healthy read is silent')

    await writeCursor(partition, '../out')
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1,
      'the reappeared condition is a transition and warns immediately')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a changed rejected value warns without waiting out the window', async () => {
  const partition = await makePartition()
  try {
    await writeCursor(partition, '../a')
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1)
    await writeCursor(partition, '../b')
    const lines = refusalLines(() => { tryReadCursorSync(partition) })
    assert.equal(lines.length, 1, 'a poison that changes shape is a new fact, never absorbed into the old window')
    assert.match(lines[0], /\.\.\/b/, 'and the line names the new value')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('an unchanged standing refusal says it again once the interval passes', async (t) => {
  const partition = await makePartition()
  try {
    await writeCursor(partition, '../out')
    t.mock.timers.enable({ apis: ['Date'], now: 60_000 })
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1)
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 0, 'inside the window: quiet')
    t.mock.timers.tick(ESCAPE_REWARN_MS)
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1,
      'the throttle is a floor: a standing condition is never mute for the process lifetime')
  } finally {
    t.mock.timers.reset()
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a cursor.json that vanishes resets the window, so the next poison warns', async () => {
  const partition = await makePartition()
  try {
    await writeCursor(partition, '../out')
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1)

    // "No cursor" is not the escape condition, so it re-arms the transition
    // just as a healthy read does (LLP 0332#transition-plus-rewarn).
    await fs.rm(path.join(partition, 'cursor.json'))
    assert.equal(refusalLines(() => {
      assert.equal(tryReadCursorSync(partition), null)
    }).length, 0, 'an absent cursor is silent')

    await writeCursor(partition, '../out')
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1,
      'the refusal that reappears after an absence is a transition, not a repeat')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('an unparseable cursor resets the window, so the next poison warns', async () => {
  const partition = await makePartition()
  try {
    await writeCursor(partition, '../out')
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1)

    // Unreadable-for-another-reason is not the escape condition either.
    await fs.writeFile(path.join(partition, 'cursor.json'), '{ not json')
    assert.equal(refusalLines(() => {
      assert.equal(tryReadCursorSync(partition), null)
    }).length, 0, 'a corrupt cursor is silent about escape')

    await writeCursor(partition, '../out')
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1,
      'the refusal that reappears after a parse failure is a transition, not a repeat')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a wall clock that steps backwards cannot mute a standing refusal', async (t) => {
  const partition = await makePartition()
  try {
    await writeCursor(partition, '../out')
    t.mock.timers.enable({ apis: ['Date'], now: 4 * ESCAPE_REWARN_MS })
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1)

    // `Date.now` is NTP-steppable. A backwards step makes the recorded warn
    // look like it is in the future, and a naive age comparison would then
    // stay quiet until the clock caught up - silence, the one degradation
    // this throttle promises it can never have (LLP 0332#not-a-pass-object).
    t.mock.timers.setTime(ESCAPE_REWARN_MS)
    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1,
      'a window that cannot be proven to hold is not a window')
  } finally {
    t.mock.timers.reset()
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})

test('a refusal the log channel could not deliver is not recorded as said', async () => {
  const partition = await makePartition()
  try {
    await writeCursor(partition, '../out')

    // The mirror writes after the OTel emit inside `getLogger`, so a provider
    // that throws takes the whole line with it. Modelled here by a stderr
    // that throws, which is the same shape: the warn raises, the cursor read
    // still succeeds in refusing, and nothing reached the operator.
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = /** @type {typeof process.stderr.write} */ (() => { throw new Error('no channel') })
    try {
      assert.equal(tryReadCursorSync(partition), null, 'the read still refuses')
    } finally {
      process.stderr.write = realWrite
    }

    assert.equal(refusalLines(() => { tryReadCursorSync(partition) }).length, 1,
      'the undelivered warn armed no window, so the next read says it for real')
  } finally {
    await fs.rm(path.dirname(partition), { recursive: true, force: true })
  }
})
