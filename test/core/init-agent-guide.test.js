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
import { readObservabilityEnv } from '../../src/core/observability/env.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { clientSyncListPath, readClientSyncEntries, readFolderAskMode, writeClientSyncEntries, writeFolderAskMode } from '../../src/core/usage-policy/index.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 * @import { DispatchOptions } from '../../src/core/cli/types.js'
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
  assert.match(guide, /    claude \(detected\)\n      Disclosure for claude/)
  assert.match(guide, /Not detected, so not offered: .*codex/)
  assert.doesNotMatch(guide, /Disclosure for codex/)
  const [preflight, flow] = guide.split('Setup flow\n')
  const [questions, commands] = flow.split('4. Configure recording for the selected apps.')
  assert.doesNotMatch(preflight, /run hyp status|Existing local config:/)
  assert.match(preflight, /HypAware is already configured:/)
  assert.ok(questions.indexOf('1. How do you want to collect agent logs?') < questions.indexOf('2. Set up recording'))
  assert.doesNotMatch(questions, /--source|--github|--no-backfill|hyp privacy|hyp status/)
  assert.ok(questions.indexOf('hyp remote login --browser') < questions.indexOf('2. Set up recording'))
  assert.match(commands, /claude: --source claude/)
  assert.match(commands, /codex: --source codex/)
  assert.doesNotMatch(guide, /Disclosure for claude-desktop|Disclosure for raw-openai/)
  assert.doesNotMatch(guide, /Other source IDs:|Example for detected sources/)
  assert.match(guide, /hyp setup --source <selected-id>/)
  assert.ok(guide.includes('Sync to the cloud (default)'))
  assert.ok(guide.includes('Record everything (default) / Customize'))
  assert.ok(guide.includes('Sync it automatically:'))
  assert.ok(questions.includes('one question at a time. Wait for the answer'))
  assert.ok(questions.includes('Use your multiple-choice question tool for every choice'))
  assert.ok(questions.includes('Use a separate multi-select question containing only the apps chosen for collection'))
  assert.ok(questions.includes('Options: Sync all selected apps / Customize.'))
  assert.ok(questions.indexOf('ask: Sync all selected apps?') < questions.indexOf('ask: What do you want to sync?'))
  assert.ok(questions.includes('skip the individual sync picker'))
  assert.ok(questions.includes('except the app list in question 2, which is asked in plain text'))
  assert.ok(questions.includes('Do not use the question tool here.'))
  assert.ok(questions.indexOf("Are there any you don't want to record?") < questions.indexOf('ask: What do you want to sync?'))
  assert.ok(questions.indexOf('ask: What do you want to sync?') < questions.indexOf('After cloud customization, ask about new projects'))
  assert.doesNotMatch(questions, /What do you want to collect and sync\?/)
  assert.ok(questions.includes('skip the customization questions, and proceed to installation'))
  assert.ok(guide.includes('Ask me the first time'))
  assert.ok(guide.indexOf('Connect GitHub?') < guide.indexOf('6. Verify the completed setup'))
  assert.ok(guide.indexOf('6. Verify the completed setup') < guide.indexOf('When would you like to upload?'))
  assert.doesNotMatch(guide, /Commands for each question branch|commands in step 5/)
  assert.ok(guide.includes('Do not ask a second confirmation of this choice'))
  assert.ok(guide.includes('Options: "Yes, disconnect" (default) / "No, stay connected"'))
  assert.ok(guide.includes('If sign-in fails or is cancelled, report the outcome and ask question 1 again with the same options'))
  assert.doesNotMatch(guide, /hyp setup --source claude --source codex/)
  assert.doesNotMatch(guide, /Existing local config:/)
  assert.equal(await fs.readFile(configPath, 'utf8'), config)
  assert.deepEqual((await fs.readdir(f.home)).sort(), before)
})

test('with no detections the guide asks instead of selecting the --yes defaults', async (t) => {
  const f = await fixture(t)
  assert.equal(await writeSetupGuide(f.ctx, {
    catalog: catalog(), platform: 'linux',
    collectStatus: async () => { throw new Error('must not collect status without a config') },
  }), 0)
  assert.match(f.stdout(), /Customize \(or no defaults\)/)
  assert.match(f.stdout(), /    codex\n      Disclosure for codex/)
  assert.doesNotMatch(f.stdout(), /Not detected, so not offered/)
  assert.match(f.stdout(), /Which of these apps do you want to record\?/)
  assert.match(f.stdout(), /hyp setup --source <selected-id>/)
  assert.doesNotMatch(f.stdout(), /Example for detected sources/)
  assert.doesNotMatch(f.stdout(), /Existing local config:/)
  assert.deepEqual(await fs.readdir(f.home), [])
})

for (const [name, config, configured] of [
  ['remote-only', { version: 2, query: { remotes: { team: { url: 'https://example.com/mcp' } } } }, false],
  ['recording', { version: 2, plugins: [{ name: '@hypaware/otel' }] }, true],
]) {
  test(`guide uses collected status for a ${name} config`, async t => {
    const f = await fixture(t)
    const configPath = path.join(f.home, 'hypaware-config.json')
    const original = JSON.stringify(config)
    await fs.writeFile(configPath, original)
    await writeSetupGuide(f.ctx, { catalog: catalog(), platform: 'linux' })
    const guide = f.stdout()
    assert.equal(guide.includes('HypAware is already configured:'), configured)
    assert.equal(guide.includes('Reconfigure / See full status / Quit (default)'), configured)
    assert.equal(guide.includes('Setup is not complete. Start with question 1.'), !configured)
    assert.doesNotMatch(guide.split('Setup flow\n')[0], /hyp status|hypaware-config\.json/)
    assert.equal(await fs.readFile(configPath, 'utf8'), original)
  })
}

test('agent guide detects LangGraph in the command project and preserves callback instructions', async t => {
  const f = await fixture(t)
  f.ctx.cwd = f.home
  await fs.writeFile(path.join(f.home, 'package.json'), '{"dependencies":{"@langchain/langgraph":"^1"}}')
  const manifest = JSON.parse(await fs.readFile(new URL('../../hypaware-core/plugins-workspace/langgraph/hypaware.plugin.json', import.meta.url), 'utf8'))
  const cat = catalog()
  cat.pickerDescriptors.set('langgraph', row({ ...manifest.contributes.picker[0], id: 'langgraph', plugin: '@hypaware/langgraph' }))
  assert.equal(await writeSetupGuide(f.ctx, { catalog: cat }), 0)
  assert.match(f.stdout(), /LangGraph.*\(detected\)/)
  assert.match(f.stdout().split('4. Configure recording for the selected apps.')[1], /LangGraph.*: --source langgraph/)
  assert.match(f.stdout(), /callback.*Setup prints the code to add/)
  assert.deepEqual(await fs.readdir(f.home), ['package.json'])
})

// @ref LLP 0462#handoffs [tests]: the guide names pipe-safe sign-ins and status fields, not bare login
test('guide explains human handoffs and verification', async (t) => {
  const f = await fixture(t)
  await writeSetupGuide(f.ctx, { catalog: catalog(), platform: 'linux' })
  for (const instruction of [
    'hyp remote login --browser', 'hyp remote login --no-browser',
    'run hyp github login to open', 'hyp github login --no-browser',
    'run hyp remote login --browser and wait for it to finish before question 2',
    'Do not repeat a completed login later',
    'Include the agreed privacy choices in the setup command',
    'Never run sign-ins in parallel',
    'If sign-in fails or is cancelled, report the outcome and ask question 1 again',
    'hand it to the person and wait for their result',
    'Connect GitHub?', 'Yes, connect GitHub (default) / Not now', 'hyp github status',
    'Yes - import it now (default)', 'No - skip for now',
    'If optional history import was deferred, add --no-backfill',
    'existing sessions will be imported automatically',
    'Setup handles the daemon, client attachment, skills, and history imports.',
    'read --help or use --dry-run only if it fails',
    'hyp sync --dry-run', 'Run hyp sync --yes; it ends the review window', 'Never run hyp sync --yes unless the person chose Upload now', 'If no first-sync hold is active, still ask',
    'Upload now (recommended)', 'Wait until <deadline> and run a security review now',
    'A review does not pause or extend it',
    'hyp query overview --json',
    'rerun the setup command from step 4 with --github --force --no-backfill',
    '--new-folders ask', '--local-only-client <source-id>', '--sync-client <source-id>',
    'No, stay connected: keep enrollment', 'hyp leave', 'first-sync privacy review',
    'Never ask the person to paste passwords or access tokens',
    'read and write access to all your repos', 'hyp status --json',
    'config.valid', 'daemon.running', 'client_attach', 'Setup exit 0 alone does not prove',
    'If an existing app is local-only, offer Record everything (default) / Customize instead',
    'Pass no --sync-client, --local-only-client or --new-folders flags',
    'On macOS, setup may open a certificate or password dialog that only the person can answer',
  ]) assert.ok(f.stdout().includes(instruction), instruction)
  assert.doesNotMatch(f.stdout(), /Suggest a new skill|Recommend a new skill|hyp ask/)
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
    assert.match(f.stdout(), /^HypAware setup guide\n/)
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
    // Keeps the setup gate (#975) from refusing on a win32 host.
    /** @type {DispatchOptions} */
    const opts = { env: f.ctx.env, stdout: f.ctx.stdout, stderr: f.ctx.stderr, platform: 'linux' }
    assert.equal(await dispatch([...args, '--dry-run'], opts), 0, f.stderr())
    assert.equal(/Would enable GitHub collection/.test(f.stdout()), github)
    const configPath = path.join(f.home, 'hypaware-config.json')
    await assert.rejects(fs.access(configPath))
    assert.equal(await dispatch(args, opts), 0, f.stderr())
    assert.equal(/GitHub collection enabled\. Next: run hyp github login/.test(f.stdout()), github)
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
  // Keeps the setup gate (#975) from refusing on a win32 host.
  /** @type {DispatchOptions} */
  const opts = { env: f.ctx.env, stdout: f.ctx.stdout, stderr: f.ctx.stderr, platform: 'linux' }
  const args = ['setup', '--from-file', configPath, '--github']
  assert.equal(await dispatch(args, opts), 1)
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
  assert.equal(await dispatch([...args, '--force', '--dry-run'], opts), 0, f.stderr())
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
  assert.equal(await dispatch([...args, '--force'], opts), 0, f.stderr())
  assert.match(f.stdout(), /GitHub collection enabled\. Next: run hyp github login/)
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.equal(after.plugins.length, 2)
  assert.deepEqual(after.plugins[1], { ...config.plugins[1], enabled: true })
  const backups = (await fs.readdir(f.home)).filter((name) => name.startsWith('hypaware-config.json.bak-'))
  assert.equal(backups.length, 1)
  assert.equal(await fs.readFile(path.join(f.home, backups[0]), 'utf8'), original)
})

for (const fromFile of [false, true]) {
  test(`setup privacy flags preserve unrelated policies and honor dry-run/refusal (from-file=${fromFile})`, async t => {
    const f = await fixture(t)
    const stateDir = readObservabilityEnv(f.ctx.env).stateDir
    const before = [{ source: 'codex', class: /** @type {'local-only'} */ ('local-only') }, { source: 'cursor', class: /** @type {'local-only'} */ ('local-only') }]
    await writeClientSyncEntries({ stateDir, entries: before })
    await writeFolderAskMode({ stateDir, mode: 'sync' })
    const configPath = path.join(f.home, 'hypaware-config.json')
    const original = JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/otel' }] })
    await fs.writeFile(configPath, original)
    const args = ['setup', ...(fromFile ? ['--from-file', configPath] : ['--source', 'otel', '--no-daemon', '--no-backfill']),
      '--sync-client', 'codex', '--local-only-client', 'claude', '--local-only-client', 'claude', '--new-folders', 'ask']
    const opts = { env: f.ctx.env, stdout: f.ctx.stdout, stderr: f.ctx.stderr, platform: /** @type {NodeJS.Platform} */ ('linux') }
    assert.equal(await dispatch(args, opts), 1)
    assert.equal(await fs.readFile(configPath, 'utf8'), original)
    assert.deepEqual(await readClientSyncEntries({ stateDir }), before)
    assert.equal(await readFolderAskMode({ stateDir }), 'sync')
    assert.equal(await dispatch([...args, '--force', '--dry-run'], opts), 0, f.stderr())
    assert.deepEqual(await readClientSyncEntries({ stateDir }), before)
    assert.equal(await readFolderAskMode({ stateDir }), 'sync')
    assert.equal(await dispatch([...args, '--force'], opts), 0, f.stderr())
    assert.deepEqual(new Set((await readClientSyncEntries({ stateDir }))?.map(e => e.source)), new Set(['cursor', 'claude']))
    assert.equal(await readFolderAskMode({ stateDir }), 'ask')
    // Omission is not an instruction to reset policy.
    assert.equal(await dispatch(['setup', '--from-file', configPath, '--force'], opts), 0, f.stderr())
    assert.equal(await readFolderAskMode({ stateDir }), 'ask')
    assert.deepEqual(new Set((await readClientSyncEntries({ stateDir }))?.map(e => e.source)), new Set(['cursor', 'claude']))
  })
}

test('setup rejects invalid privacy choices before writing config', async t => {
  const f = await fixture(t)
  const opts = { env: f.ctx.env, stdout: f.ctx.stdout, stderr: f.ctx.stderr }
  for (const args of [
    ['--source', 'otel', '--new-folders', 'invalid'],
    ['--source', 'otel', '--sync-client', 'unknown'],
    ['--source', 'otel', '--sync-client', 'codex', '--local-only-client', 'codex'],
  ]) {
    assert.equal(await dispatch(['setup', ...args], opts), 2)
    await assert.rejects(fs.access(path.join(f.home, 'hypaware-config.json')))
  }
})

test('setup preserves an unreadable client policy store and refuses before config write', async t => {
  const f = await fixture(t)
  const stateDir = readObservabilityEnv(f.ctx.env).stateDir
  const storePath = clientSyncListPath(stateDir)
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  await fs.writeFile(storePath, '{broken')
  assert.equal(await dispatch(['setup', '--source', 'otel', '--sync-client', 'codex', '--no-daemon'], {
    env: f.ctx.env, stdout: f.ctx.stdout, stderr: f.ctx.stderr,
  }), 1)
  assert.equal(await fs.readFile(storePath, 'utf8'), '{broken')
  await assert.rejects(fs.access(path.join(f.home, 'hypaware-config.json')))
})

test('setup cannot opt a team-managed source out of sync', async t => {
  const f = await fixture(t)
  const stateDir = readObservabilityEnv(f.ctx.env).stateDir
  const seed = centralSeedPath(stateDir)
  await fs.mkdir(path.dirname(seed), { recursive: true })
  await fs.writeFile(seed, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/claude' }] }))
  assert.equal(await dispatch(['setup', '--source', 'otel', '--local-only-client', 'claude', '--no-daemon'], {
    env: f.ctx.env, stdout: f.ctx.stdout, stderr: f.ctx.stderr,
  }), 1)
  assert.match(f.stderr(), /set by your team/)
  assert.deepEqual((await readClientSyncEntries({ stateDir })) ?? [], [])
  await assert.rejects(fs.access(path.join(f.home, 'hypaware-config.json')))
})

test('preset setup refuses privacy flags instead of dropping them', async t => {
  const f = await fixture(t)
  f.ctx.initPresets = /** @type {CommandRunContext['initPresets']} */ (/** @type {unknown} */ ({
    get: () => ({ run: () => assert.fail('preset must not run') }),
  }))
  for (const args of [['--new-folders', 'ask'], ['--sync-client', 'codex'], ['--local-only-client', 'claude']]) {
    assert.equal(await runInit(['preset', ...args], f.ctx), 2)
  }
  assert.deepEqual(await fs.readdir(f.home), [])
})
