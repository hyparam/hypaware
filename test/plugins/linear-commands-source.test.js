// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLinearRuntime } from '../../hypaware-core/plugins-workspace/linear/src/runtime.js'
import { startLinearSource } from '../../hypaware-core/plugins-workspace/linear/src/source.js'
import { DEFAULT_CLIENT_ID, validateLinearConfig } from '../../hypaware-core/plugins-workspace/linear/src/config.js'
import { readLinearAuth } from '../../hypaware-core/plugins-workspace/linear/src/auth.js'
import { runLinearLogin, runLinearLogout, runLinearStatus, runLinearSync, runLinearBackfill } from '../../hypaware-core/plugins-workspace/linear/src/commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { callbackUri, fakeLinearApi, IDENTITY } from '../../hypaware-core/smoke/lib/linear_fixture.js'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-linear-source-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let stdout = ''
  let stderr = ''
  const config = validateLinearConfig({ teams: ['HYP'] }).config
  assert.ok(config)
  const rt = /** @type {any} */ ({ config, env: {}, stateDir: dir, log: { info() {}, warn() {} },
    storage: { cacheTablePath: () => 'table', appendRows: async () => {} },
    graph: { project: async () => ({ nodesWritten: 0, edgesWritten: 0 }) },
    clientFactory: () => ({ identity: async () => IDENTITY,
      page: async () => ({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }) }),
  })
  setLinearRuntime(rt)
  return { rt, dir, ctx: /** @type {any} */ ({ stdout: { write(chunk) { stdout += chunk } }, stderr: { write(chunk) { stderr += chunk } } }),
    stdout: () => stdout, stderr: () => stderr }
}

test('auth/capture commands validate arguments and explain missing team scope', async t => {
  const f = fixture(t)
  for (const fn of [runLinearLogin, runLinearLogout, runLinearStatus, runLinearSync, runLinearBackfill]) {
    assert.equal(await fn(['--unknown'], f.ctx), 2)
  }
  assert.deepEqual(fs.readdirSync(f.dir), [])
  f.rt.config.teams = []
  assert.equal(await runLinearSync([], f.ctx), 2)
  assert.match(f.stderr(), /No Linear teams selected.*`teams` in the @hypaware\/linear plugin config/)
  assert.doesNotMatch(f.stderr(), /linear\.teams|linear\.client_id/)
  const source = await startLinearSource()
  t.after(() => source.stop())
  const status = await source.status?.()
  assert.equal(status?.state, 'stopped', 'hyp status prints a stopped source\'s message')
  assert.match(String(status?.message), /No Linear teams selected/)
})

test('login defaults to the shared HypAware app and preserves config then environment overrides', async t => {
  const nativeFetch = globalThis.fetch
  for (const { clientId, envId, expected } of [
    { clientId: '', envId: '', expected: DEFAULT_CLIENT_ID },
    { clientId: '', envId: 'env-app', expected: 'env-app' },
    { clientId: 'config-app', envId: 'env-app', expected: 'config-app' },
  ]) await t.test(expected, async t => {
    const f = fixture(t)
    const api = fakeLinearApi()
    f.rt.config.client_id = clientId
    f.rt.config.redirect_uri = await callbackUri()
    f.rt.env.LINEAR_CLIENT_ID = envId
    let tokenRequests = 0
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      if (String(input).endsWith('/oauth/token')) {
        tokenRequests++
        const body = new URLSearchParams(String(init?.body))
        assert.equal(body.get('client_id'), expected)
        assert.equal(body.has('client_secret'), false)
      }
      return api.fetchImpl(input, init)
    })
    let authorizationUrl = ''
    let callback = Promise.resolve()
    const ctx = { ...f.ctx, stdout: { write(chunk) {
      f.ctx.stdout.write(chunk)
      const url = String(chunk).split('\n').find(line => line.startsWith('https://linear.app/oauth/authorize'))
      if (url) {
        authorizationUrl = url
        callback = api.authorize(url, nativeFetch)
        callback.catch(() => {})
      }
    } } }
    assert.equal(await runLinearLogin(['--no-browser'], ctx), 0, f.stderr())
    await callback
    assert.equal(new URL(authorizationUrl).searchParams.get('client_id'), expected)
    assert.equal(tokenRequests, 1)
    assert.equal(readLinearAuth(f.dir)?.client_id, expected)
    assert.match(f.stdout(), /Signed in to Linear workspace smoke/)
  })
})

test('capture failures print the fixed message and next step, not the error kind', async t => {
  const f = fixture(t)
  f.rt.clientFactory = undefined
  assert.equal(await runLinearSync([], f.ctx), 1)
  assert.match(f.stderr(), /OAuth is logged out or incomplete; run `hyp linear login`/)
  assert.doesNotMatch(f.stderr(), /linear_auth_required/)
})

test('status verifies workspace and logout explains an active API-key override without exposing it', async t => {
  const f = fixture(t)
  f.rt.env.LINEAR_API_KEY = 'private-key'
  assert.equal(await runLinearStatus([], f.ctx), 0)
  assert.match(f.stdout(), /workspace: smoke/)
  assert.equal(await runLinearLogout([], f.ctx), 0)
  assert.match(f.stdout(), /Environment override LINEAR_API_KEY remains active/)
  assert.doesNotMatch(f.stdout() + f.stderr(), /private-key/)
})

test('source schedules after completion without overlap and stop aborts active network work', async t => {
  const f = fixture(t)
  f.rt.config.poll_interval = '5ms'
  let concurrent = 0
  let maximum = 0
  let announce
  const running = new Promise(resolve => { announce = resolve })
  f.rt.clientFactory = signal => ({
    async identity() {
      concurrent++
      maximum = Math.max(maximum, concurrent)
      announce()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      concurrent--
      signal.throwIfAborted()
    },
  })
  const keepAlive = setTimeout(() => {}, 2000)
  t.after(() => clearTimeout(keepAlive))
  const source = await startLinearSource()
  t.after(() => source.stop())
  await running
  assert.equal((await source.status?.())?.details?.in_flight, true)
  await new Promise(resolve => setTimeout(resolve, 20))
  await source.stop()
  assert.equal(maximum, 1)
  assert.equal(concurrent, 0)
  assert.equal((await source.status?.())?.details?.next_tick_at, null)
})

test('inactive Linear command is discoverable without enabling capture', async t => {
  const f = fixture(t)
  const configPath = path.join(f.dir, 'config.json')
  const config = JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/grep' }] })
  fs.writeFileSync(configPath, config)
  const code = await dispatch(['linear', 'login'], { stdout: f.ctx.stdout, stderr: f.ctx.stderr,
    env: { ...process.env, HYP_HOME: f.dir, HYP_CONFIG: configPath } })
  assert.equal(code, 2)
  assert.match(f.stderr(), /@hypaware\/linear.*not in the active config/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), config)
})
