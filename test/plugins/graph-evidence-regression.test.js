import test from 'node:test'
import assert from 'node:assert/strict'
import * as kit from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import { createAiGatewayGraphContract } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'
import { matchesPredicate, mergeRow } from '../../hypaware-core/plugins-workspace/context-graph/src/project.js'

const base = { session_id: 'session', message_id: 'message', part_id: 'part', part_type: 'tool_call', cwd: '/repo', repo_root: '/repo' }
/** @returns {any[]} */
function project(tool_name, tool_args) {
  const row = { ...base, tool_name, tool_args }
  return createAiGatewayGraphContract(kit).rules.filter(r => r.columns && (!r.where || matchesPredicate(r.where, row)))
    .flatMap(r => r.toRows ? r.toRows(row) : [r.toRow(row)].filter(Boolean))
}

test('literal wrapper yields inferred program, files and skill with exact original locator', () => {
  const rows = project('exec', 'text(await tools.exec_command({cmd:"cat /home/test/.agents/skills/review/SKILL.md",max_output_tokens:12000}))')
  for (const type of ['invoked', 'touched', 'ran']) {
    const edge = rows.find(r => r.edge_type === type)
    assert.ok(edge, type)
    assert.equal(edge.source_dataset, 'ai_gateway_messages')
    assert.equal(edge.source_keys.message_id, 'message')
    assert.equal(edge.source_keys.part_id, 'part')
    assert.equal(edge.props.inferred_call, true)
  }
})

test('ambiguous JavaScript never yields inferred actions', () => {
  const call = 'await tools.exec_command({cmd:"cat /repo/a.js"})'
  for (const code of [`if (ok) ${call}`, `false && ${call}`, `text("${call.replaceAll('"', '\\"')}")`, `const f = async () => ${call}`, `${call}; throw Error()`, 'await tools.exec_command({cmd:command})', 'await tools["exec_command"]({cmd:"cat /repo/a.js"})', 'await tools.exec_command({cmd:`cat ${file}`})']) {
    assert.equal(project('exec', code).filter(r => ['touched', 'invoked', 'ran'].includes(r.edge_type)).length, 0, code)
  }
})

test('direct shell and patch file controls, skill roots, and bounds', () => {
  for (const root of ['.codex/skills', '.agents/skills', '.codex/skills/.system', '.codex/plugins/cache/vendor/plugin/1.0/skills']) {
    assert.ok(project('exec_command', { cmd: `cat /home/test/${root}/review/SKILL.md` }).some(r => r.node_type === 'Skill' && r.natural_key === 'review'))
  }
  assert.deepEqual(project('exec_command', { cmd: 'cat a.js b.js' }).filter(r => r.node_type === 'File').map(r => r.natural_key), ['/repo/a.js', '/repo/b.js'])
  assert.deepEqual(project('apply_patch', '*** Begin Patch\n*** Update File: /repo/a.js\n@@\n-x\n+y\n*** Add File: /repo/b.js\n+z\n*** End Patch').filter(r => r.node_type === 'File').map(r => r.natural_key), ['/repo/a.js', '/repo/b.js'])
  for (const cmd of ['echo /home/test/.agents/skills/review/SKILL.md', 'cat a.js && rm b.js', 'cat $(echo a.js)', 'cat *.js']) {
    assert.equal(project('exec_command', { cmd }).filter(r => r.node_type === 'File' || r.node_type === 'Skill').length, 0, cmd)
  }
  assert.equal(project('exec', ' '.repeat(65537)).filter(r => r.edge_type === 'invoked').length, 0)
})

test('wrapper grammar bounds calls and rejects unsupported tails atomically', () => {
  const call = 'await tools.exec_command({cmd:"cat /repo/a.js"})'
  assert.ok(project('exec', `// @exec: {"yield_time_ms": 1000}\n${call};\n${call}`).some(r => r.edge_type === 'touched'))
  for (const code of [Array(33).fill(call).join(';'), `${call}; unexpected()`, 'awaittools.exec_command({cmd:"cat /repo/a.js"})', 'await tools.exec_command({cmd:"cat /repo/a.js",cmd:"cat /repo/b.js"})', `/* example */ ${call}`, `await tools.exec_command({cmd:"${'x'.repeat(65536)}"})`]) {
    assert.equal(project('exec', code).filter(r => ['touched', 'invoked', 'ran'].includes(r.edge_type)).length, 0)
  }
  for (const cmd of ['cat "a.js"b.js', "cat 'unterminated", `cat ${Array(33).fill('a.js').join(' ')}`]) {
    assert.equal(project('exec_command', { cmd }).filter(r => r.node_type === 'File').length, 0)
  }
})


test('observed activity provenance wins over inferred evidence in any merge order', () => {
  const inferred = project('exec', 'await tools.exec_command({cmd:"cat /repo/a.js"})').find(r => r.edge_type === 'touched')
  const observed = project('exec_command', { cmd: 'cat /repo/a.js' }).find(r => r.edge_type === 'touched')
  observed.source_keys.part_id = 'observed-part'
  for (const sequence of [[inferred, observed, inferred], [observed, inferred, inferred]]) {
    const result = structuredClone(sequence[0])
    for (const row of sequence.slice(1)) mergeRow(result, row)
    assert.equal(result.source_keys.part_id, 'observed-part')
    assert.equal(result.source_keys.inferred_call, undefined)
    assert.equal(result.props.inferred_call, true, 'the relation still reports an inferred contribution')
  }
})
