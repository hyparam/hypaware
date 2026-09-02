// @ts-check

/**
 * The read window's boundary. `readSessionContext` reads the last `maxBytes`
 * of the JSONL channel and discards the partial record the cut leaves at the
 * front. A cut that happens to land on a record edge leaves no fragment, so a
 * discard that fires on that case eats a whole intact record - silently, since
 * the reader's whole contract is best-effort: no error, no log line, just one
 * fewer session-context record handed to the projector.
 *
 * Both halves are pinned here, because the fix for one is the way to break the
 * other: a boundary inside a record must still lose exactly that fragment.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  pickLatestMatching,
  readSessionContext,
} from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'

test('a read-tail boundary that lands on a record edge keeps that record', async () => {
  const env = await stageEnv()
  try {
    // Older than the window, so out of it no matter what the boundary does.
    const head = [line('older-a', '/repo/older-a'), line('older-b', '/repo/older-b')]
    // The window, to the byte: its first record starts exactly where the read
    // starts, so there is no leading fragment to discard.
    const tail = [
      line('edge-session', '/repo/edge'),
      line('later-session', '/repo/later'),
    ]
    const maxBytes = bytesOf(tail)
    await fs.writeFile(env.stateFile, [...head, ...tail].join('\n') + '\n', 'utf8')
    const { size } = await fs.stat(env.stateFile)
    assert.equal(
      size - maxBytes,
      bytesOf(head),
      'the fixture puts the boundary exactly on the first byte of a record',
    )

    const records = await readSessionContext(env.stateFile, { maxBytes })
    assert.equal(
      pickLatestMatching(records, { sessionId: 'edge-session' })?.cwd,
      '/repo/edge',
      'the record the boundary lands on was discarded as if it were a fragment',
    )
    assert.equal(
      pickLatestMatching(records, { sessionId: 'later-session' })?.cwd,
      '/repo/later',
    )
    assert.equal(
      pickLatestMatching(records, { sessionId: 'older-b' }),
      undefined,
      'a record before the window must stay outside it',
    )
  } finally {
    await env.cleanup()
  }
})

test('a read-tail boundary inside a record still drops that fragment', async () => {
  const env = await stageEnv()
  try {
    const cut = line('cut-session', '/repo/cut')
    const tail = [line('whole-session', '/repo/whole')]
    // Half of the cut record plus the whole tail: the read begins mid-record.
    const maxBytes = bytesOf(tail) + Math.floor(Buffer.byteLength(cut) / 2)
    await fs.writeFile(env.stateFile, [cut, ...tail].join('\n') + '\n', 'utf8')

    const records = await readSessionContext(env.stateFile, { maxBytes })
    assert.equal(
      pickLatestMatching(records, { sessionId: 'cut-session' }),
      undefined,
      'half a record is not a record',
    )
    assert.equal(
      pickLatestMatching(records, { sessionId: 'whole-session' })?.cwd,
      '/repo/whole',
    )
  } finally {
    await env.cleanup()
  }
})

test('a file smaller than the window keeps its first record', async () => {
  const env = await stageEnv()
  try {
    const lines = [line('first-session', '/repo/first'), line('second-session', '/repo/second')]
    await fs.writeFile(env.stateFile, lines.join('\n') + '\n', 'utf8')

    const records = await readSessionContext(env.stateFile, { maxBytes: bytesOf(lines) * 4 })
    assert.equal(
      pickLatestMatching(records, { sessionId: 'first-session' })?.cwd,
      '/repo/first',
      'a read from byte 0 has no fragment in front of it',
    )
  } finally {
    await env.cleanup()
  }
})

/**
 * @param {string} sessionId
 * @param {string} cwd
 */
function line(sessionId, cwd) {
  return JSON.stringify({
    session_id: sessionId,
    cwd,
    ts: new Date(Date.UTC(2026, 7, 19, 10, 0, 0)).toISOString(),
  })
}

/** @param {string[]} lines */
function bytesOf(lines) {
  return lines.reduce((sum, entry) => sum + Buffer.byteLength(entry) + 1, 0)
}

async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-session-read-tail-'))
  const stateFile = path.join(homeDir, '.hyp', 'state', '@hypaware-claude', 'session-context.jsonl')
  await fs.mkdir(path.dirname(stateFile), { recursive: true })
  return {
    stateFile,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true })
    },
  }
}
