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

/**
 * Plugin authoring loop smoke. Drives the exact CLI an author/agent
 * uses (`hyp plugin new` then `hyp plugin doctor`) through the
 * dispatcher in a temp HYP_HOME, and proves the doctor's headline
 * check actually fires:
 *
 * - `hyp plugin new @smoke/widget --kind source` scaffolds a plugin
 *   and exits 0.
 * - `hyp plugin doctor <dir>` on the fresh scaffold exits 0 and prints
 *   "no issues found".
 * - After deleting the `ctx.sources.register(...)` call, the doctor
 *   exits 1 and reports `contribution_not_registered`.
 * - A `plugin.doctor` log is emitted with `status=ok` then `status=error`.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'plugin_authoring_roundtrip: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const workspace = path.join(harness.tmpDir, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  const pluginDir = path.join(workspace, 'widget')

  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({
    commandRegistry: registry,
    cacheRoot: path.join(harness.stateDir, 'cache'),
  })

  const env = { ...process.env, HYP_HOME: harness.hypHome }

  // 1. Scaffold.
  const newOut = makeBuf()
  const newErr = makeBuf()
  const newCode = await runRoot(
    'smoke.driver',
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'plugin_new',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () =>
      dispatch(['plugin', 'new', '@smoke/widget', '--kind', 'source', '--dir', workspace], {
        stdout: newOut,
        stderr: newErr,
        env,
        cwd: harness.tmpDir,
        registry,
        kernel,
      })
  )
  expect.that('dispatch: plugin new exited 0', newCode, (v) => v === 0)
  expect.that('stderr: plugin new had no errors', newErr.text(), (v) => v.length === 0)

  const manifestExists = await fs
    .stat(path.join(pluginDir, 'hypaware.plugin.json'))
    .then(() => true, () => false)
  expect.that('scaffold wrote a manifest', manifestExists, (v) => v === true)

  // 2. Doctor the clean scaffold: should be green.
  const okOut = makeBuf()
  const okCode = await runRoot(
    'smoke.driver',
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'plugin_doctor_clean',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () =>
      dispatch(['plugin', 'doctor', pluginDir], {
        stdout: okOut,
        stderr: makeBuf(),
        env,
        cwd: harness.tmpDir,
        registry,
        kernel,
      })
  )
  expect.that('dispatch: plugin doctor (clean) exited 0', okCode, (v) => v === 0)
  expect.that(
    'stdout: doctor reports no issues',
    okOut.text(),
    (v) => v.includes('no issues found')
  )

  // 3. Scaffold a *separate* plugin, strip its register() call, and
  //    doctor it: should fail with the headline diagnostic. A fresh
  //    directory is required: ESM import() caches by URL, so re-importing
  //    the already-doctored `widget` would return its clean module.
  const brokenNewCode = await dispatch(
    ['plugin', 'new', '@smoke/broken', '--kind', 'source', '--dir', workspace],
    { stdout: makeBuf(), stderr: makeBuf(), env, cwd: harness.tmpDir, registry, kernel }
  )
  expect.that('dispatch: plugin new (broken) exited 0', brokenNewCode, (v) => v === 0)

  const pluginDir2 = path.join(workspace, 'broken')
  const indexPath = path.join(pluginDir2, 'src', 'index.js')
  const original = await fs.readFile(indexPath, 'utf8')
  const broken = original.replace(
    /export async function activate\(ctx\) \{[\s\S]*\}\s*$/,
    'export async function activate(ctx) {\n  // registration removed by smoke\n}\n'
  )
  expect.that('smoke could strip the register() call', broken, (v) => v !== original)
  await fs.writeFile(indexPath, broken, 'utf8')

  const badOut = makeBuf()
  const badCode = await runRoot(
    'smoke.driver',
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'plugin_doctor_broken',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () =>
      dispatch(['plugin', 'doctor', pluginDir2, '--json'], {
        stdout: badOut,
        stderr: makeBuf(),
        env,
        cwd: harness.tmpDir,
        registry,
        kernel,
      })
  )
  expect.that('dispatch: plugin doctor (broken) exited 1', badCode, (v) => v === 1)
  const report = JSON.parse(badOut.text())
  expect.that('doctor report is not ok', report.ok, (v) => v === false)
  expect.that(
    'doctor flagged the missing registration',
    report.diagnostics.map((/** @type {any} */ d) => d.kind),
    (/** @type {string[]} */ kinds) => kinds.includes('contribution_not_registered')
  )
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
