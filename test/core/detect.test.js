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
