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
import { REQUIRES_UNSATISFIED_ERROR_KIND, recordFailedPlugins } from '../../src/core/daemon/boot_failure.js'

// Issue #1580. `recordFailedPlugins` walked `bootKernel`'s `activations` only,
// and three of the four doors into `unavailablePlugins` never produce an
// activation record at all. A plugin the dependency resolver eliminated for an
// unsatisfied `requires` therefore reached no operator surface: `hyp status`
// printed it under `active plugins`, unmarked, with `overall: healthy`, on the
// same install where `hyp plugin list` said the boot did not activate it.
//
// So the daemon runs here for real, on the shipped defaults - HYP_DEV_TELEMETRY
// and OTEL_EXPORTER_OTLP_ENDPOINT deleted from the child's environment - and the
// assertions read what an operator reads: `daemon.log`, and the stdout of `hyp
// status` and `hyp plugin list` run as real CLI processes against the running
// install.
//
// The daemon runs outside the test runner and reports through a file, for the
// reason `gateway-boot-failure-status.test.js` does (#1527): `runGatewayDaemon`
// forks `processor.js` with this process's stdout inherited, which inside a
// `node --test` worker is the runner's own report channel.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** @param {string} rel */
function moduleUrl(rel) {
  return pathToFileURL(path.join(REPO_ROOT, rel)).href
}

const QUIET_ENTRYPOINT = [
  'export async function activate(ctx) {',
  '  ctx.commands.register({',
  "    name: 'acme-quiet',",
  "    plugin: '@acme/quiet',",
  "    summary: 'fixture command',",
  "    usage: 'acme-quiet',",
  '    async run() { return 0 },',
  '  })',
  '}',
  '',
].join('\n')

// The plugin under test never runs. `activate()` throwing here would be the
// *other* door, so it is written to fail loudly if the resolver ever lets it
// through: a fixture that quietly activated would make this test agree with
// itself.
const NEEDY_ENTRYPOINT = [
  'export async function activate() {',
  "  throw new Error('fixture invariant: @acme/needy must never reach activate()')",
  '}',
  '',
].join('\n')

// Not installed, not configured, not bundled: `resolveDependencies` sees no
// manifest for it and eliminates `@acme/needy` before activation is attempted.
const MISSING_DEPENDENCY = '@acme/absent'
const NEEDY_MANIFEST = { requires: { plugins: { [MISSING_DEPENDENCY]: '^1.0.0' } } }

/**
 * Materialise an installed-plugin fixture under `<hypHome>/hypaware/plugins`,
 * the way `plugin-activation-failure-status.test.js` does: what
 * `hyp plugin install` lands on disk, without running the install pipeline.
 *
 * @param {{ hypHome: string, name: string, entrypoint: string, manifest?: object }} args
 * @returns {Promise<{ name: string, version: string, installDir: string }>}
 */
async function stageInstalledPlugin({ hypHome, name, entrypoint, manifest }) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', name)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name,
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    ...manifest,
  }, null, 2))
  await fs.writeFile(path.join(installDir, 'index.js'), entrypoint)
  return { name, version: '1.0.0', installDir }
}

/**
 * A home whose config names third-party plugins only. No gateway, so the
 * gateway process comes up `disabled` and still supervises the processing
 * child, which is where a configured plugin activates.
 *
 * @param {{ needy?: boolean }} args
 * @returns {Promise<{ hypHome: string, stateRoot: string, configPath: string }>}
 */
async function makeHome({ needy = false }) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-requires-unsatisfied-'))
  /** @type {Array<{ name: string, version: string, installDir: string }>} */
  const staged = [await stageInstalledPlugin({
    hypHome,
    name: '@acme/quiet',
    entrypoint: QUIET_ENTRYPOINT,
  })]
  if (needy) {
    staged.push(await stageInstalledPlugin({
      hypHome,
      name: '@acme/needy',
      entrypoint: NEEDY_ENTRYPOINT,
      manifest: NEEDY_MANIFEST,
    }))
  }
  /** @type {Record<string, any>} */
  const plugins = {}
  for (const entry of staged) {
    plugins[entry.name] = {
      name: entry.name,
      version: entry.version,
      source: { kind: 'local-dir', raw: entry.installDir, path: entry.installDir },
      install_dir: entry.installDir,
      content_hash: 'a'.repeat(64),
      manifest_hash: 'b'.repeat(64),
      installed_at: '2026-09-08T00:00:00.000Z',
    }
  }
  await writeLock(path.join(hypHome, 'hypaware'), { schema_version: 1, plugins })

  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    plugins: staged.map((entry) => ({ name: entry.name })),
  }))
  return { hypHome, stateRoot: path.join(hypHome, 'hypaware'), configPath }
}

// The gateway's aggregate carries a reported processing child. The child's
// `failedPlugins` reach this same file in the very `refreshStatus` pass that
// first reports the child's pid, so this waits for exactly the write the
// assertions read - there is no later tick to sleep for.
const CHILD_REPORTED = 'snapshot?.processes?.processing?.pid && snapshot.processes.processing.state !== undefined'
  + " && (snapshot.processes.processing.state !== 'degraded' || snapshot.failedPlugins)"

/**
 * Boot one daemon against `hypHome` on the shipped defaults, wait for the
 * processing child to report, then - while it is still up - run `hyp status`
 * and `hyp plugin list` as real CLI processes against the same install and
 * collect the report in-process. A snapshot left by an exited daemon is a
 * record, not a claim about now (LLP 0383), so everything here is read from a
 * running one.
 *
 * @param {{ hypHome: string, configPath: string, runId: string }} opts
 * @returns {{ booted: boolean, bootError: string | null, stopError: string | null, waited: boolean, report: any, snapshot: any, statusText: string, pluginListText: string }}
 */
function runDaemonOutsideTestRunner({ hypHome, configPath, runId }) {
  const scriptPath = path.join(hypHome, 'daemon-run.mjs')
  const resultPath = path.join(hypHome, 'daemon-run.json')
  const errPath = path.join(hypHome, 'daemon-run.err')
  const stateRoot = path.join(hypHome, 'hypaware')
  const binPath = path.join(REPO_ROOT, 'bin', 'hypaware.js')
  const daemonOpts = { hypHome, configPath, runId, tickIntervalMs: 0, installSignalHandlers: false }
  writeFileSync(scriptPath, [
    "import fs from 'node:fs'",
    "import { spawnSync } from 'node:child_process'",
    `import { runGatewayDaemon } from ${JSON.stringify(moduleUrl('src/core/daemon/gateway.js'))}`,
    `import { collectHypAwareStatus, readStatusFile } from ${JSON.stringify(moduleUrl('src/core/daemon/status.js'))}`,
    'const result = { booted: false, bootError: null, stopError: null, waited: false, report: null, snapshot: null, statusText: "", pluginListText: "" }',
    'let handle',
    'try {',
    `  handle = await runGatewayDaemon({ ...${JSON.stringify(daemonOpts)}, env: { ...process.env } })`,
    '  result.booted = true',
    '} catch (error) {',
    '  result.bootError = error instanceof Error ? error.message : String(error)',
    '}',
    'if (handle) {',
    '  const deadline = Date.now() + 45000',
    '  while (Date.now() < deadline) {',
    `    const snapshot = readStatusFile(${JSON.stringify(stateRoot)})`,
    `    if (${CHILD_REPORTED}) {`,
    '      result.waited = true',
    '      break',
    '    }',
    '    await new Promise(resolve => setTimeout(resolve, 200))',
    '  }',
    `  result.snapshot = readStatusFile(${JSON.stringify(stateRoot)})`,
    // The two operator surfaces the issue says must agree, read off the same
    // running install by the real CLI rather than by calling a renderer.
    `  const cliEnv = { ...process.env, HYP_HOME: ${JSON.stringify(hypHome)}, HYP_CONFIG: ${JSON.stringify(configPath)} }`,
    `  const statusRun = spawnSync(process.execPath, [${JSON.stringify(binPath)}, 'status'], { env: cliEnv, encoding: 'utf8' })`,
    '  result.statusText = String(statusRun.stdout ?? "")',
    `  const listRun = spawnSync(process.execPath, [${JSON.stringify(binPath)}, 'plugin', 'list'], { env: cliEnv, encoding: 'utf8' })`,
    '  result.pluginListText = String(listRun.stdout ?? "")',
    '  result.report = await collectHypAwareStatus({',
    `    env: { ...process.env, HYP_HOME: ${JSON.stringify(hypHome)}, HYP_CONFIG: '' },`,
    "    platform: 'linux',",
    `    homeDir: ${JSON.stringify(hypHome)},`,
    '  })',
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
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, HOME: hypHome, HYP_HOME: hypHome, HYP_CONFIG: '' }
  delete env.HYP_DEV_TELEMETRY
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  let run
  try {
    run = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'ignore', errFd],
      timeout: 120_000,
    })
  } finally {
    closeSync(errFd)
  }
  const stderr = readFileSync(errPath, 'utf8')
  assert.equal(run.signal, null, `the daemon never ended, so nothing was recorded: ${stderr}`)
  assert.equal(run.status, 0, stderr)
  return JSON.parse(readFileSync(resultPath, 'utf8'))
}

/**
 * Every `daemon.log` this install keeps: the gateway process writes one, and
 * the processing child (where configured plugins activate) writes its own
 * under `processing/`. `recent_error_count` already counts both (LLP 0349).
 *
 * @param {string} stateRoot
 * @returns {Promise<object[]>}
 */
async function readDaemonLogRecords(stateRoot) {
  const files = [
    path.join(stateRoot, 'logs', 'daemon.log'),
    path.join(stateRoot, 'processing', 'logs', 'daemon.log'),
  ]
  /** @type {object[]} */
  const records = []
  for (const file of files) {
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch { /* a partially flushed final line is not a record */ }
    }
  }
  return records
}

test('a plugin the dependency resolver eliminated is named by hyp status, which agrees with hyp plugin list', async () => {
  const home = await makeHome({ needy: true })
  try {
    const run = runDaemonOutsideTestRunner({
      hypHome: home.hypHome,
      configPath: home.configPath,
      runId: 'requires-unsatisfied-test',
    })
    assert.equal(run.bootError, null, 'fixture invariant: the gateway process must boot')
    assert.equal(run.waited, true, 'fixture invariant: the processing child must report before status is read')

    // Surface one: the file log every install keeps, under an event name of its
    // own - this plugin did not fail to activate, it never got to.
    const records = await readDaemonLogRecords(home.stateRoot)
    const logged = /** @type {any} */ (records.find((r) => /** @type {any} */ (r).event === 'daemon.plugin_requires_unsatisfied'))
    assert.ok(logged, `the elimination went unrecorded in daemon.log: ${JSON.stringify(records.map((r) => /** @type {any} */ (r).event))}`)
    assert.equal(logged.level, 'error')
    assert.equal(logged.plugin, '@acme/needy')
    assert.equal(logged.error_kind, 'plugin_missing')
    assert.match(logged.message, new RegExp(MISSING_DEPENDENCY))
    assert.equal(
      records.find((r) => /** @type {any} */ (r).event === 'daemon.plugin_activate_failed'),
      undefined,
      'nothing threw, so nothing may be recorded as a throw'
    )

    // Surface two: what `hyp status` tells the operator while the daemon runs.
    const report = run.report
    const diag = report.diagnostics.find((/** @type {any} */ d) => d.kind === 'plugin_requires_unsatisfied')
    assert.ok(diag, `hyp status raised nothing: ${JSON.stringify(report.diagnostics.map((/** @type {any} */ d) => d.kind))}`)
    assert.equal(diag.severity, 'error')
    assert.match(diag.message, /@acme\/needy/)
    // The resolver's own kind and its detail, which is the only place the
    // operator learns *what* is missing.
    assert.ok(diag.message.includes(`plugin_missing: requires plugin ${MISSING_DEPENDENCY}@^1.0.0`), diag.message)
    assert.ok(diag.message.endsWith('none of its sources or sinks are running'), diag.message)
    // Not the throw's repair: no log line holds more than the message above,
    // and a restart re-resolves the same unsatisfiable set.
    assert.equal(
      report.diagnostics.find((/** @type {any} */ d) => d.kind === 'plugin_activate_failed'),
      undefined,
      'the elimination must not be reported as a failed activate()'
    )
    assert.deepEqual(diag.repair, [
      `enable what the reason names, or remove '@acme/needy', in ${home.configPath}`,
      'hyp daemon restart  # requires are resolved at boot',
    ])
    assert.equal(report.overall, 'degraded', 'a configured plugin that is not running is not a healthy install')
    assert.ok(report.recentErrorCount >= 1, 'the elimination is not counted among recent errors')

    // `activePlugins` keeps its meaning: it is the configured set, and the
    // plugin was configured. The marker, not the omission, is what makes the
    // line honest - filtering it out would make `hyp status` advise
    // `hyp client detach` on a client the operator did configure.
    assert.ok(report.activePlugins.includes('@acme/needy'), 'the configured set must still name it')
    assert.deepEqual(report.failedPlugins, ['@acme/needy'])
    assert.ok(report.activePlugins.includes('@acme/quiet'), 'the plugins that did activate are unaffected')
    // The gateway profile withholds every non-routing plugin by design, so the
    // withheld door must never reach this list: `@acme/quiet` activated in the
    // child and is absent from the gateway's boot entirely.
    assert.ok(!report.failedPlugins.includes('@acme/quiet'), 'a plugin the gateway profile withheld is not a shortfall')

    // Surface three: the rendered CLI, which is where a human reads both.
    assert.match(run.statusText, /overall: {2}degraded/)
    assert.match(run.statusText, /- @acme\/needy {2}\[did not activate\]/)
    assert.match(run.statusText, /plugin_requires_unsatisfied/)
    // And the two surfaces agree on the same install, which is the whole point
    // of the issue: `hyp plugin list` already said the boot did not activate it.
    assert.match(run.pluginListText, /Plugins this boot did not activate:/)
    assert.match(run.pluginListText, /@acme\/needy/)
  } finally {
    await fs.rm(home.hypHome, { recursive: true, force: true })
  }
})

/**
 * The status file with everything that legitimately differs between two runs
 * removed: pids, clocks, the run id, and the temporary home in every path.
 *
 * @param {any} snapshot
 * @param {string} hypHome
 * @returns {string}
 */
function scrubSnapshot(snapshot, hypHome) {
  const json = JSON.stringify(snapshot)
    .split(hypHome).join('<HOME>')
  return JSON.stringify(JSON.parse(json, (key, value) => {
    if (key === 'pid' || key === 'uptimeMs') return '<VOLATILE>'
    if (key === 'runId' || key === 'startedAt' || key === 'stoppedAt') return '<VOLATILE>'
    if (key === 'healthyAt' || key === 'lastHeartbeatAt') return '<VOLATILE>'
    return value
  }))
}

// The honest path, unchanged. Recorded from a clean boot on `origin/master`
// (4ea337e8) with the same fixture and the same scrub, so this fails if the
// wider list ever leaks a term into a boot that came up whole.
const CLEAN_BOOT_SNAPSHOT = JSON.stringify({
  state: 'healthy',
  pid: '<VOLATILE>',
  startedAt: '<VOLATILE>',
  healthyAt: '<VOLATILE>',
  uptimeMs: '<VOLATILE>',
  runId: '<VOLATILE>',
  mode: 'foreground',
  sources: [],
  sinks: [],
  warnings: [],
  processes: {
    gateway: { pid: '<VOLATILE>', state: 'disabled' },
    processing: { pid: '<VOLATILE>', state: 'healthy', restarts: 0 },
  },
  configPath: '<HOME>/hypaware-config.json',
})

test('a boot where every configured plugin came up writes the status file it always wrote', async () => {
  const home = await makeHome({ needy: false })
  try {
    const run = runDaemonOutsideTestRunner({
      hypHome: home.hypHome,
      configPath: home.configPath,
      runId: 'requires-clean-test',
    })
    assert.equal(run.bootError, null, 'fixture invariant: the gateway process must boot')
    assert.equal(run.waited, true, 'fixture invariant: the processing child must report before status is read')

    assert.equal(run.snapshot.failedPlugins, undefined, 'a clean boot writes no failure list at all')
    assert.equal(scrubSnapshot(run.snapshot, home.hypHome), CLEAN_BOOT_SNAPSHOT)

    const records = await readDaemonLogRecords(home.stateRoot)
    for (const event of ['daemon.plugin_activate_failed', 'daemon.plugin_requires_unsatisfied']) {
      assert.equal(
        records.find((r) => /** @type {any} */ (r).event === event),
        undefined,
        `a clean boot must not write ${event}`
      )
    }

    const report = run.report
    assert.deepEqual(report.failedPlugins, [])
    assert.equal(report.overall, 'healthy')
    assert.deepEqual(
      report.diagnostics.filter((/** @type {any} */ d) => d.kind.startsWith('plugin_')),
      []
    )
    assert.doesNotMatch(run.statusText, /did not activate/)
  } finally {
    await fs.rm(home.hypHome, { recursive: true, force: true })
  }
})

// The two doors are recorded by one function, off two lists that overlap in
// ways a real daemon cannot easily be driven into. These pin the rules the
// diagnostic's honesty rests on.

/** A file log that keeps what it was told, so the records can be asserted. */
function recordingLog() {
  /** @type {Array<{ event: string, attrs: any }>} */
  const entries = []
  return {
    entries,
    /** @type {any} */
    log: { error: (/** @type {string} */ event, /** @type {any} */ attrs) => { entries.push({ event, attrs }) } },
  }
}

/** @param {string} name */
function activation(name) {
  return { ok: /** @type {const} */ (true), plugin: { name, version: '1.0.0', rootDir: '/x' } }
}

test('recordFailedPlugins keeps the two doors apart', () => {
  const { log, entries } = recordingLog()
  const failed = recordFailedPlugins({
    activations: /** @type {any} */ ([
      activation('@acme/ok'),
      { ok: false, plugin: { name: '@acme/thrower' }, errorKind: 'activate_failed', message: 'boom' },
    ]),
    unsatisfied: /** @type {any} */ ([
      { plugin: '@acme/needy', errorKind: 'plugin_missing', detail: 'requires plugin @acme/absent@^1.0.0' },
    ]),
    log,
  })
  assert.deepEqual(failed, [
    { name: '@acme/thrower', errorKind: 'activate_failed', message: 'boom' },
    {
      name: '@acme/needy',
      errorKind: REQUIRES_UNSATISFIED_ERROR_KIND,
      message: 'plugin_missing: requires plugin @acme/absent@^1.0.0',
    },
  ])
  assert.deepEqual(entries.map((e) => e.event), [
    'daemon.plugin_activate_failed',
    'daemon.plugin_requires_unsatisfied',
  ])
})

test('recordFailedPlugins reports no plugin the resolver named but did not eliminate', () => {
  const { log, entries } = recordingLog()
  // What `cap_version_clash` looks like: recorded against every provider of the
  // clashing capability, eliminating none of them. Both activated, so neither
  // is a plugin that is not running, and a diagnostic naming one would be false.
  const failed = recordFailedPlugins({
    activations: /** @type {any} */ ([activation('@acme/one'), activation('@acme/two')]),
    unsatisfied: /** @type {any} */ ([
      { plugin: '@acme/one', errorKind: 'cap_version_clash', detail: 'capability=x providers=@acme/one,@acme/two' },
      { plugin: '@acme/two', errorKind: 'cap_version_clash', detail: 'capability=x providers=@acme/one,@acme/two' },
    ]),
    log,
  })
  assert.deepEqual(failed, [])
  assert.deepEqual(entries, [])
})

test('recordFailedPlugins reports the require that eliminated a plugin, not a clash that did not', () => {
  const { log, entries } = recordingLog()
  // The resolver pushes every clash before it walks the topo order, so a
  // provider that clashes *and* is eliminated carries the clash first. Reading
  // the first entry would print a reason that eliminated nothing, leave the
  // require that did unnamed, and send the repair at the wrong config line.
  const failed = recordFailedPlugins({
    activations: [],
    unsatisfied: /** @type {any} */ ([
      { plugin: '@acme/one', errorKind: 'cap_version_clash', detail: 'capability=acme.enc providers=@acme/one,@acme/two' },
      { plugin: '@acme/two', errorKind: 'cap_version_clash', detail: 'capability=acme.enc providers=@acme/one,@acme/two' },
      { plugin: '@acme/one', errorKind: 'cap_missing', detail: 'capability acme.blob@^1.0.0' },
      { plugin: '@acme/two', errorKind: 'cap_missing', detail: 'capability acme.blob@^1.0.0' },
    ]),
    log,
  })
  assert.deepEqual(failed, [
    { name: '@acme/one', errorKind: REQUIRES_UNSATISFIED_ERROR_KIND, message: 'cap_missing: capability acme.blob@^1.0.0' },
    { name: '@acme/two', errorKind: REQUIRES_UNSATISFIED_ERROR_KIND, message: 'cap_missing: capability acme.blob@^1.0.0' },
  ])
  assert.deepEqual(entries.map((e) => e.attrs.error_kind), ['cap_missing', 'cap_missing'])
})

test('recordFailedPlugins records a plugin missing several requires once', () => {
  const { log, entries } = recordingLog()
  const failed = recordFailedPlugins({
    activations: [],
    unsatisfied: /** @type {any} */ ([
      { plugin: '@acme/needy', errorKind: 'plugin_missing', detail: 'requires plugin @acme/a@^1.0.0' },
      { plugin: '@acme/needy', errorKind: 'plugin_missing', detail: 'requires plugin @acme/b@^1.0.0' },
    ]),
    log,
  })
  assert.equal(failed.length, 1)
  assert.equal(failed[0].message, 'plugin_missing: requires plugin @acme/a@^1.0.0')
  assert.equal(entries.length, 1)
})
