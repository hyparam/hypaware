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
// @ref LLP 0096#decision [tests]: the aux filter is the contract rowFilter,
// evaluated once per source row by the engine (both scan paths), so these
// assertions target keep() rather than each rule's toRow. The end-to-end
// exclusion (rows never reaching any rule) is pinned by the projection e2e.
test('the contract declares the aux rowFilter on attributes, and raw rules select it', () => {
  assert.ok(contract.rowFilter, 'contract carries the aux rowFilter')
  assert.deepEqual(contract.rowFilter.columns, ['attributes'])
  for (const r of contract.rules.filter((r) => typeof r.sql === 'string')) {
    assert.match(/** @type {string} */ (r.sql), /^SELECT\s+attributes\b/i, `raw rule ${r.kind}/${r.type} projects attributes itself`)
  }
})

test('the aux rowFilter drops aux-tagged rows and keeps real ones', () => {
  const { keep } = /** @type {NonNullable<typeof contract.rowFilter>} */ (contract.rowFilter)
  assert.equal(keep({ attributes: { claude: { aux_kind: 'security_monitor' } } }), false, 'aux object excluded')
  assert.equal(keep({ attributes: JSON.stringify({ claude: { aux_kind: 'security_monitor' } }) }), false, 'aux_kind in a stringified attributes column is still excluded')
  assert.equal(keep({ attributes: { claude: { client_name: 'claude' }, dev_run_id: 'run-1' } }), true, 'attributes without aux_kind pass')
  assert.equal(keep({ attributes: null }), true, 'absent attributes pass')
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
    assert.equal(r.where?.eq?.part_type, 'tool_call', `${r.kind}/${r.type} filters tool_call parts`)
    assert.deepEqual(r.where?.in?.tool_name, ['Bash', 'exec_command'], `${r.kind}/${r.type} filters the shell tools`)
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

// --- LLP 0073/0074 (issue #229): Claude Skill nodes + ran edges ---

// Rule order within each kind: surface 1 (Skill tool), surface 2 (marker),
// surface 3 (slash), surface 4 (Codex exec_command read). The nth argument
// of rule() indexes that order.
const SKILL_TOOL = 0
const SKILL_MARKER = 1
const SKILL_SLASH = 2
const SKILL_CODEX = 3

const MARKER_TEXT = 'Base directory for this skill: /home/u/.claude/skills/hypaware-query'
const SLASH_TEXT = '<command-name>/hypaware-query</command-name>'
const CODEX_READ_ARGS = { cmd: 'cat /home/u/.codex/skills/hypaware-query/SKILL.md' }

// @ref LLP 0074#strict-filters [tests]: the filters are the decision, not
// tuning parameters; only role='user' text with a leading anchor is clean.
// Surfaces 1/4 are declarative predicates (shared scan); surfaces 2/3 stay
// raw SQL so the content_text prefix guard prunes server-side (LLP 0096).
test('Skill/ran rules declare the strict per-surface filters', () => {
  for (const kind of /** @type {const} */ (['node', 'edge'])) {
    const type = kind === 'node' ? 'Skill' : 'ran'
    const tool = rule(kind, type, SKILL_TOOL)
    assert.deepEqual(tool.where?.eq, { part_type: 'tool_call', tool_name: 'Skill' }, `${kind} surface 1 filters Skill tool calls`)

    const marker = rule(kind, type, SKILL_MARKER)
    assert.match(/** @type {string} */ (marker.sql), /role = 'user' AND part_type = 'text'/, `${kind} surface 2 filters user text parts (assistant-role markers never reach toRow)`)
    assert.match(/** @type {string} */ (marker.sql), /content_text LIKE 'Base directory for this skill: %'/, `${kind} surface 2 anchors the marker in SQL`)

    const slash = rule(kind, type, SKILL_SLASH)
    assert.match(/** @type {string} */ (slash.sql), /role = 'user' AND part_type = 'text'/, `${kind} surface 3 filters user text parts`)
    assert.match(/** @type {string} */ (slash.sql), /content_text LIKE '<command-name>%'/, `${kind} surface 3 anchors the tag in SQL`)

    const codex = rule(kind, type, SKILL_CODEX)
    assert.deepEqual(codex.where?.eq, { part_type: 'tool_call', tool_name: 'exec_command' }, `${kind} surface 4 filters exec_command tool calls`)
  }
})

test('Skill node from the Skill tool call keys on tool_args.skill', () => {
  const row = rule('node', 'Skill', SKILL_TOOL).toRow({ session_id: 'sess-1', tool_args: '{"skill":"hypaware-query"}', message_created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('Skill', 'hypaware-query'))
  assert.equal(row.node_type, 'Skill')
  assert.equal(row.natural_key, 'hypaware-query', 'verbatim bare name')
  assert.equal(row.label, 'hypaware-query')
  assert.equal(row.props, null, 'Skill carries no node props')
  assert.deepEqual(row.source_keys, { tool_name: 'Skill', skill: 'hypaware-query' })
  assert.equal(row.projector_version, PROJECTOR_VERSION)
})

test('Skill node from the marker keys on the base-directory basename', () => {
  const row = rule('node', 'Skill', SKILL_MARKER).toRow({ session_id: 'sess-1', content_text: MARKER_TEXT, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('Skill', 'hypaware-query'))
  assert.equal(row.natural_key, 'hypaware-query')
  assert.deepEqual(row.source_keys, { skill: 'hypaware-query' })
})

test('Skill node from a slash command keys on the de-slashed name', () => {
  const row = rule('node', 'Skill', SKILL_SLASH).toRow({ session_id: 'sess-1', content_text: SLASH_TEXT, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('Skill', 'hypaware-query'))
  assert.equal(row.natural_key, 'hypaware-query')
})

// @ref LLP 0075#decision [tests]: Codex's own surface — a path-pattern match
// on the exec_command SKILL.md read, not any Claude signal.
test('Skill node from a Codex exec_command read keys on the .codex/skills/<name>/SKILL.md path', () => {
  const row = rule('node', 'Skill', SKILL_CODEX).toRow({ session_id: 'sess-1', tool_args: CODEX_READ_ARGS, message_created_at: TS })
  assert.ok(row)
  assert.equal(row.node_id, nodeId('Skill', 'hypaware-query'))
  assert.equal(row.node_type, 'Skill')
  assert.equal(row.natural_key, 'hypaware-query')
  assert.equal(row.label, 'hypaware-query')
  assert.equal(row.props, null, 'Skill carries no node props')
  assert.deepEqual(row.source_keys, { tool_name: 'exec_command', skill: 'hypaware-query' })
  assert.equal(row.projector_version, PROJECTOR_VERSION)

  // fallback `command` arg, and a non-`.codex` path mints nothing.
  const fallback = rule('node', 'Skill', SKILL_CODEX).toRow({ session_id: 'sess-1', tool_args: { command: 'cat /home/u/.codex/skills/hypaware-query/SKILL.md' }, message_created_at: TS })
  assert.ok(fallback)
  assert.equal(fallback.natural_key, 'hypaware-query')
})

test('all four surfaces converge on one Skill node id (cross-surface identity)', () => {
  const tool = rule('node', 'Skill', SKILL_TOOL).toRow({ session_id: 's', tool_args: { skill: 'hypaware-query' }, message_created_at: TS })
  const marker = rule('node', 'Skill', SKILL_MARKER).toRow({ session_id: 's', content_text: MARKER_TEXT, message_created_at: TS })
  const slash = rule('node', 'Skill', SKILL_SLASH).toRow({ session_id: 's', content_text: SLASH_TEXT, message_created_at: TS })
  const codex = rule('node', 'Skill', SKILL_CODEX).toRow({ session_id: 's', tool_args: CODEX_READ_ARGS, message_created_at: TS })
  assert.ok(tool && marker && slash && codex)
  assert.equal(tool.node_id, marker.node_id)
  assert.equal(marker.node_id, slash.node_id)
  assert.equal(slash.node_id, codex.node_id)
})

// @ref LLP 0078#decision [tests]: each surface stamps ONLY its own dispatch
// flag; the edge id hashes (src, type, dst) only, so all surfaces collapse
// onto one edge and mergeRow unions the flags.
test('ran edges wire Session -> Skill with exactly their own dispatch flag', () => {
  const src = nodeId('Session', 'sess-1')
  const dst = nodeId('Skill', 'hypaware-query')

  const tool = rule('edge', 'ran', SKILL_TOOL).toRow({ session_id: 'sess-1', tool_args: { skill: 'hypaware-query' }, message_created_at: TS })
  assert.ok(tool)
  assert.equal(tool.src_id, src)
  assert.equal(tool.dst_id, dst)
  assert.equal(tool.edge_id, edgeId(src, 'ran', dst))
  assert.equal(tool.src_type, 'Session')
  assert.equal(tool.dst_type, 'Skill')
  assert.deepEqual(tool.props, { dispatch_tool: true })
  assert.deepEqual(tool.source_keys, { session_id: 'sess-1', tool_name: 'Skill', skill: 'hypaware-query' })

  const marker = rule('edge', 'ran', SKILL_MARKER).toRow({ session_id: 'sess-1', content_text: MARKER_TEXT, message_created_at: TS })
  assert.ok(marker)
  assert.deepEqual(marker.props, { dispatch_marker: true })
  assert.deepEqual(marker.source_keys, { session_id: 'sess-1', skill: 'hypaware-query' })

  const slash = rule('edge', 'ran', SKILL_SLASH).toRow({ session_id: 'sess-1', content_text: SLASH_TEXT, message_created_at: TS })
  assert.ok(slash)
  assert.deepEqual(slash.props, { dispatch_slash: true })

  const codex = rule('edge', 'ran', SKILL_CODEX).toRow({ session_id: 'sess-1', tool_args: CODEX_READ_ARGS, message_created_at: TS })
  assert.ok(codex)
  assert.deepEqual(codex.props, { dispatch_shell_read: true })
  assert.deepEqual(codex.source_keys, { session_id: 'sess-1', tool_name: 'exec_command', skill: 'hypaware-query' })

  // Same (session, skill) pair from every surface -> the SAME edge id, so the
  // dispatch flags merge onto one edge instead of minting four.
  assert.equal(marker.edge_id, tool.edge_id)
  assert.equal(slash.edge_id, tool.edge_id)
  assert.equal(codex.edge_id, tool.edge_id)
})

test('ran edges skip rows missing the session or an un-gateable skill', () => {
  assert.equal(rule('edge', 'ran', SKILL_TOOL).toRow({ session_id: null, tool_args: { skill: 'x' }, message_created_at: TS }), null)
  assert.equal(rule('edge', 'ran', SKILL_TOOL).toRow({ session_id: 'sess-1', tool_args: {}, message_created_at: TS }), null)
  assert.equal(rule('edge', 'ran', SKILL_MARKER).toRow({ session_id: null, content_text: MARKER_TEXT, message_created_at: TS }), null)
  assert.equal(rule('edge', 'ran', SKILL_SLASH).toRow({ session_id: 'sess-1', content_text: '<command-name></command-name>', message_created_at: TS }), null)
  assert.equal(rule('edge', 'ran', SKILL_CODEX).toRow({ session_id: null, tool_args: CODEX_READ_ARGS, message_created_at: TS }), null)
  assert.equal(rule('edge', 'ran', SKILL_CODEX).toRow({ session_id: 'sess-1', tool_args: { cmd: 'ls /repo' }, message_created_at: TS }), null)
})

// @ref LLP 0074#strict-filters [tests]: the false-positive matrix. Signals
// that LOOK like activations but are not (the ~23% the issue measured) mint
// nothing through any surface.
test('false-positive matrix: near-miss signals mint nothing', () => {
  const markerNode = rule('node', 'Skill', SKILL_MARKER)
  const slashNode = rule('node', 'Skill', SKILL_SLASH)
  const toolNode = rule('node', 'Skill', SKILL_TOOL)

  // A marker quoted mid-message (assistant echo, pasted transcript, query
  // output) fails the offset-0 anchor even if it slipped past the LIKE.
  assert.equal(markerNode.toRow({ session_id: 's', content_text: `look at this: ${MARKER_TEXT}`, message_created_at: TS }), null, 'mid-text marker')
  assert.equal(markerNode.toRow({ session_id: 's', content_text: ` ${MARKER_TEXT}`, message_created_at: TS }), null, 'offset-1 marker')

  // A built-in slash command is not a skill run.
  assert.equal(slashNode.toRow({ session_id: 's', content_text: '<command-name>/compact</command-name>', message_created_at: TS }), null, 'built-in slash')
  assert.equal(rule('edge', 'ran', SKILL_SLASH).toRow({ session_id: 's', content_text: '<command-name>/compact</command-name>', message_created_at: TS }), null, 'built-in slash edge')

  // A mid-text slash tag (someone discussing the tag shape) fails the anchor.
  assert.equal(slashNode.toRow({ session_id: 's', content_text: 'the tag is <command-name>/x</command-name>', message_created_at: TS }), null, 'mid-text tag')

  // grep/cat/Read of a SKILL.md is inspection, not activation: a Bash grep row
  // carries no tool_args.skill, so the tool surface mints nothing (and the SQL
  // filter would not even select it: tool_name = 'Skill' only).
  assert.equal(toolNode.toRow({ session_id: 's', tool_args: { command: 'grep -r "name:" ~/.claude/skills/hypaware-query/SKILL.md' }, message_created_at: TS }), null, 'grep of SKILL.md')

  // Un-gateable names fail closed at every surface.
  assert.equal(toolNode.toRow({ session_id: 's', tool_args: { skill: 'not a skill name' }, message_created_at: TS }), null)

  // Codex surface 4: a Claude-shaped `.claude/skills/...` path shares no
  // signal (LLP 0075 §no-shared-rule) and a read of some other file in the
  // skill's own directory is not an activation.
  const codexNode = rule('node', 'Skill', SKILL_CODEX)
  assert.equal(codexNode.toRow({ session_id: 's', tool_args: { cmd: 'cat ~/.claude/skills/hypaware-query/SKILL.md' }, message_created_at: TS }), null, 'Claude-shaped path on the Codex surface')
  assert.equal(codexNode.toRow({ session_id: 's', tool_args: { cmd: 'ls ~/.codex/skills/hypaware-query' }, message_created_at: TS }), null, 'directory listing, no SKILL.md read')
  assert.equal(codexNode.toRow({ session_id: 's', tool_args: { cmd: 'cat ~/.codex/skills/hypaware-query/reference.md' }, message_created_at: TS }), null, 'reads a different file in the skill dir')
})

// @ref LLP 0096#decision [tests]: aux exclusion is the contract rowFilter's
// job for every rule uniformly (the engine applies it before any toRow on
// both scan paths), so the Skill/ran surfaces need no per-rule aux checks;
// the rowFilter test above plus the projection e2e cover them.
test('aux-tagged skill rows are excluded by the contract rowFilter', () => {
  const { keep } = /** @type {NonNullable<typeof contract.rowFilter>} */ (contract.rowFilter)
  const aux = { attributes: { claude: { aux_kind: 'security_monitor' } } }
  assert.equal(keep({ ...aux, session_id: 's', tool_args: { skill: 'x1' }, message_created_at: TS }), false)
  assert.equal(keep({ ...aux, session_id: 's', content_text: MARKER_TEXT, message_created_at: TS }), false)
  assert.equal(keep({ ...aux, session_id: 's', tool_args: CODEX_READ_ARGS, message_created_at: TS }), false)
})
