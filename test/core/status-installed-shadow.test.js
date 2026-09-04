// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'
import { dispatch } from '../../src/core/cli/dispatch.js'

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * Stage an installed copy of a bundled name, the shape a pre-bundling
 * `hyp plugin install` of the GitHub source leaves behind.
 *
 * @param {string} hypHome
 * @param {string} name
 */
async function stageInstalledShadow(hypHome, name) {
  const stateDir = path.join(hypHome, 'hypaware')
  const installDir = path.join(stateDir, 'plugins', ...name.split('/'))
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(
    path.join(installDir, 'hypaware.plugin.json'),
    JSON.stringify({ schema_version: 1, name, version: '0.9.0', hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js' })
  )
  await fs.writeFile(path.join(installDir, 'index.js'), 'export async function activate() { throw new Error("the installed shadow must never activate") }\n')
  await writeLock(stateDir, {
    schema_version: 1,
    plugins: {
      [name]: {
        name,
        version: '0.9.0',
        source: { kind: 'local-dir', raw: installDir, path: installDir },
        install_dir: installDir,
        content_hash: 'a'.repeat(64),
        manifest_hash: 'b'.repeat(64),
        installed_at: '2026-08-31T00:00:00.000Z',
      },
    },
  })
  return installDir
}

// The shadow used to reject boot, and dispatch boots before every command,
// so `hyp status` and the `hyp plugin remove` the error named both threw the
// same error. The shadow is now a warning on the status surface with that
// command as its repair, and every command runs.
// @ref LLP 0380#surfaced-not-fatal [tests]: the shadow is a repairable warning, and the commands that clear it run
test('hyp status warns about an installed plugin the bundled copy shadows, with the repair, and every command still runs', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-shadow-'))
  try {
    await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
    await stageInstalledShadow(hypHome, '@hypaware/github')
    // context-graph is the bundled GitHub source's declared dependency; with
    // it the bundled copy activates, which is what the plugin-list assertion
    // below (running copy vs. idle lock entry) needs.
    await fs.writeFile(
      defaultConfigPath(hypHome),
      JSON.stringify({
        version: 2,
        plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/context-graph' }, { name: '@hypaware/github' }],
      }) + '\n'
    )
    const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }

    const report = await collectHypAwareStatus({ env })
    const diag = report.diagnostics.find((d) => d.kind === 'installed_plugin_shadowed')
    assert.ok(diag, 'the shadow is surfaced')
    assert.equal(diag.severity, 'warning')
    assert.match(diag.message, /@hypaware\/github/)
    assert.deepEqual(diag.repair, ['hyp plugin remove @hypaware/github'])
    // A warning, not an outage: the machine runs the bundled code.
    assert.notEqual(report.overall, 'degraded', `overall=${report.overall}`)

    const stdout = makeBuf()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
    assert.match(stdout.text(), /installed_plugin_shadowed/)
    assert.match(stdout.text(), /hyp plugin remove @hypaware\/github/)

    // The commands the operator reaches for all boot past the shadow: the
    // bundled copy activates, the installed one never does (its activate()
    // throws), and the repair command itself runs and clears the warning.
    for (const argv of [['status'], ['plugin', 'list']]) {
      const out = makeBuf()
      const err = makeBuf()
      const code = await dispatch(argv, { stdout: out, stderr: err, env })
      assert.equal(code, 0, `${argv.join(' ')}: ${err.text()}`)
    }
    const listOut = makeBuf()
    await dispatch(['plugin', 'list'], { stdout: listOut, stderr: makeBuf(), env })
    assert.match(listOut.text(), /@hypaware\/github@0\.9\.0.*shadowed: the bundled copy runs; hyp plugin remove @hypaware\/github/)

    const removeOut = makeBuf()
    const removeErr = makeBuf()
    const removeCode = await dispatch(['plugin', 'remove', '@hypaware/github'], { stdout: removeOut, stderr: removeErr, env })
    assert.equal(removeCode, 0, removeErr.text())
    assert.match(removeOut.text(), /removed @hypaware\/github/)

    const after = await collectHypAwareStatus({ env })
    assert.equal(after.diagnostics.some((d) => d.kind === 'installed_plugin_shadowed'), false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('hyp status raises no shadow warning for an installed third-party plugin', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-no-shadow-'))
  try {
    await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
    await stageInstalledShadow(hypHome, '@third-party/echo')
    await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] }) + '\n')

    const report = await collectHypAwareStatus({ env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' } })
    assert.equal(report.diagnostics.some((d) => d.kind === 'installed_plugin_shadowed'), false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
