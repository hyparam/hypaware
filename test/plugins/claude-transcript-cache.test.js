// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTranscriptLoader } from '../../hypaware-core/plugins-workspace/claude/src/transcript-cache.js'
import { loadTranscript, transcriptEntryFromRow } from '../../hypaware-core/plugins-workspace/claude/src/transcripts.js'

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

test('unchanged main and subagent files read zero bytes, then an append reads only its tail', async () => {
  const env = await stage()
  const realCreateReadStream = fs.createReadStream
  try {
    const loader = createTranscriptLoader()
    const subDir = path.join(env.dir, SESSION, 'subagents')
    const subFile = path.join(subDir, 'agent-1.jsonl')
    await fsp.mkdir(subDir, { recursive: true })
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n')
    await fsp.writeFile(subFile, line('u-sub-1', 'sub one', 2) + '\n')
    const opts = { projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file }
    await loader.load(opts)

    let bytesRead = 0
    fs.createReadStream = (/** @type {any[]} */ ...args) => {
      const stream = Reflect.apply(realCreateReadStream, fs, args)
      stream.on('data', (chunk) => { bytesRead += chunk.length })
      return stream
    }
    const unchanged = await loader.load(opts)
    assert.deepEqual(unchanged.map((e) => e.provider_uuid), ['u-1', 'u-sub-1'])
    assert.equal(bytesRead, 0, 'an unchanged session must not reopen transcript contents')

    const appended = line('u-sub-2', 'sub two', 3) + '\n'
    await fsp.appendFile(subFile, appended)
    const grown = await loader.load(opts)
    assert.deepEqual(grown.map((e) => e.provider_uuid), ['u-1', 'u-sub-1', 'u-sub-2'])
    assert.equal(bytesRead, Buffer.byteLength(appended), 'only the appended subagent tail is read')
  } finally {
    fs.createReadStream = realCreateReadStream
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

test('a complete final line with no trailing newline is returned, exactly like the uncached reader', async () => {
  const env = await stage()
  try {
    const loader = createTranscriptLoader()
    // Claude Code newline-terminates its writes, but the readline-based
    // reader also yields an unterminated final line, and a session that
    // has stopped growing would otherwise lose its newest entry forever.
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n' + line('u-2', 'two', 2))
    const opts = { projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file }
    const uncached = await loadTranscript(opts)
    assert.deepEqual(uncached.map((e) => e.provider_uuid), ['u-1', 'u-2'])

    const first = await loader.load(opts)
    assert.deepEqual(first.map((e) => e.provider_uuid), ['u-1', 'u-2'])
    // Nothing changed on disk: the tail must still be reported, and the
    // repeat must not double it.
    const second = await loader.load(opts)
    assert.deepEqual(second.map((e) => e.provider_uuid), ['u-1', 'u-2'])

    // Once its newline lands the line is consumed for real, still once.
    await fsp.appendFile(env.file, '\n' + line('u-3', 'three', 3) + '\n')
    const third = await loader.load(opts)
    assert.deepEqual(third.map((e) => e.provider_uuid), ['u-1', 'u-2', 'u-3'])
  } finally {
    await env.cleanup()
  }
})

test('a read that fails partway is re-read from zero on the next load, not left truncated', async () => {
  const env = await stage()
  try {
    const loader = createTranscriptLoader()
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n' + line('u-2', 'two', 2) + '\n')
    const opts = { projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file }

    const patchable = /** @type {any} */ (fs)
    const realCreate = patchable.createReadStream
    let failed = false
    // Fail the first read outright: a transient error must not pin a
    // short view of the file for the loader's lifetime.
    patchable.createReadStream = (/** @type {any[]} */ ...args) => {
      if (!failed) {
        failed = true
        throw new Error('EIO')
      }
      return realCreate(...args)
    }
    let first
    try {
      first = await loader.load(opts)
    } finally {
      patchable.createReadStream = realCreate
    }
    assert.deepEqual(first.map((e) => e.provider_uuid), [], 'the failed read yields nothing')

    const second = await loader.load(opts)
    assert.deepEqual(second.map((e) => e.provider_uuid), ['u-1', 'u-2'], 'the next load recovers the whole file')
  } finally {
    await env.cleanup()
  }
})

test('a vanished file yields nothing rather than a last stale copy', async () => {
  const env = await stage()
  try {
    const loader = createTranscriptLoader()
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n')
    const opts = { projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file }
    assert.equal((await loader.load(opts)).length, 1)

    await fsp.rm(env.file)
    assert.deepEqual(await loader.load(opts), [], 'the pruned file contributes nothing')
  } finally {
    await env.cleanup()
  }
})

test('overlapping loads of one session consume appended bytes exactly once', async () => {
  const env = await stage()
  try {
    const loader = createTranscriptLoader()
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n')
    const opts = { projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file }
    await loader.load(opts)

    await fsp.appendFile(env.file, line('u-2', 'two', 2) + '\n')
    // The proxy fires exchange finalizations without awaiting them.
    const [a, b] = await Promise.all([loader.load(opts), loader.load(opts)])
    assert.deepEqual(a.map((e) => e.provider_uuid), ['u-1', 'u-2'])
    assert.deepEqual(b.map((e) => e.provider_uuid), ['u-1', 'u-2'])
  } finally {
    await env.cleanup()
  }
})

/**
 * A JSON-parseable line that `transcriptEntryFromRow` cannot project:
 * its content key is hashed through a recursive canonicalizer, so deep
 * nesting (a `toolUseResult` is arbitrary third-party JSON) throws a
 * RangeError rather than returning undefined. The uncached reader
 * contains that to its own file; the cache must not turn it into a
 * whole-session loss or a permanent re-read.
 */
function pathologicalLine(uuid) {
  let inner = '{"type":"text","text":"x"}'
  for (let i = 0; i < 12_000; i++) inner = '{"a":' + inner + '}'
  return `{"sessionId":"${SESSION}","uuid":"${uuid}","type":"user",` +
    `"message":{"role":"user","content":[${inner}]}}`
}

/** @param {string} raw */
function assertUnprojectable(raw) {
  const row = JSON.parse(raw)
  assert.throws(() => transcriptEntryFromRow(row), RangeError, 'precondition: the line must be JSON but unprojectable')
}

test('an unprojectable final line is skipped, not rejected for the whole session', async () => {
  const env = await stage()
  try {
    const bad = pathologicalLine('u-bad')
    assertUnprojectable(bad)
    const loader = createTranscriptLoader()
    // Unterminated, so it is the re-derived tail: an escape from there
    // rejects `advance`, and the witnesses are only stamped on success,
    // so it would reject on every later load too.
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n' + bad)
    const opts = { projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file }
    assert.deepEqual((await loadTranscript(opts)).map((e) => e.provider_uuid), ['u-1'])
    for (const attempt of [0, 1, 2]) {
      const got = await loader.load(opts)
      assert.deepEqual(got.map((e) => e.provider_uuid), ['u-1'], `load ${attempt} still yields the good entries`)
    }
  } finally {
    await env.cleanup()
  }
})

test('an unprojectable mid-file line is consumed, not read as a short read', async () => {
  const env = await stage()
  try {
    const bad = pathologicalLine('u-bad')
    assertUnprojectable(bad)
    const loader = createTranscriptLoader()
    await fsp.writeFile(env.file, line('u-1', 'one', 1) + '\n' + bad + '\n' + line('u-2', 'two', 2) + '\n')
    const opts = { projectsDir: env.dir, sessionId: SESSION, transcriptPath: env.file }
    const first = await loader.load(opts)
    assert.deepEqual(first.map((e) => e.provider_uuid), ['u-1', 'u-2'], 'the good lines after it still land')

    await fsp.appendFile(env.file, line('u-3', 'three', 3) + '\n')
    const second = await loader.load(opts)
    assert.deepEqual(second.map((e) => e.provider_uuid), ['u-1', 'u-2', 'u-3'])
    // Treating the line as a failed read would poison the witnesses and
    // re-read the file from byte zero on every exchange, forever.
    assert.equal(second[0], first[0], 'the consumed region was not re-parsed')
    assert.equal(second[1], first[1], 'the consumed region was not re-parsed')
  } finally {
    await env.cleanup()
  }
})
