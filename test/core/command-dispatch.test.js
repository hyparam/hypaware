// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'
import { runClaudeSessionContextHook } from '../../hypaware-core/plugins-workspace/claude/src/hook_command.js'

function hookKernelAndRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  registry.register({
    name: 'claude-hook session-context',
    summary: 'Internal Claude Code hook',
    usage: 'hyp claude-hook session-context --state-file <path>',
    hidden: true,
    run: runClaudeSessionContextHook,
  })
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { kernel, registry }
}

test('Claude session-context hook exits 0 without --state-file', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-'))
  const stdout = makeBuf()
  const stderr = makeBuf()
  const { kernel, registry: hookRegistry } = hookKernelAndRegistry()

  const code = await dispatch(
    ['claude-hook', 'session-context'],
    {
      stdout,
      stderr,
      stdin: stdinFor(''),
      env: { ...process.env, HYP_HOME: hypHome },
      registry: hookRegistry,
      kernel,
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')
})

test('Claude session-context hook appends one JSONL record per event to --state-file', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-'))
  const stateFile = path.join(hypHome, 'session-context.jsonl')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const { kernel, registry: hookRegistry } = hookKernelAndRegistry()

  const code = await dispatch(
    ['claude-hook', 'session-context', '--state-file', stateFile],
    {
      stdout,
      stderr,
      stdin: stdinFor({
        session_id: 'sess-hook',
        cwd: '/tmp/not-a-git-repo',
        transcript_path: '/tmp/sess-hook.jsonl',
        hook_event_name: 'SessionStart',
      }),
      env: { ...process.env, HYP_HOME: hypHome },
      registry: hookRegistry,
      kernel,
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')

  const contents = await fs.readFile(stateFile, 'utf8')
  const lines = contents.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.session_id, 'sess-hook')
  assert.equal(record.cwd, '/tmp/not-a-git-repo')
  assert.equal(record.transcript_path, '/tmp/sess-hook.jsonl')
  assert.equal(typeof record.ts, 'string')
})

test('Claude session-context hook ignores events without session context', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-'))
  const stateFile = path.join(hypHome, 'session-context.jsonl')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const { kernel, registry: hookRegistry } = hookKernelAndRegistry()

  const code = await dispatch(
    ['claude-hook', 'session-context', '--state-file', stateFile],
    {
      stdout,
      stderr,
      stdin: stdinFor({ cwd: '/tmp/not-a-git-repo' }),
      env: { ...process.env, HYP_HOME: hypHome },
      registry: hookRegistry,
      kernel,
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')
  await assert.rejects(fs.stat(stateFile), { code: 'ENOENT' })
})

test('legacy Claude session-context hook --port writes the default plugin state file', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-legacy-'))
  const stdout = makeBuf()
  const stderr = makeBuf()
  const { kernel, registry: hookRegistry } = hookKernelAndRegistry()

  const code = await dispatch(
    ['claude-hook', 'session-context', '--port', '4388'],
    {
      stdout,
      stderr,
      stdin: stdinFor({
        session_id: 'sess-legacy',
        cwd: '/tmp/not-a-git-repo',
        transcript_path: '/tmp/sess-legacy.jsonl',
      }),
      env: { ...process.env, HYP_HOME: hypHome },
      registry: hookRegistry,
      kernel,
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')

  const stateFile = path.join(
    hypHome,
    'hypaware',
    'plugins',
    '@hypaware',
    'claude',
    'session-context.jsonl'
  )
  const contents = await fs.readFile(stateFile, 'utf8')
  const lines = contents.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.session_id, 'sess-legacy')
  assert.equal(record.cwd, '/tmp/not-a-git-repo')
  assert.equal(record.transcript_path, '/tmp/sess-legacy.jsonl')
})

test('hidden Claude hook command is omitted from top-level help', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], { stdout, stderr })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  assert.equal(stdout.text().includes('claude-hook'), false)
})

test('top-level help lists commands declared by config-active plugins', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-help-plugins-'))
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({
      version: 2,
      plugins: [{ name: '@hypaware/context-graph' }, { name: '@hypaware/vector-search' }],
    })
  )
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], { stdout, stderr, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' } })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  const out = stdout.text()
  // context-graph is in the default surface; vector-search is excluded
  // from default but config-enabled here: both must appear as collapsed
  // group rows. vector-search declares a bare `vector` command, so its
  // manifest summary speaks for the group; context-graph has no bare
  // `graph`, so the row synthesizes its subcommand listing.
  assert.match(out, /graph\s+Subcommands: compact, neighbors, project/)
  assert.match(out, /vector\s+Vector similarity search/)
  // Leaf subcommands are collapsed out of top-level help.
  assert.equal(out.includes('graph project'), false)
  assert.equal(out.includes('vector search'), false)
  // A plugin whose name is not in the config must stay out of help.
  assert.equal(out.includes('enrich'), false)
})

test('top-level help lists a local plugin addition on a fleet-joined host', async () => {
  // Regression: help must resolve the effective config the same way
  // `bootKernel` does: with the discovered plugin catalog. A joined host
  // has a central layer; the merge validator, run WITHOUT the catalog,
  // treats every bundled plugin as unknown and drops the local `plugins[]`
  // addition (`@hypaware/context-graph`), so help would hide `graph`
  // commands that actually dispatch.
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-help-joined-'))
  const controlDir = path.join(hypHome, 'hypaware', 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  // Central layer (authoritative, fleet-owned): does NOT include the graph.
  await fs.writeFile(
    path.join(controlDir, 'seed.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/local-fs' }] })
  )
  // Local layer (user-owned, additive) adds the graph.
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/context-graph' }] })
  )
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], { stdout, stderr, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' } })

  assert.equal(code, 0)
  assert.match(stdout.text(), /graph\s+Subcommands: compact, neighbors, project/)
})

test('top-level help omits plugin commands when the plugin is disabled', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-help-disabled-'))
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/context-graph', enabled: false }] })
  )
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], { stdout, stderr, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' } })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  assert.equal(stdout.text().includes('graph'), false)
})

/**
 * Stage a synthetic bundled plugin under `workspaceDir` whose manifest
 * declares the given help commands. Mirrors the shape `discoverBundledPlugins`
 * walks (a directory holding `hypaware.plugin.json`).
 *
 * @param {{ workspaceDir: string, name: string, commands: { name: string, summary: string }[] }} args
 */
async function stageBundledPlugin({ workspaceDir, name, commands }) {
  const dir = path.join(workspaceDir, name.replace(/^@hypaware\//, ''))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '0.0.1',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      contributes: { commands },
    })
  )
  await fs.writeFile(path.join(dir, 'index.js'), 'export async function activate() {}\n')
}

/**
 * Stage an installed plugin under `<hypHome>/hypaware/plugins/<name>` and
 * register it in `plugin-lock.json`, with a manifest declaring the given
 * help commands. Mirrors what `hyp plugin install` lands on disk.
 *
 * @param {{ hypHome: string, name: string, commands: { name: string, summary: string }[] }} args
 */
async function stageInstalledPlugin({ hypHome, name, commands }) {
  const stateDir = path.join(hypHome, 'hypaware')
  const installDir = path.join(stateDir, 'plugins', name)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(
    path.join(installDir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      contributes: { commands },
    })
  )
  await fs.writeFile(path.join(installDir, 'index.js'), 'export async function activate() {}\n')
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
        installed_at: '2026-05-21T00:00:00.000Z',
      },
    },
  })
}

test('top-level help lists the installed plugin that replaces an excluded bundled skeleton, not the skeleton it shadows', async () => {
  // Regression: help must replicate boot's plugin SELECTION. An installed
  // plugin whose name matches an excluded bundled skeleton (`@hypaware/gascity`)
  // *replaces* it in the boot pool, so dispatch runs the installed plugin's
  // commands. A hand-rolled help pool that kept both would advertise the
  // skeleton's commands as phantoms that never dispatch.
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-help-replace-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/gascity',
    commands: [
      { name: 'gascity attach', summary: 'attach (bundled skeleton)' },
      { name: 'gascity phantom', summary: 'only the skeleton declares this' },
    ],
  })
  await stageInstalledPlugin({
    hypHome,
    name: '@hypaware/gascity',
    commands: [
      { name: 'gascity attach', summary: 'attach (installed winner)' },
      { name: 'gascity real', summary: 'only the installed plugin declares this' },
    ],
  })
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/gascity' }] })
  )
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
  })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  const out = stdout.text()
  // The installed plugin is the boot winner: the collapsed `gascity`
  // group row lists ITS subcommands (attach, real), which is what
  // dispatch would run.
  assert.match(out, /gascity\s+Subcommands: attach, real/)
  // The replaced skeleton's commands never dispatch: they must not appear.
  assert.equal(out.includes('phantom'), false)
  assert.equal(out.includes('bundled skeleton'), false)
})

test('top-level help advertises no commands for an installed plugin that shadows a bundled first-party name', async () => {
  // Regression: an installed plugin shadowing a bundled first-party plugin
  // makes real boot reject before any command dispatches. Help must not
  // advertise either side's commands: none of them will ever run.
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-help-shadow-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/ai-gateway',
    commands: [{ name: 'gateway bundled', summary: 'bundled gateway command' }],
  })
  await stageInstalledPlugin({
    hypHome,
    name: '@hypaware/ai-gateway',
    commands: [{ name: 'gateway installed', summary: 'installed gateway command' }],
  })
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] })
  )
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
  })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  const out = stdout.text()
  assert.equal(out.includes('gateway bundled'), false)
  assert.equal(out.includes('gateway installed'), false)
})

function groupKernelAndRegistry() {
  const registry = createCommandRegistry()
  for (const name of ['graph neighbors', 'graph project', 'graph compact']) {
    registry.register({
      name,
      summary: `test ${name}`,
      usage: `hyp ${name}`,
      async run() {
        return 0
      },
    })
  }
  registry.register({
    name: 'graph secret',
    summary: 'hidden subcommand',
    usage: 'hyp graph secret',
    hidden: true,
    async run() {
      return 0
    },
  })
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { kernel, registry }
}

test('bare group with no command of its own renders synthesized group help', async () => {
  const { kernel, registry } = groupKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['graph'], { stdout, stderr, registry, kernel })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  // Direct children, sorted, with summaries; the hidden `secret`
  // subcommand is omitted.
  assert.equal(
    stdout.text(),
    [
      'usage: hyp graph <subcommand> [args...]',
      '',
      'Subcommands:',
      '  compact    test graph compact',
      '  neighbors  test graph neighbors',
      '  project    test graph project',
      '',
      "Run 'hyp graph <subcommand> --help' for subcommand-specific help.",
      '',
    ].join('\n')
  )
})

test('group --help renders synthesized group help', async () => {
  const { kernel, registry } = groupKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['graph', '--help'], { stdout, stderr, registry, kernel })

  assert.equal(code, 0)
  assert.match(stdout.text(), /usage: hyp graph <subcommand>/)
})

test('group with an unknown subcommand reports it and exits 2', async () => {
  const { kernel, registry } = groupKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['graph', 'bogus'], { stdout, stderr, registry, kernel })

  assert.equal(code, 2)
  assert.equal(stdout.text(), '')
  assert.match(stderr.text(), /hyp graph: unknown subcommand 'bogus'/)
  assert.match(stderr.text(), /expected one of: compact, neighbors, project/)
})

test('top-level help collapses subcommands into one row per group', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], { stdout, stderr })

  assert.equal(code, 0)
  const out = stdout.text()
  // Group rows carry the bare command's summary.
  assert.match(out, /^ {2}query\s+Query the local cache/m)
  assert.match(out, /^ {2}daemon\s+Manage the HypAware daemon/m)
  assert.match(out, /^ {2}plugin\s+Manage plugins/m)
  assert.match(out, /^ {2}agents\s+Manage subagents for AI clients/m)
  // Subcommands live in group help, not at the top level.
  assert.equal(out.includes('query sql'), false)
  assert.equal(out.includes('daemon install'), false)
  assert.equal(out.includes('plugin install'), false)
  assert.equal(out.includes('backfill plan'), false)
})

function coreKernelAndRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { kernel, registry }
}

test('group --help lists subcommands with their registry summaries', async () => {
  const { kernel, registry } = coreKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['query', '--help'], { stdout, stderr, registry, kernel })

  assert.equal(code, 0)
  const out = stdout.text()
  assert.match(out, /^hyp query - Query the local cache/)
  assert.match(out, /usage: hyp query <subcommand> \[args\.\.\.\]/)
  assert.match(out, /^ {2}schema\s+Print the schema for a dataset/m)
  assert.match(out, /^ {2}sql\s+Run a SQL query against registered datasets/m)
  assert.match(out, /^ {2}maintain\s+Run cache maintenance/m)
})

test('an action command with subcommands gets group help on --help', async () => {
  const { kernel, registry } = coreKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['backfill', '--help'], { stdout, stderr, registry, kernel })

  assert.equal(code, 0)
  const out = stdout.text()
  // The bare command's own usage (it runs the import itself)...
  assert.match(out, /usage: hyp backfill \[provider\.\.\.\]/)
  // ...plus its subcommands.
  assert.match(out, /^ {2}list\s+List registered backfill providers/m)
  assert.match(out, /^ {2}plan\s+Show what each backfill provider would scan/m)
})

test('leaf command --help renders summary, usage, and long help', async () => {
  const { kernel, registry } = coreKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['ignore', '--help'], { stdout, stderr, registry, kernel })

  assert.equal(code, 0)
  const out = stdout.text()
  assert.match(out, /^hyp ignore - Exclude a folder subtree/)
  assert.match(out, /usage: hyp ignore \[path\] \[--check\] \[--json\] \[--local-only \| --private \| --sync\]/)
  assert.match(out, /Writes a \.hypignore/)
})

test('a leaf subcommand --help documents every flag the command accepts', async () => {
  const { kernel, registry } = coreKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['daemon', 'install', '--help'], { stdout, stderr, registry, kernel })

  assert.equal(code, 0)
  const out = stdout.text()
  // Central `--help` interception renders the registration usage, so the
  // registration must list --bin (the command still accepts it).
  assert.match(out, /usage: hyp daemon install/)
  assert.match(out, /--bin <path>/)
})

test('bare group command with an unknown subcommand reports the registry children', async () => {
  const { kernel, registry } = coreKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['query', 'bogus'], { stdout, stderr, registry, kernel })

  assert.equal(code, 2)
  assert.match(stderr.text(), /hyp query: unknown subcommand 'bogus'/)
  assert.match(stderr.text(), /expected one of: maintain, refresh, schema, sql, status/)
})

test('a token that is neither a command nor a group prefix still errors', async () => {
  const { kernel, registry } = groupKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['totallybogus'], { stdout, stderr, registry, kernel })

  assert.equal(code, 2)
  assert.match(stderr.text(), /hyp: unknown command 'totallybogus'/)
})

test('dispatch surfaces boot-path sink materialization warnings', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-sink-warning-'))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/local-fs' }],
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
      },
    },
  }))

  const registry = createCommandRegistry()
  registry.register({
    name: 'noop',
    summary: 'Test command',
    usage: 'hyp noop',
    async run() { return 0 },
  })
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['noop'], {
    stdout,
    stderr,
    registry,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.match(
    stderr.text(),
    /warning: sink 'local' not materialized \[sink_plugin_not_active\]/
  )
})

test('zero-plugin lifecycle commands skip sink materialization warnings; config-profile commands still warn', async () => {
  // Regression for #219: lifecycle/read-only commands (`status`, `daemon`,
  // `version`, …) boot with `{ activate: [] }`, so no writer/destination
  // plugin is ever loaded and no configured sink can materialize. Emitting a
  // `sink_plugin_not_active` warning per sink there is structurally
  // guaranteed noise. The warning must only survive when the command
  // actually intended to activate those plugins (the `config` profile).
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-lifecycle-sink-warning-'))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/local-fs' }],
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
      },
    },
  }))
  const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath }

  /** @param {string[]} argv */
  async function run(argv) {
    const registry = createCommandRegistry()
    // `status` → lifecycle boot profile `{ activate: [] }`.
    // `noop`   → ordinary `config` boot profile.
    registry.register({ name: 'status', summary: 'Test lifecycle command', usage: 'hyp status', async run() { return 0 } })
    registry.register({ name: 'noop', summary: 'Test config command', usage: 'hyp noop', async run() { return 0 } })
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(argv, { stdout, stderr, registry, env })
    return { code, stdout: stdout.text(), stderr: stderr.text() }
  }

  // Zero-plugin lifecycle command: must NOT emit the guaranteed-noise warning.
  const lifecycle = await run(['status'])
  assert.equal(lifecycle.code, 0)
  assert.equal(
    lifecycle.stderr.includes('sink_plugin_not_active'),
    false,
    `lifecycle command must not warn; got stderr: ${JSON.stringify(lifecycle.stderr)}`
  )

  // Config-profile command over the SAME config: it activates config plugins
  // and genuinely expected the sink's writer to be active, so a real
  // misconfiguration (writer plugin not enabled) must still surface.
  const ordinary = await run(['noop'])
  assert.equal(ordinary.code, 0)
  assert.match(
    ordinary.stderr,
    /warning: sink 'local' not materialized \[sink_plugin_not_active\]/
  )
})

test('attach accepts a positional client name', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['attach', 'codex', '--dry-run'], {
    stdout,
    stderr,
    registry,
    kernel,
    env: { ...process.env, HYP_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-attach-')) },
  })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  assert.deepEqual(calls, [
    { action: 'attach', client: 'codex', dryRun: true, json: false },
  ])
})

test('unattach alias routes a positional client through the core disk undo', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const stdout = makeBuf()
  const stderr = makeBuf()
  // Isolate HOME/CODEX_HOME so the disk-driven detach targets a temp tree
  // (no marker present → a clean no-op) rather than the developer's files.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-unattach-'))

  const code = await dispatch(['unattach', 'claude', '--json'], {
    stdout,
    stderr,
    registry,
    kernel,
    env: { ...process.env, HOME: home, CODEX_HOME: home, HYP_HOME: home },
  })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  // Detach no longer dispatches to a per-adapter hook — it is the single
  // core disk-driven undo (LLP 0045 §Part 3), so the fake client's
  // detach() is never called.
  assert.deepEqual(calls, [])
  const out = JSON.parse(stdout.text().trim())
  assert.equal(out.action, 'detach')
  assert.equal(out.client, 'claude')
})

test('attach rejects conflicting positional and flag client names', async () => {
  const { registry, kernel, calls } = fakeClientKernel()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['attach', 'codex', '--client', 'claude'], {
    stdout,
    stderr,
    registry,
    kernel,
    env: { ...process.env, HYP_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-attach-conflict-')) },
  })

  assert.equal(code, 2)
  assert.equal(stdout.text(), '')
  assert.match(stderr.text(), /client specified multiple times \(codex, claude\)/)
  assert.deepEqual(calls, [])
})

function fakeClientKernel() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  /** @type {Array<{ action: 'attach'|'detach', client: string, dryRun: boolean, json: boolean }>} */
  const calls = []
  const clients = new Map(
    ['claude', 'codex'].map((name) => [
      name,
      {
        name,
        defaultUpstream: name === 'claude' ? 'anthropic' : 'openai',
        async attach(ctx) {
          calls.push({
            action: 'attach',
            client: name,
            dryRun: ctx.dryRun === true,
            json: ctx.json === true,
          })
        },
        async detach(ctx) {
          calls.push({
            action: 'detach',
            client: name,
            dryRun: ctx.dryRun === true,
            json: ctx.json === true,
          })
        },
      },
    ])
  )

  // Fake an `hypaware.ai-gateway@2.0.0` surface: that's the range
  // the CLI dispatcher requires after the phase-1 capability bump,
  // and the test's `dispatch(['attach', ...])` call resolves against
  // it before it ever reaches the client hooks above.
  kernel.capabilities.provide('test', 'hypaware.ai-gateway', '2.0.0', {
    registerUpstreamPreset() {},
    registerClient() {},
    registerExchangeProjector() {},
    localEndpoint() {
      return 'http://127.0.0.1:4388'
    },
    getClient(name) {
      return clients.get(name)
    },
    listClients() {
      return Array.from(clients.values())
    },
  })

  return { registry, kernel, calls }
}

test('dispatch forwards a real stdin to command run when the caller omits opts.stdin', async () => {
  // Regression for #352: the bin entry calls `dispatch(argv)` with no opts,
  // so a command that reads stdin (e.g. `hyp claude-account login`) received
  // `ctx.stdin === undefined` and wrongly reported "needs an interactive
  // terminal". stdin must default to `process.stdin`, just as stdout/stderr do.
  const registry = createCommandRegistry()
  /** @type {unknown} */
  let seenStdin = 'not-run'
  registry.register({
    name: 'stdinprobe',
    summary: 'Capture the stdin dispatch hands the command',
    usage: 'hyp stdinprobe',
    async run(_argv, ctx) {
      seenStdin = ctx.stdin
      return 0
    },
  })
  const kernel = createKernelRuntime({ commandRegistry: registry })
  const stdout = makeBuf()
  const stderr = makeBuf()

  // Deliberately omit `stdin` from opts, mirroring `dispatch(argv)` in bin.
  const code = await dispatch(['stdinprobe'], { stdout, stderr, registry, kernel })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  assert.equal(seenStdin, process.stdin)
})

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
 * @param {unknown} value
 * @returns {NodeJS.ReadStream}
 */
function stdinFor(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return /** @type {NodeJS.ReadStream} */ (Readable.from([body]))
}
