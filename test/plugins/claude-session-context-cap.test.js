// @ts-check

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

/**
 * The writer's compaction cap is a ceiling, not a suggestion.
 *
 * `appendSessionContext` takes a per-call `maxBytes`, but the reader has no
 * matching seam: `createSessionContextReader` reads the tail at
 * `SESSION_CONTEXT_READ_TAIL_BYTES` and every production caller takes the
 * default. So a file kept above that tail carries records the reader will
 * never look at, and on the OTEL ingest path an unseen record is not a null
 * column: `resolveSessionUsagePolicy` answers `undetermined`, the listener
 * withholds the batch, and the session's spooled bodies are deleted unread.
 *
 * Before this was enforced the invariant lived only in JSDoc. These tests pin
 * it structurally against the *reader's* window, not just the writer's module
 * cap: an assertion against `SESSION_CONTEXT_MAX_BYTES` alone still passes on
 * a build that keeps half a megabyte of records nobody can read.
 */

/** The largest file every retained record is still readable from. */
const READABLE_WINDOW = Math.min(SESSION_CONTEXT_MAX_BYTES, SESSION_CONTEXT_READ_TAIL_BYTES)

test('a caller cannot compact wider than the read window', async () => {
  const env = await stageEnv()
  try {
    await fs.writeFile(env.stateFile, filler(Math.floor(SESSION_CONTEXT_MAX_BYTES * 1.5)), 'utf8')
    const before = await fs.stat(env.stateFile)
    assert.ok(
      before.size > SESSION_CONTEXT_MAX_BYTES,
      'precondition: the file is already past the module cap'
    )

    await appendSessionContext(env.stateFile, record('sess-live', '/workspace/live', 9999), {
      maxBytes: SESSION_CONTEXT_MAX_BYTES * 4,
    })

    const after = await fs.stat(env.stateFile)
    assert.ok(
      after.size <= READABLE_WINDOW,
      `an over-wide maxBytes must be clamped to the read window, got ${after.size} bytes`
    )
    const records = await readSessionContext(env.stateFile)
    assert.equal(
      pickLatestMatching(records, { sessionId: 'sess-live' })?.cwd,
      '/workspace/live',
      'the record just appended must survive the clamped compaction'
    )
  } finally {
    await env.cleanup()
  }
})

test('the writer keeps no record the reader cannot see', async () => {
  const env = await stageEnv()
  try {
    // The gap the writer cap alone leaves open: a file bigger than the read
    // tail but under the module cap is never compacted, so its oldest lines
    // sit on disk outside every reader's window.
    const staged = filler(Math.floor((READABLE_WINDOW + SESSION_CONTEXT_MAX_BYTES) / 2))
    await fs.writeFile(env.stateFile, staged, 'utf8')
    const before = await fs.stat(env.stateFile)
    assert.ok(
      before.size > READABLE_WINDOW && before.size < SESSION_CONTEXT_MAX_BYTES,
      'precondition: the file sits between the read window and the module cap'
    )

    await appendSessionContext(env.stateFile, record('sess-live', '/workspace/live', 9999))

    const onDisk = (await fs.readFile(env.stateFile, 'utf8')).split('\n').filter(Boolean).length
    const records = await readSessionContext(env.stateFile)
    assert.equal(
      records.length,
      onDisk,
      `every retained line must be readable: ${onDisk} on disk, ${records.length} readable`
    )
    assert.equal(
      pickLatestMatching(records, { sessionId: 'sess-live' })?.cwd,
      '/workspace/live',
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
      await appendSessionContext(env.stateFile, record(`sess-${i}`, `/workspace/${i}`, i), {
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

/**
 * @param {string} sessionId
 * @param {string} cwd
 * @param {number} seq
 */
function record(sessionId, cwd, seq) {
  return {
    session_id: sessionId,
    transcript_path: undefined,
    cwd,
    git_branch: undefined,
    ts: new Date(Date.UTC(2026, 7, 18, 9, 0, 0) + seq * 1000).toISOString(),
  }
}

/** @param {number} targetBytes */
function filler(targetBytes) {
  const lines = []
  let bytes = 0
  for (let seq = 0; bytes < targetBytes; seq++) {
    const line = JSON.stringify(record('sess-noisy', '/workspace/busy-repo-with-a-long-enough-path', seq)) + '\n'
    lines.push(line)
    bytes += Buffer.byteLength(line, 'utf8')
  }
  return lines.join('')
}

/**
 * @returns {Promise<{ stateFile: string, cleanup: () => Promise<void> }>}
 */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-session-context-cap-'))
  const stateFile = path.join(homeDir, 'state', '@hypaware-claude', 'session-context.jsonl')
  await fs.mkdir(path.dirname(stateFile), { recursive: true })
  return {
    stateFile,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true })
    },
  }
}
