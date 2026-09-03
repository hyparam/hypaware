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

test('list methods return one normalized page and discard content bodies', async () => {
  let fetches = 0
  const client = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN',
    env: { GITHUB_TOKEN: 'secret' },
    log: silentLog,
    async fetchImpl() {
      fetches += 1
      return new Response(JSON.stringify([{
        number: 7,
        state: 'open',
        body: 'unused content'.repeat(10_000),
        user: { login: 'Octocat', type: 'User', extra: 'discarded' },
      }]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"',
        },
      })
    },
  })

  const page = await client.listIssuesPage('o', 'r', undefined)
  assert.equal(fetches, 1)
  assert.equal(page.next, 'https://api.github.com/repos/o/r/issues?page=2')
  assert.deepEqual(page.items, [{ number: 7, state: 'open', user: { login: 'Octocat', type: 'User' } }])
  assert.ok(!Object.hasOwn(page.items[0], 'body'))
})

test('incremental pull page is newest-first and sends the saved ETag', async () => {
  let requested = ''
  let ifNoneMatch = ''
  const client = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN',
    env: { GITHUB_TOKEN: 'secret' },
    log: silentLog,
    async fetchImpl(input, init) {
      requested = String(input)
      ifNoneMatch = /** @type {Record<string, string>} */ (init?.headers)['If-None-Match']
      return new Response(null, { status: 304 })
    },
  })

  const page = await client.listPullRequestsPage('o', 'r', 'saved-etag')
  assert.match(requested, /sort=updated&direction=desc/)
  assert.equal(ifNoneMatch, 'saved-etag')
  assert.equal(page.notModified, true)
})

test('a gh auth failure is not cached, so the next call retries', async () => {
  let ghCalls = 0
  const client = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN',
    env: {},
    log: silentLog,
    async ghToken() {
      ghCalls += 1
      if (ghCalls === 1) throw new Error('gh unavailable')
      return 'later-secret'
    },
    async fetchImpl() {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  await assert.rejects(client.listViewerRepos(), /gh unavailable/)
  await client.listViewerRepos()
  assert.equal(ghCalls, 2, 'a rejected token promise must not poison the client')
  await client.listViewerRepos()
  assert.equal(ghCalls, 2, 'the resolved token is still cached')
})

test('a Link header whose url carries a comma still yields the next page', async () => {
  /** @type {string[]} */
  const urls = []
  const client = createGithubClient({
    tokenEnv: 'T',
    env: { T: 'x' },
    baseUrl: 'https://api.github.test',
    log: silentLog,
    async fetchImpl(input) {
      urls.push(String(input))
      const link = urls.length === 1
        ? '<https://api.github.test/user/repos?affiliation=owner,collaborator,organization_member&page=2>; rel="next", <https://api.github.test/user/repos?page=9>; rel="last"'
        : null
      return new Response(JSON.stringify([{ full_name: `o/r${urls.length}` }]), {
        status: 200,
        headers: link ? { 'content-type': 'application/json', link } : { 'content-type': 'application/json' },
      })
    },
  })

  assert.deepEqual(await client.listViewerRepos(), ['o/r1', 'o/r2'])
  assert.match(urls[1], /page=2$/)
})

test('a commit whose file list hits the API cap is reported as truncated', async () => {
  /** @type {Array<{ name: string, attrs: any }>} */
  const warns = []
  /** @type {string[]} */
  const urls = []
  const client = createGithubClient({
    tokenEnv: 'T',
    env: { T: 'x' },
    baseUrl: 'https://api.github.test',
    log: /** @type {any} */ ({ info() {}, warn(name, attrs) { warns.push({ name, attrs }) }, error() {} }),
    async fetchImpl(input) {
      urls.push(String(input))
      const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.js` }))
      return new Response(JSON.stringify({ files }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const page = await client.listCommitFilesPage('o', 'r', 'a'.repeat(40))
  assert.equal(page.items.length, 300)
  assert.equal(page.next, null)
  assert.equal(warns.length, 1)
  assert.equal(warns[0].name, 'github.listing_truncated')
  assert.equal(warns[0].attrs.label, 'commits/files')
  // `per_page` is not a parameter of the single-commit resource, so it is not sent.
  assert.doesNotMatch(urls[0], /per_page/)
})

test('a cross-origin Link header next page is refused, not fetched with the token', async () => {
  /** @type {string[]} */
  const urls = []
  const client = createGithubClient({
    tokenEnv: 'T',
    env: { T: 'secret' },
    baseUrl: 'https://api.github.test',
    log: silentLog,
    async fetchImpl(input) {
      urls.push(String(input))
      return new Response(JSON.stringify([{ full_name: 'o/r1' }]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://evil.test/user/repos?page=2>; rel="next"',
        },
      })
    },
  })

  await assert.rejects(client.listViewerRepos(), (error) => {
    assert.ok(error instanceof Error)
    assert.equal(/** @type {HypError} */ (error).hypErrorKind, 'github_foreign_origin')
    assert.doesNotMatch(error.message, /secret/)
    return true
  })
  assert.equal(urls.length, 1, 'the refused page must not be requested')
  assert.doesNotMatch(urls[0], /evil/)
})

test('a persisted cursor page pointing off-origin is refused before the token is resolved', async () => {
  let fetches = 0
  let ghCalls = 0
  const client = createGithubClient({
    // No token env var, so resolving the credential would shell out to `gh`.
    // A refused URL must not get that far: the origin pin runs first.
    tokenEnv: 'T',
    env: {},
    baseUrl: 'https://api.github.test',
    log: silentLog,
    async ghToken() {
      ghCalls += 1
      return 'gh-secret'
    },
    async fetchImpl() {
      fetches += 1
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  await assert.rejects(
    client.listIssuesPage('o', 'r', undefined, 'https://evil.test/repos/o/r/issues?page=3'),
    (error) => {
      assert.equal(/** @type {HypError} */ (error).hypErrorKind, 'github_foreign_origin')
      return true
    },
  )
  assert.equal(fetches, 0)
  assert.equal(ghCalls, 0, 'a refused URL must not resolve the credential')
})

test('an Enterprise base keeps its own absolute continuations', async () => {
  /** @type {string[]} */
  const urls = []
  const client = createGithubClient({
    tokenEnv: 'T',
    env: { T: 'secret' },
    baseUrl: 'https://ghe.example.test:8443/api/v3',
    log: silentLog,
    async fetchImpl(input) {
      urls.push(String(input))
      const link = urls.length === 1
        ? '<https://ghe.example.test:8443/api/v3/user/repos?page=2>; rel="next"'
        : null
      return new Response(JSON.stringify([{ full_name: `o/r${urls.length}` }]), {
        status: 200,
        headers: link ? { 'content-type': 'application/json', link } : { 'content-type': 'application/json' },
      })
    },
  })

  assert.deepEqual(await client.listViewerRepos(), ['o/r1', 'o/r2'])
  assert.match(urls[0], /^https:\/\/ghe\.example\.test:8443\/api\/v3\/user\/repos\?/)
  assert.equal(urls[1], 'https://ghe.example.test:8443/api/v3/user/repos?page=2')
})

// A continuation that is not a valid absolute URL still gets joined onto the
// base, and `@host/...` turns everything before the `@` into userinfo: the
// join `https://api.github.test` + `@evil.test/x` has authority `evil.test`.
// Pinning only the absolute case let this one through with the token attached.
for (const injected of ['@evil.test/repos/o/r/issues?page=3', ':@evil.test/repos/o/r/issues?page=3']) {
  test(`a continuation injecting a foreign authority (${injected}) is refused, not joined onto the base`, async () => {
    let fetches = 0
    const client = createGithubClient({
      tokenEnv: 'T',
      env: { T: 'secret' },
      baseUrl: 'https://api.github.test',
      log: silentLog,
      async fetchImpl() {
        fetches += 1
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await assert.rejects(client.listIssuesPage('o', 'r', undefined, injected), (error) => {
      assert.equal(/** @type {HypError} */ (error).hypErrorKind, 'github_foreign_origin')
      return true
    })
    assert.equal(fetches, 0)
  })
}

test('a Link header injecting a foreign authority is refused before the next page is fetched', async () => {
  /** @type {string[]} */
  const urls = []
  const client = createGithubClient({
    tokenEnv: 'T',
    env: { T: 'secret' },
    baseUrl: 'https://api.github.test',
    log: silentLog,
    async fetchImpl(input) {
      urls.push(String(input))
      return new Response(JSON.stringify([{ full_name: 'o/r1' }]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<@evil.test/user/repos?page=2>; rel="next"',
        },
      })
    },
  })

  await assert.rejects(client.listViewerRepos(), (error) => {
    assert.equal(/** @type {HypError} */ (error).hypErrorKind, 'github_foreign_origin')
    return true
  })
  assert.equal(urls.length, 1, 'the refused page must not be requested')
  assert.doesNotMatch(urls[0], /evil/)
})

// `URL.origin` is not the whole authority. A wrapper scheme reports the origin
// of the URL it wraps, and userinfo survives into `href`, so both of these pass
// an origin-only check while addressing something other than the configured
// base. The pin covers the scheme and the credentials too.
for (const sameOrigin of ['blob:https://api.github.test/repos/o/r/issues', 'https://u:p@api.github.test/repos/o/r/issues']) {
  test(`a same-origin continuation that is not the configured base (${sameOrigin.split(':')[0]}) is refused`, async () => {
    assert.equal(new URL(sameOrigin).origin, 'https://api.github.test', 'the case is only meaningful if the origin matches')
    let fetches = 0
    const client = createGithubClient({
      tokenEnv: 'T',
      env: { T: 'secret' },
      baseUrl: 'https://api.github.test',
      log: silentLog,
      async fetchImpl() {
        fetches += 1
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await assert.rejects(client.listIssuesPage('o', 'r', undefined, sameOrigin), (error) => {
      assert.equal(/** @type {HypError} */ (error).hypErrorKind, 'github_foreign_origin')
      return true
    })
    assert.equal(fetches, 0)
  })
}

// The pin is an origin equality, not a prefix or suffix test. A host that
// merely starts or ends with the configured one is a different host.
for (const lookalike of ['https://api.github.test.evil.test/user/repos?page=2', 'https://notapi.github.test/user/repos?page=2']) {
  test(`a look-alike host (${new URL(lookalike).host}) is refused`, async () => {
    let fetches = 0
    const client = createGithubClient({
      tokenEnv: 'T',
      env: { T: 'secret' },
      baseUrl: 'https://api.github.test',
      log: silentLog,
      async fetchImpl() {
        fetches += 1
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    await assert.rejects(client.listIssuesPage('o', 'r', undefined, lookalike), (error) => {
      assert.equal(/** @type {HypError} */ (error).hypErrorKind, 'github_foreign_origin')
      return true
    })
    assert.equal(fetches, 0)
  })
}

test('a foreign Link header is refused on the response that carried it, so it never reaches the cursor sidecar', async () => {
  let fetches = 0
  const client = createGithubClient({
    tokenEnv: 'T',
    env: { T: 'secret' },
    baseUrl: 'https://api.github.test',
    log: silentLog,
    async fetchImpl() {
      fetches += 1
      return new Response(JSON.stringify([{ number: 1, state: 'open', user: { login: 'a' } }]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://evil.test/repos/o/r/issues?page=2>; rel="next"',
        },
      })
    },
  })

  // Returning this page with its foreign `next` would persist a URL that can
  // never be fetched into `github-cursors.json`. Capture then clears that
  // poisoned work and restarts the phase from its unpublished watermark, so
  // page one's rows are appended again on every later tick. Refuse the page
  // instead: the stall stays loud and `github_events` gains no duplicates.
  await assert.rejects(client.listIssuesPage('o', 'r', undefined, undefined), (error) => {
    assert.ok(error instanceof Error)
    assert.equal(/** @type {HypError} */ (error).hypErrorKind, 'github_foreign_origin')
    assert.doesNotMatch(error.message, /secret/)
    return true
  })
  assert.equal(fetches, 1, 'only the page that carried the header is requested')
})
