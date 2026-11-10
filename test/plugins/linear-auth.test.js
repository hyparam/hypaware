// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loginLinear, logoutLinear, readLinearAuth, resolveLinearOAuth, linearCredentialsPath, linearAuthorization } from '../../hypaware-core/plugins-workspace/linear/src/auth.js'
import { browserLogin } from '../../hypaware-core/plugins-workspace/linear/src/oauth.js'
import { callbackUri, fakeLinearApi, IDENTITY } from '../../hypaware-core/smoke/lib/linear_fixture.js'
import { validateLinearConfig } from '../../hypaware-core/plugins-workspace/linear/src/config.js'

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-linear-auth-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function options() {
  const api = fakeLinearApi()
  return { clientId: 'public-id', redirectUri: await callbackUri(), fetchImpl: api.fetchImpl, onUrl: url => api.authorize(url) }
}

test('browser PKCE login verifies workspace and persists only private rotating credentials', async t => {
  const dir = home(t)
  assert.deepEqual(await loginLinear(dir, await options()), IDENTITY)
  const file = linearCredentialsPath(dir)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  }
  assert.equal(await resolveLinearOAuth(dir), 'hermetic-access')
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /code_verifier|code_challenge|hermetic-code/)
  await logoutLinear(dir)
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /hermetic-access|hermetic-refresh/)
  await assert.rejects(resolveLinearOAuth(dir), /logged out/)
})

test('callback refuses wrong state, duplicate parameters, method and path without consuming the valid response', async () => {
  const api = fakeLinearApi()
  await browserLogin({ clientId: 'public-id', redirectUri: await callbackUri(), fetchImpl: api.fetchImpl,
    async onUrl(value) {
      const url = new URL(value)
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '')
      callback.searchParams.set('state', 'wrong')
      callback.searchParams.set('code', 'secret-code')
      assert.equal((await fetch(callback)).status, 400)
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      callback.searchParams.append('state', url.searchParams.get('state') ?? '')
      assert.equal((await fetch(callback)).status, 400)
      callback.searchParams.delete('state')
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      callback.searchParams.append('code', 'duplicate')
      assert.equal((await fetch(callback)).status, 400)
      assert.equal((await fetch(callback, { method: 'POST' })).status, 404)
      const wrongPath = new URL(callback)
      wrongPath.pathname = '/other'
      assert.equal((await fetch(wrongPath)).status, 404)
      await api.authorize(value)
    },
  })
})

test('denial, expiry, cancellation and failed identity leave no credential and release the callback port', async t => {
  for (const mode of ['denied', 'timeout', 'cancelled', 'identity']) {
    const dir = home(t)
    const opts = await options()
    const abort = new AbortController()
    const onUrl = opts.onUrl
    await assert.rejects(loginLinear(dir, { ...opts, signal: abort.signal, timeoutMs: mode === 'timeout' ? 30 : 3000,
      async onUrl(value) {
        if (mode === 'cancelled') abort.abort()
        else if (mode === 'denied') {
          const auth = new URL(value)
          const url = new URL(auth.searchParams.get('redirect_uri') ?? '')
          url.searchParams.set('state', auth.searchParams.get('state') ?? '')
          url.searchParams.set('error', 'access_denied-secret')
          await fetch(url)
        } else if (mode !== 'timeout') await onUrl(value)
      },
      fetchImpl: mode === 'identity' ? async (url, init) => String(url).endsWith('/graphql')
        ? Response.json({ errors: [{ message: 'provider-secret' }] }) : opts.fetchImpl(url, init) : opts.fetchImpl,
    }), error => {
      assert.doesNotMatch(String(error), /provider-secret|access_denied-secret/)
      return true
    })
    assert.equal(readLinearAuth(dir)?.status, 'pending')
    assert.doesNotMatch(fs.readFileSync(linearCredentialsPath(dir), 'utf8'), /hermetic-access/)
    // A fresh attempt with the same URI proves the listener was closed.
    await loginLinear(dir, { ...await options(), redirectUri: opts.redirectUri })
  }
})

test('logout supersedes an in-flight browser login and a failed verification cannot revive the previous grant', async t => {
  const dir = home(t)
  const opts = await options()
  await assert.rejects(loginLinear(dir, { ...opts, async onUrl(value) {
    await logoutLinear(dir)
    await opts.onUrl(value)
  } }), /superseded/)
  assert.equal(readLinearAuth(dir)?.status, 'logged_out')
})

test('concurrent refreshes consume one token and do not depend on changed app configuration', async t => {
  const dir = home(t)
  await loginLinear(dir, await options())
  const record = readLinearAuth(dir)
  assert.ok(record)
  fs.writeFileSync(linearCredentialsPath(dir), JSON.stringify({ ...record, expires_at: 1 }))
  let requests = 0
  const opts = { async fetchImpl(_url, init) {
    requests++
    assert.equal(new URLSearchParams(String(init.body)).get('client_id'), 'public-id')
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 86400, token_type: 'Bearer', scope: 'read' })
  } }
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => resolveLinearOAuth(dir, opts))), Array(6).fill('new-access'))
  assert.equal(requests, 1)
  assert.equal(readLinearAuth(dir)?.refresh_token, 'new-refresh')
  const config = validateLinearConfig({ client_id: 'other-app' }).config
  assert.ok(config)
  assert.equal(await linearAuthorization(dir, config, {}), 'Bearer new-access')
  await logoutLinear(dir)
  assert.equal(await linearAuthorization(dir, config, { LINEAR_API_KEY: 'override' }), 'override')
})

test('invalid or unreadable credential records fail closed and do not expose file contents', async t => {
  const dir = home(t)
  await loginLinear(dir, await options())
  fs.writeFileSync(linearCredentialsPath(dir), '{record-secret')
  await assert.rejects(resolveLinearOAuth(dir), error => /invalid or not private/.test(String(error)) && !String(error).includes('record-secret'))
})

test('a suspended refresh cannot overwrite logout after stale-lock recovery', async t => {
  const dir = home(t)
  await loginLinear(dir, await options())
  fs.writeFileSync(linearCredentialsPath(dir), JSON.stringify({ ...readLinearAuth(dir), expires_at: 1 }))
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const refresh = resolveLinearOAuth(dir, { async fetchImpl() {
    ready()
    await blocked
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 86400, token_type: 'Bearer', scope: 'read' })
  } })
  await started
  const old = new Date(Date.now() - 120000)
  fs.utimesSync(`${linearCredentialsPath(dir)}.lock`, old, old)
  await logoutLinear(dir)
  release()
  await assert.rejects(refresh, /credentials changed/)
  assert.equal(readLinearAuth(dir)?.status, 'logged_out')
})
