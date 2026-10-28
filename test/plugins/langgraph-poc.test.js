import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { projectContext, SessionProjection } from '../../scripts/langgraph-poc/projection.mjs'
import { createReceiver } from '../../scripts/langgraph-poc/collector.mjs'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

const exec = promisify(execFile)
const metadata = { langgraph_checkpoint_ns: 'researcher:one|model:two', ls_provider: 'openai', ls_model_name: 'test-model' }
const human = { role: 'human', content: 'same prompt' }
const reply = { role: 'ai', content: 'answer', usage: { input_tokens: 15, output_tokens: 3,
  total_tokens: 18, input_token_details: { cache_read: 4 } } }
const makeProject = () => new SessionProjection('session', { cwd: '/example' }, { dev_run_id: 'test' })

test('project context handles a Git repo, credential remote, detached HEAD, no remote, and non-repo', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'langgraph-context-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  assert.deepEqual(await projectContext(directory), { cwd: directory })
  const git = args => exec('git', ['-C', directory, ...args])
  await git(['init', '-b', 'main'])
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'])
  await git(['remote', 'add', 'origin', 'https://user:secret@example.com/team/repo.git?token=private'])
  const context = await projectContext(directory)
  assert.equal(context.git_remote, 'https://example.com/team/repo.git')
  assert.equal(context.git_branch, 'main')
  assert.match(context.head_sha, /^[a-f0-9]{40}$/)
  assert.equal(await fs.realpath(context.repo_root), await fs.realpath(directory))
  await git(['checkout', '--detach'])
  await git(['remote', 'remove', 'origin'])
  const detached = await projectContext(directory)
  assert.equal(detached.git_branch, undefined)
  assert.equal(detached.git_remote, undefined)
  assert.equal(detached.head_sha, context.head_sha)
})

test('project context degrades when Git is missing and bounds every lookup', async () => {
  let count = 0
  const result = await projectContext('/example', async (file, args, options) => {
    count++
    assert.equal(file, 'git')
    assert.deepEqual(args.slice(0, 2), ['-C', '/example'])
    assert.equal(options.timeout, 2000)
    assert.equal(options.maxBuffer, 8192)
    throw new Error('ENOENT')
  })
  assert.equal(count, 4)
  assert.deepEqual(result, { cwd: '/example' })
})

test('repeated request history is omitted but identical new messages at later positions survive', () => {
  const project = makeProject()
  const first = project.modelStart([human], metadata)
  const initial = project.modelEnd(first, [reply])
  const second = project.modelStart([human, reply, human], metadata)
  const next = project.modelEnd(second, [reply])
  assert.equal(initial.messages.length, 2)
  assert.equal(next.messages.length, 2)
  assert.notEqual(initial.messages[0].message_id, next.messages[0].message_id)
  assert.deepEqual(next.messages[0].previous_message_id, [initial.messages[1].message_id])
  const other = project.modelEnd(project.modelStart([human], { ...metadata,
    langgraph_checkpoint_ns: 'reviewer:one|model:two' }), [reply])
  assert.notEqual(initial.messages[0].message_id, other.messages[0].message_id)
  assert.deepEqual(other.messages[0].previous_message_id, [])
})

test('nested graph conversations preserve their immediate parent', () => {
  const project = makeProject()
  const parent = project.modelStart([human], metadata).projection
  const child = project.modelStart([human], { ...metadata,
    langgraph_checkpoint_ns: 'researcher:one|nested:two|model:three' }).projection
  assert.equal(parent.parent_thread_id, 'session')
  assert.equal(child.parent_thread_id, parent.conversation_id)
  assert.equal(child.agent_id, child.conversation_id)
})

test('identical responses from independent model calls retain separate identities and usage', () => {
  const project = makeProject()
  const first = project.modelEnd(project.modelStart([human], metadata, {}, 'call-one'), [reply])
  const second = project.modelEnd(project.modelStart([human], metadata, {}, 'call-two'), [reply])
  assert.equal(second.messages.length, 1)
  assert.notEqual(first.messages.at(-1).message_id, second.messages[0].message_id)
  const rows = [...aiGatewayRowsFromProjectedExchange(first), ...aiGatewayRowsFromProjectedExchange(second)]
  assert.equal(rows.filter(row => /** @type {any} */ (row.attributes)?.usage).length, 2)
  const distinctPrompt = project.modelStart([{ ...human, id: 'new-human-message' }], metadata)
  assert.equal(distinctPrompt.projection.messages.length, 1)
})

test('system text, offered tool schemas, mixed response parts and net usage reach normal columns', () => {
  const project = makeProject()
  const tools = [{ type: 'function', function: { name: 'add', description: 'Add numbers',
    parameters: { type: 'object', properties: { a: { type: 'number' } } } } }]
  const state = project.modelStart([{ role: 'system', content: 'system instructions' }, human], metadata, { tools })
  const response = { ...reply, content: [{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'hidden' }],
    tool_calls: [{ id: 'call', name: 'add', args: { a: 1 } }] }
  const rows = aiGatewayRowsFromProjectedExchange(project.modelEnd(state, [response]))
  assert.ok(rows.every(row => row.system_text === 'system instructions'))
  assert.ok(rows.every(row => row.tools === tools && row.cwd === '/example'))
  assert.ok(!JSON.stringify(rows).includes('hidden'))
  const carriers = rows.filter(row => /** @type {any} */ (row.attributes)?.usage)
  assert.equal(carriers.length, 1)
  assert.equal(carriers[0].part_type, 'tool_call')
  assert.equal(/** @type {any} */ (carriers[0].attributes).usage.input_tokens, 11)
  assert.equal(/** @type {any} */ (carriers[0].attributes).usage.cache_read_tokens, 4)
})

test('tool failure and success remain separate, and subsequent input does not repeat the result', () => {
  const project = makeProject()
  const response = { role: 'ai', content: '', tool_calls: [{ id: 'call', name: 'add', args: { a: 1 } }] }
  project.modelEnd(project.modelStart([human], metadata), [response])
  const toolMeta = { langgraph_checkpoint_ns: 'researcher:one|tools:three' }
  const error = project.toolEnd(toolMeta, 'attempt1', 'call', 'add', '{"a":1}', undefined, new Error('test'))
  const success = project.toolEnd(toolMeta, 'attempt2', 'call', 'add', '{"a":1}', '42')
  assert.notEqual(error.messages[0].message_id, success.messages[0].message_id)
  const history = project.modelStart([human, response, { role: 'tool', tool_call_id: 'call', content: '42' }], metadata)
  assert.equal(history.projection.messages.length, 0)
  const rows = aiGatewayRowsFromProjectedExchange(success)
  assert.equal(rows[0].tool_result_for, 'call')
  assert.equal(rows[0].content_text, '42')
  assert.deepEqual(rows[0].tool_args, { a: 1 })
})

function storageFixture() {
  const spooled = { traces: [], ai_gateway_messages: [] }
  const committed = { traces: [], ai_gateway_messages: [] }
  return { spooled, committed,
    cacheTablePath: dataset => dataset,
    async discoverCachePartitions({ datasets }) { return datasets.map(name => ({ path: name })) },
    async *readRows(table) { yield* committed[table] },
    async *readRowsWhere(table) { yield* committed[table] },
    async *readSpooledRows(table) { yield* spooled[table] },
    async appendRows(table, columns, rows) { spooled[table].push(...rows) },
    commit() {
      for (const name of Object.keys(spooled)) committed[name].push(...spooled[name].splice(0))
    },
  }
}

function request() {
  const project = makeProject()
  const projection = project.modelEnd(project.modelStart([human], metadata), [reply])
  return { signal: 'traces', payloadBytes: 1000, data: { resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'test' } }] },
    scopeSpans: [{ scope: { name: 'hypaware-prototype' }, spans: [{
      traceId: '1'.repeat(32), spanId: '2'.repeat(16), name: 'model',
      startTimeUnixNano: '1000000', endTimeUnixNano: '2000000',
      attributes: [
        { key: 'dev_run_id', value: { stringValue: 'test' } },
        { key: 'hypaware.projection', value: { stringValue: JSON.stringify(projection) } },
      ],
    }] }],
  }] } }
}

test('replay deduplicates within a batch, from spool, and after commit with a fresh receiver', async () => {
  const storage = storageFixture()
  const req = request()
  const spans = req.data.resourceSpans[0].scopeSpans[0].spans
  spans.push(structuredClone(spans[0]))
  await createReceiver(storage)(req)
  await createReceiver(storage)(req)
  assert.equal(storage.spooled.traces.length, 1)
  assert.equal(storage.spooled.ai_gateway_messages.length, 2)
  storage.commit()
  await createReceiver(storage)(req)
  assert.equal(storage.spooled.traces.length, 0)
  assert.equal(storage.spooled.ai_gateway_messages.length, 0)
})

test('a failed trace write after successful message writes repairs on replay without double billing', async () => {
  const storage = storageFixture()
  const append = storage.appendRows.bind(storage)
  storage.appendRows = async (table, columns, rows) => {
    if (table === 'traces') throw new Error('disk failure')
    await append(table, columns, rows)
  }
  const req = request()
  await assert.rejects(createReceiver(storage)(req), /disk failure/)
  assert.equal(storage.spooled.ai_gateway_messages.length, 2)
  storage.appendRows = append
  await createReceiver(storage)(req)
  assert.equal(storage.spooled.ai_gateway_messages.length, 2)
  assert.equal(storage.spooled.traces.length, 1)
})

test('concurrent delivery is refused then can retry, and same span ID in different traces survives', async () => {
  const storage = storageFixture()
  const receiver = createReceiver(storage)
  const req = request()
  const accepted = receiver(req)
  await assert.rejects(receiver(req), /busy/)
  await accepted
  await receiver(req)
  req.data.resourceSpans[0].scopeSpans[0].spans[0].traceId = '3'.repeat(32)
  await receiver(req)
  assert.equal(storage.spooled.traces.length, 2)
  assert.equal(storage.spooled.ai_gateway_messages.length, 2)
})
