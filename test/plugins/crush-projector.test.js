// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  CRUSH_CLIENT_NAME,
  crushScopeId,
  mintCrushPartId,
  projectCrushSession,
  stripCwd,
} from '../../hypaware-core/plugins-workspace/crush/src/projector.js'
import { openCrushDb } from '../../hypaware-core/plugins-workspace/crush/src/crush_db.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/index.js'
import { createCrushDb, insertMessage, insertSession, openWriter, tmpDir } from '../helpers/crush_db_fixture.js'

/**
 * @import { CrushMessageRow, CrushSessionRow } from '../../hypaware-core/plugins-workspace/crush/src/types.js'
 */

/**
 * @ref LLP 0573#projection [tests]: the Crush -> ai_gateway_messages mapping,
 *   one part per `parts` entry, ids stable as a message streams.
 * @ref LLP 0573#owner-decisions [tests]: D2 cost on the root only and no
 *   usage, D3 task sessions linked to their parent, D5 no working directory.
 * @ref LLP 0573#privacy [tests]: the usage-policy skip and its path-free log.
 *
 * Rows are synthetic copies of the part shapes the Crush v0.99.0 probe
 * recorded (probe/messages.sample.json), not captured content.
 */

const PROJECT_DIR = '/work/crush-fixture'
const ROOT = 'aaaaaaaa-0000-4000-8000-000000000001'
const CHILD = 'bbbbbbbb-0000-4000-8000-000000000002'
const T0 = 1793738790

/**
 * @param {Partial<CrushSessionRow>} [fields]
 * @returns {CrushSessionRow}
 */
function session(fields = {}) {
  return {
    id: ROOT,
    parent_session_id: null,
    title: 'Fixture session',
    message_count: 4,
    cost: 0.0123,
    created_at: T0,
    updated_at: T0 + 20,
    ...fields,
  }
}

let nextRowid = 1

/**
 * @param {string} id
 * @param {string} role
 * @param {unknown[]} parts
 * @param {Partial<CrushMessageRow>} [fields]
 * @returns {CrushMessageRow}
 */
function message(id, role, parts, fields = {}) {
  const rowid = nextRowid++
  return {
    rowid,
    id,
    session_id: ROOT,
    role,
    parts: JSON.stringify(parts),
    model: role === 'assistant' ? 'fixture-model' : '',
    provider: role === 'assistant' ? 'fixture-provider' : null,
    created_at: T0 + rowid,
    updated_at: T0 + rowid,
    finished_at: T0 + rowid,
    is_summary_message: false,
    ...fields,
  }
}

const CWD_TAIL = `\n<cwd>${PROJECT_DIR}</cwd>`

/** One turn in every part shape the probe recorded. */
function turn() {
  return [
    message('m-user', 'user', [{ type: 'text', data: { text: 'fixture prompt' } }]),
    message('m-asst', 'assistant', [
      { type: 'reasoning', data: { thinking: 'fixture thinking', signature: 'sig' } },
      { type: 'text', data: { text: 'running the command' } },
      { type: 'tool_call', data: { id: 'call-1', name: 'bash', input: '{"command":"echo fixture"}', provider_executed: false, finished: true } },
      { type: 'finish', data: { reason: 'tool_use', time: T0 + 2 } },
    ]),
    message('m-tool', 'tool', [
      {
        type: 'tool_result',
        data: {
          tool_call_id: 'call-1',
          name: 'bash',
          content: `fixture\n${CWD_TAIL}`,
          data: '',
          mime_type: '',
          metadata: JSON.stringify({ working_directory: PROJECT_DIR, output: 'fixture' }),
          is_error: false,
        },
      },
    ]),
    message('m-done', 'assistant', [
      { type: 'text', data: { text: 'fixture done' } },
      { type: 'image_url', data: { url: 'https://fixture.invalid/x.png', detail: 'auto' } },
      { type: 'binary', data: { path: `${PROJECT_DIR}/x.bin`, mime_type: 'application/octet-stream', data: 'AAAA' } },
      { type: 'finish', data: { reason: 'end_turn', time: T0 + 4 } },
    ]),
  ]
}

/** @param {string[]} [ignoredRoots] */
function fakeResolver(ignoredRoots = []) {
  // Resolved: the matcher hands the fs the resolved spelling, which on win32
  // gains a drive letter and backslashes over a POSIX-written fixture.
  const markers = new Set(ignoredRoots.map((root) => path.resolve(root, '.hypignore')))
  return createUsagePolicyResolver({
    existsSync: (p) => markers.has(path.resolve(p)),
    readFileSync: () => 'ignore\n',
  })
}

/**
 * @param {Partial<Parameters<typeof projectCrushSession>[0]>} [overrides]
 */
async function project(overrides = {}) {
  const item = await projectCrushSession({
    session: session(),
    messages: turn(),
    projectDir: PROJECT_DIR,
    resolver: fakeResolver(),
    deriveRepo: async () => ({ git_remote: 'https://fixture.invalid/repo.git', repo_root: 'fixture-root' }),
    ...overrides,
  })
  return /** @type {any} */ (item)
}

/** @param {any} item */
function contentParts(item) {
  return item.value.messages.filter((/** @type {any} */ m) => m.role !== 'system')
}

test('each part shape projects to one part with its block type', async () => {
  const parts = contentParts(await project())
  assert.deepEqual(parts.map((/** @type {any} */ m) => [m.role, m.content[0].type]), [
    ['user', 'text'],
    ['assistant', 'thinking'],
    ['assistant', 'text'],
    ['assistant', 'tool_use'],
    ['tool', 'tool_result'],
    ['assistant', 'text'],
    ['assistant', 'image'],
    ['assistant', 'binary'],
  ])
  const [, thinking, , call, result, , image, binary] = parts
  assert.equal(thinking.content[0].thinking, 'fixture thinking')
  assert.deepEqual(call.content[0], { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'echo fixture' } })
  assert.deepEqual(result.content[0], { type: 'tool_result', tool_use_id: 'call-1', content: 'fixture' })
  assert.deepEqual(image.content[0], { type: 'image' })
  assert.deepEqual(binary.content[0], { type: 'binary', mime_type: 'application/octet-stream' })
  assert.equal(call.stop_reason, 'tool_use')
  assert.equal(binary.stop_reason, 'end_turn')
  assert.equal(parts[0].model, undefined, 'a user part carries no model')
  assert.equal(call.model, 'fixture-model')
  assert.equal(parts[0].provider, 'fixture-provider', 'the prompt carries the provider that answered it')
  assert.equal(result.message_created_at, new Date((T0 + 3) * 1000).toISOString())
})

test('exchange identity: scoped session id, client, entrypoint, repo and reconcile scope', async () => {
  const item = await project()
  const exchange = item.value
  assert.equal(exchange.session_id, crushScopeId(ROOT))
  assert.equal(exchange.client_name, CRUSH_CLIENT_NAME)
  assert.equal(exchange.conversation_source, CRUSH_CLIENT_NAME)
  assert.equal(exchange.entrypoint, 'crush')
  assert.equal(exchange.provider, 'fixture-provider')
  assert.equal(exchange.model, 'fixture-model')
  assert.equal(exchange.conversation_started_at, new Date(T0 * 1000).toISOString())
  assert.equal(exchange.git_remote, 'https://fixture.invalid/repo.git')
  assert.equal(exchange.repo_root, 'fixture-root')
  assert.equal(exchange.cwd, PROJECT_DIR, 'the project directory is the local-only marking (LLP 0573#privacy)')
  assert.equal(exchange.parent_thread_id, undefined)
  assert.deepEqual(item.reconcile, { where: { client_name: 'crush', session_id: `crush-${ROOT}` }, key: 'part_id' })
  assert.deepEqual(item.provenance, { client_name: 'crush', native_id: ROOT })
})

test('a streamed message keeps its part ids as it grows', async () => {
  const growing = [{ type: 'text', data: { text: 'partial' } }]
  const early = contentParts(await project({ messages: [message('m-stream', 'assistant', growing, { finished_at: null })] }))
  const grown = [
    { type: 'text', data: { text: 'partial and then more' } },
    { type: 'tool_call', data: { id: 'call-2', name: 'view', input: '{}', finished: true } },
    { type: 'finish', data: { reason: 'tool_use', time: T0 + 9 } },
  ]
  const late = contentParts(await project({ messages: [message('m-stream', 'assistant', grown)] }))
  assert.equal(early[0].message_id, mintCrushPartId(ROOT, 'm-stream', 0))
  assert.equal(late[0].message_id, early[0].message_id)
  assert.equal(late[1].message_id, mintCrushPartId(ROOT, 'm-stream', 1))
  assert.equal(early[0].stop_reason, undefined)
  assert.equal(late[1].stop_reason, 'tool_use')
})

test('a part id keeps its index past a skipped sibling', async () => {
  const parts = contentParts(await project({
    messages: [message('m-skip', 'assistant', [{ type: 'text', data: { text: '' } }, { type: 'text', data: { text: 'kept' } }])],
  }))
  assert.equal(parts.length, 1)
  assert.equal(parts[0].message_id, mintCrushPartId(ROOT, 'm-skip', 1))
})

test('a user shell command is a tool call and result marked user_shell, not a prompt', async () => {
  const parts = contentParts(await project({
    messages: [message('m-shell', 'user', [{ type: 'shell_command', data: { command: 'ls', output: `a\nb${CWD_TAIL}`, exit_code: 2 } }])],
  }))
  assert.deepEqual(parts.map((/** @type {any} */ m) => [m.role, m.content[0].type, m.attributes?.crush?.user_shell]), [
    ['user', 'tool_use', true],
    ['tool', 'tool_result', true],
  ])
  assert.ok(!parts.some((/** @type {any} */ m) => m.content[0].type === 'text'), 'no text prompt')
  assert.deepEqual(parts[0].content[0], { type: 'tool_use', id: 'm-shell-0', name: 'bash', input: { command: 'ls' } })
  assert.deepEqual(parts[1].content[0], { type: 'tool_result', tool_use_id: 'm-shell-0', content: 'a\nb', exit_code: 2, is_error: true })
  assert.equal(parts[0].message_id, mintCrushPartId(ROOT, 'm-shell', 0, 'call'))
  assert.equal(parts[1].message_id, mintCrushPartId(ROOT, 'm-shell', 0, 'result'))
})

test('v0.100.0 detached reports survive crush.db projection without becoming human prompts or usage', async (t) => {
  const dir = await tmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const dbPath = await createCrushDb(path.join(dir, 'project'))
  const childId = 'm-dispatch$$call-dispatch'
  const reports = [
    { label: 'Ada', output: 'REPORT_MARKER', failed: false, model: 'child-provider/child-model' },
    { label: 'Grace', output: 'another result' }, // false and model are omitted upstream
    { label: 'Lin', output: 'Subagent failed: fixture error', failed: true, model: 'child-provider/child-model' },
    { label: 'Sam', output: 'Stopped: user request.', failed: true },
    { label: 'Empty', output: '', failed: true },
  ]
  const writer = openWriter(dbPath)
  try {
    insertSession(writer, { id: ROOT, cost: 0.5 })
    insertSession(writer, { id: childId, parent_session_id: ROOT, cost: 0.2 })
    writer.prepare('UPDATE sessions SET prompt_tokens = 900, completion_tokens = 40').run()
    insertMessage(writer, { id: 'm-human', session_id: ROOT, role: 'user', parts: [{ type: 'text', data: { text: 'dispatch a task' } }] })
    insertMessage(writer, { id: 'm-dispatch', session_id: ROOT, role: 'assistant', model: 'parent-model', provider: 'parent-provider', parts: [{ type: 'tool_call', data: { id: 'call-dispatch', name: 'agent_dispatch', input: '{}' } }] })
    insertMessage(writer, { id: 'm-started', session_id: ROOT, role: 'tool', parts: [{ type: 'tool_result', data: { tool_call_id: 'call-dispatch', content: 'Started subagent Ada' } }] })
    for (const [i, report] of reports.entries()) {
      insertMessage(writer, {
        id: `m-report-${i}`, session_id: ROOT, role: 'user',
        parts: [{ type: 'sub_agent_report', data: { ...report, output: report.output ? `${report.output}\n<cwd>${dir}/private</cwd>\npost-hook context` : '', metadata: { working_directory: dir } } }],
      })
    }
    insertMessage(writer, { id: 'm-next', session_id: ROOT, role: 'assistant', model: 'parent-model', provider: 'parent-provider', parts: [{ type: 'text', data: { text: 'received the reports' } }] })
    insertMessage(writer, { id: 'm-child', session_id: childId, role: 'assistant', model: 'child-model', provider: 'child-provider', parts: [{ type: 'text', data: { text: 'child work' } }] })
  } finally {
    writer.close()
  }
  const reader = openCrushDb(dbPath)
  try {
    const snapshot = await reader.readSessionSnapshot(ROOT)
    assert.ok(snapshot)
    assert.ok(snapshot.messages.some(row => row.parts.includes('REPORT_MARKER')), 'the reader kept the report')
    const item = await project(snapshot)
    const parts = contentParts(item)
    assert.ok(JSON.stringify(parts).includes('REPORT_MARKER'), 'the delivered parent report was dropped')
    const rows = aiGatewayRowsFromProjectedExchange(item.value)
    for (const [i, report] of reports.entries()) {
      const id = mintCrushPartId(ROOT, `m-report-${i}`, 0)
      const row = rows.find(row => row.message_id === id)
      assert.ok(row, report.label)
      assert.equal(row.session_id, crushScopeId(ROOT))
      assert.equal(row.provider_uuid, `m-report-${i}`)
      assert.equal(row.role, 'tool')
      assert.equal(row.part_type, 'tool_result')
      assert.equal(row.content_text, report.output ? `${report.output}\npost-hook context` : '')
      assert.equal(row.is_error === true, report.failed === true)
      assert.deepEqual(row.status, { tool_status: report.failed ? 'error' : 'success' })
      assert.deepEqual(/** @type {any} */ (row.attributes).crush, {
        subagent_label: report.label,
        ...(report.model ? { subagent_model: report.model } : {}),
      })
      assert.equal(row.tool_call_id, undefined, 'a report supplies no tool-call identity')
    }
    assert.equal(rows.filter(row => row.role === 'user' && row.part_type === 'text').length, 1)
    assert.equal(rows.filter(row => /** @type {any} */ (row.attributes)?.crush?.session_cost_usd).length, 1)
    assert.equal(item.value.model, 'parent-model', 'the report model must not change parent attribution')
    assert.ok(!JSON.stringify(parts).includes(dir), 'report content leaked the working directory')
    assert.ok(!JSON.stringify(parts).includes('working_directory'))
    assert.ok(!JSON.stringify(rows).includes('"usage"'), 'session token gauges must not become consumption')
    assert.deepEqual(aiGatewayRowsFromProjectedExchange((await project(snapshot)).value), rows, 'reprojection is stable')
    const child = await reader.readSessionSnapshot(childId)
    assert.ok(child)
    const childExchange = (await project(child)).value
    assert.equal(childExchange.session_id, crushScopeId(childId))
    assert.equal(childExchange.parent_thread_id, crushScopeId(ROOT))
    assert.equal(childExchange.entrypoint, 'crush-task')
    assert.ok(!JSON.stringify(childExchange).includes('session_cost_usd'))
  } finally {
    reader.close()
  }
})

test('a summary message is marked on each of its parts', async () => {
  const parts = contentParts(await project({
    messages: [message('m-sum', 'assistant', [{ type: 'text', data: { text: 'fixture summary' } }], { is_summary_message: true })],
  }))
  assert.equal(parts[0].attributes.crush.summary, true)
})

test('a task session links to its parent and carries no cost', async () => {
  const exchange = (await project({ session: session({ id: CHILD, parent_session_id: ROOT, cost: 0.5 }) })).value
  assert.equal(exchange.entrypoint, 'crush-task')
  assert.equal(exchange.session_id, crushScopeId(CHILD))
  assert.equal(exchange.parent_thread_id, crushScopeId(ROOT))
  assert.ok(!JSON.stringify(exchange).includes('session_cost_usd'))
})

test('a root session carries its cost on the latest assistant message only, and none at 0', async () => {
  const parts = contentParts(await project())
  const carrying = parts.filter((/** @type {any} */ m) => m.attributes?.crush?.session_cost_usd !== undefined)
  assert.equal(carrying.length, 1)
  assert.equal(carrying[0].message_id, mintCrushPartId(ROOT, 'm-done', 2))
  assert.equal(carrying[0].attributes.crush.session_cost_usd, 0.0123)
  const free = (await project({ session: session({ cost: 0 }) })).value
  assert.ok(!JSON.stringify(free).includes('session_cost_usd'))
})

test('no usage fields are carried', async () => {
  const exchange = (await project()).value
  const text = JSON.stringify(exchange)
  for (const field of ['usage', 'input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens']) {
    assert.ok(!text.includes(field), field)
  }
})

test('no part carries the working directory or a file path', async () => {
  const exchange = (await project()).value
  const text = JSON.stringify(contentParts({ value: exchange }))
  assert.ok(!text.includes(PROJECT_DIR), 'project path leaked')
  assert.ok(!text.includes('<cwd>'))
  assert.ok(!text.includes('working_directory'))
  assert.ok(!text.includes('metadata'))
  assert.ok(!text.includes('fixture.invalid/x.png'), 'image URL leaked')
  assert.ok(!text.includes('AAAA'), 'binary bytes leaked')
})

test('stripCwd removes the last cwd element even before hook text', () => {
  assert.equal(stripCwd('out\n<cwd>/a/b</cwd>\n'), 'out')
  assert.equal(stripCwd('out\n\n<cwd>/a/b</cwd>\nnote from hook'), 'out\nnote from hook')
  assert.equal(stripCwd('<cwd>/a</cwd> in the middle'), ' in the middle')
  // An earlier element in the output is content: only the last one goes.
  assert.equal(stripCwd('grep hit: <cwd>x</cwd> more\n<cwd>/a/b</cwd>\n'), 'grep hit: <cwd>x</cwd> more')
  assert.equal(stripCwd('grep hit: <cwd>x</cwd> more\n<cwd>/a/b</cwd>\nhook context'), 'grep hit: <cwd>x</cwd> more\nhook context')
  assert.equal(stripCwd('a literal <cwd> tag\n<cwd>/a</cwd>'), 'a literal <cwd> tag')
  assert.equal(stripCwd('out\n<cwd>/a</cwd>\nhook with a literal <cwd> tag'), 'out\nhook with a literal <cwd> tag')
  assert.equal(stripCwd('a literal <cwd> tag'), 'a literal <cwd> tag')
  assert.equal(stripCwd('a literal </cwd> tag'), 'a literal </cwd> tag')
  assert.equal(stripCwd('no element'), 'no element')
})

test('hook context and feedback survive projection without the tool working directory', async () => {
  for (const feedback of ['pre-hook context', 'post-hook context', 'failure context', 'Hook feedback: blocked', 'pre-hook context\npost-hook context\nHook feedback: blocked']) {
    const isError = feedback === 'failure context'
    const parts = contentParts(await project({
      messages: [message('m-hook', 'tool', [{
        type: 'tool_result',
        data: {
          tool_call_id: 'call-hook',
          content: `out\n\n<cwd>${PROJECT_DIR}/sub</cwd>\n${feedback}`,
          metadata: JSON.stringify({ working_directory: `${PROJECT_DIR}/sub` }),
          is_error: isError,
        },
      }])],
    }))
    assert.equal(parts.length, 1)
    assert.deepEqual(parts[0].content[0], {
      type: 'tool_result',
      tool_use_id: 'call-hook',
      content: `out\n${feedback}`,
      ...(isError ? { is_error: true } : {}),
    }, feedback)
    assert.ok(!JSON.stringify(parts).includes(PROJECT_DIR), feedback)
    assert.ok(!JSON.stringify(parts).includes('working_directory'), feedback)
  }
})

test('the title rides the session-title row', async () => {
  const titles = (await project()).value.messages.filter((/** @type {any} */ m) => m.role === 'system')
  assert.equal(titles.length, 1)
  assert.equal(titles[0].attributes.session.title, 'Fixture session')
})

test('an ignored project drops the session before any row is built, and the log names no path', async () => {
  /** @type {Array<[string, Record<string, unknown>]>} */
  const logged = []
  const log = /** @type {any} */ ({
    info: (/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) => logged.push([name, attrs]),
    warn: (/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) => logged.push([name, attrs]),
  })
  let derived = false
  const item = await projectCrushSession({
    session: session(),
    messages: turn(),
    projectDir: PROJECT_DIR,
    resolver: fakeResolver([PROJECT_DIR]),
    deriveRepo: async () => { derived = true; return {} },
    log,
  })
  assert.equal(item, undefined)
  assert.equal(derived, false)
  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'plugin.crush.usage_policy_drop')
  assert.equal(logged[0][1].session_id, ROOT)
  assert.ok(!JSON.stringify(logged).includes(PROJECT_DIR))
  assert.ok(!JSON.stringify(logged).includes('Fixture session'), 'the title is content')
})

test('an empty transcript is still an item, so a rewind reconciles the session away', async () => {
  const item = await project({ messages: [] })
  assert.ok(item)
  assert.deepEqual(contentParts(item), [])
})
