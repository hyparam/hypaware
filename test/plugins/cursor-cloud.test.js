// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { readCursorCloudConversation, CursorCloudError, readCursorCloudMetadata } from '../../hypaware-core/plugins-workspace/cursor/src/cloud-client.js'
import { projectCursorCloudHook, projectCursorCloudConversation, redactCursorCloud } from '../../hypaware-core/plugins-workspace/cursor/src/cloud.js'
import { cursorCloudConnectionPath, connectCursorCloud, readCursorCloudConnection } from '../../hypaware-core/plugins-workspace/cursor/src/cloud-state.js'
import { registerCursorCloudCommands, startCursorCloudDaemon } from '../../hypaware-core/plugins-workspace/cursor/src/cloud-commands.js'
import { createStartCursorSource } from '../../hypaware-core/plugins-workspace/cursor/src/listener.js'
/** @import { TestContext } from 'node:test' */

const agentId = 'bc-11111111-2222-4333-8444-555555555555'
const repository = 'https://github.com/example/synthetic'
const connection = { version: /** @type {const} */ (1), agentId, repository, cwd: '/synthetic' }
const metadata = { id: agentId, status: 'FINISHED', source: { repository } }
const conversation = { id: agentId, messages: [
  { id: 'first-prompt', type: 'user_message', text: 'same prompt' },
  { id: 'turn-0:step:1:assistant', type: 'assistant_message', text: 'FIRST_RESPONSE', thinking: 'HIDDEN' },
  { id: 'next-prompt', type: 'user_message', text: 'same prompt' },
  { id: 'turn-1:step:1:assistant', type: 'assistant_message', text: 'NEXT_RESPONSE' },
] }

/** @param {() => boolean | Promise<boolean>} predicate */
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return
    await delay(10)
  }
  assert.fail('Cloud capture did not reach its expected state')
}

test('API text has native identities, no reasoning, and no inferred original timestamp or model', async () => {
  const calls = []
  const fetcher = /** @type {typeof fetch} */ (async (url, options) => {
    assert.ok(options)
    calls.push(String(url))
    assert.equal(options.redirect, 'error')
    assert.equal(new Headers(options.headers).get('authorization'), 'Basic ' + Buffer.from('synthetic-key:').toString('base64'))
    return Response.json(String(url).endsWith('/conversation') ? conversation : metadata)
  })
  const result = await readCursorCloudConversation(connection, 'synthetic-key', { fetcher })
  assert.ok(result)
  assert.deepEqual(calls, ['', '/conversation', ''].map(suffix => 'https://api.cursor.com/v0/agents/' + agentId + suffix))
  const projected = projectCursorCloudConversation(result, connection)
  assert.equal(projected.length, 4)
  assert.notEqual(projected[0].messages[0].message_id, projected[2].messages[0].message_id)
  assert.deepEqual(projected, projectCursorCloudConversation(result, connection))
  assert.doesNotMatch(JSON.stringify(projected), /HIDDEN|thinking/)
  assert.ok(projected.every(p => p.messages[0].message_created_at === undefined && p.model === undefined && p.entrypoint === 'cloud'))
})

test('API refuses pending snapshots, scope changes, malformed identities and unbounded bodies without exposing server text', async () => {
  const read = fetcher => readCursorCloudConversation(connection, 'synthetic-key', { fetcher })
  let requests = 0
  assert.equal(await read(async () => {
    requests++
    return Response.json({ ...metadata, status: 'RUNNING' })
  }), undefined)
  assert.equal(requests, 1)
  requests = 0
  assert.equal(await read(async () => Response.json(++requests === 1 ? metadata : requests === 2 ? conversation : { ...metadata, status: 'RUNNING' })), undefined)
  await assert.rejects(read(async () => Response.json({ ...metadata, source: { repository: 'https://github.com/other/private' } })), /cloud_api_scope/)
  await assert.rejects(read(async () => new Response('PRIVATE SERVER BODY', { status: 401 })), error => error instanceof CursorCloudError && error.code === 'cloud_api_http_401' && !error.message.includes('PRIVATE'))
  await assert.rejects(read(async () => new Response('x'.repeat(65537))), /cloud_api_response_limit/)
  await assert.rejects(read(async url => Response.json(String(url).endsWith('/conversation') ? { ...conversation, messages: [conversation.messages[0], conversation.messages[0]] } : metadata)), /cloud_api_message_shape/)
  await assert.rejects(read(async () => new Response('PRIVATE invalid JSON')), /cloud_api_json/)
})

test('hook projection separates edits and tools, suppresses main text, and redacts structured thought and secret fields', () => {
  const envelope = event => ({ delivery_id: randomUUID(), observed_at: new Date().toISOString(), event: { workspace_roots: ['/synthetic'], conversation_id: agentId, ...event } })
  assert.equal(projectCursorCloudHook(envelope({ hook_event_name: 'beforeSubmitPrompt', prompt: 'FIRST_PROMPT' }), connection), undefined)
  const tool = envelope({ hook_event_name: 'postToolUse', tool_use_id: 'one', tool_name: 'Shell', tool_input: { command: 'repeat', thinking: 'HIDDEN' }, tool_output: { output: 'synthetic-key', exitCode: 0, reasoning: 'HIDDEN' } })
  const projected = projectCursorCloudHook(tool, connection, { CURSOR_API_KEY: 'synthetic-key' })
  assert.ok(projected)
  assert.doesNotMatch(JSON.stringify(projected), /HIDDEN|synthetic-key/)
  const replay = projectCursorCloudHook({ ...tool, delivery_id: randomUUID() }, connection)
  const repeated = projectCursorCloudHook({ ...tool, event: { ...tool.event, tool_use_id: 'two' } }, connection)
  assert.ok(replay && repeated)
  assert.deepEqual(projected.messages.map(m => m.message_id), replay.messages.map(m => m.message_id))
  assert.notEqual(projected.messages[0].message_id, repeated.messages[0].message_id)
  const edit = projectCursorCloudHook(envelope({ hook_event_name: 'afterFileEdit', file_path: '/synthetic/file', edits: [{ old_string: 'before', new_string: 'after', unrelated: 'NO' }] }), connection)
  assert.ok(edit && typeof edit.messages[0].content === 'string')
  assert.deepEqual(JSON.parse(edit.messages[0].content), { file_path: '/synthetic/file', edits: [{ old_string: 'before', new_string: 'after' }] })
  assert.equal(edit.messages[0].role, 'system')
  assert.equal(edit.messages[0].provider_type, 'hook')
  assert.throws(() => redactCursorCloud({ ...projected, messages: [{ role: 'user', content: 'x'.repeat(256 * 1024) }] }, {}), /cloud_record_limit/)
})

/** @param {TestContext} t */
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-')))
  const cwd = path.join(root, 'repo')
  await fs.mkdir(cwd)
  const stateDir = path.join(root, 'state')
  const socket = path.join(root, 'meta.sock')
  const server = http.createServer((req, res) => {
    res.end(req.url?.endsWith('agent/id') ? agentId : 'github.com/example/synthetic')
  })
  await new Promise(resolve => server.listen(socket, () => resolve(undefined)))
  t.after(async () => {
    await stop()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  const env = { HOME: root, HYP_HOME: path.join(root, 'hyp'), CURSOR_AGENT_SOCKET: socket, CURSOR_API_KEY: 'synthetic-key' }
  const grant = await connectCursorCloud(stateDir, cwd, env)
  const rows = []
  const events = []
  const ignoredSessions = new Set()
  const storage = { cacheTablePath: () => '/cache/ai_gateway_messages', async discoverCachePartitions() { return [] }, async *readRows() {}, async *readSpooledRows() { yield* rows }, async appendRows(_path, _cols, next) { rows.push(...next) } }
  let apiCalls = 0
  const cloud = { stateDir, connection: grant, intervalMs: 25, fetcher: /** @type {typeof fetch} */ (async url => {
    apiCalls++
    return Response.json(String(url).endsWith('/conversation') ? conversation : metadata)
  }) }
  const ctx = /** @type {any} */ ({ config: { listen_port: 0 }, env, storage, paths: { stateDir }, plugin: { version: '1.0.0' }, log: { info(...args) { events.push(args) }, warn(...args) { events.push(args) }, error(...args) { events.push(args) } } })
  let source
  let sourceRunning = false
  let endpoint
  const stop = async () => {
    if (!sourceRunning) return
    sourceRunning = false
    await source.stop()
  }
  const start = async () => {
    source = await createStartCursorSource({ ignoredSessions, cloud })(ctx)
    sourceRunning = true
    endpoint = `http://127.0.0.1:${(await source.status()).details.listen_port}`
  }
  return { root, cwd, env, stateDir, grant, ctx, cloud, rows, events, ignoredSessions, storage, start, stop,
    get source() { return source }, get apiCalls() { return apiCalls },
    post(event, delivery_id = randomUUID()) { return fetch(endpoint + '/hook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delivery_id, observed_at: new Date().toISOString(), event: { conversation_id: agentId, workspace_roots: [cwd], ...event } }) }) },
  }
}

test('real listener and writer recover first-turn text, dedupe restart, preserve edits, and refuse unsafe paths or revoked grants', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await f.start()
  await until(() => f.rows.length === 4)
  assert.equal((await f.post({ hook_event_name: 'beforeSubmitPrompt', prompt: 'same prompt' })).status, 202)
  const tool = { hook_event_name: 'postToolUse', tool_use_id: 'one', tool_name: 'Shell', tool_input: { command: 'repeat' }, tool_output: { output: 'SHELL\n', exitCode: 0 } }
  await f.post(tool)
  await f.post(tool)
  await f.post({ ...tool, tool_use_id: 'two' })
  const file = path.join(f.cwd, 'file.txt')
  await fs.writeFile(file, 'after')
  const edit = { hook_event_name: 'afterFileEdit', file_path: file, edits: [{ old_string: 'before', new_string: 'after' }] }
  const delivery = randomUUID()
  await f.post(edit, delivery)
  await f.post(edit, delivery)
  assert.equal(f.rows.length, 9)
  assert.equal(f.rows.filter(r => r.content_text === 'same prompt').length, 2)
  assert.equal(f.rows.filter(r => r.hook_event === 'afterFileEdit').length, 1)
  const privateDir = path.join(f.cwd, 'private')
  await fs.mkdir(privateDir)
  await fs.writeFile(path.join(privateDir, '.hypignore'), 'local-only\n')
  await fs.writeFile(path.join(privateDir, 'secret'), 'secret')
  const outside = path.join(f.root, 'outside')
  await fs.writeFile(outside, 'outside')
  if (process.platform !== 'win32') await fs.symlink(outside, path.join(f.cwd, 'link'))
  for (const file_path of [outside, path.join(f.cwd, 'link'), path.join(privateDir, 'secret')]) assert.equal((await f.post({ ...edit, file_path })).status, 202)
  assert.equal((await f.post({ ...tool, tool_name: 'Read', tool_use_id: 'outside-read', tool_input: { path: outside }, tool_output: 'PRIVATE OUTSIDE CONTENT' })).status, 202)
  await f.stop()
  await f.start()
  await until(async () => (await f.source.status()).details.api_messages === 4)
  assert.equal(f.rows.length, 9)
  assert.equal((await f.source.status()).details.native_reads, 0)
  const before = f.apiCalls
  await fs.rm(cursorCloudConnectionPath(f.stateDir))
  assert.equal((await f.post({ ...tool, tool_use_id: 'revoked' })).status, 202)
  await until(async () => (await f.source.status()).details.cloud_state === 'withheld')
  assert.equal(f.apiCalls, before)
  assert.equal(f.rows.length, 9)
  assert.doesNotMatch(JSON.stringify(f.events), /synthetic-key|FIRST_RESPONSE|same prompt/)
})

test('failed storage is retried without identity loss and parent opt-out withholds child hooks and API reads', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const append = f.storage.appendRows
  f.storage.appendRows = async () => { throw new Error('PRIVATE storage details') }
  await f.start()
  await until(async () => (await f.source.status()).details.api_failures === 1)
  assert.equal((await f.source.status()).state, 'degraded')
  f.storage.appendRows = append
  await until(() => f.rows.length === 4)
  assert.equal((await f.source.status()).state, 'ready')
  f.ignoredSessions.add(agentId)
  const before = f.apiCalls
  assert.equal((await f.post({ conversation_id: 'child', hook_event_name: 'beforeSubmitPrompt', prompt: 'PRIVATE child' })).status, 202)
  await until(async () => (await f.source.status()).details.cloud_state === 'withheld')
  assert.equal(f.apiCalls, before)
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE storage details/)
})

test('connect dry-run and disconnect preserve foreign hooks, and corrupt grants fail closed', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await fs.rm(cursorCloudConnectionPath(f.stateDir))
  await fs.mkdir(path.join(f.cwd, '.cursor'))
  const hooksFile = path.join(f.cwd, '.cursor/hooks.json')
  const original = { version: 1, hooks: { stop: [{ command: 'foreign-hook' }] } }
  await fs.writeFile(hooksFile, JSON.stringify(original))
  const commands = new Map()
  f.ctx.commands = { register(command) { commands.set(command.name, command) } }
  registerCursorCloudCommands(f.ctx)
  const output = []
  const command = /** @type {any} */ ({ cwd: f.cwd, env: f.env, platform: 'linux', stdout: { write(value) { output.push(value) } } })
  await commands.get('cursor-cloud connect').run(['--dry-run'], command)
  assert.equal(await readCursorCloudConnection(f.stateDir), undefined)
  assert.deepEqual(JSON.parse(await fs.readFile(hooksFile, 'utf8')), original)
  await commands.get('cursor-cloud connect').run([], command)
  assert.ok(await readCursorCloudConnection(f.stateDir))
  const installed = JSON.parse(await fs.readFile(hooksFile, 'utf8'))
  assert.ok(installed.hooks.afterFileEdit[0].command.endsWith("'cloud'"))
  await commands.get('cursor-cloud disconnect').run([], command)
  assert.equal(await readCursorCloudConnection(f.stateDir), undefined)
  assert.deepEqual(JSON.parse(await fs.readFile(hooksFile, 'utf8')), original)
  await fs.writeFile(cursorCloudConnectionPath(f.stateDir), '{bad')
  await assert.rejects(readCursorCloudConnection(f.stateDir), /cloud_connection_invalid/)
  await commands.get('cursor-cloud disconnect').run([], command)
  assert.equal(await readCursorCloudConnection(f.stateDir), undefined)
  assert.doesNotMatch(output.join(''), /synthetic-key/)
  assert.deepEqual(await readCursorCloudMetadata(f.env), { agentId, repository })
})

test('disconnect during an API read prevents its append and stop aborts a blocked request', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  let release
  let reading = false
  const waiting = new Promise(resolve => { release = resolve })
  f.cloud.fetcher = /** @type {typeof fetch} */ (async url => {
    if (!String(url).endsWith('/conversation')) return Response.json(metadata)
    reading = true
    await waiting
    return Response.json(conversation)
  })
  await f.start()
  await until(() => reading)
  await fs.rm(cursorCloudConnectionPath(f.stateDir))
  release()
  await until(async () => (await f.source.status()).details.cloud_state === 'withheld')
  assert.equal(f.rows.length, 0)
  await f.stop()
  await connectCursorCloud(f.stateDir, f.cwd, f.env)
  reading = false
  f.cloud.fetcher = /** @type {typeof fetch} */ (async (_url, options) => {
    reading = true
    const signal = options?.signal
    assert.ok(signal)
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('PRIVATE transport detail')), { once: true }))
    return Response.json(metadata)
  })
  await f.start()
  await until(() => reading)
  const before = performance.now()
  await f.stop()
  assert.ok(performance.now() - before < 1000)
  assert.equal((await f.source.status()).details.api_failures, 0, 'shutdown cancellation is not a recovery error')
})

test('a quick follow-up between finished checks cannot freeze partial text under a native message ID', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  let snapshots = 0
  f.cloud.fetcher = /** @type {typeof fetch} */ (async url => {
    if (!String(url).endsWith('/conversation')) return Response.json(metadata)
    return Response.json({ id: agentId, messages: [{ id: 'turn-0:step:1:assistant', type: 'assistant_message', text: ++snapshots === 1 ? 'PARTIAL' : 'FULL_RESPONSE' }] })
  })
  await f.start()
  await until(() => f.rows.length === 1)
  assert.equal(f.rows[0].content_text, 'FULL_RESPONSE')
  assert.ok(snapshots >= 3, 'changed text must settle across two completed snapshots')
})

test('start reuses only the same agent and workspace, and a copied grant never reaches the API', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await f.start()
  const port = Number((await f.source.status()).details.listen_port)
  assert.deepEqual(await startCursorCloudDaemon(f.grant, f.env, port), { already_running: true })
  await assert.rejects(startCursorCloudDaemon({ ...f.grant, cwd: path.join(f.root, 'other') }, f.env, port), /cloud_listener_conflict/)
  await f.stop()
  const before = f.apiCalls
  const other = { ...f.cloud, readMetadata: async () => ({ agentId: 'bc-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', repository }) }
  await assert.rejects(createStartCursorSource({ cloud: other })(f.ctx), /cloud_metadata_scope/)
  assert.equal(f.apiCalls, before)
})
