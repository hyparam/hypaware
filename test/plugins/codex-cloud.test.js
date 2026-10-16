// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acquireCloudAuth, readCloudAuth, CloudError } from '../../hypaware-core/plugins-workspace/codex/src/cloud-auth.js'
import { openCloudClient, readCloudThread, CLOUD_ENDPOINT, listCloudThreads } from '../../hypaware-core/plugins-workspace/codex/src/cloud-client.js'
import { createCodexCloudProvider, projectCloudHistory } from '../../hypaware-core/plugins-workspace/codex/src/cloud.js'
import { cloudConnectionPath, readCloudConnection, validateCloudThreads, registerCloudCommands, validateCloudOrigins } from '../../hypaware-core/plugins-workspace/codex/src/cloud-state.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'

const threadId = '11111111-2222-4333-8444-555555555555'
const accountHash = 'a'.repeat(64)
const now = 1792150000000
const auth = { token: 'synthetic-access-token', accountHash, expiresAt: now + 600000 }
const log = { info() {}, warn() {}, error() {}, debug() {} }
const wrap = (item, completedAtMs = now) => ({ turnId: 'turn-1', startedAtMs: now, completedAtMs, item })
const history = () => ({ thread: { id: threadId, source: { custom: 'codex-cloud-agent' }, originator: 'codex_cloud', createdAt: now / 1000, model: 'thread-model', cwd: '/workspace' }, items: [
  wrap({ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'synthetic prompt' }] }),
  wrap({ type: 'agentMessage', id: 'a1', text: 'synthetic reply' }),
  wrap({ type: 'commandExecution', id: 'c1', command: 'printf synthetic', cwd: '/workspace', aggregatedOutput: 'x'.repeat(21000), status: 'completed' }),
  wrap({ type: 'mcpToolCall', id: 'm1', server: 'example', tool: 'read', arguments: { a: 1 }, result: { content: [{ type: 'text', text: 'result' }], structuredContent: { answer: 42 } }, status: 'completed' }),
  wrap({ type: 'reasoning', id: 'r1', text: 'excluded-reasoning' }),
] })

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-cloud-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

function authHarness({ store = 'file', type = 'chatgpt', snapshots = [auth] } = {}) {
  const calls = []
  let closed = 0
  let reads = 0
  return {
    calls, get closed() { return closed },
    deps: {
      now: () => now,
      read: async () => snapshots[Math.min(reads++, snapshots.length - 1)],
      open: () => ({
        async call(method, params) {
          calls.push([method, params])
          if (method === 'config/read') return { config: { cli_auth_credentials_store: store } }
          if (method === 'account/read') return { account: { type } }
          return {}
        },
        initialized() {}, close() { closed++ },
      }),
    },
  }
}
const authOpts = { codexHome: '/synthetic', env: {}, accountHash }

test('managed auth renews near expiry, reloads the persisted token and closes helper', async () => {
  const h = authHarness({ snapshots: [{ ...auth, expiresAt: now + 10 }, { ...auth, token: 'renewed' }] })
  assert.equal((await acquireCloudAuth(authOpts, h.deps)).token, 'renewed')
  assert.equal(h.calls.filter(([m, p]) => m === 'account/read' && p.refreshToken).length, 1)
  assert.equal(h.closed, 1)
})

test('valid token does not rotate; unsupported modes, account switches and dry-run fail closed', async () => {
  const valid = authHarness()
  await acquireCloudAuth(authOpts, valid.deps)
  assert.equal(valid.calls.some(([m, p]) => m === 'account/read' && p.refreshToken), false)
  for (const store of ['keyring', 'auto', 'ephemeral']) {
    const h = authHarness({ store })
    await assert.rejects(acquireCloudAuth(authOpts, h.deps), /file_credential_store_required/)
    assert.equal(h.closed, 1)
  }
  await assert.rejects(acquireCloudAuth(authOpts, authHarness({ type: 'apiKey' }).deps), /chatgpt_login_required/)
  await assert.rejects(acquireCloudAuth(authOpts, authHarness({ snapshots: [{ ...auth, accountHash: 'different' }] }).deps), /account_changed/)
  await assert.rejects(acquireCloudAuth(authOpts, authHarness({ snapshots: [{ ...auth, expiresAt: now }, { ...auth, accountHash: 'different' }] }).deps), /account_changed/)
  const h = authHarness({ snapshots: [{ ...auth, expiresAt: now }] })
  await assert.rejects(acquireCloudAuth({ ...authOpts, allowRefresh: false }, h.deps), /login_refresh_required/)
  assert.equal(h.calls.some(([m, p]) => m === 'account/read' && p.refreshToken), false)
})

test('auth file validation does not leak malformed credentials and binds subject plus account', async t => {
  const dir = await temp(t)
  const claims = { sub: 'synthetic-user', exp: now / 1000, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } }
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
  await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, account_id: 'synthetic-account' } }))
  const result = await readCloudAuth(dir)
  assert.equal(result.token, token)
  assert.match(result.accountHash, /^[a-f0-9]{64}$/)
  await fs.writeFile(path.join(dir, 'auth.json'), '{secret-invalid-token')
  await assert.rejects(readCloudAuth(dir), error => !String(error).includes('secret-invalid-token') && String(error).includes('file_backed_login_required'))
})

class FakeSocket extends EventTarget {
  /** @type {(message: any) => any} */
  static responder = message => ({ id: message.id, result: {} })
  static address = ''
  static protocols = []
  protocol = 'codex-app-server'
  constructor(address, protocols) {
    super()
    FakeSocket.address = address
    FakeSocket.protocols = protocols
    queueMicrotask(() => this.dispatchEvent(new Event('open')))
  }
  send(data) {
    const request = JSON.parse(data)
    if (!request.id) return
    const response = FakeSocket.responder(request)
    if (response) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(response) })))
  }
  close() {}
}
const socketOpts = () => ({ WebSocketClass: /** @type {any} */ (FakeSocket), timeoutMs: 30 })

test('WebSocket targets only the hosted origin and sanitizes errors, byte limits and timeout', async () => {
  FakeSocket.responder = m => ({ id: m.id, result: {} })
  const c = await openCloudClient('test-token', new AbortController().signal, socketOpts())
  assert.equal(FakeSocket.address, CLOUD_ENDPOINT)
  assert.ok(FakeSocket.protocols.includes('openai-bearer.test-token'))
  FakeSocket.responder = m => ({ id: m.id, error: { message: 'SECRET server text' } })
  await assert.rejects(c.call('thread/read', {}), error => String(error).includes('cloud_request_rejected') && !String(error).includes('SECRET'))
  c.close()
  FakeSocket.responder = m => ({ id: m.id, result: { text: 'x'.repeat(200) } })
  await assert.rejects(openCloudClient('token', new AbortController().signal, { ...socketOpts(), maxBytes: 100 }), /response_byte_limit/)
  FakeSocket.responder = () => null
  await assert.rejects(openCloudClient('token', new AbortController().signal, socketOpts()), /cloud_request_timeout/)
  const signal = AbortSignal.abort()
  await assert.rejects(openCloudClient('token', signal, socketOpts()), /collection_cancelled/)
})

test('paginated reads validate identity and refuse repeated cursors before yielding', async () => {
  const h = history()
  let pages = 0
  const client = { async call(method, params) {
    if (method === 'thread/read') return { thread: h.thread }
    pages++
    return { data: [h.items[pages - 1]], nextCursor: pages === 1 ? 'next' : null }
  } }
  assert.equal((await readCloudThread(client, threadId)).items.length, 2)
  assert.equal(pages, 2)
  for (const originator of ['codex_work_web', 'codex_work_mobile', 'codex_work_cca', null, undefined]) {
    let calls = 0
    await assert.rejects(readCloudThread({ call: async () => {
      calls++
      return { thread: { ...h.thread, originator } }
    } }, threadId), /unsupported_thread_originator/)
    assert.equal(calls, 1, 'reject before fetching any message history')
  }
  await assert.rejects(readCloudThread({ call: async () => ({ thread: { id: 'wrong' } }) }, threadId), /thread_identity/)
  await assert.rejects(readCloudThread({ call: async m => m === 'thread/read' ? { thread: h.thread } : { data: [], nextCursor: 'repeated' } }, threadId), /invalid_history_cursor/)
  await assert.rejects(readCloudThread({ call: async m => m === 'thread/read' ? { thread: h.thread } : { data: [h.items[0], h.items[0]], nextCursor: null } }, threadId), /duplicate_item/)
})

test('projection preserves long outputs and structured MCP results, excludes unfinished and reasoning, leaves usage/model unknown', async () => {
  const h = history()
  h.items.push(wrap({ type: 'agentMessage', id: 'partial', text: 'partial' }, /** @type {any} */ (null)))
  h.items.push(wrap({ type: 'unknownFutureItem', id: 'unknown' }))
  const p = projectCloudHistory(h)
  assert.equal(p.exchange.messages.length, 6)
  assert.equal(p.unsupported, 1)
  assert.equal(p.unfinished, 1)
  assert.equal(p.exchange.cwd, undefined)
  assert.equal(p.exchange.model, undefined)
  assert.equal(projectCloudHistory(h, { sinceMs: now + 1 }).exchange.messages.length, 0)
  const item = { dataset: 'ai_gateway_messages', kind: 'ai_gateway.projected_exchange', value: /** @type {any} */ (p.exchange) }
  const rows = await aiGatewayBackfillMaterializer().materialize(item, /** @type {any} */ ({ env: {}, storage: {}, log }))
  assert.equal(rows.length, 6)
  assert.equal(new Set(rows.map(r => r.part_id)).size, 6)
  assert.ok(rows.every(r => r.entrypoint === 'codex-cloud' && r.session_id === threadId))
  assert.ok(JSON.stringify(rows).includes('x'.repeat(21000)))
  assert.ok(JSON.stringify(rows).includes('structuredContent'))
  assert.equal(JSON.stringify(rows).includes('excluded-reasoning'), false)
})

test('provider is inert until connected, honors opt-out and rechecks account/selection before yielding', async t => {
  const stateDir = await temp(t)
  let network = 0
  let closed = 0
  const ignoredSessions = new Set()
  const opts = { stateDir, codexHome: '/fake', env: {}, ignoredSessions }
  const deps = {
    acquire: async () => auth, readAuth: async () => auth,
    open: async () => {
      network++
      return { call: async () => ({}), close() { closed++ } }
    },
    readThread: async () => history(),
  }
  const provider = createCodexCloudProvider(opts, deps)
  const ctx = /** @type {any} */ ({ env: {}, cacheRoot: stateDir, storage: {}, log, dryRun: false })
  const collect = async p => {
    const rows = []
    for await (const row of p.run(ctx)) rows.push(row)
    return rows
  }
  assert.deepEqual(await collect(provider), [])
  assert.equal(network, 0)
  await fs.writeFile(cloudConnectionPath(stateDir), JSON.stringify({ version: 1, accountHash, threads: [threadId] }))
  ignoredSessions.add(threadId)
  assert.deepEqual(await collect(provider), [])
  assert.equal(network, 0)
  ignoredSessions.clear()
  assert.equal((await collect(provider)).length, 1)
  assert.equal(closed, 1)
  await assert.rejects(collect(createCodexCloudProvider(opts, { ...deps, readAuth: async () => ({ ...auth, accountHash: 'changed' }) })), /account_changed/)
  await assert.rejects(collect(createCodexCloudProvider(opts, { ...deps, readThread: async () => {
    await fs.rm(cloudConnectionPath(stateDir))
    return history()
  } })), /connection_changed/)
  assert.equal(closed, 3)
})

test('connection grant rejects malformed selections', async t => {
  const stateDir = await temp(t)
  for (const ids of [[], ['bad'], [threadId, threadId], Array(21).fill(threadId)]) assert.throws(() => validateCloudThreads(ids))
  assert.equal(await readCloudConnection(stateDir), undefined)
  await fs.writeFile(cloudConnectionPath(stateDir), JSON.stringify({ version: 1, accountHash, threads: ['bad'] }))
  await assert.rejects(readCloudConnection(stateDir), /invalid_cloud_connection/)
})

const cloudId = n => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`

test('discovery pages both archive states, strips content and deduplicates moving chats', async () => {
  const calls = []
  const row = (id, updatedAt) => ({ id, updatedAt, source: { custom: 'codex-cloud-agent' }, originator: 'codex_cloud', preview: 'private preview' })
  const rows = await listCloudThreads({ async call(method, params) {
    calls.push(params)
    assert.equal(method, 'thread/list')
    const query = /** @type {any} */ (params)
    assert.equal(Object.hasOwn(query, 'originators'), false)
    if (query.archived) return { data: [row(cloudId(1), 3)], nextCursor: null }
    if (query.cursor) return { data: [row(cloudId(2), 2), { id: 'local', source: 'cli' }], nextCursor: null }
    return { data: [row(cloudId(1), 1), ...['codex_work_web', 'codex_work_mobile', 'codex_work_cca', null, undefined].map(originator => ({ ...row(cloudId(9), 4), originator }))], nextCursor: 'next' }
  } })
  assert.deepEqual(rows, [{ id: cloudId(1), updatedAt: 3 }, { id: cloudId(2), updatedAt: 2 }])
  assert.equal(calls.length, 3)
  assert.equal(JSON.stringify(rows).includes('private preview'), false)
  await assert.rejects(listCloudThreads({ call: async () => ({ data: [], nextCursor: 'repeat' }) }), /invalid_thread_cursor/)
  let pages = 0
  await assert.rejects(listCloudThreads({ call: async () => ({ data: [], nextCursor: `page-${++pages}` }) }), /thread_discovery_page_limit/)
  assert.equal(pages, 20)
  await assert.rejects(listCloudThreads({ call: async () => ({ data: [row('invalid', 1)], nextCursor: null }) }), /invalid_thread_metadata/)
})

test('account grants are distinct from selected grants and reject malformed scope or lower bounds', async t => {
  const dir = await temp(t)
  const valid = { version: 2, scope: 'account', accountHash, since: new Date(now).toISOString() }
  await fs.writeFile(cloudConnectionPath(dir), JSON.stringify(valid))
  assert.deepEqual(await readCloudConnection(dir), valid)
  for (const value of [{ ...valid, scope: 'other' }, { ...valid, threads: [threadId] }, { ...valid, since: 'never' }, { version: 1, accountHash }]) {
    await fs.writeFile(cloudConnectionPath(dir), JSON.stringify(value))
    await assert.rejects(readCloudConnection(dir), /invalid_cloud_connection/)
  }
})

test('account discovery rotates bounded batches, retries failures and discovers new chats', async t => {
  const stateDir = await temp(t)
  await fs.writeFile(cloudConnectionPath(stateDir), JSON.stringify({ version: 2, scope: 'account', accountHash }))
  let listed = Array.from({ length: 25 }, (_, n) => ({ id: cloudId(n), updatedAt: now / 1000 - n }))
  const reads = []
  let failedOnce = false
  let lists = 0
  const events = []
  const provider = createCodexCloudProvider({ stateDir, codexHome: '/fake', env: {}, ignoredSessions: new Set([cloudId(24)]) }, {
    acquire: async () => auth, readAuth: async () => auth,
    open: async () => ({ call: async () => ({}), close() {} }),
    listThreads: async () => {
      lists++
      return listed
    },
    readThread: async (_client, id) => {
      reads.push(id)
      if (id === cloudId(0) && !failedOnce) {
        failedOnce = true
        throw new CloudError('history_page_limit')
      }
      return { ...history(), thread: { ...history().thread, id } }
    },
  })
  const logs = []
  const observedLog = { ...log,
    info: (name, fields) => logs.push({ name, fields }),
    warn: (name, fields) => logs.push({ name, fields }),
  }
  const ctx = /** @type {any} */ ({ env: {}, log: observedLog, dryRun: false })
  const collect = async () => {
    const out = []
    for await (const item of provider.run(ctx)) {
      if (item.type === 'event') events.push(item)
      else out.push(item)
    }
    return out
  }
  await assert.rejects(collect(), /some_chats_failed/)
  assert.equal(reads.length, 20)
  assert.ok(events.some(e => e.event === 'cloud_chat_failed'))
  assert.equal(logs.find(e => e.name === 'codex.cloud.discovered').fields.selected, 20)
  assert.equal(logs.find(e => e.name === 'codex.cloud.failed').fields.failed_chats, 1)
  assert.equal(logs.some(e => e.name === 'codex.cloud.completed'), false)
  assert.equal(JSON.stringify(logs).includes('synthetic prompt'), false)
  assert.equal((await collect()).length, 20)
  assert.deepEqual(reads.slice(20, 24), [20, 21, 22, 23].map(cloudId))
  assert.equal(reads.includes(cloudId(24)), false)
  assert.equal(reads.filter(id => id === cloudId(0)).length, 2)
  listed = [...listed, { id: cloudId(30), updatedAt: now / 1000 }]
  await collect()
  assert.equal(reads[40], cloudId(30))
  assert.equal(lists, 3)
  // An interrupted consumer cannot permanently checkpoint a yielded chat away.
  const interrupted = provider.run(ctx)[Symbol.asyncIterator]()
  await interrupted.next()
  await interrupted.return?.(undefined)
  const interruptedId = reads.at(-1)
  await collect()
  await collect()
  assert.ok(reads.filter(id => id === interruptedId).length >= 2)
})

test('account collection honors its lower bound and emits only newer messages', async t => {
  const stateDir = await temp(t)
  await fs.writeFile(cloudConnectionPath(stateDir), JSON.stringify({ version: 2, scope: 'account', accountHash, since: new Date(now + 1000).toISOString() }))
  const reads = []
  const h = history()
  h.items.push({ turnId: 'turn-new', startedAtMs: now + 2000, completedAtMs: now + 3000, item: { id: 'new', type: 'agentMessage', text: 'new text' } })
  const provider = createCodexCloudProvider({ stateDir, codexHome: '/fake', env: {}, ignoredSessions: new Set() }, {
    acquire: async () => auth, readAuth: async () => auth,
    open: async () => ({ call: async () => ({}), close() {} }),
    listThreads: async () => [{ id: cloudId(1), updatedAt: now / 1000 }, { id: threadId, updatedAt: now / 1000 + 3 }],
    readThread: async (_client, id) => {
      reads.push(id)
      return h
    },
  })
  const out = []
  for await (const item of provider.run(/** @type {any} */ ({ env: {}, log, dryRun: false }))) out.push(item)
  assert.deepEqual(reads, [threadId])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].value.messages.map(m => m.content), ['new text'])
})


test('durable session exclusions refresh across runs and corrupt state blocks auth', async t => {
  const stateDir = await temp(t)
  const ignoredSessions = new SessionIgnoreSet(stateDir)
  const writer = new SessionIgnoreSet(stateDir)
  await fs.writeFile(cloudConnectionPath(stateDir), JSON.stringify({ version: 1, accountHash, threads: [threadId] }))
  let authCalls = 0
  const provider = createCodexCloudProvider({ stateDir, codexHome: '/fake', env: {}, ignoredSessions }, {
    acquire: async () => {
      authCalls++
      return auth
    },
    readAuth: async () => auth,
    open: async () => ({ call: async () => ({}), close() {} }),
    readThread: async () => history(),
  })
  const collect = async () => {
    const out = []
    for await (const item of provider.run(/** @type {any} */ ({ log }))) out.push(item)
    return out
  }
  writer.add(threadId)
  assert.deepEqual(await collect(), [])
  assert.equal(authCalls, 0)
  writer.delete(threadId)
  assert.equal((await collect()).length, 1)
  await fs.writeFile(path.join(stateDir, 'session-ignores', 'invalid.json'), 'invalid')
  await assert.rejects(collect(), /collection_failed/)
  assert.equal(authCalls, 1)
})

test('connection commands validate before auth, persist only grants and replace or remove them', async t => {
  const stateDir = await temp(t)
  const commands = new Map()
  let authCalls = 0
  registerCloudCommands(/** @type {any} */ ({ paths: { stateDir }, env: {},
    commands: { register: c => commands.set(c.name, c) },
  }), '/fake', { acquire: async () => {
      authCalls++
      return auth
    } })
  let stdout = ''
  const run = (name, args = []) => commands.get(`codex-cloud ${name}`).run(args, { stdout: { write: s => { stdout += s } } })
  await assert.rejects(run('connect', ['--all', '--bad']), /invalid_connection_arguments/)
  await assert.rejects(run('connect', ['bad']), /provide_1_to_20/)
  assert.equal(authCalls, 0)
  await run('connect', [threadId])
  assert.deepEqual(await readCloudConnection(stateDir), { version: 1, accountHash, threads: [threadId], origins: ['codex_cloud'] })
  await run('connect', ['--all', '--from-now', '--origins', 'codex_work_web,codex_work_mobile'])
  const grant = await readCloudConnection(stateDir)
  assert.equal(grant?.version, 2)
  assert.ok(grant?.version === 2 && Number.isFinite(Date.parse(grant.since ?? '')))
  assert.equal((await fs.stat(cloudConnectionPath(stateDir))).mode & 0o777, 0o600)
  assert.equal((await fs.readFile(cloudConnectionPath(stateDir), 'utf8')).includes(auth.token), false)
  stdout = ''
  await run('status')
  assert.equal(JSON.parse(stdout).scope, 'account')
  assert.deepEqual(JSON.parse(stdout).origins, ['codex_work_web', 'codex_work_mobile'])
  assert.equal(stdout.includes(accountHash), false)
  await run('disconnect')
  assert.equal(await readCloudConnection(stateDir), undefined)
})


test('each supported origin is independently selectable and discovery cannot widen the grant', async () => {
  const supported = /** @type {const} */ (['codex_cloud', 'codex_work_web', 'codex_work_mobile'])
  const rows = [...supported, 'codex_work_cca', null].map((originator, n) => ({
    id: cloudId(n), updatedAt: now / 1000, originator, source: { custom: 'codex-cloud-agent' },
  }))
  for (const origin of supported) {
    const result = await listCloudThreads({ call: async (_method, params) => {
      assert.equal(Object.hasOwn(params, 'originators'), false)
      return { data: rows, nextCursor: null }
    } }, [origin])
    assert.deepEqual(result.map(r => r.id), rows.filter(r => r.originator === origin).map(r => r.id))
    const h = history()
    h.thread.originator = origin
    const client = { call: async method => method === 'thread/read' ? { thread: h.thread } : { data: h.items, nextCursor: null } }
    assert.equal((await readCloudThread(client, threadId, [origin])).thread.originator, origin)
    const other = supported.find(value => value !== origin)
    assert.ok(other)
    await assert.rejects(readCloudThread(client, threadId, [other]), /unsupported_thread_originator/)
  }
  assert.deepEqual(validateCloudOrigins([...supported]), [...supported])
  for (const value of [[], ['codex_work_cca'], ['codex_cloud', 'codex_cloud'], ['unknown'], null]) {
    assert.throws(() => validateCloudOrigins(value), /choose_codex/)
  }
})
