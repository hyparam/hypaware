// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPluginList } from '../../src/core/commands/plugin.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * @param {string} name
 * @param {string} version
 * @param {string} [rootDir] where the active copy runs from; a bundled fixture root by default
 */
function activePlugin(name, version, rootDir = `/fixtures/bundled/${name}`) {
  return /** @type {any} */ ({
    name,
    version,
    rootDir,
    manifest: { schema_version: 1, name, version, hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js' },
  })
}

// `hyp plugin list` printed "(bundled)" for every active plugin, so an
// installed copy running in a bundled name's place (or any active installed
// plugin) was labelled as shipped code. Provenance now comes from the install
// lock, the same source the `--json` branch already used for `source`.
test('plugin list labels an active plugin as installed when the install lock holds it', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-plugin-list-'))
  try {
    const stateDir = path.join(hypHome, 'hypaware')
    await fs.mkdir(stateDir, { recursive: true })
    const installDir = path.join(stateDir, 'plugins', '@third-party', 'echo')
    await writeLock(stateDir, {
      schema_version: 1,
      plugins: {
        '@third-party/echo': {
          name: '@third-party/echo',
          version: '0.2.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: 'a'.repeat(64),
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-09-01T00:00:00.000Z',
        },
      },
    })
    const ctx = /** @type {any} */ ({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      stdout: makeBuf(),
      stderr: makeBuf(),
      // The third-party plugin runs from its install dir, the bundled one does not.
      plugins: [activePlugin('@hypaware/claude', '1.0.0'), activePlugin('@third-party/echo', '0.2.0', installDir)],
    })

    assert.equal(await runPluginList([], ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /^  @hypaware\/claude@1\.0\.0  \(bundled\)$/m)
    assert.match(text, /^  @third-party\/echo@0\.2\.0  \(installed\)$/m)
    assert.equal(text.includes('@third-party/echo@0.2.0  (bundled)'), false)

    // The JSON branch says the same thing through `source`.
    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const byName = new Map(json.plugins.map((/** @type {{ name: string }} */ p) => [p.name, p]))
    assert.equal(byName.get('@hypaware/claude')?.source, 'bundled')
    assert.equal(byName.get('@third-party/echo')?.source, 'installed')
    assert.equal(byName.get('@third-party/echo')?.active, true)
    assert.equal(byName.get('@third-party/echo')?.shadowed, undefined)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// An installed copy of a bundled name is in the lock while the bundled copy
// is what runs (LLP 0380). Name membership in the lock would label the active
// bundled plugin "installed"; the root directory tells the two apart, and the
// idle lock entry is marked with the command that clears it.
// @ref LLP 0380#bundled-copy-wins [tests]: provenance is the root that runs, and the shadowed lock entry says so
test('plugin list marks an installed copy the bundled plugin shadows, and labels the running copy bundled', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-plugin-list-shadow-'))
  try {
    const stateDir = path.join(hypHome, 'hypaware')
    await fs.mkdir(stateDir, { recursive: true })
    const installDir = path.join(stateDir, 'plugins', '@hypaware', 'github')
    await writeLock(stateDir, {
      schema_version: 1,
      plugins: {
        '@hypaware/github': {
          name: '@hypaware/github',
          version: '0.9.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: 'a'.repeat(64),
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-08-31T00:00:00.000Z',
        },
      },
    })
    // The active copy runs from the bundled workspace, not the install dir.
    const ctx = /** @type {any} */ ({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      stdout: makeBuf(),
      stderr: makeBuf(),
      plugins: [activePlugin('@hypaware/github', '1.31.0')],
    })

    assert.equal(await runPluginList([], ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /^  @hypaware\/github@1\.31\.0  \(bundled\)$/m)
    assert.match(text, /^  @hypaware\/github@0\.9\.0  \(shadowed by the bundled copy; hyp plugin remove @hypaware\/github\)$/m)

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const github = json.plugins.find((/** @type {{ name: string }} */ p) => p.name === '@hypaware/github')
    assert.equal(github.source, 'bundled')
    assert.equal(github.version, '1.31.0')
    assert.equal(github.active, true)
    assert.equal(github.shadowed, true)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// `plugin list` boots the `config` profile, so the bundled twin of a shadowed
// lock entry is only active when the config names it. It usually does not:
// both V1-excluded names this rule is about (`@hypaware/github`,
// `@hypaware/claude-desktop`) activate only on an explicit opt-in, and the
// operator following the `hyp status` repair has often already taken the name
// out of `plugins[]`. Deriving the mark from what happened to activate left
// `plugin list` calling that entry an ordinary install while `hyp status`
// called it code that never runs, and `plugin list` is the surface the repair
// sends the operator to. The bundled manifest set decides, under every profile.
// @ref LLP 0380#surfaced-not-fatal [tests]: the list marks the idle lock entry whether or not this boot activated its bundled twin
test('plugin list marks a shadowed lock entry even when the bundled twin is not active', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-plugin-list-idle-shadow-'))
  try {
    const stateDir = path.join(hypHome, 'hypaware')
    await fs.mkdir(stateDir, { recursive: true })
    const installDir = path.join(stateDir, 'plugins', '@hypaware', 'github')
    await writeLock(stateDir, {
      schema_version: 1,
      plugins: {
        '@hypaware/github': {
          name: '@hypaware/github',
          version: '0.9.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: 'a'.repeat(64),
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-08-31T00:00:00.000Z',
        },
      },
    })
    // Nothing active: the config does not name the excluded bundled plugin.
    const ctx = /** @type {any} */ ({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      stdout: makeBuf(),
      stderr: makeBuf(),
      plugins: [],
    })

    assert.equal(await runPluginList([], ctx), 0)
    assert.match(
      ctx.stdout.text(),
      /^  @hypaware\/github@0\.9\.0  \(shadowed by the bundled copy; hyp plugin remove @hypaware\/github\)$/m
    )

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const github = json.plugins.find((/** @type {{ name: string }} */ p) => p.name === '@hypaware/github')
    assert.equal(github.shadowed, true)
    assert.equal(github.active, false)
    // Nothing ran, so the row still reports where its own code came from.
    assert.equal(github.source, 'installed')
    assert.equal(github.version, '0.9.0')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// A third-party plugin the package does not ship is never shadowed, whether
// or not this boot activated it: the mark must key off the bundled manifest
// set, not merely off "in the lock and not active".
test('plugin list does not mark an inactive third-party install as shadowed', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-plugin-list-third-party-'))
  try {
    const stateDir = path.join(hypHome, 'hypaware')
    await fs.mkdir(stateDir, { recursive: true })
    const installDir = path.join(stateDir, 'plugins', '@third-party', 'echo')
    await writeLock(stateDir, {
      schema_version: 1,
      plugins: {
        '@third-party/echo': {
          name: '@third-party/echo',
          version: '0.2.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: 'a'.repeat(64),
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-09-01T00:00:00.000Z',
        },
      },
    })
    const ctx = /** @type {any} */ ({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      stdout: makeBuf(),
      stderr: makeBuf(),
      plugins: [],
    })

    assert.equal(await runPluginList([], ctx), 0)
    assert.equal(ctx.stdout.text().includes('shadowed'), false)

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const echo = json.plugins.find((/** @type {{ name: string }} */ p) => p.name === '@third-party/echo')
    assert.equal(echo.shadowed, undefined)
    assert.equal(echo.source, 'installed')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
