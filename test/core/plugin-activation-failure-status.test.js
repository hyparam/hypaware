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

// Issue #1556. The kernel catches a throwing `activate()` per plugin and boots
// the rest, which is the intended behaviour; what was missing was any record
// of it an operator reads. The loader's `getLogger` record reaches the OTLP
// exporter and `dev-telemetry/`, and a shipped install has neither, so a
// plugin that stopped capturing left `hyp status` reporting `healthy` with the
// plugin still listed and `daemon.log` empty.
//
// So every run below is a real daemon on the shipped defaults: HYP_DEV_TELEMETRY
// is deleted from the child's environment, and the assertions read the two
// surfaces a production install keeps - `daemon.log` and what
// `collectHypAwareStatus` reports while the daemon is up.
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

// Longer than `sanitizeLabel`'s 120-character default, and shaped like the
// commonest real one: a module-resolution error whose operative half is the
// second path. A diagnostic that quotes it at the default width loses exactly
// the part that says which file did the failing import.
const THROWN_MESSAGE =
  "acme thrower: cannot find module '/opt/hypaware/plugins/@acme/thrower/lib/missing-helper.js'"
  + " imported from '/opt/hypaware/plugins/@acme/thrower/index.js'"

const THROWING_ENTRYPOINT = [
  'export async function activate() {',
  `  throw new Error(${JSON.stringify(THROWN_MESSAGE)})`,
  '}',
  '',
].join('\n')

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

/**
 * Materialise an installed-plugin fixture under `<hypHome>/hypaware/plugins`,
 * the way `test/core/boot-installed.test.js` does: what `hyp plugin install`
 * lands on disk, without running the install pipeline.
 *
 * @param {{ hypHome: string, name: string, entrypoint: string }} args
 * @returns {Promise<{ name: string, version: string, installDir: string }>}
 */
async function stageInstalledPlugin({ hypHome, name, entrypoint }) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', name)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name,
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }, null, 2))
  await fs.writeFile(path.join(installDir, 'index.js'), entrypoint)
  return { name, version: '1.0.0', installDir }
}

/**
 * A home whose config names third-party plugins only. No gateway, so the
 * gateway process comes up `disabled` and still supervises the processing
 * child, which is where a configured plugin activates.
 *
 * @param {{ thrower: boolean }} args
 * @returns {Promise<{ hypHome: string, stateRoot: string, configPath: string }>}
 */
async function makeHome({ thrower }) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-activate-failure-'))
  /** @type {Array<{ name: string, version: string, installDir: string }>} */
  const staged = [await stageInstalledPlugin({
    hypHome,
    name: '@acme/quiet',
    entrypoint: QUIET_ENTRYPOINT,
  })]
  if (thrower) {
    staged.push(await stageInstalledPlugin({
      hypHome,
      name: '@acme/thrower',
      entrypoint: THROWING_ENTRYPOINT,
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

/**
 * Boot one daemon against `hypHome` on the shipped defaults, wait for the
 * processing child to report, collect `hyp status` while it is still up, then
 * stop it. The report is collected inside the daemon's own process because the
 * question is what an operator sees on a *running* install: a snapshot left by
 * an exited daemon is a record, not a claim about now (LLP 0383).
 *
 * @param {{ hypHome: string, configPath: string, runId: string }} opts
 * @returns {{ booted: boolean, bootError: string | null, stopError: string | null, waited: boolean, report: any, snapshot: any }}
 */
function runDaemonOutsideTestRunner({ hypHome, configPath, runId }) {
  const scriptPath = path.join(hypHome, 'daemon-run.mjs')
  const resultPath = path.join(hypHome, 'daemon-run.json')
  const errPath = path.join(hypHome, 'daemon-run.err')
  const stateRoot = path.join(hypHome, 'hypaware')
  const daemonOpts = { hypHome, configPath, runId, tickIntervalMs: 0, installSignalHandlers: false }
  writeFileSync(scriptPath, [
    "import fs from 'node:fs'",
    `import { runGatewayDaemon } from ${JSON.stringify(moduleUrl('src/core/daemon/gateway.js'))}`,
    `import { collectHypAwareStatus, readStatusFile } from ${JSON.stringify(moduleUrl('src/core/daemon/status.js'))}`,
    'const result = { booted: false, bootError: null, stopError: null, waited: false, report: null, snapshot: null }',
    'let handle',
    'try {',
    `  handle = await runGatewayDaemon({ ...${JSON.stringify(daemonOpts)}, env: { ...process.env } })`,
    '  result.booted = true',
    '} catch (error) {',
    '  result.bootError = error instanceof Error ? error.message : String(error)',
    '}',
    'if (handle) {',
    // The processing child boots asynchronously behind the gateway, so wait
    // for the gateway's aggregate to carry a reported child before reading.
    '  const deadline = Date.now() + 45000',
    '  while (Date.now() < deadline) {',
    `    const snapshot = readStatusFile(${JSON.stringify(stateRoot)})`,
    '    if (snapshot?.processes?.processing?.pid && snapshot.processes.processing.state !== undefined',
    "        && (snapshot.processes.processing.state !== 'degraded' || snapshot.failedPlugins)) {",
    '      result.waited = true',
    '      break',
    '    }',
    '    await new Promise(resolve => setTimeout(resolve, 200))',
    '  }',
    `  result.snapshot = readStatusFile(${JSON.stringify(stateRoot)})`,
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
  // The shipped default, which is the whole point: with `HYP_DEV_TELEMETRY=1`
  // the loader's record would reach `dev-telemetry/` and the defect would be
  // invisible to this test.
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
 * under `processing/`. `recent_error_count` already counts both.
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

test('a plugin whose activate() throws is reported on the surfaces a shipped install keeps', async () => {
  const home = await makeHome({ thrower: true })
  try {
    const run = runDaemonOutsideTestRunner({
      hypHome: home.hypHome,
      configPath: home.configPath,
      runId: 'activate-failure-test',
    })
    assert.equal(run.bootError, null, 'fixture invariant: the gateway process must boot')
    assert.equal(run.waited, true, 'fixture invariant: the processing child must report before status is read')

    // Surface one: the file log, which `openDaemonLog` writes on every boot in
    // every mode and which `recent_error_count` counts (LLP 0349).
    const records = await readDaemonLogRecords(home.stateRoot)
    const logged = records.find((r) => /** @type {any} */ (r).event === 'daemon.plugin_activate_failed')
    assert.ok(logged, `the activation failure went unrecorded in daemon.log: ${JSON.stringify(records.map((r) => /** @type {any} */ (r).event))}`)
    assert.equal(/** @type {any} */ (logged).level, 'error')
    assert.equal(/** @type {any} */ (logged).plugin, '@acme/thrower')
    assert.equal(/** @type {any} */ (logged).message, THROWN_MESSAGE)

    // Surface two: what `hyp status` tells the operator while the daemon runs.
    const report = run.report
    const diag = report.diagnostics.find((/** @type {any} */ d) => d.kind === 'plugin_activate_failed')
    assert.ok(diag, `hyp status raised nothing: ${JSON.stringify(report.diagnostics.map((/** @type {any} */ d) => d.kind))}`)
    assert.equal(diag.severity, 'error')
    assert.match(diag.message, /@acme\/thrower/)
    // Quoted whole: the reason is the only thing this diagnostic is for.
    assert.ok(diag.message.includes(THROWN_MESSAGE), `the reason was truncated: ${diag.message}`)
    // And the repair is the record that keeps it whole past the clamp, not a
    // plugin listing: `hyp plugin list` prints the plugins the CLI's own boot
    // activated plus the install lock, so a bundled adapter that failed to
    // activate is absent from its output entirely, and an installed one sits
    // under "Installed plugins" with nothing marking it broken. Both log files
    // are named because either process can be the one that could not activate.
    assert.equal(diag.repair.length, 2)
    assert.match(diag.repair[0], /^grep -s plugin_activate_failed /)
    for (const logFile of [
      path.join(home.stateRoot, 'logs', 'daemon.log'),
      path.join(home.stateRoot, 'processing', 'logs', 'daemon.log'),
    ]) {
      assert.ok(diag.repair[0].includes(logFile), `the repair does not name ${logFile}: ${diag.repair[0]}`)
    }
    assert.equal(diag.repair[1], 'hyp daemon restart')
    assert.equal(report.overall, 'degraded', 'a configured plugin that is not running is not a healthy install')

    // And the plugin list stops claiming the plugin is running.
    assert.deepEqual(report.failedPlugins, ['@acme/thrower'])
    assert.ok(report.activePlugins.includes('@acme/quiet'), 'the plugins that did activate are unaffected')

    // The count the operator scans first is not zero either.
    assert.ok(report.recentErrorCount >= 1, 'the failure is not counted among recent errors')
  } finally {
    await fs.rm(home.hypHome, { recursive: true, force: true })
  }
})

test('a boot where every plugin activates adds no new noise', async () => {
  const home = await makeHome({ thrower: false })
  try {
    const run = runDaemonOutsideTestRunner({
      hypHome: home.hypHome,
      configPath: home.configPath,
      runId: 'activate-clean-test',
    })
    assert.equal(run.bootError, null, 'fixture invariant: the gateway process must boot')
    assert.equal(run.waited, true, 'fixture invariant: the processing child must report before status is read')

    const records = await readDaemonLogRecords(home.stateRoot)
    assert.equal(
      records.find((r) => /** @type {any} */ (r).event === 'daemon.plugin_activate_failed'),
      undefined,
      'a clean boot must not write an activation failure'
    )

    const report = run.report
    assert.equal(
      report.diagnostics.find((/** @type {any} */ d) => d.kind === 'plugin_activate_failed'),
      undefined,
      'a clean boot must raise no activation diagnostic'
    )
    assert.deepEqual(report.failedPlugins, [])
    assert.equal(report.overall, 'healthy')
    assert.equal(run.snapshot.failedPlugins, undefined, 'a clean boot writes the status shape it always wrote')
  } finally {
    await fs.rm(home.hypHome, { recursive: true, force: true })
  }
})

// The two daemon runs above cover the plugin that failed in the one process
// that was going to run it. A routing contributor is the other shape: it
// activates in the gateway *and* in the processing child, and the gateway
// hands it a storage proxy that throws on every cache call, so one that reads
// storage in `activate()` fails there and comes up here. Driven off a written
// snapshot rather than a second daemon because the whole question is what the
// collector says about a snapshot holding both facts at once.

/**
 * A live snapshot for this process's pid: the daemon is up and the file is
 * its own, which is the only state the activation diagnostic is raised from.
 *
 * @param {{ hypHome: string, failedPlugins: object[], sources: object[] }} args
 */
async function writeLiveSnapshot({ hypHome, failedPlugins, sources }) {
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(path.join(hypHome, 'hypaware-config.json'), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  const { writePidFile } = await import('../../src/core/daemon/pid.js')
  const { writeStatusFile } = await import('../../src/core/daemon/status.js')
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    pid: process.pid,
    healthyAt: new Date().toISOString(),
    uptimeMs: 0,
    sources,
    sinks: [],
    failedPlugins,
  }))
  return stateRoot
}

/** @param {string} hypHome */
async function collectFrom(hypHome) {
  const { collectHypAwareStatus } = await import('../../src/core/daemon/status.js')
  return collectHypAwareStatus({
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'linux',
    homeDir: hypHome,
    isLaunchAgentInstalled: () => false,
  })
}

test('a plugin that failed in one process and came up in the other is not reported as wholly stopped', async (t) => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-activate-partial-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeLiveSnapshot({
    hypHome,
    failedPlugins: [{ name: '@acme/router', errorKind: 'activate_failed', message: 'gateway process cannot access storage.tableExists' }],
    sources: [{ name: 'acme-router', plugin: '@acme/router', state: 'started' }],
  })
  const report = await collectFrom(hypHome)
  const diag = report.diagnostics.find((/** @type {any} */ d) => d.kind === 'plugin_activate_failed')
  assert.ok(diag, 'the failure must still be reported')
  // The claim the collector must not make: this same report lists the
  // plugin's source as started, so "none of its sources ... are running"
  // would be contradicted two fields away.
  assert.ok(
    !diag.message.includes('none of its sources'),
    `the diagnostic contradicts the source list in its own report: ${diag.message}`
  )
  assert.match(diag.message, /only one of the daemon's two processes/)
})

test('a plugin with nothing left running still says so', async (t) => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-activate-whole-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeLiveSnapshot({
    hypHome,
    failedPlugins: [{ name: '@acme/router', errorKind: 'activate_failed', message: 'boom' }],
    sources: [{ name: 'other', plugin: '@acme/other', state: 'started' }],
  })
  const report = await collectFrom(hypHome)
  const diag = report.diagnostics.find((/** @type {any} */ d) => d.kind === 'plugin_activate_failed')
  assert.ok(diag)
  assert.match(diag.message, / - none of its sources, sinks or commands are running$/)
})
