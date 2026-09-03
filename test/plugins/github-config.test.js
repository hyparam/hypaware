// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { CONFIG_DEFAULTS, parseInterval, validateGithubConfig } from '../../hypaware-core/plugins-workspace/github/src/config.js'
import {
  V1_BUNDLED_PLUGIN_ALLOWLIST,
  V1_EXCLUDED_FROM_DEFAULT,
  discoverBundledPlugins,
} from '../../src/core/runtime/bundled.js'

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hypaware-core/plugins-workspace/github'
)

test('empty config defaults to session inventory on a daily cadence', () => {
  const r = validateGithubConfig(undefined)
  assert.ok(r.ok)
  assert.deepEqual(r.config.ignore, [])
  assert.equal(r.config.token_env, CONFIG_DEFAULTS.token_env)
  assert.equal(r.config.token_env, 'GITHUB_TOKEN')
  assert.equal(r.config.poll_interval, '24h')
  assert.equal(r.config.inventory, 'session_repos')
})

test('a full valid config round-trips', () => {
  const r = validateGithubConfig({
    ignore: ['my-org/secret'],
    poll_interval: '10m',
    inventory: 'all_visible',
    token_env: 'GH_PAT',
  })
  assert.ok(r.ok)
  assert.deepEqual(r.config.ignore, ['my-org/secret'])
  assert.equal(r.config.poll_interval, '10m')
  assert.equal(r.config.inventory, 'all_visible')
  assert.equal(r.config.token_env, 'GH_PAT')
})

test('ignore entries must be owner/repo and retired inventory lists are rejected', () => {
  assert.equal(validateGithubConfig({ ignore: ['a/b/c'] }).ok, false)
  assert.equal(validateGithubConfig({ repos: ['owner/repo'] }).ok, false)
  assert.equal(validateGithubConfig({ orgs: ['owner'] }).ok, false)
})

test('token_env must be an env-var NAME, never a token value', () => {
  // The config carries the NAME; the client resolves the value at call time.
  // A GitHub credential is base62 plus underscores, so it satisfies the POSIX
  // env-name character class: the name check alone would let a pasted secret
  // be written verbatim into hypaware.toml. Every credential prefix is
  // rejected outright.
  for (const secret of [
    'ghp_aaaabbbbccccddddeeeeffff0000111122',
    'gho_16C7e42F292c6912E7710c838347Ae178B4a',
    'ghu_abcdefghijklmnopqrstuvwxyz0123456789',
    'ghs_abcdefghijklmnopqrstuvwxyz0123456789',
    'ghr_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDE0Y0abcdefghijkl_xYz0123456789',
    'GHP_UPPERCASED0000111122223333444455',
  ]) {
    assert.equal(validateGithubConfig({ token_env: secret }).ok, false, secret)
  }
  assert.equal(validateGithubConfig({ token_env: 'has space' }).ok, false)
  assert.equal(validateGithubConfig({ token_env: 'ghp-with-dashes!' }).ok, false)
  // Ordinary names, including ones that merely mention github, still pass.
  for (const name of ['GITHUB_TOKEN', 'GH_PAT', 'GITHUB_PAT', 'MY_GH_TOKEN']) {
    assert.equal(validateGithubConfig({ token_env: name }).ok, true, name)
  }
})

test('poll_interval must be a duration', () => {
  assert.equal(validateGithubConfig({ poll_interval: '10m' }).ok, true)
  assert.equal(validateGithubConfig({ poll_interval: '5m' }).ok, true)
  assert.equal(validateGithubConfig({ poll_interval: '1h' }).ok, true)
  assert.equal(validateGithubConfig({ poll_interval: '30s' }).ok, false)
  assert.equal(validateGithubConfig({ poll_interval: '0ms' }).ok, false)
  assert.equal(validateGithubConfig({ poll_interval: '1ms' }).ok, false)
  assert.equal(validateGithubConfig({ poll_interval: 'soon' }).ok, false)
  assert.equal(validateGithubConfig({ poll_interval: 600 }).ok, false)
})

test('inventory accepts only session_repos or all_visible', () => {
  assert.equal(validateGithubConfig({ inventory: 'session_repos' }).ok, true)
  assert.equal(validateGithubConfig({ inventory: 'all_visible' }).ok, true)
  const invalid = validateGithubConfig({ inventory: 'everything' })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.ok(invalid.errors.some((error) => error.pointer === '/inventory'))
})

test('parseInterval converts to milliseconds', () => {
  assert.equal(parseInterval('500ms'), 500)
  assert.equal(parseInterval('30s'), 30_000)
  assert.equal(parseInterval('10m'), 600_000)
  assert.equal(parseInterval('2h'), 7_200_000)
  assert.equal(parseInterval('nope'), null)
})

test('hypaware.plugin.json declares the bundled-graph-source shape (LLP 0005/0360)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hypaware.plugin.json'), 'utf8'))
  assert.equal(manifest.name, '@hypaware/github')
  assert.equal(manifest.entrypoint, './src/index.js')
  // Both dependency kinds are required (LLP 0001 §both-dependency-kinds): the
  // plugin dep pins activation order; the capability dep is the contract interface.
  assert.equal(manifest.requires.plugins['@hypaware/context-graph'], '^0.1.0')
  assert.equal(manifest.requires.capabilities['hypaware.context-graph'], '^1.0.0')
  // Outbound + state permissions (network for the GitHub API; state for cursors).
  assert.deepEqual([...manifest.permissions].sort(), ['network', 'read_state', 'write_state'])
  // Contributions: one dataset, one config section, one source, and its command group.
  assert.deepEqual(manifest.contributes.datasets.map((/** @type {{name:string}} */ d) => d.name), ['github_events'])
  assert.deepEqual(manifest.contributes.config_sections.map((/** @type {{section:string}} */ s) => s.section), ['github'])
  assert.deepEqual(manifest.contributes.sources.map((/** @type {{name:string}} */ s) => s.name), ['github'])
  assert.deepEqual(manifest.contributes.commands.map((/** @type {{name:string}} */ c) => c.name).sort(), ['github', 'github backfill', 'github sync'])
})

test('GitHub ships in the bundle but never activates by default', () => {
  assert.ok(V1_EXCLUDED_FROM_DEFAULT.has('@hypaware/github'))
  assert.ok(!V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/github'))
})

test('bundled discovery loads GitHub into the explicit-activation catalog', async () => {
  const bundled = await discoverBundledPlugins()
  assert.ok(bundled.excluded.some((entry) => entry.manifest.name === '@hypaware/github'))
  assert.ok(!bundled.loaded.some((entry) => entry.manifest.name === '@hypaware/github'))
})
