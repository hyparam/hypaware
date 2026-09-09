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
// do it: one provides the gateway capability and registers `ai-gateway`, the
// other requires that capability (so the gateway boot profile selects it, and
// dependency order activates it second) and redefines the victim's `name`.

const PROVIDER = '@fixture/gw-provider'
const POISONER = '@fixture/gw-poisoner'
const NEIGHBOUR = 'zzz-neighbour'

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

/** The source the gateway is meant to start, under the key it looks up by. */
function providerEntrypoint() {
  return [
    recorderPreamble(),
    'export async function activate(ctx) {',
    "  ctx.provideCapability('hypaware.ai-gateway', '2.0.0', {})",
    '  ctx.sources.register({',
    "    name: 'ai-gateway',",
    `    plugin: ${JSON.stringify(PROVIDER)},`,
    '    async start(startCtx) {',
    "      record({ event: 'start', source: 'ai-gateway', ctx_plugin: startCtx.plugin.name })",
    '      return {',
    "        async status() { record({ event: 'status', source: 'ai-gateway' }); return { state: 'ready', details: { fixture: 'gw-provider' } } },",
    "        async stop() { record({ event: 'stop', source: 'ai-gateway' }) },",
    '      }',
    '    },',
    '  })',
    '}',
    '',
  ].join('\n')
}

/**
 * The neighbour, plus the substitution itself.
 *
 * `Object.defineProperties(victim, Object.getOwnPropertyDescriptors(...))` is
 * what leaves a live accessor on the object the registry is holding, and two
 * near-misses would not. `Object.assign(victim, over)` reads the getter and
 * assigns its value, leaving the registry a contribution whose `name` is an
 * ordinary lying string: still a substitution, but no longer the live read
 * this issue is about, and no longer a read the count below can see.
 * `{ ...victim, ...over }` builds a new object and never touches the
 * registry's contribution at all, so every substitution assertion below would
 * pass against the unfixed code too. The recorded `accessor` and `probe`, and
 * the asserted read count, are what make either fail loudly.
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
    "  if (process.env.HYP_FIXTURE_POISON !== '1') return",
    "  const victim = ctx.sources.get('ai-gateway')",
    '  Object.defineProperties(victim, Object.getOwnPropertyDescriptors({',
    `    get name() { record({ event: 'name_read' }); return ${JSON.stringify(NEIGHBOUR)} },`,
    '  }))',
    "  const descriptor = Object.getOwnPropertyDescriptor(victim, 'name')",
    "  record({ event: 'poisoned', accessor: typeof descriptor?.get === 'function', probe: victim.name })",
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
 * @param {{ hypHome: string, configPath: string, recordDir: string, poison: boolean }} opts
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
        HYP_FIXTURE_POISON: poison ? '1' : '0',
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
  const run = runGatewayOutsideTestRunner({ ...home, poison: true })
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

test('an honest gateway boot starts, reports and stops unchanged', async (t) => {
  const home = await makeHome(t)
  const run = runGatewayOutsideTestRunner({ ...home, poison: false })
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
