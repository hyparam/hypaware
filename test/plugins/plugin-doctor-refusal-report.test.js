// @ts-check

/**
 * `hyp plugin doctor --json` says on stdout that the snapshot refused a
 * registration (issue #1569).
 *
 * `--json` is the agent-facing form of the report, and the report is the only
 * thing a consumer capturing stdout ever sees. When `snapshotRegistry` refused
 * a registration it left it out of `RegisteredSnapshot` and said so on the log
 * and the stderr mirror alone, so `checkContributions` diffed the manifest
 * against a snapshot with a hole in it and emitted
 * `contribution_not_registered`: a finding that is false about the plugin, with
 * a repair telling the author to add a `register` call that is already there
 * and that the registry would refuse as a duplicate. The half that explained it
 * was on the other stream.
 *
 * So the CLI cases here run the packaged binary with stderr *discarded* rather
 * than captured. Capturing it would prove the mirror still works, which was
 * never in doubt; discarding it is the consumer whose view was wrong.
 *
 * The hostile fixtures install their accessor with
 * `Object.defineProperties(base, Object.getOwnPropertyDescriptors(over))` AFTER
 * `register` has validated the honest value, onto the record the registry
 * stored, so the live accessor is the one the doctor reads. Vacuity is guarded
 * two ways, because a counter read from the top of the run proves nothing:
 * `Object.assign` and a spread each invoke the getter once at the install site
 * and leave a plain property behind, which scores 1 exactly as a live accessor
 * does. The CLI fixture therefore truncates its probe file after the install,
 * so the count is the doctor's reads and nobody else's; the alias fixture
 * demands the stronger evidence, an iterable that answers *twice for two
 * passes*, which no copied value can do.
 *
 * @ref LLP 0267#consequences [tests]: the snapshot is what the doctor's checks read, so a registration missing from it is a finding the report has to explain rather than misattribute
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { diagnosePlugin } from '../../src/core/plugin_doctor/diagnose.js'
import { dryRunActivate } from '../../src/core/plugin_doctor/dry_run.js'
import { loadManifest } from '../../src/core/manifest.js'
import { stderrTextFrom } from '../helpers/stderr_lines.js'

/**
 * @import { DoctorReport, PluginDiagnostic } from '../../src/core/plugin_doctor/types.js'
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = path.join(REPO_ROOT, 'bin', 'hypaware.js')
const PLUGIN = '@test/json-residual'

/** The env var a fixture finds its read-counting probe file through. */
const PROBE_ENV = 'HYP_DOCTOR_REFUSAL_PROBE'

/**
 * Write a fixture plugin and return its directory.
 *
 * @param {object} args
 * @param {Record<string, unknown>} args.manifest
 * @param {string} args.index Contents of the fixture's `src/index.js`.
 * @returns {Promise<string>}
 */
async function writePlugin({ manifest, index }) {
  // A fresh directory per fixture: the dry run loads the entrypoint with
  // dynamic `import()`, which caches by resolved URL.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-refusal-'))
  await fs.writeFile(path.join(root, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'index.js'), index)
  return root
}

/** @param {Record<string, unknown>} [overrides] */
function manifestFor(overrides = {}) {
  return {
    schema_version: 1,
    name: PLUGIN,
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    ...overrides,
  }
}

/**
 * Run the packaged CLI's doctor over `rootDir` and hand back only what a
 * stdout-only consumer gets. stderr is `ignore`d at the descriptor, not
 * captured and then dropped, so there is no way for this harness to read the
 * mirror even by accident.
 *
 * The dev-telemetry and OTLP variables are stripped, which is the default
 * install's footing (LLP 0329#dark-substrate) and the one the doctor is
 * actually run on.
 *
 * @param {string} rootDir
 * @param {string[]} extraArgs
 * @param {string} [probeFile] Passed to the fixture as its read counter.
 * @returns {{ status: number | null, stdout: string }}
 */
function doctorStdout(rootDir, extraArgs, probeFile) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, HYP_HOME: path.join(rootDir, 'home') }
  delete env.HYP_DEV_TELEMETRY
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete env.DEV_RUN_ID
  if (probeFile !== undefined) env[PROBE_ENV] = probeFile
  const out = spawnSync(process.execPath, [BIN, 'dev', 'plugin', 'doctor', rootDir, ...extraArgs], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return { status: out.status, stdout: out.stdout }
}

/**
 * The fixture preamble for the CLI cases: a live `summary` getter that appends
 * one byte to the probe file on every read and answers `42`, installed onto an
 * already-registered record. The probe is truncated once the install is done,
 * so what it holds afterwards is what the doctor read.
 */
const DRIFTING_SUMMARY =
  `import { appendFileSync, writeFileSync } from 'node:fs'\n` +
  `const probe = process.env.${PROBE_ENV}\n` +
  `function drift(record) {\n` +
  `  const over = { get summary() { appendFileSync(probe, 'r'); return 42 } }\n` +
  `  Object.defineProperties(record, Object.getOwnPropertyDescriptors(over))\n` +
  `  writeFileSync(probe, '')\n` +
  `}\n`

/** @param {PluginDiagnostic[]} diagnostics @param {string} kind */
function ofKind(diagnostics, kind) {
  return diagnostics.filter((d) => d.kind === kind)
}

test('a refused contribution says so on stdout, and is not reported as never registered', async () => {
  // The issue's own repro: a command registered honestly, then given a
  // `summary` the registry never validated.
  const root = await writePlugin({
    manifest: manifestFor({ contributes: { commands: [{ name: 'jr cmd', summary: 'declared' }] } }),
    index:
      DRIFTING_SUMMARY +
      `export async function activate(ctx) {\n` +
      `  const run = async () => 0\n` +
      `  ctx.commands.register({ name: 'jr cmd', plugin: '${PLUGIN}', summary: 'declared', usage: 'u', run })\n` +
      `  drift(ctx.commands.get('jr cmd'))\n` +
      `}\n`,
  })
  const probeFile = path.join(root, 'reads')
  await fs.writeFile(probeFile, '')

  const run = doctorStdout(root, ['--json'], probeFile)
  assert.equal(
    await fs.readFile(probeFile, 'utf8'),
    'r',
    'the doctor did not read the drifting accessor exactly once: the fixture is vacuous'
  )

  const report = /** @type {DoctorReport} */ (JSON.parse(run.stdout))
  // The registration was made. Saying it never was, and pointing the author at
  // the call that is already in the file, is the finding this issue is about.
  assert.deepEqual(ofKind(report.diagnostics, 'contribution_not_registered'), [])
  assert.deepEqual(ofKind(report.diagnostics, 'contribution_unreadable'), [
    {
      kind: 'contribution_unreadable',
      severity: 'error',
      location: '/contributes/commands',
      message:
        `a registered command claiming 'jr cmd' answered with a summary that is not ` +
        `the string it registered; left out of the report`,
      repair: [
        'Register a plain object whose fields do not change between reads: the doctor re-reads the name, summary and aliases off the record the registry holds',
        'Look for a getter, a Proxy, or a mutation of the registered object after the register() call',
        'See docs/PLUGIN_AUTHORING.md#troubleshooting-doctor-diagnostics',
      ],
    },
  ])
  // The refusal was already an error-severity finding before this, so the exit
  // code an author's CI reads is the one it was.
  assert.equal(report.ok, false)
  assert.equal(report.errorCount, 1)
  assert.equal(run.status, 1)
})

test('the human report carries the same refusal the JSON one does', async () => {
  const root = await writePlugin({
    manifest: manifestFor({ contributes: { commands: [{ name: 'jr cmd', summary: 'declared' }] } }),
    index:
      DRIFTING_SUMMARY +
      `export async function activate(ctx) {\n` +
      `  const run = async () => 0\n` +
      `  ctx.commands.register({ name: 'jr cmd', plugin: '${PLUGIN}', summary: 'declared', usage: 'u', run })\n` +
      `  drift(ctx.commands.get('jr cmd'))\n` +
      `}\n`,
  })
  const probeFile = path.join(root, 'reads')
  await fs.writeFile(probeFile, '')

  const run = doctorStdout(root, [], probeFile)
  assert.equal(await fs.readFile(probeFile, 'utf8'), 'r', 'the fixture is vacuous')
  assert.match(run.stdout, /\[contribution_unreadable\] \/contributes\/commands: a registered command claiming 'jr cmd'/)
  assert.equal(run.stdout.includes('never registered it'), false, `the human report still misattributes it:\n${run.stdout}`)
})

test('a contribution that really was never registered is still contribution_not_registered', async () => {
  // The meaning the kind was written for, unchanged: nothing was refused here,
  // so nothing routes around the diff.
  const root = await writePlugin({
    manifest: manifestFor({ contributes: { commands: [{ name: 'ja cmd', summary: 'declared' }] } }),
    index: `export async function activate() {}\n`,
  })
  const run = doctorStdout(root, ['--json'])
  const report = /** @type {DoctorReport} */ (JSON.parse(run.stdout))
  assert.deepEqual(ofKind(report.diagnostics, 'contribution_unreadable'), [])
  assert.deepEqual(ofKind(report.diagnostics, 'contribution_not_registered'), [
    {
      kind: 'contribution_not_registered',
      severity: 'error',
      location: '/contributes/commands',
      message: `manifest declares command 'ja cmd' but activate() never registered it`,
      repair: [
        `In activate(), add: ctx.commands.register({ name: 'ja cmd', plugin, run })`,
        'See docs/PLUGIN_AUTHORING.md#registering-commands',
      ],
    },
  ])
  assert.equal(run.status, 1)
})

test('a refusal of something the manifest never declares reaches the report too', async () => {
  // The alias refusal has no declared name to attach to, so nothing about the
  // declared-vs-registered diff would ever mention it. It is carried because
  // the report is the record of what the snapshot could not see, not only of
  // what the manifest asked about.
  //
  // Non-vacuity, the strong form: the iterable has to answer twice, once for
  // `register` and once for the snapshot, and answer differently. A value
  // frozen in by `Object.assign` or a spread answers once and identically.
  const root = await writePlugin({
    manifest: manifestFor({ contributes: { commands: [{ name: 'cmd', summary: 'declared' }] } }),
    index:
      `let passes = 0\n` +
      `const aliases = {\n` +
      `  [Symbol.iterator]() {\n` +
      `    passes += 1\n` +
      `    return (passes === 1 ? ['ok'] : ['ok', 'stolen'])[Symbol.iterator]()\n` +
      `  },\n` +
      `}\n` +
      `export async function activate(ctx) {\n` +
      `  const run = async () => 0\n` +
      `  ctx.commands.register({ name: 'cmd', plugin: '${PLUGIN}', summary: 'declared', usage: 'u', aliases, run })\n` +
      `  if (passes !== 1) throw new Error('the registry did not drain the iterable: the fixture is vacuous')\n` +
      `  globalThis.__doctorAliasPasses = () => passes\n` +
      `}\n`,
  })

  /** @type {DoctorReport | undefined} */
  let report
  await stderrTextFrom(async () => {
    report = await diagnosePlugin(root)
  })
  assert.ok(report, 'diagnosePlugin returned nothing')
  // @ts-ignore - the fixture parks its counter here
  assert.equal(globalThis.__doctorAliasPasses(), 2, 'the iterable answered only once: the fixture is vacuous')
  assert.deepEqual(
    ofKind(report.diagnostics, 'contribution_unreadable').map((d) => ({ location: d.location, message: d.message })),
    [
      {
        location: '/contributes/commands',
        message: `a registered command alias claiming 'stolen' is not registered under it; left out of the report`,
      },
    ]
  )
  // The command itself registered fine, so the diff below stays silent.
  assert.deepEqual(ofKind(report.diagnostics, 'contribution_not_registered'), [])
})

test('the bundled set refuses nothing, so its reports are the ones it had', async () => {
  // The equivalence half. Nothing in the shipped surface trips a refusal, so
  // `refused` is empty everywhere, no `contribution_unreadable` is emitted, and
  // `checkContributions` takes exactly the branch it took before for every
  // declared name. Observed on the tree this landed on: 24 plugins, 35
  // commands, 17 aliases. Floors rather than fixtures of those totals, the way
  // the sibling containment suite keeps them: the point is that the report did
  // not quietly empty out.
  const workspace = path.join(REPO_ROOT, 'hypaware-core/plugins-workspace')
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
  for (const dir of dirs) {
    const loaded = await loadManifest(path.join(workspace, dir))
    if (!loaded.ok) continue
    const pluginDir = path.join(workspace, dir)
    const dry = await dryRunActivate(loaded.manifest, pluginDir, { knownCapabilities })
    assert.deepEqual(dry.refused, [], `${dir}: the snapshot refused something`)
    const report = await diagnosePlugin(pluginDir, { knownCapabilities })
    assert.deepEqual(ofKind(report.diagnostics, 'contribution_unreadable'), [], `${dir}: an unreadable finding`)
    commands += dry.registered.commands.length
    for (const detail of dry.registered.commandDetails) aliases += detail.aliases.length
  }
  assert.ok(dirs.length >= 20, `only ${dirs.length} bundled plugins`)
  assert.ok(commands >= 30, `only ${commands} bundled commands survived the snapshot`)
  assert.ok(aliases >= 15, `only ${aliases} bundled aliases survived the snapshot`)
})
