// @ts-check

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { createGithubClient } from '../../hypaware-core/plugins-workspace/github/src/github_client.js'
import { silentLog } from './github-fake-client.js'

/** @import { HypError } from '../../hypaware-core/plugins-workspace/github/src/types.d.ts' */

test('GitHub client prefers the configured env token', async () => {
  let ghCalls = 0
  let authorization = ''
  const client = createGithubClient({
    tokenEnv: 'MY_TOKEN',
    env: { MY_TOKEN: 'env-secret' },
    log: silentLog,
    async ghToken() {
      ghCalls += 1
      return 'gh-secret'
    },
    async fetchImpl(_input, init) {
      authorization = /** @type {Record<string, string>} */ (init?.headers).Authorization
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  await client.listViewerRepos()
  assert.equal(authorization, 'Bearer env-secret')
  assert.equal(ghCalls, 0)
})

test('GitHub client falls back to gh once without logging the credential', async () => {
  let ghCalls = 0
  /** @type {Array<{ name: string, attrs: unknown }>} */
  const logs = []
  /** @type {string[]} */
  const authorizations = []
  const client = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN',
    env: {},
    log: /** @type {any} */ ({
      info(name, attrs) { logs.push({ name, attrs }) },
      warn() {},
    }),
    async ghToken() {
      ghCalls += 1
      return 'local-secret\n'
    },
    async fetchImpl(_input, init) {
      authorizations.push(/** @type {Record<string, string>} */ (init?.headers).Authorization)
      return new Response(JSON.stringify([{ full_name: 'Acme/One' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.deepEqual(await client.listViewerRepos(), ['Acme/One'])
  assert.deepEqual(await client.listViewerRepos(), ['Acme/One'])
  assert.equal(ghCalls, 1)
  assert.deepEqual(authorizations, ['Bearer local-secret', 'Bearer local-secret'])
  assert.equal(logs.filter((entry) => entry.name === 'github.auth_resolved').length, 1)
  assert.doesNotMatch(JSON.stringify(logs), /local-secret/)
})

test('GitHub CLI lookup extends a launchd-style path only for the child', async () => {
  let childPath = ''
  const env = { PATH: '/usr/bin:/bin', HOME: '/Users/tester' }
  const client = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN',
    env,
    log: silentLog,
    execFileImpl(file, args, options, callback) {
      assert.equal(file, 'gh')
      assert.deepEqual(args, ['auth', 'token'])
      childPath = /** @type {{ env: NodeJS.ProcessEnv }} */ (options).env.PATH ?? ''
      callback(null, 'daemon-secret\n')
    },
    async fetchImpl() {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  await client.listViewerRepos()
  assert.ok(childPath.split(path.delimiter).includes('/opt/homebrew/bin'))
  assert.ok(childPath.split(path.delimiter).includes('/Users/tester/.local/share/mise/shims'))
  assert.equal(env.PATH, '/usr/bin:/bin')
})

test('GitHub auth failure is safe and classified', async () => {
  let fetched = false
  const client = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN',
    env: {},
    log: silentLog,
    async ghToken() { return '' },
    async fetchImpl() {
      fetched = true
      return new Response('[]')
    },
  })

  await assert.rejects(client.listViewerRepos(), (error) => {
    assert.ok(error instanceof Error)
    assert.equal(/** @type {HypError} */ (error).hypErrorKind, 'github_auth_unavailable')
    assert.doesNotMatch(error.message, /secret|token value/i)
    return true
  })
  assert.equal(fetched, false)
})

