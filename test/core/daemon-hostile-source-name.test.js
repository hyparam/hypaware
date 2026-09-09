// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { createSourceRegistry } from '../../src/core/registry/sources.js'
import { startConfiguredSources } from '../../src/core/daemon/runtime.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writePidFile } from '../../src/core/daemon/pid.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */
/** @import { TestContext } from 'node:test' */

// `SourceRegistry.register` keys its Map from the string it validated, and
// `sources.start(name, ctx)` starts whichever contribution that key holds. The
// daemon's boot walk read `contribution.name` again for every use - ten times
// per source - and a contribution is stored by reference, so the name is free
// to be an accessor answering a neighbour's registered name: the neighbour's
// source is then started under the hostile plugin's activation context, its
// config slice and its capability handles, and every snapshot row is written
// from a further read still (issue #1535). The `hyp status` walk carried the
// same pair one probe wide.

const HOSTILE = '@fixture/hostile-source-name'
const HONEST = '@fixture/honest-source-name'

/**
 * Install `over`'s property descriptors onto an already-registered
 * contribution, so `name` becomes a live accessor on the object the registry
 * is holding.
 *
 * Descriptors, not `{ ...base, ...over }`: a spread invokes each getter once
 * and copies the value out, leaving a contribution whose `name` is an ordinary
 * string. Every assertion below then passes against the unfixed code too, and
 * the test proves nothing. The read counters are asserted for the same reason.
 *
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} over
 */
function beHostile(base, over) {
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(over))
}

/** @param {Record<string, unknown>} contribution */
function nameIsStillAnAccessor(contribution) {
  const descriptor = Object.getOwnPropertyDescriptor(contribution, 'name')
  return typeof descriptor?.get === 'function'
}

function makeLog() {
  /** @type {Array<{ level: string, event: string, fields: Record<string, unknown> }>} */
  const records = []
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields) => {
    records.push({ level, event, fields: fields ?? {} })
  }
  return { records, info: at('info'), warn: at('warn'), error: at('error') }
}

/**
 * A source whose handle does nothing but exist, plus the record of what it was
 * started with.
 *
 * @param {string} name
 * @param {string} plugin
 */
function fixtureSource(name, plugin) {
  /** @type {{ starts: number, ctx: unknown }} */
  const seen = { starts: 0, ctx: undefined }
  return {
    seen,
    contribution: {
      name,
      plugin,
      /** @param {unknown} ctx */
      async start(ctx) {
        seen.starts += 1
        seen.ctx = ctx
        return { async stop() {} }
      },
    },
  }
}

/**
 * The two contributions the substitution needs: a hostile one registered under
 * a name that sorts first, and the honest neighbour whose name it claims.
 */
function stageSubstitution() {
  const registry = createSourceRegistry()
  const hostile = fixtureSource('aaa-hostile', HOSTILE)
  const honest = fixtureSource('bbb-honest', HONEST)
  // `list()` orders by the keys the registry validated, so the hostile
  // contribution is walked first whatever its `name` answers, and the honest
  // source is still unstarted when the substitution is attempted.
  registry.register(hostile.contribution)
  registry.register(honest.contribution)
  let nameReads = 0
  beHostile(/** @type {any} */ (hostile.contribution), {
    get name() {
      nameReads += 1
      return 'bbb-honest'
    },
  })
  const hostileCtx = { marker: 'hostile-activation' }
  const honestCtx = { marker: 'honest-activation' }
  const runtime = /** @type {any} */ ({
    sources: registry,
    activationContexts: new Map([[HOSTILE, hostileCtx], [HONEST, honestCtx]]),
  })
  return { registry, runtime, hostile, honest, hostileCtx, honestCtx, reads: () => nameReads }
}

test('a source name answering with a neighbour\'s does not start the neighbour under the wrong activation context', async () => {
  const staged = stageSubstitution()
  const log = makeLog()
  const fileLog = makeLog()

  const snapshots = await startConfiguredSources({
    runtime: staged.runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })

  assert.equal(
    staged.honest.seen.ctx,
    staged.honestCtx,
    'the honest source was started with a context that is not its own'
  )
  assert.equal(staged.honest.seen.starts, 1, 'the honest source must start exactly once')
  assert.equal(staged.hostile.seen.starts, 0, 'the refused contribution must not have been started')

  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [{ name: 'bbb-honest', plugin: HONEST, state: 'started' }],
    'the status file must carry one row per started source, under its registered name and its own plugin'
  )

  assert.ok(nameIsStillAnAccessor(/** @type {any} */ (staged.hostile.contribution)), 'the fixture stopped being hostile')
  assert.equal(staged.reads(), 1, `the walk read the hostile name ${staged.reads()} times, so its uses can still disagree`)
})

test('the boot walk emits a structured warn for the source it refuses to start', async () => {
  const staged = stageSubstitution()
  const log = makeLog()
  const fileLog = makeLog()

  await startConfiguredSources({
    runtime: staged.runtime,
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })

  const warned = fileLog.records.filter((r) => r.event === 'daemon.source_identity_unreadable')
  assert.equal(warned.length, 1, 'a refused source was skipped silently')
  assert.equal(warned[0].level, 'warn')
  assert.equal(warned[0].fields.hyp_component, 'daemon')
  assert.equal(warned[0].fields.hyp_operation, 'daemon.start_sources')
  assert.equal(warned[0].fields.error_kind, 'unregistered_source_name')
  assert.equal(warned[0].fields.source, 'bbb-honest', 'the warn does not say which name was claimed')
})

test('the boot walk reads a source contribution\'s name once', async () => {
  const registry = createSourceRegistry()
  const solo = fixtureSource('solo', HONEST)
  registry.register(solo.contribution)
  let reads = 0
  beHostile(/** @type {any} */ (solo.contribution), {
    get name() {
      reads += 1
      return 'solo'
    },
  })
  const log = makeLog()
  const fileLog = makeLog()

  const snapshots = await startConfiguredSources({
    runtime: /** @type {any} */ ({
      sources: registry,
      activationContexts: new Map([[HONEST, { marker: 'honest-activation' }]]),
    }),
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })

  assert.equal(snapshots.length, 1, 'the honest single source must still start')
  assert.ok(nameIsStillAnAccessor(/** @type {any} */ (solo.contribution)), 'the fixture stopped being hostile')
  // `list()` orders by its own keys and reads nothing off the contribution,
  // so this is the walk's own count: the guard reads the name, and every use
  // after it reads the string the guard resolved.
  assert.equal(reads, 1, 'the walk read the same contribution name more than once')
})

test('an honest source starts exactly as it did before the guard', async () => {
  const registry = createSourceRegistry()
  const second = fixtureSource('zzz-second', HONEST)
  const first = fixtureSource('aaa-first', HOSTILE)
  registry.register(second.contribution)
  registry.register(first.contribution)
  const firstCtx = { marker: 'first-activation' }
  const secondCtx = { marker: 'second-activation' }
  const log = makeLog()
  const fileLog = makeLog()

  const snapshots = await startConfiguredSources({
    runtime: /** @type {any} */ ({
      sources: registry,
      activationContexts: new Map([[HOSTILE, firstCtx], [HONEST, secondCtx]]),
    }),
    log: /** @type {any} */ (log),
    fileLog: /** @type {any} */ (fileLog),
  })

  assert.deepEqual(
    snapshots.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state, health: s.health })),
    [
      { name: 'aaa-first', plugin: HOSTILE, state: 'started', health: { state: 'ready' } },
      { name: 'zzz-second', plugin: HONEST, state: 'started', health: { state: 'ready' } },
    ],
    'the registered order and the snapshot rows changed for honest contributions'
  )
  assert.equal(first.seen.ctx, firstCtx)
  assert.equal(second.seen.ctx, secondCtx)
  assert.equal(fileLog.records.filter((r) => r.level === 'warn').length, 0, 'an honest boot warned about something')
})

/**
 * @param {TestContext} t
 */
async function makeHome(t) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-source-name-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }))
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  return { hypHome, stateRoot }
}

/**
 * @param {string} hypHome
 * @param {unknown} sources
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome, sources) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
    runtime: /** @type {any} */ ({ sources }),
  }
}

test('hyp status lists a source under the name it registered under, or not at all', async (t) => {
  const { hypHome } = await makeHome(t)
  const staged = stageSubstitution()

  const report = await collectHypAwareStatus(collectOpts(hypHome, staged.registry))

  assert.deepEqual(
    report.sources.map((s) => ({ name: s.name, plugin: s.plugin, state: s.state })),
    [{ name: 'bbb-honest', plugin: HONEST, state: 'stopped' }],
    'the report labelled a row with a name and plugin that are not the same source\'s'
  )
  const diagnostic = report.diagnostics.find((d) => d.kind === 'source_name_unregistered')
  assert.ok(diagnostic, 'a source dropped from the report went unreported')
  assert.equal(diagnostic.severity, 'warning')

  assert.ok(nameIsStillAnAccessor(/** @type {any} */ (staged.hostile.contribution)), 'the fixture stopped being hostile')
  assert.equal(staged.reads(), 1, `the status walk read the hostile name ${staged.reads()} times, so its probe and its row can disagree`)
})
