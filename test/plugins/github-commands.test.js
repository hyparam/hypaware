// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { dispatch } from '../../src/core/cli/dispatch.js'
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
  const config = JSON.stringify({ version: 2, plugins: [] })
  fs.writeFileSync(configPath, config)
  const code = await dispatch(['github', 'login', '--no-browser'], {
    stdout: f.stdout, stderr: f.stderr,
    env: { ...process.env, HYP_HOME: f.stateDir, HYP_CONFIG: configPath },
  })
  assert.equal(code, 2)
  assert.match(f.stderr.text(), /@hypaware\/github.*not in the active config/)
  assert.match(f.stderr.text(), /plugins\[\]/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), config)
})
