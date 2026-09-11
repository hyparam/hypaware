// @ts-check

/**
 * `hyp session ignore` must survive the daemon's automatic Claude
 * transcript sweep.
 *
 * The live drop alone suppresses nothing durable: Claude Code writes its
 * JSONL transcript whatever HypAware was told, and the scheduled sweep
 * (LLP 0358 #scheduled-sweep, every five minutes by default) re-reads that
 * tree in the same daemon process. Because the live drop meant no row was
 * ever written, `part_id` dedupe has nothing to dedupe against and the
 * ignored turns land verbatim.
 *
 * These tests drive the two real lanes end to end: the control route the
 * CLI posts to (`POST /_hypaware/ignore/session` on the listener,
 * LLP 0256 #cli-posts-to-both) and the real backfill provider run through
 * the kernel's sweep runner.
 *
 * @ref LLP 0395#sweep-consults-the-set [tests]
 *
 * @import { BackfillContribution, CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

import assert from 'node:assert/strict'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import { createStartClaudeTelemetrySource } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
import { runBackfillProvider } from '../../src/core/commands/backfill.js'
import {
  createBackfillMaterializerRegistry,
  createBackfillRegistry,
} from '../../src/core/registry/backfills.js'

const PRIVATE_PROMPT = 'my private prompt'
const PRIVATE_ANSWER = 'the private answer'

/**
 * A two-turn Claude Code transcript, the shape the CLI writes under
 * `~/.claude/projects/<repo>/<session>.jsonl`.
 *
 * @param {string} sessionId
 * @param {string} prompt
 * @param {string} answer
 */
function conversationRows(sessionId, prompt, answer) {
  return [
    {
      sessionId,
      uuid: `${sessionId}-user-1`,
      parentUuid: null,
      type: 'user',
      version: '2.1.233',
      cwd: `/work/${sessionId}`,
      message: { role: 'user', content: prompt },
      timestamp: '2026-05-20T10:00:00.000Z',
    },
    {
      sessionId,
      uuid: `${sessionId}-asst-1`,
      parentUuid: `${sessionId}-user-1`,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
      timestamp: '2026-05-20T10:00:05.000Z',
    },
  ]
}

async function stageEnv() {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-session-ignore-sweep-'))
  const stateFile = path.join(homeDir, 'state', 'session-context.jsonl')
  await fsp.mkdir(path.dirname(stateFile), { recursive: true })
  return { homeDir, stateFile, cleanup: () => fsp.rm(homeDir, { recursive: true, force: true }) }
}

/**
 * @param {{ homeDir: string }} env
 * @param {string} sessionId
 * @param {string} prompt
 * @param {string} answer
 */
async function writeTranscript(env, sessionId, prompt, answer) {
  const dir = path.join(env.homeDir, '.claude', 'projects', 'repo-a')
  await fsp.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const rows = conversationRows(sessionId, prompt, answer)
  await fsp.writeFile(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return filePath
}

/**
 * Run the provider through the kernel's real backfill runner and the real
 * gateway materializer, so a tick takes the same scan -> materialize ->
 * write path the daemon sweep takes.
 *
 * @param {{ homeDir: string }} env
 * @param {BackfillContribution} provider
 */
function stageRunner(env, provider) {
  const backfills = createBackfillRegistry()
  backfills.register(provider)
  const materializers = createBackfillMaterializerRegistry()
  materializers.register(aiGatewayBackfillMaterializer())
  /** @type {Record<string, unknown>[]} */
  const appended = []
  const storage = {
    cacheRoot: path.join(env.homeDir, 'cache'),
    /** @param {string} dataset @param {string[]} segs */
    cacheTablePath: (dataset, segs) => path.join(env.homeDir, 'cache', dataset, ...segs),
    /** @param {string} _tablePath @param {unknown} _columns @param {Record<string, unknown>[]} rows */
    async appendRows(_tablePath, _columns, rows) { appended.push(...rows) },
    async flushTable() {},
  }
  const query = {
    /** @param {string} name */
    getDataset(name) {
      if (name !== 'ai_gateway_messages') return undefined
      return { name, plugin: '@hypaware/ai-gateway', schema: { columns: [] } }
    },
    registerDataset() {},
    listDatasets() { return [] },
  }
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: { HYP_HOME: env.homeDir },
    config: {},
    stdout: { write: () => true },
    stderr: { write: () => true },
    backfills,
    backfillMaterializers: materializers,
    query,
    storage,
  }))
  return {
    appended,
    /** One scheduled sweep tick. */
    tick: () => runBackfillProvider({ ctx, provider: 'claude', dryRun: false, sweep: true }),
    /** One operator-typed `hyp backfill claude` run. */
    manual: () => runBackfillProvider({ ctx, provider: 'claude', dryRun: false }),
  }
}

/**
 * Start the real Claude telemetry listener over a caller-supplied drop set,
 * so the test can post to the same control route `hyp session ignore` posts
 * to instead of reaching into the set by hand.
 *
 * @param {{ hypHome: string, ignoredSessions: Set<string> }} opts
 */
async function startListener(opts) {
  const start = createStartClaudeTelemetrySource({
    gateway: /** @type {any} */ ({ recordProjectedExchange: async () => ({ rowsWritten: 0, rowsSkipped: 0 }) }),
    clientName: 'claude',
    stateFile: path.join(opts.hypHome, 'claude-sessions.json'),
    ignoredSessions: opts.ignoredSessions,
  })
  const noop = () => {}
  const ctx = /** @type {any} */ ({
    config: { telemetry: { listen_host: '127.0.0.1', listen_port: 0 } },
    env: { HYP_HOME: opts.hypHome },
    log: { info: noop, warn: noop, error: noop, debug: noop },
    storage: { cacheTablePath: () => path.join(opts.hypHome, 'cache'), appendRows: async () => {} },
  })
  const source = /** @type {any} */ (await start(ctx))
  const details = /** @type {any} */ ((await source.status()).details)
  const endpoint = `http://127.0.0.1:${details.listen_port}/_hypaware/ignore/session`
  return {
    /** @param {'POST' | 'DELETE'} method @param {string} sessionId */
    async control(method, sessionId) {
      const res = await fetch(endpoint, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      })
      assert.equal(res.status, 200)
      return /** @type {any} */ (await res.json())
    },
    stop: () => source.stop(),
  }
}

/** @param {Record<string, unknown>[]} rows */
function sessionIds(rows) {
  return [...new Set(rows.map((row) => row.session_id))].sort()
}

// The defect: the opt-out reaches the recorder, the recorder drops the live
// exchange, and five minutes later the sweep imports the same turns off disk.
test('the scheduled sweep does not re-import a session the CLI ignored', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-private', PRIVATE_PROMPT, PRIVATE_ANSWER)
    await writeTranscript(env, 'sess-ordinary', 'what is the time', 'ten past ten')

    // One set per plugin activation, shared by the recorder and the sweep.
    const ignoredSessions = new Set()
    const listener = await startListener({ hypHome: env.homeDir, ignoredSessions })
    try {
      const receipt = await listener.control('POST', 'sess-private')
      assert.equal(receipt.ignored, true)
    } finally {
      await listener.stop()
    }

    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      ignoredSessions,
    })
    const runner = stageRunner(env, provider)
    const result = await runner.tick()
    assert.equal(result.ok, true)

    assert.deepEqual(
      sessionIds(runner.appended),
      ['sess-ordinary'],
      'the ignored session must not be re-imported by the automatic sweep'
    )
    const written = JSON.stringify(runner.appended)
    assert.equal(written.includes(PRIVATE_PROMPT), false, 'the ignored prompt must not reach the cache')
    assert.equal(written.includes(PRIVATE_ANSWER), false, 'the ignored reply must not reach the cache')
  } finally {
    await env.cleanup()
  }
})

// The other half: a drop set is only safe if it drops exactly what is in it.
// A sweep that stopped importing everything would be the worse bug.
test('an ordinary session still imports on the same tick, empty or absent set', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-a', 'first prompt', 'first answer')
    await writeTranscript(env, 'sess-b', 'second prompt', 'second answer')

    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      ignoredSessions: new Set(),
    })
    const runner = stageRunner(env, provider)
    const result = await runner.tick()
    assert.equal(result.ok, true)
    assert.deepEqual(sessionIds(runner.appended), ['sess-a', 'sess-b'])

    // And with no set threaded at all (the shape every existing caller and
    // `hyp backfill claude` in its own process has), nothing changes.
    const bare = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const bareRunner = stageRunner(env, bare)
    assert.equal((await bareRunner.tick()).ok, true)
    assert.deepEqual(sessionIds(bareRunner.appended), ['sess-a', 'sess-b'])
  } finally {
    await env.cleanup()
  }
})

// The drop is set membership, not a tombstone: nothing on disk remembers it,
// so once `hyp session unignore` removes the id a deliberate re-import brings
// the session back. That is the half LLP 0067 always left to the operator.
test('the drop is live set membership, not a durable tombstone', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'sess-private', PRIVATE_PROMPT, PRIVATE_ANSWER)

    const ignoredSessions = new Set()
    const listener = await startListener({ hypHome: env.homeDir, ignoredSessions })
    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      ignoredSessions,
    })
    const runner = stageRunner(env, provider)
    try {
      await listener.control('POST', 'sess-private')
      // Asserted before the emptiness check: a tick that failed for an
      // unrelated reason also appends nothing, so without this the drop
      // would be credited for a run that never scanned.
      assert.equal((await runner.tick()).ok, true)
      assert.deepEqual(runner.appended, [])

      const receipt = await listener.control('DELETE', 'sess-private')
      assert.equal(receipt.ignored, false)
    } finally {
      await listener.stop()
    }

    // A deliberate re-import (`hyp backfill claude`, `sweep` unset) reads the
    // whole tree rather than the sweep's changed-file candidates, so the
    // session the sweep passed over is imported once the id is out of the set.
    assert.equal((await runner.manual()).ok, true)
    assert.deepEqual(sessionIds(runner.appended), ['sess-private'])
  } finally {
    await env.cleanup()
  }
})


test('a fresh importer and an existing manual importer both honor persisted exclusions', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'private', PRIVATE_PROMPT, PRIVATE_ANSWER)
    await writeTranscript(env, 'ordinary', 'ordinary prompt', 'ordinary answer')
    const reader = new SessionIgnoreSet(env.homeDir)
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile, ignoredSessions: reader })
    const writer = new SessionIgnoreSet(env.homeDir)
    const listener = await startListener({ hypHome: env.homeDir, ignoredSessions: writer })
    try { await listener.control('POST', 'private') } finally { await listener.stop() }
    const manual = stageRunner(env, provider)
    assert.equal((await manual.manual()).ok, true)
    assert.deepEqual(sessionIds(manual.appended), ['ordinary'])
    const fresh = stageRunner(env, createClaudeBackfillProvider({
      homeDir: env.homeDir, stateFile: env.stateFile, ignoredSessions: new SessionIgnoreSet(env.homeDir),
    }))
    assert.equal((await fresh.tick()).ok, true)
    assert.deepEqual(sessionIds(fresh.appended), ['ordinary'])
    writer.delete('private')
    const resumed = stageRunner(env, provider)
    assert.equal((await resumed.manual()).ok, true)
    assert.deepEqual(sessionIds(resumed.appended), ['ordinary', 'private'])
  } finally { await env.cleanup() }
})
