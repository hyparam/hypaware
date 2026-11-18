// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { stateRootOf } from '../../src/core/runtime/paths.js'
import { runGithubLogin, runGithubLogout, runGithubStatus } from '../../hypaware-core/plugins-workspace/github/src/commands.js'
import { setGithubRuntime } from '../../hypaware-core/plugins-workspace/github/src/runtime.js'
import { silentLog } from './github-fake-client.js'

/** @import { TestContext } from 'node:test' */

function buffer() {
  let text = ''
  return { write(value) { text += value }, text: () => text }
}

/** @param {TestContext} t */
function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-github-commands-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  const stdout = buffer()
  const stderr = buffer()
  const env = { GITHUB_TOKEN: 'environment-secret' }
  setGithubRuntime(/** @type {any} */ ({ stateDir, env, config: { token_env: 'GITHUB_TOKEN' }, log: silentLog }))
  return { stateDir, stdout, stderr, env, ctx: /** @type {any} */ ({ stdout, stderr }) }
}

test('GitHub status explains the effective environment override and logout preserves it explicitly', async (t) => {
  const f = fixture(t)
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer environment-secret')
    return Response.json({ login: 'octocat', id: 7 })
  })
  assert.equal(await runGithubLogout([], f.ctx), 0)
  assert.equal(await runGithubStatus([], f.ctx), 0)
  assert.match(f.stdout.text(), /Environment override GITHUB_TOKEN remains active/)
  assert.match(f.stdout.text(), /authenticated as octocat/)
  assert.doesNotMatch(f.stdout.text() + f.stderr.text(), /environment-secret/)
  f.env.GITHUB_TOKEN = ''
  assert.equal(await runGithubStatus([], f.ctx), 1)
  assert.match(f.stdout.text(), /local OAuth \(logged_out\)/)
  assert.match(f.stderr.text(), /hyp github login/)
})

test('disabled device flow is actionable and never prints the provider body', async (t) => {
  const f = fixture(t)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'device_flow_disabled', error_description: 'sensitive-provider-body' }))
  assert.equal(await runGithubLogin(['--no-browser'], f.ctx), 1)
  assert.match(f.stderr.text(), /enable it in the GitHub OAuth App settings/)
  assert.doesNotMatch(f.stdout.text() + f.stderr.text(), /sensitive-provider-body|environment-secret/)
})

test('auth command argument errors cannot perform a login or logout', async (t) => {
  const f = fixture(t)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not fetch'))
  for (const command of [runGithubLogin, runGithubLogout, runGithubStatus]) assert.equal(await command(['--unknown'], f.ctx), 2)
  assert.deepEqual(fs.readdirSync(f.stateDir), [])
})

test('inactive GitHub login is discoverable without quietly enabling collection', async (t) => {
  const f = fixture(t)
  const configPath = path.join(f.stateDir, 'hypaware-config.json')
  // Keep the legacy grep migration out of this GitHub opt-in assertion.
  const config = JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/grep' }] })
  fs.writeFileSync(configPath, config)
  const code = await dispatch(['github', 'login', '--no-browser'], {
    stdout: f.stdout, stderr: f.stderr,
    env: { ...process.env, HYP_HOME: f.stateDir, HYP_CONFIG: configPath },
  })
  assert.equal(code, 2)
  assert.match(f.stderr.text(), /@hypaware\/github.*not in the active config/)
  assert.match(f.stderr.text(), /hyp github connect/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), config)
})

test('GitHub connect preserves the configured scope and leaves an idempotent retry after failed sign-in', async t => {
  const f = fixture(t)
  const configPath = path.join(f.stateDir, 'hypaware-config.json')
  const plugins = [
    { name: '@hypaware/grep' },
    { name: '@hypaware/github', enabled: false, config: { inventory: 'session_repos', ignore: ['acme/private'] } },
  ]
  fs.writeFileSync(configPath, JSON.stringify({ version: 2, plugins }))
  let requests = 0
  t.mock.method(globalThis, 'fetch', async input => {
    assert.equal(String(input), 'https://github.com/login/device/code')
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins
    assert.deepEqual(saved, [plugins[0], { ...plugins[1], enabled: true }, { name: '@hypaware/context-graph' }])
    requests++
    return Response.json({ error: 'access_denied' })
  })
  const opts = { stdout: f.stdout, stderr: f.stderr, env: { ...process.env, HOME: f.stateDir, HYP_HOME: f.stateDir, HYP_CONFIG: configPath, GITHUB_TOKEN: '' } }
  assert.equal(await dispatch(['github', 'connect', '--no-browser'], opts), 1)
  assert.match(f.stderr.text(), /Re-run `hyp github connect`/)
  const saved = fs.readFileSync(configPath, 'utf8')
  assert.equal(await dispatch(['github', 'connect', '--no-browser'], opts), 1)
  assert.equal(requests, 2)
  assert.equal(fs.readFileSync(configPath, 'utf8'), saved)
  assert.equal(fs.readdirSync(f.stateDir).filter(name => name.startsWith('hypaware-config.json.bak-')).length, 1)
})

test('GitHub connect respects a centrally disabled collector', async t => {
  const f = fixture(t)
  const configPath = path.join(f.stateDir, 'hypaware-config.json')
  const seedPath = centralSeedPath(stateRootOf(f.stateDir))
  const local = JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/grep' }] })
  const central = JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/github', enabled: false }] })
  fs.writeFileSync(configPath, local)
  fs.mkdirSync(path.dirname(seedPath), { recursive: true })
  fs.writeFileSync(seedPath, central)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not start device sign-in'))
  assert.equal(await dispatch(['github', 'connect', '--no-browser'], { stdout: f.stdout, stderr: f.stderr,
    env: { ...process.env, HOME: f.stateDir, HYP_HOME: f.stateDir, HYP_CONFIG: configPath, GITHUB_TOKEN: '' } }), 1)
  assert.match(f.stderr.text(), /disabled by your organization/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), local)
  assert.equal(fs.readFileSync(seedPath, 'utf8'), central)
})
