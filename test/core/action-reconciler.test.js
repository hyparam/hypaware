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
  clearClientActionMarker,
  rearmRefusedActionMarker,
} from '../../src/core/config/action_reconciler.js'
import { createAttachHandler } from '../../src/core/config/action_attach.js'

/**
 * @import {
 *   ActionHandler,
 *   ActionMarkerStore,
 *   ActionOutcome,
 * } from '../../src/core/config/types.d.ts'
 * @import { ClientDescriptor } from '../../src/core/types.js'
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

/** A minimal reconcile input: handlers under test ignore these. */
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
 * A client descriptor with no `attachProbe`: perform() could attach it, but the
 * disk-driven reverse() has nothing to replay, so a marker applied out-of-band
 * for it must reverse as a `failed` (not a marker-dropping no-op). Mirrors the
 * `PROBELESS_DESCRIPTOR` fixture in `action-attach.test.js` (#212).
 * @type {ClientDescriptor}
 */
const PROBELESS_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/probeless'),
  name: 'probeless',
  skillDir: 'skills/probeless',
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

    // Second pass: the done marker short-circuits, so perform is not re-run.
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
    // then names a unit on the second pass, and the gap is picked up.
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

    // Empty before any pass: both the standalone reader and the handle agree.
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

    // A failed marker is not terminal: the next pass retries and bumps attempts.
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
    // it through a bare JSON.parse: a corrupt marker wedged ALL actions
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

test('a failed reverse keeps the marker in the store (probe-less attach is never orphaned) (#212)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // Seed a pre-existing applied `attach` marker for a probe-less client, as
    // if it had been written out-of-band (a manual `hyp attach`, or a pre-fix
    // marker). The real attach handler's reverse() short-circuits on the
    // missing attachProbe and returns `failed` rather than a marker-dropping
    // no-op, so the reconciler must KEEP the marker. Dropping it would orphan
    // the on-disk settings: present, but invisible to a later detach.
    const controlDir = path.join(stateRoot, 'config-control')
    fs.mkdirSync(controlDir, { recursive: true })
    fs.writeFileSync(
      markerPath(stateRoot),
      JSON.stringify(
        { attach: { probeless: { status: 'done', request_key: 'probeless', at: '2026-06-25T00:00:00.000Z' } } },
        null,
        2
      ) + '\n'
    )

    // Inject a detach spy so we can prove reverse() never even consulted the
    // disk undo (it short-circuits on the missing probe).
    let detachCalled = false
    const handler = createAttachHandler({
      detach: async () => {
        detachCalled = true
        return { changed: false }
      },
    })
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })

    // desired() returns [] (no `clients` registry on this input), so `probeless`
    // is no-longer-desired and the reverse gap fires for the seeded marker.
    const report = await reconciler.reconcile({
      ...INPUT,
      clientDescriptors: new Map([[PROBELESS_DESCRIPTOR.name, PROBELESS_DESCRIPTOR]]),
    })

    // (a) the reverse failure is reported, not a `reversed`.
    assert.deepEqual(
      report.results.map((r) => [r.kind, r.requestKey, r.outcome]),
      [['attach', 'probeless', 'failed']]
    )
    assert.match(String(report.results[0].reason), /attach_probe/)
    assert.equal(detachCalled, false, 'a probe-less reverse must not pretend the disk undo ran')

    // (b) the marker REMAINS in the store: never dropped, so the settings stay
    // owned and a later detach can still find them.
    assert.equal(readMarkerFile(stateRoot).attach.probeless.status, 'done')
    assert.equal(
      readClientActionStatus({ stateRoot }).byKind.attach.probeless.status,
      'done'
    )
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a failed marker that recorded an effect is reversed, not dropped (LLP 0138 marker-undo)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // A failed marker is normally dropped rather than reversed: it never
    // applied anything. `installed_assets` is the exception that proves it did
    // - an attach that went `done`, re-performed unsuccessfully, and carried
    // the field into its `failed` rewrite. Nothing else on disk names those
    // copies, so dropping the marker would orphan them.
    fs.mkdirSync(path.join(stateRoot, 'config-control'), { recursive: true })
    fs.writeFileSync(
      markerPath(stateRoot),
      JSON.stringify({
        attach: {
          'with-assets': {
            status: 'failed',
            request_key: 'with-assets',
            reason: 'a later pass failed',
            installed_assets: ['/home/u/.claude/skills/helper'],
          },
          'no-assets': { status: 'failed', request_key: 'no-assets', reason: 'never applied' },
        },
      }, null, 2) + '\n'
    )

    /** @type {ActionHandler & { reverseCalls: string[] }} */
    const handler = {
      kind: 'attach',
      reverseCalls: [],
      desired() { return [] },
      async perform() { return { status: 'done' } },
      async reverse(requestKey) {
        handler.reverseCalls.push(requestKey)
        return { status: 'done' }
      },
    }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })
    const report = await reconciler.reconcile(INPUT)

    assert.deepEqual(handler.reverseCalls, ['with-assets'], 'only the marker with a recorded effect reverses')
    assert.deepEqual(
      report.results.map((r) => [r.requestKey, r.outcome]),
      [['with-assets', 'reversed']]
    )
    // Both are gone from the store, but one of them went through its undo.
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

/**
 * Directly seed the client-actions marker store on disk (bypassing the
 * reconciler) so `clearClientActionMarker`'s retraction branches can be
 * exercised in isolation.
 *
 * @param {string} stateRoot
 * @param {ActionMarkerStore} store
 */
function seedMarkerFile(stateRoot, store) {
  const p = markerPath(stateRoot)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(store, null, 2) + '\n')
}

test('clearClientActionMarker is a no-op (returns false, writes nothing) when the file, bucket, or key is missing', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // (a) Missing store file: nothing to retract, and none is created.
    assert.equal(
      clearClientActionMarker({ stateRoot, kind: 'attach', requestKey: 'claude' }),
      false,
      'missing marker file returns false'
    )
    assert.equal(
      fs.existsSync(markerPath(stateRoot)),
      false,
      'no marker file is written for a missing store'
    )

    // (b) Missing bucket: an `attach` retraction over a store that only has a
    //     `backfill` bucket leaves the file byte-for-byte unchanged.
    seedMarkerFile(stateRoot, {
      backfill: { '@hypaware/claude': { status: 'done', request_key: '@hypaware/claude' } },
    })
    const beforeBucket = fs.readFileSync(markerPath(stateRoot), 'utf8')
    assert.equal(
      clearClientActionMarker({ stateRoot, kind: 'attach', requestKey: 'claude' }),
      false,
      'missing bucket returns false'
    )
    assert.equal(
      fs.readFileSync(markerPath(stateRoot), 'utf8'),
      beforeBucket,
      'missing bucket does not rewrite the file'
    )

    // (c) Missing key: the `attach` bucket exists but names a different client.
    seedMarkerFile(stateRoot, {
      attach: { codex: { status: 'done', request_key: 'codex' } },
    })
    const beforeKey = fs.readFileSync(markerPath(stateRoot), 'utf8')
    assert.equal(
      clearClientActionMarker({ stateRoot, kind: 'attach', requestKey: 'claude' }),
      false,
      'missing key returns false'
    )
    assert.equal(
      fs.readFileSync(markerPath(stateRoot), 'utf8'),
      beforeKey,
      'missing key does not rewrite the file'
    )
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('clearClientActionMarker drops an emptied bucket but preserves sibling buckets and keys', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // `attach` holds a single key; `backfill` is a sibling bucket with two.
    seedMarkerFile(stateRoot, {
      attach: { claude: { status: 'done', request_key: 'claude' } },
      backfill: {
        '@hypaware/claude': { status: 'done', request_key: '@hypaware/claude' },
        '@hypaware/codex': { status: 'done', request_key: '@hypaware/codex' },
      },
    })

    assert.equal(
      clearClientActionMarker({ stateRoot, kind: 'attach', requestKey: 'claude' }),
      true,
      'retracting the last attach key returns true'
    )

    const store = readMarkerFile(stateRoot)
    // Emptied bucket dropped entirely, not left dangling as an empty `{}`.
    assert.equal('attach' in store, false, 'the emptied attach bucket is dropped')
    // The sibling bucket and both its keys survive untouched.
    assert.equal(store.backfill['@hypaware/claude'].status, 'done', 'sibling backfill key survives')
    assert.equal(store.backfill['@hypaware/codex'].status, 'done', 'sibling backfill key survives')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// The re-arm's two shapes. `refused` is the only status it touches (a `done`
// marker is a live undo record; a `failed` one is short-circuited by nothing
// and needs no help), and it only *drops* a marker that records no effect: one
// carrying `installed_assets` names files an earlier successful attach copied,
// and that record has to outlive the re-arm or a later detach cannot remove
// them.
// @ref LLP 0186#re-arm-explicit-hyp-attach-re-run-only [tests]: only a refused
//   marker is re-armed, and an assetless one is the only one dropped
// @ref LLP 0138#marker-undo [tests]: the re-arm never destroys the record of an
//   applied effect
test('rearmRefusedActionMarker only touches a refused marker, and drops it only when it records no assets', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // (a) Missing store file: nothing to re-arm, and none is created.
    assert.equal(
      rearmRefusedActionMarker({ stateRoot, kind: 'attach', requestKey: 'claude' }),
      false,
      'missing marker file returns false'
    )
    assert.equal(fs.existsSync(markerPath(stateRoot)), false, 'no marker file is written for a missing store')

    // (b) A `done` marker is left exactly as it was: it is the only record
    //     naming what an org-driven attach installed.
    seedMarkerFile(stateRoot, {
      attach: {
        claude: { status: 'done', request_key: 'claude', installed_assets: ['/home/u/.claude/skills/org'] },
      },
    })
    const beforeDone = fs.readFileSync(markerPath(stateRoot), 'utf8')
    assert.equal(
      rearmRefusedActionMarker({ stateRoot, kind: 'attach', requestKey: 'claude' }),
      false,
      'a done marker is not re-armed'
    )
    assert.equal(fs.readFileSync(markerPath(stateRoot), 'utf8'), beforeDone, 'a done marker is not rewritten')

    // (c) A `failed` marker likewise: nothing short-circuits it already.
    seedMarkerFile(stateRoot, {
      attach: { claude: { status: 'failed', request_key: 'claude', reason: 'boom', attempts: 2 } },
    })
    const beforeFailed = fs.readFileSync(markerPath(stateRoot), 'utf8')
    assert.equal(
      rearmRefusedActionMarker({ stateRoot, kind: 'attach', requestKey: 'claude' }),
      false,
      'a failed marker is not re-armed'
    )
    assert.equal(fs.readFileSync(markerPath(stateRoot), 'utf8'), beforeFailed, 'a failed marker is not rewritten')

    // (d) An assetless `refused` marker records no effect, so it is dropped
    //     outright (and its emptied bucket with it), leaving siblings alone.
    seedMarkerFile(stateRoot, {
      attach: { claude: { status: 'refused', request_key: 'claude', reason: 'JSONC settings file', at: 'T0' } },
      backfill: { '@hypaware/claude': { status: 'done', request_key: '@hypaware/claude' } },
    })
    assert.equal(
      rearmRefusedActionMarker({ stateRoot, kind: 'attach', requestKey: 'claude' }),
      true,
      'an assetless refused marker is re-armed'
    )
    const dropped = readMarkerFile(stateRoot)
    assert.equal('attach' in dropped, false, 'the assetless refused marker is dropped, emptied bucket and all')
    assert.equal(dropped.backfill['@hypaware/claude'].status, 'done', 'sibling bucket survives')

    // (e) A `refused` marker carrying `installed_assets` is re-armed WITHOUT
    //     dropping the undo record: rewritten to `failed` (short-circuited by
    //     nothing, so the next pass re-performs) with the paths intact.
    seedMarkerFile(stateRoot, {
      attach: {
        claude: {
          status: 'refused',
          request_key: 'claude',
          reason: 'JSONC settings file',
          at: 'T0',
          endpoint: 'http://127.0.0.1:4388',
          installed_assets: ['/home/u/.claude/skills/org'],
        },
      },
    })
    assert.equal(
      rearmRefusedActionMarker({ stateRoot, kind: 'attach', requestKey: 'claude' }),
      true,
      'an asset-bearing refused marker is re-armed'
    )
    const kept = readMarkerFile(stateRoot).attach.claude
    assert.equal(kept.status, 'failed', 'it is rewritten to failed, which nothing short-circuits')
    assert.deepEqual(kept.installed_assets, ['/home/u/.claude/skills/org'], 'the undo record survives the re-arm')
    assert.equal(kept.request_key, 'claude')
    assert.equal(kept.endpoint, 'http://127.0.0.1:4388', 'unrelated detail is carried, not reconstructed')
    assert.match(String(kept.reason), /re-armed by an explicit 'hyp attach claude'/)
    assert.match(String(kept.reason), /previous refusal: JSONC settings file/)
    assert.equal('attempts' in kept, false, 'no attempt counter is invented for a re-arm')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a refused marker short-circuits unconditionally, unlike a done marker the handler reports stale (LLP 0186)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // The refusing handler would happily succeed on a second call, and declares
    // its marker stale on every pass. Neither re-arms it: only an explicit
    // `hyp attach` (which clears the marker) does, so `perform()` must be called
    // exactly once for the whole life of the refusal. This is what separates
    // `refused` from `done`, which the same `isCurrent() => false` DOES re-fire.
    let refuse = true
    /** @type {ActionHandler & { performCalls: number }} */
    const refusing = {
      kind: 'attach',
      performCalls: 0,
      desired() {
        return [{ requestKey: 'openclaw' }]
      },
      isCurrent() {
        return false
      },
      async perform() {
        refusing.performCalls += 1
        return refuse
          ? { status: 'refused', reason: 'models.providers.anthropic is not ours' }
          : { status: 'done' }
      },
    }
    const reconciler = createActionReconciler({
      stateRoot,
      handlers: [refusing],
      now: () => Date.parse('2026-08-04T00:00:00.000Z'),
      log: NOOP_LOG,
    })

    const p1 = await reconciler.reconcile(INPUT)
    assert.equal(refusing.performCalls, 1)
    assert.deepEqual(
      p1.results.map((r) => [r.requestKey, r.outcome]),
      [['openclaw', 'refused']]
    )
    assert.equal(p1.results[0].reason, 'models.providers.anthropic is not ours')

    // The precondition is "fixed" (perform would now report done) and the
    // freshness hook still says stale: the pass must skip anyway.
    refuse = false
    const p2 = await reconciler.reconcile(INPUT)
    assert.equal(refusing.performCalls, 1, 'a refused marker is never re-performed')
    assert.deepEqual(
      p2.results.map((r) => [r.requestKey, r.outcome]),
      [['openclaw', 'skipped']]
    )
    assert.equal(readMarkerFile(stateRoot).attach.openclaw.status, 'refused')

    // Control: the same `isCurrent() => false` against a DONE marker does
    // re-perform, so the skip above is the refusal's doing, not a dead hook.
    /** @type {ActionHandler & { performCalls: number }} */
    const succeeding = {
      kind: 'attach',
      performCalls: 0,
      desired() {
        return [{ requestKey: 'claude' }]
      },
      isCurrent() {
        return false
      },
      async perform() {
        succeeding.performCalls += 1
        return { status: 'done' }
      },
    }
    const control = createActionReconciler({ stateRoot, handlers: [succeeding], log: NOOP_LOG })
    await control.reconcile(INPUT)
    await control.reconcile(INPUT)
    assert.equal(succeeding.performCalls, 2, 'a stale done marker still re-performs')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('a refused outcome writes a terminal marker (reason + at, no attempts) that carries installed_assets forward (LLP 0186)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // The interesting shape: an attach that went `done` and copied assets, then
    // drifted (isCurrent → false) into a re-perform that refuses. The refusal
    // must not orphan the copies the earlier success recorded, and must not
    // grow an `attempts` counter, since nothing will ever retry it.
    seedMarkerFile(stateRoot, {
      attach: {
        openclaw: {
          status: 'done',
          request_key: 'openclaw',
          at: '2026-07-01T00:00:00.000Z',
          installed_assets: ['/home/u/.openclaw/skills/helper'],
        },
      },
    })

    /** @type {ActionHandler} */
    const handler = {
      kind: 'attach',
      desired() {
        return [{ requestKey: 'openclaw' }]
      },
      isCurrent() {
        return false
      },
      async perform() {
        return { status: 'refused', reason: 'openclaw.json is not ours' }
      },
    }
    const reconciler = createActionReconciler({
      stateRoot,
      handlers: [handler],
      now: () => Date.parse('2026-08-04T00:00:00.000Z'),
      log: NOOP_LOG,
    })

    await reconciler.reconcile(INPUT)

    const marker = readMarkerFile(stateRoot).attach.openclaw
    assert.equal(marker.status, 'refused')
    assert.equal(marker.request_key, 'openclaw')
    assert.equal(marker.reason, 'openclaw.json is not ours')
    assert.equal(marker.at, '2026-08-04T00:00:00.000Z', 'at carries the terminal-state time, like done')
    assert.equal('attempts' in marker, false, 'a refusal is never retried, so nothing counts attempts')
    assert.equal('last_attempt' in marker, false)
    assert.deepEqual(
      marker.installed_assets,
      ['/home/u/.openclaw/skills/helper'],
      "the earlier success's undo record survives the rewrite"
    )
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('the reverse gap drops an assetless refused marker and reverses one that recorded an effect (LLP 0186)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    // A refusal writes nothing to the client's settings, so a refused marker
    // for a key the config stops naming has nothing to undo and is dropped,
    // exactly like an assetless `failed` one. Unless it carried assets forward
    // from an earlier successful attach: then it takes the reverse path.
    seedMarkerFile(stateRoot, {
      attach: {
        'refused-with-assets': {
          status: 'refused',
          request_key: 'refused-with-assets',
          reason: 'not ours',
          at: '2026-08-04T00:00:00.000Z',
          installed_assets: ['/home/u/.openclaw/skills/helper'],
        },
        'refused-no-assets': {
          status: 'refused',
          request_key: 'refused-no-assets',
          reason: 'not ours',
          at: '2026-08-04T00:00:00.000Z',
        },
      },
    })

    /** @type {ActionHandler & { reverseCalls: string[] }} */
    const handler = {
      kind: 'attach',
      reverseCalls: [],
      desired() {
        return []
      },
      async perform() {
        return { status: 'done' }
      },
      async reverse(requestKey) {
        handler.reverseCalls.push(requestKey)
        return { status: 'done' }
      },
    }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })
    const report = await reconciler.reconcile(INPUT)

    assert.deepEqual(
      handler.reverseCalls,
      ['refused-with-assets'],
      'only the refused marker with a recorded effect reverses'
    )
    assert.deepEqual(
      report.results.map((r) => [r.requestKey, r.outcome]),
      [['refused-with-assets', 'reversed']]
    )
    // Both keys are gone: one dropped outright, one through its undo.
    assert.equal(readClientActionStatus({ stateRoot }).byKind.attach, undefined)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// The settings-only half of the undo record. `installed_assets` was the marker's
// only evidence that an effect had been applied, which is no evidence at all for
// a client whose attach writes settings and copies no files (openclaw is the
// routine case). These two tests pin the `prior_done` bit that carries that
// evidence, and the reverse gap's drop condition that reads it.
// @ref LLP 0250#the-bit [tests]: a done-to-terminal rewrite records the effect
//   it overwrites, and the reverse gap stops dropping such a marker
test('a settings-only attach rewritten from done to refused is reversed, not dropped (LLP 0250)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    let phase = 'attach'
    /** @type {ActionHandler & { reverseCalls: string[] }} */
    const handler = {
      kind: 'attach',
      reverseCalls: [],
      desired() {
        return phase === 'dropped' ? [] : [{ requestKey: 'openclaw' }]
      },
      // The LLP 0086 freshness hook: the recorded input drifted, so the `done`
      // marker re-`perform()`s instead of short-circuiting.
      isCurrent() {
        return false
      },
      async perform() {
        return phase === 'attach'
          ? { status: 'done' }
          : { status: 'refused', reason: 'models.providers.anthropic is not ours' }
      },
      async reverse(requestKey) {
        handler.reverseCalls.push(requestKey)
        return { status: 'done' }
      },
    }
    const reconciler = createActionReconciler({
      stateRoot,
      handlers: [handler],
      now: () => Date.parse('2026-08-17T00:00:00.000Z'),
      log: NOOP_LOG,
    })

    // 1. The attach applies: the client's settings are written, no assets copied.
    await reconciler.reconcile(INPUT)
    const applied = readMarkerFile(stateRoot).attach.openclaw
    assert.equal(applied.status, 'done')
    assert.equal('installed_assets' in applied, false, 'a settings-only attach records no assets')
    assert.equal('prior_done' in applied, false, 'a done marker says so with its status')

    // 2. The input drifts and the re-`perform()` refuses. The refusal itself
    //    wrote nothing, but the settings the earlier `done` wrote are still on
    //    disk, so the rewrite has to record the effect it overwrites.
    phase = 'refuse'
    await reconciler.reconcile(INPUT)
    const rewritten = readMarkerFile(stateRoot).attach.openclaw
    assert.equal(rewritten.status, 'refused')
    assert.equal('installed_assets' in rewritten, false)
    assert.equal(
      rewritten.prior_done,
      true,
      'the rewrite records that an earlier pass reached done, so the settings write stays named'
    )

    // 3. The config stops naming the key. The marker records no assets, so the
    //    reverse gap used to drop it and strand the settings; it must reverse.
    phase = 'dropped'
    const report = await reconciler.reconcile(INPUT)
    assert.deepEqual(
      handler.reverseCalls,
      ['openclaw'],
      'a marker over a settings write that is still on disk is reversed, never dropped'
    )
    assert.deepEqual(
      report.results.map((r) => [r.requestKey, r.outcome]),
      [['openclaw', 'reversed']]
    )
    assert.equal(readClientActionStatus({ stateRoot }).byKind.attach, undefined)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('the prior-done bit survives repeated failed rewrites, and a key that never applied anything is still dropped (LLP 0250)', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    let phase = 'attach'
    /** @type {ActionHandler & { reverseCalls: string[] }} */
    const handler = {
      kind: 'attach',
      reverseCalls: [],
      desired() {
        return phase === 'dropped' ? [] : [{ requestKey: 'applied' }, { requestKey: 'never-applied' }]
      },
      isCurrent() {
        return false
      },
      async perform(action) {
        if (action.requestKey === 'never-applied') return { status: 'failed', reason: 'transient' }
        return phase === 'attach' ? { status: 'done' } : { status: 'failed', reason: 'transient' }
      },
      async reverse(requestKey) {
        handler.reverseCalls.push(requestKey)
        return { status: 'done' }
      },
    }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })

    await reconciler.reconcile(INPUT)
    phase = 'fail'
    // Two failing passes: the bit is set by the first rewrite and has to survive
    // the second, which reads it off a marker that is already `failed`.
    await reconciler.reconcile(INPUT)
    await reconciler.reconcile(INPUT)

    const store = readMarkerFile(stateRoot).attach
    assert.equal(store.applied.status, 'failed')
    assert.equal(store.applied.attempts, 2, 'a failed marker still counts its retries')
    assert.equal(store.applied.prior_done, true, 'the bit outlives every later rewrite')
    assert.equal('prior_done' in store['never-applied'], false, 'a key that never reached done records nothing')

    phase = 'dropped'
    await reconciler.reconcile(INPUT)
    assert.deepEqual(
      handler.reverseCalls,
      ['applied'],
      'only the key whose attach really applied something is reversed; the other is dropped'
    )
    assert.equal(readClientActionStatus({ stateRoot }).byKind.attach, undefined)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})
