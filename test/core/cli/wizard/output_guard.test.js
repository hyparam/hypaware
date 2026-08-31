// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { guardWizardOutput } from '../../../../src/core/cli/wizard/output_guard.js'
import { runInitWizard } from '../../../../src/core/cli/wizard/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { folderAskPath, readFolderAskModeSafe } from '../../../../src/core/usage-policy/folder_ask.js'

// The wizard's stream guard and boundary rule (LLP 0341): a dying output
// stream never surfaces as an uncaught throw, a dead stdout ends an
// attended run as a cancel at the next boundary, a dead stderr only
// degrades warnings, and what was persisted before the death stands.
// @ref LLP 0341#dead-surface [tests]:
// @ref LLP 0341#absorb [tests]:
// @ref LLP 0341#warnings [tests]:
// @ref LLP 0341#retained [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A sink that writes normally until the nth write, which (and every write
 * after it) throws the way a closed stream does.
 *
 * @param {number} failOn 1-based index of the first write that throws
 */
function throwingBuf(failOn) {
  let value = ''
  let writes = 0
  return {
    /** @param {string} chunk */
    write(chunk) {
      writes += 1
      if (writes >= failOn) throw new Error('EPIPE: broken pipe')
      value += String(chunk)
      return true
    },
    text() { return value },
  }
}

async function tmpHome(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

// --- the guard itself ---

test('guard: healthy streams pass writes through untouched', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const guard = guardWizardOutput({ stdout, stderr })

  assert.equal(guard.stdout.write('a'), true)
  assert.equal(guard.stderr.write('b'), true)
  assert.equal(stdout.text(), 'a')
  assert.equal(stderr.text(), 'b')
  assert.equal(guard.outputDead(), false)
  assert.equal(await guard.checkpoint(), true)
})

test('guard: a throwing stdout is absorbed, recorded, and reported by the checkpoint', async () => {
  const guard = guardWizardOutput({ stdout: throwingBuf(1), stderr: makeBuf() })

  assert.equal(guard.stdout.write('gone'), false)
  assert.equal(guard.outputDead(), true)
  assert.equal(await guard.checkpoint(), false)
  // Further writes are no-ops, not repeat throws.
  assert.equal(guard.stdout.write('still gone'), false)
})

test('guard: a throwing stderr never marks the consent surface dead', async () => {
  const stdout = makeBuf()
  const guard = guardWizardOutput({ stdout, stderr: throwingBuf(1) })

  assert.equal(guard.stderr.write('warning\n'), false)
  assert.equal(guard.outputDead(), false)
  assert.equal(await guard.checkpoint(), true)
  assert.equal(guard.stdout.write('on we go\n'), true)
  assert.equal(stdout.text(), 'on we go\n')
})

test('guard: isTTY and columns delegate to the wrapped stream', () => {
  const stdout = /** @type {any} */ ({ write: () => true, isTTY: true, columns: 120 })
  const guard = guardWizardOutput({ stdout, stderr: makeBuf() })
  assert.equal(/** @type {any} */ (guard.stdout).isTTY, true)
  assert.equal(/** @type {any} */ (guard.stdout).columns, 120)
})

// --- the orchestrator's boundary rule, driven in-process ---

/** Minimal empty catalog so the orchestrator never discovers real plugins. */
function catalogWith(descriptors) {
  return /** @type {any} */ ({
    plugins: new Map(),
    pluginMetadata: new Map(),
    knownDatasets: new Set(),
    clientDescriptors: new Map(),
    pickerDescriptors: new Map(descriptors.map((d) => [d.id, d])),
  })
}

const claude = { plugin: '@hypaware/claude', id: 'claude', label: 'Claude Code' }

/**
 * An enrolled decline-path run whose real folder-ask lane runs against
 * the given streams; every heavier phase is scripted.
 *
 * @param {string} home
 * @param {Record<string, any>} over
 */
function drivenOpts(home, over = {}) {
  const configPath = path.join(home, 'config.json')
  return /** @type {any} */ ({
    stdout: makeBuf(),
    stderr: makeBuf(),
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_NO_TUI: '1' },
    ctx: { commands: { run: async () => 0 } },
    capabilities: { has: () => false },
    catalog: catalogWith([claude]),
    finale: {},
    detect: async () => new Set(['claude']),
    gate: async () => ({ action: 'first-run', managed: false, report: {} }),
    fork: async () => 'team',
    join: async () => ({ status: 'ok', lockedSources: [], managed: true }),
    express: async () => 'choose',
    pick: async () => ({
      exitCode: 0,
      configPath,
      config: { version: 2, plugins: [] },
      configPending: true,
      sourcesPicked: ['claude'],
      exportPicked: 'local-parquet',
      clientsPicked: ['claude'],
      retentionDays: 30,
      descriptors: [claude],
      previouslyConfigured: [],
      lockedSources: [],
    }),
    prompt: async () => ['claude'],
    confirm: async () => 'ask',
    configure: async () => ({ results: [] }),
    finaleRunner: async () => ({
      daemonInstall: { skipped: true, dryRun: false },
      globalInstall: { skipped: true, installed: false },
      attach: [],
      skillsInstalled: [],
      agentsInstalled: [],
      daemonRestart: { skipped: true, dryRun: false, ok: false },
      backfill: [],
    }),
    ...over,
  })
}

test('a stdout that dies at the folder-ask receipt cancels the run before the config commits, keeping the recorded answer', async () => {
  const home = await tmpHome('hyp-guard-folder-')
  const stderr = makeBuf()
  // The folder-ask lane's receipt is the next stdout write after the
  // scripted answer; every write from it on throws. Writes before it
  // (narrations, position lines) succeed, so the run reaches the lane
  // exactly as a live one does.
  const stdout = makeBuf()
  let deadFrom = Infinity
  let writes = 0
  const dying = {
    /** @param {string} chunk */
    write(chunk) {
      writes += 1
      if (writes >= deadFrom) throw new Error('EPIPE: broken pipe')
      return stdout.write(chunk)
    },
  }
  const opts = drivenOpts(home, {
    stdout: dying,
    stderr,
    // The scripted folder answer also arms the death: the next stdout
    // write is the lane's own receipt, after the store write.
    confirm: async () => { deadFrom = writes + 1; return 'ask' },
  })

  const result = await runInitWizard(opts)

  assert.equal(result.exitCode, 130)
  assert.equal(result.cancelled, true)
  // The cancel is named where the ctrl+c cancel names itself.
  assert.match(stderr.text(), /output closed - cancelled/)
  // The answer given on a live surface stands (LLP 0341 #retained)...
  const stateDir = readObservabilityEnv(opts.env).stateDir
  assert.equal(await readFolderAskModeSafe({ stateDir }), 'ask')
  // ...and the composed config never landed (LLP 0341 #dead-surface).
  await assert.rejects(fs.access(path.join(home, 'config.json')))
})

test('a stdout that dies during the sync narration stops the run before the folder lane opens', async () => {
  const home = await tmpHome('hyp-guard-sync-')
  let folderConfirmAsked = false
  const opts = drivenOpts(home, {
    // Express accept: the lanes narrate instead of prompting, and the
    // narration is the run's consent surface (LLP 0201 #narrate).
    express: async () => 'defaults',
    // The pick lane is scripted, so the first real narration writes are
    // the sync lane's; kill the stream from the very first write.
    stdout: throwingBuf(1),
    confirm: async () => { folderConfirmAsked = true; return 'ask' },
  })

  const result = await runInitWizard(opts)

  assert.equal(result.exitCode, 130)
  assert.equal(result.cancelled, true)
  // The folder lane never opened and its store was never written: no
  // lane opens on a surface already known dead.
  assert.equal(folderConfirmAsked, false)
  const stateDir = readObservabilityEnv(opts.env).stateDir
  await assert.rejects(fs.access(folderAskPath(stateDir)))
  await assert.rejects(fs.access(path.join(home, 'config.json')))
})

test('an enrolled run whose stdout dies narrates the enrolled abort on the surviving stream', async () => {
  const home = await tmpHome('hyp-guard-abort-')
  const stderr = makeBuf()
  let deadFrom = Infinity
  let writes = 0
  const dying = {
    write() {
      writes += 1
      if (writes >= deadFrom) throw new Error('EPIPE: broken pipe')
      return true
    },
  }
  const opts = drivenOpts(home, {
    stdout: dying,
    stderr,
    confirm: async () => { deadFrom = writes + 1; return 'ask' },
  })

  const result = await runInitWizard(opts)

  assert.equal(result.cancelled, true)
  // This run joined, so the fact that outlives it is attempted where a
  // `2>log` invocation could still catch it.
  assert.match(stderr.text(), /This machine is enrolled/)
})

test('a dead stderr never cancels the run: warnings degrade, the wizard completes', async () => {
  const home = await tmpHome('hyp-guard-stderr-')
  const stdout = makeBuf()
  const opts = drivenOpts(home, {
    stdout,
    stderr: throwingBuf(1),
  })

  const result = await runInitWizard(opts)

  assert.equal(result.exitCode, 0)
  assert.equal(result.cancelled, undefined)
  // The run finished, committed, and said so.
  await fs.access(path.join(home, 'config.json'))
})

// --- the real closing stream, driven through a real pipe ---

// The reproduction from issue #1151, kept as the regression gate: the
// wizard runs in a child process with its stdout piped here, the pipe's
// read end is closed between the folder-ask answer and the lane's
// receipt write, and the run must end as a clean cancel - preference
// kept, config uncommitted, no EPIPE crash. Before LLP 0341 this exact
// drive died on an uncaught EPIPE with the split state on disk.
// @ref LLP 0341#dead-surface [tests]: driven through a real closing pipe, not a stubbed throw
test('a real closing pipe ends the run as a cancel: no crash, no commit, the recorded answer kept', async () => {
  const home = await tmpHome('hyp-guard-pipe-')
  const fixture = fileURLToPath(new URL('./fixtures/output_closed_pipe_child.mjs', import.meta.url))
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, DRIVE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (d) => { stderrText += d })
  child.stdout.on('data', () => {})

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const ready = path.join(home, 'ready.marker')
  let sawReady = false
  for (let i = 0; i < 1000; i += 1) {
    try {
      await fs.access(ready)
      sawReady = true
      break
    } catch {
      await sleep(10)
    }
  }
  assert.equal(sawReady, true, 'the drive never reached the folder-ask answer')
  // Close the read end of the real pipe, then let the child continue.
  child.stdout.destroy()
  await fs.writeFile(path.join(home, 'closed.marker'), '')

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve(code ?? `signal:${signal}`))
  })

  // A cancel, not a crash: exit 130 with the cancel named on stderr and
  // no EPIPE stack anywhere.
  assert.equal(exitCode, 130, `child exited ${exitCode}; stderr:\n${stderrText}`)
  assert.match(stderrText, /output closed - cancelled/)
  assert.doesNotMatch(stderrText, /EPIPE/)

  const result = JSON.parse(await fs.readFile(path.join(home, 'result.json'), 'utf8'))
  assert.equal(result.cancelled, true)

  // The split state is resolved the documented way (LLP 0341 #retained):
  // the answer given while the surface lived stands, and the composed
  // config never landed.
  const stateDir = readObservabilityEnv({ HYP_HOME: path.join(home, '.hyp') }).stateDir
  assert.equal(await readFolderAskModeSafe({ stateDir }), 'ask')
  await assert.rejects(fs.access(path.join(home, 'config.json')))
})

// The fork loop is a loop level like any other, and the disconnect
// question it can open is the run's most destructive act: "yes" runs the
// real `hyp leave` teardown (LLP 0190 #fork-disconnect). Unlike every
// store the lanes write, that teardown is not a retained answer
// (LLP 0341 #retained) - it undoes an enrollment - so it must not run on
// the strength of a default nobody could read.
// @ref LLP 0341#dead-surface [tests]: the disconnect question and its teardown take the boundary too
test('a stdout that dies at the fork question stops the run before the disconnect question opens', async () => {
  const home = await tmpHome('hyp-guard-leave-')
  const acts = []
  let writes = 0
  let deadFrom = Infinity
  const dying = {
    write() {
      writes += 1
      if (writes >= deadFrom) throw new Error('EPIPE: broken pipe')
      return true
    },
  }
  const opts = drivenOpts(home, {
    stdout: dying,
    // A managed machine reconfiguring: choosing local opens the
    // disconnect question.
    gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
    // The surface dies while the fork question is on screen: the lane's
    // own frame is the write that fails, absorbed by the guard.
    fork: async (lane) => {
      deadFrom = writes + 1
      lane.stdout.write('fork question frame\n')
      return 'local'
    },
    confirm: async () => { acts.push('disconnect-question-asked'); return 'disconnect' },
    leave: async () => { acts.push('leave-ran'); return 0 },
    configure: async () => { acts.push('configure-ran'); return { results: [] } },
  })

  const result = await runInitWizard(opts)

  assert.equal(result.exitCode, 130)
  assert.equal(result.cancelled, true)
  assert.deepEqual(acts, [])
  await assert.rejects(fs.access(path.join(home, 'config.json')))
})

// The settle is what makes the boundary check see a failure the stream
// has not announced yet. It reads the write callback's own error, so a
// sink that reports only that way - without an `error` event, and
// without the event arriving before the promise continuation - is still
// caught.
// @ref LLP 0341#absorb [tests]: the settle records a failure reported through the write callback alone
test('guard: a failure reported only through the write callback is caught by the checkpoint', async () => {
  /** A sink whose writes report failure through the callback alone. */
  const callbackOnly = {
    on() {},
    /** @param {string} _chunk @param {(err?: Error) => void} [cb] */
    write(_chunk, cb) {
      if (typeof cb === 'function') cb(new Error('EPIPE: broken pipe'))
      return false
    },
  }
  const guard = guardWizardOutput(/** @type {any} */ ({ stdout: callbackOnly, stderr: makeBuf() }))

  // No throw, no `error` event: nothing has marked the surface dead yet.
  assert.equal(guard.stdout.write('narration\n'), false)
  assert.equal(guard.outputDead(), false)
  // The boundary check settles first, and the settle's callback error is
  // the verdict.
  assert.equal(await guard.checkpoint(), false)
  assert.equal(guard.outputDead(), true)
})

// The same disconnect path, through a real closing pipe rather than a
// stubbed throw: the drive that found it.
// @ref LLP 0341#dead-surface [tests]: the disconnect teardown, proved absent through a real closing pipe
test('a real closing pipe at the fork question leaves the enrollment standing', async () => {
  const home = await tmpHome('hyp-guard-pipe-leave-')
  const fixture = fileURLToPath(new URL('./fixtures/output_closed_pipe_leave_child.mjs', import.meta.url))
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, DRIVE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', (d) => { stderrText += d })
  child.stdout.on('data', () => {})
  child.stdout.on('error', () => {})

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let sawReady = false
  for (let i = 0; i < 1000; i += 1) {
    try {
      await fs.access(path.join(home, 'ready.marker'))
      sawReady = true
      break
    } catch {
      await sleep(10)
    }
  }
  assert.equal(sawReady, true, 'the drive never reached the fork answer')
  child.stdout.destroy()
  await fs.writeFile(path.join(home, 'closed.marker'), '')

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve(code ?? `signal:${signal}`))
  })

  assert.equal(exitCode, 130, `child exited ${exitCode}; stderr:\n${stderrText}`)
  assert.match(stderrText, /output closed - cancelled/)
  assert.doesNotMatch(stderrText, /EPIPE/)

  const { result, acts } = JSON.parse(await fs.readFile(path.join(home, 'result.json'), 'utf8'))
  assert.equal(result.cancelled, true)
  // Nothing was asked and nothing acted after the surface died - the
  // enrollment this machine had is the enrollment it still has.
  assert.deepEqual(acts, [])
  await assert.rejects(fs.access(path.join(home, 'config.json')))
})
