// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { writeLock } from '../../src/core/plugin_install/lock.js'

/** @import { TestContext } from 'node:test' */

// Issue #1540. The gateway process looks its source up by the kernel-owned key
// and then started `source.name`, a fresh read of a plugin property on a
// contribution the registry stores by reference. An accessor answering with a
// neighbour's registered name made `sources.start` resolve that neighbour and
// start it under the gateway plugin's activation context, while `stop()` and
// `gatewaySnapshot()` stayed on the literal: nothing stopped what actually ran,
// and the status row kept reporting `ai-gateway` started.
//
// The substitution has to be staged inside a real boot, because the read is on
// the contribution the real registry is holding. Two installed fixture plugins
// do it: one provides the gateway capability, registers `ai-gateway`, and then
// redefines a property of the contribution it still holds a reference to (its
// `name` here, and its `plugin` for #1551 below); the other requires that
// capability (so the gateway boot profile selects it, and dependency order
// activates it second) and records that the same reach from a neighbour, which
// is what used to stage this, is closed (issue #1953).

const PROVIDER = '@fixture/gw-provider'
const POISONER = '@fixture/gw-poisoner'
const NEIGHBOUR = 'zzz-neighbour'
// Sorts before the provider, which is what puts it first in the activation
// order: `toposort` builds edges from `requires.plugins` only and breaks the
// remaining ties by name, so a capability requirement orders nothing.
const SQUATTER = '@aa/gw-squatter'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Shared fixture preamble: an append-only record, one file per process, so the
 * gateway's own reads are never confused with the processing child's (it boots
 * the same config, in its own heap, with its own copy of these contributions).
 */
function recorderPreamble() {
  return [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "import process from 'node:process'",
    'const RECORD = path.join(process.env.HYP_FIXTURE_RECORD, `rec-${process.pid}.jsonl`)',
    "function record(entry) { fs.appendFileSync(RECORD, JSON.stringify(entry) + '\\n') }",
  ].join('\n')
}

/**
 * The source the gateway is meant to start, under the key it looks up by, plus
 * the substitution itself.
 *
 * Self-inflicted, and it has to be: the registry stores contributions by
 * reference, so the plugin that registered one keeps a live handle on the
 * object the kernel is holding and can turn any property of it into an
 * accessor at any moment. A neighbour used to be able to do it too, through
 * `ctx.sources.get`, and `poisonerEntrypoint` below now records that it
 * cannot (issue #1953). The kernel-side invariant under test is the same
 * either way: the key the registry validated, and the registrar it recorded,
 * are what the gateway acts on, not what a live property answers now.
 *
 * `Object.defineProperties(contribution, Object.getOwnPropertyDescriptors(...))`
 * is what leaves a live accessor on the object the registry is holding, and
 * two near-misses would not. `Object.assign(contribution, over)` reads the
 * getter and assigns its value, leaving the registry a contribution whose
 * `name` is an ordinary lying string: still a substitution, but no longer the
 * live read this issue is about, and no longer a read the count below can see.
 * `{ ...contribution, ...over }` builds a new object and never touches the
 * registry's contribution at all, so every substitution assertion below would
 * pass against the unfixed code too. The recorded `accessor` and `probe`, and
 * the asserted read count, are what make either fail loudly.
 *
 * Which property it redefines is `HYP_FIXTURE_POISON`: `name` for the
 * substitution #1540 is about, `plugin` for the activation context #1551 is
 * about, and anything else leaves the contribution alone.
 */
function providerEntrypoint() {
  return [
    recorderPreamble(),
    'export async function activate(ctx) {',
    "  ctx.provideCapability('hypaware.ai-gateway', '2.0.0', {})",
    '  const contribution = {',
    "    name: 'ai-gateway',",
    `    plugin: ${JSON.stringify(PROVIDER)},`,
    '    async start(startCtx) {',
    "      record({ event: 'start', source: 'ai-gateway', ctx_plugin: startCtx.plugin.name })",
    '      return {',
    "        async status() { record({ event: 'status', source: 'ai-gateway' }); return { state: 'ready', details: { fixture: 'gw-provider' } } },",
    "        async stop() { record({ event: 'stop', source: 'ai-gateway' }) },",
    '      }',
    '    },',
    '  }',
    '  ctx.sources.register(contribution)',
    '  const poison = process.env.HYP_FIXTURE_POISON',
    "  if (poison !== 'name' && poison !== 'plugin') return",
    "  if (poison === 'name') {",
    '    Object.defineProperties(contribution, Object.getOwnPropertyDescriptors({',
    `      get name() { record({ event: 'name_read' }); return ${JSON.stringify(NEIGHBOUR)} },`,
    '    }))',
    '  } else {',
    '    Object.defineProperties(contribution, Object.getOwnPropertyDescriptors({',
    `      get plugin() { record({ event: 'plugin_read' }); return ${JSON.stringify(POISONER)} },`,
    '    }))',
    '  }',
    '  const descriptor = Object.getOwnPropertyDescriptor(contribution, poison)',
    "  record({ event: 'poisoned', field: poison, accessor: typeof descriptor?.get === 'function', probe: contribution[poison] })",
    '}',
    '',
  ].join('\n')
}

/**
 * The neighbour, and the reach that used to stage the substitution above.
 *
 * `ctx.sources.get('ai-gateway')` handed this plugin the live contribution the
 * registry is holding, by reference and writable, so a neighbour could both
 * redefine a property of it and call its `start()` under a context of its own
 * (issue #1953). It now answers with a read-only view, so the define throws
 * where it is made. The fixture records what it found rather than assuming it,
 * and it reads no poisoned property, so the read counts below stay the
 * provider's own probe alone.
 */
function poisonerEntrypoint() {
  return [
    recorderPreamble(),
    'export async function activate(ctx) {',
    "  ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')",
    '  ctx.sources.register({',
    `    name: ${JSON.stringify(NEIGHBOUR)},`,
    `    plugin: ${JSON.stringify(POISONER)},`,
    '    async start(startCtx) {',
    `      record({ event: 'start', source: ${JSON.stringify(NEIGHBOUR)}, ctx_plugin: startCtx.plugin.name })`,
    `      return { async stop() { record({ event: 'stop', source: ${JSON.stringify(NEIGHBOUR)} }) } }`,
    '    },',
    '  })',
    '  const poison = process.env.HYP_FIXTURE_POISON',
    "  if (poison !== 'name' && poison !== 'plugin') return",
    "  const reached = ctx.sources.get('ai-gateway')",
    "  let define_error = ''",
    "  let write_error = ''",
    '  try {',
    "    Object.defineProperty(reached, poison, { get() { return 'neighbour' }, configurable: true })",
    '  } catch (err) { define_error = String(err && err.name) }',
    '  try {',
    "    reached.start = async () => ({ async stop() {} })",
    '  } catch (err) { write_error = String(err && err.name) }',
    "  record({ event: 'neighbour_reach', field: poison, define_error, write_error, reached_type: typeof reached, start_type: typeof reached.start })",
    '}',
    '',
  ].join('\n')
}

/**
 * The other way to reach the same context, and the one the claim fallback was
 * written for: register `ai-gateway` on the registry itself rather than
 * through the facade, so the kernel records no owner, and declare the
 * provider's name as the contribution's own `plugin`.
 *
 * `Object.getPrototypeOf(ctx.sources)` used to be the registry: the facade
 * forwarded the rest of it by prototype chain, so its unbracketed `register`
 * was one property read away from any plugin holding a context, and
 * registering through it left `ownerOf('ai-gateway')` undefined (issue #1944).
 * The facade now reads through to the registry rather than inheriting from it,
 * so the hop finds `null` and the squat throws where it is attempted. The
 * fixture records what it found, so what follows is measured rather than
 * assumed.
 */
function squatterEntrypoint() {
  return [
    recorderPreamble(),
    'export async function activate(ctx) {',
    '  const proto = Object.getPrototypeOf(ctx.sources)',
    "  record({ event: 'squat_attempted', proto: String(proto), unbracketed_register: typeof proto?.register })",
    '  try {',
    '    proto.register({',
    "      name: 'ai-gateway',",
    `      plugin: ${JSON.stringify(PROVIDER)},`,
    '      async start(startCtx) {',
    "        record({ event: 'start', source: 'ai-gateway', who: 'squatter', ctx_plugin: startCtx.plugin.name })",
    "        return { async status() { return { state: 'ready' } }, async stop() { record({ event: 'stop', who: 'squatter' }) } }",
    '      },',
    '    })',
    '  } catch (err) {',
    "    record({ event: 'squat_refused', message: String(err && err.message) })",
    '  }',
    "  record({ event: 'squatted', owner_of: String(ctx.sources.ownerOf('ai-gateway')) })",
    '}',
    '',
  ].join('\n')
}

/**
 * Materialise an installed-plugin fixture and its lock entry, the way
 * `test/core/boot-installed.test.js` does, so a real boot discovers it.
 *
 * @param {string} hypHome
 * @param {string} name
 * @param {Record<string, unknown>} manifestExtras
 * @param {string} entrypoint
 */
async function stagePlugin(hypHome, name, manifestExtras, entrypoint) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', name)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name,
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    ...manifestExtras,
  }, null, 2))
  await fs.writeFile(path.join(installDir, 'index.js'), entrypoint)
  return { name, version: '0.1.0', installDir }
}

/**
 * A home whose gateway boot activates the two fixtures and nothing else.
 *
 * @param {TestContext} t
 */
async function makeHome(t) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-gateway-hostile-name-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const entries = [
    await stagePlugin(hypHome, PROVIDER, {
      provides: { capabilities: { 'hypaware.ai-gateway': '2.0.0' } },
      contributes: { sources: [{ name: 'ai-gateway' }] },
    }, providerEntrypoint()),
    await stagePlugin(hypHome, POISONER, {
      // The capability requirement is what makes the gateway boot profile
      // select this plugin at all; the plugin requirement is what orders it
      // after the provider, since `toposort` orders on `requires.plugins`.
      requires: { plugins: { [PROVIDER]: '^0.1.0' }, capabilities: { 'hypaware.ai-gateway': '^2.0.0' } },
      contributes: { sources: [{ name: NEIGHBOUR }] },
    }, poisonerEntrypoint()),
  ]
  /** @type {Record<string, any>} */
  const plugins = {}
  for (const e of entries) {
    plugins[e.name] = {
      name: e.name,
      version: e.version,
      source: { kind: 'local-dir', raw: e.installDir, path: e.installDir },
      install_dir: e.installDir,
      content_hash: 'a'.repeat(64),
      manifest_hash: 'b'.repeat(64),
      installed_at: '2026-05-21T00:00:00.000Z',
    }
  }
  await writeLock(path.join(hypHome, 'hypaware'), { schema_version: 1, plugins })
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    plugins: [{ name: PROVIDER, config: {} }, { name: POISONER, config: {} }],
  }))
  const recordDir = path.join(hypHome, 'records')
  await fs.mkdir(recordDir, { recursive: true })
  return { hypHome, configPath, recordDir }
}

/**
 * The same two roles, with the neighbour replaced by one that squats the key
 * instead of redefining a property on the contribution behind it.
 *
 * @param {TestContext} t
 */
async function makeSquatHome(t) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-gateway-squat-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const entries = [
    await stagePlugin(hypHome, PROVIDER, {
      provides: { capabilities: { 'hypaware.ai-gateway': '2.0.0' } },
      contributes: { sources: [{ name: 'ai-gateway' }] },
    }, providerEntrypoint()),
    await stagePlugin(hypHome, SQUATTER, {
      // The capability requirement, and no plugin requirement: the first is
      // what the gateway boot profile selects on, and leaving the second out
      // is what lets the name tie-break put this plugin first.
      requires: { capabilities: { 'hypaware.ai-gateway': '^2.0.0' } },
    }, squatterEntrypoint()),
  ]
  /** @type {Record<string, any>} */
  const plugins = {}
  for (const e of entries) {
    plugins[e.name] = {
      name: e.name,
      version: e.version,
      source: { kind: 'local-dir', raw: e.installDir, path: e.installDir },
      install_dir: e.installDir,
      content_hash: 'a'.repeat(64),
      manifest_hash: 'b'.repeat(64),
      installed_at: '2026-05-21T00:00:00.000Z',
    }
  }
  await writeLock(path.join(hypHome, 'hypaware'), { schema_version: 1, plugins })
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    plugins: [{ name: PROVIDER, config: {} }, { name: SQUATTER, config: {} }],
  }))
  const recordDir = path.join(hypHome, 'records')
  await fs.mkdir(recordDir, { recursive: true })
  return { hypHome, configPath, recordDir }
}

/**
 * Boot one gateway daemon against `hypHome`, snapshot it, stop it, and report
 * what it did.
 *
 * `runGatewayDaemon` is a daemon entrypoint, not a library call: it forks
 * `processor.js` with this process's stdout inherited, and its stop deadline
 * ends the process with `process.exit`. Inside a `node --test` worker that
 * stdout is the runner's report channel, so a processing child that outlives
 * the worker wedges the whole suite (see the same note in
 * `gateway-boot-failure-status.test.js`, #1527). So the daemon runs outside the
 * runner and reports through a file.
 *
 * @param {{ hypHome: string, configPath: string, recordDir: string, poison: 'name' | 'plugin' | 'none' }} opts
 * @returns {{ pid: number, bootError: string | null, stopError: string | null, snapshot: any }}
 */
function runGatewayOutsideTestRunner({ hypHome, configPath, recordDir, poison }) {
  const scriptPath = path.join(hypHome, 'gateway-run.mjs')
  const resultPath = path.join(hypHome, 'gateway-run.json')
  const errPath = path.join(hypHome, 'gateway-run.err')
  const daemonOpts = { hypHome, configPath, runId: 'gateway-hostile-name-test', tickIntervalMs: 0, installSignalHandlers: false }
  const gatewayUrl = pathToFileURL(path.join(REPO_ROOT, 'src/core/daemon/gateway.js')).href
  writeFileSync(scriptPath, [
    "import fs from 'node:fs'",
    `import { runGatewayDaemon } from ${JSON.stringify(gatewayUrl)}`,
    'const result = { pid: process.pid, bootError: null, stopError: null, snapshot: null }',
    'let handle',
    'try {',
    `  handle = await runGatewayDaemon({ ...${JSON.stringify(daemonOpts)}, env: { ...process.env } })`,
    '  result.snapshot = JSON.parse(JSON.stringify(handle.snapshot()))',
    '} catch (error) {',
    '  result.bootError = error instanceof Error ? error.message : String(error)',
    '}',
    'if (handle) {',
    '  try {',
    '    await handle.stop()',
    '    await handle.done',
    '  } catch (error) {',
    '    result.stopError = error instanceof Error ? error.message : String(error)',
    '  }',
    '}',
    `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result))`,
    'process.exit(0)',
    '',
  ].join('\n'))

  // A file, never a pipe: a pipe is the one thing the forked processing child
  // could still be holding when the deadline kills its parent.
  const errFd = openSync(errPath, 'w')
  let run
  try {
    run = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: hypHome,
        HYP_HOME: hypHome,
        HYP_FIXTURE_RECORD: recordDir,
        HYP_FIXTURE_POISON: poison,
      },
      stdio: ['ignore', 'ignore', errFd],
      timeout: 60_000,
    })
  } finally {
    closeSync(errFd)
  }
  const stderr = readFileSync(errPath, 'utf8')
  assert.equal(run.signal, null, `the gateway daemon never ended, so nothing was recorded: ${stderr}`)
  assert.equal(run.status, 0, stderr)
  return JSON.parse(readFileSync(resultPath, 'utf8'))
}

/**
 * What the fixtures recorded in the gateway's own process, in order.
 *
 * @param {string} recordDir
 * @param {number} pid
 */
async function recordsFor(recordDir, pid) {
  const text = await fs.readFile(path.join(recordDir, `rec-${pid}.jsonl`), 'utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

test('the gateway starts the source it looked up, not the name that contribution hands back', async (t) => {
  const home = await makeHome(t)
  const run = runGatewayOutsideTestRunner({ ...home, poison: 'name' })
  assert.equal(run.bootError, null, 'fixture invariant: the staged gateway home must boot')
  assert.equal(run.stopError, null, 'fixture invariant: the stop must complete')
  const records = await recordsFor(home.recordDir, run.pid)

  // Fixture invariant, asserted before anything else: the registry is holding a
  // contribution whose `name` is a live accessor answering the neighbour's
  // registered name. Without this the rest of the test is vacuous.
  const poisoned = records.find(r => r.event === 'poisoned')
  assert.ok(poisoned, 'the substitution was never staged')
  assert.equal(poisoned.accessor, true, 'the fixture stopped being hostile: `name` is not an accessor')
  assert.equal(poisoned.probe, NEIGHBOUR, 'the accessor does not answer with the neighbour\'s name')

  const starts = records.filter(r => r.event === 'start')
  assert.deepEqual(
    starts.map(r => ({ source: r.source, ctx_plugin: r.ctx_plugin })),
    [{ source: 'ai-gateway', ctx_plugin: PROVIDER }],
    'the gateway started a source other than the one it looked up, or under another plugin\'s activation context'
  )

  // One read: the fixture's own probe above. The gateway must not read the
  // name it already holds as a literal.
  const reads = records.filter(r => r.event === 'name_read')
  assert.equal(reads.length, 1, `the gateway read the contribution's name again after the probe (${reads.length} reads), so its lookup and its start can disagree`)


  // And the reach that used to stage this from a neighbour: `ctx.sources.get`
  // handed the poisoner the live contribution, by reference and writable, so
  // the substitution above was a neighbour's to make and `start()` was a
  // neighbour's to call (issue #1953). It now answers with a read-only view.
  const reach = records.find(r => r.event === 'neighbour_reach')
  assert.ok(reach, 'the neighbour never reached for the contribution')
  assert.equal(reach.reached_type, 'object', 'get() stopped answering a neighbour at all')
  assert.equal(reach.start_type, 'function', 'the narrowed contribution lost the shape the contract declares')
  assert.equal(reach.define_error, 'TypeError', 'a neighbour redefined a property of the live contribution')
  assert.equal(reach.write_error, 'TypeError', 'a neighbour wrote its own start() onto the live contribution')

  // What was started is what gets stopped.
  assert.deepEqual(
    records.filter(r => r.event === 'stop').map(r => r.source),
    ['ai-gateway'],
    'the gateway exited without stopping the source it started'
  )

  // And the status row describes the source that actually ran.
  const row = run.snapshot.sources[0]
  assert.equal(row.name, 'ai-gateway')
  assert.equal(row.details?.fixture, 'gw-provider', 'the gateway reported `ai-gateway` started from a source that never ran')
  assert.ok(records.some(r => r.event === 'status'), 'the snapshot never asked the started source for its status')
})

// Issue #1551, the same read one property over. The gateway picked the
// activation context it starts the source under from `source.plugin`, so a
// neighbour redefining that property after registration handed the real
// `ai-gateway` source the neighbour's config slice, paths, logger, capability
// handles and permission context, and nothing logged the swap.
test('the gateway starts the source under the context of the plugin that registered it, not the one that contribution claims', async (t) => {
  const home = await makeHome(t)
  const run = runGatewayOutsideTestRunner({ ...home, poison: 'plugin' })
  assert.equal(run.bootError, null, 'fixture invariant: the staged gateway home must boot')
  assert.equal(run.stopError, null, 'fixture invariant: the stop must complete')
  const records = await recordsFor(home.recordDir, run.pid)

  // Fixture invariant, asserted before anything else: the registry is holding a
  // contribution whose `plugin` is a live accessor naming the neighbour. Both
  // near-misses in `poisonerEntrypoint`'s note apply here too, so without this
  // the rest of the test is vacuous.
  const poisoned = records.find(r => r.event === 'poisoned')
  assert.ok(poisoned, 'the substitution was never staged')
  assert.equal(poisoned.field, 'plugin')
  assert.equal(poisoned.accessor, true, 'the fixture stopped being hostile: `plugin` is not an accessor')
  assert.equal(poisoned.probe, POISONER, 'the accessor does not answer with the neighbour\'s plugin name')

  // The one that matters: the registrar the kernel recorded, not the claim.
  assert.deepEqual(
    records.filter(r => r.event === 'start').map(r => ({ source: r.source, ctx_plugin: r.ctx_plugin })),
    [{ source: 'ai-gateway', ctx_plugin: PROVIDER }],
    'the gateway started the gateway source under a neighbour\'s activation context'
  )

  // One read: the fixture's own probe above. `ownerOf` answers, so the claim is
  // never consulted at all.
  const reads = records.filter(r => r.event === 'plugin_read')
  assert.equal(reads.length, 1, `the gateway read the contribution's plugin claim after the probe (${reads.length} reads), so a neighbour can still steer the context`)


  // And the reach that used to stage this from a neighbour: `ctx.sources.get`
  // handed the poisoner the live contribution, by reference and writable, so
  // the substitution above was a neighbour's to make and `start()` was a
  // neighbour's to call (issue #1953). It now answers with a read-only view.
  const reach = records.find(r => r.event === 'neighbour_reach')
  assert.ok(reach, 'the neighbour never reached for the contribution')
  assert.equal(reach.reached_type, 'object', 'get() stopped answering a neighbour at all')
  assert.equal(reach.start_type, 'function', 'the narrowed contribution lost the shape the contract declares')
  assert.equal(reach.define_error, 'TypeError', 'a neighbour redefined a property of the live contribution')
  assert.equal(reach.write_error, 'TypeError', 'a neighbour wrote its own start() onto the live contribution')

  assert.deepEqual(records.filter(r => r.event === 'stop').map(r => r.source), ['ai-gateway'])
})

// The step past #1551 the claim fallback left open, and the door it came
// through. A plugin reached the registry's own unbracketed `register` one
// prototype hop off `ctx.sources`, took the `ai-gateway` key with no owner
// recorded, and the real gateway plugin's registration then failed as a
// duplicate. The gateway refuses an unowned key rather than falling back to
// the contribution's `plugin` (#1551), so the squatter's source did not run,
// and the provider's did not either, because the key was gone.
//
// The facade now reads through to the registry rather than putting it on the
// plugin's prototype chain (issue #1944), so the hop finds nothing to register
// with. The squat fails where it is made, the provider keeps its own key, and
// the unowned registration the gateway's refusal is written against can no
// longer be staged from inside a plugin at all. That refusal stays as the last
// line; the same one in the processing daemon's boot walk is pinned directly
// in `test/core/source-plugin-ownership.test.js`, where an unowned
// registration can still be constructed on a bare registry.
test('the gateway key cannot be taken with no owner recorded through the sources facade', async (t) => {
  const home = await makeSquatHome(t)
  const run = runGatewayOutsideTestRunner({ ...home, poison: 'none' })
  assert.equal(run.stopError, null, 'fixture invariant: the stop must complete')
  const records = await recordsFor(home.recordDir, run.pid)

  // Fixture invariant: the squat has to have been attempted, or the assertions
  // below pass against any code at all.
  const attempt = records.find(r => r.event === 'squat_attempted')
  assert.ok(attempt, 'the squatter never ran, so nothing was staged')
  assert.equal(attempt.proto, 'null', 'the facade still hands a plugin something to walk up to')
  assert.equal(attempt.unbracketed_register, 'undefined', 'the facade still reaches an unbracketed register')
  assert.ok(
    records.find(r => r.event === 'squat_refused'),
    'the squat neither threw nor registered, so this proves nothing'
  )

  assert.equal(
    records.find(r => r.event === 'start' && r.who === 'squatter'),
    undefined,
    `the gateway started an unowned contribution under the plugin it named (bootError=${run.bootError})`
  )
  // The key stayed with the plugin that registers it, so the refused squat
  // costs the real gateway nothing either.
  assert.equal(run.bootError, null)
  assert.deepEqual(
    records.filter(r => r.event === 'start').map(r => ({ source: r.source, ctx_plugin: r.ctx_plugin })),
    [{ source: 'ai-gateway', ctx_plugin: PROVIDER }],
    'the provider lost its own source name to the squat'
  )
})

test('an honest gateway boot starts, reports and stops unchanged', async (t) => {
  const home = await makeHome(t)
  const run = runGatewayOutsideTestRunner({ ...home, poison: 'none' })
  assert.equal(run.bootError, null)
  assert.equal(run.stopError, null)
  const records = await recordsFor(home.recordDir, run.pid)

  assert.equal(records.filter(r => r.event === 'name_read').length, 0, 'nothing was poisoned, so nothing should have been read back')
  assert.deepEqual(
    records.filter(r => r.event === 'start').map(r => ({ source: r.source, ctx_plugin: r.ctx_plugin })),
    [{ source: 'ai-gateway', ctx_plugin: PROVIDER }]
  )
  assert.deepEqual(records.filter(r => r.event === 'stop').map(r => r.source), ['ai-gateway'])
  const row = run.snapshot.sources[0]
  assert.equal(row.name, 'ai-gateway')
  assert.equal(row.plugin, '@hypaware/ai-gateway')
  assert.equal(row.state, 'started')
  assert.equal(row.details?.fixture, 'gw-provider')
})
