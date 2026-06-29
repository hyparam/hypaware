// @ts-check

import fs from 'node:fs/promises'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { pluginLockPath } from '../../../src/core/plugin_install/paths.js'

/**
 * Acceptance smoke for hy-gh-3. Hits a real GitHub URL at a pinned tag
 * so the install path is exercised end-to-end against the network.
 *
 * Opt-in via env var:
 *
 *   HYP_SMOKE_REAL_GITHUB=1 npm run smoke -- plugin_install_github_url
 *
 * Defaults:
 *   HYP_SMOKE_GITHUB_URL: git URL of a tiny public plugin fixture
 *   HYP_SMOKE_GITHUB_REF: pinned tag (or commit SHA) to install
 *   HYP_SMOKE_GITHUB_NAME: manifest name the install should report
 *
 * The smoke skips silently with a clear marker line when the env var
 * is not set so CI runs of `npm run smoke` do not hit the network.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  if (process.env.HYP_SMOKE_REAL_GITHUB !== '1') {
    process.stdout.write(
      `smoke ${harness.smokeName}: SKIPPED (set HYP_SMOKE_REAL_GITHUB=1 to opt in)\n`
    )
    return
  }

  const url = process.env.HYP_SMOKE_GITHUB_URL ||
    'https://github.com/hyperparam/hypaware-plugin-fixture.git'
  const ref = process.env.HYP_SMOKE_GITHUB_REF || 'v0.1.0'
  const expectedName = process.env.HYP_SMOKE_GITHUB_NAME ||
    '@hypaware/plugin-fixture'

  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'plugin_install_github_url: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const stateDir = harness.stateDir
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({
    commandRegistry: registry,
    cacheRoot: `${stateDir}/cache`,
  })

  // -- Non-TTY install without --yes must reject with confirmation_required.
  const rejectStdout = makeBuf()
  const rejectStderr = makeBuf()
  const rejectCode = await dispatch(
    ['plugin', 'install', url, '--ref', ref],
    {
      stdout: rejectStdout,
      stderr: rejectStderr,
      env: { ...process.env, HYP_HOME: harness.hypHome },
      cwd: harness.tmpDir,
      registry,
      kernel,
    }
  )
  expect.that(
    'dispatch: non-tty install without --yes returns non-zero',
    rejectCode,
    (v) => v !== 0
  )
  expect.that(
    'stderr: non-tty install without --yes mentions confirmation requirement',
    rejectStderr.text(),
    (v) =>
      typeof v === 'string' &&
      /confirmation/i.test(v) &&
      /--yes/.test(v)
  )

  // -- Install with --yes against the real upstream.
  const installStdout = makeBuf()
  const installStderr = makeBuf()
  const installCode = await runRoot(
    'smoke.driver',
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'plugin_install_github_url',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () =>
      dispatch(
        ['plugin', 'install', url, '--ref', ref, '--yes'],
        {
          stdout: installStdout,
          stderr: installStderr,
          env: { ...process.env, HYP_HOME: harness.hypHome },
          cwd: harness.tmpDir,
          registry,
          kernel,
        }
      )
  )
  expect.that(
    'dispatch: install with --yes exited 0',
    installCode,
    (v) => v === 0
  )
  expect.that(
    'stdout: install summary includes plugin name',
    installStdout.text(),
    (v) => typeof v === 'string' && v.includes(expectedName)
  )

  // -- The plugin contributed a command we can run to prove activation.
  const lockPath = pluginLockPath(stateDir)
  const lockRaw = await fs.readFile(lockPath, 'utf8')
  const lock = JSON.parse(lockRaw)
  expect.that(
    'lock: schema_version is 1',
    lock?.schema_version,
    (v) => v === 1
  )
  const entry = lock?.plugins?.[expectedName]
  expect.that(
    `lock: contains ${expectedName} entry`,
    entry,
    (v) => v !== undefined
  )
  expect.that(
    'lock: source.kind is git',
    entry?.source?.kind,
    (v) => v === 'git'
  )
  expect.that(
    'lock: resolved_ref is a 40-char commit SHA',
    entry?.resolved_ref,
    (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)
  )
  expect.that(
    'lock: content_hash present',
    entry?.content_hash,
    (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  )

  await obs.shutdown()

  // -- The plugin.install span must carry confirmation=auto_yes.
  const traces = await expect.traces()
  const installSpan = traces.find(
    (/** @type {any} */ t) =>
      t.name === 'plugin.install' &&
      t.attributes?.hyp_plugin === expectedName
  )
  expect.that(
    'traces: plugin.install span found for the github fixture',
    installSpan,
    (v) => v !== undefined
  )
  expect.that(
    'traces: plugin.install stamps confirmation=auto_yes',
    installSpan?.attributes?.confirmation,
    (v) => v === 'auto_yes'
  )
}

/**
 * Minimal capture stream mirroring the local-dir/git smokes. Smoke
 * flows keep the shape identical so assertions stay consistent.
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
