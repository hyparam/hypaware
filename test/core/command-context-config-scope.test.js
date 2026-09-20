// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { CONFIG_BASENAME } from '../../src/core/config/schema.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

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
export async function activate(ctx) {
  ctx.sinks.register({
    name: 'central',
    plugin: ${JSON.stringify(OWNER)},
    async create() {
      return {
        async exportBatch() { return { exported: true } },
        async close() {},
      }
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
 * @param {{ hypHome: string, name: string, files: Record<string, string> }} args
 * @returns {Promise<{ name: string, version: string, installDir: string }>}
 */
async function stageInstalledPlugin({ hypHome, name, files }) {
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
 */
async function invoke(staged, argv) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(argv, {
    stdout,
    stderr,
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
