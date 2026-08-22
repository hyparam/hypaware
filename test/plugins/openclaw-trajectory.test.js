// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  OPENCLAW_TRAJECTORY_POINTER_SCHEMA,
  OPENCLAW_TRAJECTORY_SCHEMA,
  pickOpenclawRunContext,
  readOpenclawRunContexts,
  resolveOpenclawTrajectoryPath,
} from '../../hypaware-core/plugins-workspace/openclaw/src/trajectory_file.js'

/**
 * Tests for the one reader of an OpenClaw run trajectory (LLP 0265).
 *
 * The fixtures below are the event shapes a live
 * `~/.openclaw/agents/main/sessions/<id>.trajectory.jsonl` actually holds,
 * verified against OpenClaw 2026.7.1-2: every line states
 * `traceSchema: "openclaw-trajectory"`, `sessionId`, `runId`, `type`, `ts`,
 * and a per-type `data` object; a run writes `session.started`,
 * `trace.metadata`, `context.compiled`, `prompt.submitted`,
 * `model.completed`, `trace.artifacts`, `session.ended`, in that order.
 */

const SESSION_ID = 'sess-traj-1'

/**
 * One trajectory event line.
 *
 * @param {{ type: string, ts: string, sessionId?: string, runId?: string, data?: Record<string, unknown> }} fields
 * @returns {string}
 */
function event(fields) {
  return JSON.stringify({
    traceSchema: OPENCLAW_TRAJECTORY_SCHEMA,
    schemaVersion: 1,
    traceId: fields.sessionId ?? SESSION_ID,
    source: 'runtime',
    type: fields.type,
    ts: fields.ts,
    sessionId: fields.sessionId ?? SESSION_ID,
    sessionKey: 'agent:main:main',
    runId: fields.runId ?? 'run-1',
    workspaceDir: '/work',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    modelApi: 'anthropic-messages',
    data: fields.data ?? {},
  })
}

/**
 * The `systemPrompt` stub OpenClaw substitutes for a prompt longer than its
 * hard-coded 32768-character trajectory field cap.
 *
 * @param {number} originalChars
 */
function truncatedPrompt(originalChars) {
  return { truncated: true, reason: 'trajectory-field-size-limit', originalChars, limitChars: 32768 }
}

/**
 * The `trace.metadata` payload, reduced to the one branch this reader
 * descends (`prompting.systemPromptReport.systemPrompt`).
 *
 * @param {{ chars: number, hash: string }} systemPrompt
 */
function metadata(systemPrompt) {
  return {
    capturedAt: '2026-08-03T19:02:08.771Z',
    prompting: { systemPromptReport: { source: 'run', sessionId: SESSION_ID, systemPrompt } },
  }
}

const TOOLS = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
  { name: 'exec', description: 'Run a command', parameters: { type: 'object', properties: {} } },
]

async function stageDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-trajectory-'))
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

/**
 * @param {string} dir
 * @param {string[]} lines
 * @param {{ sessionId?: string, name?: string }} [opts]
 */
async function writeTrajectory(dir, lines, opts = {}) {
  const filePath = path.join(dir, opts.name ?? `${opts.sessionId ?? SESSION_ID}.trajectory.jsonl`)
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8')
  return filePath
}

// ---------------------------------------------------------------------------
// Locating the file
// ---------------------------------------------------------------------------

test('resolves the trajectory through OpenClaw pointer file when it names one', async () => {
  const env = await stageDir()
  try {
    const relocated = path.join(env.dir, 'elsewhere.trajectory.jsonl')
    await fs.writeFile(
      path.join(env.dir, `${SESSION_ID}.trajectory-path.json`),
      JSON.stringify({
        traceSchema: OPENCLAW_TRAJECTORY_POINTER_SCHEMA,
        schemaVersion: 1,
        sessionId: SESSION_ID,
        runtimeFile: relocated,
      }),
      'utf8'
    )
    assert.equal(await resolveOpenclawTrajectoryPath(env.dir, SESSION_ID), relocated)
  } finally {
    await env.cleanup()
  }
})

test('falls back to the sibling name for a missing, foreign, or unusable pointer', async () => {
  const env = await stageDir()
  try {
    const conventional = path.join(env.dir, `${SESSION_ID}.trajectory.jsonl`)
    assert.equal(await resolveOpenclawTrajectoryPath(env.dir, SESSION_ID), conventional)

    const pointerPath = path.join(env.dir, `${SESSION_ID}.trajectory-path.json`)
    // Another session's pointer: its runtimeFile would attach that session's
    // tool set to this session's rows.
    await fs.writeFile(pointerPath, JSON.stringify({
      traceSchema: OPENCLAW_TRAJECTORY_POINTER_SCHEMA,
      sessionId: 'some-other-session',
      runtimeFile: path.join(env.dir, 'other.trajectory.jsonl'),
    }), 'utf8')
    assert.equal(await resolveOpenclawTrajectoryPath(env.dir, SESSION_ID), conventional)

    await fs.writeFile(pointerPath, JSON.stringify({
      traceSchema: 'something-else',
      runtimeFile: path.join(env.dir, 'other.trajectory.jsonl'),
    }), 'utf8')
    assert.equal(await resolveOpenclawTrajectoryPath(env.dir, SESSION_ID), conventional)

    await fs.writeFile(pointerPath, JSON.stringify({
      traceSchema: OPENCLAW_TRAJECTORY_POINTER_SCHEMA,
      runtimeFile: 'relative/path.jsonl',
    }), 'utf8')
    assert.equal(await resolveOpenclawTrajectoryPath(env.dir, SESSION_ID), conventional)

    await fs.writeFile(pointerPath, 'not json at all', 'utf8')
    assert.equal(await resolveOpenclawTrajectoryPath(env.dir, SESSION_ID), conventional)
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Reading run contexts
// ---------------------------------------------------------------------------

test('a missing trajectory file reads as no runs, not an error', async () => {
  const env = await stageDir()
  try {
    assert.deepEqual(await readOpenclawRunContexts(path.join(env.dir, 'absent.jsonl')), [])
  } finally {
    await env.cleanup()
  }
})

test('reads one context per run, with the compiled prompt and tool set', async () => {
  const env = await stageDir()
  try {
    const filePath = await writeTrajectory(env.dir, [
      event({ type: 'session.started', ts: '2026-08-03T19:02:08.774Z' }),
      event({ type: 'context.compiled', ts: '2026-08-03T19:02:08.800Z', data: { systemPrompt: 'you are an agent', tools: TOOLS } }),
      event({ type: 'model.completed', ts: '2026-08-03T19:02:10.808Z' }),
      event({ type: 'session.ended', ts: '2026-08-03T19:02:10.809Z' }),
    ])
    const contexts = await readOpenclawRunContexts(filePath, { sessionId: SESSION_ID })
    assert.equal(contexts.length, 1)
    assert.equal(contexts[0].runId, 'run-1')
    assert.equal(contexts[0].systemText, 'you are an agent')
    assert.deepEqual(contexts[0].tools, TOOLS)
    assert.equal(contexts[0].startMs, Date.parse('2026-08-03T19:02:08.800Z'))
    assert.equal(contexts[0].endMs, Date.parse('2026-08-03T19:02:10.809Z'))
    assert.equal(contexts[0].systemPromptDigest, undefined)
  } finally {
    await env.cleanup()
  }
})

// @ref LLP 0265#truncated-prompts [tests]: an over-cap prompt is described by
// its size and content hash, never reconstructed from the stub.
test('an over-32k system prompt yields a digest and no text', async () => {
  const env = await stageDir()
  try {
    const filePath = await writeTrajectory(env.dir, [
      event({ type: 'trace.metadata', ts: '2026-08-03T19:02:08.775Z', data: metadata({ chars: 36775, hash: 'a6e6cdcc' }) }),
      event({ type: 'context.compiled', ts: '2026-08-03T19:02:08.800Z', data: { systemPrompt: truncatedPrompt(36775), tools: TOOLS } }),
      event({ type: 'session.ended', ts: '2026-08-03T19:02:10.809Z' }),
    ])
    const [context] = await readOpenclawRunContexts(filePath, { sessionId: SESSION_ID })
    assert.equal(context.systemText, undefined)
    assert.deepEqual(context.systemPromptDigest, { hash: 'a6e6cdcc', chars: 36775, truncated: true })
    // The tool set is unaffected: the cap is per string field, and an array
    // of definitions is not one.
    assert.deepEqual(context.tools, TOOLS)
  } finally {
    await env.cleanup()
  }
})

test('a stub with no metadata report still reports the truncation', async () => {
  const env = await stageDir()
  try {
    const filePath = await writeTrajectory(env.dir, [
      event({ type: 'context.compiled', ts: '2026-08-03T19:02:08.800Z', data: { systemPrompt: truncatedPrompt(40183) } }),
    ])
    const [context] = await readOpenclawRunContexts(filePath, { sessionId: SESSION_ID })
    assert.equal(context.systemText, undefined)
    assert.deepEqual(context.systemPromptDigest, { chars: 40183, truncated: true })
  } finally {
    await env.cleanup()
  }
})

test('a run report is consumed by its own run, not the next one', async () => {
  const env = await stageDir()
  try {
    const filePath = await writeTrajectory(env.dir, [
      event({ type: 'trace.metadata', ts: '2026-08-03T19:02:08.775Z', data: metadata({ chars: 36775, hash: 'first-hash' }) }),
      event({ type: 'context.compiled', ts: '2026-08-03T19:02:08.800Z', runId: 'run-1', data: { systemPrompt: truncatedPrompt(36775) } }),
      event({ type: 'session.ended', ts: '2026-08-03T19:02:10.000Z' }),
      // The second run wrote no metadata event, so it has no report of its
      // own; the first run's must not carry over onto it.
      event({ type: 'context.compiled', ts: '2026-08-03T19:06:08.000Z', runId: 'run-2', data: { systemPrompt: truncatedPrompt(40183) } }),
    ])
    const contexts = await readOpenclawRunContexts(filePath, { sessionId: SESSION_ID })
    assert.deepEqual(contexts[0].systemPromptDigest, { hash: 'first-hash', chars: 36775, truncated: true })
    assert.deepEqual(contexts[1].systemPromptDigest, { chars: 40183, truncated: true })
  } finally {
    await env.cleanup()
  }
})

test('skips lines of another session, another schema, or no timestamp', async () => {
  const env = await stageDir()
  try {
    const filePath = await writeTrajectory(env.dir, [
      // A trajectory outlives a session reset and keeps appending, so a
      // stated foreign session id is another session's run.
      event({ type: 'context.compiled', ts: '2026-08-03T19:00:00.000Z', sessionId: 'other-session', data: { tools: TOOLS } }),
      JSON.stringify({ traceSchema: 'openclaw-something-else', type: 'context.compiled', ts: '2026-08-03T19:01:00.000Z', sessionId: SESSION_ID, data: { tools: TOOLS } }),
      event({ type: 'context.compiled', ts: 'not-a-timestamp', data: { tools: TOOLS } }),
      'not json',
      '',
      event({ type: 'context.compiled', ts: '2026-08-03T19:02:08.800Z', data: { systemPrompt: 'mine', tools: TOOLS } }),
    ])
    const contexts = await readOpenclawRunContexts(filePath, { sessionId: SESSION_ID })
    assert.equal(contexts.length, 1)
    assert.equal(contexts[0].systemText, 'mine')
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Matching a message to its run
// ---------------------------------------------------------------------------

// @ref LLP 0265#backfill-stamping [tests]: the window is the run's own, and a
// message outside every window belongs to a run that compiled no context.
test('picks the run whose window covers the message, and nothing outside one', async () => {
  const env = await stageDir()
  try {
    const filePath = await writeTrajectory(env.dir, [
      event({ type: 'context.compiled', ts: '2026-08-03T19:00:00.000Z', runId: 'run-1', data: { systemPrompt: 'first', tools: TOOLS } }),
      event({ type: 'session.ended', ts: '2026-08-03T19:00:10.000Z', runId: 'run-1' }),
      event({ type: 'context.compiled', ts: '2026-08-03T19:10:00.000Z', runId: 'run-2', data: { systemPrompt: 'second', tools: TOOLS } }),
    ])
    const contexts = await readOpenclawRunContexts(filePath, { sessionId: SESSION_ID })
    const at = (iso) => pickOpenclawRunContext(contexts, Date.parse(iso))

    assert.equal(at('2026-08-03T19:00:05.000Z')?.runId, 'run-1', 'inside the first run')
    assert.equal(at('2026-08-03T19:00:10.000Z')?.runId, 'run-1', 'the closing instant is still inside')
    // The gap between one run ending and the next compiling is a turn that
    // recorded no trajectory (a failed run, or a CLI harness turn).
    assert.equal(at('2026-08-03T19:05:00.000Z'), undefined, 'in the gap after a closed run')
    assert.equal(at('2026-08-02T00:00:00.000Z'), undefined, 'before any run compiled')
    // The last run has no `session.ended`: it was still going at sweep time.
    assert.equal(at('2026-08-03T23:00:00.000Z')?.runId, 'run-2', 'inside the open final run')
    assert.equal(pickOpenclawRunContext(contexts, undefined), undefined)
    assert.equal(pickOpenclawRunContext([], Date.parse('2026-08-03T19:00:05.000Z')), undefined)
  } finally {
    await env.cleanup()
  }
})

// @ref LLP 0265#truncated-prompts [tests]: the silent cap. OpenClaw also
// clips a long prompt to 20000 characters plus an ellipsis and writes it as
// an ordinary string, so a string is not evidence of a complete prompt.
test('a string prompt clipped by the silent cap is kept and flagged', async () => {
  const env = await stageDir()
  try {
    const clipped = 'x'.repeat(20000) + '\u2026'
    const filePath = await writeTrajectory(env.dir, [
      event({ type: 'context.compiled', ts: '2026-08-03T19:02:08.800Z', data: { systemPrompt: clipped, tools: TOOLS } }),
    ])
    const [context] = await readOpenclawRunContexts(filePath, { sessionId: SESSION_ID })
    assert.equal(context.systemText, clipped, 'the recorded prefix is still worth keeping')
    assert.deepEqual(context.systemPromptDigest, { recordedChars: 20001, truncated: true })
  } finally {
    await env.cleanup()
  }
})

test('a recorded prompt shorter than the run reported is flagged', async () => {
  const env = await stageDir()
  try {
    const filePath = await writeTrajectory(env.dir, [
      event({ type: 'trace.metadata', ts: '2026-08-03T19:02:08.775Z', data: metadata({ chars: 31000, hash: 'deadbeef' }) }),
      // No ellipsis to go on: only the report's own size disagrees.
      event({ type: 'context.compiled', ts: '2026-08-03T19:02:08.800Z', data: { systemPrompt: 'y'.repeat(20000) } }),
    ])
    const [context] = await readOpenclawRunContexts(filePath, { sessionId: SESSION_ID })
    assert.equal(context.systemText?.length, 20000)
    assert.deepEqual(context.systemPromptDigest, { hash: 'deadbeef', chars: 31000, recordedChars: 20000, truncated: true })
  } finally {
    await env.cleanup()
  }
})

test('a complete prompt is not flagged, and a zero-char report is not evidence', async () => {
  const env = await stageDir()
  try {
    const filePath = await writeTrajectory(env.dir, [
      // The shape a probe session writes: a real short prompt beside a
      // report that computed nothing.
      event({ type: 'trace.metadata', ts: '2026-08-03T19:02:08.775Z', data: metadata({ chars: 0, hash: 'probe-hash' }) }),
      event({ type: 'context.compiled', ts: '2026-08-03T19:02:08.800Z', data: { systemPrompt: 'Reply with OK.' } }),
    ])
    const [context] = await readOpenclawRunContexts(filePath, { sessionId: SESSION_ID })
    assert.equal(context.systemText, 'Reply with OK.')
    assert.deepEqual(context.systemPromptDigest, { hash: 'probe-hash' })
  } finally {
    await env.cleanup()
  }
})
