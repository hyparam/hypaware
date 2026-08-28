// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { runClaudeSessionContextHook } from '../../hypaware-core/plugins-workspace/claude/src/hook_command.js'
import { readSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'
import {
  DEFAULT_SPOOL_MAX_BYTES,
  claudeBodySpoolDir,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/spool.js'

/**
 * The body spool's byte cap, enforced from OUTSIDE the daemon.
 *
 * LLP 0253 #byte-cap names the daemon-down window as the reason the cap
 * exists, but shipped every enforcement inside the listener source, so that
 * window was the one nothing swept. LLP 0263 makes the client hook the second
 * enforcer. These tests drive the hook with no daemon anywhere in sight,
 * which is the whole point: if they pass, a machine whose daemon crashed,
 * was never started, or was uninstalled without a detach still converges to
 * the cap.
 *
 * @ref LLP 0263#hook-enforces-the-cap [tests]: the hook bounds the spool with
 *   no daemon running
 */

test('the hook evicts oldest-first when the spool is over the operator cap, with no daemon anywhere', async () => {
  const env = await stageEnv()
  try {
    // Three 100-byte bodies, oldest to newest, against a 250-byte cap: the
    // oldest must go and the two newest must survive (LLP 0253 keeps the
    // bodies whose events are still arriving).
    await writeBody(env.spoolDir, 'old.json', 100, 1_000)
    await writeBody(env.spoolDir, 'middle.json', 100, 2_000)
    await writeBody(env.spoolDir, 'new.json', 100, 3_000)

    const code = await runHook(env, { spoolMaxBytes: 250 })
    assert.equal(code, 0)

    const left = (await fs.readdir(env.spoolDir)).sort()
    assert.deepEqual(left, ['middle.json', 'new.json'], 'the oldest body is evicted, the newest are kept')
    assert.ok(await totalBytes(env.spoolDir) <= 250, 'the spool is back under the cap')
  } finally {
    await env.cleanup()
  }
})

// @ref LLP 0263#hook-enforces-the-cap [tests]: the cap the hook applies is the
// operator's `telemetry.spool_max_bytes`, never a rule of the hook's own.
test('the hook reads the operator cap out of the @hypaware/claude config slice', async () => {
  const env = await stageEnv()
  try {
    await writeBody(env.spoolDir, 'a.json', 100, 1_000)
    await writeBody(env.spoolDir, 'b.json', 100, 2_000)

    // 150 bytes is far below the 512 MB default: if the hook ignored the
    // config slice, nothing here would be evicted at all.
    assert.ok(150 < DEFAULT_SPOOL_MAX_BYTES, 'the test cap is below the default it must override')
    const code = await runHook(env, { spoolMaxBytes: 150 })
    assert.equal(code, 0)

    assert.deepEqual(await fs.readdir(env.spoolDir), ['b.json'], 'the configured cap bound the sweep')
  } finally {
    await env.cleanup()
  }
})

test('a malformed cap falls back to the default rather than evicting on a bad number', async () => {
  const env = await stageEnv()
  try {
    await writeBody(env.spoolDir, 'a.json', 100, 1_000)
    for (const bad of ['not-a-number', -1, 0, 1.5, null]) {
      const code = await runHook(env, { spoolMaxBytes: /** @type {any} */ (bad) })
      assert.equal(code, 0)
      assert.deepEqual(
        await fs.readdir(env.spoolDir),
        ['a.json'],
        `a ${JSON.stringify(bad)} cap falls back to the default, which evicts nothing here`
      )
    }
  } finally {
    await env.cleanup()
  }
})

test('an under-cap spool is left alone', async () => {
  const env = await stageEnv()
  try {
    await writeBody(env.spoolDir, 'a.json', 100, 1_000)
    await writeBody(env.spoolDir, 'b.json', 100, 2_000)

    const code = await runHook(env, { spoolMaxBytes: 10_000 })
    assert.equal(code, 0)
    assert.deepEqual((await fs.readdir(env.spoolDir)).sort(), ['a.json', 'b.json'])
  } finally {
    await env.cleanup()
  }
})

// A proxy-attached or unattached machine has no spool directory at all. The
// sweep must be a silent no-op there, not an error the hook has to swallow.
test('a machine with no spool directory sweeps to a no-op and still records context', async () => {
  const env = await stageEnv({ createSpool: false })
  try {
    const code = await runHook(env, { spoolMaxBytes: 100 })
    assert.equal(code, 0)

    const records = await readSessionContext(env.stateFile)
    assert.ok(records.length >= 1, 'the session-context record still landed')
    await assert.rejects(fs.stat(env.spoolDir), 'the sweep did not create the directory it found missing')
  } finally {
    await env.cleanup()
  }
})

// @ref LLP 0263#never-interrupts [tests]: the sweep runs on invocations that
// record nothing. A missing --state-file says nothing about whether Claude
// Code is filling the spool, and this is exactly the path a half-configured
// machine takes.
test('the cap is enforced even when the event records no context at all', async () => {
  const env = await stageEnv()
  try {
    await writeBody(env.spoolDir, 'old.json', 100, 1_000)
    await writeBody(env.spoolDir, 'new.json', 100, 2_000)

    // No --state-file: recordSessionContext bails immediately.
    const code = await runClaudeSessionContextHook(
      ['session-context'],
      ctxFor(env, { spoolMaxBytes: 150 }, { session_id: 's', cwd: '/w' }),
      { gitBranch: async () => undefined, gitRepoFacts: async () => ({}) }
    )
    assert.equal(code, 0)
    assert.deepEqual(await fs.readdir(env.spoolDir), ['new.json'], 'the spool was swept anyway')
  } finally {
    await env.cleanup()
  }
})

test('a malformed event still sweeps the spool', async () => {
  const env = await stageEnv()
  try {
    await writeBody(env.spoolDir, 'old.json', 100, 1_000)
    await writeBody(env.spoolDir, 'new.json', 100, 2_000)

    const code = await runClaudeSessionContextHook(
      ['session-context', '--state-file', env.stateFile],
      ctxFor(env, { spoolMaxBytes: 150 }, 'not json at all'),
      { gitBranch: async () => undefined, gitRepoFacts: async () => ({}) }
    )
    assert.equal(code, 0)
    assert.deepEqual(await fs.readdir(env.spoolDir), ['new.json'])
  } finally {
    await env.cleanup()
  }
})

// @ref LLP 0263#never-interrupts [tests]: a sweep failure is swallowed. The
// hook must never throw back into Claude Code, and a spool it cannot read is
// not a reason to lose the session-context record.
test('a throwing sweep never fails the hook and never costs the context record', async () => {
  const env = await stageEnv()
  try {
    const code = await runClaudeSessionContextHook(
      ['session-context', '--state-file', env.stateFile],
      ctxFor(env, {}, { session_id: 'sess-throw', cwd: '/work/repo' }),
      {
        gitBranch: async () => undefined,
        gitRepoFacts: async () => ({}),
        sweepSpool: async () => { throw new Error('spool unreadable') },
      }
    )
    assert.equal(code, 0)

    const records = await readSessionContext(env.stateFile)
    assert.equal(records.length, 1)
    assert.equal(records[0].cwd, '/work/repo')
  } finally {
    await env.cleanup()
  }
})

// @ref LLP 0263#never-interrupts [tests]: ordering. LLP 0085 exists to shrink
// the window where the projector reads a cwd-less record, so the sweep may
// never run ahead of the appends.
test('the sweep runs after the session-context records, never before', async () => {
  const env = await stageEnv()
  try {
    let recordsAtSweepTime = /** @type {any[] | null} */ (null)
    const code = await runClaudeSessionContextHook(
      ['session-context', '--state-file', env.stateFile],
      ctxFor(env, {}, { session_id: 'sess-order', cwd: '/work/repo' }),
      {
        gitBranch: async () => 'main',
        gitRepoFacts: async () => ({ repoRoot: '/work/repo' }),
        sweepSpool: async () => { recordsAtSweepTime = await readSessionContext(env.stateFile) },
      }
    )
    assert.equal(code, 0)
    assert.ok(recordsAtSweepTime, 'the sweep ran')
    assert.equal(recordsAtSweepTime.length, 2, 'both records were durable before the sweep started')
    assert.equal(recordsAtSweepTime[1].git_branch, 'main', 'even the enriched record landed first')
  } finally {
    await env.cleanup()
  }
})

/**
 * @param {{ createSpool?: boolean }} [opts]
 */
async function stageEnv(opts = {}) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-hook-spool-cap-'))
  const hypHome = path.join(homeDir, '.hyp')
  const stateDir = path.join(hypHome, 'state', '@hypaware-claude')
  await fs.mkdir(stateDir, { recursive: true })
  const spoolDir = claudeBodySpoolDir(hypHome)
  if (opts.createSpool !== false) await fs.mkdir(spoolDir, { recursive: true, mode: 0o700 })
  return {
    hypHome,
    spoolDir,
    stateFile: path.join(stateDir, 'session-context.jsonl'),
    cleanup: async () => { await fs.rm(homeDir, { recursive: true, force: true }) },
  }
}

/**
 * @param {{ hypHome: string, stateFile: string }} env
 * @param {{ spoolMaxBytes?: number }} pluginConfig
 * @param {unknown} event
 */
function ctxFor(env, pluginConfig, event) {
  const telemetry = pluginConfig.spoolMaxBytes === undefined
    ? {}
    : { telemetry: { spool_max_bytes: pluginConfig.spoolMaxBytes } }
  return /** @type {any} */ ({
    stdout: { write() { return true } },
    stderr: { write() { return true } },
    stdin: /** @type {NodeJS.ReadStream} */ (
      Readable.from([typeof event === 'string' ? event : JSON.stringify(event)])
    ),
    env: { ...process.env, HYP_HOME: env.hypHome },
    config: { plugins: [{ name: '@hypaware/claude', config: telemetry }] },
  })
}

/**
 * @param {{ hypHome: string, stateFile: string }} env
 * @param {{ spoolMaxBytes?: number }} pluginConfig
 */
function runHook(env, pluginConfig) {
  return runClaudeSessionContextHook(
    ['session-context', '--state-file', env.stateFile],
    ctxFor(env, pluginConfig, { session_id: 'sess-spool', cwd: '/work/repo' }),
    { gitBranch: async () => undefined, gitRepoFacts: async () => ({}) }
  )
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {number} size
 * @param {number} mtimeSeconds
 */
async function writeBody(dir, name, size, mtimeSeconds) {
  const file = path.join(dir, name)
  await fs.writeFile(file, 'x'.repeat(size))
  await fs.utimes(file, mtimeSeconds, mtimeSeconds)
}

/** @param {string} dir */
async function totalBytes(dir) {
  const names = await fs.readdir(dir)
  let sum = 0
  for (const name of names) sum += (await fs.stat(path.join(dir, name))).size
  return sum
}
