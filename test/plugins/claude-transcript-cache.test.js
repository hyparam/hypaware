// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTranscriptLoader } from '../../hypaware-core/plugins-workspace/claude/src/transcript-cache.js'

/**
 * The incremental transcript loader: parse work per load must track
 * appended bytes, while anything that breaks the append-only picture
 * (truncation, in-place rewrite, a half-written tail) degrades safely
 * to a full re-read or a wait-for-completion, never a wrong result.
 */

const SESSION = 'cache-test-session'

/** @param {string} uuid @param {string} text @param {number} tick */
function line(uuid, text, tick) {
  return JSON.stringify({
    sessionId: SESSION,
    uuid,
    parentUuid: null,
    type: 'user',
    timestamp: new Date(1756160000000 + tick * 1000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

async function stage() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-tcache-'))
  return {
    dir,
    file: path.join(dir, `${SESSION}.jsonl`),
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
  }
}

test('a second load parses only the appended lines, reusing prior entries', async () => {
  const env = await stage()
  try {
    const loader = createTranscriptLoader()
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n' + line('u-2', 'two', 2) + '\n')
    const first = await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })
    assert.deepEqual(first.map((e) => e.provider_uuid), ['u-1', 'u-2'])

    await fsp.appendFile(env.file, line('u-3', 'three', 3) + '\n')
    const second = await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })
    assert.deepEqual(second.map((e) => e.provider_uuid), ['u-1', 'u-2', 'u-3'])
    // Same objects, not re-parsed copies: the tail read must not have
    // touched the already-consumed region.
    assert.equal(second[0], first[0])
    assert.equal(second[1], first[1])
  } finally {
    await env.cleanup()
  }
})

test('truncation discards the cached state and re-reads from byte zero', async () => {
  const env = await stage()
  try {
    const loader = createTranscriptLoader()
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n' + line('u-2', 'two', 2) + '\n')
    await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })

    await fsp.writeFile(env.file, line('u-9', 'rewritten', 9) + '\n')
    const after = await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })
    assert.deepEqual(after.map((e) => e.provider_uuid), ['u-9'])
  } finally {
    await env.cleanup()
  }
})

test('a half-written tail line is left for the next load, then consumed once complete', async () => {
  const env = await stage()
  try {
    const loader = createTranscriptLoader()
    const partial = line('u-2', 'two', 2)
    const head = partial.slice(0, 20)
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n' + head)
    const first = await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })
    assert.deepEqual(first.map((e) => e.provider_uuid), ['u-1'], 'the unterminated tail is not consumed')

    await fsp.appendFile(env.file, partial.slice(20) + '\n')
    const second = await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })
    assert.deepEqual(second.map((e) => e.provider_uuid), ['u-1', 'u-2'], 'the completed line is consumed exactly once')
  } finally {
    await env.cleanup()
  }
})

test('subagent files appearing after the first load are picked up', async () => {
  const env = await stage()
  try {
    const loader = createTranscriptLoader()
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n')
    const first = await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })
    assert.equal(first.length, 1)

    const subDir = path.join(env.dir, SESSION, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    await fsp.writeFile(path.join(subDir, 'agent-1.jsonl'), line('u-sub', 'sub work', 2) + '\n')
    const second = await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })
    assert.deepEqual(second.map((e) => e.provider_uuid), ['u-1', 'u-sub'])
  } finally {
    await env.cleanup()
  }
})

test('files over the retained budget are evicted once idle, and reload correctly', async () => {
  const env = await stage()
  try {
    let clock = 0
    const loader = createTranscriptLoader({ maxRetainedBytes: 64, now: () => clock })
    const other = path.join(env.dir, 'other-session.jsonl')
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n')
    await fsp.writeFile(other, line('u-9', 'nine', 9) + '\n')

    await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })
    clock += 120_000
    const second = await loader.load({ projectsDir: env.dir, sessionId: 'other-session', transcriptPath: other })
    assert.deepEqual(second.map((e) => e.provider_uuid), ['u-9'])
    // The first file was evicted (idle, over budget); loading it again
    // still returns full content via a fresh from-zero read.
    clock += 120_000
    const third = await loader.load({ projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file })
    assert.deepEqual(third.map((e) => e.provider_uuid), ['u-1'])
  } finally {
    await env.cleanup()
  }
})
