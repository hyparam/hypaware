// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { edgeId, makeRowBuilders, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import {
  createAiGatewayGraphContract,
  PROJECTOR,
  PROJECTOR_VERSION,
  SOURCE_DATASET,
} from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'

// Build the contract the way the connector's activate() does: from the graph
// plugin's generic kit (the bridge-key recipe is the connector's own, imported
// inside the contract). The rules' row identity + provenance are therefore the
// real end-to-end ones, and these assertions double as the digest-stability guard.
const KIT = { nodeId, edgeId, makeRowBuilders }
const contract = createAiGatewayGraphContract(KIT)

/**
 * @param {'node' | 'edge'} kind
 * @param {string} type
 * @param {number} [nth] which match to return when several rules share a type
 *   (the two membership edges both use `in`); defaults to the first.
 */
function rule(kind, type, nth = 0) {
  const found = contract.rules.filter((r) => r.kind === kind && r.type === type)
  assert.ok(found[nth], `${kind} rule ${type} #${nth} exists`)
  return found[nth]
}

const TS = '2026-06-05T12:00:00.000Z'

test('contract carries its source/projector metadata', () => {
  assert.equal(contract.name, 'ai-gateway-t0')
  assert.equal(contract.plugin, '@hypaware/ai-gateway-graph')
  assert.equal(contract.sourceDataset, SOURCE_DATASET)
  assert.equal(contract.sourceDataset, 'ai_gateway_messages')
  assert.equal(contract.projector, PROJECTOR)
  assert.equal(contract.projectorVersion, PROJECTOR_VERSION)
})

// @ref LLP 0073#additive-no-migration: the Program/invoked rules bump the
// projector version 1 → 2 as provenance only (ids are content-addressed; no
// re-key, no migration).
test('PROJECTOR_VERSION is 2 after the additive Program/invoked rules', () => {
  assert.equal(PROJECTOR_VERSION, 2)
  assert.equal(contract.projectorVersion, 2)
})

// @ref LLP 0030#decision: the Session node keys on session_id (the
// session container, always present); conversation_id is null for Claude.
test('Session rule builds a node keyed on session_id with pruned props', () => {
  const r = rule('node', 'Session')
  const row = r.toRow({
    session_id: 'sess-1',
    cwd: '/repo',
    git_branch: null,
    client_name: 'claude',
    user_id: undefined,
    message_created_at: TS,
  })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('Session', 'sess-1'))
  assert.equal(row.node_type, 'Session')
  assert.equal(row.natural_key, 'sess-1')
  assert.deepEqual(row.props, { client_name: 'claude', cwd: '/repo' }, 'null/undefined props dropped, keys sorted')
  assert.equal(row.first_seen, TS)
  assert.equal(row.source_dataset, SOURCE_DATASET)
  assert.deepEqual(row.source_keys, { session_id: 'sess-1' })
  assert.equal(row.projector, PROJECTOR)
  assert.equal(row.projector_version, PROJECTOR_VERSION)
})

test('node rules skip rows missing their natural key', () => {
  assert.equal(rule('node', 'Session').toRow({ session_id: null, message_created_at: TS }), null)
  assert.equal(rule('node', 'Session').toRow({ session_id: '', message_created_at: TS }), null)
  assert.equal(rule('node', 'App').toRow({ client_name: null, message_created_at: TS }), null)
  assert.equal(rule('node', 'Model').toRow({ model: undefined, message_created_at: TS }), null)
  assert.equal(rule('node', 'Tool').toRow({ tool_name: '', message_created_at: TS }), null)
})

test('Session rule with no optional fields builds null props', () => {
  const row = rule('node', 'Session').toRow({ session_id: 'sess-1', message_created_at: TS })
  assert.ok(row)
  assert.equal(row.props, null, 'empty props prune to null')
})

test('File rule resolves file_path from file-touching tools only', () => {
  const r = rule('node', 'File')
  const row = r.toRow({ tool_name: 'Read', tool_args: { file_path: '/repo/auth.py' }, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('File', '/repo/auth.py'))
  assert.equal(row.natural_key, '/repo/auth.py')
  assert.equal(row.label, 'auth.py')

  assert.equal(r.toRow({ tool_name: 'Bash', tool_args: { file_path: '/x' }, message_created_at: TS }), null, 'non-file tool skipped')
  assert.equal(r.toRow({ tool_name: 'Read', tool_args: {}, message_created_at: TS }), null, 'no path in args')
  assert.equal(r.toRow({ tool_name: null, tool_args: { file_path: '/x' }, message_created_at: TS }), null)
})

test('File rule parses tool_args arriving as a JSON string, skipping malformed JSON', () => {
  const r = rule('node', 'File')
  const row = r.toRow({ tool_name: 'Edit', tool_args: '{"file_path":"/repo/proxy.py"}', message_created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, '/repo/proxy.py')

  assert.equal(r.toRow({ tool_name: 'Edit', tool_args: '{not json', message_created_at: TS }), null, 'malformed JSON skipped')
  assert.equal(r.toRow({ tool_name: 'Edit', tool_args: '"just a string"', message_created_at: TS }), null, 'non-object JSON skipped')
})

test('File rule falls back to notebook_path', () => {
  const r = rule('node', 'File')
  const row = r.toRow({ tool_name: 'NotebookEdit', tool_args: { notebook_path: '/repo/nb.ipynb' }, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, '/repo/nb.ipynb')
  assert.equal(row.label, 'nb.ipynb')
})

test('touched edge wires Session and File node ids and skips partial rows', () => {
  const r = rule('edge', 'touched')
  const row = r.toRow({
    session_id: 'sess-1',
    tool_name: 'Write',
    tool_args: { file_path: '/repo/a.js' },
    message_created_at: TS,
  })
  assert.ok(row)
  const src = nodeId('Session', 'sess-1')
  const dst = nodeId('File', '/repo/a.js')
  assert.equal(row.src_id, src)
  assert.equal(row.dst_id, dst)
  assert.equal(row.edge_id, edgeId(src, 'touched', dst))
  assert.equal(row.src_type, 'Session')
  assert.equal(row.dst_type, 'File')

  assert.equal(r.toRow({ session_id: 'sess-1', tool_name: 'Bash', tool_args: {}, message_created_at: TS }), null)
  assert.equal(r.toRow({ session_id: null, tool_name: 'Write', tool_args: { file_path: '/x' }, message_created_at: TS }), null)
})

test('via and used_model edges skip rows missing either endpoint', () => {
  const via = rule('edge', 'via')
  assert.ok(via.toRow({ session_id: 'c', client_name: 'a', message_created_at: TS }))
  assert.equal(via.toRow({ session_id: 'c', client_name: null, message_created_at: TS }), null)
  assert.equal(via.toRow({ session_id: null, client_name: 'a', message_created_at: TS }), null)

  const used = rule('edge', 'used_model')
  assert.ok(used.toRow({ session_id: 'c', model: 'm', message_created_at: TS }))
  assert.equal(used.toRow({ session_id: 'c', model: '', message_created_at: TS }), null)
})

test('toRow normalizes first_seen from Date and epoch-number timestamps', () => {
  const r = rule('node', 'App')
  const fromDate = r.toRow({ client_name: 'claude', message_created_at: new Date(TS) })
  assert.ok(fromDate)
  assert.equal(fromDate.first_seen, TS)

  const fromNumber = r.toRow({ client_name: 'claude', message_created_at: Date.parse(TS) })
  assert.ok(fromNumber)
  assert.equal(fromNumber.first_seen, TS)

  const fromGarbage = r.toRow({ client_name: 'claude', message_created_at: '' })
  assert.ok(fromGarbage)
  assert.equal(fromGarbage.first_seen, null)
})

test('numeric natural keys are stringified', () => {
  const row = rule('node', 'Session').toRow({ session_id: 42, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, '42')
  assert.equal(row.node_id, nodeId('Session', '42'))
})

// @ref LLP 0026#decision: Claude harness aux exchanges are retained (tagged
// attributes.claude.aux_kind) rather than dropped; the graph contract must
// exclude them so security-monitor traffic mints no Session/App/Tool noise.
test('every rule selects attributes so the shared aux filter has its input', () => {
  for (const r of contract.rules) {
    assert.match(r.sql, /^SELECT\s+attributes\b/i, `rule ${r.kind}/${r.type} projects attributes`)
  }
})

test('aux-tagged rows are excluded from every node and edge rule', () => {
  const aux = { attributes: { claude: { aux_kind: 'security_monitor' } } }
  // Otherwise-valid rows that would each mint a node/edge if not aux.
  assert.equal(rule('node', 'Session').toRow({ ...aux, conversation_id: 'conv-1', message_created_at: TS }), null)
  assert.equal(rule('node', 'App').toRow({ ...aux, client_name: 'claude', message_created_at: TS }), null)
  assert.equal(rule('node', 'Model').toRow({ ...aux, model: 'claude-opus', message_created_at: TS }), null)
  assert.equal(rule('node', 'Tool').toRow({ ...aux, tool_name: 'Read', part_type: 'tool_call', message_created_at: TS }), null)
  assert.equal(rule('node', 'File').toRow({ ...aux, tool_name: 'Read', tool_args: { file_path: '/x' }, message_created_at: TS }), null)
  assert.equal(rule('edge', 'via').toRow({ ...aux, conversation_id: 'c', client_name: 'a', message_created_at: TS }), null)
  assert.equal(rule('edge', 'used_model').toRow({ ...aux, conversation_id: 'c', model: 'm', message_created_at: TS }), null)
  assert.equal(rule('edge', 'used').toRow({ ...aux, conversation_id: 'c', tool_name: 'Read', message_created_at: TS }), null)
  assert.equal(rule('edge', 'touched').toRow({ ...aux, conversation_id: 'c', tool_name: 'Write', tool_args: { file_path: '/a.js' }, message_created_at: TS }), null)
  assert.equal(rule('node', 'Program').toRow({ ...aux, tool_name: 'Bash', tool_args: { command: 'git status' }, part_type: 'tool_call', message_created_at: TS }), null)
  assert.equal(rule('edge', 'invoked').toRow({ ...aux, session_id: 's', tool_name: 'Bash', tool_args: { command: 'git status' }, part_type: 'tool_call', message_created_at: TS }), null)
})

test('aux filter handles attributes arriving as a JSON string', () => {
  const row = rule('node', 'Session').toRow({
    attributes: JSON.stringify({ claude: { aux_kind: 'security_monitor' } }),
    conversation_id: 'conv-1',
    message_created_at: TS,
  })
  assert.equal(row, null, 'aux_kind in a stringified attributes column is still excluded')
})

test('non-aux rows pass through unchanged (attributes present but no aux_kind)', () => {
  const row = rule('node', 'Session').toRow({
    attributes: { claude: { client_name: 'claude' }, dev_run_id: 'run-1' },
    session_id: 'sess-real',
    message_created_at: TS,
  })
  assert.ok(row, 'a real row with attributes but no aux_kind still mints its node')
  assert.equal(row.natural_key, 'sess-real')
})

// --- LLP 0032: GitHub↔LLM bridge nodes/edges + File re-key ---

const REMOTE = 'git@github.com:Acme/Repo.git'
const SHA = '0123456789abcdef0123456789abcdef01234567'

test('Repo node keys on owner/repo derived from the git remote', () => {
  const row = rule('node', 'Repo').toRow({ git_remote: REMOTE, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, 'acme/repo')
  assert.equal(row.node_id, nodeId('Repo', 'acme/repo'))
  assert.equal(row.label, 'acme/repo')
  assert.deepEqual(row.source_keys, { git_remote: REMOTE })
  // Non-github / missing remotes mint no Repo node.
  assert.equal(rule('node', 'Repo').toRow({ git_remote: 'git@gitlab.com:a/b.git', message_created_at: TS }), null)
  assert.equal(rule('node', 'Repo').toRow({ git_remote: null, message_created_at: TS }), null)
})

test('Commit node keys on the full HEAD sha and rejects an abbreviated one', () => {
  const row = rule('node', 'Commit').toRow({ head_sha: SHA.toUpperCase(), message_created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, SHA, 'sha lowercased')
  assert.equal(row.node_id, nodeId('Commit', SHA))
  assert.equal(row.label, SHA.slice(0, 12))
  assert.equal(rule('node', 'Commit').toRow({ head_sha: 'abc123', message_created_at: TS }), null, 'abbreviated sha skipped')
  assert.equal(rule('node', 'Commit').toRow({ head_sha: null, message_created_at: TS }), null)
})

test('File node re-keys an in-repo path to owner/repo:relpath (relpath case preserved)', () => {
  const row = rule('node', 'File').toRow({
    tool_name: 'Edit',
    tool_args: { file_path: '/home/u/Repo/src/Auth.py' },
    git_remote: REMOTE,
    repo_root: '/home/u/Repo',
    message_created_at: TS,
  })
  assert.ok(row)
  assert.equal(row.natural_key, 'acme/repo:src/Auth.py')
  assert.equal(row.node_id, nodeId('File', 'acme/repo:src/Auth.py'))
  assert.equal(row.label, 'Auth.py')
  assert.deepEqual(row.source_keys, { file_path: '/home/u/Repo/src/Auth.py', git_remote: REMOTE })
})

test('File node falls back to the absolute path when it cannot be relativized', () => {
  // Outside the repo root.
  const outside = rule('node', 'File').toRow({
    tool_name: 'Read',
    tool_args: { file_path: '/tmp/scratch.py' },
    git_remote: REMOTE,
    repo_root: '/home/u/Repo',
    message_created_at: TS,
  })
  assert.ok(outside)
  assert.equal(outside.natural_key, '/tmp/scratch.py', 'out-of-repo file keeps its absolute key')
  assert.deepEqual(outside.source_keys, { file_path: '/tmp/scratch.py' })

  // No captured repo at all (pre-0032 row / non-git session).
  const noRepo = rule('node', 'File').toRow({ tool_name: 'Read', tool_args: { file_path: '/repo/x.py' }, message_created_at: TS })
  assert.ok(noRepo)
  assert.equal(noRepo.natural_key, '/repo/x.py')
})

test('File node falls back (does not mint a bogus bridge key) for a path that escapes the root via `..`', () => {
  // `/home/u/Repo/../secret.py` is *outside* the repo. A raw prefix check would
  // slice it to `../secret.py` and mint `acme/repo:../secret.py`; normalization
  // before the containment test collapses it out from under the root, so it
  // falls back to its absolute key. @ref LLP 0032#file-migration
  const escaped = rule('node', 'File').toRow({
    tool_name: 'Edit',
    tool_args: { file_path: '/home/u/Repo/../secret.py' },
    git_remote: REMOTE,
    repo_root: '/home/u/Repo',
    message_created_at: TS,
  })
  assert.ok(escaped)
  assert.notEqual(escaped.natural_key, 'acme/repo:../secret.py', 'no `..` in the bridge key')
  assert.equal(escaped.natural_key, '/home/u/Repo/../secret.py', 'escaping path keeps its absolute key')
  assert.deepEqual(escaped.source_keys, { file_path: '/home/u/Repo/../secret.py' })
})

test('File node still relativizes an in-repo `..` that stays inside the root', () => {
  const inside = rule('node', 'File').toRow({
    tool_name: 'Edit',
    tool_args: { file_path: '/home/u/Repo/src/../Auth.py' },
    git_remote: REMOTE,
    repo_root: '/home/u/Repo',
    message_created_at: TS,
  })
  assert.ok(inside)
  assert.equal(inside.natural_key, 'acme/repo:Auth.py', 'in-repo `..` collapses then bridges')
})

test('touched edge re-keys its File endpoint identically to the File node', () => {
  const r = rule('edge', 'touched')
  const row = r.toRow({
    session_id: 'sess-1',
    tool_name: 'Write',
    tool_args: { file_path: '/home/u/Repo/src/Auth.py' },
    git_remote: REMOTE,
    repo_root: '/home/u/Repo',
    message_created_at: TS,
  })
  assert.ok(row)
  assert.equal(row.dst_id, nodeId('File', 'acme/repo:src/Auth.py'), 'edge points at the bridged File node')
  assert.equal(row.src_id, nodeId('Session', 'sess-1'))
})

test('Session -in-> Repo and Session -at-> Commit wire the bridge nodes', () => {
  const inRepo = rule('edge', 'in', 0).toRow({ session_id: 'sess-1', git_remote: REMOTE, message_created_at: TS })
  assert.ok(inRepo)
  assert.equal(inRepo.src_id, nodeId('Session', 'sess-1'))
  assert.equal(inRepo.dst_id, nodeId('Repo', 'acme/repo'))
  assert.equal(inRepo.src_type, 'Session')
  assert.equal(inRepo.dst_type, 'Repo')

  const atCommit = rule('edge', 'at').toRow({ session_id: 'sess-1', head_sha: SHA, message_created_at: TS })
  assert.ok(atCommit)
  assert.equal(atCommit.src_id, nodeId('Session', 'sess-1'))
  assert.equal(atCommit.dst_id, nodeId('Commit', SHA))

  // Missing endpoints skip.
  assert.equal(rule('edge', 'in', 0).toRow({ session_id: 'sess-1', git_remote: null, message_created_at: TS }), null)
  assert.equal(rule('edge', 'at').toRow({ session_id: 'sess-1', head_sha: 'abc123', message_created_at: TS }), null)
})

test('Commit -in-> Repo is the second `in` edge and converges with the GitHub edge', () => {
  const commitInRepo = rule('edge', 'in', 1).toRow({ head_sha: SHA, git_remote: REMOTE, message_created_at: TS })
  assert.ok(commitInRepo)
  assert.equal(commitInRepo.src_type, 'Commit')
  assert.equal(commitInRepo.dst_type, 'Repo')
  const commit = nodeId('Commit', SHA)
  const repo = nodeId('Repo', 'acme/repo')
  assert.equal(commitInRepo.src_id, commit)
  assert.equal(commitInRepo.dst_id, repo)
  assert.equal(commitInRepo.edge_id, edgeId(commit, 'in', repo))
})

// --- LLP 0073/0077 (issue #230): Program nodes + invoked edges ---

test('Program/invoked rules select only tool_call rows from the two shell tools', () => {
  for (const r of [rule('node', 'Program'), rule('edge', 'invoked')]) {
    assert.match(r.sql, /part_type = 'tool_call'/, `${r.kind}/${r.type} filters tool_call parts`)
    assert.match(r.sql, /tool_name IN \('Bash', 'exec_command'\)/, `${r.kind}/${r.type} filters the shell tools`)
  }
})

test('Program node keys on the validity-gated basename(argv[0]) of the first command', () => {
  const r = rule('node', 'Program')
  const row = r.toRow({ tool_name: 'Bash', tool_args: { command: '/opt/homebrew/bin/duckdb foo.db' }, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('Program', 'duckdb'))
  assert.equal(row.node_type, 'Program')
  assert.equal(row.natural_key, 'duckdb', 'path basenamed + lowercased')
  assert.equal(row.label, 'duckdb', 'label is the key')
  assert.equal(row.props, null, 'Program carries no props')
  assert.deepEqual(row.source_keys, { tool_name: 'Bash', program: 'duckdb' })
  assert.equal(row.projector_version, PROJECTOR_VERSION)

  // Codex exec_command reads the `cmd` arg (and bash -lc is unwrapped).
  const codex = r.toRow({ tool_name: 'exec_command', tool_args: { cmd: 'bash -lc "git commit -m x"' }, message_created_at: TS })
  assert.ok(codex)
  assert.equal(codex.natural_key, 'git')
})

test('Program node mints nothing when the facet cannot be cleanly bounded (fail-closed)', () => {
  const r = rule('node', 'Program')
  assert.equal(r.toRow({ tool_name: 'Read', tool_args: { command: 'git status' }, message_created_at: TS }), null, 'non-shell tool')
  assert.equal(r.toRow({ tool_name: 'Bash', tool_args: {}, message_created_at: TS }), null, 'no command')
  assert.equal(r.toRow({ tool_name: 'Bash', tool_args: '{bad json', message_created_at: TS }), null, 'malformed args')
  assert.equal(r.toRow({ tool_name: 'Bash', tool_args: { command: '12345' }, message_created_at: TS }), null, 'all-numeric argv[0]')
  assert.equal(r.toRow({ tool_name: 'Bash', tool_args: { command: '"has space" x' }, message_created_at: TS }), null, 'un-gateable token')
})

test('Program node parses tool_args arriving as a JSON string', () => {
  const row = rule('node', 'Program').toRow({ tool_name: 'exec_command', tool_args: '{"cmd":"npm run build"}', message_created_at: TS })
  assert.ok(row)
  assert.equal(row.natural_key, 'npm')
})

test('invoked edge wires Session -> Program ids and carries no props', () => {
  const r = rule('edge', 'invoked')
  const row = r.toRow({ session_id: 'sess-1', tool_name: 'Bash', tool_args: { command: 'git push origin main' }, message_created_at: TS })
  assert.ok(row)
  const src = nodeId('Session', 'sess-1')
  const dst = nodeId('Program', 'git')
  assert.equal(row.src_id, src)
  assert.equal(row.dst_id, dst)
  assert.equal(row.edge_id, edgeId(src, 'invoked', dst), 'edge points at the Program node the node rule mints')
  assert.equal(row.src_type, 'Session')
  assert.equal(row.dst_type, 'Program')
  assert.equal(row.props, null)
  assert.deepEqual(row.source_keys, { session_id: 'sess-1', tool_name: 'Bash', program: 'git' })
})

test('invoked edge skips rows missing the session or an un-gateable program', () => {
  const r = rule('edge', 'invoked')
  assert.equal(r.toRow({ session_id: null, tool_name: 'Bash', tool_args: { command: 'git status' }, message_created_at: TS }), null)
  assert.equal(r.toRow({ session_id: 'sess-1', tool_name: 'Bash', tool_args: { command: '   ' }, message_created_at: TS }), null)
  assert.equal(r.toRow({ session_id: 'sess-1', tool_name: 'Read', tool_args: { command: 'git status' }, message_created_at: TS }), null)
})
