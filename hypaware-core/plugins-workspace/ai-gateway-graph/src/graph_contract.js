// @ts-check

import path from 'node:path'

import { keys } from './graph-keys.js'
import { commandStringFrom, programFrom, skillFromCodexRead, skillFromMarker, skillFromSlash, skillFromToolArgs } from './tool_facets.js'

/**
 * @import { ContractRule, GraphKit, GraphKeys } from './types.js'
 */

/** This connector's plugin name, stamped on the contract for provenance/dedup keys. */
export const PLUGIN_NAME = '@hypaware/ai-gateway-graph'

/** The public dataset the gateway fills; named by string (no import of ai-gateway private files, per LLP 0006). */
export const SOURCE_DATASET = 'ai_gateway_messages'
/** Projector id stamped into every row's provenance. */
export const PROJECTOR = 'ai-gateway.t0'
/**
 * Projector version, stamped into provenance to mark which projector generation
 * minted a row (not a re-projection trigger: ids are content-addressed; see
 * LLP 0023 §inline-provenance). Bumped `1 → 2` with the additive `Program` /
 * `invoked` rules (LLP 0073 §additive-no-migration): provenance only — existing
 * rows and ids are untouched, there is no re-key and therefore no migration.
 */
export const PROJECTOR_VERSION = 2

/** Tools whose args name a concrete file. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Build the `ai_gateway_messages → graph` T0 contract. The rules are the same
 * hand-authored node/edge mappings that used to live in `@hypaware/context-graph`;
 * they now live here, beside the source they read. Rows are built with the
 * graph plugin's `kit` so the id recipe and provenance columns stay owned by
 * the graph plugin. This connector owns the read declarations (declarative
 * columns/where, or raw SQL for the pushed-down prefix guards) + `toRow`
 * semantics and the bridge-key recipe (`keys`, imported from
 * `./graph-keys.js`).
 *
 * @param {GraphKit} kit
 * @returns {{ name: string, plugin: string, sourceDataset: string, projector: string, projectorVersion: number, rules: ContractRule[], rowFilter: { columns: string[], keep(row: Record<string, unknown>): boolean } }}
 * @ref LLP 0023#contract-contribution [implements]: a source's contract, contributed via the capability; engine + kit stay central
 */
export function createAiGatewayGraphContract(kit) {
  const { buildNode, buildEdge } = kit.makeRowBuilders({
    sourceDataset: SOURCE_DATASET,
    projector: PROJECTOR,
    projectorVersion: PROJECTOR_VERSION,
  })

  /** @type {ContractRule[]} */
  const rules = [
    // --- nodes ---

    // Session per session_id. @ref LLP 0030#decision: session_id is the
    // session container (always present); conversation_id is null for
    // Claude, so the Session node must key on session_id, not
    // conversation_id.
    {
      kind: 'node',
      type: 'Session',
      columns: ['session_id', 'cwd', 'git_branch', 'client_name', 'user_id', 'message_created_at'],
      toRow(r) {
        const key = str(r.session_id)
        if (!key) return null
        return buildNode({
          type: 'Session',
          key,
          props: pruned({
            cwd: str(r.cwd),
            git_branch: str(r.git_branch),
            client_name: str(r.client_name),
            user_id: str(r.user_id),
          }),
          firstSeen: r.message_created_at,
          sourceKeys: { session_id: key },
        })
      },
    },

    // App per client_name.
    {
      kind: 'node',
      type: 'App',
      columns: ['client_name', 'message_created_at'],
      toRow(r) {
        const key = str(r.client_name)
        if (!key) return null
        return buildNode({ type: 'App', key, label: key, firstSeen: r.message_created_at, sourceKeys: { client_name: key } })
      },
    },

    // Model per model id.
    {
      kind: 'node',
      type: 'Model',
      columns: ['model', 'message_created_at'],
      toRow(r) {
        const key = str(r.model)
        if (!key) return null
        return buildNode({ type: 'Model', key, label: key, firstSeen: r.message_created_at, sourceKeys: { model: key } })
      },
    },

    // Tool per tool_name, from tool_call parts.
    {
      kind: 'node',
      type: 'Tool',
      columns: ['tool_name', 'message_created_at'],
      where: { eq: { part_type: 'tool_call' } },
      toRow(r) {
        const key = str(r.tool_name)
        if (!key) return null
        return buildNode({ type: 'Tool', key, label: key, firstSeen: r.message_created_at, sourceKeys: { tool_name: key } })
      },
    },

    // File per resolved path, from file-touching tool calls. The key is
    // `owner/repo:relpath` when the absolute path can be relativized against the
    // captured repo (so it converges with @hypaware/github AND across worktrees
    // of one repo); it falls back to the absolute path otherwise (file outside
    // the repo, non-github remote, or a session with no captured repo).
    // @ref LLP 0032#file-migration [implements]:
    {
      kind: 'node',
      type: 'File',
      columns: ['tool_name', 'tool_args', 'git_remote', 'repo_root', 'message_created_at'],
      where: { eq: { part_type: 'tool_call' } },
      toRow(r) {
        const target = fileTargetFrom(keys, r.tool_name, r.tool_args, r.git_remote, r.repo_root)
        if (!target) return null
        return buildNode({ type: 'File', key: target.key, label: target.label, firstSeen: r.message_created_at, sourceKeys: target.sourceKeys })
      },
    },

    // Repo per captured git remote (`owner/repo`). Bridge-ready: a repo seen by
    // @hypaware/github lands on this same node. @ref LLP 0032#repo-commit-nodes
    {
      kind: 'node',
      type: 'Repo',
      columns: ['git_remote', 'message_created_at'],
      toRow(r) {
        const key = keys.repoKeyFromRemote(r.git_remote)
        if (!key) return null
        return buildNode({ type: 'Repo', key, label: key, firstSeen: r.message_created_at, sourceKeys: { git_remote: str(r.git_remote) } })
      },
    },

    // Commit per captured full HEAD sha. Bridge-ready: the sha is globally
    // unique across git, so it converges with @hypaware/github with no repo
    // qualification. An abbreviated sha is rejected by `commitKey` (it could
    // not converge with the full-sha node). @ref LLP 0032#repo-commit-nodes
    {
      kind: 'node',
      type: 'Commit',
      columns: ['head_sha', 'message_created_at'],
      toRow(r) {
        const key = keys.commitKey(r.head_sha)
        if (!key) return null
        return buildNode({ type: 'Commit', key, label: key.slice(0, 12), firstSeen: r.message_created_at, sourceKeys: { head_sha: key } })
      },
    },

    // Program per validity-gated basename(argv[0]) of the first command, from
    // the two busy shell tools. The raw command string is unbounded (~1,433
    // distinct for 1,568 Codex calls) and stays in ai_gateway_messages; only the
    // bounded program facet (~29 distinct) becomes a node.
    // @ref LLP 0077#decision [implements] — Program = validity-gated
    // basename(argv[0]) of the first command; fail-closed (mint nothing rather
    // than mis-key). Extraction lives in `tool_facets.js`.
    {
      kind: 'node',
      type: 'Program',
      columns: ['tool_name', 'tool_args', 'message_created_at'],
      where: { eq: { part_type: 'tool_call' }, in: { tool_name: ['Bash', 'exec_command'] } },
      toRow(r) {
        const key = programFrom(commandStringFrom(r.tool_name, r.tool_args))
        if (!key) return null
        return buildNode({ type: 'Program', key, label: key, firstSeen: r.message_created_at, sourceKeys: { tool_name: str(r.tool_name), program: key } })
      },
    },

    // Skill nodes from the four activation surfaces: three Claude surfaces
    // (1-3, below) plus Codex's own (4, LLP 0075 — Codex shares zero signal
    // with Claude). Each surface is its own rule pair (node + ran edge from
    // the same match, so an edge never dangles). Surfaces 1-3 each sit under
    // a strict filter: only role='user'/part_type='text' with a leading
    // anchor is clean (loose matching pulls ~23% false positives, LLP 0074
    // §strict-filters); the offset-0 anchor is enforced twice, in the SQL
    // prefix-LIKE and again in the extraction helper. Assistant text
    // mentioning skills, grep/cat/Read of a SKILL.md, and mid-text markers
    // deliberately mint nothing.
    // @ref LLP 0073#claude-skill-derivation [implements]: three-surface union;
    // strict role/part_type/offset-0 filters (LLP 0074).

    // Surface 1: the model chose the skill via the `Skill` tool.
    {
      kind: 'node',
      type: 'Skill',
      columns: ['session_id', 'tool_args', 'message_created_at'],
      where: { eq: { part_type: 'tool_call', tool_name: 'Skill' } },
      toRow(r) {
        const key = skillFromToolArgs(r.tool_args)
        if (!key) return null
        return buildNode({ type: 'Skill', key, label: key, firstSeen: r.message_created_at, sourceKeys: { tool_name: 'Skill', skill: key } })
      },
    },

    // Surface 2: the SKILL.md injection marker at offset 0 of a user text part.
    {
      kind: 'node',
      type: 'Skill',
      // Raw SQL on purpose: the prefix filter prunes `content_text` (the
      // table's largest column) server-side, keeping it out of the shared
      // scan's materialization. `attributes` rides for the contract
      // rowFilter (registry-enforced).
      // @ref LLP 0096#decision [constrained-by]: heavy-column prefix guards stay pushed down
      sql: `SELECT attributes, session_id, content_text, message_created_at FROM ${SOURCE_DATASET} WHERE role = 'user' AND part_type = 'text' AND content_text LIKE 'Base directory for this skill: %'`,
      toRow(r) {
        const key = skillFromMarker(r.content_text)
        if (!key) return null
        return buildNode({ type: 'Skill', key, label: key, firstSeen: r.message_created_at, sourceKeys: { skill: key } })
      },
    },

    // Surface 3: a user-typed slash command, minus Claude Code built-ins.
    {
      kind: 'node',
      type: 'Skill',
      // Raw SQL on purpose, same pushdown rationale as the marker surface.
      sql: `SELECT attributes, session_id, content_text, message_created_at FROM ${SOURCE_DATASET} WHERE role = 'user' AND part_type = 'text' AND content_text LIKE '<command-name>%'`,
      toRow(r) {
        const key = skillFromSlash(r.content_text)
        if (!key) return null
        return buildNode({ type: 'Skill', key, label: key, firstSeen: r.message_created_at, sourceKeys: { skill: key } })
      },
    },

    // Surface 4: Codex shares none of the Claude signals (no marker, no
    // `Skill` tool, no `<command-name>` tag), so its activation trace is a
    // plain shell read of the SKILL.md — an `exec_command` whose command
    // string matches `.codex/skills/<name>/SKILL.md`.
    // @ref LLP 0073#codex-skill-derivation [implements] — path-pattern on the
    // exec_command SKILL.md read; Codex shares no Claude signal (LLP 0075).
    {
      kind: 'node',
      type: 'Skill',
      columns: ['session_id', 'tool_args', 'message_created_at'],
      where: { eq: { part_type: 'tool_call', tool_name: 'exec_command' } },
      toRow(r) {
        const key = skillFromCodexRead(commandStringFrom('exec_command', r.tool_args))
        if (!key) return null
        return buildNode({ type: 'Skill', key, label: key, firstSeen: r.message_created_at, sourceKeys: { tool_name: 'exec_command', skill: key } })
      },
    },

    // --- edges ---

    // Session -via-> App. @ref LLP 0030#decision: Session keyed on
    // session_id (conversation_id is null for Claude).
    {
      kind: 'edge',
      type: 'via',
      columns: ['session_id', 'client_name', 'message_created_at'],
      toRow(r) {
        const session = str(r.session_id)
        const app = str(r.client_name)
        if (!session || !app) return null
        return buildEdge({ type: 'via', srcType: 'Session', srcKey: session, dstType: 'App', dstKey: app, firstSeen: r.message_created_at, sourceKeys: { session_id: session, client_name: app } })
      },
    },

    // Session -used_model-> Model
    {
      kind: 'edge',
      type: 'used_model',
      columns: ['session_id', 'model', 'message_created_at'],
      toRow(r) {
        const session = str(r.session_id)
        const model = str(r.model)
        if (!session || !model) return null
        return buildEdge({ type: 'used_model', srcType: 'Session', srcKey: session, dstType: 'Model', dstKey: model, firstSeen: r.message_created_at, sourceKeys: { session_id: session, model } })
      },
    },

    // Session -used-> Tool
    {
      kind: 'edge',
      type: 'used',
      columns: ['session_id', 'tool_name', 'message_created_at'],
      where: { eq: { part_type: 'tool_call' } },
      toRow(r) {
        const session = str(r.session_id)
        const tool = str(r.tool_name)
        if (!session || !tool) return null
        return buildEdge({ type: 'used', srcType: 'Session', srcKey: session, dstType: 'Tool', dstKey: tool, firstSeen: r.message_created_at, sourceKeys: { session_id: session, tool_name: tool } })
      },
    },

    // Session -touched-> File. The File endpoint is keyed identically to the
    // File node rule (bridge key when relativizable, else absolute path), so the
    // edge always points at a node the File rule mints. @ref LLP 0032#file-migration
    {
      kind: 'edge',
      type: 'touched',
      columns: ['session_id', 'tool_name', 'tool_args', 'git_remote', 'repo_root', 'message_created_at'],
      where: { eq: { part_type: 'tool_call' } },
      toRow(r) {
        const session = str(r.session_id)
        const target = fileTargetFrom(keys, r.tool_name, r.tool_args, r.git_remote, r.repo_root)
        if (!session || !target) return null
        return buildEdge({ type: 'touched', srcType: 'Session', srcKey: session, dstType: 'File', dstKey: target.key, firstSeen: r.message_created_at, sourceKeys: { session_id: session, ...target.sourceKeys } })
      },
    },

    // Session -in-> Repo: which repo this session ran in. @ref LLP 0032#repo-commit-nodes
    {
      kind: 'edge',
      type: 'in',
      columns: ['session_id', 'git_remote', 'message_created_at'],
      toRow(r) {
        const session = str(r.session_id)
        const repo = keys.repoKeyFromRemote(r.git_remote)
        if (!session || !repo) return null
        return buildEdge({ type: 'in', srcType: 'Session', srcKey: session, dstType: 'Repo', dstKey: repo, firstSeen: r.message_created_at, sourceKeys: { session_id: session, git_remote: str(r.git_remote) } })
      },
    },

    // Session -at-> Commit: the HEAD the session was sitting on. @ref LLP 0032#repo-commit-nodes
    {
      kind: 'edge',
      type: 'at',
      columns: ['session_id', 'head_sha', 'message_created_at'],
      toRow(r) {
        const session = str(r.session_id)
        const commit = keys.commitKey(r.head_sha)
        if (!session || !commit) return null
        return buildEdge({ type: 'at', srcType: 'Session', srcKey: session, dstType: 'Commit', dstKey: commit, firstSeen: r.message_created_at, sourceKeys: { session_id: session, head_sha: commit } })
      },
    },

    // Commit -in-> Repo: situates the HEAD commit in its repo. This is the SAME
    // edge @hypaware/github mints, so it converges (not just the endpoint
    // nodes). @ref LLP 0032#repo-commit-nodes
    {
      kind: 'edge',
      type: 'in',
      columns: ['head_sha', 'git_remote', 'message_created_at'],
      toRow(r) {
        const commit = keys.commitKey(r.head_sha)
        const repo = keys.repoKeyFromRemote(r.git_remote)
        if (!commit || !repo) return null
        return buildEdge({ type: 'in', srcType: 'Commit', srcKey: commit, dstType: 'Repo', dstKey: repo, firstSeen: r.message_created_at, sourceKeys: { head_sha: commit, git_remote: str(r.git_remote) } })
      },
    },

    // Session -invoked-> Program. Distinct edge type from `used` (Tool) so
    // programs never collide with tool names under one edge_type filter, and
    // distinct from the skills' `ran` (issue #230 vs #229). The Program endpoint
    // is keyed identically to the Program node rule, so the edge always lands on
    // a node that rule mints. No props (unlike `ran`).
    // @ref LLP 0077#decision [implements] — validity-gated basename(argv[0]); fail-closed.
    {
      kind: 'edge',
      type: 'invoked',
      columns: ['session_id', 'tool_name', 'tool_args', 'message_created_at'],
      where: { eq: { part_type: 'tool_call' }, in: { tool_name: ['Bash', 'exec_command'] } },
      toRow(r) {
        const session = str(r.session_id)
        const program = programFrom(commandStringFrom(r.tool_name, r.tool_args))
        if (!session || !program) return null
        return buildEdge({ type: 'invoked', srcType: 'Session', srcKey: session, dstType: 'Program', dstKey: program, firstSeen: r.message_created_at, sourceKeys: { session_id: session, tool_name: str(r.tool_name), program } })
      },
    },

    // Session -ran-> Skill, one rule per activation surface, Claude's three
    // (1-3) plus Codex's own (4) (the Skill endpoint is keyed identically to
    // the surface's node rule, so the edge always lands on a node that rule
    // mints). Each rule stamps only its own dispatch flag: edge ids hash
    // (src, type, dst) only, so all surfaces' sightings of one (session,
    // skill) pair collapse onto one edge and mergeRow's props-key union
    // combines the flags order-independently (a single enum would resolve
    // earliest-wins and drop "both" truth).
    // @ref LLP 0078#decision [implements]: dispatch_source as per-surface
    // boolean edge props, unioned by mergeRow.

    // Surface 1: model-chosen (`Skill` tool call).
    {
      kind: 'edge',
      type: 'ran',
      columns: ['session_id', 'tool_args', 'message_created_at'],
      where: { eq: { part_type: 'tool_call', tool_name: 'Skill' } },
      toRow(r) {
        const session = str(r.session_id)
        const skill = skillFromToolArgs(r.tool_args)
        if (!session || !skill) return null
        return buildEdge({ type: 'ran', srcType: 'Session', srcKey: session, dstType: 'Skill', dstKey: skill, props: { dispatch_tool: true }, firstSeen: r.message_created_at, sourceKeys: { session_id: session, tool_name: 'Skill', skill } })
      },
    },

    // Surface 2: SKILL.md injection marker (alone, it means prompt-driven or
    // otherwise ambiguous dispatch; every slash- or tool-dispatched skill also
    // injects this marker).
    {
      kind: 'edge',
      type: 'ran',
      // Raw SQL on purpose: the prefix filter prunes `content_text` (the
      // table's largest column) server-side, keeping it out of the shared
      // scan's materialization. `attributes` rides for the contract
      // rowFilter (registry-enforced).
      // @ref LLP 0096#decision [constrained-by]: heavy-column prefix guards stay pushed down
      sql: `SELECT attributes, session_id, content_text, message_created_at FROM ${SOURCE_DATASET} WHERE role = 'user' AND part_type = 'text' AND content_text LIKE 'Base directory for this skill: %'`,
      toRow(r) {
        const session = str(r.session_id)
        const skill = skillFromMarker(r.content_text)
        if (!session || !skill) return null
        return buildEdge({ type: 'ran', srcType: 'Session', srcKey: session, dstType: 'Skill', dstKey: skill, props: { dispatch_marker: true }, firstSeen: r.message_created_at, sourceKeys: { session_id: session, skill } })
      },
    },

    // Surface 3: user-typed slash command.
    {
      kind: 'edge',
      type: 'ran',
      // Raw SQL on purpose, same pushdown rationale as the marker surface.
      sql: `SELECT attributes, session_id, content_text, message_created_at FROM ${SOURCE_DATASET} WHERE role = 'user' AND part_type = 'text' AND content_text LIKE '<command-name>%'`,
      toRow(r) {
        const session = str(r.session_id)
        const skill = skillFromSlash(r.content_text)
        if (!session || !skill) return null
        return buildEdge({ type: 'ran', srcType: 'Session', srcKey: session, dstType: 'Skill', dstKey: skill, props: { dispatch_slash: true }, firstSeen: r.message_created_at, sourceKeys: { session_id: session, skill } })
      },
    },

    // Surface 4: Codex exec_command read of the SKILL.md (dispatch_shell_read,
    // the weaker inferred signal LLP 0075 keeps distinct from Claude's richer
    // ones). The Skill endpoint is keyed identically to the surface's node
    // rule, so the edge always lands on a node that rule mints.
    {
      kind: 'edge',
      type: 'ran',
      columns: ['session_id', 'tool_args', 'message_created_at'],
      where: { eq: { part_type: 'tool_call', tool_name: 'exec_command' } },
      toRow(r) {
        const session = str(r.session_id)
        const skill = skillFromCodexRead(commandStringFrom('exec_command', r.tool_args))
        if (!session || !skill) return null
        return buildEdge({ type: 'ran', srcType: 'Session', srcKey: session, dstType: 'Skill', dstKey: skill, props: { dispatch_shell_read: true }, firstSeen: r.message_created_at, sourceKeys: { session_id: session, tool_name: 'exec_command', skill } })
      },
    },
  ]

  return {
    name: 'ai-gateway-t0',
    plugin: PLUGIN_NAME,
    sourceDataset: SOURCE_DATASET,
    projector: PROJECTOR,
    projectorVersion: PROJECTOR_VERSION,
    rules,
    // @ref LLP 0026#decision [implements]: tag-don't-drop: the gateway
    // RETAINS Claude harness aux exchanges (security monitor, etc.) tagged
    // `attributes.claude.aux_kind` instead of dropping them. That traffic is
    // real but not user conversation, so it must not mint graph
    // Session/App/Model/Tool/File nodes or edges.
    // @ref LLP 0096#decision [implements]: the aux filter is a contract
    // rowFilter, evaluated once per source row by the engine (both paths),
    // instead of the old per-rule SQL prepend + toRow wrap that parsed
    // `attributes` once per rule per row.
    rowFilter: {
      columns: ['attributes'],
      /** @param {Record<string, unknown>} r */
      keep(r) {
        return auxKindOf(r.attributes) === null
      },
    },
  }
}

/**
 * Read `attributes.claude.aux_kind` from a source row. `attributes` is a
 * JSON column that may arrive parsed or as a string (like `tool_args`).
 *
 * @param {unknown} attributes
 * @returns {string | null}
 */
function auxKindOf(attributes) {
  const attrs = parseMaybeJson(attributes)
  if (!attrs || typeof attrs !== 'object') return null
  const claude = parseMaybeJson(/** @type {Record<string, unknown>} */ (attrs).claude)
  if (!claude || typeof claude !== 'object') return null
  return str(/** @type {Record<string, unknown>} */ (claude).aux_kind)
}

/**
 * Resolve a touched file's graph key + label + provenance. Prefers the bridge
 * key `owner/repo:relpath` (which converges with @hypaware/github AND across
 * worktrees of one repo, each worktree has its own root but the same relpath)
 * and falls back to the absolute path when the file can't be relativized
 * (outside the repo, a non-github remote, or a session with no captured repo).
 * The label is always the basename; `sourceKeys` records the absolute path for
 * provenance regardless of which key won. The File node rule and the touched
 * edge share this so the edge always lands on a node the node rule mints.
 *
 * @param {GraphKeys} keys
 * @param {unknown} toolName
 * @param {unknown} toolArgs
 * @param {unknown} gitRemote
 * @param {unknown} repoRoot
 * @returns {{ key: string, label: string, sourceKeys: Record<string, unknown> } | null}
 */
function fileTargetFrom(keys, toolName, toolArgs, gitRemote, repoRoot) {
  const file = filePathFrom(toolName, toolArgs)
  if (!file) return null
  const label = path.basename(file)
  const bridged = keys.fileKeyFromParts(gitRemote, repoRoot, file)
  if (bridged) {
    return { key: bridged, label, sourceKeys: { file_path: file, git_remote: str(gitRemote) } }
  }
  return { key: file, label, sourceKeys: { file_path: file } }
}

/**
 * Resolve a file path from a file-touching tool's args. `tool_args` is a JSON
 * column that may arrive parsed or as a string.
 *
 * @param {unknown} toolName
 * @param {unknown} toolArgs
 * @returns {string | null}
 */
function filePathFrom(toolName, toolArgs) {
  const name = str(toolName)
  if (!name || !FILE_TOOLS.has(name)) return null
  const args = parseMaybeJson(toolArgs)
  if (!args || typeof args !== 'object') return null
  const obj = /** @type {Record<string, unknown>} */ (args)
  return str(obj.file_path) ?? str(obj.notebook_path) ?? null
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function str(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/**
 * Drop null/undefined entries so identical inputs build identical props.
 *
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function pruned(obj) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] != null) out[key] = obj[key]
  }
  return out
}
