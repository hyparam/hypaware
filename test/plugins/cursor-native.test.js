// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { cursorNativeFixture, growToMaximalGraph, wire } from '../../hypaware-core/smoke/lib/cursor_native_fixture.js'
import { cursorFields, cursorStorePaths, findCursorSession, listCursorSessions, readCursorSession } from '../../hypaware-core/plugins-workspace/cursor/src/native.js'
import { createCursorBackfillProvider, cursorAdmission } from '../../hypaware-core/plugins-workspace/cursor/src/recovery.js'
import { createCursorDecoder } from '../../hypaware-core/plugins-workspace/cursor/src/native_decoder.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createProjectedExchangeWriter } from '../../hypaware-core/plugins-workspace/ai-gateway/src/exchange_writer.js'
import { activate } from '../../hypaware-core/plugins-workspace/cursor/src/index.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { readObservabilityEnv } from '../../src/core/observability/env.js'
import { temporaryDirectory } from '../helpers/temp_dir.js'

/** @param {'cli' | 'editor'} [frontend] */
async function fixture(frontend = 'cli') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-native-'))
  const cwd = path.join(root, 'workspace')
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, 'notes.txt'), 'The probe value is MARIGOLD-42.\n')
  const f = await cursorNativeFixture(path.join(root, 'native'), cwd, frontend)
  const opts = { editorDb: frontend === 'editor' ? f.session.dbPath : path.join(root, 'absent'), cliRoot: frontend === 'cli' ? path.join(root, 'native') : path.join(root, 'absent') }
  return { ...f, root, cwd, opts, async cleanup() { f.close(); await fs.rm(root, { recursive: true, force: true }) } }
}

test('native tool calls retain arguments and join results, including replay over pre-upgrade rows', async () => {
  const f = await fixture()
  try {
    const exchange = readCursorSession(f.session).exchanges[0]
    const rows = aiGatewayRowsFromProjectedExchange(exchange)
    const calls = rows.filter((row) => row.part_type === 'tool_call')
    const results = rows.filter((row) => row.part_type === 'tool_result')
    assert.equal(calls.length, 5)
    for (const result of results) {
      const call = calls.find((row) => row.tool_call_id === result.tool_result_for)
      assert.ok(call)
      assert.equal(call.role, 'assistant')
      assert.equal(call.tool_name, result.tool_name)
      assert.deepEqual(call.tool_args, result.tool_args)
      assert.notEqual(call.part_id, result.part_id)
      assert.ok(rows.indexOf(call) < rows.indexOf(result))
      assert.equal(result.message_id, 'cursor:' + JSON.stringify([f.session.id, 'native-user', 'tool', result.tool_call_id]))
    }
    // The old reader stored these exact identities without call rows. Upgrading
    // fills the missing calls without duplicating results, text or prompts.
    const stored = rows.filter((row) => row.part_type !== 'tool_call')
    const storage = /** @type {any} */ ({
      cacheTablePath: () => '/cache/ai_gateway_messages',
      async discoverCachePartitions() { return [] },
      async *readRows() {},
      async *readSpooledRows() { yield* stored },
      async appendRows(_path, _columns, next) { stored.push(...next) },
    })
    assert.equal((await createProjectedExchangeWriter({ storage }).record(exchange)).rowsWritten, 5)
    assert.equal((await createProjectedExchangeWriter({ storage }).record(exchange)).rowsWritten, 0)
    assert.equal(stored.length, 13)
  } finally { await f.cleanup() }
})

test('Shell outcomes ignore known metadata, decode exit status, and keep unrecognized outcomes unknown', async () => {
  const f = await fixture()
  try {
    const cases = [
      { label: 'success', outcome: wire([1, wire()]), error: false },
      { label: 'nonzero exit', outcome: wire([1, wire([3, 1])]), error: true },
      { label: 'negative int32 exit', outcome: wire([1, Buffer.from([24, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1])]), error: true },
      { label: 'signal', outcome: wire([1, wire([4, 'SIGTERM'])]), error: true },
      { label: 'failure with sandbox metadata', outcome: wire([2, wire([3, 1])], [101, wire()]), error: true },
      { label: 'success with metadata', outcome: wire([1, wire()], [101, wire()], [102, 0], [103, '/terminals'], [104, 42]), error: false },
      { label: 'background still running', outcome: wire([1, wire()], [102, 1]), error: null },
      ...[2, 3, 4, 5, 7].map((terminal) => ({ label: 'error alternative ' + terminal, outcome: wire([terminal, wire()]), error: true })),
      { label: 'future outcome', outcome: wire([99, wire()]), error: null },
      { label: 'future metadata', outcome: wire([1, wire()], [105, 1]), error: null },
      { label: 'conflicting outcomes', outcome: wire([1, wire()], [2, wire()]), error: null },
    ]
    for (const { label, outcome, error } of cases) {
      const step = f.put(wire([2, wire([57, 'native-call-3'], [1, wire([2, outcome])])]))
      const turn = f.put(wire([1, wire([1, f.user], [2, step], [3, 'native-generation'])]))
      f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turn]))
      const rows = readCursorSession(f.session).exchanges.flatMap((exchange) => aiGatewayRowsFromProjectedExchange(exchange))
      const result = rows.find((row) => row.part_type === 'tool_result')
      assert.ok(result)
      assert.equal(result.is_error ?? null, error === true ? true : null, label)
      assert.deepEqual(result.status, error === null ? undefined : { tool_status: error ? 'error' : 'success' }, label)
    }
  } finally { await f.cleanup() }
})

test('verified non-Shell outcomes and routed models survive native projection', async () => {
  const f = await fixture()
  try {
    const variants = new Map([
      [3, [2, 3, 4, 5, 6, 7]], [4, [2]], [5, [2]], [8, [2, 3, 4, 5, 6]],
      [12, [2, 3, 4, 6, 7]], [13, [2, 3, 4]], [14, [2]], [15, [2, 3, 4, 5, 6]],
      [18, [2, 3]], [19, [2]], [24, [2]], [44, [2]],
    ])
    for (const [variant, errors] of variants) {
      const cases = [[wire([1, wire()]), false], ...errors.map((n) => [wire([n, wire()]), true]),
        [wire([99, wire()]), null], [wire([1, wire()], [2, wire()]), null]]
      if (variant === 15) cases.push([wire([1, wire([2, 1])]), true], [wire([7, wire()]), null])
      for (const [outcome, expected] of cases) {
        const step = f.put(wire([2, wire([57, 'native-call-3'], [variant, wire([2, outcome])])]))
        const turn = f.put(wire([1, wire([1, f.user], [2, step], [3, 'native-generation'], [7, 'Routed Model'])]))
        f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turn]))
        const exchange = readCursorSession(f.session).exchanges[0]
        const result = exchange.messages.find((m) => m.role === 'tool')
        assert.ok(result && Array.isArray(result.content))
        assert.equal(result.content[0].is_error, expected, `variant ${variant}`)
        const rows = aiGatewayRowsFromProjectedExchange(exchange)
        assert.equal(rows.find((row) => row.part_type === 'tool_call')?.model, 'Routed Model')
        assert.equal(rows[0].model, undefined, 'a routed response model is not attributed to the user')
        assert.equal(exchange.provider, 'unknown')
      }
    }
    for (const model of ['', 'x'.repeat(257), 'bad\nmodel']) {
      const turn = f.put(wire([1, wire([1, f.user], ...f.steps.map((ref) => [2, ref]), [3, 'native-generation'], [7, model])]))
      f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turn]))
      assert.ok(readCursorSession(f.session).exchanges[0].messages.every((m) => !m.model))
    }
  } finally { await f.cleanup() }
})

for (const frontend of /** @type {const} */ (['editor', 'cli'])) {
  test(`${frontend} reads committed WAL, preserves native identities and full outcomes, excludes private metadata`, async () => {
    const f = await fixture(frontend)
    try {
      // Fixture connection stays open: content exists in WAL, not just the db.
      assert.ok((await fs.stat(f.session.dbPath + '-wal')).size > 0)
      const before = await fs.readFile(f.session.dbPath)
      const session = await findCursorSession(f.session.id, f.cwd, f.opts)
      assert.ok(session)
      const snap = readCursorSession(session)
      const messages = snap.exchanges.flatMap((e) => e.messages)
      assert.equal(messages.length, 13)
      assert.equal(messages.filter((m) => m.content === 'Same text').length, 2)
      assert.equal(new Set(messages.map((m) => m.message_id)).size, 13)
      const tools = messages.filter((m) => m.role === 'tool').map((m) => /** @type {any} */ (m.content)[0])
      assert.deepEqual(tools.map((t) => t.name), ['Read', 'Grep', 'Glob', 'Shell', 'Shell'])
      assert.deepEqual(tools.map((t) => t.is_error), [false, false, false, true, true])
      assert.match(tools[0].content, /MARIGOLD-42/)
      assert.deepEqual(tools[0].input, { path: 'notes.txt' })
      assert.notEqual(tools[3].tool_use_id, tools[4].tool_use_id)
      assert.equal(JSON.stringify(snap).includes('PRIVATE'), false)
      assert.equal(snap.exchanges[0].entrypoint, frontend)
      assert.deepEqual(readCursorSession(session), snap)
      assert.equal(readCursorSession(session, snap.root).unchanged, true)
      assert.deepEqual(await fs.readFile(f.session.dbPath), before, 'read-only access does not rewrite database')
      assert.equal((await listCursorSessions(f.opts)).length, 1)
      assert.equal((await listCursorSessions(f.opts, { sinceMs: Date.now() + 10000 })).length, 0)
    } finally { await f.cleanup() }
  })
}

test('partial and incompatible native checkpoints fail explicitly instead of claiming conversation identities', async () => {
  const f = await fixture('editor')
  try {
    f.writeRoot(f.state, 'generating')
    assert.throws(() => readCursorSession(f.session), /native_in_progress/)
    f.writeRoot(Buffer.concat([f.state, wire([4, 'pending-call'])]))
    assert.throws(() => readCursorSession(f.session), /native_in_progress/)
    f.writeRoot(wire([8, Buffer.alloc(32)]))
    assert.throws(() => readCursorSession(f.session), /native_blob_missing_or_large/)
    f.writeRoot(f.state)
    const pointer = f.steps[0].toString('hex')
    f.db.prepare('UPDATE cursorDiskKV SET value=? WHERE key=?').run(Buffer.from('corruption'), 'agentKv:blob:' + pointer)
    assert.throws(() => readCursorSession(f.session), /native_blob_hash/)
    assert.throws(() => cursorFields(Buffer.from([0x0a, 0xff])), /native_truncated/)
    assert.throws(() => cursorFields(Buffer.alloc(1024 * 1024 + 1)), /native_record_limit/)
  } finally { await f.cleanup() }
})

test('CLI refuses unfinished assistant text, retains completed text without an end timestamp', async () => {
  const f = await fixture()
  try {
    const partial = f.put(wire([1, wire([1, 'partial text'], [2, 1789070400100])]))
    const turn = f.put(wire([1, wire([1, f.user], [2, partial], [3, 'native-generation'])]))
    f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turn]))
    assert.throws(() => readCursorSession(f.session), /native_in_progress/)
    f.writeRoot(f.state)
    assert.equal(readCursorSession(f.session).exchanges[0].messages.length, 13)
  } finally { await f.cleanup() }
})

test('only the exact suppression value drops a typed prompt, and it drops nothing else', async () => {
  const f = await fixture()
  const turnFor = (user) => f.put(wire([1, wire([1, user], ...f.steps.map((ref) => [2, ref]), [3, 'native-generation'])]))
  const userWith = (flag) => f.put(wire([1, 'Read and search notes.txt'], [2, 'native-user'], [25, 1789070400000], [5, flag]))
  try {
    f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turnFor(userWith(1))]))
    const suppressed = readCursorSession(f.session).exchanges[0].messages
    assert.equal(suppressed.length, 12)
    assert.equal(suppressed.some((m) => m.role === 'user'), false)
    // Any other value keeps the prompt, so an unrelated flag cannot silently
    // delete human speech while assistant and tool rows still land.
    for (const flag of [0, 2]) {
      f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turnFor(userWith(flag))]))
      const messages = readCursorSession(f.session).exchanges[0].messages
      assert.equal(messages.length, 13)
      assert.equal(messages[0].content, 'Read and search notes.txt')
    }
  } finally { await f.cleanup() }
})

test('archive/current overlap does not duplicate tools, and unknown tool outcomes stay unknown', async () => {
  const f = await fixture()
  try {
    const archive = f.put(wire(...f.refs.map((ref) => [1, ref])))
    f.writeRoot(Buffer.concat([f.state, wire([13, archive])]))
    assert.equal(readCursorSession(f.session).exchanges[0].messages.length, 13)
    const step = f.put(wire([2, wire([57, 'native-call-0'], [8, wire([2, wire([99, wire()])])])]))
    const turn = f.put(wire([1, wire([1, f.user], [2, step], [3, 'native-generation'])]))
    f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turn]))
    const content = /** @type {any} */ (readCursorSession(f.session).exchanges[0].messages.find((message) => message.role === 'tool')?.content)
    assert.equal(content[0].is_error, null)
  } finally { await f.cleanup() }
})

test('discovery isolates a broken editor store so valid CLI history still recovers', async () => {
  const f = await fixture()
  try {
    const badDb = path.join(f.root, 'bad.db')
    await fs.writeFile(badDb, 'not sqlite PRIVATE')
    const errors = []
    const sessions = await listCursorSessions({ ...f.opts, editorDb: badDb, onError: (err) => errors.push(err.message) })
    assert.equal(sessions.length, 1)
    assert.ok(errors.length)
    assert.equal(JSON.stringify(errors).includes('PRIVATE'), false)
  } finally { await f.cleanup() }
})

test('native Read observes workspace, symlink and stricter policies; session ignore gates recovery', async () => {
  const f = await fixture()
  try {
    const ignoredSessions = new Set()
    const admission = cursorAdmission({ ignoredSessions })
    const exchange = readCursorSession(f.session).exchanges[0]
    assert.equal((await admission.filter(exchange))?.messages.length, 13)
    await fs.unlink(path.join(f.cwd, 'notes.txt'))
    await fs.writeFile(path.join(f.root, 'outside'), 'private')
    await fs.symlink(path.join(f.root, 'outside'), path.join(f.cwd, 'notes.txt'))
    const permitted = await admission.filter(exchange)
    assert.equal(permitted?.messages.length, 11)
    assert.equal(JSON.stringify(permitted).includes('native-call-0'), false, 'neither side of the refused Read survives')
    ignoredSessions.add(f.session.id)
    assert.equal(admission.session(f.session), false)
    assert.equal(await admission.filter(exchange), undefined)
  } finally { await f.cleanup() }
})

test('one refused file block refuses the whole message, whatever block follows it', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.root, 'outside.txt'), 'private')
    const block = (input, is_error) => ({ type: 'tool_result', name: 'Read', tool_use_id: String(Math.random()), input, content: 'text', is_error })
    const exchange = /** @type {any} */ ({ session_id: f.session.id, cwd: f.cwd, messages: [{ role: 'tool', content: [
      // Refused: resolves outside the workspace.
      block({ path: '../outside.txt' }, false),
      // A missing-file error is admissible on its own, and must not reinstate
      // the message the block before it refused.
      block({ path: 'missing.txt' }, true),
    ] }] })
    assert.equal((await cursorAdmission({}).filter(exchange))?.messages.length, 0)
  } finally { await f.cleanup() }
})

test('sweep fingerprints advance only after successful non-dry recovery and manual runs bypass them', async () => {
  const f = await fixture()
  try {
    const logs = []
    const provider = createCursorBackfillProvider(f.opts)
    const ctx = /** @type {any} */ ({ sweep: true, dryRun: false, env: {}, itemsFailed: 0, log: { info: (name) => logs.push(name), warn: (name) => logs.push(name) } })
    const collect = async () => { const items = []; for await (const item of provider.run(ctx)) items.push(item); return items }
    ctx.dryRun = true
    assert.equal((await collect()).length, 1)
    ctx.dryRun = false
    const failed = provider.run(ctx)[Symbol.asyncIterator]()
    await failed.next()
    ctx.itemsFailed++
    await failed.next()
    assert.equal((await collect()).length, 1)
    assert.equal((await collect()).length, 0)
    assert.ok(logs.includes('cursor.recovery.unchanged'))
    ctx.sweep = false
    assert.equal((await collect()).length, 1)
    assert.equal(createCursorBackfillProvider({ config: { backfill: { on_join: false } } }).sweep, undefined)
  } finally { await f.cleanup() }
})

test('Cursor CLI config paths honor its config variables independently of editor storage', () => {
  assert.equal(cursorStorePaths({ env: { HOME: '/home/user', CURSOR_CONFIG_DIR: '/custom' }, platform: 'linux' }).cliRoot, '/custom/chats')
  assert.equal(cursorStorePaths({ env: { HOME: '/home/user', XDG_CONFIG_HOME: '/config' }, platform: 'linux' }).cliRoot, '/config/cursor/chats')
})

// @ref LLP 0403#storage [tests]: cursor joins the shared persistent store
test('activate() persists session ignores to the shared store, honors saved ones in the sweep, and refuses when the store is unreadable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-ignores-'))
  try {
    const cwd = path.join(root, 'workspace')
    await fs.mkdir(cwd)
    await fs.writeFile(path.join(cwd, 'notes.txt'), 'The probe value is MARIGOLD-42.\n')
    const env = { HOME: path.join(root, 'home'), HYP_HOME: path.join(root, 'hyp'), CURSOR_CONFIG_DIR: path.join(root, 'cursor'), XDG_CONFIG_HOME: path.join(root, 'xdg') }
    const f = await cursorNativeFixture(path.join(env.CURSOR_CONFIG_DIR, 'chats'), cwd, 'cli')
    f.close()
    const stateDir = readObservabilityEnv(env).stateDir
    const silent = { info() {}, warn() {}, error() {}, debug() {} }
    const activateCursor = async () => {
      /** @type {any} */ let provider
      /** @type {any} */ let source
      await activate(/** @type {any} */ ({
        env, config: {}, log: silent, configRegistry: { registerSection() {} },
        query: { getDataset: () => true }, backfillMaterializers: { get: () => true },
        backfills: { register(p) { provider = p } }, sources: { register(s) { source = s } },
        commands: { get: () => true }, skills: { register() {} }, clients: { registerClient() {} },
      }))
      return { provider, source }
    }
    const sweep = async (provider) => {
      const items = []
      for await (const item of provider.run(/** @type {any} */ ({ env, log: silent }))) if ('value' in item) items.push(item.value)
      return items
    }
    const control = (endpoint, method, id) => fetch(`${endpoint}/_hypaware/ignore/session${method === 'GET' ? `?session_id=${id}` : ''}`,
      method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: id }) })

    // A confirmed ignore on the cursor route is saved where every recorder reads it.
    const first = await activateCursor()
    assert.equal((await sweep(first.provider)).length, 1)
    const started = await first.source.start(/** @type {any} */ ({ config: { listen_port: 0 }, storage: {}, log: silent }))
    const endpoint = `http://127.0.0.1:${(await started.status()).details.listen_port}`
    try {
      assert.equal((await control(endpoint, 'POST', 'cursor-confirmed')).status, 200)
    } finally { await started.stop() }
    assert.ok(new SessionIgnoreSet(stateDir).has('cursor-confirmed'), 'the opt-out reaches the shared store')

    // A restarted cursor recorder still reports it, and its sweep honors a
    // marker another recorder saved after activation.
    const second = await activateCursor()
    const restarted = await second.source.start(/** @type {any} */ ({ config: { listen_port: 0 }, storage: {}, log: silent }))
    try {
      const status = await control(`http://127.0.0.1:${(await restarted.status()).details.listen_port}`, 'GET', 'cursor-confirmed')
      assert.equal(/** @type {any} */ (await status.json()).ignored, true)
    } finally { await restarted.stop() }
    new SessionIgnoreSet(stateDir).add(f.session.id)
    assert.equal((await sweep(second.provider)).length, 0, 'the sweep refreshes saved exclusions before import')

    // An unreadable store is an error, never an empty list.
    await fs.writeFile(path.join(stateDir, 'session-ignores', 'not-a-marker'), 'x')
    const broken = await activateCursor()
    await assert.rejects(sweep(broken.provider))
    const exchange = readCursorSession(f.session).exchanges[0]
    const admission = cursorAdmission({ ignoredSessions: new SessionIgnoreSet(stateDir) })
    assert.equal(admission.session(/** @type {any} */ ({ ...f.session, id: 'other', cwd })), false)
    assert.equal(await admission.filter({ ...exchange, session_id: 'other' }), undefined)
    const refused = await broken.source.start(/** @type {any} */ ({ config: { listen_port: 0 }, storage: {}, log: silent }))
    try {
      assert.match(String((await refused.status()).lastError), /could not be loaded/)
    } finally { await refused.stop() }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('historical windows select messages inside recently updated sessions and widening invalidates sweep shortcuts', async () => {
  const f = await fixture()
  try {
    const provider = createCursorBackfillProvider(f.opts)
    const ctx = /** @type {any} */ ({ sweep: true, dryRun: false, env: {}, log: { info() {}, warn() {} }, until: new Date(1789070400005).toISOString() })
    const collect = async () => { const items = []; for await (const item of provider.run(ctx)) if ('value' in item) items.push(item.value); return items }
    const first = await collect()
    assert.equal(first.length, 1, 'session update time does not hide earlier messages')
    assert.equal(first[0].messages.length, 2)
    assert.equal((await collect()).length, 0)
    delete ctx.until
    assert.equal((await collect())[0].messages.length, 13)
  } finally { await f.cleanup() }
})

test('the decoder returns the reader own result off the event loop, and a dead worker fails one read instead of hanging', async () => {
  const f = await fixture()
  const decoder = createCursorDecoder()
  try {
    growToMaximalGraph(f)
    let ticks = 0
    const sampler = setInterval(() => { ticks++ }, 1)
    const snapshot = await decoder.read(f.session)
    clearInterval(sampler)
    assert.ok(ticks > 5, `the decode occupied the event loop for its whole duration (${ticks} turns)`)
    assert.deepEqual(snapshot, readCursorSession(f.session))
    assert.equal((await decoder.read(f.session, snapshot.root)).unchanged, true)

    // A refused graph keeps the reader's fixed code: a raw SQLite message can
    // carry private paths or row data, and the caller logs whatever arrives.
    f.db.prepare('UPDATE blobs SET data=? WHERE id=?').run(Buffer.from('corruption'), f.steps[0].toString('hex'))
    await assert.rejects(decoder.read(f.session), /^Error: native_blob_hash$/)

    // Terminating mid-read must reject that read. A promise nothing settles
    // would wedge the recovery chain for the daemon's lifetime.
    const inflight = decoder.read(f.session)
    await decoder.close()
    await assert.rejects(inflight, /native_read_failed/)
    await assert.rejects(decoder.read(f.session), /native_read_failed/)
  } finally { await decoder.close(); await f.cleanup() }
})

test('a queued decoder reply during close keeps the worker referenced until exit', async (t) => {
  const terminate = Worker.prototype.terminate
  const unref = t.mock.method(Worker.prototype, 'unref')
  t.mock.method(Worker.prototype, 'terminate', function () {
    const exit = terminate.call(this)
    // Deliver the last reply after terminate() refs the worker, before its
    // exit event. This ordering otherwise depends on thread scheduling.
    this.emit('message', { id: 1, error: 'native_read_failed' })
    return exit
  })
  const decoder = createCursorDecoder()
  const read = assert.rejects(decoder.read({ id: 's', dbPath: '/absent', frontend: 'cli', cwd: '/absent', updatedAt: 0 }), /native_read_failed/)
  const idleUnrefs = unref.mock.callCount()
  // Keep the failing version alive long enough to report the assertion.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    await decoder.close()
    await read
    assert.equal(unref.mock.callCount(), idleUnrefs, 'the final reply must not undo terminate()\'s ref')
  } finally { clearInterval(keepAlive) }
})

// Until hyparam/hypaware#1735 a read whose payload the structured clone
// refused rejected on time and left the worker serving later reads, so the
// only thing the leak showed was that the pending entry `syncRef` reads had
// never been dropped and the loop could no longer drain. The exit code is
// therefore the load-bearing assertion: the child's own watchdog is unref'd,
// so it fires only if something else is holding the loop open, and the child
// never calls the `close()` this would otherwise self-heal at.
test('a read whose postMessage throws releases its pending entry and the worker ref, so the process can still exit', async () => {
  const home = temporaryDirectory('cursor-decoder-clone-')
  const decoderUrl = new URL('../../hypaware-core/plugins-workspace/cursor/src/native_decoder.js', import.meta.url)
  const entry = path.join(home, 'nonclonable.mjs')
  await fs.writeFile(entry, [
    `import { createCursorDecoder } from ${JSON.stringify(decoderUrl.href)}`,
    'const watchdog = setTimeout(() => { process.stderr.write("watchdog\\n"); process.exit(42) }, 10000)',
    'watchdog.unref()',
    'const decoder = createCursorDecoder()',
    // `session` reaches `postMessage` untouched, so a method on it is a
    // synchronous DataCloneError out of the structured clone.
    'const session = { id: "s", dbPath: "/absent", frontend: "cli", notClonable() {} }',
    'try {',
    '  await decoder.read(session)',
    '  process.stderr.write("resolved\\n")',
    '} catch (err) {',
    '  process.stderr.write("rejected:" + err.message + "\\n")',
    '}',
  ].join('\n'))
  const child = await runNode(entry)
  assert.match(child.stderr, /^rejected:native_read_failed$/m,
    `the refused read rejects with the reader's fixed code, not a raw DOMException (stderr=${child.stderr})`)
  assert.equal(child.code, 0,
    `the process left on a drained loop instead of the watchdog (code=${child.code}, stderr=${child.stderr})`)
})

/**
 * Run one module in a child `node`, and collect how it left.
 *
 * @param {string} entry
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
function runNode(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

test('local subagent references and inline states retain scoped identity, nesting and privacy', async () => {
  const f = await fixture()
  try {
    const childState = wire([1, f.state], [6, 1])
    const nested = wire(...cursorFields(f.state).entries().flatMap(([key, values]) => values.map((value) => [key, value])),
      [16, wire([1, 'nested'], [2, childState])])
    const inline = wire([1, nested], [6, 1])
    const run = wire([1, 'native-call-3'], [2, 'child'])
    f.writeRoot(Buffer.concat([f.state,
      wire([16, wire([1, 'child'], [2, inline])],
        [31, wire([1, 'other'], [2, f.put(childState)])],
        [30, wire([1, 'native-call-3'], [2, run])])]))
    const snap = readCursorSession(f.session)
    assert.equal(snap.exchanges.length, 4)
    const root = snap.exchanges[0]
    assert.equal(root.agent_id, undefined)
    assert.equal(root.messages[0].message_id, 'cursor:' + JSON.stringify([f.session.id, 'native-user', 'user']))
    const children = snap.exchanges.filter((e) => e.is_sidechain)
    assert.equal(children.length, 3)
    const child = children.find((e) => e.agent_id === 'child')
    const grandchild = children.find((e) => e.agent_id === 'nested')
    assert.ok(child && grandchild)
    assert.equal(child.parent_thread_id, f.session.id)
    assert.equal(grandchild.parent_thread_id, child.conversation_id)
    assert.equal(/** @type {any} */ (child.attributes?.cursor)?.spawned_by_tool_use_id, 'native-call-3')
    const rows = snap.exchanges.flatMap((e) => aiGatewayRowsFromProjectedExchange(e))
    assert.equal(rows.length, 52)
    assert.equal(new Set(rows.map((r) => r.part_id)).size, 52)
    assert.equal(rows.filter((r) => r.is_sidechain).length, 39)
    assert.ok(rows.filter((r) => r.agent_id === 'child').every((r) => /** @type {any} */ (r.attributes).cursor.spawned_by_tool_use_id === 'native-call-3'))
    assert.ok(rows.every((r) => r.session_id === f.session.id && r.cwd === f.cwd))
    assert.equal(JSON.stringify(rows).includes('PRIVATE'), false)
    assert.deepEqual(readCursorSession(f.session), snap)
    await fs.rm(path.join(f.cwd, 'notes.txt'))
    for (const exchange of snap.exchanges) {
      const filtered = await cursorAdmission({}).filter(exchange)
      assert.equal(filtered?.messages.length, 11, 'child Read calls and results follow the same file admission')
    }
    const admission = cursorAdmission({ ignoredSessions: new Set([f.session.id]) })
    for (const exchange of snap.exchanges) assert.equal(await admission.filter(exchange), undefined)
    await fs.writeFile(path.join(f.cwd, '.hypignore'), 'ignore\n')
    for (const exchange of snap.exchanges) assert.equal(await cursorAdmission({}).filter(exchange), undefined)
  } finally { await f.cleanup() }
})

test('subagent recovery refuses ambiguous, missing, deep and oversized trees, and excludes cloud states', async () => {
  const f = await fixture()
  try {
    const child = wire([1, f.state], [6, 1])
    const reference = f.put(child)
    f.writeRoot(Buffer.concat([f.state, wire([16, wire([1, 'child'], [2, child])], [31, wire([1, 'child'], [2, reference])])]))
    assert.equal(readCursorSession(f.session).exchanges.length, 2, 'identical referenced and inline copies are projected once')
    f.writeRoot(Buffer.concat([f.state, wire([16, wire([1, 'child'], [2, wire([6, 1])])], [31, wire([1, 'child'], [2, reference])])]))
    assert.throws(() => readCursorSession(f.session), /native_subagent_identity/)
    f.writeRoot(Buffer.concat([f.state, wire([16, wire([1, 'cloud'], [2, wire([1, f.state], [6, 2])])])]))
    assert.equal(readCursorSession(f.session).exchanges.length, 1)
    f.writeRoot(Buffer.concat([f.state, wire([31, wire([1, 'missing'], [2, Buffer.alloc(32)])])]))
    assert.throws(() => readCursorSession(f.session), /native_blob_missing_or_large/)
    f.writeRoot(Buffer.concat([f.state, wire([16, wire([1, ''], [2, child])])]))
    assert.throws(() => readCursorSession(f.session), /native_subagent_identity/)
    f.writeRoot(Buffer.concat([f.state, wire(...Array.from({ length: 65 }, (_, i) => [16, wire([1, 'child-' + i], [2, child])]))]))
    assert.throws(() => readCursorSession(f.session), /native_subagent_limit/)
    const extra = Array.from({ length: 2100 }, (_, i) => f.put(Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'probe-' + i }] }))))
    const expanded = Buffer.concat([f.state, wire(...extra.map((ref) => [1, ref]))])
    f.writeRoot(Buffer.concat([expanded, wire([31, wire([1, 'child'], [2, f.put(wire([1, expanded], [6, 1]))])])]))
    assert.throws(() => readCursorSession(f.session), /native_graph_limit/, 'root and child share one blob-read budget')
    const branch = Buffer.concat([f.state, wire(...Array.from({ length: 33 }, (_, i) => [16, wire([1, 'child-' + i], [2, child])]))])
    f.writeRoot(Buffer.concat([f.state, wire(...['a', 'b'].map((id) => [16, wire([1, id], [2, wire([1, branch], [6, 1])])]))]))
    assert.throws(() => readCursorSession(f.session), /native_subagent_limit/, 'agent limit is shared across branches')
    let nested = f.state
    for (let i = 0; i < 17; i++) nested = Buffer.concat([f.state, wire([31, wire([1, 'child'], [2, f.put(wire([1, nested], [6, 1]))])])])
    f.writeRoot(nested)
    assert.throws(() => readCursorSession(f.session), /native_subagent_limit/)
  } finally { await f.cleanup() }
})
