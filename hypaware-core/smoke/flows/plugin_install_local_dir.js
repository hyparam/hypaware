// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { hashArtifactTree } from '../../../src/core/plugin_install/fetch.js'
import {
  pluginInstallDir,
  pluginLockPath,
} from '../../../src/core/plugin_install/paths.js'

/**
 * Phase 7 smoke. Stages a `dummy-a` fixture plugin in the harness
 * tmpdir (the in-repo equivalent of `hypaware-core/plugins-workspace/dummy-a`
 * once Phase 8 populates the workspace), installs it through the CLI
 * dispatcher with `hyp plugin install <path>`, and verifies the
 * §Phase 7 contract from `hypaware-implementation-plan.md`:
 *
 * - The lock file gained an entry with `source.kind="local-dir"`
 *   and a `content_hash` that matches a re-hash of the install dir.
 * - `hyp plugin list --json` lists the dummy plugin with
 *   `installed_at` set.
 * - A `plugin.install` span emits with `status=ok` and
 *   `hyp_plugin=@hypaware/dummy-a`.
 * - A `plugin.update_check` span emits with `available=false`
 *   (local-dir has no upstream).
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'plugin_install_local_dir: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const workspaceDir = path.join(harness.tmpDir, 'plugins-workspace', 'dummy-a')
  await writeFixturePlugin(workspaceDir)

  const stateDir = harness.stateDir
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({
    commandRegistry: registry,
    cacheRoot: path.join(stateDir, 'cache'),
  })

  // Drive the install through the CLI dispatcher so we exercise the
  // exact path `hyp plugin install ./hypaware-core/plugins-workspace/dummy-a`
  // takes — argv parsing, dispatch span, plugin.install + plugin.update_check
  // span emission, lock writes — in one shot.
  const installStdout = makeBuf()
  const installStderr = makeBuf()
  const installCode = await runRoot(
    'smoke.driver',
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'plugin_install',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () =>
      dispatch(['plugin', 'install', workspaceDir], {
        stdout: installStdout,
        stderr: installStderr,
        env: { ...process.env, HYP_HOME: harness.hypHome },
        cwd: harness.tmpDir,
        registry,
        kernel,
      })
  )
  expect.that('dispatch: plugin install exited 0', installCode, (v) => v === 0)
  expect.that(
    'stderr: plugin install had no errors',
    installStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )
  expect.that(
    'stdout: install summary lists the plugin name',
    installStdout.text(),
    (v) => typeof v === 'string' && v.includes('@hypaware/dummy-a')
  )

  // Re-list through the dispatcher so the `--json` shape is exactly
  // what an external caller would receive.
  const listStdout = makeBuf()
  const listStderr = makeBuf()
  const listCode = await dispatch(['plugin', 'list', '--json'], {
    stdout: listStdout,
    stderr: listStderr,
    env: { ...process.env, HYP_HOME: harness.hypHome },
    cwd: harness.tmpDir,
    registry,
    kernel,
  })
  expect.that('dispatch: plugin list exited 0', listCode, (v) => v === 0)
  expect.that(
    'stderr: plugin list had no errors',
    listStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )

  /** @type {any} */
  let listJson
  try {
    listJson = JSON.parse(listStdout.text())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    expect.that(
      `stdout: plugin list --json was valid JSON (parse error: ${message})`,
      false,
      (v) => v === true
    )
    return
  }
  expect.that(
    'stdout: plugin list --json contains the dummy plugin',
    listJson?.plugins,
    (v) =>
      Array.isArray(v) &&
      v.length === 1 &&
      v[0]?.name === '@hypaware/dummy-a' &&
      typeof v[0]?.installed_at === 'string' &&
      v[0]?.installed_at.length > 0
  )

  // Read the lock straight off disk and validate the entry shape.
  const lockPath = pluginLockPath(stateDir)
  const lockRaw = await fs.readFile(lockPath, 'utf8')
  const lock = JSON.parse(lockRaw)
  expect.that(
    'lock: schema_version is 1',
    lock?.schema_version,
    (v) => v === 1
  )
  const entry = lock?.plugins?.['@hypaware/dummy-a']
  expect.that(
    'lock: contains @hypaware/dummy-a entry',
    entry,
    (v) => v !== undefined
  )
  expect.that(
    'lock: source.kind is local-dir',
    entry?.source?.kind,
    (v) => v === 'local-dir'
  )
  expect.that(
    'lock: install_dir points at the expected install root',
    entry?.install_dir,
    (v) => v === pluginInstallDir(stateDir, '@hypaware/dummy-a')
  )
  expect.that(
    'lock: installed_at is set',
    entry?.installed_at,
    (v) => typeof v === 'string' && v.length > 0
  )

  // Re-hash the install dir to confirm content_hash matches.
  const rehash = await hashArtifactTree(entry.install_dir)
  expect.that(
    'lock: content_hash matches a re-hash of the install dir',
    entry?.content_hash,
    (v) => v === rehash
  )

  expect.that(
    'lock: update.available is false (local-dir has no upstream)',
    entry?.update?.available,
    (v) => v === false
  )

  await obs.shutdown()

  const traces = await expect.traces()
  const installSpans = traces.filter(
    (/** @type {any} */ t) => t.name === 'plugin.install'
  )
  expect.that(
    'traces: exactly one plugin.install span',
    installSpans,
    (rows) => rows.length === 1
  )
  const installSpan = installSpans[0]
  expect.that(
    'traces: plugin.install status=ok',
    installSpan?.attributes?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: plugin.install hyp_plugin=@hypaware/dummy-a',
    installSpan?.attributes?.hyp_plugin,
    (v) => v === '@hypaware/dummy-a'
  )
  expect.that(
    'traces: plugin.install hyp_source_kind=local-dir',
    installSpan?.attributes?.hyp_source_kind,
    (v) => v === 'local-dir'
  )

  const updateChecks = traces.filter(
    (/** @type {any} */ t) => t.name === 'plugin.update_check'
  )
  expect.that(
    'traces: at least one plugin.update_check span',
    updateChecks,
    (rows) => rows.length >= 1
  )
  const dummyCheck = updateChecks.find(
    (/** @type {any} */ s) => s.attributes?.hyp_plugin === '@hypaware/dummy-a'
  )
  expect.that(
    'traces: plugin.update_check for @hypaware/dummy-a exists',
    dummyCheck,
    (v) => v !== undefined
  )
  expect.that(
    'traces: plugin.update_check available=false',
    dummyCheck?.attributes?.available,
    (v) => v === false
  )

  const metrics = await expect.metrics()
  const installCounter = metrics.find(
    (/** @type {any} */ m) =>
      m.name === 'hyp_plugin_installs_total' && m.attributes?.status === 'ok'
  )
  expect.that(
    'metrics: hyp_plugin_installs_total{status=ok} ticked',
    installCounter,
    (v) => v !== undefined
  )
  const updatesGauge = metrics.find(
    (/** @type {any} */ m) =>
      m.name === 'hyp_plugin_updates_available' &&
      m.attributes?.hyp_plugin === '@hypaware/dummy-a'
  )
  expect.that(
    'metrics: hyp_plugin_updates_available emitted for @hypaware/dummy-a',
    updatesGauge,
    (v) => v !== undefined
  )
  expect.that(
    'metrics: hyp_plugin_updates_available value is 0 (local-dir)',
    updatesGauge?.value,
    (v) => v === 0
  )
}

/**
 * Drop a minimal fixture plugin under `dir`. The shape mirrors what
 * Phase 8 plugins will commit to `hypaware-core/plugins-workspace/<name>/`:
 * one manifest and one entrypoint. The smoke does not activate the
 * plugin — installing it is enough to exercise the §Phase 7
 * resolver/fetch/lock/update_check contract.
 *
 * @param {string} dir
 */
async function writeFixturePlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/dummy-a',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify(manifest, null, 2)
  )
  await fs.writeFile(
    path.join(dir, 'index.js'),
    "// fixture: @hypaware/dummy-a\nexport async function activate() {}\n"
  )
}

/**
 * Minimal capture stream mirroring `cache_roundtrip.js` and
 * `command_dispatch.js`. All smoke flows share this shape so
 * assertions stay consistent across files.
 */
function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    write(/** @type {unknown} */ chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
