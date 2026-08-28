// @ts-check

/**
 * Compaction is the second, harder half of the session-context eviction bug.
 *
 * The read window (LLP 0254 #policy-inline) decides what the reader sees of a
 * file the writer kept. These tests are about the file itself: once
 * `session-context.jsonl` genuinely reaches its cap, compaction rewrites it,
 * and dropping purely by position takes out whichever sessions have been
 * quiet, however live they are. A session whose record leaves the disk cannot
 * be recovered by any read window: `resolveSessionUsagePolicy` answers
 * `undetermined`, the listener withholds the batch, and the session's spooled
 * bodies are deleted unread.
 *
 * The two rules are coupled, so the tests exercise them together: retaining a
 * session's record past the window every reader actually reads leaves it on
 * disk and invisible, which is the same defect through the other door.
 *
 * @ref LLP 0286#endpoints-evicted-last [tests]: a session's endpoints are evicted
 *   last, so compaction cannot silence a live session nor strand its opening
 *   rows without a session-start record
 * @ref LLP 0286#writer-cap-is-clamped [tests]: what compaction keeps is inside
 *   the window the default reader reads
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SESSION_CONTEXT_MAX_BYTES,
  SESSION_CONTEXT_READ_TAIL_BYTES,
  appendSessionContext,
  pickLatestMatching,
  readSessionContext,
} from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'

const RETAINED = Math.min(SESSION_CONTEXT_MAX_BYTES, SESSION_CONTEXT_READ_TAIL_BYTES)

test('compaction keeps a quiet session while a noisy neighbour fills the file', async () => {
  const env = await stageEnv()
  try {
    const opts = { maxBytes: 700, maxRecords: 4 }
    await appendSessionContext(env.stateFile, record('quiet-session', '/repo/quiet', 0), opts)
    for (let i = 1; i <= 40; i++) {
      await appendSessionContext(env.stateFile, record('noisy-session', '/repo/noisy', i), opts)
    }

    const records = await readSessionContext(env.stateFile)
    const quiet = pickLatestMatching(records, { sessionId: 'quiet-session' })
    assert.equal(quiet?.cwd, '/repo/quiet', 'the quiet session lost its only record')
    assert.equal(pickLatestMatching(records, { sessionId: 'noisy-session' })?.ts, record('noisy-session', '/repo/noisy', 40).ts)

    // Endpoints, not history: what compaction gives up is the noisy session's
    // interior records, while its session start survives alongside its latest,
    // and the file stays bounded throughout.
    const noisy = records.filter((entry) => entry.session_id === 'noisy-session')
    assert.ok(
      noisy.some((entry) => entry.ts === record('noisy-session', '/repo/noisy', 1).ts),
      'the noisy session lost its session-start record'
    )
    assert.ok(
      !noisy.some((entry) => entry.ts === record('noisy-session', '/repo/noisy', 20).ts),
      'an interior noisy record survived, so nothing was actually evicted'
    )
    const stat = await fs.stat(env.stateFile)
    assert.ok(stat.size <= opts.maxBytes * 2, `file grew to ${stat.size} bytes`)
  } finally {
    await env.cleanup()
  }
})

test('compaction keeps a session-start record so an opening row still settles', async () => {
  const env = await stageEnv()
  try {
    const opts = { maxBytes: 1400 }
    // The live session OPENS FIRST, in an ignored dir, and keeps firing the hook
    // from a clean dir for the rest of the run. Its session-start record is
    // therefore the record nearest the FRONT of the file the whole time, which
    // is what makes this the case that discriminates: evicting endpoints by
    // their own position drops it first, though the session writing it is the
    // one session that never went quiet. Short one-shot neighbours run
    // alongside it, two records each so tier one has no interior to give.
    await appendSessionContext(env.stateFile, record('live', '/repo/ignored', 0), opts)
    for (let i = 0; i < 30; i++) {
      await appendSessionContext(env.stateFile, record(`dead-${i}`, `/repo/dead-${i}`, 1 + i), opts)
      await appendSessionContext(env.stateFile, record(`dead-${i}`, `/repo/dead-${i}`, 1 + i), opts)
      await appendSessionContext(env.stateFile, record('live', '/repo/clean', 40 + i), opts)
    }

    const records = await readSessionContext(env.stateFile)
    const live = records.filter((entry) => entry.session_id === 'live')
    // LLP 0085 resolves an opening row against the record live at the row's own
    // time. Without the session-start record, `pickRecordForRow` finds nothing
    // at-or-before the row and falls back to the earliest survivor: the clean
    // cwd, which retains a row settlement exists to drop.
    assert.equal(live[0]?.cwd, '/repo/ignored', 'the live session lost its session-start record')
    assert.equal(live.at(-1)?.cwd, '/repo/clean', 'the live session lost its latest record')
    // The neighbours are what paid for it: the file is over cap throughout, so
    // records were genuinely evicted rather than all of them fitting, and what
    // went is the sessions that stopped firing, oldest activity first.
    assert.ok(
      records.length < 61,
      `nothing was evicted (${records.length} records), so the test proves nothing`
    )
    assert.equal(
      pickLatestMatching(records, { sessionId: 'dead-0' }),
      undefined,
      'the first neighbour to go quiet outlived the live session, so eviction is still positional'
    )
  } finally {
    await env.cleanup()
  }
})


test('compaction clamps a caller cap wider than the window the reader reads', async () => {
  const env = await stageEnv()
  try {
    const padding = 'p'.repeat(8 * 1024)
    for (let i = 0; i < 160; i++) {
      await appendSessionContext(
        env.stateFile,
        record(`sess-${i}`, `/repo/${padding}/${i}`, i),
        // Four times the module cap: readers call `readSessionContext` with no
        // opts, so a wider writer cap keeps records no reader can see.
        { maxBytes: SESSION_CONTEXT_MAX_BYTES * 4 }
      )
    }

    const stat = await fs.stat(env.stateFile)
    assert.ok(
      stat.size <= RETAINED,
      `file grew to ${stat.size} bytes, past the ${RETAINED}-byte retained window`
    )

    // Everything the writer kept is inside the window the DEFAULT reader reads.
    const onDisk = (await fs.readFile(env.stateFile, 'utf8')).split('\n').filter(Boolean).length
    const read = await readSessionContext(env.stateFile)
    assert.equal(read.length, onDisk)
  } finally {
    await env.cleanup()
  }
})

test('the writer keeps no record the reader cannot see', async () => {
  const env = await stageEnv()
  try {
    const staged = filler(RETAINED + Math.floor(RETAINED / 8))
    await fs.writeFile(env.stateFile, staged, 'utf8')
    const before = await fs.stat(env.stateFile)
    assert.ok(
      before.size > RETAINED,
      'precondition: the file starts out past the readable window'
    )

    await appendSessionContext(env.stateFile, record('sess-live', '/repo/live', 9999))

    const onDisk = (await fs.readFile(env.stateFile, 'utf8')).split('\n').filter(Boolean).length
    const records = await readSessionContext(env.stateFile)
    assert.equal(
      records.length,
      onDisk,
      `every retained line must be readable: ${onDisk} on disk, ${records.length} readable`
    )
    assert.equal(
      pickLatestMatching(records, { sessionId: 'sess-live' })?.cwd,
      '/repo/live',
      'the record just appended must survive compaction'
    )
  } finally {
    await env.cleanup()
  }
})

test('a narrower maxBytes is still honored', async () => {
  const env = await stageEnv()
  try {
    for (let i = 0; i < 8; i++) {
      await appendSessionContext(env.stateFile, record(`sess-${i}`, `/repo/${i}`, i), {
        maxBytes: 240,
        maxRecords: 3,
      })
    }
    const stat = await fs.stat(env.stateFile)
    assert.ok(stat.size <= 240, 'the clamp is a ceiling, so a smaller cap still applies')
  } finally {
    await env.cleanup()
  }
})

test('a quiet session stays readable once the file reaches the module cap', async () => {
  const env = await stageEnv()
  try {
    // No opts: the module's own constants, which is what the hook uses.
    const padding = 'p'.repeat(4 * 1024)
    await appendSessionContext(env.stateFile, { ...record('quiet-session', '/repo/quiet', 0), git_branch: padding })
    for (let i = 1; i <= 300; i++) {
      await appendSessionContext(env.stateFile, { ...record('noisy-session', '/repo/noisy', i), git_branch: padding })
    }

    const stat = await fs.stat(env.stateFile)
    assert.ok(stat.size > RETAINED / 2, `file only reached ${stat.size} bytes, so no compaction ran`)

    // The default reader is the one every caller uses: `createSessionContextReader`,
    // settlement and backfill all call `readSessionContext` with no opts.
    const records = await readSessionContext(env.stateFile)
    assert.equal(
      pickLatestMatching(records, { sessionId: 'quiet-session' })?.cwd,
      '/repo/quiet',
      'the quiet session is on disk but outside the window any reader reads'
    )
  } finally {
    await env.cleanup()
  }
})

/**
 * @param {string} sessionId
 * @param {string} cwd
 * @param {number} tick
 */
function record(sessionId, cwd, tick) {
  return {
    session_id: sessionId,
    cwd,
    transcript_path: undefined,
    git_branch: undefined,
    ts: new Date(Date.UTC(2026, 7, 19, 10, 0, tick)).toISOString(),
  }
}

/** @param {number} targetBytes */
function filler(targetBytes) {
  const lines = []
  let bytes = 0
  for (let tick = 0; bytes < targetBytes; tick++) {
    const line = JSON.stringify(
      record('sess-noisy', '/repo/busy-with-a-long-enough-path', tick)
    ) + '\n'
    lines.push(line)
    bytes += Buffer.byteLength(line, 'utf8')
  }
  return lines.join('')
}

/**
 * @returns {Promise<{ stateFile: string, cleanup: () => Promise<void> }>}
 */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-session-compaction-'))
  const stateFile = path.join(homeDir, '.hyp', 'state', '@hypaware-claude', 'session-context.jsonl')
  await fs.mkdir(path.dirname(stateFile), { recursive: true })
  return {
    stateFile,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true })
    },
  }
}
