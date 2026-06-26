// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createActionReconciler,
  readClientActionStatus,
} from '../../src/core/config/action_reconciler.js'

/**
 * @import {
 *   ActionContext,
 *   ActionHandler,
 *   ActionOutcome,
 *   DesiredAction,
 * } from '../../src/core/config/types.d.ts'
 */

/** A quiet logger so tests don't spam stderr. */
const NOOP_LOG = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

async function makeFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-action-reconciler-'))
  const stateRoot = path.join(tmp, 'hypaware')
  return { tmp, stateRoot }
}

/** A minimal reconcile input — handlers under test ignore these. */
const INPUT = {
  config: /** @type {any} */ ({ version: 2, plugins: [] }),
  backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
  env: process.env,
}

function markerPath(stateRoot) {
  return path.join(stateRoot, 'config-control', 'client-actions.json')
}

function readMarkerFile(stateRoot) {
  return JSON.parse(fs.readFileSync(markerPath(stateRoot), 'utf8'))
}

/**
 * A run-once handler whose `perform` counts calls. `desired()` returns one
 * unit per configured request key.
 *
 * @param {{ kind?: string, keys?: string[], outcome?: ActionOutcome }} [opts]
 */
function countingHandler(opts = {}) {
  const kind = opts.kind ?? 'backfill'
  const keys = opts.keys ?? ['@hypaware/claude']
  /** @type {ActionHandler & { performCalls: number, desiredCalls: number }} */
  const handler = {
    kind,
    performCalls: 0,
    desiredCalls: 0,
    desired() {
      handler.desiredCalls += 1
      return keys.map((requestKey) => ({ requestKey, params: { plugin: requestKey } }))
    },
    async perform(action) {
      handler.performCalls += 1
      return opts.outcome ?? { status: 'done', rows: 7 }
    },
  }
  return handler
}

test('reconcile runs a desired action once and short-circuits on the done marker', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    const handler = countingHandler()
    let clock = Date.parse('2026-06-25T00:00:00.000Z')
    const reconciler = createActionReconciler({
      stateRoot,
      handlers: [handler],
      now: () => clock,
      log: NOOP_LOG,
    })

    const first = await reconciler.reconcile(INPUT)
    assert.equal(handler.performCalls, 1)
    assert.deepEqual(
      first.results.map((r) => [r.requestKey, r.outcome]),
      [['@hypaware/claude', 'done']]
    )

    // Second pass: the done marker short-circuits — perform is not re-run.
    clock += 1000
    const second = await reconciler.reconcile(INPUT)
    assert.equal(handler.performCalls, 1, 'perform must not run again on a done marker')
    assert.deepEqual(
      second.results.map((r) => [r.requestKey, r.outcome]),
      [['@hypaware/claude', 'skipped']]
    )

    const file = readMarkerFile(stateRoot)
    assert.equal(file.backfill['@hypaware/claude'].status, 'done')
    assert.equal(file.backfill['@hypaware/claude'].rows, 7)
    assert.equal(file.backfill['@hypaware/claude'].request_key, '@hypaware/claude')
    assert.equal(file.backfill['@hypaware/claude'].at, '2026-06-25T00:00:00.000Z')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a missed pass (no marker yet) runs on the next reconcile call', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // Handler wants nothing on the first pass (the join hasn't confirmed),
    // then names a unit on the second — the gap is picked up.
    let active = false
    /** @type {ActionHandler & { performCalls: number }} */
    const handler = {
      kind: 'backfill',
      performCalls: 0,
      desired() {
        return active ? [{ requestKey: '@hypaware/codex' }] : []
      },
      async perform() {
        handler.performCalls += 1
        return { status: 'done', rows: 3 }
      },
    }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })

    const first = await reconciler.reconcile(INPUT)
    assert.equal(handler.performCalls, 0)
    assert.deepEqual(first.results, [])
    // No marker file written when nothing happened.
    assert.equal(fs.existsSync(markerPath(stateRoot)), false)

    active = true
    const second = await reconciler.reconcile(INPUT)
    assert.equal(handler.performCalls, 1)
    assert.equal(second.results[0].outcome, 'done')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('atomic marker read/write round-trips through readClientActionStatus and readStatus', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    const reconciler = createActionReconciler({
      stateRoot,
      handlers: [countingHandler({ keys: ['@hypaware/claude', '@hypaware/codex'] })],
      now: () => Date.parse('2026-06-25T12:00:00.000Z'),
      log: NOOP_LOG,
    })

    // Empty before any pass — both the standalone reader and the handle agree.
    assert.deepEqual(readClientActionStatus({ stateRoot }), { byKind: {} })
    assert.deepEqual(reconciler.readStatus(), { byKind: {} })

    await reconciler.reconcile(INPUT)

    const standalone = readClientActionStatus({ stateRoot })
    const viaHandle = reconciler.readStatus()
    assert.deepEqual(standalone, viaHandle)
    assert.equal(standalone.byKind.backfill['@hypaware/claude'].status, 'done')
    assert.equal(standalone.byKind.backfill['@hypaware/codex'].status, 'done')

    // File is mode 0600 and ends with a trailing newline (atomic-write idiom).
    const raw = fs.readFileSync(markerPath(stateRoot), 'utf8')
    assert.ok(raw.endsWith('}\n'))
    const mode = fs.statSync(markerPath(stateRoot)).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a failed perform writes a failed marker (not done) and retries with bumped attempts', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    let shouldFail = true
    /** @type {ActionHandler & { performCalls: number }} */
    const handler = {
      kind: 'backfill',
      performCalls: 0,
      desired() {
        return [{ requestKey: '@hypaware/codex' }]
      },
      async perform() {
        handler.performCalls += 1
        return shouldFail
          ? { status: 'failed', reason: 'transcript dir missing' }
          : { status: 'done', rows: 12 }
      },
    }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })

    const p1 = await reconciler.reconcile(INPUT)
    assert.equal(p1.results[0].outcome, 'failed')
    let file = readMarkerFile(stateRoot)
    assert.equal(file.backfill['@hypaware/codex'].status, 'failed')
    assert.equal(file.backfill['@hypaware/codex'].reason, 'transcript dir missing')
    assert.equal(file.backfill['@hypaware/codex'].attempts, 1)

    // A failed marker is not terminal — the next pass retries and bumps attempts.
    const p2 = await reconciler.reconcile(INPUT)
    assert.equal(handler.performCalls, 2)
    assert.equal(p2.results[0].outcome, 'failed')
    file = readMarkerFile(stateRoot)
    assert.equal(file.backfill['@hypaware/codex'].attempts, 2)

    // Once it succeeds the marker flips to done and stops retrying.
    shouldFail = false
    const p3 = await reconciler.reconcile(INPUT)
    assert.equal(p3.results[0].outcome, 'done')
    file = readMarkerFile(stateRoot)
    assert.equal(file.backfill['@hypaware/codex'].status, 'done')
    assert.equal(file.backfill['@hypaware/codex'].rows, 12)

    const p4 = await reconciler.reconcile(INPUT)
    assert.equal(handler.performCalls, 3, 'a done marker short-circuits subsequent passes')
    assert.equal(p4.results[0].outcome, 'skipped')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a thrown perform is normalized to a failed marker', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    /** @type {ActionHandler} */
    const handler = {
      kind: 'backfill',
      desired() {
        return [{ requestKey: '@hypaware/claude' }]
      },
      async perform() {
        throw new Error('spawn ENOENT')
      },
    }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })
    const report = await reconciler.reconcile(INPUT)
    assert.equal(report.results[0].outcome, 'failed')
    const file = readMarkerFile(stateRoot)
    assert.equal(file.backfill['@hypaware/claude'].status, 'failed')
    assert.equal(file.backfill['@hypaware/claude'].reason, 'spawn ENOENT')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a corrupt marker file does not wedge reconcile (treated as empty, pass still runs)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // Write garbage where the atomic marker store should be. `hyp status`
    // already swallows this (readClientActionStatus), but reconcile() read
    // it through a bare JSON.parse — a corrupt marker wedged ALL actions
    // while status reported clean. It must now degrade to an empty store.
    const controlDir = path.join(stateRoot, 'config-control')
    fs.mkdirSync(controlDir, { recursive: true })
    fs.writeFileSync(path.join(controlDir, 'client-actions.json'), '{ this is not: json,,,')

    const handler = countingHandler()
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })

    const report = await reconciler.reconcile(INPUT)
    // The pass ran the desired unit instead of throwing on the corrupt file.
    assert.equal(handler.performCalls, 1)
    assert.equal(report.results[0].outcome, 'done')
    // The corrupt file was overwritten with a clean, parseable marker store.
    const file = readMarkerFile(stateRoot)
    assert.equal(file.backfill['@hypaware/claude'].status, 'done')
    // The standalone status reader agrees (both tolerate corruption).
    assert.equal(
      readClientActionStatus({ stateRoot }).byKind.backfill['@hypaware/claude'].status,
      'done'
    )
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a handler whose desired() throws does not wedge other handlers', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    /** @type {ActionHandler} */
    const bad = {
      kind: 'attach',
      desired() {
        throw new Error('boom')
      },
      async perform() {
        return { status: 'done' }
      },
    }
    const good = countingHandler()
    const reconciler = createActionReconciler({ stateRoot, handlers: [bad, good], log: NOOP_LOG })
    const report = await reconciler.reconcile(INPUT)
    assert.equal(good.performCalls, 1)
    assert.deepEqual(
      report.results.map((r) => [r.kind, r.outcome]),
      [['backfill', 'done']]
    )
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a reversible handler undoes a previously-applied key the config no longer names', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    let wanted = ['client-a']
    /** @type {ActionHandler & { reverseCalls: string[] }} */
    const handler = {
      kind: 'attach',
      reverseCalls: [],
      desired() {
        return wanted.map((requestKey) => ({ requestKey }))
      },
      async perform() {
        // Reversible handlers record an applied state; reuse `done` as the
        // applied terminal for the test (the reconciler keys reverse off
        // "present marker that isn't failed and is no longer desired").
        return { status: 'done' }
      },
      async reverse(requestKey) {
        handler.reverseCalls.push(requestKey)
        return { status: 'done' }
      },
    }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })

    await reconciler.reconcile(INPUT)
    assert.equal(readMarkerFile(stateRoot).attach['client-a'].status, 'done')

    // Config no longer names client-a → reverse runs once and the marker is removed.
    wanted = []
    const report = await reconciler.reconcile(INPUT)
    assert.deepEqual(handler.reverseCalls, ['client-a'])
    assert.equal(report.results[0].outcome, 'reversed')
    assert.equal(readClientActionStatus({ stateRoot }).byKind.attach, undefined)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a run-once handler never reverses a no-longer-desired done marker', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    let wanted = ['@hypaware/claude']
    const handler = countingHandler()
    handler.desired = () => wanted.map((requestKey) => ({ requestKey }))
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })

    await reconciler.reconcile(INPUT)
    assert.equal(readMarkerFile(stateRoot).backfill['@hypaware/claude'].status, 'done')

    // Plugin disabled: a non-reversible handler keeps the marker (imported
    // data stays; run-once still short-circuits if it is re-enabled later).
    wanted = []
    const report = await reconciler.reconcile(INPUT)
    assert.deepEqual(report.results, [])
    assert.equal(readMarkerFile(stateRoot).backfill['@hypaware/claude'].status, 'done')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})
