// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { CONFIG_BASENAME } from '../../src/core/config/schema.js'
import { pluginScopedConfig } from '../../src/core/config/plugin_scope.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'
import { resolveGatewayBaseUrl } from '../../hypaware-core/plugins-workspace/claude-desktop/src/profile.js'

// `CommandRunContext.config` was the whole effective config, so contributing a
// command (or a verb, whose `operation` receives the same object through
// `buildOperationContext`) handed a plugin every OTHER plugin's config section
// and every configured sink's inline credential - the disclosure #1970 closed
// on `ctx.sinks`, one member over (issue #1978). A plugin's `activate()` has
// only ever seen its own slice.
//
// Every case here drives the real `dispatch()` over a real boot: two installed
// fixture plugins, a real config on disk, and the kernel's own registries.

const OWNER = '@fixture/sink-owner'
const SQUATTER = '@fixture/squatter'

// Obvious placeholders. Nothing here is a credential; the point is only that a
// neighbour's `config` is where an operator's real one would sit.
const SINK_TOKEN = 'PLACEHOLDER-SINK-TOKEN'
const OWNER_API_KEY = 'PLACEHOLDER-OWNER-KEY'

/**
 * What a command body or verb operation can see of the effective config,
 * reduced to the questions this issue is about. Written by the fixture
 * plugin (a separate module the loader imports) into `HYP_FIXTURE_OUT`.
 */
const OBSERVE_SOURCE = `
import nodeFs from 'node:fs'
import nodePath from 'node:path'

export function observe(config, env, file) {
  const plugins = Array.isArray(config?.plugins) ? config.plugins : []
  const entry = (name) => plugins.find((p) => p && p.name === name)
  const sink = config?.sinks?.['org-central']
  const observation = {
    sinkPresent: sink !== undefined,
    sinkToken: sink?.config?.token ?? null,
    sinkPlugin: sink?.plugin ?? null,
    ownConfig: entry(${JSON.stringify(SQUATTER)})?.config ?? null,
    neighbourConfig: entry(${JSON.stringify(OWNER)})?.config ?? null,
    pluginNames: plugins.map((p) => p && p.name),
    version: config?.version ?? null,
    queryDefaultRemote: config?.query?.default_remote ?? null,
  }
  nodeFs.writeFileSync(nodePath.join(env.HYP_FIXTURE_OUT, file), JSON.stringify(observation))
}
`

const OWNER_SOURCE = `
import nodeFs from 'node:fs'
import nodePath from 'node:path'

export async function activate(ctx) {
  ctx.sinks.register({
    name: 'central',
    plugin: ${JSON.stringify(OWNER)},
    supports: [],
    async create() {
      return {
        async exportBatch() { return { exported: true } },
        async close() {},
      }
    },
  })
  ctx.verbs.register({
    name: 'own probe',
    tool: 'owner_probe',
    plugin: ${JSON.stringify(OWNER)},
    summary: 'fixture owner verb',
    inputSchema: { type: 'object', properties: {} },
    async operation(_params, opCtx) {
      const plugins = Array.isArray(opCtx.config?.plugins) ? opCtx.config.plugins : []
      const entry = (name) => plugins.find((p) => p && p.name === name)
      nodeFs.writeFileSync(nodePath.join(opCtx.env.HYP_FIXTURE_OUT, 'owner-verb.json'), JSON.stringify({
        ownConfig: entry(${JSON.stringify(OWNER)})?.config ?? null,
        neighbourConfig: entry(${JSON.stringify(SQUATTER)})?.config ?? null,
        sinkToken: opCtx.config?.sinks?.['org-central']?.config?.token ?? null,
      }))
      return { ok: true }
    },
    render() {
      return { stdout: 'owner probed\\n' }
    },
  })
}
`

const SQUATTER_SOURCE = `
import { observe } from './observe.js'

export async function activate(ctx) {
  ctx.commands.register({
    name: 'squat peek',
    plugin: ${JSON.stringify(SQUATTER)},
    summary: 'fixture command',
    usage: 'hyp squat peek',
    async run(_argv, cmdCtx) {
      observe(cmdCtx.config, cmdCtx.env, 'command.json')
      return 0
    },
  })
  ctx.verbs.register({
    name: 'squat probe',
    tool: 'squat_probe',
    plugin: ${JSON.stringify(SQUATTER)},
    summary: 'fixture verb',
    inputSchema: { type: 'object', properties: {} },
    async operation(_params, opCtx) {
      observe(opCtx.config, opCtx.env, 'verb.json')
      return { ok: true }
    },
    render() {
      return { stdout: 'probed\\n' }
    },
  })
}
`

/**
 * Materialize an installed-plugin fixture under `<hypHome>/hypaware/plugins`.
 * Mirrors `test/core/boot-installed.test.js`: what `hyp plugin install` lands
 * on disk, without running the install pipeline.
 *
 * @param {{ hypHome: string, name: string, files: Record<string, string>, manifest?: Record<string, unknown> }} args
 * @returns {Promise<{ name: string, version: string, installDir: string }>}
 */
async function stageInstalledPlugin({ hypHome, name, files, manifest }) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', name)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(
    path.join(installDir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '0.1.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      ...manifest,
    })
  )
  for (const [file, body] of Object.entries(files)) {
    await fs.writeFile(path.join(installDir, file), body)
  }
  return { name, version: '0.1.0', installDir }
}

/**
 * @param {string} hypHome
 * @param {Array<{ name: string, version: string, installDir: string }>} entries
 */
async function writeFixtureLock(hypHome, entries) {
  /** @type {Record<string, unknown>} */
  const plugins = {}
  for (const e of entries) {
    plugins[e.name] = {
      name: e.name,
      version: e.version,
      source: { kind: 'local-dir', raw: e.installDir, path: e.installDir },
      install_dir: e.installDir,
      content_hash: 'a'.repeat(64),
      manifest_hash: 'b'.repeat(64),
      installed_at: '2026-05-21T00:00:00.000Z',
    }
  }
  await writeLock(path.join(hypHome, 'hypaware'), /** @type {any} */ ({ schema_version: 1, plugins }))
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    write(/** @type {string} */ chunk) { chunks.push(String(chunk)); return true },
    text: () => chunks.join(''),
  }
}

/**
 * One real boot: two installed fixture plugins, a config that gives the sink
 * owner an inline token and a private key of its own, and a command registry
 * carrying core's commands plus one registered the way core registers (outside
 * any plugin bracket), so the core half of the split is measurable too.
 */
async function stage() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cmd-config-scope-'))
  const out = path.join(hypHome, 'observed')
  await fs.mkdir(out, { recursive: true })
  const owner = await stageInstalledPlugin({
    hypHome,
    name: OWNER,
    files: { 'index.js': OWNER_SOURCE },
  })
  const squatter = await stageInstalledPlugin({
    hypHome,
    name: SQUATTER,
    files: { 'index.js': SQUATTER_SOURCE, 'observe.js': OBSERVE_SOURCE },
  })
  await writeFixtureLock(hypHome, [owner, squatter])
  await fs.writeFile(
    path.join(hypHome, CONFIG_BASENAME),
    JSON.stringify({
      version: 2,
      plugins: [
        { name: OWNER, config: { api_key: OWNER_API_KEY } },
        { name: SQUATTER, config: { mine: 'visible' } },
      ],
      sinks: {
        'org-central': {
          plugin: OWNER,
          config: { schedule: '* * * * *', endpoint: 'https://central.example', token: SINK_TOKEN },
        },
      },
      query: {
        remotes: { 'fixture-remote': { url: 'https://remote.example/mcp' } },
        default_remote: 'fixture-remote',
      },
    })
  )

  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  registry.register({
    name: 'core probe',
    summary: 'fixture core command',
    usage: 'hyp core probe',
    async run(_argv, ctx) {
      const { observe } = await import(path.join(squatter.installDir, 'observe.js'))
      observe(ctx.config, ctx.env, 'core.json')
      return 0
    },
  })

  return { hypHome, out, registry }
}

/**
 * @param {Awaited<ReturnType<typeof stage>>} staged
 * @param {string[]} argv
 * @param {NodeJS.ReadableStream} [stdin] the client channel, for `hyp mcp`
 */
async function invoke(staged, argv, stdin) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(argv, {
    stdout,
    stderr,
    ...(stdin ? { stdin: /** @type {any} */ (stdin) } : {}),
    env: {
      ...process.env,
      HYP_HOME: staged.hypHome,
      HYP_FIXTURE_OUT: staged.out,
      HYP_DEV_TELEMETRY: '',
    },
    cwd: staged.hypHome,
    registry: staged.registry,
    workspaceDir: path.join(staged.hypHome, 'no-bundled'),
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

/**
 * @param {Awaited<ReturnType<typeof stage>>} staged
 * @param {string} file
 */
async function observation(staged, file) {
  return JSON.parse(await fs.readFile(path.join(staged.out, file), 'utf8'))
}

test('a plugin-owned command body reads no config section its plugin does not own', async () => {
  const staged = await stage()
  try {
    const run = await invoke(staged, ['squat', 'peek'])
    assert.equal(run.code, 0, run.stderr)
    const seen = await observation(staged, 'command.json')

    assert.equal(seen.sinkPresent, true, 'the configured sink instance stopped being visible at all')
    assert.equal(seen.sinkToken, null, 'a plugin command read a neighbour sink\'s inline token')
    assert.equal(seen.neighbourConfig, null, 'a plugin command read another plugin\'s config section')
    assert.deepEqual(seen.ownConfig, { mine: 'visible' }, 'a plugin command lost its own config section')
    assert.deepEqual(seen.pluginNames, [OWNER, SQUATTER], 'the plugin roster stopped being visible')
    assert.equal(seen.version, 2)
    assert.equal(seen.queryDefaultRemote, 'fixture-remote', 'the kernel query block stopped being visible')
  } finally {
    await fs.rm(staged.hypHome, { recursive: true, force: true })
  }
})

test('a verb a plugin registered gets the same narrowing on its operation config', async () => {
  const staged = await stage()
  try {
    const run = await invoke(staged, ['squat', 'probe'])
    assert.equal(run.code, 0, run.stderr)
    assert.equal(run.stdout, 'probed\n')
    const seen = await observation(staged, 'verb.json')

    assert.equal(seen.sinkPresent, true, 'the configured sink instance stopped being visible at all')
    assert.equal(seen.sinkToken, null, 'a plugin verb operation read a neighbour sink\'s inline token')
    assert.equal(seen.neighbourConfig, null, 'a plugin verb operation read another plugin\'s config section')
    assert.deepEqual(seen.ownConfig, { mine: 'visible' }, 'a plugin verb operation lost its own config section')
    assert.equal(seen.queryDefaultRemote, 'fixture-remote', 'the kernel query block stopped being visible')
  } finally {
    await fs.rm(staged.hypHome, { recursive: true, force: true })
  }
})

/**
 * Drive one MCP stdio session over the staged boot: the Readable ends after
 * the last line, so `hyp mcp` sees EOF, stops serving and exits 0.
 *
 * @param {Awaited<ReturnType<typeof stage>>} staged
 * @param {string[]} tools tool names to call, one `tools/call` each
 */
async function mcpSession(staged, tools) {
  const requests = tools.map((name, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'tools/call',
    params: { name, arguments: {} },
  }))
  const stdin = Readable.from(requests.map((r) => JSON.stringify(r) + '\n'))
  const run = await invoke(staged, ['mcp'], /** @type {any} */ (stdin))
  const responses = run.stdout.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l))
  return { ...run, responses }
}

// The same verb, reached as an MCP tool instead of through its projected CLI
// command. `hyp mcp` is a core command, so its own context carries the whole
// effective config, and every tool call was run against it: the surface that
// exists to hand a verb to an AI client read out every other plugin's section
// and a configured sink's inline credential (issue #1982).
test('a verb reached as an MCP tool reads the same narrowed config its CLI projection does', async () => {
  const staged = await stage()
  try {
    const run = await mcpSession(staged, ['squat_probe'])
    assert.equal(run.code, 0, run.stderr)
    assert.equal(run.responses.length, 1, run.stdout)
    assert.equal(run.responses[0]?.result?.isError, false, run.stdout)
    const seen = await observation(staged, 'verb.json')

    assert.equal(seen.sinkPresent, true, 'the configured sink instance stopped being visible at all')
    assert.equal(seen.sinkToken, null, 'an MCP tool call read a neighbour sink\'s inline token')
    assert.equal(seen.neighbourConfig, null, 'an MCP tool call read another plugin\'s config section')
    assert.deepEqual(seen.ownConfig, { mine: 'visible' }, 'an MCP tool call lost its own plugin\'s config section')
    assert.deepEqual(seen.pluginNames, [OWNER, SQUATTER], 'the plugin roster stopped being visible')
    assert.equal(seen.version, 2)
    assert.equal(seen.queryDefaultRemote, 'fixture-remote', 'the kernel query block stopped being visible')
  } finally {
    await fs.rm(staged.hypHome, { recursive: true, force: true })
  }
})

// One session, two owners: the slice is resolved per tool call, not once for
// the host. The sink owner still reads the sink instance it composes, which is
// what tells a narrowing apart from a blanket redaction.
test('two plugins\' tools in one MCP session each read their own slice', async () => {
  const staged = await stage()
  try {
    const run = await mcpSession(staged, ['squat_probe', 'owner_probe'])
    assert.equal(run.code, 0, run.stderr)
    assert.equal(run.responses.length, 2, run.stdout)
    for (const response of run.responses) {
      assert.equal(response?.result?.isError, false, run.stdout)
    }

    const squatter = await observation(staged, 'verb.json')
    assert.equal(squatter.neighbourConfig, null, 'the squatter\'s tool read the sink owner\'s config section')
    assert.equal(squatter.sinkToken, null, 'the squatter\'s tool read a sink instance it composes no part of')

    const owner = await observation(staged, 'owner-verb.json')
    assert.deepEqual(owner.ownConfig, { api_key: OWNER_API_KEY }, 'the sink owner\'s tool lost its own config section')
    assert.equal(owner.neighbourConfig, null, 'the sink owner\'s tool read the squatter\'s config section')
    assert.equal(owner.sinkToken, SINK_TOKEN, 'the sink owner\'s tool lost the sink instance it composes')
  } finally {
    await fs.rm(staged.hypHome, { recursive: true, force: true })
  }
})

// The one widening the slice makes: a declared capability requirer keeps its
// provider's `plugins[]` section. The bundled case is `@hypaware/claude-desktop`
// resolving `@hypaware/ai-gateway`'s pinned `listen` (LLP 0422 #scope); these
// fixtures prove the rule through the real `dispatch()`, in both directions.
const CAP_PROVIDER = '@fixture/cap-gateway'
const CAP_REQUIRER = '@fixture/desktop'

const CAP_PROVIDER_SOURCE = `
import nodeFs from 'node:fs'
import nodePath from 'node:path'

export async function activate(ctx) {
  ctx.commands.register({
    name: 'prov peek',
    plugin: ${JSON.stringify(CAP_PROVIDER)},
    summary: 'fixture provider command',
    usage: 'hyp prov peek',
    async run(_argv, cmdCtx) {
      const entry = (name) => (cmdCtx.config?.plugins ?? []).find((p) => p && p.name === name)
      nodeFs.writeFileSync(nodePath.join(cmdCtx.env.HYP_FIXTURE_OUT, 'provider.json'), JSON.stringify({
        requirerConfig: entry(${JSON.stringify(CAP_REQUIRER)})?.config ?? null,
        ownConfig: entry(${JSON.stringify(CAP_PROVIDER)})?.config ?? null,
      }))
      return 0
    },
  })
}
`

const CAP_REQUIRER_SOURCE = `
import nodeFs from 'node:fs'
import nodePath from 'node:path'

export async function activate(ctx) {
  ctx.commands.register({
    name: 'desk peek',
    plugin: ${JSON.stringify(CAP_REQUIRER)},
    summary: 'fixture requirer command',
    usage: 'hyp desk peek',
    async run(_argv, cmdCtx) {
      const entry = (name) => (cmdCtx.config?.plugins ?? []).find((p) => p && p.name === name)
      nodeFs.writeFileSync(nodePath.join(cmdCtx.env.HYP_FIXTURE_OUT, 'requirer.json'), JSON.stringify({
        providerConfig: entry(${JSON.stringify(CAP_PROVIDER)})?.config ?? null,
        ownConfig: entry(${JSON.stringify(CAP_REQUIRER)})?.config ?? null,
        unrelatedConfig: entry(${JSON.stringify(OWNER)})?.config ?? null,
        sinkToken: cmdCtx.config?.sinks?.['org-central']?.config?.token ?? null,
      }))
      return 0
    },
  })
}
`

/**
 * A second staged boot: a capability provider with a pinned setting, the
 * plugin whose manifest requires that capability, and an unrelated third
 * plugin owning a sink with an inline token.
 */
async function stageCapabilityPair() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cmd-config-cap-'))
  const out = path.join(hypHome, 'observed')
  await fs.mkdir(out, { recursive: true })
  const provider = await stageInstalledPlugin({
    hypHome,
    name: CAP_PROVIDER,
    files: { 'index.js': CAP_PROVIDER_SOURCE },
    manifest: { provides: { capabilities: { 'fixture.gateway': '2.0.0' } } },
  })
  const requirer = await stageInstalledPlugin({
    hypHome,
    name: CAP_REQUIRER,
    files: { 'index.js': CAP_REQUIRER_SOURCE },
    manifest: { requires: { capabilities: { 'fixture.gateway': '^2.0.0' } } },
  })
  const owner = await stageInstalledPlugin({
    hypHome,
    name: OWNER,
    files: { 'index.js': OWNER_SOURCE },
  })
  await writeFixtureLock(hypHome, [provider, requirer, owner])
  await fs.writeFile(
    path.join(hypHome, CONFIG_BASENAME),
    JSON.stringify({
      version: 2,
      plugins: [
        { name: CAP_PROVIDER, config: { listen: '127.0.0.1:9911' } },
        { name: CAP_REQUIRER, config: { mine: 'visible' } },
        { name: OWNER, config: { api_key: OWNER_API_KEY } },
      ],
      sinks: {
        'org-central': {
          plugin: OWNER,
          config: { schedule: '* * * * *', endpoint: 'https://central.example', token: SINK_TOKEN },
        },
      },
    })
  )
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  return { hypHome, out, registry }
}

test('a declared capability requirer keeps its provider\'s config section, and only that', async () => {
  const staged = await stageCapabilityPair()
  try {
    const run = await invoke(staged, ['desk', 'peek'])
    assert.equal(run.code, 0, run.stderr)
    const seen = await observation(staged, 'requirer.json')

    assert.deepEqual(seen.providerConfig, { listen: '127.0.0.1:9911' },
      'the requirer lost the config of the capability provider its manifest declares')
    assert.deepEqual(seen.ownConfig, { mine: 'visible' })
    assert.equal(seen.unrelatedConfig, null, 'the widening leaked an undeclared neighbour\'s config section')
    assert.equal(seen.sinkToken, null, 'the widening leaked a sink instance\'s inline token')
  } finally {
    await fs.rm(staged.hypHome, { recursive: true, force: true })
  }
})

test('the capability edge is directed: the provider does not read its requirer\'s config', async () => {
  const staged = await stageCapabilityPair()
  try {
    const run = await invoke(staged, ['prov', 'peek'])
    assert.equal(run.code, 0, run.stderr)
    const seen = await observation(staged, 'provider.json')

    assert.equal(seen.requirerConfig, null, 'providing a capability granted a read of the requirer\'s config')
    assert.deepEqual(seen.ownConfig, { listen: '127.0.0.1:9911' })
  } finally {
    await fs.rm(staged.hypHome, { recursive: true, force: true })
  }
})

// Binds the shipped cross-plugin reader to the slice without a darwin boot:
// `@hypaware/claude-desktop`'s real manifest and real `resolveGatewayBaseUrl`
// over the slice `dispatch()` would hand its commands. Fails at the pre-fix
// head: the scoped config lost the gateway's `listen`, so the profile pointed
// at the fixed default and the LLP 0115 ephemeral refusal was unreachable.
test('claude-desktop resolves the gateway pinned listen through its slice, and still refuses an ephemeral one', async () => {
  const workspace = path.join(import.meta.dirname, '..', '..', 'hypaware-core', 'plugins-workspace')
  /** @param {string} dir */
  const manifestOf = async (dir) =>
    JSON.parse(await fs.readFile(path.join(workspace, dir, 'hypaware.plugin.json'), 'utf8'))
  const gateway = await manifestOf('ai-gateway')
  const desktop = await manifestOf('claude-desktop')
  const activePlugins = [
    { name: gateway.name, version: gateway.version, manifest: gateway, rootDir: path.join(workspace, 'ai-gateway') },
    { name: desktop.name, version: desktop.version, manifest: desktop, rootDir: path.join(workspace, 'claude-desktop') },
  ]
  /** @param {string} listen */
  const configWith = (listen) => ({
    version: 2,
    plugins: [
      { name: gateway.name, config: { listen } },
      { name: desktop.name },
      { name: OWNER, config: { api_key: OWNER_API_KEY } },
    ],
  })

  const scoped = pluginScopedConfig(/** @type {any} */ (configWith('127.0.0.1:9911')), desktop.name, /** @type {any} */ (activePlugins))
  assert.equal(
    resolveGatewayBaseUrl({ hypConfig: scoped, sectionConfig: {} }),
    'http://127.0.0.1:9911',
    'the Desktop profile lost the operator\'s pinned gateway listen'
  )
  assert.equal(
    scoped.plugins?.find((p) => p.name === OWNER)?.config,
    undefined,
    'the widening kept a section claude-desktop\'s manifest declares no edge to'
  )

  const ephemeral = pluginScopedConfig(/** @type {any} */ (configWith('127.0.0.1:0')), desktop.name, /** @type {any} */ (activePlugins))
  assert.throws(
    () => resolveGatewayBaseUrl({ hypConfig: ephemeral, sectionConfig: {} }),
    /ephemeral/,
    'the LLP 0115 ephemeral-listen refusal became unreachable through the slice'
  )
})

test('a core command still receives the whole effective config', async () => {
  const staged = await stage()
  try {
    const run = await invoke(staged, ['core', 'probe'])
    assert.equal(run.code, 0, run.stderr)
    const seen = await observation(staged, 'core.json')

    assert.equal(seen.sinkToken, SINK_TOKEN, 'a core command lost the configured sink\'s own settings')
    assert.deepEqual(seen.neighbourConfig, { api_key: OWNER_API_KEY }, 'a core command lost a plugin config section')
    assert.deepEqual(seen.ownConfig, { mine: 'visible' })
    assert.equal(seen.queryDefaultRemote, 'fixture-remote')
  } finally {
    await fs.rm(staged.hypHome, { recursive: true, force: true })
  }
})
