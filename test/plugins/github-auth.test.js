// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fork } from 'node:child_process'
import { githubCredentialsPath, loginGithub, logoutGithub, readGithubAuth, resolveGithubOAuth } from '../../hypaware-core/plugins-workspace/github/src/auth.js'
import { createGithubClient } from '../../hypaware-core/plugins-workspace/github/src/github_client.js'
import { silentLog } from './github-fake-client.js'

/** @import { TestContext } from 'node:test' */

/** @param {TestContext} t */
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-github-auth-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param {unknown} value */
const json = (value) => new Response(JSON.stringify(value))
const grant = { access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'bearer', scope: 'repo', expires_in: 28800 }

function loginOptions(login = 'octocat') {
  return {
    async sleep() {},
    onCode() {},
    async fetchImpl(url) {
      if (String(url).endsWith('/device/code')) return json({ device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
      if (String(url).endsWith('/user')) return json({ login, id: login === 'octocat' ? 7 : 8 })
      return json(grant)
    },
  }
}

/** @param {string} dir */
function expire(dir) {
  const record = readGithubAuth(dir)
  assert.ok(record)
  fs.writeFileSync(githubCredentialsPath(dir), JSON.stringify({ ...record, expires_at: 1 }), { mode: 0o600 })
}

test('login verifies identity and creates owner-only credentials even in a permissive directory', async (t) => {
  const dir = home(t)
  fs.mkdirSync(path.join(dir, 'auth'), { mode: 0o755 })
  assert.deepEqual(await loginGithub(dir, loginOptions()), { login: 'octocat', id: 7 })
  assert.equal(fs.statSync(path.join(dir, 'auth')).mode & 0o777, 0o700)
  assert.equal(fs.statSync(githubCredentialsPath(dir)).mode & 0o777, 0o600)
  assert.equal(await resolveGithubOAuth(dir), 'access-secret')
  await logoutGithub(dir)
  assert.doesNotMatch(fs.readFileSync(githubCredentialsPath(dir), 'utf8'), /access-secret|refresh-secret/)
  await assert.rejects(resolveGithubOAuth(dir), /logged out/)
})

test('failed identity verification never commits a token or revives the previous account', async (t) => {
  const dir = home(t)
  await loginGithub(dir, loginOptions())
  const opts = loginOptions('new-account')
  const upstream = opts.fetchImpl
  opts.fetchImpl = async (url) => String(url).endsWith('/user') ? new Response('echo-secret', { status: 401 }) : upstream(url)
  await assert.rejects(loginGithub(dir, opts), /HTTP 401/)
  assert.equal(readGithubAuth(dir)?.status, 'pending')
  await assert.rejects(resolveGithubOAuth(dir), /incomplete/)
  assert.doesNotMatch(fs.readFileSync(githubCredentialsPath(dir), 'utf8'), /secret|octocat/)
})

test('logout or newer login supersedes a device login still awaiting authorization', async (t) => {
  for (const change of ['logout', 'login']) {
    const dir = home(t)
    let release
    const blocked = new Promise((resolve) => { release = resolve })
    let ready
    const started = new Promise((resolve) => { ready = resolve })
    const pending = loginGithub(dir, { ...loginOptions(), async onCode() { ready()
      await blocked } })
    await started
    if (change === 'logout') await logoutGithub(dir)
    else await loginGithub(dir, loginOptions('new-account'))
    release()
    await assert.rejects(pending, /superseded/)
    assert.equal(readGithubAuth(dir)?.status, change === 'logout' ? 'logged_out' : 'active')
    if (change === 'login') assert.equal(readGithubAuth(dir)?.account?.login, 'new-account')
  }
})

test('selected invalid OAuth never falls back and running clients pick up login and logout', async (t) => {
  const dir = home(t)
  let ghCalls = 0
  const headers = []
  /** @type {NodeJS.ProcessEnv} */
  const env = {}
  const client = createGithubClient({ stateDir: dir, tokenEnv: 'GITHUB_TOKEN', env, log: silentLog,
    async ghToken() { ghCalls++
      return 'legacy-secret' },
    async fetchImpl(_url, init) { headers.push(init?.headers?.['Authorization'])
      return json([]) },
  })
  await client.listViewerRepos()
  await loginGithub(dir, loginOptions())
  await client.listViewerRepos()
  await logoutGithub(dir)
  await assert.rejects(client.listViewerRepos(), /logged out/)
  env['GITHUB_TOKEN'] = 'env-secret'
  await client.listViewerRepos()
  delete env['GITHUB_TOKEN']
  fs.writeFileSync(githubCredentialsPath(dir), '{secret-malformed')
  await assert.rejects(client.listViewerRepos(), /invalid or not private/)
  assert.equal(ghCalls, 1)
  assert.deepEqual(headers, ['Bearer legacy-secret', 'Bearer access-secret', 'Bearer env-secret'])
})

test('concurrent refreshes re-read inside the lock and spend a rotating token only once', async (t) => {
  const dir = home(t)
  await loginGithub(dir, loginOptions())
  expire(dir)
  let calls = 0
  const opts = { async fetchImpl() { calls++
    return json({ ...grant, access_token: 'new-access', refresh_token: 'new-refresh' }) } }
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => resolveGithubOAuth(dir, opts))), Array(8).fill('new-access'))
  assert.equal(calls, 1)
  assert.equal(readGithubAuth(dir)?.refresh_token, 'new-refresh')
})

test('a stale-lock replacement cannot let refresh overwrite logout or a newer login', async (t) => {
  for (const change of ['logout', 'login']) {
    const dir = home(t)
    await loginGithub(dir, loginOptions())
    expire(dir)
    let release
    const blocked = new Promise((resolve) => { release = resolve })
    let ready
    const started = new Promise((resolve) => { ready = resolve })
    const pending = resolveGithubOAuth(dir, { async fetchImpl() { ready()
      await blocked
      return json(grant) } })
    await started
    const old = new Date(Date.now() - 120000)
    fs.utimesSync(`${githubCredentialsPath(dir)}.lock`, old, old)
    if (change === 'logout') await logoutGithub(dir)
    else await loginGithub(dir, loginOptions('new-account'))
    release()
    await assert.rejects(pending, /credentials changed/)
    assert.equal(readGithubAuth(dir)?.status, change === 'logout' ? 'logged_out' : 'active')
    if (change === 'login') assert.equal(readGithubAuth(dir)?.account?.login, 'new-account')
  }
})

test('refresh failures stay selected and do not expose provider errors', async (t) => {
  const dir = home(t)
  await loginGithub(dir, loginOptions())
  expire(dir)
  await assert.rejects(resolveGithubOAuth(dir, { async fetchImpl() { return json({ error: 'bad_refresh_token', error_description: 'refresh-secret' }) } }), /run `hyp github login`/)
  assert.equal(readGithubAuth(dir)?.status, 'active')
})

test('one capture client bounds failed refresh work and notices a subsequent login', async (t) => {
  const dir = home(t)
  await loginGithub(dir, loginOptions())
  expire(dir)
  let refreshes = 0
  const client = createGithubClient({ stateDir: dir, env: {}, tokenEnv: 'GITHUB_TOKEN', log: silentLog,
    ghToken: async () => assert.fail('must not fall back to gh'),
    async fetchImpl(url) {
      if (String(url).includes('/access_token')) {
        refreshes++
        return json({ error: 'bad_refresh_token' })
      }
      return json([])
    },
  })
  for (let i = 0; i < 4; i++) await assert.rejects(client.listViewerRepos(), /run `hyp github login`/)
  assert.equal(refreshes, 1)
  await loginGithub(dir, loginOptions('new-account'))
  assert.deepEqual(await client.listViewerRepos(), [])
})

test('expired refresh token requires login without a network call', async (t) => {
  const dir = home(t)
  await loginGithub(dir, loginOptions())
  fs.writeFileSync(githubCredentialsPath(dir), JSON.stringify({ ...readGithubAuth(dir), expires_at: 1, refresh_expires_at: 1 }))
  await assert.rejects(resolveGithubOAuth(dir, { fetchImpl: async () => assert.fail('expired refresh must not be sent') }), /session expired/)
})

test('the refresh lock serializes independent CLI and daemon processes', async (t) => {
  const dir = home(t)
  await loginGithub(dir, loginOptions())
  expire(dir)
  const moduleUrl = new URL('../../hypaware-core/plugins-workspace/github/src/auth.js', import.meta.url).href
  const script = path.join(dir, 'child.mjs')
  fs.writeFileSync(script, `import fs from 'node:fs'\nimport { resolveGithubOAuth } from ${JSON.stringify(moduleUrl)}\nconst dir = process.argv[2]\nawait resolveGithubOAuth(dir, { async fetchImpl() { fs.appendFileSync(dir + '/refresh-count', '1')\nawait new Promise(r => setTimeout(r, 50))\nreturn new Response(JSON.stringify(${JSON.stringify({ ...grant, access_token: 'child-access', refresh_token: 'child-refresh' })})) } })\n`)
  await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = fork(script, [dir], { stdio: 'pipe' })
    let stderr = ''
    child.stderr?.on('data', (data) => { stderr += data })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve(undefined) : reject(new Error(stderr)))
  })))
  assert.equal(fs.readFileSync(path.join(dir, 'refresh-count'), 'utf8'), '1')
  assert.equal(readGithubAuth(dir)?.access_token, 'child-access')
})

test('a transient read failure is reported as such, not as corruption inviting a destructive re-login', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('permission bits are not enforced here')
  const dir = home(t)
  await loginGithub(dir, loginOptions())
  const authDir = path.join(dir, 'auth')
  t.after(() => { try { fs.chmodSync(authDir, 0o700) } catch { /* already removed */ } })
  fs.chmodSync(authDir, 0o000)
  assert.throws(() => readGithubAuth(dir), /read failed \(EACCES\); retry/)
  fs.chmodSync(authDir, 0o700)
  assert.equal(readGithubAuth(dir)?.status, 'active', 'the working credential survives the transient failure')
})
