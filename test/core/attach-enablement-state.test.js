// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

/**
 * @import { CommandRunContext, PluginLockEntry } from '../../hypaware-plugin-kernel-types.js'
 */

// Client attach used to dead-end on two different "we don't know that client"
// messages when the real state was "the adapter exists but is not enabled on
// this install" (LLP 0174 #detection). These fixtures drive the three states
// through BOTH failure sites: the `hypaware.ai-gateway` capability gate (no
// gateway-using plugin enabled at all) and the live-registry miss (some other
// gateway-using plugin is enabled, this client's adapter is not).
//
// @ref LLP 0174#detection [tests]: unknown client / known-but-not-enabled /
// disabled-by-fleet, at both attach failure sites
//
// @ref LLP 0531#one-blocker [tests]: the refusal names the one plugin in the
// adapter's dependency closure that blocks it, with the repair for its state

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * Build a CommandRunContext rooted at a temp home.
 *
 * `gatewayCapability: false` reproduces the capability-gate failure site;
 * otherwise a live-but-empty registry reproduces the registry-miss site
 * (`registered` names the clients the fake gateway does know).
 *
 * `activations` stands in for the loader outcomes of this run.
 *
 * @param {{ home: string, gatewayCapability?: boolean, registered?: string[], activations?: object[] }} opts
 */
function makeCtx({ home, gatewayCapability = true, registered = [], activations }) {
  const gateway = {
    localEndpoint() {
      return 'http://127.0.0.1:60680'
    },
    /** @param {string} name */
    getClient(name) {
      if (!registered.includes(name)) return undefined
      return { name, async attach() {} }
    },
    listClients() {
      return registered.map((name) => ({ name }))
    },
  }
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout,
    stderr,
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
    activations,
    capabilities: {
      /** @param {string} id */
      has: (id) => (id === 'hypaware.ai-gateway' ? gatewayCapability : false),
      require: () => gateway,
    },
  }))
  return { ctx, stdout, stderr }
}

/** @param {string} home */
function localConfigPath(home) {
  return path.join(home, '.hyp', 'hypaware-config.json')
}

/**
 * The exact guided error the design specifies for the fixable state.
 * @param {string} home
 * @param {string} client
 * @param {string} plugin
 */
function notEnabledMessage(home, client, plugin) {
  return (
    `error: the ${client} adapter is not enabled on this install; ` +
    `enable it with 'hyp setup', or add ${plugin} to ${localConfigPath(home)} ` +
    `and run 'hyp daemon restart', then re-run 'hyp client attach ${client}'\n`
  )
}

const DISABLED_CENTRAL_MESSAGE =
  `error: the claude adapter is disabled by your central config; ` +
  `a local config cannot override the central-managed setting\n`

/**
 * Write a local config and return its exact bytes, so a test can prove the
 * refusal wrote nothing.
 *
 * @param {string} home
 * @param {object[]} plugins
 */
function writeLocalConfig(home, plugins) {
  mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
  const body = JSON.stringify({ version: 2, plugins }, null, 2) + '\n'
  writeFileSync(localConfigPath(home), body)
  return body
}

/**
 * Run attach twice, human and `--json`, and return both renderings of the
 * one refusal.
 *
 * @param {string} home
 * @param {string} client
 * @param {{ registered?: string[], gatewayCapability?: boolean, activations?: object[] }} [opts]
 */
async function refusal(home, client, opts = {}) {
  const human = makeCtx({ home, ...opts })
  assert.equal(await runAttach([client], human.ctx), 1, human.stdout.text() + human.stderr.text())
  assert.equal(human.stdout.text(), '')
  const json = makeCtx({ home, ...opts })
  assert.equal(await runAttach([client, '--json'], json.ctx), 1)
  assert.equal(json.stderr.text(), '')
  return { text: human.stderr.text(), payload: JSON.parse(json.stdout.text()) }
}

/**
 * Stage installed plugins the way `hyp plugin install` lands them (install
 * dir + lock entry), so the catalog walk sees their `requires`/`provides`.
 *
 * @param {string} home
 * @param {Record<string, unknown>[]} manifests
 */
async function stageInstalledPlugins(home, manifests) {
  const stateDir = path.join(home, '.hyp', 'hypaware')
  /** @type {Record<string, PluginLockEntry>} */
  const plugins = {}
  for (const manifest of manifests) {
    const name = String(manifest.name)
    const installDir = path.join(stateDir, 'plugins', name.replace(/[@/]/g, '-'))
    mkdirSync(installDir, { recursive: true })
    writeFileSync(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
      schema_version: 1,
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      ...manifest,
    }))
    writeFileSync(path.join(installDir, 'index.js'), 'export async function activate() {}\n')
    plugins[name] = {
      name,
      version: '1.0.0',
      source: { kind: 'local-dir', raw: installDir, path: installDir },
      install_dir: installDir,
      content_hash: 'a'.repeat(64),
      manifest_hash: 'b'.repeat(64),
      installed_at: '2026-10-17T00:00:00.000Z',
    }
  }
  await writeLock(stateDir, { schema_version: 1, plugins })
}

/**
 * A settings-file probe, so a fixture client takes the adapter attach path
 * rather than the switch-only resume path.
 *
 * @param {string} client
 */
function probe(client) {
  return { format: 'json', settings_file: `.${client}/settings.json`, marker_key: '_hypaware' }
}

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-enable-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Write a fleet (central) layer seed under the temp home's state root. The
 * whole central document wins and locks under LLP 0031's additive merge, so a
 * local add-back of the same plugin name is dropped.
 *
 * @param {string} home
 * @param {object} config
 */
function writeCentralConfig(home, config) {
  const controlDir = path.join(home, '.hyp', 'hypaware', 'state')
  mkdirSync(controlDir, { recursive: true })
  writeFileSync(path.join(controlDir, 'managed-config.seed.json'), JSON.stringify(config))
}

test('capability gate: a catalog-known client reports not_enabled, not cap_missing', async () => {
  await withTempHome(async (home) => {
    // No gateway-using plugin enabled at all, so `hypaware.ai-gateway` is
    // absent. The old wording blamed the gateway plugin; the state is that the
    // claude adapter (which would have pulled the gateway in) is not enabled.
    const { ctx, stderr, stdout } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), notEnabledMessage(home, 'claude', '@hypaware/claude'))
    assert.equal(stdout.text(), '')
    assert.doesNotMatch(stderr.text(), /unknown client/)
    assert.doesNotMatch(stderr.text(), /installed and activated/)
  })
})

test('capability gate: bare attach runner defaults to claude and takes the same path', async () => {
  await withTempHome(async (home) => {
    const { ctx, stderr } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach([], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), notEnabledMessage(home, 'claude', '@hypaware/claude'))
  })
})

test('capability gate: --json carries error_kind adapter_not_enabled in the same payload shape', async () => {
  await withTempHome(async (home) => {
    const { ctx, stdout, stderr } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach(['claude', '--json'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), '')
    const payload = JSON.parse(stdout.text())
    assert.deepEqual(payload, {
      status: 'failed',
      action: 'attach',
      client: 'claude',
      dry_run: false,
      error_kind: 'adapter_not_enabled',
      error: notEnabledMessage(home, 'claude', '@hypaware/claude').replace(/^error: /, '').trimEnd(),
    })
  })
})

test('capability gate: a name no plugin contributes keeps the cap_missing wording', async () => {
  await withTempHome(async (home) => {
    // State 1 at the capability gate: nothing in the bundled+installed catalog
    // contributes this client, so there is no adapter to name and the gate's
    // own message stands unchanged.
    const { ctx, stderr } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach(['frobnicator'], ctx)
    assert.equal(code, 1)
    assert.equal(
      stderr.text(),
      'error: attach requires the @hypaware/ai-gateway plugin to be installed and activated\n'
    )
  })
})

test('registry miss: another gateway plugin is live but the requested adapter is not enabled', async () => {
  await withTempHome(async (home) => {
    // The gateway capability resolves (some other gateway-using plugin is
    // enabled) and its registry knows codex but not claude. Today's message
    // was `unknown client 'claude'`; the state is not_enabled.
    const { ctx, stderr, stdout } = makeCtx({ home, registered: ['codex'] })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), notEnabledMessage(home, 'claude', '@hypaware/claude'))
    assert.equal(stdout.text(), '')
    assert.doesNotMatch(stderr.text(), /unknown client/)
  })
})

test('registry miss: --json reports adapter_not_enabled', async () => {
  await withTempHome(async (home) => {
    const { ctx, stdout, stderr } = makeCtx({ home, registered: ['codex'] })
    const code = await runAttach(['claude', '--json'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), '')
    const payload = JSON.parse(stdout.text())
    assert.equal(payload.status, 'failed')
    assert.equal(payload.action, 'attach')
    assert.equal(payload.client, 'claude')
    assert.equal(payload.dry_run, false)
    assert.equal(payload.error_kind, 'adapter_not_enabled')
    assert.match(payload.error, /the claude adapter is not enabled on this install/)
  })
})

test('registry miss: a genuinely unrecognized name still gets the plain unknown client text', async () => {
  await withTempHome(async (home) => {
    const { ctx, stderr } = makeCtx({ home, registered: ['codex'] })
    const code = await runAttach(['frobnicator'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), "error: unknown client 'frobnicator'\n")
  })
})

test('central-disabled adapter refuses with the central-managed explanation, not the local remedy', async () => {
  await withTempHome(async (home) => {
    // The central layer names @hypaware/claude with enabled:false. LLP 0031's
    // merge drops any local entry with that name, so telling the user to edit
    // their own config would be advice that cannot work.
    writeCentralConfig(home, {
      version: 2,
      plugins: [{ name: '@hypaware/claude', enabled: false }],
    })
    mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
    writeFileSync(localConfigPath(home), JSON.stringify({ version: 2, plugins: [] }))

    const { ctx, stderr } = makeCtx({ home, registered: ['codex'] })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), DISABLED_CENTRAL_MESSAGE)
    assert.doesNotMatch(stderr.text(), /hyp setup/)
    assert.doesNotMatch(stderr.text(), /hyp daemon restart/)
  })
})

test('central-disabled adapter reports adapter_disabled_central through the capability gate too', async () => {
  await withTempHome(async (home) => {
    writeCentralConfig(home, {
      version: 2,
      plugins: [{ name: '@hypaware/claude', enabled: false }],
    })
    mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
    writeFileSync(localConfigPath(home), JSON.stringify({ version: 2, plugins: [] }))

    const { ctx, stdout } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach(['claude', '--json'], ctx)
    assert.equal(code, 1)
    const payload = JSON.parse(stdout.text())
    assert.equal(payload.error_kind, 'adapter_disabled_central')
    assert.equal(payload.error, DISABLED_CENTRAL_MESSAGE.replace(/^error: /, '').trimEnd())
  })
})

test('a locally disabled adapter names its own entry and the flag that enables it', async () => {
  await withTempHome(async (home) => {
    // enabled:false in the LOCAL layer only: the user can flip it, but the
    // add path cannot (the entry already exists), so the remedy is the flag.
    const before = writeLocalConfig(home, [{ name: '@hypaware/claude', enabled: false }])
    const { text, payload } = await refusal(home, 'claude', { registered: ['codex'] })
    const message =
      `the claude adapter's plugin @hypaware/claude is disabled in ${localConfigPath(home)}; ` +
      `set "enabled": true on its plugins[] entry and run 'hyp daemon restart', ` +
      `then re-run 'hyp client attach claude'`
    assert.equal(text, `error: ${message}\n`)
    assert.equal(payload.error_kind, 'adapter_not_enabled')
    assert.equal(payload.error, message)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test('a disabled dependency is named instead of the enabled adapter', async () => {
  await withTempHome(async (home) => {
    // #588: claude is enabled; what blocks it is its gateway dependency.
    const before = writeLocalConfig(home, [
      { name: '@hypaware/ai-gateway', enabled: false },
      { name: '@hypaware/claude' },
    ])
    const { text, payload } = await refusal(home, 'claude', { gatewayCapability: false })
    const message =
      `the claude adapter needs @hypaware/ai-gateway, which is disabled in ${localConfigPath(home)}; ` +
      `set "enabled": true on its plugins[] entry and run 'hyp daemon restart', ` +
      `then re-run 'hyp client attach claude'`
    assert.equal(text, `error: ${message}\n`)
    assert.equal(payload.error_kind, 'adapter_not_enabled')
    assert.equal(payload.error, message)
    assert.doesNotMatch(text, /hyp setup/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test('a disabled dependency outranks an absent adapter, so exactly one blocker is named', async () => {
  await withTempHome(async (home) => {
    // Adding claude would not help while the gateway stays disabled, so the
    // disabled gateway is the one plugin named.
    writeLocalConfig(home, [{ name: '@hypaware/ai-gateway', enabled: false }])
    const { text } = await refusal(home, 'claude', { gatewayCapability: false })
    assert.match(text, /^error: the claude adapter needs @hypaware\/ai-gateway, which is disabled in /)
    assert.doesNotMatch(text, /@hypaware\/claude/)
  })
})

test('a centrally disabled dependency reports adapter_disabled_central and no local remedy', async () => {
  await withTempHome(async (home) => {
    writeCentralConfig(home, {
      version: 2,
      plugins: [{ name: '@hypaware/ai-gateway', enabled: false }],
    })
    const before = writeLocalConfig(home, [{ name: '@hypaware/claude' }])
    const { text, payload } = await refusal(home, 'claude', { gatewayCapability: false })
    const message =
      `the claude adapter needs @hypaware/ai-gateway, which is disabled by your central config; ` +
      `a local config cannot override the central-managed setting`
    assert.equal(text, `error: ${message}\n`)
    assert.equal(payload.error_kind, 'adapter_disabled_central')
    assert.equal(payload.error, message)
    assert.doesNotMatch(text, /hyp setup|hyp daemon restart|"enabled": true/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test('an absent dependency keeps the add path, naming the dependency', async () => {
  await withTempHome(async (home) => {
    const before = writeLocalConfig(home, [{ name: '@hypaware/claude' }])
    const { text, payload } = await refusal(home, 'claude', { gatewayCapability: false })
    const message =
      `the claude adapter needs @hypaware/ai-gateway, which is not enabled on this install; ` +
      `enable it with 'hyp setup', or add @hypaware/ai-gateway to ${localConfigPath(home)} ` +
      `and run 'hyp daemon restart', then re-run 'hyp client attach claude'`
    assert.equal(text, `error: ${message}\n`)
    assert.equal(payload.error_kind, 'adapter_not_enabled')
    assert.equal(payload.error, message)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test('a failed activation names the plugin and the loader kind, never its raw error', async () => {
  await withTempHome(async (home) => {
    const before = writeLocalConfig(home, [
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude' },
    ])
    const activations = [
      { ok: true, plugin: { name: '@hypaware/ai-gateway' } },
      { ok: false, plugin: { name: '@hypaware/claude' }, errorKind: 'TypeError: /home/someone/secret' },
    ]
    const { text, payload } = await refusal(home, 'claude', { registered: ['codex'], activations })
    const message =
      `the claude adapter is enabled, but @hypaware/claude failed to activate this run ` +
      `(activate_failed); run 'hyp status' for why, then re-run 'hyp client attach claude'`
    assert.equal(text, `error: ${message}\n`)
    assert.equal(payload.error_kind, 'adapter_not_enabled')
    assert.equal(payload.error, message)
    assert.doesNotMatch(text, /secret|hyp setup/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test('an unreadable config names the repair path and invents no owner', async () => {
  await withTempHome(async (home) => {
    mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
    const before = '{ "version": 2, "plugins": [\n'
    writeFileSync(localConfigPath(home), before)
    const { text, payload } = await refusal(home, 'claude', { registered: ['codex'] })
    const message =
      `the claude adapter is not active, and its enablement cannot be classified because ` +
      `${localConfigPath(home)} could not be read; run 'hyp config validate' for why, ` +
      `then re-run 'hyp client attach claude'`
    assert.equal(text, `error: ${message}\n`)
    assert.equal(payload.error_kind, 'adapter_not_enabled')
    assert.equal(payload.error, message)
    assert.doesNotMatch(text, /disabled|central|hyp setup/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test('a dependency cycle terminates, and a capability nothing provides is named', async () => {
  await withTempHome(async (home) => {
    // loop-client needs acme.loop-a from loop-dep, which needs acme.loop-b
    // back from loop-client and acme.nowhere from nobody.
    await stageInstalledPlugins(home, [
      {
        name: '@acme/loop-client',
        provides: { capabilities: { 'acme.loop-b': '1.0.0' } },
        requires: { capabilities: { 'acme.loop-a': '^1.0.0' } },
        contributes: { client: { name: 'loopy', skill_dir: '.loopy/skills', attach_probe: probe('loopy') } },
      },
      {
        name: '@acme/loop-dep',
        provides: { capabilities: { 'acme.loop-a': '1.0.0' } },
        requires: { capabilities: { 'acme.loop-b': '^1.0.0', 'acme.nowhere': '^1.0.0' } },
      },
    ])
    writeLocalConfig(home, [])
    const { text, payload } = await refusal(home, 'loopy', { gatewayCapability: false })
    const message =
      `the loopy adapter needs the acme.nowhere capability, which no installed plugin provides; ` +
      `install a plugin that provides it (see 'hyp plugin list'), then re-run 'hyp client attach loopy'`
    assert.equal(text, `error: ${message}\n`)
    assert.equal(payload.error_kind, 'adapter_not_enabled')
    assert.equal(payload.error, message)
  })
})

test('a composed plugin the catalog does not know is named as not installed', async () => {
  await withTempHome(async (home) => {
    await stageInstalledPlugins(home, [
      {
        name: '@acme/needy-client',
        contributes: {
          client: { name: 'needy', skill_dir: '.needy/skills', attach_probe: probe('needy') },
          picker: [{
            name: 'needy',
            label: 'Needy',
            compose: {
              plugin: { name: '@acme/needy-client' },
              plugins: [{ name: '@acme/not-installed' }],
              requires_gateway: true,
            },
          }],
        },
      },
    ])
    writeLocalConfig(home, [{ name: '@acme/needy-client' }])
    const { text } = await refusal(home, 'needy', { gatewayCapability: false })
    assert.equal(
      text,
      `error: the needy adapter needs @acme/not-installed, which is not installed on this machine; ` +
        `install it with 'hyp plugin install @acme/not-installed', then re-run 'hyp client attach needy'\n`
    )
  })
})

/**
 * Stage an installed client whose manifest requires a dependency by name
 * (`requires.plugins`), the edge the boot closure follows as well.
 *
 * @param {string} home
 * @param {{ installDep: boolean }} opts
 */
async function stageDirectClient(home, { installDep }) {
  /** @type {Record<string, unknown>[]} */
  const manifests = [{
    name: '@acme/direct-client',
    requires: { plugins: { '@acme/direct-dep': '^1.0.0' } },
    contributes: { client: { name: 'direct', skill_dir: '.direct/skills', attach_probe: probe('direct') } },
  }]
  if (installDep) manifests.push({ name: '@acme/direct-dep' })
  await stageInstalledPlugins(home, manifests)
}

test('a locally disabled requires.plugins dependency is named', async () => {
  await withTempHome(async (home) => {
    await stageDirectClient(home, { installDep: true })
    const before = writeLocalConfig(home, [
      { name: '@acme/direct-client' },
      { name: '@acme/direct-dep', enabled: false },
    ])
    const { text, payload } = await refusal(home, 'direct', { gatewayCapability: false })
    assert.equal(
      text,
      `error: the direct adapter needs @acme/direct-dep, which is disabled in ${localConfigPath(home)}; ` +
        `set "enabled": true on its plugins[] entry and run 'hyp daemon restart', ` +
        `then re-run 'hyp client attach direct'\n`
    )
    assert.equal(payload.error_kind, 'adapter_not_enabled')
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test('a centrally disabled requires.plugins dependency reports adapter_disabled_central', async () => {
  await withTempHome(async (home) => {
    await stageDirectClient(home, { installDep: true })
    writeCentralConfig(home, { version: 2, plugins: [{ name: '@acme/direct-dep', enabled: false }] })
    const before = writeLocalConfig(home, [{ name: '@acme/direct-client' }])
    const { text, payload } = await refusal(home, 'direct', { gatewayCapability: false })
    assert.equal(
      text,
      `error: the direct adapter needs @acme/direct-dep, which is disabled by your central config; ` +
        `a local config cannot override the central-managed setting\n`
    )
    assert.equal(payload.error_kind, 'adapter_disabled_central')
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test('an absent requires.plugins dependency keeps the add path, naming it', async () => {
  await withTempHome(async (home) => {
    await stageDirectClient(home, { installDep: true })
    writeLocalConfig(home, [{ name: '@acme/direct-client' }])
    const { text, payload } = await refusal(home, 'direct', { gatewayCapability: false })
    assert.match(text, /^error: the direct adapter needs @acme\/direct-dep, which is not enabled on this install; /)
    assert.equal(payload.error_kind, 'adapter_not_enabled')
  })
})

test('a requires.plugins dependency that is not installed is named as not installed', async () => {
  await withTempHome(async (home) => {
    await stageDirectClient(home, { installDep: false })
    writeLocalConfig(home, [{ name: '@acme/direct-client' }])
    const { text, payload } = await refusal(home, 'direct', { gatewayCapability: false })
    assert.equal(
      text,
      `error: the direct adapter needs @acme/direct-dep, which is not installed on this machine; ` +
        `install it with 'hyp plugin install @acme/direct-dep', then re-run 'hyp client attach direct'\n`
    )
    assert.equal(payload.error_kind, 'adapter_not_enabled')
  })
})

test('a requires.plugins cycle terminates and still names the disabled member', async () => {
  await withTempHome(async (home) => {
    await stageInstalledPlugins(home, [
      {
        name: '@acme/ring-client',
        requires: { plugins: { '@acme/ring-dep': '^1.0.0' } },
        contributes: { client: { name: 'ring', skill_dir: '.ring/skills', attach_probe: probe('ring') } },
      },
      { name: '@acme/ring-dep', requires: { plugins: { '@acme/ring-client': '^1.0.0' } } },
    ])
    writeLocalConfig(home, [
      { name: '@acme/ring-client' },
      { name: '@acme/ring-dep', enabled: false },
    ])
    const { text } = await refusal(home, 'ring', { gatewayCapability: false })
    assert.match(text, /^error: the ring adapter needs @acme\/ring-dep, which is disabled in /)
  })
})

test('a registered client still attaches unchanged', async () => {
  await withTempHome(async (home) => {
    const { ctx, stderr } = makeCtx({ home, registered: ['claude'] })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    // Silent: the claude row stopped declaring proxy attach with LLP 0262, so
    // the LLP 0244 migration pointer no longer rides along, and an attach that
    // enables nothing has nothing to say on stderr.
    assert.equal(stderr.text(), '')
  })
})
