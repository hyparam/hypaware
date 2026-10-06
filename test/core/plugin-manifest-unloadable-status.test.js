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

import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

// Issue #1576. A plugin directory whose manifest will not load contributes
// nothing and has no plugin name to be known by, so `bootKernel` records it in
// `unavailablePlugins` as the directory it failed in. No operator surface
// named it: `hyp status` had no diagnostic for it (the #1556 collector reads
// `failedPlugins`, which is built from activation records, and a manifest that
// never loaded never reaches `activatePlugins`), and `hyp plugin list`
// deliberately will not invent a name for a path (issue #1570). The only
// record was a boot log line written through `getLogger`, which on a shipped
// install has no exporter attached.
//
// So every daemon run below is a real daemon on the shipped defaults, the way
// `plugin-activation-failure-status.test.js` runs its own: `HYP_DEV_TELEMETRY`
// is deleted from the child's environment, and the assertions read the two
// surfaces a production install keeps - `daemon.log` and what
// `collectHypAwareStatus` reports while the daemon is up.
//
// The daemon runs outside the test runner because `runGatewayDaemon` forks
// `processor.js` with this process's stdout inherited, which inside a
// `node --test` worker is the runner's own report channel.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** @param {string} rel */
function moduleUrl(rel) {
  return pathToFileURL(path.join(REPO_ROOT, rel)).href
}

// Not valid JSON at all: the corrupt half of "corrupt, unparseable, or failing
// schema validation". The schema-validation half is covered by `SHORT_MANIFEST`
// below, so both rejection wordings `loadManifest` produces are exercised.
const CORRUPT_MANIFEST = '{ "schema_version": 1, "name": "@acme/corrupt"'

// Valid JSON that `validateManifest` rejects. The other door into the same
// `failed` bin, and the one that proves the reason is carried rather than
// assumed: only the manifest's own rejection sentence can say which field.
const SHORT_MANIFEST = JSON.stringify({
  schema_version: 1,
  name: '@acme/short',
  version: '1.0.0',
  runtime: 'node',
  entrypoint: './index.js',
}, null, 2)

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

// The #1556 case, verbatim from its own fixture: a plugin whose manifest loads
// and whose `activate()` throws. Present so this change can be shown not to
// have altered what that case renders.
const THROWN_MESSAGE =
  "acme thrower: cannot find module '/opt/hypaware/plugins/@acme/thrower/lib/missing-helper.js'"
  + " imported from '/opt/hypaware/plugins/@acme/thrower/index.js'"

const THROWING_ENTRYPOINT = [
  'export async function activate() {',
  `  throw new Error(${JSON.stringify(THROWN_MESSAGE)})`,
  '}',
  '',
].join('\n')

/**
 * Materialise an installed-plugin fixture under `<hypHome>/hypaware/plugins`:
 * what `hyp plugin install` lands on disk, without running the install
 * pipeline. `manifestText` is written verbatim so a fixture can put a manifest
 * there that will not load.
 *
 * @param {{ hypHome: string, name: string, entrypoint: string, manifestText?: string }} args
 * @returns {Promise<{ name: string, version: string, installDir: string }>}
 */
async function stageInstalledPlugin({ hypHome, name, entrypoint, manifestText }) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', name)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), manifestText ?? JSON.stringify({
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
 * child.
 *
 * `@acme/quiet` always loads and always activates: it is the plugin this
 * change must leave alone.
 *
 * @param {{ broken?: boolean, thrower?: boolean }} args
 * @returns {Promise<{ hypHome: string, stateRoot: string, configPath: string, corruptDir: string, shortDir: string }>}
 */
async function makeHome({ broken = false, thrower = false }) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-manifest-unloadable-'))
  /** @type {Array<{ name: string, version: string, installDir: string }>} */
  const staged = [await stageInstalledPlugin({
    hypHome,
    name: '@acme/quiet',
    entrypoint: QUIET_ENTRYPOINT,
  })]
  let corruptDir = ''
  let shortDir = ''
  if (broken) {
    corruptDir = (await stageInstalledPlugin({
      hypHome,
      name: '@acme/corrupt',
      entrypoint: 'export async function activate() {}\n',
      manifestText: CORRUPT_MANIFEST,
    })).installDir
    shortDir = (await stageInstalledPlugin({
      hypHome,
      name: '@acme/short',
      entrypoint: 'export async function activate() {}\n',
      manifestText: SHORT_MANIFEST,
    })).installDir
  }
  if (thrower) {
    staged.push(await stageInstalledPlugin({
      hypHome,
      name: '@acme/thrower',
      entrypoint: THROWING_ENTRYPOINT,
    }))
  }
  /** @type {Record<string, any>} */
  const plugins = {}
  /** @param {string} name @param {string} installDir */
  const lockEntry = (name, installDir) => ({
    name,
    version: '1.0.0',
    source: { kind: 'local-dir', raw: installDir, path: installDir },
    install_dir: installDir,
    content_hash: 'a'.repeat(64),
    manifest_hash: 'b'.repeat(64),
    installed_at: '2026-09-08T00:00:00.000Z',
  })
  for (const entry of staged) plugins[entry.name] = lockEntry(entry.name, entry.installDir)
  // The unloadable pair are in the lock exactly as a real install leaves them:
  // `hyp plugin install` wrote the entry, and the manifest went bad afterwards
  // (a truncated write, a partial upgrade, a hand edit).
  if (broken) {
    plugins['@acme/corrupt'] = lockEntry('@acme/corrupt', corruptDir)
    plugins['@acme/short'] = lockEntry('@acme/short', shortDir)
  }
  await writeLock(path.join(hypHome, 'hypaware'), { schema_version: 1, plugins })

  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    plugins: staged.map((entry) => ({ name: entry.name })),
  }))
  return { hypHome, stateRoot: path.join(hypHome, 'hypaware'), configPath, corruptDir, shortDir }
}

// The gateway's aggregate carries a reported processing child, and (when the
// child is not yet ready) the failed-plugin list it aggregates: the same
// condition `plugin-activation-failure-status.test.js` waits on, so the #1556
// half of this test reads a settled snapshot rather than the first one written.
const CHILD_REPORTED = 'snapshot?.processes?.processing?.pid && snapshot.processes.processing.state !== undefined'
  + " && (snapshot.processes.processing.state !== 'degraded' || snapshot.failedPlugins)"

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
  // the kernel's `getLogger` record would reach `dev-telemetry/` and the defect
  // would be invisible to this test.
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
 * the processing child writes its own under `processing/`.
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

test('a plugin directory whose manifest will not load is named, with its reason, on the surfaces a shipped install keeps', async () => {
  const home = await makeHome({ broken: true, thrower: true })
  try {
    const run = runDaemonOutsideTestRunner({
      hypHome: home.hypHome,
      configPath: home.configPath,
      runId: 'manifest-unloadable-test',
    })
    assert.equal(run.bootError, null, 'fixture invariant: the gateway process must boot')
    assert.equal(run.waited, true, 'fixture invariant: the processing child must report before status is read')

    // Surface one: the file log, which `openDaemonLog` writes on every boot in
    // every mode and which `recent_error_count` counts (LLP 0349). The
    // directory, never a name, and the reason whole.
    const records = await readDaemonLogRecords(home.stateRoot)
    const logged = records.filter((r) => /** @type {any} */ (r).event === 'daemon.plugin_manifest_unloadable')
    const loggedDirs = logged.map((r) => /** @type {any} */ (r).root_dir)
    assert.ok(
      loggedDirs.includes(home.corruptDir) && loggedDirs.includes(home.shortDir),
      `the unloadable manifests went unrecorded in daemon.log: ${JSON.stringify(records.map((r) => /** @type {any} */ (r).event))}`
    )
    for (const record of logged) assert.equal(/** @type {any} */ (record).level, 'error')
    const corruptLog = logged.find((r) => /** @type {any} */ (r).root_dir === home.corruptDir)
    assert.match(/** @type {any} */ (corruptLog).message, /manifest is not valid JSON/)

    // Surface two: what `hyp status` tells the operator while the daemon runs.
    const report = run.report
    const diags = report.diagnostics.filter((/** @type {any} */ d) => d.kind === 'plugin_manifest_unloadable')
    assert.equal(diags.length, 2, `hyp status raised nothing for the unloadable manifests: ${JSON.stringify(report.diagnostics.map((/** @type {any} */ d) => d.kind))}`)
    const corrupt = diags.find((/** @type {any} */ d) => d.message.includes(home.corruptDir))
    const short = diags.find((/** @type {any} */ d) => d.message.includes(home.shortDir))
    assert.ok(corrupt, `no diagnostic names ${home.corruptDir}: ${JSON.stringify(diags)}`)
    assert.ok(short, `no diagnostic names ${home.shortDir}: ${JSON.stringify(diags)}`)
    assert.equal(corrupt.severity, 'error')
    // The reason, not just the fact: without it the operator is sent back to
    // the boot log, which is the state this issue is about. Each directory
    // carries its own rejection, so the two wordings must not be interchanged.
    assert.match(corrupt.message, /manifest is not valid JSON/)
    assert.match(short.message, /hypaware_api \(string semver range\) is required/)
    assert.equal(corrupt.repair.length, 2)
    assert.equal(
      corrupt.repair[0],
      `grep -s plugin_manifest_unloadable ${path.join(home.stateRoot, 'logs', 'daemon.log')}`
    )
    assert.equal(corrupt.repair[1], 'hyp daemon restart  # manifests are read at boot')
    assert.equal(report.overall, 'degraded', 'a plugin directory that is capturing nothing is not a healthy install')

    // Directory-shaped, not name-shaped. `failedPlugins` is the plugin-name
    // list PR #1575 kept honest, and a `rootDir` must never appear in it.
    assert.deepEqual(report.failedPlugins, ['@acme/thrower'])

    // The #1556 case, unchanged: the plugin that loaded and threw still renders
    // exactly the diagnostic that PR shipped, repair pair included.
    const activateFailed = report.diagnostics.filter((/** @type {any} */ d) => d.kind === 'plugin_activate_failed')
    assert.equal(activateFailed.length, 1)
    assert.equal(activateFailed[0].severity, 'error')
    assert.ok(activateFailed[0].message.includes(THROWN_MESSAGE), `the reason was truncated: ${activateFailed[0].message}`)
    assert.match(activateFailed[0].message, /^plugin '@acme\/thrower' failed to activate \(activate_failed\): /)
    assert.match(activateFailed[0].message, / - none of its sources or sinks are running$/)
    assert.equal(activateFailed[0].repair.length, 2)
    assert.match(activateFailed[0].repair[0], /^grep -s plugin_activate_failed /)
    assert.equal(activateFailed[0].repair[1], 'hyp daemon restart')

    // The plugin that loaded and activated is untouched, and no diagnostic
    // mentions it.
    assert.ok(report.activePlugins.includes('@acme/quiet'), 'the plugin that did activate is unaffected')
    assert.equal(
      report.diagnostics.find((/** @type {any} */ d) => d.message.includes('@acme/quiet')),
      undefined,
      'a plugin that loaded and activated must raise nothing'
    )

    // Both renderings carry it. The human plane prints kind, message and every
    // repair line; the machine plane passes the diagnostic through whole.
    const chunks = /** @type {string[]} */ ([])
    renderStatusText({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(home.stateRoot, 'cache'),
      stdout: /** @type {any} */ ({ write: (/** @type {string} */ s) => { chunks.push(s) } }),
    })
    const text = chunks.join('')
    assert.ok(
      text.includes(`[ERROR] plugin_manifest_unloadable: ${corrupt.message}`),
      `the human rendering does not name the directory: ${text}`
    )
    assert.ok(text.includes(`        repair: ${corrupt.repair[0]}\n`), 'the human rendering drops the repair')

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(home.stateRoot, 'cache'),
    })
    const jsonDiag = json.diagnostics.find((/** @type {any} */ d) => d.kind === 'plugin_manifest_unloadable' && d.message.includes(home.corruptDir))
    assert.ok(jsonDiag, `the --json rendering drops the diagnostic: ${JSON.stringify(json.diagnostics)}`)
    assert.deepEqual(jsonDiag.repair, corrupt.repair)
    // And the machine contract PR #1575 protected is intact: no field that
    // holds a plugin name holds a path.
    for (const entry of json.active_plugins) {
      assert.ok(
        !path.isAbsolute(entry.name),
        `a directory leaked into the plugin-name plane: ${entry.name}`
      )
    }
  } finally {
    await fs.rm(home.hypHome, { recursive: true, force: true })
  }
})

test('a boot where every manifest loads adds no new noise', async () => {
  const home = await makeHome({ broken: false, thrower: false })
  try {
    const run = runDaemonOutsideTestRunner({
      hypHome: home.hypHome,
      configPath: home.configPath,
      runId: 'manifest-clean-test',
    })
    assert.equal(run.bootError, null, 'fixture invariant: the gateway process must boot')
    assert.equal(run.waited, true, 'fixture invariant: the processing child must report before status is read')

    const records = await readDaemonLogRecords(home.stateRoot)
    assert.equal(
      records.find((r) => /** @type {any} */ (r).event === 'daemon.plugin_manifest_unloadable'),
      undefined,
      'a clean boot must not write a manifest-load failure'
    )

    const report = run.report
    assert.equal(
      report.diagnostics.find((/** @type {any} */ d) => d.kind === 'plugin_manifest_unloadable'),
      undefined,
      'a clean boot must raise no manifest diagnostic'
    )
    assert.deepEqual(report.failedPlugins, [])
    assert.ok(report.activePlugins.includes('@acme/quiet'))
    assert.equal(report.overall, 'healthy')
    // Absent, never `[]`: a boot with nothing to report writes the status file
    // shape it always wrote.
    assert.equal(run.snapshot.unloadableManifests, undefined, 'a clean boot writes the status shape it always wrote')
    assert.equal(run.snapshot.failedPlugins, undefined)
  } finally {
    await fs.rm(home.hypHome, { recursive: true, force: true })
  }
})
