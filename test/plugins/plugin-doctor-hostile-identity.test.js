// @ts-check

/**
 * `hyp plugin doctor` reports the keys the registries indexed by, not a fresh
 * read of the records they stored (issue #1538).
 *
 * Every registry the doctor's snapshot walks stores the object the plugin
 * passed, by reference, or (for a command) a shallow copy that still carries
 * the plugin's own `aliases`. `snapshotRegistry` read `name` and drained
 * `aliases` again out of those records, so a plugin controlling an accessor or
 * a stateful iterable could answer the report differently from the answer the
 * registry indexed. Nothing about that is visible to the operator: the report
 * still renders as a well-formed list, of a registry holding something else,
 * and `hyp plugin doctor` is precisely the surface used to decide whether to
 * trust a plugin.
 *
 * Every hostile fixture here installs its accessor with
 * `Object.defineProperties(base, Object.getOwnPropertyDescriptors(over))`
 * AFTER the registration, so the live getter reaches the stored record. A
 * fixture built with a spread would invoke each getter once and store the
 * copied value, which passes against the buggy code as happily as against the
 * fix; the read counters below fail loudly if that ever happens here.
 *
 * @ref LLP 0267#consequences [tests]: the snapshot is what the doctor's checks read, so a name in it that is not the registry's key is a finding made against the wrong contribution
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

import { dryRunActivate } from '../../src/core/plugin_doctor/dry_run.js'
import { loadManifest } from '../../src/core/manifest.js'
import { stderrTextFrom } from '../helpers/stderr_lines.js'

/**
 * @import { DryRunResult } from '../../src/core/plugin_doctor/types.js'
 */

const PLUGIN = '@test/hostile'

/** The token the guard's structured report carries. */
const REFUSAL = 'unregistered_contribution_name'

/**
 * Counters the fixtures write and the assertions read. A fixture is imported
 * into this same process, so the probe is shared through the global rather
 * than through a file.
 *
 * @type {{ nameReads: number, aliasPasses: number }}
 */
const probe = { nameReads: 0, aliasPasses: 0 }
// @ts-ignore - the fixtures reach it by this name
globalThis.__doctorProbe = probe

/**
 * Dry-run one fixture entrypoint and return the snapshot beside whatever the
 * guard wrote to stderr.
 *
 * @param {string} index Contents of the fixture's `src/index.js`.
 * @returns {Promise<{ result: DryRunResult, stderr: string }>}
 */
async function dryRun(index) {
  probe.nameReads = 0
  probe.aliasPasses = 0
  // A fresh directory per fixture: `dryRunActivate` loads the entrypoint with
  // dynamic `import()`, which caches by resolved URL.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-hostile-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'index.js'), index)
  const manifest = /** @type {any} */ ({
    schema_version: 1,
    name: PLUGIN,
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
  })
  /** @type {DryRunResult | undefined} */
  let result
  const stderr = await stderrTextFrom(async () => {
    result = await dryRunActivate(manifest, root)
  })
  assert.ok(result, 'dry run returned nothing')
  return { result, stderr }
}

/**
 * The fixture preamble: a live `name` getter that counts its reads and answers
 * with `answer`, installed onto an already-registered record.
 *
 * @param {string} answer
 */
function driftingName(answer) {
  return (
    `const probe = globalThis.__doctorProbe\n` +
    `function drift(record) {\n` +
    `  const over = { get name() { probe.nameReads += 1; return ${JSON.stringify(answer)} } }\n` +
    `  Object.defineProperties(record, Object.getOwnPropertyDescriptors(over))\n` +
    `}\n`
  )
}

test('a source whose name drifts onto its neighbour is left out, not listed under it', async () => {
  const { result, stderr } = await dryRun(
    driftingName('aaa-honest') +
    `export async function activate(ctx) {\n` +
    `  const start = async () => ({ async stop() {} })\n` +
    `  ctx.sources.register({ name: 'aaa-honest', plugin: '${PLUGIN}', start })\n` +
    `  const hostile = { name: 'bbb-hostile', plugin: '${PLUGIN}', start }\n` +
    `  ctx.sources.register(hostile)\n` +
    `  drift(hostile)\n` +
    `}\n`
  )
  assert.equal(result.ok, true)
  // Before the guard this read `['aaa-honest', 'aaa-honest']`: two sources, one
  // name, and no way to tell which row was which.
  assert.deepEqual(result.registered.sources, ['aaa-honest'])
  assert.equal(probe.nameReads, 1, 'the drifting accessor was never live: the fixture is vacuous')
  assert.match(stderr, new RegExp(REFUSAL))
})

test('a sink whose name drifts onto its neighbour is left out', async () => {
  const { result } = await dryRun(
    driftingName('aaa-honest') +
    `export async function activate(ctx) {\n` +
    `  const create = async () => ({ async export() { return { ok: true } }, async close() {} })\n` +
    `  ctx.sinks.register({ name: 'aaa-honest', plugin: '${PLUGIN}', supports: [], create })\n` +
    `  const hostile = { name: 'bbb-hostile', plugin: '${PLUGIN}', supports: [], create }\n` +
    `  ctx.sinks.register(hostile)\n` +
    `  drift(hostile)\n` +
    `}\n`
  )
  assert.deepEqual(result.registered.sinks, ['aaa-honest'])
  assert.equal(probe.nameReads, 1, 'the drifting accessor was never live: the fixture is vacuous')
})

test('a dataset whose name drifts onto its neighbour is left out', async () => {
  const { result } = await dryRun(
    driftingName('aaa_honest') +
    `export async function activate(ctx) {\n` +
    `  const schema = { columns: [{ name: 'id', type: 'string' }] }\n` +
    `  ctx.query.registerDataset({ name: 'aaa_honest', plugin: '${PLUGIN}', schema })\n` +
    `  const hostile = { name: 'bbb_hostile', plugin: '${PLUGIN}', schema }\n` +
    `  ctx.query.registerDataset(hostile)\n` +
    `  drift(hostile)\n` +
    `}\n`
  )
  assert.deepEqual(result.registered.datasets, ['aaa_honest'])
  assert.equal(probe.nameReads, 1, 'the drifting accessor was never live: the fixture is vacuous')
})

test('a command whose name drifts onto its neighbour is left out of both command buckets', async () => {
  const { result } = await dryRun(
    driftingName('aaa-honest') +
    `export async function activate(ctx) {\n` +
    `  const run = async () => 0\n` +
    `  ctx.commands.register({ name: 'aaa-honest', plugin: '${PLUGIN}', summary: 'a', usage: 'u', run })\n` +
    `  ctx.commands.register({ name: 'bbb-hostile', plugin: '${PLUGIN}', summary: 'b', usage: 'u', run })\n` +
    // The registry stores a copy of the registration, so the drift is
    // installed on the copy: `ctx.commands.get` is how a plugin reaches it.
    `  drift(ctx.commands.get('bbb-hostile'))\n` +
    `}\n`
  )
  assert.deepEqual(result.registered.commands, ['aaa-honest'])
  assert.deepEqual(result.registered.commandDetails.map((c) => c.name), ['aaa-honest'])
  // Two reads: one inside `CommandRegistry.list()`, whose comparator still
  // reads `a.name` off the records it is ordering (issue #1542, and not this
  // file's to fix), and one guarded read here. The snapshot took three before,
  // because `commands` and `commandDetails` each mapped the list again, so
  // they could disagree with the registry and with each other.
  assert.equal(probe.nameReads, 2, 'the drifting accessor was never live: the fixture is vacuous')
})

test('a stateful aliases iterable cannot put a spelling in the report that does not dispatch', async () => {
  const { result, stderr } = await dryRun(
    `const probe = globalThis.__doctorProbe\n` +
    `const aliases = {\n` +
    `  [Symbol.iterator]() {\n` +
    `    probe.aliasPasses += 1\n` +
    `    const yielded = probe.aliasPasses === 1 ? ['ok'] : ['ok', 'stolen']\n` +
    `    return yielded[Symbol.iterator]()\n` +
    `  },\n` +
    `}\n` +
    `export async function activate(ctx) {\n` +
    `  const run = async () => 0\n` +
    `  ctx.commands.register({ name: 'cmd', plugin: '${PLUGIN}', summary: 'c', usage: 'u', aliases, run })\n` +
    `}\n`
  )
  const [command] = result.registered.commandDetails
  // 'stolen' was never indexed: the registry drained the iterable once and got
  // `['ok']`. The report used to drain it a second time and print whatever
  // that pass said.
  assert.deepEqual(command.aliases, ['ok'])
  assert.equal(probe.aliasPasses, 2, 'the iterable answered only once: the fixture is vacuous')
  assert.match(stderr, new RegExp(REFUSAL))
  assert.match(stderr, /command alias/)
})

test('the refusal is a structured report, not a silent drop', async () => {
  const { stderr } = await dryRun(
    driftingName('nowhere-at-all') +
    `export async function activate(ctx) {\n` +
    `  const start = async () => ({ async stop() {} })\n` +
    `  const hostile = { name: 'only-source', plugin: '${PLUGIN}', start }\n` +
    `  ctx.sources.register(hostile)\n` +
    `  drift(hostile)\n` +
    `}\n`
  )
  const line = stderr.split('\n').find((l) => l.includes(REFUSAL))
  assert.ok(line, `no refusal on stderr:\n${stderr}`)
  assert.match(line, /\[hypaware:plugin-doctor\] WARN/)
  assert.match(line, /"hyp_operation":"doctor\.snapshot"/)
  assert.match(line, /"status":"degraded"/)
  assert.match(line, /"contribution_kind":"source"/)
  // The name it claimed, so an operator can go looking for it.
  assert.match(line, /"claimed_name":"nowhere-at-all"/)
})

test('a name accessor that throws costs the plugin one entry, not the whole doctor run', async () => {
  const { result, stderr } = await dryRun(
    `export async function activate(ctx) {\n` +
    `  const start = async () => ({ async stop() {} })\n` +
    `  ctx.sources.register({ name: 'aaa-honest', plugin: '${PLUGIN}', start })\n` +
    `  const hostile = { name: 'bbb-hostile', plugin: '${PLUGIN}', start }\n` +
    `  ctx.sources.register(hostile)\n` +
    `  const over = { get name() { throw new Error('no name for you') } }\n` +
    `  Object.defineProperties(hostile, Object.getOwnPropertyDescriptors(over))\n` +
    `}\n`
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.registered.sources, ['aaa-honest'])
  assert.match(stderr, new RegExp(REFUSAL))
})

test('an honest plugin registers exactly what the report says it does', async () => {
  const { result, stderr } = await dryRun(
    `export async function activate(ctx) {\n` +
    `  const run = async () => 0\n` +
    `  ctx.sources.register({ name: 'src', plugin: '${PLUGIN}', start: async () => ({ async stop() {} }) })\n` +
    `  ctx.sinks.register({ name: 'snk', plugin: '${PLUGIN}', supports: [], create: async () => ({ async export() { return { ok: true } }, async close() {} }) })\n` +
    `  ctx.query.registerDataset({ name: 'ds', plugin: '${PLUGIN}', schema: { columns: [{ name: 'id', type: 'string' }] } })\n` +
    `  ctx.commands.register({ name: 'demo run', plugin: '${PLUGIN}', summary: 's', usage: 'u', aliases: ['dr'], run })\n` +
    `  ctx.commands.registerGroup({ name: 'demo', plugin: '${PLUGIN}', summary: 'the demo group' })\n` +
    `  ctx.initPresets.register({ name: 'preset', plugin: '${PLUGIN}', summary: 'p', run })\n` +
    `}\n`
  )
  assert.equal(stderr.includes(REFUSAL), false, `an honest plugin tripped the guard:\n${stderr}`)
  assert.deepEqual(result.registered.sources, ['src'])
  assert.deepEqual(result.registered.sinks, ['snk'])
  assert.deepEqual(result.registered.datasets, ['ds'])
  assert.deepEqual(result.registered.commands, ['demo run'])
  assert.deepEqual(result.registered.commandDetails, [
    { name: 'demo run', summary: 's', aliases: ['dr'], hidden: false },
  ])
  assert.deepEqual(result.registered.commandGroups, [{ name: 'demo', summary: 'the demo group' }])
  assert.deepEqual(result.registered.init_presets, ['preset'])
})

test('no bundled plugin trips the guard', async () => {
  // The shipped surface is the equivalence check that matters: every name and
  // alias in it is a plain string on a plain object, so the guard has to leave
  // all of them exactly where they were.
  const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')
  const workspace = path.join(repoRoot, 'hypaware-core/plugins-workspace')
  const dirs = (await fs.readdir(workspace, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  /** @type {Map<string, string[]>} */
  const knownCapabilities = new Map()
  for (const dir of dirs) {
    const loaded = await loadManifest(path.join(workspace, dir))
    if (!loaded.ok) continue
    for (const [name, version] of Object.entries(loaded.manifest.provides?.capabilities ?? {})) {
      knownCapabilities.set(name, [...(knownCapabilities.get(name) ?? []), version])
    }
  }

  let commands = 0
  let aliases = 0
  const stderr = await stderrTextFrom(async () => {
    for (const dir of dirs) {
      const loaded = await loadManifest(path.join(workspace, dir))
      if (!loaded.ok) continue
      const { registered } = await dryRunActivate(loaded.manifest, path.join(workspace, dir), { knownCapabilities })
      assert.deepEqual(
        registered.commands,
        registered.commandDetails.map((c) => c.name),
        `${dir}: the two command buckets disagree`
      )
      commands += registered.commands.length
      for (const detail of registered.commandDetails) aliases += detail.aliases.length
    }
  })
  assert.equal(stderr.includes(REFUSAL), false, `a bundled plugin tripped the guard:\n${stderr}`)
  // Floors, not fixtures of the current totals: the point is that the guard
  // did not quietly empty the report.
  assert.ok(dirs.length >= 20, `only ${dirs.length} bundled plugins`)
  assert.ok(commands >= 30, `only ${commands} bundled commands survived the snapshot`)
  assert.ok(aliases >= 15, `only ${aliases} bundled aliases survived the snapshot`)
})
