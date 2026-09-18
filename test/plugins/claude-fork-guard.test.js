// @ts-check

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { runSessionIgnore, runSessionUnignore } from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'
import { runClaudeSessionContextHook } from '../../hypaware-core/plugins-workspace/claude/src/hook_command.js'
import { createControlHandler } from '../../src/core/control/session_ignore.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

/**
 * Issue #1891, the Claude lane. `claude --fork-session` (and `/branch`) copies
 * the parent conversation into a new transcript under a NEW session id, and
 * every recorder drops on the id alone, so an opt-out taken on the parent
 * covered none of the copy: an opted-out conversation was recorded in full.
 *
 * Claude hands a hook no parent id, so the parent is identified by what the
 * copy keeps: each copied line's `uuid` is carried over unchanged while
 * `sessionId` is rewritten. These tests drive the real chain - the real
 * `hyp session ignore` verb against a real control route over a real
 * `SessionIgnoreSet`, then the real managed hook against a forked transcript.
 *
 * The false-positive direction gets its own case on purpose: wrongly ignoring
 * a session destroys capture silently, and nothing tells the user it happened.
 *
 * @ref LLP 0419#hook-closes-the-fork [tests]
 */

test('a fork of an ignored session is ignored before its first exchange, and a fork of the fork too', async () => {
  const env = stage()
  try {
    await withRecorder(env, async (harness) => {
      // The parent conversation, opted out the ordinary way.
      writeTranscript(env, 'A', headOf('A'))
      recordSessionContext(env, 'A')
      assert.equal(await runSessionIgnore(['session-A'], harness.cliCtx), 0)
      assert.equal(harness.store.has('session-A'), true)

      // `claude --fork-session`: a new id over a copy of the same lines.
      writeTranscript(env, 'B', headOf('A'))
      const first = await runHook(env, harness, {
        session_id: 'session-B',
        cwd: env.cwd,
        transcript_path: transcriptPath(env, 'B'),
        hook_event_name: 'SessionStart',
        source: 'fork',
      })
      assert.equal(first.code, 0)

      // In the drop set of the live recorder, and on disk, before anything of
      // the fork has been recorded.
      assert.equal(harness.store.has('session-B'), true, 'the live recorder drops the fork')
      assert.equal(hasSessionIgnoreMarker(env, 'session-B'), true, 'and a restart keeps dropping it')
      assert.match(first.stderr, /fork of an ignored session/)

      // A fork of the fork shares the same head uuids, with no record of its own.
      writeTranscript(env, 'C', headOf('A'))
      await runHook(env, harness, {
        session_id: 'session-C',
        cwd: env.cwd,
        transcript_path: transcriptPath(env, 'C'),
        hook_event_name: 'SessionStart',
        source: 'fork',
      })
      assert.equal(harness.store.has('session-C'), true, 'a fork of a fork is covered by the original parent')
    })
  } finally { cleanup(env) }
})

test('a fork of an UN-ignored session is not ignored', async () => {
  const env = stage()
  try {
    await withRecorder(env, async (harness) => {
      // One session is excluded, so a fingerprint exists and the guard is live.
      writeTranscript(env, 'A', headOf('A'))
      recordSessionContext(env, 'A')
      assert.equal(await runSessionIgnore(['session-A'], harness.cliCtx), 0)

      // An unrelated conversation, and a fork of it: different lines, so
      // different uuids, so nothing to match.
      writeTranscript(env, 'D', headOf('D'))
      const result = await runHook(env, harness, {
        session_id: 'session-D',
        cwd: env.cwd,
        transcript_path: transcriptPath(env, 'D'),
        hook_event_name: 'SessionStart',
        source: 'fork',
      })
      assert.equal(result.code, 0)
      assert.equal(harness.store.has('session-D'), false, 'capture must not be destroyed by a guess')
      assert.equal(hasSessionIgnoreMarker(env, 'session-D'), false)
      assert.equal(result.stderr, '')
    })
  } finally { cleanup(env) }
})

test('the check repeats on UserPromptSubmit, skips a non-fork start, and does no work once ignored', async () => {
  const env = stage()
  try {
    await withRecorder(env, async (harness) => {
      writeTranscript(env, 'A', headOf('A'))
      recordSessionContext(env, 'A')
      assert.equal(await runSessionIgnore(['session-A'], harness.cliCtx), 0)
      writeTranscript(env, 'B', headOf('A'))

      // A plain resume/startup is not a fork, and says so.
      await runHook(env, harness, {
        session_id: 'session-B',
        cwd: env.cwd,
        transcript_path: transcriptPath(env, 'B'),
        hook_event_name: 'SessionStart',
        source: 'startup',
      })
      assert.equal(harness.store.has('session-B'), false)

      // The backstop: the copy may land after SessionStart ran, and the first
      // prompt has still not reached the model.
      await runHook(env, harness, {
        session_id: 'session-B',
        cwd: env.cwd,
        transcript_path: transcriptPath(env, 'B'),
        hook_event_name: 'UserPromptSubmit',
      })
      assert.equal(harness.store.has('session-B'), true)

      // Repeating is idempotent, and costs no second opt-out call.
      harness.calls.length = 0
      await runHook(env, harness, {
        session_id: 'session-B',
        cwd: env.cwd,
        transcript_path: transcriptPath(env, 'B'),
        hook_event_name: 'UserPromptSubmit',
      })
      assert.deepEqual(harness.calls, [], 'an already-excluded session re-runs nothing')
      assert.equal(harness.store.has('session-B'), true)
    })
  } finally { cleanup(env) }
})

test('unignore removes the fingerprint, so later forks of that session are recorded again', async () => {
  const env = stage()
  try {
    await withRecorder(env, async (harness) => {
      writeTranscript(env, 'A', headOf('A'))
      recordSessionContext(env, 'A')
      assert.equal(await runSessionIgnore(['session-A'], harness.cliCtx), 0)
      const fingerprints = () => fs.readdirSync(path.join(env.stateRoot, 'session-ignores'))
        .filter((name) => name.endsWith('.fingerprint.json'))
      assert.equal(fingerprints().length, 1)

      assert.equal(await runSessionUnignore(['session-A'], harness.cliCtx), 0)
      assert.equal(fingerprints().length, 0, 'the fingerprint went with the marker')
      assert.equal(hasSessionIgnoreMarker(env, 'session-A'), false)

      writeTranscript(env, 'B', headOf('A'))
      await runHook(env, harness, {
        session_id: 'session-B',
        cwd: env.cwd,
        transcript_path: transcriptPath(env, 'B'),
        hook_event_name: 'SessionStart',
        source: 'fork',
      })
      assert.equal(harness.store.has('session-B'), false, 'unignore means record this conversation again')
    })
  } finally { cleanup(env) }
})

test('the ignore receipt says whether fork protection was armed', async () => {
  const env = stage()
  try {
    await withRecorder(env, async (harness) => {
      // No transcript on record: the exclusion still stands, and the receipt
      // refuses to imply a protection it did not establish.
      assert.equal(await runSessionIgnore(['codex-container', '--json'], harness.cliCtx), 0)
      assert.equal(JSON.parse(harness.cliOut()).fork_protection, 'unconfirmed')
      harness.resetCli()

      writeTranscript(env, 'A', headOf('A'))
      recordSessionContext(env, 'A')
      assert.equal(await runSessionIgnore(['session-A', '--json'], harness.cliCtx), 0)
      assert.equal(JSON.parse(harness.cliOut()).fork_protection, 'armed')
      harness.resetCli()

      assert.equal(await runSessionIgnore(['session-A'], harness.cliCtx), 0)
      assert.match(harness.cliOut(), /fork of this session .* is excluded automatically/)
    })
  } finally { cleanup(env) }
})

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

function stage() {
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-guard-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  const transcripts = path.join(hypHome, 'transcripts')
  fs.mkdirSync(transcripts, { recursive: true })
  return {
    hypHome,
    stateRoot,
    transcripts,
    cwd: path.join(hypHome, 'repo'),
    stateFile: path.join(stateRoot, 'plugins', '@hypaware', 'claude', 'session-context.jsonl'),
  }
}

/**
 * Is the persistent marker on disk? Computed here from the documented name
 * (sha256 of the id's JSON encoding) rather than read through the store API,
 * so this file tests the BEHAVIOUR of the fix and not merely its new exports.
 *
 * @param {ReturnType<typeof stage>} env
 * @param {string} id
 */
function hasSessionIgnoreMarker(env, id) {
  const name = createHash('sha256').update(JSON.stringify(id)).digest('hex')
  return fs.existsSync(path.join(env.stateRoot, 'session-ignores', `${name}.json`))
}

/** @param {ReturnType<typeof stage>} env */
function cleanup(env) {
  fs.rmSync(env.hypHome, { recursive: true, force: true })
}

/**
 * The parent's leading transcript lines. A fork copies these byte for byte
 * apart from `sessionId`, which is the whole reason the uuids identify it.
 * @param {string} tag
 */
function headOf(tag) {
  return Array.from({ length: 4 }, (_, i) => `0000000${tag === 'A' ? 'a' : 'd'}-0000-4000-8000-${String(i).padStart(12, '0')}`)
}

/** @param {ReturnType<typeof stage>} env @param {string} tag */
function transcriptPath(env, tag) {
  return path.join(env.transcripts, `session-${tag}.jsonl`)
}

/** @param {ReturnType<typeof stage>} env @param {string} tag @param {string[]} uuids */
function writeTranscript(env, tag, uuids) {
  const lines = uuids.map((uuid, i) => JSON.stringify({
    sessionId: `session-${tag}`,
    uuid,
    parentUuid: i === 0 ? null : uuids[i - 1],
    type: i % 2 === 0 ? 'user' : 'assistant',
    message: { role: i % 2 === 0 ? 'user' : 'assistant', content: 'conversation text that must never be fingerprinted' },
  }))
  fs.writeFileSync(transcriptPath(env, tag), lines.join('\n') + '\n')
}

/** @param {ReturnType<typeof stage>} env @param {string} tag */
function recordSessionContext(env, tag) {
  fs.mkdirSync(path.dirname(env.stateFile), { recursive: true })
  fs.appendFileSync(env.stateFile, JSON.stringify({
    session_id: `session-${tag}`,
    cwd: env.cwd,
    transcript_path: transcriptPath(env, tag),
    ts: new Date().toISOString(),
  }) + '\n')
}

/**
 * A live recorder: the shared control route over a real persistent store, plus
 * a CLI context pointed at it the way the gateway's pinned `listen` does.
 *
 * @param {ReturnType<typeof stage>} env
 * @param {(harness: {
 *   store: SessionIgnoreSet,
 *   cliCtx: any,
 *   cliOut: () => string,
 *   resetCli: () => void,
 *   calls: string[],
 * }) => Promise<void>} fn
 */
async function withRecorder(env, fn) {
  const store = new SessionIgnoreSet(env.stateRoot)
  const handler = createControlHandler({ ignoredSessions: store })
  const server = http.createServer((req, res) => {
    handler(
      /** @type {IncomingMessage} */ (req),
      /** @type {ServerResponse} */ (res),
      new URL(req.url ?? '/', 'http://127.0.0.1')
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  let out = ''
  const cliCtx = {
    stdout: { write: (/** @type {string} */ s) => { out += s; return true } },
    stderr: { write: () => true },
    env: { HYP_HOME: env.hypHome },
    cwd: env.cwd,
    config: { version: 2, plugins: [{ name: '@hypaware/ai-gateway', config: { listen: `127.0.0.1:${port}` } }] },
  }
  /** @type {string[]} */
  const calls = []
  try {
    await fn({
      store,
      cliCtx: /** @type {any} */ (cliCtx),
      cliOut: () => out,
      resetCli: () => { out = '' },
      calls,
    })
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

/**
 * Run the managed hook exactly as Claude Code invokes it, with the opt-out call
 * routed through the real CLI verb in-process rather than a re-spawn of `hyp`.
 *
 * @param {ReturnType<typeof stage>} env
 * @param {{ cliCtx: any, calls: string[] }} harness
 * @param {Record<string, unknown>} event
 */
async function runHook(env, harness, event) {
  let stderr = ''
  const ctx = /** @type {any} */ ({
    stdout: { write: () => true },
    stderr: { write: (/** @type {string} */ s) => { stderr += s; return true } },
    stdin: Readable.from([JSON.stringify(event)]),
    env: { HYP_HOME: env.hypHome },
    cwd: env.cwd,
    config: { version: 2, plugins: [] },
  })
  const code = await runClaudeSessionContextHook(
    ['--state-file', env.stateFile],
    ctx,
    {
      gitBranch: async () => undefined,
      gitRepoFacts: async () => ({}),
      sweepSpool: async () => undefined,
      ignoreSession: async (/** @type {string} */ sessionId) => {
        harness.calls.push(sessionId)
        const code = await runSessionIgnore([sessionId, '--json'], harness.cliCtx)
        if (code !== 0) throw new Error(`hyp session ignore exited ${code}`)
      },
    }
  )
  return { code, stderr }
}
