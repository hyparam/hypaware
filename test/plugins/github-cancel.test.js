// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { githubCredentialsPath, loginGithub, readGithubAuth } from '../../hypaware-core/plugins-workspace/github/src/auth.js'
import { captureRepos } from '../../hypaware-core/plugins-workspace/github/src/capture.js'
import { readCursors, writeCursors } from '../../hypaware-core/plugins-workspace/github/src/cursors.js'
import { createGithubClient } from '../../hypaware-core/plugins-workspace/github/src/github_client.js'
import { setGithubRuntime } from '../../hypaware-core/plugins-workspace/github/src/runtime.js'
import { startGithubSource } from '../../hypaware-core/plugins-workspace/github/src/source.js'
import { CURSOR_ERROR_REPO, runCaptureTick } from '../../hypaware-core/plugins-workspace/github/src/tick.js'
import { emptyGraph, silentLog } from './github-fake-client.js'

/** @import { TestContext } from 'node:test' */
/** @import { AddressInfo } from 'node:net' */
/** @import { CursorState } from '../../hypaware-core/plugins-workspace/github/src/types.js' */

// Far under the client's 30-second request timeout, so a pass proves the stop
// ended the work rather than the timeout.
const PROMPT_MS = 1000

/** @param {unknown} err */
function cancelled(err) {
  assert.equal(/** @type {{ hypErrorKind?: string }} */ (err)?.hypErrorKind, 'github_capture_cancelled')
  return true
}

/**
 * A fetch that never answers until its own signal aborts, then rejects the way
 * the real fetch does. `calls` counts every request the client sent.
 */
function blockingFetch() {
  /** @type {string[]} */
  const calls = []
  let began = () => {}
  const started = new Promise((resolve) => { began = () => resolve(undefined) })
  /** @type {typeof fetch} */
  const fetchImpl = (url, init) => new Promise((_resolve, reject) => {
    calls.push(String(url))
    const signal = /** @type {AbortSignal} */ (init?.signal)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    began()
  })
  return { calls, started, fetchImpl }
}

/** @param {() => Promise<unknown>} fn */
async function elapsed(fn) {
  const at = Date.now()
  await fn()
  return Date.now() - at
}

/** @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler */
async function loopback(handler) {
  /** @type {string[]} */
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(String(req.url))
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const baseUrl = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`
  async function close() {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }
  return { baseUrl, requests, close }
}

/** @param {number} number */
function issue(number) {
  return { number, state: 'open', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', user: { login: 'a' } }
}

/** @param {TestContext} t */
function stateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-cancel-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a stop aborts a blocked request at once and the client sends nothing after it', async () => {
  const blocked = blockingFetch()
  const stop = new AbortController()
  const client = createGithubClient({ tokenEnv: 'GITHUB_TOKEN', env: { GITHUB_TOKEN: 'secret' }, log: silentLog, fetchImpl: blocked.fetchImpl, signal: stop.signal })
  const pending = client.listViewerRepos()
  await blocked.started
  const ms = await elapsed(async () => {
    stop.abort()
    await assert.rejects(pending, cancelled)
  })
  assert.ok(ms < PROMPT_MS, `cancelled in ${ms}ms`)
  await assert.rejects(client.listIssuesPage('o', 'r', undefined), cancelled)
  assert.equal(blocked.calls.length, 1, 'no request is sent once the stop has landed')
})

test('a stop aborts a response body that never finishes', async () => {
  const api = await loopback((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('[')
  })
  try {
    const stop = new AbortController()
    let headers = () => {}
    const arrived = new Promise((resolve) => { headers = () => resolve(undefined) })
    const client = createGithubClient({
      tokenEnv: 'GITHUB_TOKEN', env: { GITHUB_TOKEN: 'secret' }, log: silentLog, baseUrl: api.baseUrl, signal: stop.signal,
      async fetchImpl(url, init) {
        const res = await fetch(url, init)
        headers()
        return res
      },
    })
    const pending = client.listViewerRepos()
    await arrived
    const ms = await elapsed(async () => {
      stop.abort()
      await assert.rejects(pending, cancelled)
    })
    assert.ok(ms < PROMPT_MS, `cancelled in ${ms}ms`)
    assert.equal(api.requests.length, 1)
  } finally {
    await api.close()
  }
})

test('a response that completes as the stop lands is kept, and the next request is not sent', async () => {
  const stop = new AbortController()
  /** @type {string[]} */
  const calls = []
  const client = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN', env: { GITHUB_TOKEN: 'secret' }, log: silentLog, signal: stop.signal,
    async fetchImpl(url) {
      calls.push(String(url))
      stop.abort()
      return new Response(JSON.stringify(String(url).includes('/issues') ? [issue(1)] : []), { headers: { 'content-type': 'application/json' } })
    },
  })
  /** @type {Record<string, unknown>[]} */
  const rows = []
  /** @type {CursorState} */
  const cursors = { schema_version: 1, repos: {} }
  const result = await captureRepos({
    client,
    config: /** @type {any} */ ({ inventory: 'session_repos', ignore: [] }),
    cursors,
    append: async (batch) => { rows.push(...batch) },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r', 'p/q'],
    signal: stop.signal,
  })
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.errors, [], 'a stop is not a repository failure')
  assert.equal(calls.length, 1)
  assert.ok(rows.length >= 1, 'the completed page landed')
  assert.equal(result.events, rows.length, 'the landed rows stay counted')
  assert.ok(cursors.repos['o/r']?.work, 'the repository keeps its saved work for the next run')
  assert.equal(cursors.next_repo, undefined, 'the rotation does not move past the repository it stopped in')
  assert.equal(cursors.repos['p/q'], undefined, 'no later repository is touched')
})

test('a stop during the all_visible inventory ends the run with no error and no request after it', async () => {
  const blocked = blockingFetch()
  const stop = new AbortController()
  const client = createGithubClient({ tokenEnv: 'GITHUB_TOKEN', env: { GITHUB_TOKEN: 'secret' }, log: silentLog, fetchImpl: blocked.fetchImpl, signal: stop.signal })
  const run = captureRepos({
    client,
    config: /** @type {any} */ ({ inventory: 'all_visible', ignore: [] }),
    cursors: { schema_version: 1, repos: {} },
    append: async () => { throw new Error('nothing to append') },
    log: silentLog,
    mode: 'poll',
    signal: stop.signal,
  })
  await blocked.started
  stop.abort()
  const result = await run
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.errors, [])
  assert.equal(blocked.calls.length, 1)
  assert.match(blocked.calls[0], /\/user\/repos/)
})

test('a stop during gh token resolution kills the child and is not an auth failure', async () => {
  const stop = new AbortController()
  /** @type {AbortSignal | undefined} */
  let childSignal
  let fetched = 0
  const client = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN', env: {}, log: silentLog, signal: stop.signal,
    execFileImpl(_file, _args, options, callback) {
      childSignal = /** @type {{ signal?: AbortSignal }} */ (options).signal
      childSignal?.addEventListener('abort', () => callback(Object.assign(new Error('aborted'), { name: 'AbortError' }), ''), { once: true })
    },
    async fetchImpl() {
      fetched += 1
      return new Response('[]')
    },
  })
  const pending = client.listViewerRepos()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(childSignal, 'the gh child receives the stop')
  stop.abort()
  await assert.rejects(pending, cancelled)
  assert.equal(fetched, 0)
})

test('a stop during an OAuth refresh is not a credential verdict, and a fresh client refreshes', async (t) => {
  const dir = stateDir(t)
  const json = (/** @type {unknown} */ value) => new Response(JSON.stringify(value))
  const grant = { access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'bearer', scope: 'repo', expires_in: 28800 }
  await loginGithub(dir, {
    async sleep() {},
    onCode() {},
    async fetchImpl(url) {
      if (String(url).endsWith('/device/code')) return json({ device_code: 'd', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
      if (String(url).endsWith('/user')) return json({ login: 'octocat', id: 7 })
      return json(grant)
    },
  })
  const record = readGithubAuth(dir)
  fs.writeFileSync(githubCredentialsPath(dir), JSON.stringify({ ...record, expires_at: 1 }), { mode: 0o600 })
  const before = fs.readFileSync(githubCredentialsPath(dir), 'utf8')

  const blocked = blockingFetch()
  const stop = new AbortController()
  const client = createGithubClient({ tokenEnv: 'GITHUB_TOKEN', env: {}, log: silentLog, stateDir: dir, fetchImpl: blocked.fetchImpl, signal: stop.signal })
  const pending = client.listViewerRepos()
  await blocked.started
  assert.match(blocked.calls[0], /login\/oauth\/access_token/, 'the stop lands inside the refresh')
  const ms = await elapsed(async () => {
    stop.abort()
    await assert.rejects(pending, cancelled)
  })
  assert.ok(ms < PROMPT_MS, `cancelled in ${ms}ms`)
  assert.equal(blocked.calls.length, 1)
  assert.equal(fs.readFileSync(githubCredentialsPath(dir), 'utf8'), before, 'the credential record is untouched')

  /** @type {string[]} */
  const urls = []
  const fresh = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN', env: {}, log: silentLog, stateDir: dir,
    async fetchImpl(url) {
      urls.push(String(url))
      if (String(url).includes('login/oauth/access_token')) return json({ ...grant, access_token: 'next-access', refresh_token: 'next-refresh' })
      return new Response('[]')
    },
  })
  assert.deepEqual(await fresh.listViewerRepos(), [])
  assert.equal(urls.length, 2, 'the next invocation refreshes and then captures')
})

/**
 * A two-repository poll against a loopback API whose `o/r` issue listing has
 * two pages. While `hold` is set the second page never answers, so the run is
 * stopped mid-paging after page one's rows landed.
 */
async function pagingApi() {
  const state = { hold: true, page2: 0, closed: 0 }
  const api = await loopback((req, res) => {
    const url = new URL(String(req.url), 'http://x')
    const send = (/** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    if (url.pathname !== '/repos/o/r/issues') return send([])
    if (url.searchParams.get('page') !== '2') return send([issue(1), issue(2)], { link: `<${api.baseUrl}/repos/o/r/issues?page=2>; rel="next"` })
    state.page2 += 1
    if (!state.hold) return send([issue(3)])
    res.on('close', () => { state.closed += 1 })
  })
  return { ...api, state }
}

/** @param {string} dir @param {string} baseUrl */
function tickRuntime(dir, baseUrl) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  /** @type {string[]} */
  const projected = []
  /** @type {Array<{ name: string, attrs: Record<string, unknown> }>} */
  const logs = []
  const runtime = /** @type {any} */ ({
    stateDir: dir,
    config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: '24h', inventory: 'session_repos' },
    observedRepos: { async list() { return ['a/one', 'o/r'] } },
    clientFactory: (/** @type {{ signal?: AbortSignal }} */ opts) => createGithubClient({
      tokenEnv: 'GITHUB_TOKEN', env: { GITHUB_TOKEN: 'secret' }, log: silentLog, baseUrl, signal: opts?.signal,
    }),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows(/** @type {string} */ _path, /** @type {unknown} */ _columns, /** @type {Record<string, unknown>[]} */ batch) { rows.push(...batch) },
    },
    graph: {
      async project(/** @type {string} */ source) {
        projected.push(source)
        return { nodes: 0, edges: 0, nodesWritten: 0, edgesWritten: 0 }
      },
    },
    log: {
      info(/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) { logs.push({ name, attrs }) },
      error(/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) { logs.push({ name, attrs }) },
    },
  })
  return { runtime, rows, projected, logs }
}

test('a tick stopped mid-paging commits only landed pages, skips projection, and the next run resumes without duplicates', async (t) => {
  const dir = stateDir(t)
  const api = await pagingApi()
  try {
    // A verdict an earlier tick recorded: the stopped tick sized nothing, so
    // it must leave this answer alone.
    await writeCursors(dir, { schema_version: 1, repos: {}, pending: true })
    const { runtime, rows, projected, logs } = tickRuntime(dir, api.baseUrl)
    runtime.projectionNeeded = false
    const stop = new AbortController()
    const run = runCaptureTick(runtime, { mode: 'poll', signal: stop.signal })
    while (api.state.page2 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const sent = api.requests.length
    const ms = await elapsed(async () => {
      stop.abort()
      const result = await run
      assert.equal(result.cancelled, true)
      assert.deepEqual(result.errors, [])
      assert.equal(result.events, rows.length)
    })
    assert.ok(ms < PROMPT_MS, `cancelled in ${ms}ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(api.state.closed, 1, 'the stop tore down the blocked request on the wire')
    assert.equal(api.requests.length, sent, 'no request followed the stop')
    assert.deepEqual(projected, [], 'no projection starts after a stop')
    assert.equal(runtime.projectionNeeded, true, 'the landed rows stay due for projection')
    const firstRun = rows.length
    assert.ok(firstRun >= 2, 'page one landed')

    const saved = readCursors(dir)
    assert.match(String(saved.repos['o/r']?.work?.page), /page=2/, 'the continuation names the unanswered page')
    assert.equal(saved.next_repo, 'o/r', 'the rotation resumes in the repository it stopped in')
    assert.equal(saved.pending, true, 'the recorded verdict survives the stopped tick')
    const done = logs.find((entry) => entry.name === 'github.capture_tick_completed')
    assert.equal(done?.attrs.cancelled, true)

    // A fresh invocation gets a fresh signal and finishes the work.
    api.state.hold = false
    const before = api.requests.length
    const resumed = await runCaptureTick(runtime, { mode: 'poll', signal: new AbortController().signal })
    assert.equal(resumed.cancelled, undefined)
    assert.deepEqual(resumed.errors, [])
    assert.match(api.requests[before], /\/repos\/o\/r\/issues\?page=2/, 'the run resumes from the saved continuation first')
    assert.deepEqual(projected, ['github_events'])
    const ids = rows.map((row) => row.event_id)
    assert.equal(new Set(ids).size, ids.length, 'no row is captured twice across the stop')
    assert.ok(rows.length > firstRun, 'the resumed run captured page two')
    assert.equal(readCursors(dir).repos['o/r']?.work, undefined)
  } finally {
    await api.close()
  }
})

test('a failed checkpoint on a stopped tick is still reported', async (t) => {
  const base = stateDir(t)
  const blocker = path.join(base, 'not-a-directory')
  fs.writeFileSync(blocker, '')
  const api = await pagingApi()
  try {
    const { runtime } = tickRuntime(path.join(blocker, 'state'), api.baseUrl)
    const stop = new AbortController()
    const run = runCaptureTick(runtime, { mode: 'poll', signal: stop.signal })
    while (api.state.page2 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    stop.abort()
    const result = await run
    assert.equal(result.cancelled, true)
    assert.ok(result.events >= 2)
    assert.deepEqual(result.errors.map((error) => error.repo), [CURSOR_ERROR_REPO])
  } finally {
    await api.close()
  }
})

test('an append that fails as the stop lands is reported, and the run still ends cancelled', async () => {
  const stop = new AbortController()
  const client = createGithubClient({
    tokenEnv: 'GITHUB_TOKEN', env: { GITHUB_TOKEN: 'secret' }, log: silentLog, signal: stop.signal,
    async fetchImpl(url) {
      return new Response(JSON.stringify(String(url).includes('/issues') ? [issue(1)] : []), { headers: { 'content-type': 'application/json' } })
    },
  })
  /** @type {CursorState} */
  const cursors = { schema_version: 1, repos: {} }
  const result = await captureRepos({
    client,
    config: /** @type {any} */ ({ inventory: 'session_repos', ignore: [] }),
    cursors,
    append: async () => {
      stop.abort()
      throw new Error('cache unavailable')
    },
    log: silentLog,
    mode: 'poll',
    observedRepos: ['o/r', 'p/q'],
    signal: stop.signal,
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.events, 0)
  assert.deepEqual(result.errors, [{ repo: 'o/r', error: 'cache unavailable' }])
  assert.equal(cursors.repos['p/q'], undefined, 'the stop is honored before the next repository')
})

/** @param {Partial<{ pollInterval: string, fetchImpl: typeof fetch }>} opts */
function sourceRuntime({ pollInterval = '10ms', fetchImpl }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-cancel-source-'))
  /** @type {Array<{ name: string, attrs: Record<string, unknown> }>} */
  const logs = []
  setGithubRuntime(/** @type {any} */ ({
    stateDir: dir,
    graph: emptyGraph,
    config: { ignore: [], token_env: 'GITHUB_TOKEN', poll_interval: pollInterval, inventory: 'session_repos' },
    observedRepos: { async list() { return ['o/r'] } },
    clientFactory: (/** @type {{ signal?: AbortSignal }} */ opts) => createGithubClient({
      tokenEnv: 'GITHUB_TOKEN', env: { GITHUB_TOKEN: 'secret' }, log: silentLog, fetchImpl, signal: opts?.signal,
    }),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() {},
    },
    log: {
      info(/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) { logs.push({ name, attrs }) },
      error(/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) { logs.push({ name, attrs }) },
    },
  }))
  return { dir, logs }
}

test('source stop cancels a running tick promptly, records no success or failure, and repeats safely', async (t) => {
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const blocked = blockingFetch()
  const { dir, logs } = sourceRuntime({ fetchImpl: blocked.fetchImpl })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = await startGithubSource()
  await blocked.started
  const ms = await elapsed(() => source.stop())
  assert.ok(ms < PROMPT_MS, `stopped in ${ms}ms`)
  const names = logs.map((entry) => entry.name)
  assert.ok(names.includes('github.poll_tick_cancelled'))
  assert.ok(!names.includes('github.poll_tick_completed'))
  assert.ok(!names.includes('github.poll_tick_failed'))
  assert.ok(source.status)
  const status = await source.status()
  assert.equal(status.details?.last_success_at, null)
  assert.equal(status.lastError, undefined)
  assert.equal(status.details?.in_flight, false)
  assert.ok(await elapsed(() => source.stop()) < PROMPT_MS, 'a repeated stop returns at once')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(blocked.calls.length, 1, 'no tick or request follows the stop')
})

test('source stop while idle returns at once and never reaches GitHub', async (t) => {
  const blocked = blockingFetch()
  const { dir } = sourceRuntime({ pollInterval: '24h', fetchImpl: blocked.fetchImpl })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = await startGithubSource()
  assert.ok(await elapsed(() => source.stop()) < PROMPT_MS)
  assert.ok(await elapsed(() => source.stop()) < PROMPT_MS)
  assert.equal(blocked.calls.length, 0)
})
