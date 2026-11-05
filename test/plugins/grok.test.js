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
import { grokSessionFiles, grokSessionsRoot, IDLE_FLUSH_MS, readGrokSession, readGrokTranscript } from '../../hypaware-core/plugins-workspace/grok/src/transcript.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { runClaudeSessionContextHook } from '../../hypaware-core/plugins-workspace/claude/src/hook_command.js'

const fixtureText = await fs.readFile(new URL('../../hypaware-core/smoke/fixtures/grok-updates.jsonl', import.meta.url), 'utf8')
const silent = { info() {}, warn() {}, debug() {}, error() {} }
const allowAll = () => true
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
  for await (const item of readGrokTranscript(file, { allowed: allowAll, ...opts })) {
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
  assert.deepEqual(content[3], { type: 'tool_result', tool_use_id: 't1', content: 'key = 1', is_error: false })
  assert.equal(content[4].text, 'key is one.')
  assert.equal(messages[0].message_created_at, new Date(1793000000100).toISOString())
  assert.equal(messages[0].model, undefined)
  assert.equal(messages[1].model, 'grok-summary')
  assert.equal(messages[4].model, 'grok-summary')
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
  assert.deepEqual(failed[1], { type: 'tool_result', tool_use_id: 'bad', content: '{"error":"no"}', is_error: true })
  assert.equal(/** @type {any} */ (messages[2].content)[0].is_error, true)
})

test('consecutive prompts stay separate messages', async t => {
  const prompt = (/** @type {string} */ text, /** @type {number} */ promptIndex) => envelope({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex } })
  const { root, file } = await setup(t, { text: jsonl([prompt('a', 0), prompt('b', 0), prompt('c', 1), { timestamp: 1, params: { update: { sessionUpdate: 'turn_completed' } } }]) })
  assert.deepEqual((await read(file, { root })).messages.map(m => /** @type {any} */ (m.content)[0].text), ['ab', 'c'])
})

test('session identity survives a missing summary and refuses a mismatched one', async t => {
  const { dir, cwd } = await setup(t, { summary: null })
  assert.deepEqual(await readGrokSession(dir), { id: SESSION, cwd })
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: 'other', cwd } }))
  await assert.rejects(readGrokSession(dir), /unsupported_session/)
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: SESSION, cwd }, parent_session_id: 'parent' }))
  assert.equal((await readGrokSession(dir)).parent_thread_id, undefined)
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: SESSION, cwd }, parent_session_id: 'parent', session_kind: 'subagent:review' }))
  assert.equal((await readGrokSession(dir)).parent_thread_id, 'parent')
})

test('reads stay inside the sessions tree and a mismatched session id is refused', async t => {
  const { root, file, home } = await setup(t)
  await assert.rejects(read(file, { root, sessionId: 'other' }), /unsupported_session/)
  const outside = path.join(home, 'updates.jsonl')
  await fs.writeFile(outside, fixtureText)
  await assert.rejects(read(outside, { root }), /transcript_outside_root/)
  assert.equal((await read(file, { root, allowed: () => false })).dropped, true)
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
