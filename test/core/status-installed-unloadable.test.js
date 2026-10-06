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

/**
 * @import { HypAwareStatusReport } from '../../src/core/daemon/types.js'
 */

// Issue #1936. A plugin whose manifest will not load contributes nothing to
// the catalog `collectHypAwareStatus` validates the config against, so a
// config entry naming it read exactly like a typo: "is not a known
// first-party plugin and is not installed", repaired by rewriting the config.
// Both halves were wrong. The lock says it is installed (and `hyp plugin list`
// says so on the same machine, at the same moment), and the config entry is
// the one thing about the install that is right.
//
// The sibling `plugin_manifest_unloadable` diagnostic (issue #1576) names the
// directory off a live daemon's snapshot. This is the half that names the
// plugin, and it has to hold with no daemon running at all, so these tests
// never start one.

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * Stage an installed plugin: a lock entry, an `install_dir` that exists, and
 * files in it. `manifest` is written verbatim so a caller can truncate it.
 *
 * @param {string} hypHome
 * @param {string} name
 * @param {string} manifest
 * @param {string} [entrypoint]
 */
async function stageInstalled(hypHome, name, manifest, entrypoint = 'export async function activate() {}\n') {
  const stateDir = path.join(hypHome, 'hypaware')
  const installDir = path.join(stateDir, 'plugins', ...name.split('/'))
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), manifest)
  await fs.writeFile(path.join(installDir, 'index.js'), entrypoint)
  await writeLock(stateDir, {
    schema_version: 1,
    plugins: {
      [name]: {
        name,
        version: '1.0.0',
        source: { kind: 'local-dir', raw: installDir, path: installDir },
        install_dir: installDir,
        content_hash: 'a'.repeat(64),
        manifest_hash: 'b'.repeat(64),
        installed_at: '2026-09-19T00:00:00.000Z',
      },
    },
  })
  return installDir
}

/** @param {string} name @param {string} [version] */
function validManifest(name, version = '1.0.0') {
  return JSON.stringify({
    schema_version: 1,
    name,
    version,
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  })
}

/** @param {HypAwareStatusReport} report @param {string} pointer */
function configErrorAt(report, pointer) {
  return report.diagnostics.find((d) => d.kind === 'config_invalid' && d.pointer === pointer)
}

test('an installed plugin whose manifest will not load is not called uninstalled, and its repair points at the install', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-unloadable-'))
  try {
    const name = '@acme/corrupt'
    // Truncated JSON: the manifest is unparseable, so the directory yields no
    // plugin name at all and only the lock entry can supply one.
    const installDir = await stageInstalled(hypHome, name, '{"schema_version":1,"name":"@acme/corrupt",')
    await fs.writeFile(
      defaultConfigPath(hypHome),
      JSON.stringify({ version: 2, plugins: [{ name }] }) + '\n'
    )
    const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }

    const report = await collectHypAwareStatus({ env })
    const diag = configErrorAt(report, '/plugins/0/name')
    assert.ok(diag, 'the entry is still reported')
    assert.equal(diag.severity, 'error')
    // The claim the issue is about.
    assert.doesNotMatch(diag.message, /is not installed/)
    assert.equal(
      diag.message,
      `[plugin_installed_unloadable] /plugins/0/name: plugin '${name}' is installed but its manifest will not load, so nothing in it is running`
    )
    // The repair names the install, and nothing in it rewrites the config.
    assert.deepEqual(diag.repair, [`hyp plugin doctor ${installDir}`, `hyp plugin update ${name}`])
    assert.equal(diag.repair.some((r) => r.includes('hyp setup')), false)

    // The rendered surface carries both halves, since that is what the
    // operator actually reads.
    const stdout = makeBuf()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
    assert.match(stdout.text(), /plugin_installed_unloadable/)
    assert.match(stdout.text(), /hyp plugin doctor /)

    // The contradiction the issue opens with: on this same install, at this
    // same moment, the listing calls the plugin installed.
    const listOut = makeBuf()
    const listCode = await dispatch(['plugin', 'list'], { stdout: listOut, stderr: makeBuf(), env })
    assert.equal(listCode, 0)
    assert.match(listOut.text(), /@acme\/corrupt@1\.0\.0/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a plugin name nothing on the machine matches keeps the unknown message and the config repair', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-unknown-'))
  try {
    await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
    await fs.writeFile(
      defaultConfigPath(hypHome),
      JSON.stringify({ version: 2, plugins: [{ name: '@acme/typo' }] }) + '\n'
    )

    const report = await collectHypAwareStatus({ env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' } })
    const diag = configErrorAt(report, '/plugins/0/name')
    assert.ok(diag, 'an unknown name is still an error')
    assert.equal(diag.severity, 'error')
    // Byte for byte what it said before the two states were told apart.
    assert.equal(
      diag.message,
      "[plugin_unknown] /plugins/0/name: plugin '@acme/typo' is not a known first-party plugin and is not installed"
    )
    assert.deepEqual(diag.repair, ['hyp setup --from-file <config.json>'])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a plugin that loads raises no config error, whether or not its activate() throws', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-loads-'))
  try {
    // Issue #1556's case: the manifest loads, so the plugin is in the catalog,
    // and a throwing `activate()` is reported by the activation surfaces, not
    // by config validation. Nothing here may start calling it unknown or
    // unloadable.
    const name = '@acme/thrower'
    await stageInstalled(
      hypHome,
      name,
      validManifest(name),
      'export async function activate() { throw new Error("acme thrower: boom") }\n'
    )
    await fs.writeFile(
      defaultConfigPath(hypHome),
      JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/ai-gateway' }, { name }] }) + '\n'
    )

    const report = await collectHypAwareStatus({ env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' } })
    assert.equal(configErrorAt(report, '/plugins/0/name'), undefined, 'a bundled plugin that activates is not a config error')
    assert.equal(configErrorAt(report, '/plugins/1/name'), undefined, 'a loadable manifest is not a config error')
    assert.equal(report.diagnostics.some((d) => d.message.includes('plugin_installed_unloadable')), false)
    assert.equal(report.diagnostics.some((d) => d.message.includes('plugin_unknown')), false)
    assert.deepEqual(report.activePlugins, ['@hypaware/ai-gateway', name])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// Issue #1954. `hyp status` learned to tell the two states apart; the other
// surfaces that validate a config against the CLI plugin catalog did not, so
// on one install, at one moment, `hyp config validate` said the plugin was not
// installed while `hyp status`, `hyp plugin list` and `hyp plugin info` said it
// was. The contradiction is the defect, so these assert the surfaces agree
// rather than only that a new sentence appeared: a fix that made them disagree
// differently would pass a message-only check.

/** @param {string} text @returns {string | undefined} */
function errorKindIn(text) {
  return text.match(/\[([a-z_]+)\] \/plugins\/0\/name:/)?.[1]
}

test('config validate reports the same kind as status for an installed plugin whose manifest will not load', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-validate-unloadable-'))
  try {
    const name = '@acme/corrupt'
    const installDir = await stageInstalled(hypHome, name, '{"schema_version":1,"name":"@acme/corrupt",')
    const configPath = defaultConfigPath(hypHome)
    await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [{ name }] }) + '\n')
    const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }

    const validateErr = makeBuf()
    const validateCode = await dispatch(['config', 'validate'], { stdout: makeBuf(), stderr: validateErr, env })
    // Still an error: the plugin captures nothing either way.
    assert.equal(validateCode, 1)
    // The claim the issue is about.
    assert.doesNotMatch(validateErr.text(), /is not installed/)

    // The agreement, read off both surfaces rather than compared to a literal.
    const report = await collectHypAwareStatus({ env })
    const statusDiag = configErrorAt(report, '/plugins/0/name')
    assert.ok(statusDiag, 'status still reports the entry')
    const statusKind = errorKindIn(statusDiag.message)
    const validateKind = errorKindIn(validateErr.text())
    assert.ok(validateKind, `config validate named no kind: ${validateErr.text()}`)
    assert.equal(validateKind, statusKind)
    assert.equal(validateKind, 'plugin_installed_unloadable')

    // The other two surfaces in the contradiction, on the same fixture.
    const listOut = makeBuf()
    assert.equal(await dispatch(['plugin', 'list'], { stdout: listOut, stderr: makeBuf(), env }), 0)
    assert.match(listOut.text(), /@acme\/corrupt@1\.0\.0/)
    const infoOut = makeBuf()
    assert.equal(await dispatch(['plugin', 'info', name], { stdout: infoOut, stderr: makeBuf(), env }), 0)
    assert.ok(infoOut.text().includes(`install_dir:   ${installDir}`), infoOut.text())

    // The sibling caller of the same catalog build, which validates an
    // operator-supplied file and had the identical defect.
    const setupErr = makeBuf()
    await dispatch(['setup', '--from-file', configPath], { stdout: makeBuf(), stderr: setupErr, env })
    assert.equal(errorKindIn(setupErr.text()), statusKind)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('config validate still calls a name nothing on the machine matches unknown', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-validate-unknown-'))
  try {
    await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
    await fs.writeFile(
      defaultConfigPath(hypHome),
      JSON.stringify({ version: 2, plugins: [{ name: '@acme/typo' }] }) + '\n'
    )
    const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }

    const stderr = makeBuf()
    assert.equal(await dispatch(['config', 'validate'], { stdout: makeBuf(), stderr, env }), 1)
    // Byte for byte what it said before the two states were told apart.
    assert.match(
      stderr.text(),
      /\[plugin_unknown\] \/plugins\/0\/name: plugin '@acme\/typo' is not a known first-party plugin and is not installed/
    )

    // And it agrees with status here too, which is the half a fix that
    // weakened the unknown arm would break.
    const report = await collectHypAwareStatus({ env })
    const statusDiag = configErrorAt(report, '/plugins/0/name')
    assert.ok(statusDiag)
    assert.equal(errorKindIn(stderr.text()), errorKindIn(statusDiag.message))
    assert.equal(errorKindIn(stderr.text()), 'plugin_unknown')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
