// @ts-check

// LLP 0322 gave a failed spool-to-cache flush a stamp, and the stamp a
// message. The stamp's *time* reached the query gate; its message reached
// nothing, so the only user-visible consequence of a standing failure was
// "the cache may be stale" with no way to learn why short of opening
// `_hypaware_spool` by hand. These tests pin the message all the way from
// `pendingInfo` to the `hyp status` capture-health line, and pin the line the
// stamp must never cross: it is a pacing record, so it may say why a retry is
// being held off and may not be read as a write that happened.
// @ref LLP 0322#what-the-stamp-is-not [tests]:

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createCacheSpool, SPOOL_DIR } from '../../src/core/cache/spool.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { settlePendingCacheForQuery } from '../../src/core/query/sql.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { CollectStatusOptions } from '../../src/core/daemon/types.js'
 */

const ESC = '\u001b'

// The three groups LLP 0225 decomposes the unsafe class into, so this file
// pins the strip policy at *this* call site rather than trusting that
// whatever the renderer happens to call still covers all three. An ESC-only
// assertion would pass against a hand-rolled `replace(/\u001b/g, '')`, and a
// lone carriage return or a bidi override would still reach the terminal.
// @ref LLP 0225#one-vocabulary [tests]: one class, three groups, and the label plane strips every one of them
const TERMINAL_DRIVING = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u2028-\\u2029]')
const BIDI_OR_INVISIBLE = new RegExp('[\\u061C\\u200E-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\u00AD\\u200B-\\u200D\\u2060-\\u2064\\uFEFF]')

const PARTITION_ERROR =
  'cache-iceberg: partition field "session_id" is new - adding a partition field is spec evolution and requires an explicit migration'

/** @type {ColumnSpec[]} */
const COLUMNS = [{ name: 'id', type: 'INT32', nullable: false }]

/** @param {string} prefix */
function makeRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/**
 * A spool whose commit step can be switched between rejecting and accepting,
 * so one test can span the failure and the repair.
 *
 * @param {string} cacheRoot
 * @param {string} [message]
 */
function spoolWithSwitchableCommit(cacheRoot, message = PARTITION_ERROR) {
  const state = { rejecting: true }
  const spool = createCacheSpool({
    cacheRoot,
    async appendChunk(_tablePath, _columns, rows) {
      if (state.rejecting) throw new Error(message)
      return { bytesWritten: rows.length }
    },
  })
  return { spool, state }
}

test("pendingInfo carries the failed flush's reason next to its time, and drops both on a flush that completed", async () => {
  const cacheRoot = await makeRoot('hyp-flush-failure-message-')
  try {
    const tablePath = path.join(cacheRoot, 'ai_gateway_messages')
    const { spool, state } = spoolWithSwitchableCommit(cacheRoot)

    await spool.append(tablePath, COLUMNS, [{ id: 1 }])
    await assert.rejects(() => spool.flushTable(tablePath, { reason: 'test' }))

    const info = await spool.pendingInfo(tablePath)
    assert.equal(typeof info.flushFailedAtMs, 'number', 'the failed flush leaves a readable stamp')
    // The regression: the stamp has always persisted this, and nothing read it.
    assert.equal(
      info.flushFailureMessage,
      PARTITION_ERROR,
      'pendingInfo reports why the flush failed, not only that it did'
    )

    // A pacing record is not a write. The freshness timestamp the staleness
    // line quotes must be untouched by an attempt that failed.
    // @ref LLP 0322#what-the-stamp-is-not [tests]:
    assert.equal(info.lastFlushAtMs, null, 'a failed attempt is not a write to the cache')

    state.rejecting = false
    await spool.flushTable(tablePath, { reason: 'test', force: true })
    const repaired = await spool.pendingInfo(tablePath)
    assert.equal(repaired.flushFailedAtMs ?? null, null)
    assert.equal(repaired.flushFailureMessage ?? null, null, 'the reason retires with the stamp')
    assert.equal(typeof repaired.lastFlushAtMs, 'number', 'and only now is a write recorded')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a stamp whose message is missing or unreadable still paces the retry, with no reason to give', async () => {
  const cacheRoot = await makeRoot('hyp-flush-failure-message-partial-')
  try {
    const tablePath = path.join(cacheRoot, 'ai_gateway_messages')
    const { spool } = spoolWithSwitchableCommit(cacheRoot)
    await spool.append(tablePath, COLUMNS, [{ id: 1 }])

    const stampPath = path.join(tablePath, SPOOL_DIR, 'last-flush-failure.json')
    await fs.mkdir(path.dirname(stampPath), { recursive: true })
    for (const errorMessage of [undefined, '', 42]) {
      await fs.writeFile(
        stampPath,
        JSON.stringify({
          failedAt: new Date().toISOString(),
          ...(errorMessage === undefined ? {} : { errorMessage }),
        })
      )
      const info = await spool.pendingInfo(tablePath)
      assert.equal(typeof info.flushFailedAtMs, 'number', 'the pacing half never depends on the message')
      assert.equal(info.flushFailureMessage ?? null, null)
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('the cooling-down query still says only that the cache may be stale, never that a write happened', async () => {
  const cacheRoot = await makeRoot('hyp-flush-failure-message-query-')
  try {
    const tablePath = path.join(cacheRoot, 'ai_gateway_messages')
    const { spool } = spoolWithSwitchableCommit(cacheRoot)
    const storage = {
      cacheRoot,
      /** @param {string} p */
      pendingInfo: (p) => spool.pendingInfo(p),
      /**
       * @param {string} p
       * @param {{ reason?: string, force?: boolean }} [o]
       */
      flushTable: (p, o) => spool.flushTable(p, o),
    }

    await spool.append(tablePath, COLUMNS, [{ id: 1 }])
    /** @type {string[]} */
    const first = []
    await settlePendingCacheForQuery({
      partitions: [{ tablePath }],
      storage: /** @type {any} */ (storage),
      refresh: 'auto',
      messages: first,
    })
    /** @type {string[]} */
    const cooled = []
    const second = await settlePendingCacheForQuery({
      partitions: [{ tablePath }],
      storage: /** @type {any} */ (storage),
      refresh: 'auto',
      messages: cooled,
    })

    assert.equal(second.degraded, true)
    // The stamp reaches the status surface, and still does not reach this
    // one: the freshness line quotes `lastFlushAtMs`, which no failure moves.
    // @ref LLP 0322#what-the-stamp-is-not [tests]:
    assert.equal(cooled.some((m) => m.includes('last write to query cache')), false)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

/* ---------- hyp status ---------- */

/** @returns {{ write(chunk: string): void, text(): string }} */
function buffer() {
  /** @type {string[]} */
  const chunks = []
  return { write: (chunk) => { chunks.push(chunk) }, text: () => chunks.join('') }
}

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-flush-failure-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, cacheRoot: path.join(stateRoot, 'cache') }
}

/**
 * @param {string} cacheRoot
 * @param {string} table
 * @param {{ failedAt: string, errorMessage?: unknown }} stamp
 */
async function writeStamp(cacheRoot, table, stamp) {
  const dir = path.join(cacheRoot, 'datasets', table, SPOOL_DIR)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'last-flush-failure.json'), JSON.stringify(stamp))
}

test('hyp status names the table whose flush is failing and quotes the reason', async () => {
  const { hypHome, cacheRoot } = await makeHome()
  try {
    await writeStamp(cacheRoot, path.join('ai_gateway_messages', 'source=claude'), {
      failedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      errorMessage: PARTITION_ERROR,
    })
    // Older than the ten-minute window: the failure stands, but the next
    // automatic query will attempt the flush again rather than skip it.
    await writeStamp(cacheRoot, path.join('traces', 'source=codex'), {
      failedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      errorMessage: 'ENOSPC: no space left on device',
    })

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(report.cacheFlushFailures.length, 2)
    // Newest failure first.
    assert.equal(
      report.cacheFlushFailures[0].table,
      path.join('datasets', 'ai_gateway_messages', 'source=claude')
    )
    assert.equal(report.cacheFlushFailures[0].errorMessage, PARTITION_ERROR)
    assert.equal(report.cacheFlushFailures[0].stillCoolingDown, true)
    assert.equal(report.cacheFlushFailures[1].stillCoolingDown, false)

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot, stdout })
    const text = stdout.text()
    assert.match(text, /capture health:/)
    assert.match(
      text,
      /- cache flush \(datasets[\\/]ai_gateway_messages[\\/]source=claude\) {2}last attempt failed 4m ago: cache-iceberg: partition field "session_id" is new/
    )
    assert.match(text, /\[refresh cooling down\]/)
    assert.match(
      text,
      /- cache flush \(datasets[\\/]traces[\\/]source=codex\) {2}last attempt failed 3h ago: ENOSPC: no space left on device\n/
    )

    // The separation, on the rendered surface: the failure is a reason, not
    // a freshness claim, so no line here reports a write to the cache.
    // @ref LLP 0322#what-the-stamp-is-not [tests]:
    assert.doesNotMatch(text, /last write to query cache/)

    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot })
    assert.equal(json.cache_flush_failures.length, 2)
    assert.equal(json.cache_flush_failures[0].error_message, PARTITION_ERROR)
    assert.equal(json.cache_flush_failures[0].still_cooling_down, true)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a healthy cache adds no line, and a hostile stamp cannot repaint the terminal', async () => {
  const { hypHome, cacheRoot } = await makeHome()
  try {
    await fs.mkdir(path.join(cacheRoot, 'datasets'), { recursive: true })
    const clean = await collectHypAwareStatus(collectOpts(hypHome))
    assert.deepEqual(clean.cacheFlushFailures, [])
    const quiet = buffer()
    renderStatusText({ report: clean, clientNames: [], datasets: [], cacheRoot, stdout: quiet })
    assert.doesNotMatch(quiet.text(), /cache flush \(/)

    // The stamp is a file some other process wrote, so its message reaches a
    // TTY with no guarantee of being short, printable, or single-line.
    // One payload per way a captured string drives a terminal: an erase-screen
    // CSI, an OSC 8 hyperlink, a carriage return that overwrites the line, a
    // backspace run that rewrites what was already printed, a forged status
    // line, a raw C1 CSI and a DEL, a Unicode line separator, a right-to-left
    // override that reorders everything after it, a zero-width run, and more
    // characters than the line may spend.
    const hostile = [
      `${ESC}[2J${ESC}[Hforged`,
      `${ESC}]8;;http://evil${ESC}\u0007click${ESC}]8;;${ESC}\u0007`,
      'benign\rEVIL',
      'realmsg\b\b\b\b\b\b\bFAKE',
      '\n  daemon:         running',
      '\u009b2J\u007f\u0085',
      '\u2028  daemon: running\u2029',
      'gnitsurt\u202e evil \u202c\u2066x\u2069',
      'a\u200bb\u200dc\ufeffd\u00ade',
      'x'.repeat(600),
    ].join('')
    await writeStamp(cacheRoot, 'ai_gateway_messages', {
      failedAt: new Date().toISOString(),
      errorMessage: hostile,
    })
    const report = await collectHypAwareStatus(collectOpts(hypHome))
    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot, stdout })
    const text = stdout.text()
    const line = text.split('\n').find((l) => l.includes('cache flush ('))
    assert.ok(line, 'the failure is still reported')
    assert.equal(line.includes(ESC), false, 'no escape byte survives to the terminal')
    const driving = line.match(TERMINAL_DRIVING)
    assert.equal(
      driving,
      null,
      `no character that drives a terminal survives, got U+${driving?.[0].codePointAt(0)?.toString(16)}`
    )
    const reordering = line.match(BIDI_OR_INVISIBLE)
    assert.equal(
      reordering,
      null,
      `no character that reorders or hides survives, got U+${reordering?.[0].codePointAt(0)?.toString(16)}`
    )
    assert.equal(
      text.split('\n').filter((l) => l === '  daemon:         running').length,
      0,
      'no forged status line survives'
    )
    assert.ok(line.length < 320, `the message is clipped, got ${line.length} chars`)

    // `--json` is byte-exact: a program reading the payload gets what was
    // stamped, clamped only by the 512 the writer applies.
    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot })
    assert.equal(json.cache_flush_failures[0].error_message, hostile.slice(0, 512))
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('the capped list still reports how many tables it is not naming', async () => {
  const { hypHome, cacheRoot } = await makeHome()
  try {
    // Twelve tables, all refusing writes. Eight is a screenful and the cap is
    // right; showing eight and implying that is the whole incident is not.
    // The same rule `MAX_SKIPPED_PARTITIONS_REPORTED` settled for the
    // maintenance block: cap the list, never the size of the problem.
    for (let i = 0; i < 12; i++) {
      await writeStamp(cacheRoot, `t${String(i).padStart(2, '0')}`, {
        failedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
        errorMessage: 'ENOSPC: no space left on device',
      })
    }

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(report.cacheFlushFailures.length, 8, 'the list is capped')
    assert.equal(report.cacheFlushFailuresTotal, 12, 'the count is not')

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot, stdout })
    const text = stdout.text()
    assert.equal(text.split('\n').filter((l) => l.includes('cache flush (')).length, 8)
    assert.match(text, /\.\.\. and 4 more tables whose last flush failed/)

    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot })
    assert.equal(json.cache_flush_failures.length, 8)
    assert.equal(json.cache_flush_failures_total, 12)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('an uncapped list says nothing about tables it is not hiding', async () => {
  const { hypHome, cacheRoot } = await makeHome()
  try {
    await writeStamp(cacheRoot, 'only_one', {
      failedAt: new Date().toISOString(),
      errorMessage: 'ENOSPC: no space left on device',
    })
    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(report.cacheFlushFailuresTotal, 1)
    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot, stdout })
    assert.doesNotMatch(stdout.text(), /\.\.\. and \d+ more table/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
