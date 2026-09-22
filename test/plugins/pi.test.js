// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import test from 'node:test'
import extension from '../../packages/pi-extension/index.js'
import { projectPiEntries, piEntryFingerprint } from '../../hypaware-core/plugins-workspace/pi/src/projector.js'
import { createPiBackfillProvider, piSessionsRoot, readPiLines } from '../../hypaware-core/plugins-workspace/pi/src/backfill.js'
import { createStartPiSource } from '../../hypaware-core/plugins-workspace/pi/src/listener.js'
import { attachPiPlugin, piPluginPath, PI_PLUGIN_MARKER } from '../../hypaware-core/plugins-workspace/pi/src/attach.js'
import { validatePiConfig } from '../../hypaware-core/plugins-workspace/pi/src/config.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { resolveSessionIdForCli } from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'

const fixture = JSON.parse(await fs.readFile(new URL('../../hypaware-core/smoke/fixtures/pi-session.json', import.meta.url), 'utf8'))
const silent = { info() {}, warn() {}, debug() {}, error() {} }
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'hyp-pi-test-'))
const copy = () => structuredClone(fixture)

test('Pi projects stable native identities, structured tools and one net-usage carrier', () => {
  const projection = projectPiEntries(copy())
  assert.ok(projection)
  const rows = aiGatewayRowsFromProjectedExchange(projection)
  assert.equal(rows.length, 5)
  const usage = rows.map(r => /** @type {any} */ (r.attributes)?.usage).filter(Boolean)
  assert.equal(usage.length, 2)
  assert.equal(usage.reduce((n, v) => n + v.input_tokens, 0), 12)
  assert.equal(usage.reduce((n, v) => n + v.total_tokens, 0), 23)
  assert.ok(rows.some(r => r.part_type === 'tool_call' && r.tool_name === 'read' && r.tool_call_id === 'call-1'))
  assert.ok(rows.some(r => r.part_type === 'tool_result' && r.tool_name === 'read' && r.tool_call_id === 'call-1'))
  const other = copy()
  other.session.id = 'different-session'
  assert.notEqual(projectPiEntries(other)?.messages[0].message_id, projection.messages[0].message_id)
  other.session.id = fixture.session.id
  other.session.cwd = '/other/root'
  assert.notEqual(projectPiEntries(other)?.messages[0].message_id, projection.messages[0].message_id)
  assert.deepEqual(projectPiEntries(copy()), projection)
})

test('Pi fork copies and nested tool aggregates do not add billed usage twice', () => {
  const raw = copy()
  raw.entries[2].message.usage = { input: 99, output: 99, totalTokens: 198 }
  const inherited = new Map(raw.entries.map(e => [e.id, piEntryFingerprint(e)]))
  raw.session.id = 'fork'
  raw.entries[1].parentId = null
  raw.entries[3].firstKeptEntryId = 'rewritten-label'
  const messages = projectPiEntries(raw, { inherited })?.messages
  assert.ok(messages?.every(m => !m.attributes?.usage))
  assert.ok(messages?.some(m => m.attributes?.raw_usage))
})

test('Pi projection does not serialize payloads without a matching fork parent ID', () => {
  const raw = copy()
  raw.entries[1].message.toJSON = () => { throw new Error('unnecessary payload serialization') }
  assert.equal(projectPiEntries(raw)?.messages.length, 4)
  assert.equal(projectPiEntries(raw, { inherited: new Map([['unrelated', 'hash']]) })?.messages.length, 4)
})

test('Pi rejects unsupported headers and partial assistant messages', () => {
  const raw = copy()
  raw.session.cwd = 'relative'
  assert.equal(projectPiEntries(raw), undefined)
  raw.session.cwd = '/absolute'
  raw.session.version = 4
  assert.equal(projectPiEntries(raw), undefined)
  raw.session.version = 3
  raw.entries = [raw.entries[1]]
  raw.entries[0].message.stopReason = 'pending'
  assert.equal(projectPiEntries(raw), undefined)
  raw.entries[0].message.stopReason = 'aborted'
  raw.entries[0].message.content = []
  assert.equal(projectPiEntries(raw)?.messages.length, 1)
})

test('Shared projection honors explicit positions on every part and preserves the legacy default', () => {
  const projection = projectPiEntries(copy())
  assert.ok(projection)
  for (const [i, message] of projection.messages.entries()) message.message_index = i + 70
  assert.deepEqual(aiGatewayRowsFromProjectedExchange(projection).map(row => row.message_index), [70, 71, 71, 72, 73])
  for (const message of projection.messages) delete message.message_index
  assert.deepEqual(aiGatewayRowsFromProjectedExchange(projection).map(row => row.message_index), [0, 1, 1, 2, 3])
  assert.equal(projectPiEntries({ ...copy(), message_indices: [0, 1] }), undefined)
  for (const invalid of [-1, 0.5, NaN, Infinity, 2147483648, null, '12']) {
    projection.messages[0].message_index = /** @type {any} */ (invalid)
    assert.throws(() => aiGatewayRowsFromProjectedExchange(projection), /message_index must be a nonnegative INT32/)
  }
})

/** @param {string} root @param {any} raw @param {string} name */
async function writeSession(root, raw, name) {
  const file = path.join(root, `${name}.jsonl`)
  await fs.writeFile(file, [raw.session, ...raw.entries].map(e => JSON.stringify(e)).join('\n') + '\n')
  return file
}

/** @param {any} provider @param {any} context */
async function collect(provider, context) {
  const items = []
  const events = []
  for await (const entry of provider.run(context)) (entry.type === 'event' ? events : items).push(entry)
  return { items, events }
}

test('Pi recovery keeps session positions across batches, metadata and time filtering', async () => {
  const root = await temp()
  try {
    const raw = copy()
    raw.session.cwd = root
    raw.entries = Array.from({ length: 150 }, (_, i) => ({
      type: 'message', id: `order-${i}`, parentId: i ? `order-${i - 1}` : null,
      timestamp: new Date(Date.UTC(2026, 8, 17, 10, 0, i)).toISOString(),
      message: { role: 'user', content: `message ${i}` },
    }))
    raw.entries.splice(60, 0, { type: 'model_change', id: 'metadata', parentId: 'order-59', timestamp: raw.entries[59].timestamp })
    await writeSession(root, raw, 'ordered')
    const provider = createPiBackfillProvider({ env: { PI_CODING_AGENT_SESSION_DIR: root } })
    const result = await collect(provider, { env: {}, log: silent, dryRun: true })
    const rows = result.items.flatMap(item => aiGatewayRowsFromProjectedExchange(item.value))
    assert.deepEqual(rows.map(row => row.message_index), Array.from({ length: 150 }, (_, i) => i))
    const filtered = await collect(provider, { env: {}, log: silent, dryRun: true, since: raw.entries[100].timestamp })
    const later = filtered.items.flatMap(item => aiGatewayRowsFromProjectedExchange(item.value))
    assert.equal(later[0].message_index, 99)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Pi recovery skips unchanged input, retries changed/partial input and honors dry-run/write failures', async () => {
  const root = await temp()
  try {
    const raw = copy()
    raw.session.cwd = root
    const file = await writeSession(root, raw, 'session')
    const provider = createPiBackfillProvider({ env: { PI_CODING_AGENT_SESSION_DIR: root } })
    const ctx = { env: {}, storage: {}, cacheRoot: root, log: silent, dryRun: true, sweep: true, itemsFailed: 0 }
    assert.equal((await collect(provider, ctx)).items.length, 1)
    ctx.dryRun = false
    assert.equal((await collect(provider, ctx)).items.length, 1)
    assert.equal((await collect(provider, ctx)).items.length, 0)
    await fs.appendFile(file, '{"type":"message"')
    assert.equal((await collect(provider, ctx)).items.length, 1)
    await fs.appendFile(file, ',"id":"more","parentId":null,"timestamp":"2026-09-17T10:00:05Z","message":{"role":"user","content":"new"}}\n')
    assert.equal((await collect(provider, ctx)).items[0].value.messages.length, 5)
    const retry = createPiBackfillProvider({ env: { PI_CODING_AGENT_SESSION_DIR: root } })
    for await (const item of retry.run(/** @type {any} */ (ctx))) if (item.type !== 'event') ctx.itemsFailed++
    assert.equal((await collect(retry, ctx)).items.length, 1)
    assert.equal(createPiBackfillProvider({ config: { backfill: { on_join: false } } }).sweep, undefined)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Pi recovery verifies fork provenance and refuses excluded/missing parents', async () => {
  const root = await temp()
  try {
    const parent = copy()
    parent.session.cwd = root
    const parentFile = await writeSession(root, parent, 'parent')
    const fork = copy()
    fork.session = { ...parent.session, id: 'child', parentSession: parentFile }
    await writeSession(root, fork, 'child')
    const ignored = new Set()
    const provider = createPiBackfillProvider({ env: { PI_CODING_AGENT_SESSION_DIR: root }, ignoredSessions: ignored })
    const ctx = { env: {}, log: silent, dryRun: false }
    const result = await collect(provider, ctx)
    const child = result.items.find(i => i.value.session_id === 'child')
    assert.ok(child)
    assert.ok(child.value.messages.every(m => !m.attributes.usage))
    ignored.add(parent.session.id)
    assert.equal((await collect(provider, ctx)).items.length, 0)
    ignored.clear()
    await fs.unlink(parentFile)
    const missing = await collect(provider, ctx)
    assert.equal(missing.items.length, 0)
    assert.equal(missing.events.length, 1)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Pi recovery applies time windows, cwd policy and persisted session exclusions', async () => {
  const root = await temp()
  try {
    const raw = copy()
    raw.session.cwd = root
    await writeSession(root, raw, 'session')
    const ignored = new SessionIgnoreSet(path.join(root, 'state'))
    const provider = createPiBackfillProvider({ env: { PI_CODING_AGENT_SESSION_DIR: root }, ignoredSessions: ignored })
    const ctx = { env: {}, log: silent, dryRun: false, since: '2026-09-17T10:00:03Z', until: '2026-09-17T10:00:03Z' }
    assert.equal((await collect(provider, ctx)).items[0].value.messages.length, 1)
    ignored.add(raw.session.id)
    assert.equal((await collect(provider, ctx)).items.length, 0)
    ignored.delete(raw.session.id)
    await fs.writeFile(path.join(root, '.hypignore'), 'ignore\n')
    assert.equal((await collect(provider, ctx)).items.length, 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Pi sweep budgets include failed files and resume beyond them on the next run', async () => {
  const root = await temp()
  try {
    // Sparse files reserve their input size but fail on the first line, so
    // this exercises the real sweep ceiling without reading hundreds of MiB.
    for (const name of ['a', 'b', 'c', 'd']) {
      const file = path.join(root, `${name}.jsonl`)
      await fs.writeFile(file, 'invalid\n')
      await fs.truncate(file, 64 * 1024 * 1024)
    }
    const raw = copy()
    raw.session.cwd = root
    const last = await writeSession(root, raw, 'z')
    const signals = []
    const ctx = { env: {}, log: { ...silent, info(_name, attrs) { signals.push(attrs) } }, sweep: true, dryRun: false, itemsFailed: 0 }
    const provider = createPiBackfillProvider({ env: { PI_CODING_AGENT_SESSION_DIR: root } })
    const first = await collect(provider, ctx)
    assert.equal(first.items.length, 0)
    assert.equal(first.events.filter(e => e.event === 'file_failed').length, 4)
    assert.ok(first.events.some(e => e.event === 'scan_deferred'))
    assert.equal(signals.at(-1).scan_bytes_reserved, 256 * 1024 * 1024)
    const next = await collect(provider, ctx)
    assert.equal(next.items[0].value.session_id, raw.session.id)
    assert.equal(signals.at(-1).fingerprint_count, 1)
    await fs.unlink(last)
    await collect(provider, ctx)
    assert.equal(signals.at(-1).fingerprint_count, 0)
    assert.equal(signals.at(-1).scan_deferred, false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Pi JSONL framing copies long split lines once and rejects oversized unfinished input', async t => {
  const root = await temp()
  try {
    const file = path.join(root, 'lines.jsonl')
    const value = { text: 'x'.repeat(65520) + '🙂'.repeat(200000) }
    const line = JSON.stringify(value)
    await fs.writeFile(file, line + '\n{}\n{"unfinished":')
    const original = Buffer.concat
    let copied = 0
    const mock = t.mock.method(Buffer, 'concat', (parts, length) => {
      copied += length ?? parts.reduce((sum, part) => sum + part.length, 0)
      return original(parts, length)
    })
    const lines = []
    try {
      for await (const entry of readPiLines(file, (await fs.stat(file)).size)) lines.push(entry)
    } finally { mock.mock.restore() }
    assert.deepEqual(lines.map(v => v.entry), [value, {}])
    assert.equal(lines[0].bytes, Buffer.byteLength(line))
    assert.ok(copied <= Buffer.byteLength(line) + 65536, `copied ${copied} bytes`)
    await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1))
    await assert.rejects(async () => { for await (const _entry of readPiLines(file, (await fs.stat(file)).size)) {} }, /line_budget/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Pi package and managed attach are independently discoverable and marker-owned', async () => {
  const root = await temp()
  try {
    const env = { HOME: root, PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_HOME: '/wrong' }
    const opts = { endpoint: 'http://127.0.0.1:4322', version: 'test', env }
    const dry = await attachPiPlugin({ ...opts, dryRun: true })
    await assert.rejects(fs.stat(dry.settingsPath), { code: 'ENOENT' })
    const first = await attachPiPlugin(opts)
    assert.equal(first.settingsPath, path.join(env.PI_CODING_AGENT_DIR, 'extensions/hypaware.js'))
    assert.ok((await fs.readFile(first.settingsPath, 'utf8')).includes(PI_PLUGIN_MARKER))
    assert.equal((await attachPiPlugin(opts)).changed, false)
    const custom = await attachPiPlugin({ ...opts, endpoint: 'http://127.0.0.1:4399', env: { ...env, PI_CODING_AGENT_DIR: path.join(root, 'agent2') } })
    const customBody = await fs.readFile(custom.settingsPath, 'utf8')
    assert.ok(customBody.includes("DEFAULT_ENDPOINT = 'http://127.0.0.1:4399'"))
    assert.equal(customBody.includes('http://127.0.0.1:4322'), false)
    const discovered = await discoverBundledPlugins()
    const catalog = buildPluginCatalog([...discovered.loaded, ...discovered.excluded])
    assert.equal(catalog.pickerDescriptors.get('pi')?.label, 'Pi')
    const descriptor = catalog.clientDescriptors.get('pi')
    assert.ok(descriptor)
    assert.equal((await detachClientFromDisk({ descriptor, homeDir: root, env })).changed, true)
    await fs.writeFile(first.settingsPath, '// user extension')
    await assert.rejects(attachPiPlugin(opts), /not HypAware-owned/)
    assert.equal((await fs.readFile(first.settingsPath, 'utf8')), '// user extension')
    const pkg = JSON.parse(await fs.readFile(new URL('../../packages/pi-extension/package.json', import.meta.url), 'utf8'))
    assert.deepEqual(pkg.pi.extensions, ['./index.js'])
    assert.equal(pkg.dependencies, undefined)
    assert.equal(piPluginPath({ homeDir: root, env: { PI_HOME: '/wrong' } }), path.join(root, '.pi/agent/extensions/hypaware.js'))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Pi resolves real environment roots and refuses ambiguous session identity', () => {
  assert.equal(piSessionsRoot({ HOME: '/test', PI_CODING_AGENT_DIR: '/agent' }), '/agent/sessions')
  assert.equal(piSessionsRoot({ PI_CODING_AGENT_SESSION_DIR: '/sessions' }), '/sessions')
  assert.deepEqual(resolveSessionIdForCli({ env: { PI_SESSION_ID: 'native' }, cwd: '/test' }), { ok: true, sessionId: 'native', source: 'pi_env' })
  assert.equal(resolveSessionIdForCli({ env: { PI_SESSION_ID: 'native', CODEX_THREAD_ID: 'outer' }, cwd: '/test' }).ok, false)
  assert.equal(validatePiConfig({ listen_port: 4322, backfill: { sweep_cron: '*/5 * * * *' } }).ok, true)
  assert.equal(validatePiConfig({ listen_port: -1, backfill: { sweep_cron: 'bad' } }).ok, false)
})

test('Pi listener records once, refuses browser requests and applies live policy/control', async () => {
  const root = await temp()
  const rows = []
  const storage = { cacheTablePath: () => '/cache/pi', async discoverCachePartitions() { return [] }, async *readRows() {}, async *readSpooledRows() { yield* rows }, async appendRows(_p, _c, batch) { rows.push(...batch) } }
  const ignored = new SessionIgnoreSet(path.join(root, 'state'))
  const source = await createStartPiSource({ ignoredSessions: ignored })(/** @type {any} */ ({ config: { listen_port: 0 }, storage, log: silent }))
  try {
    const port = (await source.status?.())?.details?.listen_port
    const endpoint = `http://127.0.0.1:${port}`
    const post = (body, route = '/entries', type = 'application/json') => fetch(endpoint + route, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) })
    const raw = copy()
    raw.session.cwd = root
    raw.message_indices = [0, 1, 2, 3]
    assert.equal((await post(raw)).status, 200)
    assert.equal(rows.length, 5)
    assert.equal((await post(raw)).status, 200)
    assert.equal(rows.length, 5)
    assert.equal((await post(raw, '/entries', 'text/plain')).status, 415)
    assert.equal((await post({ ...raw, version: 1 })).status, 400)
    assert.equal((await post({ ...raw, message_indices: undefined })).status, 400)
    assert.equal((await post({ ...raw, message_indices: [0, 1, -1, 3] })).status, 400)
    await post({ session_id: raw.session.id }, '/_hypaware/ignore/session')
    assert.equal((await post(raw)).status, 202)
    raw.session.id = 'other'
    await fs.writeFile(path.join(root, '.hypignore'), 'ignore\n')
    assert.equal((await post(raw)).status, 202)
    assert.equal(rows.length, 5)
  } finally { await source.stop(); await fs.rm(root, { recursive: true, force: true }) }
})

test('Pi extension captures post-append deltas, suppresses duplicate instances and skips ephemeral sessions', async () => {
  const originalFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return new Response('{}') }
  /** @type {Map<string, Function[]>} */
  const hooks = new Map()
  const api = { on(name, fn) { hooks.set(name, [...(hooks.get(name) ?? []), fn]) }, registerCommand() {} }
  const raw = copy()
  let entries = []
  let persisted = true
  const ctx = { mode: 'print', sessionManager: { getEntries: () => entries.slice(), getLeafId: () => entries.at(-1)?.id ?? null, getEntry: id => entries.find(e => e.id === id), getHeader: () => raw.session, getSessionFile: () => persisted ? '/session.jsonl' : undefined } }
  const emit = async name => { for (const fn of hooks.get(name) ?? []) await fn({}, ctx) }
  try {
    extension(api)
    extension(api)
    assert.equal(hooks.has('message_end'), false)
    await emit('session_start')
    entries = raw.entries.slice(0, 3)
    await emit('turn_end')
    await emit('agent_end')
    await emit('session_shutdown')
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].entries, entries)
    persisted = false
    await emit('session_start')
    entries = raw.entries
    await emit('session_compact')
    await emit('session_shutdown')
    assert.equal(sent.length, 1)
  } finally { globalThis.fetch = originalFetch; delete globalThis[Symbol.for('hypaware.pi-extension.v1')] }
})

test('Pi live positions agree with recovery after resume, branching, dropped entries and a fork', async () => {
  const originalFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return new Response('{}') }
  const hooks = new Map()
  const raw = copy()
  raw.entries = []
  /** @type {string | null} */
  let head = null
  let snapshots = 0
  const entriesById = new Map()
  const ctx = { mode: 'print', sessionManager: {
    getEntries() { snapshots++; return raw.entries.slice() }, getLeafId: () => head,
    getEntry: id => entriesById.get(id), getHeader: () => raw.session, getSessionFile: () => '/session.jsonl',
  } }
  const append = (type = 'message', content = 'text') => {
    const entry = { type, id: `live-${raw.entries.length}`, parentId: head, timestamp: new Date(Date.UTC(2026, 8, 17, 10, 0, raw.entries.length)).toISOString(), message: { role: 'user', content } }
    raw.entries.push(entry)
    entriesById.set(entry.id, entry)
    head = entry.id
  }
  try {
    // Resume with history. The first transmitted message must not become 0.
    for (let i = 0; i < 80; i++) append(i % 10 ? 'message' : 'model_change')
    extension({ on(name, fn) { hooks.set(name, fn) }, registerCommand() {} })
    hooks.get('session_start')({}, ctx)
    for (let i = 0; i < 100; i++) { append(); hooks.get('turn_end')({}, ctx) }
    assert.equal(snapshots, 1, 'ordinary turns never copy or scan session history')
    hooks.get('session_before_tree')({}, ctx)
    head = 'live-30'
    append('branch_summary')
    hooks.get('session_tree')({}, ctx)
    assert.equal(snapshots, 2)
    append('message', 'x'.repeat(600 * 1024))
    hooks.get('turn_end')({}, ctx)
    append()
    hooks.get('turn_end')({}, ctx)
    await hooks.get('session_shutdown')({}, ctx)
    const recoveredProjection = projectPiEntries(raw)
    assert.ok(recoveredProjection)
    const recovered = aiGatewayRowsFromProjectedExchange(recoveredProjection)
    const byId = new Map(recovered.map(row => [row.part_id, row.message_index]))
    const live = sent.flatMap(batch => {
      const projection = projectPiEntries(batch)
      assert.ok(projection)
      return aiGatewayRowsFromProjectedExchange(projection)
    })
    assert.ok(live.length > 64)
    assert.equal(live[0].message_index, 72)
    assert.equal(live.at(-1)?.message_index, recovered.at(-1)?.message_index)
    for (const row of live) assert.equal(row.message_index, byId.get(row.part_id))
    assert.equal(new Set(live.map(row => row.message_index)).size, live.length)
    // Fork inherits a copied prefix, then adds new work in a new session.
    const parent = new Map(raw.entries.map(entry => [entry.id, piEntryFingerprint(entry)]))
    raw.entries = raw.entries.slice(0, 31)
    raw.session.id = 'forked'
    head = raw.entries.at(-1).id
    hooks.get('session_start')({}, ctx)
    append()
    hooks.get('turn_end')({}, ctx)
    await hooks.get('session_shutdown')({}, ctx)
    const forkLiveProjection = projectPiEntries(sent.at(-1))
    const forkRecoveryProjection = projectPiEntries(raw, { inherited: parent })
    assert.ok(forkLiveProjection)
    assert.ok(forkRecoveryProjection)
    const forkLive = aiGatewayRowsFromProjectedExchange(forkLiveProjection)
    const forkRecovered = aiGatewayRowsFromProjectedExchange(forkRecoveryProjection)
    assert.equal(forkLive[0].message_index, forkRecovered.at(-1)?.message_index)
  } finally { globalThis.fetch = originalFetch; delete globalThis[Symbol.for('hypaware.pi-extension.v1')] }
})

test('Pi live positions survive a turn whose session file is transiently unavailable', async () => {
  const originalFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return new Response('{}') }
  const hooks = new Map()
  const raw = copy()
  raw.entries = []
  /** @type {string | null} */
  let head = null
  let persisted = true
  const byId = new Map()
  const ctx = { mode: 'print', sessionManager: {
    getEntries: () => raw.entries.slice(), getLeafId: () => head, getEntry: id => byId.get(id),
    getHeader: () => raw.session, getSessionFile: () => persisted ? '/session.jsonl' : undefined,
  } }
  const append = () => {
    const entry = { type: 'message', id: `live-${raw.entries.length}`, parentId: head, timestamp: new Date(Date.UTC(2026, 8, 17, 10, 0, raw.entries.length)).toISOString(), message: { role: 'user', content: 'text' } }
    raw.entries.push(entry)
    byId.set(entry.id, entry)
    head = entry.id
  }
  try {
    extension({ on(name, fn) { hooks.set(name, fn) }, registerCommand() {} })
    hooks.get('session_start')({}, ctx)
    append()
    hooks.get('turn_end')({}, ctx)
    // The session file is momentarily unavailable. The checkpoint must not
    // move past this turn, or its entry is never counted and every later
    // position is short by one against recovery.
    append()
    persisted = false
    hooks.get('turn_end')({}, ctx)
    persisted = true
    append()
    hooks.get('turn_end')({}, ctx)
    await hooks.get('session_shutdown')({}, ctx)
    const recovered = projectPiEntries(raw)
    assert.ok(recovered)
    const byPart = new Map(aiGatewayRowsFromProjectedExchange(recovered).map(row => [row.part_id, row.message_index]))
    const live = sent.flatMap(batch => {
      const projection = projectPiEntries(batch)
      assert.ok(projection)
      return aiGatewayRowsFromProjectedExchange(projection)
    })
    assert.equal(live.length, 3)
    for (const row of live) assert.equal(row.message_index, byPart.get(row.part_id))
  } finally { globalThis.fetch = originalFetch; delete globalThis[Symbol.for('hypaware.pi-extension.v1')] }
})

test('Pi extension bounds encoding work under backpressure and rejects huge values before walking their tail', async () => {
  const originalFetch = globalThis.fetch
  const sent = []
  let release
  const blocked = new Promise(resolve => { release = resolve })
  globalThis.fetch = async (_url, init) => { sent.push(String(init?.body)); await blocked; return new Response('{}') }
  const hooks = new Map()
  const raw = copy()
  let entries = []
  let serializations = 0
  let tailVisits = 0
  const ctx = { mode: 'print', sessionManager: { getEntries: () => entries.slice(), getLeafId: () => entries.at(-1)?.id ?? null, getEntry: id => entries.find(e => e.id === id), getHeader: () => raw.session, getSessionFile: () => '/session.jsonl' } }
  try {
    extension({ on(name, fn) { hooks.set(name, fn) }, registerCommand() {} })
    hooks.get('session_start')({}, ctx)
    entries = [{ ...raw.entries[0], id: 'huge', parentId: null, message: { role: 'user', content: [
      { type: 'text', text: 'x'.repeat(8 * 1024 * 1024) },
      { type: 'text', get text() { tailVisits++; return 'tail' } },
    ] } }]
    hooks.get('turn_end')({}, ctx)
    assert.equal(tailVisits, 0)
    assert.equal(sent.length, 0)
    entries = Array.from({ length: 64 }, (_, i) => ({
      ...raw.entries[0], id: `bounded-${i}`, parentId: i ? `bounded-${i - 1}` : 'huge',
      message: { role: 'user', content: '🙂\\"'.repeat(16000) },
      toJSON() { serializations++; const { toJSON, ...json } = this; return json },
    }))
    hooks.get('turn_end')({}, ctx)
    const afterFirstTurn = serializations
    assert.ok(afterFirstTurn < 64, `encoded ${afterFirstTurn} entries while transport was blocked`)
    release()
    await hooks.get('session_shutdown')({}, ctx)
    assert.ok(sent.every(body => Buffer.byteLength(body) <= 512 * 1024))
    assert.ok(sent.reduce((sum, body) => sum + Buffer.byteLength(body), 0) <= 4.5 * 1024 * 1024)
    const decoded = sent.flatMap(body => JSON.parse(body).entries)
    assert.ok(decoded.length > 0)
    assert.equal(decoded[0].message.content, entries[0].message.content)
    assert.equal(new Set(decoded.map(e => e.id)).size, decoded.length)
    assert.ok(serializations <= decoded.length + 2, 'entries are serialized only once')
  } finally {
    release()
    globalThis.fetch = originalFetch
    delete globalThis[Symbol.for('hypaware.pi-extension.v1')]
  }
})

test('Pi listener releases admission even while a slow upload keeps its socket active', async () => {
  const source = await createStartPiSource({})(/** @type {any} */ ({ config: { listen_port: 0 }, storage: {}, log: silent }))
  const port = Number((await source.status?.())?.details?.listen_port)
  const socket = net.connect(port, '127.0.0.1')
  let interval
  try {
    socket.on('error', () => {})
    await once(socket, 'connect')
    const closed = new Promise(resolve => socket.once('close', resolve))
    socket.write('POST /entries HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 99999\r\n\r\n{')
    interval = setInterval(() => socket.write(' '), 100)
    const deadline = AbortSignal.timeout(5000)
    await Promise.race([closed, new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('slow upload held admission past deadline')), { once: true }))])
    assert.equal((await source.status?.())?.details?.active_batches, 0)
    const response = await fetch(`http://127.0.0.1:${port}/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 400)
  } finally { clearInterval(interval); socket.destroy(); await source.stop() }
})

test('Pi live capture health surfaces a persistently version-skewed extension, not a stray probe', async () => {
  const root = await temp()
  const rows = []
  const storage = { cacheTablePath: () => '/cache/pi', async discoverCachePartitions() { return [] }, async *readRows() {}, async *readSpooledRows() { yield* rows }, async appendRows(_p, _c, batch) { rows.push(...batch) } }
  const source = await createStartPiSource({})(/** @type {any} */ ({ config: { listen_port: 0 }, storage, log: silent }))
  try {
    const port = (await source.status?.())?.details?.listen_port
    const post = body => fetch(`http://127.0.0.1:${port}/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const health = async () => /** @type {any} */ (await source.status?.())
    const v1 = () => { const raw = copy(); raw.session.cwd = root; raw.version = 1; raw.message_indices = [0, 1, 2, 3]; return JSON.stringify(raw) }
    const malformed = () => { const raw = copy(); raw.session.cwd = root; raw.message_indices = [0, 1, 2, -1]; return JSON.stringify(raw) }
    // Past the threshold, so the exclusions below assert the path is excluded
    // rather than only that one refusal is under the bar.
    const past = 4

    for (let i = 0; i < past; i++) assert.equal((await post('not json at all')).status, 400)
    assert.equal((await health()).lastError, undefined, 'non-JSON probes do not trip capture health')
    for (let i = 0; i < past; i++) assert.equal((await post(malformed())).status, 400)
    assert.equal((await health()).lastError, undefined, 'malformed batches from a current extension do not trip capture health')

    for (let i = 0; i < past; i++) assert.equal((await post(v1())).status, 400)
    const skewed = await health()
    assert.match(String(skewed.lastError), /version/i, 'consecutive version refusals surface in capture health')

    const accepted = copy()
    accepted.session.cwd = root
    accepted.message_indices = [0, 1, 2, 3]
    assert.equal((await post(JSON.stringify(accepted))).status, 200)
    assert.equal((await health()).lastError, undefined, 'an accepted batch clears the skew report')
  } finally { await source.stop(); await fs.rm(root, { recursive: true, force: true }) }
})

test('Pi capture health keeps an unresolved write failure visible alongside a skew report', async () => {
  const root = await temp()
  const storage = { cacheTablePath: () => '/cache/pi', async discoverCachePartitions() { return [] }, async *readRows() {}, async *readSpooledRows() {}, async appendRows() { throw new Error('disk gone') } }
  const source = await createStartPiSource({})(/** @type {any} */ ({ config: { listen_port: 0 }, storage, log: silent }))
  try {
    const port = (await source.status?.())?.details?.listen_port
    const post = body => fetch(`http://127.0.0.1:${port}/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const health = async () => /** @type {any} */ (await source.status?.())
    const accepted = copy()
    accepted.session.cwd = root
    accepted.message_indices = [0, 1, 2, 3]
    assert.equal((await post(JSON.stringify(accepted))).status, 500)
    assert.equal((await health()).lastError, 'pi_capture_failed')

    // A skewed lane never lands the accepted batch that would clear the write
    // failure, so the skew report must not become the only thing reported.
    const v1 = () => { const raw = copy(); raw.session.cwd = root; raw.version = 1; raw.message_indices = [0, 1, 2, 3]; return JSON.stringify(raw) }
    for (let i = 0; i < 4; i++) assert.equal((await post(v1())).status, 400)
    const both = String((await health()).lastError)
    assert.match(both, /pi_capture_failed/)
    assert.match(both, /version/i)
    assert.ok(both.length <= 200, `capture health stays inside the 200-char source-health bound, saw ${both.length}`)
  } finally { await source.stop(); await fs.rm(root, { recursive: true, force: true }) }
})
