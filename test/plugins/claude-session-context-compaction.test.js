// @ts-check

/**
 * Compaction is the second, harder half of the session-context eviction bug.
 *
 * The read window (LLP 0254 #policy-inline, pinned by
 * `claude-telemetry-session-context-window.test.js`) decides what the reader
 * sees of a file the writer kept. These tests are about the file itself: once
 * `session-context.jsonl` genuinely reaches its cap, compaction rewrites it,
 * and dropping purely by position takes out whichever sessions have been
 * quiet, however live they are. A session whose record leaves the disk cannot
 * be recovered by any read window: `resolveSessionUsagePolicy` answers
 * `undetermined`, the listener withholds the batch, and the session's spooled
 * bodies are deleted unread.
 *
 * @ref LLP 0286#newest-per-session [tests]: a session's newest record is
 *   evicted last, so compaction cannot silence a live session
 * @ref LLP 0286#writer-cap-is-clamped [tests]: the caller's compaction cap
 *   never exceeds the module constant the reader's window is derived from
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SESSION_CONTEXT_MAX_BYTES,
  appendSessionContext,
  pickLatestMatching,
  readSessionContext,
} from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'

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

    // Presence, not history: what compaction gives up is the noisy session's
    // older records, and the file stays bounded while it does.
    const noisy = records.filter((entry) => entry.session_id === 'noisy-session')
    const firstNoisyTs = record('noisy-session', '/repo/noisy', 1).ts
    assert.ok(!noisy.some((entry) => entry.ts === firstNoisyTs), 'the oldest noisy record survived')
    const stat = await fs.stat(env.stateFile)
    assert.ok(stat.size <= opts.maxBytes * 2, `file grew to ${stat.size} bytes`)
  } finally {
    await env.cleanup()
  }
})

test('compaction clamps a caller cap wider than the module cap', async () => {
  const env = await stageEnv()
  try {
    const padding = 'p'.repeat(8 * 1024)
    for (let i = 0; i < 160; i++) {
      await appendSessionContext(
        env.stateFile,
        record(`sess-${i}`, `/repo/${padding}/${i}`, i),
        // Four times the module cap: the reader's window is a module constant
        // with no per-call seam, so a wider writer cap keeps records no reader
        // can see.
        { maxBytes: SESSION_CONTEXT_MAX_BYTES * 4 }
      )
    }

    const stat = await fs.stat(env.stateFile)
    assert.ok(
      stat.size <= SESSION_CONTEXT_MAX_BYTES,
      `file grew to ${stat.size} bytes, past the ${SESSION_CONTEXT_MAX_BYTES}-byte module cap`
    )

    // Everything the writer kept is inside the window the reader is allowed
    // to assume it may read.
    const onDisk = (await fs.readFile(env.stateFile, 'utf8')).split('\n').filter(Boolean).length
    const read = await readSessionContext(env.stateFile, { maxBytes: SESSION_CONTEXT_MAX_BYTES })
    assert.equal(read.length, onDisk)
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

/**
 * @returns {Promise<{ stateFile: string, cleanup: () => Promise<void> }>}
 */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-session-compaction-'))
  const stateFile = path.join(homeDir, '.hyp', 'state', '@hypaware-claude', 'session-context.jsonl')
  return {
    stateFile,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true })
    },
  }
}
