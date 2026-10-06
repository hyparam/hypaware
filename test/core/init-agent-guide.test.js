// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInit, writeSetupGuide } from '../../src/core/commands/init.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
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
  assert.match(guide, /hyp setup --source claude --export local-parquet --retention-days 120/)
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
    'hyp remote login --no-browser', 'hyp github login --no-browser',
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
