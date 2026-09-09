// @ts-check

// `hyp plugin list` built its output from exactly two sources: `ctx.plugins`
// (what this CLI boot activated) and the install lock. A plugin this boot did
// not get is in neither, so a bundled adapter whose `activate()` threw vanished
// from the listing entirely and an installed one printed under
// `Installed plugins:` with nothing marking it (issue #1570). The listing now
// reads a third source, `ctx.failedPlugins`, and scopes what it says to this
// boot.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPluginList } from '../../src/core/commands/plugin.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * @param {string} name
 * @param {string} version
 * @param {string} [rootDir]
 */
function activePlugin(name, version, rootDir = `/fixtures/bundled/${name}`) {
  return /** @type {any} */ ({
    name,
    version,
    rootDir,
    manifest: { schema_version: 1, name, version, hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js' },
  })
}

/** The version the package actually ships for a bundled name, so nothing below pins a release. */
async function bundledVersion(/** @type {string} */ name) {
  const bundled = await discoverBundledPlugins()
  const entry = [...bundled.loaded, ...bundled.excluded].find((m) => m.manifest.name === name)
  assert.ok(entry, `expected the package to bundle ${name}`)
  return entry.manifest.version
}

/** A literal-match regexp for one whole output line. */
function line(/** @type {string} */ text) {
  return new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '$', 'm')
}

/**
 * @param {string} prefix
 * @param {Record<string, { version: string }>} lockPlugins
 */
async function makeHome(prefix, lockPlugins = {}) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const stateDir = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateDir, { recursive: true })
  /** @type {Record<string, any>} */
  const plugins = {}
  for (const [name, { version }] of Object.entries(lockPlugins)) {
    const installDir = path.join(stateDir, 'plugins', ...name.split('/'))
    plugins[name] = {
      name,
      version,
      source: { kind: 'local-dir', raw: installDir, path: installDir },
      install_dir: installDir,
      content_hash: 'a'.repeat(64),
      manifest_hash: 'b'.repeat(64),
      installed_at: '2026-09-01T00:00:00.000Z',
    }
  }
  await writeLock(stateDir, { schema_version: 1, plugins })
  return hypHome
}

/**
 * @param {string} hypHome
 * @param {{ plugins?: any[], failedPlugins?: string[] }} boot
 */
function makeCtx(hypHome, boot) {
  return /** @type {any} */ ({
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    stdout: makeBuf(),
    stderr: makeBuf(),
    plugins: boot.plugins ?? [],
    ...(boot.failedPlugins ? { failedPlugins: boot.failedPlugins } : {}),
  })
}

const CLEAN_TEXT = 'Active plugins (from current boot):\n'
  + '  @hypaware/ai-gateway@2.0.0  (bundled)\n'
  + 'Installed plugins:\n'
  + '  @third-party/echo@0.2.0\n'

// The case the issue is about: the bundled client adapters are what most
// installs run, and the one that failed was the one name the listing could not
// produce. A config that enables it and a boot that could not activate it read
// exactly like a config that never mentioned it.
test('plugin list names a bundled plugin this boot did not activate, in both output forms', async () => {
  const claudeVersion = await bundledVersion('@hypaware/claude')
  const hypHome = await makeHome('hyp-plugin-list-failed-bundled-')
  try {
    const ctx = makeCtx(hypHome, {
      plugins: [activePlugin('@hypaware/ai-gateway', '2.0.0')],
      failedPlugins: ['@hypaware/claude'],
    })

    assert.equal(await runPluginList([], ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /^Plugins this boot did not activate:$/m)
    assert.match(text, line(`  @hypaware/claude@${claudeVersion}  (bundled)`))
    // The active section still means what it meant, and does not gain the name.
    assert.match(text, /^  @hypaware\/ai-gateway@2\.0\.0  \(bundled\)$/m)

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const claude = json.plugins.find((/** @type {{ name: string }} */ p) => p.name === '@hypaware/claude')
    assert.ok(claude, '--json must carry the plugin the boot did not get')
    assert.equal(claude.active, false)
    assert.equal(claude.unavailable, true)
    // Not `installed`: the name is not in the lock at all, and reporting a
    // bundled plugin's provenance as installed points at a directory that does
    // not exist.
    assert.equal(claude.source, 'bundled')
    assert.equal(claude.version, claudeVersion)
    assert.equal(claude.installed_at, undefined)
    // The active plugin's entry is untouched.
    const gateway = json.plugins.find((/** @type {{ name: string }} */ p) => p.name === '@hypaware/ai-gateway')
    assert.equal(gateway.active, true)
    assert.equal(gateway.unavailable, undefined)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The listing's claim is bounded to this CLI process. The daemon boots
// separately and a plugin can fail in either one alone, so the output must not
// read as a verdict on the daemon.
test('plugin list scopes its failure claim to this boot and points at hyp status for the daemon', async () => {
  const hypHome = await makeHome('hyp-plugin-list-failed-scope-')
  try {
    const ctx = makeCtx(hypHome, { failedPlugins: ['@hypaware/claude'] })
    assert.equal(await runPluginList([], ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /this boot did not activate/)
    assert.match(text, line("  The daemon boots separately; hyp status reports the running daemon's own plugin failures."))
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// Nothing active and nothing installed used to be the whole story, so the
// listing said so. With a bundled plugin that did not come up, "No plugins
// active or installed." is the same denial in one line.
test('plugin list does not report an empty install when a plugin failed to come up', async () => {
  const hypHome = await makeHome('hyp-plugin-list-failed-empty-')
  try {
    const ctx = makeCtx(hypHome, { failedPlugins: ['@hypaware/claude'] })
    assert.equal(await runPluginList([], ctx), 0)
    assert.equal(ctx.stdout.text().includes('No plugins active or installed.'), false)
    assert.match(ctx.stdout.text(), /^  @hypaware\/claude@/m)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// Problem two in the issue: an installed plugin that failed printed under
// `Installed plugins:` with no marker, so only a reader who knew to compare the
// two sections could tell it apart from an idle install.
test('plugin list marks an installed plugin this boot did not activate, in both output forms', async () => {
  const hypHome = await makeHome('hyp-plugin-list-failed-installed-', {
    '@acme/thrower': { version: '1.0.0' },
  })
  try {
    const ctx = makeCtx(hypHome, { failedPlugins: ['@acme/thrower'] })

    assert.equal(await runPluginList([], ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /^  @acme\/thrower@1\.0\.0  \(did not activate in this boot\)$/m)
    assert.match(text, /^Plugins this boot did not activate:$/m)
    assert.match(text, /^  @acme\/thrower@1\.0\.0  \(installed\)$/m)

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const thrower = json.plugins.find((/** @type {{ name: string }} */ p) => p.name === '@acme/thrower')
    assert.equal(thrower.active, false)
    assert.equal(thrower.unavailable, true)
    assert.equal(thrower.source, 'installed')
    assert.equal(thrower.version, '1.0.0')
    assert.equal(thrower.installed_at, '2026-09-01T00:00:00.000Z')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// An idle install is not a failed one. `active: false` covers both, so the mark
// has to be the thing that tells them apart.
test('plugin list leaves an idle install unmarked', async () => {
  const hypHome = await makeHome('hyp-plugin-list-idle-', {
    '@acme/idle': { version: '1.0.0' },
  })
  try {
    const ctx = makeCtx(hypHome, {})
    assert.equal(await runPluginList([], ctx), 0)
    assert.equal(ctx.stdout.text().includes('did not activate'), false)

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const idle = json.plugins.find((/** @type {{ name: string }} */ p) => p.name === '@acme/idle')
    assert.equal(idle.active, false)
    assert.equal(idle.unavailable, undefined)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// `unavailablePlugins` names a manifest that would not load by its *directory*,
// because such a manifest has no plugin name. Rendering that as a plugin would
// put a filesystem path in the `--json` `name` field, so the listing carries
// only what it can attribute to a bundled manifest or a lock entry.
test('plugin list does not render an unattributable entry as a plugin', async () => {
  const hypHome = await makeHome('hyp-plugin-list-unattributable-')
  try {
    const brokenDir = path.join(hypHome, 'hypaware', 'plugins', '@acme', 'unreadable')
    const ctx = makeCtx(hypHome, {
      plugins: [activePlugin('@hypaware/ai-gateway', '2.0.0')],
      failedPlugins: [brokenDir],
    })

    assert.equal(await runPluginList([], ctx), 0)
    assert.equal(ctx.stdout.text().includes(brokenDir), false)
    assert.equal(ctx.stdout.text().includes('this boot did not activate'), false)

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    assert.equal(json.plugins.some((/** @type {{ name: string }} */ p) => p.name === brokenDir), false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// An operator handed both "it is running" and "it did not come up" for one name
// has no way to settle which is true, so the listing never says both.
test('plugin list never names an active plugin as one this boot did not activate', async () => {
  const hypHome = await makeHome('hyp-plugin-list-contradiction-')
  try {
    const ctx = makeCtx(hypHome, {
      plugins: [activePlugin('@hypaware/ai-gateway', '2.0.0')],
      failedPlugins: ['@hypaware/ai-gateway'],
    })
    assert.equal(await runPluginList([], ctx), 0)
    assert.equal(ctx.stdout.text().includes('this boot did not activate'), false)

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const gateway = json.plugins.find((/** @type {{ name: string }} */ p) => p.name === '@hypaware/ai-gateway')
    assert.equal(gateway.active, true)
    assert.equal(gateway.unavailable, undefined)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// A shadowed lock entry never runs (LLP 0380 #bundled-copy-wins), so when its
// bundled twin is the copy that failed, the failure belongs to the bundled
// code. Marking the lock entry would name the wrong copy.
test('plugin list blames the bundled copy, not the shadowed lock entry, when a shadowed name failed', async () => {
  const githubVersion = await bundledVersion('@hypaware/github')
  const hypHome = await makeHome('hyp-plugin-list-shadow-failed-', {
    '@hypaware/github': { version: '0.9.0' },
  })
  try {
    const ctx = makeCtx(hypHome, { failedPlugins: ['@hypaware/github'] })

    assert.equal(await runPluginList([], ctx), 0)
    const text = ctx.stdout.text()
    assert.match(
      text,
      line('  @hypaware/github@0.9.0  (shadowed by the bundled copy; hyp plugin remove @hypaware/github)')
    )
    assert.equal(
      text.includes('hyp plugin remove @hypaware/github)  (did not activate in this boot)'),
      false,
      'the idle lock entry is not the copy that failed'
    )
    assert.match(text, line(`  @hypaware/github@${githubVersion}  (bundled)`))

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const github = json.plugins.find((/** @type {{ name: string }} */ p) => p.name === '@hypaware/github')
    assert.equal(github.unavailable, true)
    assert.equal(github.shadowed, true)
    // Version and source describe the copy that failed, which is the copy boot
    // selects, and the lock's own fields still ride on the entry.
    assert.equal(github.source, 'bundled')
    assert.equal(github.version, githubVersion)
    assert.equal(github.installed_at, '2026-09-01T00:00:00.000Z')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The honest path is the one every install prints. A boot with no shortfall
// must produce the bytes it produced before, in both forms.
test('plugin list output is unchanged when this boot got everything it asked for', async () => {
  const hypHome = await makeHome('hyp-plugin-list-clean-', {
    '@third-party/echo': { version: '0.2.0' },
  })
  try {
    const ctx = makeCtx(hypHome, { plugins: [activePlugin('@hypaware/ai-gateway', '2.0.0')] })

    assert.equal(await runPluginList([], ctx), 0)
    assert.equal(ctx.stdout.text(), CLEAN_TEXT)

    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    assert.deepEqual(JSON.parse(ctx.stdout.text()), {
      plugins: [
        { name: '@hypaware/ai-gateway', version: '2.0.0', source: 'bundled', active: true },
        {
          name: '@third-party/echo',
          version: '0.2.0',
          source: 'installed',
          active: false,
          installed_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    })

    // An empty `failedPlugins`, the shape a clean dispatch actually passes, is
    // the same output as no field at all.
    const withEmpty = makeCtx(hypHome, {
      plugins: [activePlugin('@hypaware/ai-gateway', '2.0.0')],
      failedPlugins: [],
    })
    assert.equal(await runPluginList([], withEmpty), 0)
    assert.equal(withEmpty.stdout.text(), CLEAN_TEXT)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// Nothing at all is still nothing at all.
test('plugin list still reports an empty install as empty', async () => {
  const hypHome = await makeHome('hyp-plugin-list-empty-')
  try {
    const ctx = makeCtx(hypHome, { failedPlugins: [] })
    assert.equal(await runPluginList([], ctx), 0)
    assert.equal(ctx.stdout.text(), 'No plugins active or installed.\n')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
