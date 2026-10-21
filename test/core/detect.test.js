// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { detectPickerSources } from '../../src/core/cli/detect.js'

/**
 * @import { PluginCatalog } from '../../src/core/types.js'
 */

/**
 * @returns {Promise<string>}
 */
async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-detect-'))
}

/**
 * Fixture catalog mirroring the `claude`/`codex` picker rows
 * `@hypaware/claude` and `@hypaware/codex` will eventually contribute
 * (LLP 0136 task T6): `settings_file` probes at the same paths the old
 * hardcoded `DETECTABLE_CLIENT_SOURCES` table used.
 *
 * @returns {PluginCatalog}
 */
function claudeCodexCatalog() {
  return {
    plugins: new Map(),
    pluginMetadata: new Map(),
    knownDatasets: new Set(),
    clientDescriptors: new Map(),
    pickerDescriptors: new Map([
      [
        'claude',
        {
          plugin: /** @type {any} */ ('@hypaware/claude'),
          id: 'claude',
          label: 'capture Claude Code conversations',
          detect: { settings_file: '.claude/settings.json' },
        },
      ],
      [
        'codex',
        {
          plugin: /** @type {any} */ ('@hypaware/codex'),
          id: 'codex',
          label: 'capture Codex conversations',
          detect: { settings_file: '.codex/config.toml' },
        },
      ],
    ]),
  }
}

test('detects claude when ~/.claude exists', async () => {
  const home = await tmpHome()
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })

  const detected = await detectPickerSources(claudeCodexCatalog(), { HOME: home })

  assert.equal(detected.has('claude'), true)
  assert.equal(detected.has('codex'), false)
})

test('detects codex when ~/.codex exists', async () => {
  const home = await tmpHome()
  await fs.mkdir(path.join(home, '.codex'), { recursive: true })

  const detected = await detectPickerSources(claudeCodexCatalog(), { HOME: home })

  assert.equal(detected.has('codex'), true)
  assert.equal(detected.has('claude'), false)
})

test('detects both when both config homes exist', async () => {
  const home = await tmpHome()
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  await fs.mkdir(path.join(home, '.codex'), { recursive: true })

  const detected = await detectPickerSources(claudeCodexCatalog(), { HOME: home })

  assert.deepEqual([...detected].sort(), ['claude', 'codex'])
})

test('detects nothing in an empty home', async () => {
  const home = await tmpHome()

  const detected = await detectPickerSources(claudeCodexCatalog(), { HOME: home })

  assert.equal(detected.size, 0)
})

test('Copilot manifest does not detect an empty home, VS Code directory or Copilot CLI state', async t => {
  const home = await tmpHome()
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const manifest = JSON.parse(await fs.readFile(new URL('../../hypaware-core/plugins-workspace/copilot/hypaware.plugin.json', import.meta.url), 'utf8'))
  const catalog = claudeCodexCatalog()
  catalog.pickerDescriptors = new Map([['copilot', { ...manifest.contributes.picker[0], id: 'copilot', plugin: manifest.name }]])
  assert.deepEqual([...await detectPickerSources(catalog, { HOME: home })], [])
  await fs.mkdir(path.join(home, '.vscode'))
  await fs.mkdir(path.join(home, '.copilot'))
  assert.deepEqual([...await detectPickerSources(catalog, { HOME: home })], [])
})

/** @param {string} name */
async function manifestCatalog(name) {
  const manifest = JSON.parse(await fs.readFile(new URL(`../../hypaware-core/plugins-workspace/${name}/hypaware.plugin.json`, import.meta.url), 'utf8'))
  const catalog = claudeCodexCatalog()
  catalog.pickerDescriptors = new Map([[name, { ...manifest.contributes.picker[0], id: name, plugin: manifest.name }]])
  return catalog
}

test('Copilot detects installed Stable, Insiders, portable and relocated extensions', async t => {
  const home = await tmpHome()
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const catalog = await manifestCatalog('copilot')
  for (const [dir, env] of /** @type {[string, NodeJS.ProcessEnv][]} */ ([
    ['.vscode/extensions', {}], ['.vscode-insiders/extensions', {}],
    ['portable/extensions', { VSCODE_PORTABLE: path.join(home, 'portable') }],
    ['custom', { VSCODE_EXTENSIONS: path.join(home, 'custom') }],
  ])) {
    const root = path.join(home, dir)
    await fs.mkdir(root, { recursive: true })
    const file = path.join(root, 'extensions.json')
    await fs.writeFile(file, JSON.stringify([{ identifier: { id: 'GitHub.copilot-chat' } }]))
    assert.equal((await detectPickerSources(catalog, { HOME: home, ...env })).has('copilot'), true, dir)
    await fs.writeFile(file, JSON.stringify([{ identifier: { id: 'someone.copilot-chat' } }]))
    assert.equal((await detectPickerSources(catalog, { HOME: home, ...env })).has('copilot'), false, dir)
    await fs.rm(root, { recursive: true })
  }
})

test('LangGraph detects only direct declarations in the current project', async t => {
  const home = await tmpHome()
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const project = path.join(home, 'project')
  await fs.mkdir(project)
  const catalog = await manifestCatalog('langgraph')
  const cases = [
    ['package.json', '{"dependencies":{"@langchain/langgraph":"^1.0.0"}}', true],
    ['package.json', '{"devDependencies":{"@langchain/langgraph":"*"}}', true],
    ['package.json', '{"description":"@langchain/langgraph","dependencies":{"@langchain/langgraph-sdk":"*"}}', false],
    ['package.json', '{"dependencies":["@langchain/langgraph"]}', false],
    ['requirements.txt', '# langgraph\nlanggraph-checkpoint>=1\n', false],
    ['requirements.txt', 'LangGraph[extra]>=1; python_version >= "3.10"\n', true],
    ['requirements.txt', '-r ../requirements.txt\n', false],
    ['pyproject.toml', '[project]\nname = "demo"\ndependencies = [\n "langgraph>=1", # comment\n "requests"\n]\n[tool.other]\nvalue = 1\n', true],
    ['pyproject.toml', "[project]\ndependencies = ['langgraph[foo]>=1']\n", true],
    ['pyproject.toml', '[project]\ndescription = "langgraph"\n[tool.other]\ndependencies = ["langgraph"]\n', false],
    ['pyproject.toml', '[project]\nname = "demo"\n[[tool.example]]\ndependencies = ["langgraph"]\n', false],
    ['pyproject.toml', '[project]\nname = "demo"\n  [tool.example]\ndependencies = ["langgraph"]\n', false],
    ['pyproject.toml', '[project]\n[tool.example]\ndependencies = ["langgraph"]\n', false],
    ['pyproject.toml', '[project]\n[[tool.example]]\ndependencies = ["langgraph"]\n', false],
    ['pyproject.toml', '[project]\r\ndependencies = ["langgraph"]\r\n[tool.other]\r\n', true],
    ['pyproject.toml', '[project]\n# dependencies = ["langgraph"]\ndependencies = ["langgraph-sdk"]\n', false],
    ['pyproject.toml', '[project]\ndescription = """\ndependencies = ["langgraph"]\n"""\n', false],
    ['pyproject.toml', '[project]\n' + 'dependencies = [\n'.repeat(14000), false],
  ]
  for (const [filename, content, expected] of cases) {
    const file = path.join(project, String(filename))
    await fs.writeFile(file, String(content))
    assert.equal((await detectPickerSources(catalog, { HOME: home }, project)).has('langgraph'), expected, String(content))
    await fs.unlink(file)
  }
  await fs.writeFile(path.join(home, 'package.json'), '{"dependencies":{"@langchain/langgraph":"*"}}')
  assert.equal((await detectPickerSources(catalog, { HOME: home }, project)).has('langgraph'), false)
  await fs.mkdir(path.join(home, '.config/hypaware'), { recursive: true })
  await fs.writeFile(path.join(home, '.config/hypaware/langgraph.mjs'), '// managed callback')
  assert.equal((await detectPickerSources(catalog, { HOME: home }, project)).has('langgraph'), false)
})

test('metadata probes reject malformed, oversized and symlinked files and isolate failures', async t => {
  const home = await tmpHome()
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const catalog = await manifestCatalog('langgraph')
  const file = path.join(home, 'package.json')
  for (const content of ['{bad', JSON.stringify({ dependencies: { '@langchain/langgraph': '*' }, padding: 'x'.repeat(256 * 1024) })]) {
    await fs.writeFile(file, content)
    assert.equal((await detectPickerSources(catalog, { HOME: home }, home)).has('langgraph'), false)
  }
  await fs.unlink(file)
  await fs.writeFile(path.join(home, 'real.json'), '{"dependencies":{"@langchain/langgraph":"*"}}')
  await fs.symlink(path.join(home, 'real.json'), file)
  assert.equal((await detectPickerSources(catalog, { HOME: home }, home)).has('langgraph'), false)
  await fs.writeFile(path.join(home, 'requirements.txt'), 'langgraph>=1\n')
  assert.equal((await detectPickerSources(catalog, { HOME: home }, home)).has('langgraph'), true)
})

test('honors $CODEX_HOME override for codex detection', async () => {
  // HOME has no ~/.codex; the override points elsewhere and exists.
  const home = await tmpHome()
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-codexhome-'))

  const detected = await detectPickerSources(claudeCodexCatalog(), { HOME: home, CODEX_HOME: codexHome })

  assert.equal(detected.has('codex'), true)
  assert.equal(detected.has('claude'), false)
})

test('a plain file (not a directory) at the config-home path does not count', async () => {
  const home = await tmpHome()
  // Write `.claude` as a file rather than a directory.
  await fs.writeFile(path.join(home, '.claude'), 'not a dir\n', 'utf8')

  const detected = await detectPickerSources(claudeCodexCatalog(), { HOME: home })

  assert.equal(detected.has('claude'), false)
})

test('a picker row with no detect probe is never detected', async () => {
  const home = await tmpHome()
  /** @type {PluginCatalog} */
  const catalog = {
    plugins: new Map(),
    pluginMetadata: new Map(),
    knownDatasets: new Set(),
    clientDescriptors: new Map(),
    pickerDescriptors: new Map([
      ['otel', { plugin: /** @type {any} */ ('@hypaware/otel'), id: 'otel', label: 'receive OTEL signals' }],
    ]),
  }

  const detected = await detectPickerSources(catalog, { HOME: home })

  assert.equal(detected.size, 0)
})

test('an app_bundle probe detects presence by stat', async () => {
  const home = await tmpHome()
  const bundlePath = path.join(home, 'Claude.app')
  await fs.writeFile(bundlePath, '', 'utf8')
  /** @type {PluginCatalog} */
  const catalog = {
    plugins: new Map(),
    pluginMetadata: new Map(),
    knownDatasets: new Set(),
    clientDescriptors: new Map(),
    pickerDescriptors: new Map([
      [
        'claude-desktop',
        {
          plugin: /** @type {any} */ ('@hypaware/claude-desktop'),
          id: 'claude-desktop',
          label: 'Claude Desktop',
          detect: { app_bundle: bundlePath },
        },
      ],
    ]),
  }

  const detected = await detectPickerSources(catalog, { HOME: home })

  assert.equal(detected.has('claude-desktop'), true)
})

test('an app_bundle probe is not present when the path does not exist', async () => {
  const home = await tmpHome()
  /** @type {PluginCatalog} */
  const catalog = {
    plugins: new Map(),
    pluginMetadata: new Map(),
    knownDatasets: new Set(),
    clientDescriptors: new Map(),
    pickerDescriptors: new Map([
      [
        'claude-desktop',
        {
          plugin: /** @type {any} */ ('@hypaware/claude-desktop'),
          id: 'claude-desktop',
          label: 'Claude Desktop',
          detect: { app_bundle: path.join(home, 'nonexistent', 'Claude.app') },
        },
      ],
    ]),
  }

  const detected = await detectPickerSources(catalog, { HOME: home })

  assert.equal(detected.has('claude-desktop'), false)
})

test('a path probe detects a literal directory', async () => {
  const home = await tmpHome()
  const hermesDir = path.join(home, '.hermes')
  await fs.mkdir(hermesDir, { recursive: true })
  /** @type {PluginCatalog} */
  const catalog = {
    plugins: new Map(),
    pluginMetadata: new Map(),
    knownDatasets: new Set(),
    clientDescriptors: new Map(),
    pickerDescriptors: new Map([
      [
        'hermes',
        {
          plugin: /** @type {any} */ ('@hypaware/hermes'),
          id: 'hermes',
          label: 'Hermes',
          detect: { path: hermesDir },
        },
      ],
    ]),
  }

  const detected = await detectPickerSources(catalog, { HOME: home })

  assert.equal(detected.has('hermes'), true)
})

test('a path probe honors a $FOO_HOME-style env override of its literal path', async () => {
  const home = await tmpHome()
  const overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hermeshome-'))
  /** @type {PluginCatalog} */
  const catalog = {
    plugins: new Map(),
    pluginMetadata: new Map(),
    knownDatasets: new Set(),
    clientDescriptors: new Map(),
    pickerDescriptors: new Map([
      [
        'hermes',
        {
          plugin: /** @type {any} */ ('@hypaware/hermes'),
          id: 'hermes',
          label: 'Hermes',
          // The literal path does not exist; the override does.
          detect: { path: path.join(home, 'nonexistent-hermes') },
        },
      ],
    ]),
  }

  const detected = await detectPickerSources(catalog, { HOME: home, HERMES_HOME: overrideDir })

  assert.equal(detected.has('hermes'), true)
})

test('a probe failure does not surface, and other rows still detect', async () => {
  const home = await tmpHome()
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  /** @type {PluginCatalog} */
  const catalog = {
    plugins: new Map(),
    pluginMetadata: new Map(),
    knownDatasets: new Set(),
    clientDescriptors: new Map(),
    pickerDescriptors: new Map([
      ...claudeCodexCatalog().pickerDescriptors,
      [
        'broken',
        {
          plugin: /** @type {any} */ ('@hypaware/broken'),
          id: 'broken',
          label: 'Broken probe',
          detect: { app_bundle: path.join(home, 'does', 'not', 'exist', 'X.app') },
        },
      ],
    ]),
  }

  const detected = await detectPickerSources(catalog, { HOME: home })

  assert.equal(detected.has('claude'), true)
  assert.equal(detected.has('broken'), false)
})
