// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createBackfillHandler, backfillHandler } from '../../src/core/config/action_backfill.js'
import { createActionReconciler } from '../../src/core/config/action_reconciler.js'

/**
 * @import { ActionContext, BackfillSpawnArgs, BackfillSpawnResult } from '../../src/core/config/types.js'
 * @import { BackfillContribution } from '../../hypaware-plugin-kernel-types.js'
 */

/** A quiet logger so tests don't spam stderr. */
const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }

const FIXED_NOW = Date.parse('2026-06-25T00:00:00.000Z')

/** The HYP_HOME the daemon resolves and threads into the reconcile input. */
const RESOLVED_HYP_HOME = '/resolved/hyp/home'

/**
 * A fake backfill registry over a fixed provider list.
 * @param {Partial<BackfillContribution>[]} list
 */
function fakeBackfills(list) {
  const providers = /** @type {BackfillContribution[]} */ (list)
  return {
    register() {},
    get(name) { return providers.find((p) => p.name === name) },
    list() { return providers },
  }
}

/** The claude provider as the kernel registers it (provider name != plugin name). */
const CLAUDE_PROVIDER = {
  name: 'claude',
  plugin: '@hypaware/claude',
  datasets: ['ai_gateway_messages'],
  run() { return (async function* () {})() },
}

/**
 * Build the ActionContext a handler hook receives.
 * @param {{ plugins?: any[], providers?: Partial<BackfillContribution>[] }} [opts]
 * @returns {ActionContext}
 */
function makeCtx(opts = {}) {
  return {
    config: /** @type {any} */ ({ version: 2, plugins: opts.plugins ?? [] }),
    backfills: /** @type {any} */ (fakeBackfills(opts.providers ?? [CLAUDE_PROVIDER])),
    // The daemon threads its resolved env (HYP_HOME forced to the daemon's
    // hypHome) down to the spawn; tests assert the child inherits it.
    env: { ...process.env, HYP_HOME: RESOLVED_HYP_HOME },
    now: () => FIXED_NOW,
    log: NOOP_LOG,
  }
}

/**
 * A spawn seam that records every call and returns a scripted result list
 * (the last entry repeats once exhausted).
 * @param {BackfillSpawnResult[]} results
 */
function recordingSpawn(results) {
  /** @type {BackfillSpawnArgs[]} */
  const calls = []
  let i = 0
  /** @param {BackfillSpawnArgs} args */
  async function spawn(args) {
    calls.push(args)
    const result = results[Math.min(i, results.length - 1)]
    i += 1
    return result
  }
  return { spawn, calls }
}

/** A successful `hyp backfill --json` payload with the given row count. */
function jsonPayload(rows) {
  return JSON.stringify({
    run_id: 'bf-test',
    dry_run: false,
    providers: [{ provider: 'claude', plugin: '@hypaware/claude', status: 'ok', rows_written: rows }],
  })
}

test('the default backfillHandler is a backfill-kind ActionHandler', () => {
  assert.equal(backfillHandler.kind, 'backfill')
  assert.equal(typeof backfillHandler.desired, 'function')
  assert.equal(typeof backfillHandler.perform, 'function')
  // Run-once: backfill is not reversible (imported data stays).
  assert.equal(backfillHandler.reverse, undefined)
})

test('desired() emits one action per enabled provider (default on_join, plugin->provider mapping)', () => {
  const { spawn } = recordingSpawn([{ status: 0, stdout: jsonPayload(0) }])
  const handler = createBackfillHandler({ spawn })
  const desired = handler.desired(
    makeCtx({ plugins: [{ name: '@hypaware/claude', enabled: true, config: { proxy: '@hypaware/ai-gateway' } }] })
  )
  assert.deepEqual(desired, [
    { requestKey: '@hypaware/claude', params: { provider: 'claude', plugin: '@hypaware/claude' } },
  ])
})

test('desired() honors an explicit on_join:false opt-out (no action)', () => {
  const handler = createBackfillHandler({ spawn: recordingSpawn([]).spawn })
  const desired = handler.desired(
    makeCtx({ plugins: [{ name: '@hypaware/claude', enabled: true, config: { backfill: { on_join: false } } }] })
  )
  assert.deepEqual(desired, [])
})

test('desired() does not fail open on a non-boolean on_join (treats it as opt-out)', () => {
  // The typo'd JSON string `"false"` is not a boolean; pre-fix it fell
  // through to default-on and ran backfill anyway. It must now suppress.
  const handler = createBackfillHandler({ spawn: recordingSpawn([]).spawn })
  const stringFalse = handler.desired(
    makeCtx({ plugins: [{ name: '@hypaware/claude', enabled: true, config: { backfill: { on_join: 'false' } } }] })
  )
  assert.deepEqual(stringFalse, [], 'on_join:"false" (string) must not run backfill')
  // A truthy non-boolean is equally malformed and equally suppressed.
  // Only a real boolean true (or an absent flag) runs the import.
  const numberOne = handler.desired(
    makeCtx({ plugins: [{ name: '@hypaware/claude', enabled: true, config: { backfill: { on_join: 1 } } }] })
  )
  assert.deepEqual(numberOne, [], 'on_join:1 (number) must not run backfill')
})

test('desired() carries window_days through to params when present', () => {
  const handler = createBackfillHandler({ spawn: recordingSpawn([]).spawn })
  const desired = handler.desired(
    makeCtx({ plugins: [{ name: '@hypaware/claude', enabled: true, config: { backfill: { window_days: 30 } } }] })
  )
  assert.deepEqual(desired, [
    { requestKey: '@hypaware/claude', params: { provider: 'claude', plugin: '@hypaware/claude', windowDays: 30 } },
  ])
})

test('desired() excludes a provider whose owning plugin is not enabled', () => {
  const handler = createBackfillHandler({ spawn: recordingSpawn([]).spawn })
  // Plugin present but disabled -> selectProviders drops it.
  const disabled = handler.desired(
    makeCtx({ plugins: [{ name: '@hypaware/claude', enabled: false, config: {} }] })
  )
  assert.deepEqual(disabled, [])
  // Plugin entirely absent from config -> also dropped.
  const absent = handler.desired(makeCtx({ plugins: [] }))
  assert.deepEqual(absent, [])
})

test('perform() resolves window_days to a --since flag (assert spawned argv)', async () => {
  const { spawn, calls } = recordingSpawn([{ status: 0, stdout: jsonPayload(1234) }])
  const handler = createBackfillHandler({ spawn })
  const outcome = await handler.perform(
    { requestKey: '@hypaware/claude', params: { provider: 'claude', plugin: '@hypaware/claude', windowDays: 30 } },
    makeCtx()
  )
  assert.deepEqual(outcome, { status: 'done', rows: 1234 })
  assert.equal(calls.length, 1)
  const expectedSince = new Date(FIXED_NOW - 30 * 86_400_000).toISOString()
  assert.deepEqual(calls[0].args, ['backfill', 'claude', '--since', expectedSince, '--json'])
})

test('perform() spawns with the daemon-resolved env (HYP_HOME), not process.env', async () => {
  // Regression for the LLP 0041 §Run-once flow step 2 hazard: the child must
  // import into the daemon's resolved HYP_HOME, not whatever process.env
  // names. Diverge process.env.HYP_HOME from the ctx env so a regression
  // (spawning with process.env) is unambiguous.
  const original = process.env.HYP_HOME
  process.env.HYP_HOME = '/some/other/process/home'
  try {
    const { spawn, calls } = recordingSpawn([{ status: 0, stdout: jsonPayload(1) }])
    const handler = createBackfillHandler({ spawn })
    await handler.perform(
      { requestKey: '@hypaware/claude', params: { provider: 'claude', plugin: '@hypaware/claude' } },
      makeCtx()
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].env.HYP_HOME, RESOLVED_HYP_HOME)
    assert.notEqual(calls[0].env.HYP_HOME, process.env.HYP_HOME)
  } finally {
    if (original === undefined) delete process.env.HYP_HOME
    else process.env.HYP_HOME = original
  }
})

test('perform() omits --since when window_days is absent (retention fallback)', async () => {
  const { spawn, calls } = recordingSpawn([{ status: 0, stdout: jsonPayload(5) }])
  const handler = createBackfillHandler({ spawn })
  const outcome = await handler.perform(
    { requestKey: '@hypaware/claude', params: { provider: 'claude', plugin: '@hypaware/claude' } },
    makeCtx()
  )
  assert.deepEqual(outcome, { status: 'done', rows: 5 })
  assert.deepEqual(calls[0].args, ['backfill', 'claude', '--json'])
})

test('perform() sums rows_written across providers in the --json payload', async () => {
  const payload = JSON.stringify({
    providers: [
      { provider: 'claude', rows_written: 10 },
      { provider: 'claude-extra', rows_written: 7 },
    ],
  })
  const { spawn } = recordingSpawn([{ status: 0, stdout: payload }])
  const handler = createBackfillHandler({ spawn })
  const outcome = await handler.perform(
    { requestKey: '@hypaware/claude', params: { provider: 'claude' } },
    makeCtx()
  )
  assert.deepEqual(outcome, { status: 'done', rows: 17 })
})

test('perform() records done (without rows) on exit 0 with an unparseable payload', async () => {
  const { spawn } = recordingSpawn([{ status: 0, stdout: 'not json' }])
  const handler = createBackfillHandler({ spawn })
  const outcome = await handler.perform(
    { requestKey: '@hypaware/claude', params: { provider: 'claude' } },
    makeCtx()
  )
  assert.deepEqual(outcome, { status: 'done' })
})

test('perform() returns failed on a non-zero exit', async () => {
  const { spawn } = recordingSpawn([{ status: 1, stdout: '' }])
  const handler = createBackfillHandler({ spawn })
  const outcome = await handler.perform(
    { requestKey: '@hypaware/claude', params: { provider: 'claude' } },
    makeCtx()
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /exited with code 1/)
})

test('perform() returns failed on a spawn error', async () => {
  const { spawn } = recordingSpawn([{ status: null, stdout: '', error: new Error('spawn ENOENT') }])
  const handler = createBackfillHandler({ spawn })
  const outcome = await handler.perform(
    { requestKey: '@hypaware/claude', params: { provider: 'claude' } },
    makeCtx()
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /ENOENT/)
})

test('perform() guards against a missing provider name', async () => {
  const { spawn, calls } = recordingSpawn([{ status: 0, stdout: jsonPayload(0) }])
  const handler = createBackfillHandler({ spawn })
  const outcome = await handler.perform({ requestKey: '@hypaware/claude', params: {} }, makeCtx())
  assert.equal(outcome.status, 'failed')
  assert.equal(calls.length, 0, 'no child spawned when the provider name is missing')
})

test('driven through the reconciler: a failed perform writes a failed marker, then a retry flips to done', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-action-backfill-'))
  const stateRoot = path.join(tmp, 'hypaware')
  try {
    // First pass fails (exit 1); second pass succeeds with 42 rows.
    const { spawn, calls } = recordingSpawn([
      { status: 1, stdout: '' },
      { status: 0, stdout: jsonPayload(42) },
    ])
    const handler = createBackfillHandler({ spawn })
    const input = {
      config: /** @type {any} */ ({
        version: 2,
        plugins: [{ name: '@hypaware/claude', enabled: true, config: { backfill: { window_days: 7 } } }],
      }),
      backfills: /** @type {any} */ (fakeBackfills([CLAUDE_PROVIDER])),
      env: { ...process.env, HYP_HOME: RESOLVED_HYP_HOME },
    }
    const reconciler = createActionReconciler({
      stateRoot,
      handlers: [handler],
      now: () => FIXED_NOW,
      log: NOOP_LOG,
    })

    const p1 = await reconciler.reconcile(input)
    assert.equal(p1.results[0].outcome, 'failed')
    const markerPath = path.join(stateRoot, 'config-control', 'client-actions.json')
    let marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    assert.equal(marker.backfill['@hypaware/claude'].status, 'failed')
    assert.equal(marker.backfill['@hypaware/claude'].attempts, 1)
    // The first spawn carried the resolved --since for a 7-day window, and
    // the daemon-resolved HYP_HOME threaded through the reconcile input.
    const expectedSince = new Date(FIXED_NOW - 7 * 86_400_000).toISOString()
    assert.deepEqual(calls[0].args, ['backfill', 'claude', '--since', expectedSince, '--json'])
    assert.equal(calls[0].env.HYP_HOME, RESOLVED_HYP_HOME)

    const p2 = await reconciler.reconcile(input)
    assert.equal(p2.results[0].outcome, 'done')
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    assert.equal(marker.backfill['@hypaware/claude'].status, 'done')
    assert.equal(marker.backfill['@hypaware/claude'].rows, 42)

    // Run-once: a done marker short-circuits. No third spawn.
    const p3 = await reconciler.reconcile(input)
    assert.equal(p3.results[0].outcome, 'skipped')
    assert.equal(calls.length, 2, 'no spawn after the done marker lands')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})
