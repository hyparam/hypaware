// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createReconcilePassScheduler, runDaemon } from '../../src/core/daemon/runtime.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

/**
 * @import { ActionReconciler, ReconcileInput } from '../../src/core/config/types.d.ts'
 */

/** Resolve on the next macrotask so a `void`-launched async pass can run. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Poll `predicate` until true or the deadline elapses.
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick()
  }
  throw new Error('waitFor timed out')
}

// ---------------------------------------------------------------------------
// Single-flight scheduler (the off-tick guard the daemon wires onConfirmed to)
// ---------------------------------------------------------------------------

test('createReconcilePassScheduler runs exactly one pass per idle edge', async () => {
  let runs = 0
  const sched = createReconcilePassScheduler({ run: async () => { runs++ } })

  sched.schedule('edge-1')
  await sched.settle()
  assert.equal(runs, 1)

  // A second edge after the first pass settles runs again: one pass per edge.
  sched.schedule('edge-2')
  await sched.settle()
  assert.equal(runs, 2)
})

test('createReconcilePassScheduler is single-flight and coalesces concurrent edges into one rerun', async () => {
  let runs = 0
  /** @type {Array<() => void>} */
  const releases = []
  // Each pass blocks until its release is called, so the test controls the
  // in-flight window deterministically.
  const run = () => new Promise((resolve) => {
    runs++
    releases.push(() => resolve(undefined))
  })
  const sched = createReconcilePassScheduler({ run })

  sched.schedule('edge-1') // starts pass 1, blocks on its release
  // schedule() returned while pass 1 is still in flight: proof the pass runs
  // off the caller's stack (it never blocks the tick loop / confirm poll).
  assert.equal(runs, 1)

  sched.schedule('edge-2') // in-flight → coalesced, no concurrent pass
  sched.schedule('edge-3') // in-flight → still one coalesced rerun
  assert.equal(runs, 1)

  // Finish pass 1: the coalesced edges drive exactly one more pass, not two.
  releases.shift()?.()
  await waitFor(() => runs === 2)
  assert.equal(runs, 2)

  // Finish pass 2: no further reruns are pending, so the scheduler settles.
  releases.shift()?.()
  await sched.settle()
  assert.equal(runs, 2)
})

test('createReconcilePassScheduler.settle resolves immediately when no pass is in flight', async () => {
  const sched = createReconcilePassScheduler({ run: async () => {} })
  await sched.settle() // never scheduled: resolves without hanging
  assert.ok(true)
})

test('createReconcilePassScheduler keeps scheduling after a pass throws', async () => {
  let runs = 0
  const sched = createReconcilePassScheduler({
    run: async () => { runs++; throw new Error('boom') },
    log: { error() {} },
  })
  sched.schedule('edge-1')
  await sched.settle()
  assert.equal(runs, 1)
  // A throw must not wedge the guard: the next edge still runs.
  sched.schedule('edge-2')
  await sched.settle()
  assert.equal(runs, 2)
})

// ---------------------------------------------------------------------------
// Daemon wiring: the after-activation already-confirmed pass + gating
// ---------------------------------------------------------------------------

/**
 * A fake reconciler that records each `reconcile()` input. Lets the daemon
 * tests assert whether (and with what) the boot pass ran without a real
 * `hyp backfill` subprocess.
 * @returns {{ reconciler: ActionReconciler, calls: ReconcileInput[] }}
 */
function makeFakeReconciler() {
  /** @type {ReconcileInput[]} */
  const calls = []
  /** @type {ActionReconciler} */
  const reconciler = {
    async reconcile(input) {
      calls.push(input)
      return { results: [] }
    },
    readStatus() {
      return { byKind: {} }
    },
  }
  return { reconciler, calls }
}

test('runDaemon runs the boot already-confirmed pass when a central layer is present and no probation is active', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-reconcile-boot-'))
  let handle
  try {
    const stateRoot = path.join(hypHome, 'hypaware')
    // A central layer (join seed) with no applied slot ⇒ no probation marker.
    const seedPath = centralSeedPath(stateRoot)
    await fs.mkdir(path.dirname(seedPath), { recursive: true })
    await fs.writeFile(seedPath, JSON.stringify({ version: 2, plugins: [] }) + '\n')

    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }) + '\n')

    const { reconciler, calls } = makeFakeReconciler()
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'reconcile-boot-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
      actionReconciler: reconciler,
    })

    await waitFor(() => calls.length === 1)
    assert.equal(calls.length, 1)
    // The pass carries the effective config and the kernel backfill registry.
    assert.ok(calls[0].config)
    assert.ok(calls[0].backfills)
    assert.equal(typeof calls[0].backfills.list, 'function')
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('runDaemon does not run the boot pass on a non-joined host (no central layer)', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-reconcile-nocentral-'))
  let handle
  try {
    // No seed, no applied slot ⇒ no central layer ⇒ the reconciler stays inert.
    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }) + '\n')

    const { reconciler, calls } = makeFakeReconciler()
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'reconcile-nocentral-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
      actionReconciler: reconciler,
    })

    // Give any (erroneously) scheduled pass time to run, then assert none did.
    await tick()
    await tick()
    assert.equal(calls.length, 0)
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('runDaemon does not run the boot pass while probation is still active (fresh-join case)', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-reconcile-probation-'))
  let handle
  try {
    const stateRoot = path.join(hypHome, 'hypaware')
    const controlDir = path.join(stateRoot, 'config-control')
    await fs.mkdir(controlDir, { recursive: true })

    // An applied central slot 'a' under active, unexpired probation: the
    // running config has NOT been confirmed yet, so the boot pass must wait
    // for the confirmation edge rather than fire now.
    const central = JSON.stringify({ version: 2, plugins: [] }) + '\n'
    await fs.writeFile(path.join(controlDir, 'config.a.json'), central)
    await fs.writeFile(path.join(controlDir, 'config.a.etag'), 'etag-1')
    await fs.symlink('config.a.json', path.join(controlDir, 'active'))
    const until = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
    await fs.writeFile(
      path.join(controlDir, 'state.json'),
      JSON.stringify({
        probation: {
          etag: 'etag-1',
          applied_at: new Date().toISOString(),
          until,
          slot: 'a',
          previous_slot: 'a',
        },
      }) + '\n'
    )

    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }) + '\n')

    const { reconciler, calls } = makeFakeReconciler()
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'reconcile-probation-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
      actionReconciler: reconciler,
    })

    await tick()
    await tick()
    assert.equal(calls.length, 0)
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('the confirmation edge during active probation drives exactly one reconcile pass (fresh-join path)', async () => {
  // The primary LLP 0037 path: a fresh join boots under active probation
  // (no boot pass: covered above) and the FIRST authenticated config poll
  // clears probation, firing the confirmation edge that schedules backfill.
  // Previously only the no-fire half was tested; this drives the edge through
  // the real configControl seam and asserts the pass actually runs once.
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-reconcile-confirm-'))
  let handle
  try {
    const stateRoot = path.join(hypHome, 'hypaware')
    const controlDir = path.join(stateRoot, 'config-control')
    await fs.mkdir(controlDir, { recursive: true })

    // Applied central slot 'a' under active, unexpired probation (the
    // fresh-join case): the boot pass must NOT fire yet.
    const central = JSON.stringify({ version: 2, plugins: [] }) + '\n'
    await fs.writeFile(path.join(controlDir, 'config.a.json'), central)
    await fs.writeFile(path.join(controlDir, 'config.a.etag'), 'etag-1')
    await fs.symlink('config.a.json', path.join(controlDir, 'active'))
    const until = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
    await fs.writeFile(
      path.join(controlDir, 'state.json'),
      JSON.stringify({
        probation: {
          etag: 'etag-1',
          applied_at: new Date().toISOString(),
          until,
          slot: 'a',
          previous_slot: 'a',
        },
      }) + '\n'
    )

    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }) + '\n')

    const { reconciler, calls } = makeFakeReconciler()
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'reconcile-confirm-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
      actionReconciler: reconciler,
    })

    // Probation is active → no boot pass.
    await tick()
    await tick()
    assert.equal(calls.length, 0, 'no pass while probation is outstanding')

    // Drive the confirmation edge through the same configControl seam the
    // central plugin's poll loop uses in production: probation active→cleared
    // fires onConfirmed → schedules exactly one reconcile pass.
    const configControl = /** @type {{ confirmPoll(): void } | undefined} */ (
      handle.runtime.configControl
    )
    assert.ok(configControl, 'the daemon runtime exposes the configControl seam')
    configControl.confirmPoll()

    await waitFor(() => calls.length === 1)
    // A second confirmPoll is a no-op (probation already cleared): no extra pass.
    configControl.confirmPoll()
    await tick()
    await tick()
    assert.equal(calls.length, 1, 'exactly one pass per confirmation edge')

    // The pass carried the effective config + the kernel backfill registry,
    // and the daemon's resolved HYP_HOME threaded into the input.
    assert.ok(calls[0].config)
    assert.equal(typeof calls[0].backfills.list, 'function')
    assert.equal(calls[0].env.HYP_HOME, hypHome)
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
