// @ts-check

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { attachGrokHooks, grokHooksPath, GROK_EVENTS } from '../../hypaware-core/plugins-workspace/grok/src/attach.js'
import { createGrokBackfillProvider } from '../../hypaware-core/plugins-workspace/grok/src/backfill.js'
import { validateGrokConfig } from '../../hypaware-core/plugins-workspace/grok/src/config.js'
import { grokMessageId } from '../../hypaware-core/plugins-workspace/grok/src/projector.js'
import { createGrokPolicy, createGrokWithheldStore } from '../../hypaware-core/plugins-workspace/grok/src/policy.js'
import { resolveSessionIdForCli } from '../../hypaware-core/plugins-workspace/ai-gateway/src/session_command.js'
import { grokSessionFiles, grokSessionsRoot, IDLE_FLUSH_MS, MAX_LINE_BYTES, readGrokSession, readGrokTranscript } from '../../hypaware-core/plugins-workspace/grok/src/transcript.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { runClaudeSessionContextHook } from '../../hypaware-core/plugins-workspace/claude/src/hook_command.js'

const fixtureText = await fs.readFile(new URL('../../hypaware-core/smoke/fixtures/grok-updates.jsonl', import.meta.url), 'utf8')
const silent = { info() {}, warn() {}, debug() {}, error() {} }
const allowAll = { allowed: () => true, sessionIgnored: () => false, governingDir: (/** @type {any} */ session) => session.cwd }
const SESSION = '0198a0b0-1111-7222-8333-444455556666'

/** @param {any} t @param {{ text?: string, summary?: any }} [opts] */
async function setup(t, opts = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-grok-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const root = grokSessionsRoot({ HOME: home })
  const cwd = path.join(home, 'project dir')
  const dir = path.join(root, encodeURIComponent(cwd), SESSION)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'updates.jsonl')
  await fs.writeFile(file, opts.text ?? fixtureText)
  if (opts.summary !== null) {
    await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(opts.summary ?? { info: { id: SESSION, cwd }, current_model_id: 'grok-summary' }))
  }
  return { home, root, cwd, dir, file }
}

/** @param {string} file @param {any} opts */
async function read(file, opts) {
  const messages = []
  let cursor
  let dropped = false
  for await (const item of readGrokTranscript(file, { policy: allowAll, ...opts })) {
    if (item.projection) messages.push(...item.projection.messages)
    if (item.cursor) cursor = item.cursor
    if (item.dropped) dropped = true
  }
  return { messages, cursor, dropped }
}

/** @param {any[]} updates */
const jsonl = updates => updates.map(update => JSON.stringify(update)).join('\n') + '\n'

/** @param {any} update @param {any} [meta] */
const envelope = (update, meta = {}) => ({ timestamp: 1793000000, method: 'session/update', params: { sessionId: 's', update, _meta: meta } })

test('folds chunks and tool lifecycles into one message per line of origin', async t => {
  const { root, file } = await setup(t)
  const { messages, cursor } = await read(file, { root })
  assert.deepEqual(messages.map(m => [m.message_index, m.role, /** @type {any} */ (m.content)[0].type]), [
    [1, 'user', 'text'],
    [2, 'assistant', 'thinking'],
    [4, 'assistant', 'tool_use'],
    [6, 'user', 'tool_result'],
    [7, 'assistant', 'text'],
  ])
  const content = /** @type {any[]} */ (messages.map(m => /** @type {any} */ (m.content)[0]))
  assert.equal(content[0].text, 'Read the config')
  assert.equal(content[1].thinking, 'Need the file.')
  assert.deepEqual(content[2], { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'config.toml' } })
  assert.deepEqual(content[3], { type: 'tool_result', tool_use_id: 't1', name: 'read_file', content: 'key = 1', is_error: false })
  assert.equal(content[4].text, 'key is one.')
  assert.equal(messages[0].message_created_at, new Date(1793000000100).toISOString())
  assert.equal(messages[0].model, undefined)
  assert.equal(messages[1].model, 'grok-build')
  assert.equal(messages[4].model, 'grok-build')
  assert.equal(messages[0].message_id, grokMessageId(SESSION, 1))
  assert.equal(cursor.offset, Buffer.byteLength(fixtureText))
  assert.equal(cursor.line, 11)
  // The storage projector accepts every block this folder produces.
  const rows = aiGatewayRowsFromProjectedExchange(/** @type {any} */ ({ provider: 'unknown', session_id: SESSION, conversation_id: SESSION, conversation_source: 'grok', client_name: 'grok', cwd: '/x', entrypoint: 'unknown', messages }))
  assert.ok(rows.length >= messages.length)
})

test('incremental reads converge with a whole-file read and hold before open items', async t => {
  const lines = fixtureText.trimEnd().split('\n')
  const { root, file } = await setup(t, { text: '' })
  const whole = await setup(t)
  const expected = (await read(whole.file, { root: whole.root })).messages.map(m => JSON.stringify(m))
  /** @type {Map<string, string>} */
  const seen = new Map()
  let cursor
  for (const line of lines) {
    await fs.appendFile(file, line + '\n')
    const result = await read(file, { root, cursor })
    for (const message of result.messages) {
      const prior = seen.get(String(message.message_id))
      if (prior) assert.equal(prior, JSON.stringify(message))
      seen.set(String(message.message_id), JSON.stringify(message))
    }
    cursor = result.cursor
  }
  assert.deepEqual([...seen.values()], expected)
})

test('an unterminated append is not parsed or acknowledged', async t => {
  const prompt = jsonl([envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } })])
  const { root, file } = await setup(t, { text: prompt + '{"timestamp":17' })
  const { messages, cursor } = await read(file, { root })
  assert.deepEqual(messages, [])
  assert.equal(cursor.offset, 0)
})

test('a quiet file settles what no later update will close', async t => {
  const text = jsonl([
    envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' } }),
    envelope({ sessionUpdate: 'tool_call', toolCallId: 'open', title: 'bash', status: 'pending' }),
    envelope({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cut off' } }),
  ])
  const { root, file } = await setup(t, { text })
  assert.deepEqual((await read(file, { root })).messages.map(m => m.message_index), [0])
  const old = new Date(Date.now() - IDLE_FLUSH_MS - 1000)
  await fs.utimes(file, old, old)
  const { messages, cursor } = await read(file, { root })
  assert.deepEqual(messages.map(m => m.message_index).sort(), [0, 1, 2])
  assert.equal(cursor.offset, Buffer.byteLength(text))
})

test('host output, torn lines and failures keep identity and meaning', async t => {
  const text = jsonl([
    envelope({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'slash output' }, _meta: { hostTurn: true } }),
    envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'c2VjcmV0' } }),
  ]) + '{torn\n' + jsonl([
    envelope({ sessionUpdate: 'tool_call', toolCallId: 'bad', title: 'bash', status: 'failed', rawOutput: { error: 'no' } }),
    envelope({ sessionUpdate: 'tool_call_update', toolCallId: 'late', status: 'cancelled' }),
    { timestamp: 0, method: '_x.ai/session/update', params: { sessionId: 's', update: { sessionUpdate: 'rewind_marker', target_prompt_index: 0 } } },
  ])
  const { root, file } = await setup(t, { text })
  const { messages } = await read(file, { root })
  assert.deepEqual(messages.map(m => m.message_index), [1, 3, 4])
  assert.deepEqual(/** @type {any} */ (messages[0].content), [{ type: 'image', mime_type: 'image/png' }])
  assert.ok(!JSON.stringify(messages).includes('c2VjcmV0'))
  const failed = /** @type {any} */ (messages[1].content)
  assert.equal(failed[0].type, 'tool_use')
  assert.deepEqual(failed[1], { type: 'tool_result', tool_use_id: 'bad', name: 'bash', content: '{"error":"no"}', is_error: true })
  assert.equal(/** @type {any} */ (messages[2].content)[0].is_error, true)
})

test('consecutive prompts stay separate messages', async t => {
  const prompt = (/** @type {string} */ text, /** @type {number} */ promptIndex) => envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex } })
  const { root, file } = await setup(t, { text: jsonl([prompt('a', 0), prompt('b', 0), prompt('c', 1), { timestamp: 1, params: { update: { sessionUpdate: 'turn_completed' } } }]) })
  assert.deepEqual((await read(file, { root })).messages.map(m => /** @type {any} */ (m.content)[0].text), ['ab', 'c'])
})

test('session identity survives a missing summary and refuses a mismatched one', async t => {
  const { dir, cwd, root } = await setup(t, { summary: null })
  assert.deepEqual(await readGrokSession(dir, root), { id: SESSION, cwd, policy_dirs: [cwd], lineage: [SESSION], fork_sources: [] })
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: 'other', cwd } }))
  await assert.rejects(readGrokSession(dir, root), /unsupported_session/)
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: SESSION, cwd }, parent_session_id: 'parent', head_branch: 'main', git_root_dir: '/repo/', git_remotes: ['https://user:token@example.com/o/r.git'], head_commit: 'a'.repeat(40) }))
  const fork = await readGrokSession(dir, root)
  assert.equal(fork.parent_thread_id, undefined)
  assert.deepEqual(fork.lineage, [SESSION, 'parent'])
  assert.deepEqual(fork.fork_sources, [{ id: 'parent' }])
  assert.deepEqual(fork.git, { git_branch: 'main', git_remote: 'https://example.com/o/r.git', repo_root: '/repo', head_sha: 'a'.repeat(40) })
})

test('a subagent finds its parent from the parent side, and waits until the link exists', async t => {
  const { dir, cwd, root, file } = await setup(t, { summary: null })
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: SESSION, cwd }, session_kind: 'subagent' }))
  assert.equal((await readGrokSession(dir, root)).parent_pending, true)
  assert.deepEqual((await read(file, { root })).messages, [])
  const meta = path.join(path.dirname(dir), 'the-parent', 'subagents', SESSION)
  await fs.mkdir(meta, { recursive: true })
  await fs.writeFile(path.join(meta, 'meta.json'), '{}')
  const child = await readGrokSession(dir, root)
  assert.equal(child.parent_thread_id, 'the-parent')
  assert.deepEqual(child.lineage, [SESSION, 'the-parent'])
  assert.deepEqual(child.fork_sources, [])
  const out = []
  for await (const item of readGrokTranscript(file, { root, policy: allowAll })) if (item.projection) out.push(item.projection)
  assert.equal(out[0].parent_thread_id, 'the-parent')
  assert.equal(out[0].is_sidechain, true)
})

test('ignoring a session covers what it spawned, and stays out after unignore', async t => {
  const { root, file, dir, cwd, home } = await setup(t, { summary: null })
  const ignored = new Set(['the-parent'])
  const policy = createGrokPolicy(ignored, { resolve: () => ({ class: 'sync' }) })
  const withheld = createGrokWithheldStore(path.join(home, 'state'))
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: SESSION, cwd }, parent_session_id: 'the-parent' }))
  assert.equal((await read(file, { root, policy, withheld })).dropped, true)
  // Nothing written while it was ignored appears once it is not.
  ignored.delete('the-parent')
  assert.deepEqual((await read(file, { root, policy, withheld })).messages, [])
  await fs.appendFile(file, jsonl([envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'after' } }), { timestamp: 1, params: { update: { sessionUpdate: 'turn_completed' } } }]))
  const { messages } = await read(file, { root, policy, withheld })
  assert.deepEqual(messages.map(m => /** @type {any} */ (m.content)[0].text), ['after'])
  assert.equal(messages[0].message_index, 11)
  // A later fork copies those bytes and inherits the floor from its source.
  const session = await readGrokSession(dir, root)
  await withheld.mark('the-parent', 500)
  const offsets = async () => (await withheld.floors(session)).map(f => f.offset)
  assert.ok((await offsets()).includes(500))
  // A marking cannot lower a floor, and a corrupt one fails rather than records.
  await withheld.mark('the-parent', 10)
  assert.ok((await offsets()).includes(500))
  const floors = path.join(home, 'state', 'grok-withheld')
  for (const name of await fs.readdir(floors)) await fs.writeFile(path.join(floors, name), '{"offset":"x"}')
  await assert.rejects(read(file, { root, policy, withheld }), /withheld_floor_invalid/)
})

test('tool results never carry binary bytes, and a non-zero exit is an error', async t => {
  const b64 = 'iVBORw0KGgo'
  const { root, file } = await setup(t, { text: jsonl([
    envelope({ sessionUpdate: 'tool_call', toolCallId: 'img', title: 'read_file' }),
    envelope({ sessionUpdate: 'tool_call_update', toolCallId: 'img', status: 'completed', content: [{ type: 'content', content: { type: 'image', data: b64, mimeType: 'image/png' } }, { type: 'content', content: { type: 'resource', resource: { uri: 'file:///a.pdf', blob: b64 } } }] }),
    envelope({ sessionUpdate: 'tool_call', toolCallId: 'sh', title: 'run_terminal_command' }),
    envelope({ sessionUpdate: 'tool_call_update', toolCallId: 'sh', status: 'completed', rawOutput: { type: 'Bash', exit_code: 1 }, content: [{ type: 'content', content: { type: 'text', text: 'nope' } }] }),
    envelope({ sessionUpdate: 'tool_call', toolCallId: 'ok', title: 'run_terminal_command' }),
    envelope({ sessionUpdate: 'tool_call_update', toolCallId: 'ok', status: 'completed', rawOutput: { type: 'Bash', exit_code: 0 }, content: [{ type: 'content', content: { type: 'text', text: 'yes' } }] }),
  ]) })
  const { messages } = await read(file, { root })
  assert.ok(!JSON.stringify(messages).includes(b64))
  const results = messages.flatMap(m => /** @type {any[]} */ (m.content)).filter(b => b.type === 'tool_result')
  assert.deepEqual(results.map(b => [b.tool_use_id, b.content, b.is_error]), [['img', '[image image/png]\n[resource file:///a.pdf]', false], ['sh', 'nope', true], ['ok', 'yes', false]])
})

test('each reply carries the model of its own prompt, across a resumed read', async t => {
  const prompt = (/** @type {string} */ modelId) => envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: modelId }, _meta: { modelId, promptIndex: modelId === 'grok-a' ? 0 : 1 } })
  const reply = envelope({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'r' } })
  const done = { timestamp: 1, params: { update: { sessionUpdate: 'turn_completed' } } }
  const { root, file } = await setup(t, { text: jsonl([prompt('grok-a'), reply, done]) })
  const first = await read(file, { root })
  assert.equal(first.messages[1].model, 'grok-a')
  assert.equal(first.cursor.model, 'grok-a')
  await fs.appendFile(file, jsonl([reply, done, prompt('grok-b'), reply, done]))
  const second = await read(file, { root, cursor: first.cursor })
  assert.deepEqual(second.messages.map(m => m.model), ['grok-a', undefined, 'grok-b'])
  const whole = await read(file, { root })
  assert.deepEqual(whole.messages.filter(m => m.role === 'assistant').map(m => m.model), ['grok-a', 'grok-a', 'grok-b'])
})

test('an oversized line is skipped, keeping what surrounds it and its line number', async t => {
  const chunk = (/** @type {string} */ text, /** @type {number} */ promptIndex) => envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex } })
  const done = { timestamp: 1, params: { update: { sessionUpdate: 'turn_completed' } } }
  const { root, file } = await setup(t, { text: jsonl([chunk('before', 0), done, chunk('x'.repeat(MAX_LINE_BYTES + 10), 1), done, chunk('after', 2), done]) })
  const { messages, cursor } = await read(file, { root })
  assert.deepEqual(messages.map(m => [m.message_index, /** @type {any} */ (m.content)[0].text]), [[0, 'before'], [4, 'after']])
  assert.equal(cursor.line, 6)
})

test('a live read budget cannot stall behind a large line or an open item', async t => {
  const big = 'y'.repeat(4 * 1024 * 1024)
  const text = (/** @type {string} */ value, /** @type {number} */ promptIndex) => envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: value }, _meta: { promptIndex } })
  const open = envelope({ sessionUpdate: 'tool_call', toolCallId: 'long', title: 'bash' })
  const done = { timestamp: 1, params: { update: { sessionUpdate: 'turn_completed' } } }
  const { root, file } = await setup(t, { text: jsonl([open, envelope({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: big } }), done, text('z'.repeat(10 * 1024 * 1024), 0), done, text('tail', 1), done]) })
  let cursor
  /** @type {any[]} */
  const seen = []
  for (let i = 0; i < 4; i++) {
    const result = await read(file, { root, cursor, maxBytes: 1024 * 1024 })
    seen.push(...result.messages)
    cursor = result.cursor
  }
  assert.ok(seen.some(m => /** @type {any} */ (m.content)[0].text === 'tail'))
  assert.equal(cursor?.offset, (await fs.stat(file)).size)
})

test('a quiet file settles what is open even behind a torn last line', async t => {
  const { root, file } = await setup(t, { text: jsonl([envelope({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'last reply' } })]) + '{"timestamp":17' })
  const old = new Date(Date.now() - IDLE_FLUSH_MS - 1000)
  await fs.utimes(file, old, old)
  assert.equal(/** @type {any} */ ((await read(file, { root })).messages[0].content)[0].text, 'last reply')
})

test('a repeat read at the end of the file does no work', async t => {
  const { root, file } = await setup(t)
  const { cursor } = await read(file, { root })
  const again = await read(file, { root, cursor })
  assert.deepEqual(again.messages, [])
  assert.equal(again.cursor.offset, cursor.offset)
})

test('rows from separate batches and reads keep one chain, tool names and start time', async t => {
  const updates = []
  for (let i = 0; i < 70; i++) {
    updates.push(envelope({ sessionUpdate: 'tool_call', toolCallId: `c${i}`, title: 'bash' }))
    updates.push(envelope({ sessionUpdate: 'tool_call_update', toolCallId: `c${i}`, status: 'completed', rawOutput: 'ok' }))
  }
  const started = '2026-11-05T19:30:13.349123Z'
  const { root, file } = await setup(t, { text: jsonl(updates), summary: { info: { id: SESSION, cwd: '/tmp' }, created_at: started } })
  const rows = []
  let batches = 0
  // Each projection on its own, as the listener and backfill write them.
  for await (const item of readGrokTranscript(file, { root, policy: allowAll })) {
    if (!item.projection) continue
    batches++
    rows.push(...aiGatewayRowsFromProjectedExchange(item.projection))
  }
  assert.ok(batches > 1)
  assert.equal(rows.length, 140)
  rows.forEach((row, i) => assert.deepEqual(row.previous_message_id, i ? [rows[i - 1].message_id] : []))
  assert.ok(rows.every(row => row.tool_name === 'bash'))
  assert.deepEqual([...new Set(rows.map(row => row.conversation_started_at))], [new Date(started).toISOString()])
})

test('without a summary the start time still comes from the session, not the write', async t => {
  const { root, file } = await setup(t, { summary: null })
  const projections = []
  for await (const item of readGrokTranscript(file, { root, policy: allowAll })) if (item.projection) projections.push(item.projection)
  assert.equal(projections[0].conversation_started_at, new Date(1793000000100).toISOString())
})

test('a fork shorter than its parent keeps its own messages under the parent floor', async t => {
  const forkedAt = 1793000500000
  const chunk = (/** @type {string} */ text, /** @type {number} */ seconds) => ({ ...envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }), timestamp: seconds })
  const done = { timestamp: 1793000600, params: { update: { sessionUpdate: 'turn_completed' } } }
  const copied = jsonl([chunk('withheld copy', 1793000000), done])
  const { root, file, dir, cwd, home } = await setup(t, { text: copied + jsonl([chunk('the fork', 1793000600), done]), summary: null })
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: SESSION, cwd }, parent_session_id: 'the-parent', forked_at: new Date(forkedAt).toISOString() }))
  const withheld = createGrokWithheldStore(path.join(home, 'state'))
  // The parent grew far past the copy before it was read while ignored.
  await withheld.mark('the-parent', 1024 * 1024)
  const { messages } = await read(file, { root, withheld })
  assert.deepEqual(messages.map(m => /** @type {any} */ (m.content)[0].text), ['the fork'])
})

test('a tool that runs for many lines stops holding the cursor back', async t => {
  // Alternating kinds, so each run closes and only the tool can hold the cursor.
  const chunks = Array.from({ length: 1100 }, (_, i) => envelope({ sessionUpdate: i % 2 ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text: 't' } }))
  const open = envelope({ sessionUpdate: 'tool_call', toolCallId: 'long', title: 'bash', rawInput: { command: 'sleep' } })
  const { root, file } = await setup(t, { text: jsonl([open, ...chunks]) })
  const first = await read(file, { root })
  assert.ok(first.cursor.line > 1000)
  assert.ok(first.messages.some(m => /** @type {any} */ (m.content)[0].name === 'bash'))
  // Its late result still links by id, and no call is recorded twice.
  await fs.appendFile(file, jsonl([envelope({ sessionUpdate: 'tool_call_update', toolCallId: 'long', status: 'completed', rawOutput: 'done' })]))
  const late = await read(file, { root, cursor: first.cursor })
  assert.ok(late.messages.some(m => /** @type {any} */ (m.content)[0].tool_use_id === 'long'))
  assert.ok(!late.messages.some(m => /** @type {any} */ (m.content)[0].type === 'tool_use'))
})

test('a later title does not replace the name of a backgrounded tool', async t => {
  const name = { 'x.ai/tool': { name: 'run_terminal_command' } }
  const { root, file } = await setup(t, { text: jsonl([
    envelope({ sessionUpdate: 'tool_call', toolCallId: 'bg', title: 'run_terminal_command', rawInput: { command: 'sleep 8' }, _meta: name }),
    envelope({ sessionUpdate: 'tool_call_update', toolCallId: 'bg', title: 'Execute `sleep 8`', _meta: name }),
    envelope({ sessionUpdate: 'tool_call_update', toolCallId: 'bg', status: 'completed', title: '[bg] sleep 8 (8aaf44d1)', content: [{ type: 'content', content: { type: 'text', text: 'started' } }] }),
  ]) })
  const { messages } = await read(file, { root })
  assert.equal(/** @type {any} */ (messages[0].content)[0].name, 'run_terminal_command')
  assert.equal(/** @type {any} */ (messages[1].content)[0].name, 'run_terminal_command')
})

test('resource blocks in a prompt are kept, without blob bytes', async t => {
  const user = (/** @type {any} */ content) => envelope({ sessionUpdate: 'user_message_chunk', content, _meta: { promptIndex: 0 } })
  const { root, file } = await setup(t, { text: jsonl([
    user({ type: 'text', text: 'look' }),
    user({ type: 'resource_link', name: 'a.txt', uri: 'file:///a.txt' }),
    user({ type: 'resource', resource: { uri: 'file:///b.txt', text: 'embedded body' } }),
    user({ type: 'resource', resource: { uri: 'file:///c.bin', blob: 'QUJD' } }),
    envelope({ sessionUpdate: 'turn_completed' }),
  ]) })
  const { messages } = await read(file, { root })
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'look' },
    { type: 'text', text: '[resource file:///a.txt]' },
    { type: 'text', text: '[resource file:///b.txt]\nembedded body' },
    { type: 'text', text: '[resource file:///c.bin]' },
  ])
})

test('after a rewind the chain continues from before the target prompt, across reads', async t => {
  const user = (/** @type {string} */ text, /** @type {number} */ promptIndex) => envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex } })
  const reply = (/** @type {string} */ text) => envelope({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  const done = envelope({ sessionUpdate: 'turn_completed' })
  const before = jsonl([user('one', 0), reply('r1'), done, user('dead', 1), reply('r2'), done])
  const after = jsonl([envelope({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }), user('live', 1), reply('r3'), done, envelope({ sessionUpdate: 'rewind_marker', target_prompt_index: 0 }), user('fresh', 0), reply('r4'), done])
  const { root, file } = await setup(t, { text: before + after })
  const whole = (await read(file, { root })).messages
  const byText = new Map(whole.map(m => [/** @type {any} */ (m.content)[0].text, m]))
  const parent = (/** @type {string} */ text) => /** @type {any} */ (byText.get(text)).previous_message_id
  assert.deepEqual(parent('dead'), [/** @type {any} */ (byText.get('r1')).message_id])
  assert.deepEqual(parent('live'), [/** @type {any} */ (byText.get('r1')).message_id])
  assert.deepEqual(parent('fresh'), [])

  await fs.writeFile(file, before)
  const first = await read(file, { root })
  await fs.appendFile(file, after)
  const second = await read(file, { root, cursor: first.cursor })
  assert.deepEqual([...first.messages, ...second.messages], whole)
})

test('a worktree or subagent answers to the folders it came from', async t => {
  const { root, file, dir, cwd, home } = await setup(t, { summary: null })
  const source = path.join(home, 'repo')
  const classes = /** @type {Record<string, string>} */ ({})
  const policy = createGrokPolicy(new Set(), { resolve: dir => ({ class: classes[dir] ?? 'full' }) })
  const cwds = async () => {
    const out = []
    for await (const item of readGrokTranscript(file, { root, policy })) if (item.projection) out.push(item.projection.cwd)
    return out
  }
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: SESSION, cwd }, session_kind: 'worktree', source_workspace_dir: source }))
  assert.equal((await cwds())[0], cwd)
  classes[source] = 'local-only'
  assert.equal((await cwds())[0], source)
  classes[source] = 'ignore'
  assert.deepEqual(await cwds(), [])

  delete classes[source]
  const parentCwd = path.join(home, 'elsewhere')
  const parentDir = path.join(path.dirname(dir), 'the-parent')
  await fs.mkdir(path.join(parentDir, 'subagents', SESSION), { recursive: true })
  await fs.writeFile(path.join(parentDir, 'subagents', SESSION, 'meta.json'), '{}')
  await fs.writeFile(path.join(parentDir, 'summary.json'), JSON.stringify({ info: { id: 'the-parent', cwd: parentCwd } }))
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: SESSION, cwd }, session_kind: 'subagent' }))
  assert.equal((await cwds())[0], cwd)
  classes[parentCwd] = 'ignore'
  assert.deepEqual(await cwds(), [])
})

test('the session id Grok hands its tools resolves to that session', () => {
  assert.deepEqual(resolveSessionIdForCli({ env: { GROK_SESSION_ID: 'g1', HOME: '/none' }, cwd: '/x' }), { ok: true, sessionId: 'g1', source: 'grok_env' })
  const both = resolveSessionIdForCli({ env: { GROK_SESSION_ID: 'g1', CLAUDE_CODE_SESSION_ID: 'c1', HOME: '/none' }, cwd: '/x' })
  assert.equal(both.ok, false)
})

test('reads stay inside the sessions tree and a mismatched session id is refused', async t => {
  const { root, file, home } = await setup(t)
  await assert.rejects(read(file, { root, sessionId: 'other' }), /unsupported_session/)
  const outside = path.join(home, 'updates.jsonl')
  await fs.writeFile(outside, fixtureText)
  await assert.rejects(read(outside, { root }), /transcript_outside_root/)
  assert.equal((await read(file, { root, policy: { allowed: () => false, sessionIgnored: () => false } })).dropped, true)
})

test('discovery skips relocation staging and stray files', async t => {
  const { root, file } = await setup(t)
  await fs.mkdir(path.join(root, '.staging', 'x'), { recursive: true })
  await fs.writeFile(path.join(root, 'session_search.sqlite'), '')
  await fs.writeFile(path.join(path.dirname(path.dirname(file)), 'prompt_history.jsonl'), '')
  const found = []
  for await (const entry of grokSessionFiles(root)) found.push(entry)
  assert.deepEqual(found, [file])
})

test('sweeps resume from a cursor, windows filter by message time, ignored sessions drop', async t => {
  const { home, file } = await setup(t)
  const items = async (/** @type {any} */ provider, /** @type {any} */ extra = {}) => {
    const out = []
    for await (const item of provider.run({ env: { HOME: home }, log: silent, sweep: true, itemsFailed: 0, ...extra })) out.push(item)
    return out.filter(i => i.type !== 'event')
  }
  const provider = createGrokBackfillProvider({ env: { HOME: home } })
  assert.equal(provider.sweep?.cron, '*/5 * * * *')
  assert.equal((await items(provider)).length, 1)
  await fs.appendFile(file, jsonl([envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'next' } }, { promptId: 'p2' }), { timestamp: 1793000001, method: '_x.ai/session/update', params: { update: { sessionUpdate: 'turn_completed', prompt_id: 'p2' }, _meta: {} } }]))
  const next = await items(provider)
  assert.equal(next.length, 1)
  assert.deepEqual(JSON.stringify(next).match(/next/g)?.length, 1)
  assert.ok(!JSON.stringify(next).includes('Read the config'))

  const windowed = await items(createGrokBackfillProvider({ env: { HOME: home } }), { sweep: false, since: new Date(1793000004000).toISOString() })
  assert.ok(!JSON.stringify(windowed).includes('Read the config'))
  assert.ok(JSON.stringify(windowed).includes('key is one.'))

  assert.deepEqual(await items(createGrokBackfillProvider({ env: { HOME: home }, ignoredSessions: new Set([SESSION]) })), [])
})

test('config accepts its keys and rejects others', () => {
  assert.equal(validateGrokConfig({ listen_port: 4325 }).ok, true)
  assert.equal(validateGrokConfig({ listen_port: 0 }).ok, false)
  assert.equal(validateGrokConfig({ surprise: true }).ok, false)
})

test('attach owns one hook file, honors GROK_HOME, and detach leaves user hooks', async t => {
  const { home } = await setup(t)
  const env = { GROK_HOME: path.join(home, 'relocated') }
  assert.equal(grokHooksPath({ env, homeDir: home }), path.join(home, 'relocated', 'hooks', 'hypaware.json'))
  const opts = { endpoint: 'http://127.0.0.1:4325', version: '1.0.0', env, homeDir: home }
  const first = await attachGrokHooks({ ...opts, dryRun: true })
  assert.equal(first.changed, true)
  await assert.rejects(fs.stat(first.settingsPath), { code: 'ENOENT' })
  assert.equal((await attachGrokHooks(opts)).changed, true)
  assert.equal((await attachGrokHooks(opts)).changed, false)
  const attached = JSON.parse(await fs.readFile(first.settingsPath, 'utf8'))
  assert.deepEqual(Object.keys(attached.hooks), [...GROK_EVENTS])
  assert.ok(!('PreToolUse' in attached.hooks), 'the only blocking event stays untouched')
  attached.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'mine.sh' }] })
  await fs.writeFile(first.settingsPath, JSON.stringify(attached))
  await attachGrokHooks(opts)
  await detachClientFromDisk({ descriptor: /** @type {any} */ ({ name: 'grok', attachProbe: { format: 'json', settings_file: '.grok/hooks/hypaware.json', marker_key: '_hypaware' } }), env, homeDir: home })
  const detached = JSON.parse(await fs.readFile(first.settingsPath, 'utf8'))
  assert.equal(detached._hypaware, undefined)
  assert.deepEqual(detached.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] })
})

test('the installed hook forwards identity only, and stays silent without a path', async t => {
  /** @type {any[]} */
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.writeHead(200).end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => server.close())
  const address = /** @type {any} */ (server.address())
  const hook = fileURLToPath(new URL('../../hypaware-core/plugins-workspace/grok/src/hook.mjs', import.meta.url))
  // Asynchronous: the listener above runs on this event loop.
  const child = (/** @type {any} */ input) => new Promise(resolve => {
    const proc = spawn(process.execPath, [hook, `127.0.0.1:${address.port}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout.on('data', chunk => { out += chunk })
    proc.stderr.on('data', chunk => { out += chunk })
    proc.on('close', code => resolve({ code, out }))
    proc.stdin.end(JSON.stringify(input))
  })
  assert.deepEqual(await child({ hookEventName: 'SessionStart', sessionId: 's' }), { code: 0, out: '' })
  assert.deepEqual(received, [])
  assert.deepEqual(await child({ hookEventName: 'Stop', sessionId: 's', transcriptPath: '/x/updates.jsonl', toolResult: 'secret' }), { code: 0, out: '' })
  assert.deepEqual(received, [{ session_id: 's', transcript_path: '/x/updates.jsonl' }])
})

test('Claude hooks inherited by Grok exit quietly and have no effects', async t => {
  const { home } = await setup(t)
  const stateFile = path.join(home, 'context.jsonl')
  let effects = 0
  await runClaudeSessionContextHook(['--state-file', stateFile], /** @type {any} */ ({ env: { GROK_HOOK_EVENT: 'session_start' }, stdout: { write() { effects++ } } }), { sweepSpool: /** @type {any} */ (() => { effects++ }) })
  assert.equal(effects, 0)
  await assert.rejects(fs.stat(stateFile), { code: 'ENOENT' })
  await fs.writeFile(path.join(home, 'hypaware-config.json'), 'invalid json')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../bin/hypaware.js', import.meta.url)), 'claude-hook', 'classify-cwd'], {
    env: { ...process.env, GROK_HOOK_EVENT: 'session_start', HYP_HOME: home, HYP_CONFIG: '' }, input: '{}', encoding: 'utf8', timeout: 15000,
  })
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''])
})
