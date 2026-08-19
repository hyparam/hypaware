// @ts-check

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

/**
 * The writer's compaction cap is a ceiling, not a suggestion.
 *
 * `appendSessionContext` takes a per-call `maxBytes`, but the reader has no
 * matching seam: `createSessionContextReader` reads the tail at a module
 * constant and every production caller takes the default. So a caller that
 * compacts to a window wider than `SESSION_CONTEXT_MAX_BYTES` keeps records
 * the reader will never look at, and on the OTEL ingest path an unseen record
 * is not a null column: `resolveSessionUsagePolicy` answers `undetermined`,
 * the listener withholds the batch, and the session's spooled bodies are
 * deleted unread.
 *
 * Before this was enforced the invariant lived only in JSDoc. These tests pin
 * it structurally: the option may narrow the cap, never widen it.
 */

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
      after.size <= SESSION_CONTEXT_MAX_BYTES,
      `an over-wide maxBytes must be clamped to the module cap, got ${after.size} bytes`
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
