// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInit, writeSetupGuide } from '../../src/core/commands/init.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 * @import { PickerDescriptor } from '../../src/core/types.js'
 */

async function fixture(t, tty = false) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agent-guide-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  let out = ''
  let err = ''
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: { ...isolatedClientEnv(process.env, home), HYP_HOME: home, HYP_CONFIG: '' },
    stdout: { isTTY: tty, write: (text) => { out += text } },
    stderr: { write: (text) => { err += text } },
    initPresets: { list: () => [] },
  }))
  return { home, ctx, stdout: () => out, stderr: () => err }
}

/** @param {Partial<PickerDescriptor> & { id: string }} over */
function row(over) {
  return /** @type {PickerDescriptor} */ ({
    plugin: '@hypaware/claude', label: over.id, summary: `Disclosure for ${over.id}`,
    ...over,
  })
}

function catalog() {
  const result = buildPluginCatalog([])
  result.pickerDescriptors = new Map([
    ['claude', row({ id: 'claude', detect: { settings_file: '.claude/settings.json' } })],
    ['codex', row({ id: 'codex', detect: { settings_file: '.codex/config.toml' } })],
    ['claude-desktop', row({ id: 'claude-desktop', platforms: ['darwin'], detect: { settings_file: '.desktop/settings.json' } })],
    ['raw-openai', row({ id: 'raw-openai', hidden: true, detect: { settings_file: '.raw/settings.json' } })],
  ])
  return result
}

// @ref LLP 0462#guide [tests]: detection informs an example without installing or overriding config
test('agent guide reuses detection, filters hidden/platform rows and preserves existing config', async (t) => {
  const f = await fixture(t)
  for (const dir of ['.claude', '.desktop', '.raw']) await fs.mkdir(path.join(f.home, dir))
  const configPath = path.join(f.home, 'hypaware-config.json')
  const config = '{"version":2,"plugins":[]}\n'
  await fs.writeFile(configPath, config)
  const before = (await fs.readdir(f.home)).sort()
  assert.equal(await writeSetupGuide(f.ctx, { catalog: catalog(), platform: 'linux' }), 0)
  assert.equal(f.stderr(), '')
  const guide = f.stdout()
  assert.match(guide, /claude \(detected\): --source claude\n    Disclosure for claude/)
  assert.match(guide, /codex: --source codex/)
  assert.doesNotMatch(guide, /Disclosure for claude-desktop|Disclosure for raw-openai/)
  assert.match(guide, /Other source IDs: .*claude-desktop.*raw-openai/)
  assert.match(guide, /hyp setup --source claude --export local-parquet --retention-days 90/)
  assert.ok(guide.includes('Offer "Cloud sync (recommended)" and "Local only"'))
  assert.ok(guide.includes('Confirm the choice before enrollment; honor an existing local-only preference'))
  assert.doesNotMatch(guide, /hyp setup --source claude --source codex/)
  assert.ok(guide.includes(`Existing local config: ${configPath}`))
  assert.equal(await fs.readFile(configPath, 'utf8'), config)
  assert.deepEqual((await fs.readdir(f.home)).sort(), before)
})

test('with no detections the guide asks instead of selecting the --yes defaults', async (t) => {
  const f = await fixture(t)
  assert.equal(await writeSetupGuide(f.ctx, { catalog: catalog(), platform: 'linux' }), 0)
  assert.match(f.stdout(), /No sources detected.*do not fall back to --yes/)
  assert.match(f.stdout(), /--yes alone selects claude \+ otel, regardless of detection/)
  assert.doesNotMatch(f.stdout(), /Example for detected sources/)
  assert.deepEqual(await fs.readdir(f.home), [])
})

// @ref LLP 0462#handoffs [tests]: the guide names pipe-safe sign-ins and status fields, not bare login
test('guide explains human handoffs and verification', async (t) => {
  const f = await fixture(t)
  await writeSetupGuide(f.ctx, { catalog: catalog(), platform: 'linux' })
  for (const instruction of [
    'hyp remote login --browser', 'hyp remote login --no-browser',
    'run hyp github login to open', 'hyp github login --no-browser',
    'cloud first, then GitHub if enabled and requested',
    'Wait for the command to finish and check its result before starting the next sign-in',
    'Never run sign-ins in parallel',
    'On failure, cancellation or timeout, resolve it or ask whether to skip',
    'wait for their result before starting any other sign-in',
    'Separately ask: collect GitHub information', 'add --github to the setup command',
    '--yes never opts into GitHub', 'hyp github status',
    'Offer optional history import now or later; add --no-backfill for later',
    'Scheduled recovery still imports history',
    'hyp sync --dry-run', '--yes cannot bypass that review',
    'hyp query overview --json', 'Suggest a new skill?', 'run hyp ask in an interactive terminal',
    'hyp setup --from-file <existing-config-path> --github --force',
    'hyp privacy folders ask', 'hyp privacy client <name> local-only',
    'Existing enrollment remains', 'hyp leave', 'first-sync privacy review',
    'Never ask the person to paste passwords or access tokens',
    'private repos and grants write scope', 'hyp status --json',
    'config.valid', 'daemon.running', 'client_attach', 'Setup exit 0 alone does not prove',
  ]) assert.ok(f.stdout().includes(instruction), instruction)
})

/** @type {[string, string[], boolean][]} */
const guideCases = [
  ['flagless pipe', [], false],
  ['explicit terminal guide', ['--guide'], true],
]
for (const [name, argv, tty] of guideCases) {
  test(`setup ${name} prints a guide without reaching the wizard`, async (t) => {
    const f = await fixture(t, tty)
    assert.equal(await runInit(argv, f.ctx), 0)
    assert.match(f.stdout(), /^HypAware setup guide\nChoose the options with the person/)
    assert.doesNotMatch(f.stdout(), /hyp setup: setup has not run/)
    assert.equal(f.stderr(), '')
    assert.deepEqual(await fs.readdir(f.home), [])
  })
}

test('guide combined with install flags refuses instead of applying choices', async (t) => {
  const f = await fixture(t)
  assert.equal(await runInit(['--guide', '--yes'], f.ctx), 2)
  assert.match(f.stderr(), /unknown flag --guide/)
  assert.deepEqual(await fs.readdir(f.home), [])
})

// @ref LLP 0462#parity [tests]: the public flag enables collection without requiring a terminal or starting OAuth
for (const github of [false, true]) {
  test(`unattended setup GitHub opt-in=${github} writes the explicit selection`, async (t) => {
    const f = await fixture(t)
    const args = ['setup', '--source', 'otel', '--no-daemon', '--no-backfill', '--export', 'keep-local']
    if (github) args.push('--github')
    const opts = { env: f.ctx.env, stdout: f.ctx.stdout, stderr: f.ctx.stderr }
    assert.equal(await dispatch([...args, '--dry-run'], opts), 0, f.stderr())
    const configPath = path.join(f.home, 'hypaware-config.json')
    await assert.rejects(fs.access(configPath))
    assert.equal(await dispatch(args, opts), 0, f.stderr())
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    const names = config.plugins.map((p) => p.name)
    assert.equal(names.includes('@hypaware/github'), github)
    if (github) assert.equal(names.filter((name) => name === '@hypaware/context-graph').length, 1)
    assert.ok(names.includes('@hypaware/otel'))
    assert.doesNotMatch(f.stdout(), /Waiting for GitHub authorization|Opening your browser/)
  })
}

test('GitHub opt-in from an existing config keeps settings, backs up, and does not duplicate plugins', async (t) => {
  const f = await fixture(t)
  const configPath = path.join(f.home, 'hypaware-config.json')
  const config = { version: 2, plugins: [
    { name: '@hypaware/context-graph' },
    { name: '@hypaware/github', enabled: false, config: { inventory: 'session_repos' } },
  ] }
  const original = JSON.stringify(config) + '\n'
  await fs.writeFile(configPath, original)
  const opts = { env: f.ctx.env, stdout: f.ctx.stdout, stderr: f.ctx.stderr }
  const args = ['setup', '--from-file', configPath, '--github']
  assert.equal(await dispatch(args, opts), 1)
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
  assert.equal(await dispatch([...args, '--force', '--dry-run'], opts), 0, f.stderr())
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
  assert.equal(await dispatch([...args, '--force'], opts), 0, f.stderr())
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.equal(after.plugins.length, 2)
  assert.deepEqual(after.plugins[1], { ...config.plugins[1], enabled: true })
  const backups = (await fs.readdir(f.home)).filter((name) => name.startsWith('hypaware-config.json.bak-'))
  assert.equal(backups.length, 1)
  assert.equal(await fs.readFile(path.join(f.home, backups[0]), 'utf8'), original)
})
