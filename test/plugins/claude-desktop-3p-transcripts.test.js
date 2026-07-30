// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import {
  createDesktop3pDirsCache,
  findDesktop3pProjectsDirs,
  loadTranscript,
} from '../../hypaware-core/plugins-workspace/claude/src/transcripts.js'

/**
 * Attached Claude Desktop (managed 3p profile) does not write into the
 * shared `~/.claude/projects`: it runs each conversation's embedded CLI
 * in a per-session sandbox home inside its `Claude-3p` container, so the
 * transcript lands in a `.claude/projects` tree nested there, tagged
 * `entrypoint: "local-agent"` (LLP 0133#attribution). These tests pin
 * the discovery of those trees and the two consumers: `loadTranscript`'s
 * live fallback and the backfill scan.
 *
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

/** Sibling-container layout observed on Desktop app 1.13576.0 / CLI 2.1.177. */
function siblingSandboxProjectsDir(homeDir) {
  return path.join(
    homeDir, 'Library', 'Application Support', 'Claude-3p',
    'local-agent-mode-sessions', '423c4275', '00000000', 'local_abc123',
    '.claude', 'projects', 'sandbox-outputs'
  )
}

/** Nested-container layout from LLP 0133's first live test. */
function nestedSandboxProjectsDir(homeDir) {
  return path.join(
    homeDir, 'Library', 'Application Support', 'Claude', 'Claude-3p',
    'local-agent-mode-sessions', '11112222', '00000000', 'local_def456',
    '.claude', 'projects', 'sandbox-outputs'
  )
}

/**
 * @param {string} dir
 * @param {string} sessionId
 * @param {Record<string, unknown>[]} rows
 */
async function writeTranscriptAt(dir, sessionId, rows) {
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  await fs.writeFile(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return filePath
}

/**
 * Minimal Desktop 3p session: a user turn and an assistant turn, every
 * line tagged with the entrypoint the current Desktop build writes.
 *
 * @param {string} sessionId
 */
function desktop3pRows(sessionId) {
  return [
    {
      sessionId,
      uuid: 'u-user-1',
      parentUuid: null,
      type: 'user',
      userType: 'external',
      entrypoint: 'local-agent',
      version: '2.1.177',
      message: { role: 'user', content: 'What is the distance from Honolulu to Houston?' },
      timestamp: '2026-07-29T23:05:00.000Z',
    },
    {
      sessionId,
      uuid: 'u-asst-1',
      parentUuid: 'u-user-1',
      type: 'assistant',
      userType: 'external',
      entrypoint: 'local-agent',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'About 3,900 miles.' }],
      },
      timestamp: '2026-07-29T23:05:02.000Z',
    },
  ]
}

function runContext(overrides = {}) {
  /** @type {Record<string, unknown>[]} */
  const entries = []
  /** @type {BackfillRunContext} */
  const ctx = /** @type {any} */ ({
    env: {},
    cacheRoot: path.join(os.tmpdir(), 'claude-3p-cache-unused'),
    dryRun: false,
    log: {
      info: (m, f) => entries.push({ level: 'info', message: m, ...f }),
      warn: (m, f) => entries.push({ level: 'warn', message: m, ...f }),
    },
    storage: {},
    ...(overrides.entrypointOwners ? { entrypointOwners: overrides.entrypointOwners } : {}),
    ...(overrides.isPluginConfigured ? { isPluginConfigured: overrides.isPluginConfigured } : {}),
  })
  return { ctx, entries }
}

/**
 * @param {AsyncIterable<BackfillItem | BackfillEvent>} iterable
 */
async function collectItems(iterable) {
  /** @type {BackfillItem[]} */
  const items = []
  for await (const yielded of iterable) {
    if (yielded.type !== 'event') items.push(/** @type {BackfillItem} */ (yielded))
  }
  return items
}

test('findDesktop3pProjectsDirs discovers nested .claude/projects under both container layouts', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-discover-'))
  try {
    const sibling = siblingSandboxProjectsDir(homeDir)
    const nested = nestedSandboxProjectsDir(homeDir)
    await fs.mkdir(sibling, { recursive: true })
    await fs.mkdir(nested, { recursive: true })
    // Decoys: a jsonl outside any .claude/projects (the sandbox's
    // audit.jsonl) must not create a discovered root.
    await fs.writeFile(
      path.join(sibling, '..', '..', '..', 'audit.jsonl'),
      '{"event":"noise"}\n',
      'utf8'
    )

    const found = findDesktop3pProjectsDirs(homeDir)

    // The discovered roots are the `.claude/projects` dirs themselves
    // (one level above the per-project subdir the transcript sits in).
    assert.deepEqual(
      found.sort(),
      [path.dirname(sibling), path.dirname(nested)].sort()
    )
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('findDesktop3pProjectsDirs is empty when no 3p container exists', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-none-'))
  try {
    assert.deepEqual(findDesktop3pProjectsDirs(homeDir), [])
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('loadTranscript falls back to the 3p sandbox tree when the shared tree misses', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-load-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-3p', desktop3pRows('sess-3p'))

    const entries = await loadTranscript({ projectsDir, sessionId: 'sess-3p', homeDir })

    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.entrypoint, 'local-agent')

    // Without homeDir the fallback is off and the primary miss stays a miss.
    const withoutHome = await loadTranscript({ projectsDir, sessionId: 'sess-3p' })
    assert.equal(withoutHome.length, 0)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('loadTranscript does not scan the 3p tree when the shared tree matches', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-primary-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    const primaryRows = desktop3pRows('sess-x').map((r) => ({ ...r, entrypoint: 'cli' }))
    await writeTranscriptAt(path.join(projectsDir, 'repo-a'), 'sess-x', primaryRows)
    // Same session id in the 3p tree: if the fallback ran anyway, the
    // entries would double up.
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-x', desktop3pRows('sess-x'))

    const entries = await loadTranscript({ projectsDir, sessionId: 'sess-x', homeDir })

    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.entrypoint, 'cli')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('backfill imports a 3p sandbox session and attributes it to the configured owner', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-backfill-'))
  try {
    const filePath = await writeTranscriptAt(
      siblingSandboxProjectsDir(homeDir), 'sess-3p', desktop3pRows('sess-3p')
    )
    const provider = createClaudeBackfillProvider({
      homeDir,
      stateFile: path.join(homeDir, 'sc.jsonl'),
    })
    const owners = new Map([
      ['claude-desktop', { client: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: true }],
    ])
    const { ctx } = runContext({
      entrypointOwners: owners,
      isPluginConfigured: (p) => p === '@hypaware/claude-desktop',
    })

    const items = await collectItems(provider.run(ctx))

    assert.equal(items.length, 1)
    assert.equal(items[0]?.provenance?.client_name, 'claude-desktop')
    assert.equal(items[0]?.provenance?.source_path, filePath)
    assert.equal(items[0]?.provenance?.native_id, 'sess-3p')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// The blocking review finding on c01ef0e: admission was decided on the
// entrypoint VALUE, which fails open when absent or unclaimed, so a machine
// that never configured Desktop imported Desktop's private container as
// Claude Code. Ownership now derives from the root, so the tag decides
// nothing.
// @ref LLP 0140#container-root-owns [tests]: 3p sessions with absent or drifted entrypoints gate off while Desktop is unconfigured
test('backfill gates 3p sessions with absent or unclaimed entrypoints when Desktop is unconfigured', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-failopen-'))
  try {
    // One session whose lines never carry the field, one tagged with a value
    // no plugin claims (the observed drift, 'local-agent' to 'local-agent-v2').
    const noEntrypoint = desktop3pRows('sess-noep').map(({ entrypoint, ...rest }) => rest)
    const drifted = desktop3pRows('sess-drift').map((r) => ({ ...r, entrypoint: 'local-agent-v2' }))
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-noep', noEntrypoint)
    await writeTranscriptAt(nestedSandboxProjectsDir(homeDir), 'sess-drift', drifted)
    const provider = createClaudeBackfillProvider({
      homeDir,
      stateFile: path.join(homeDir, 'sc.jsonl'),
    })
    // The owners map and predicate a default install builds: claude
    // configured, Desktop installed but not configured. Neither claims
    // 'local-agent-v2'.
    const owners = new Map([
      ['cli', { client: 'claude', plugin: '@hypaware/claude', configured: true }],
      ['claude-desktop', { client: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: false }],
    ])
    const { ctx, entries } = runContext({
      entrypointOwners: owners,
      isPluginConfigured: (p) => p === '@hypaware/claude',
    })

    const items = await collectItems(provider.run(ctx))

    assert.equal(items.length, 0, 'nothing from the container is imported')
    const gated = entries.filter((e) => e.message === 'claude.backfill.entrypoint_not_configured')
    assert.equal(gated.length, 2, 'both sessions are gated, whatever their tag')
    assert.ok(gated.every((e) => e.owner_plugin === '@hypaware/claude-desktop'))
    const complete = entries.find((e) => e.message === 'claude.backfill.scan_complete')
    assert.equal(complete?.sessions_gated, 2)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// An absent owners map and predicate degrade toward master for each root
// kind: import everything in the scanning client's own tree, and read
// nothing from the container master never read.
test('backfill gates 3p sessions when no owners map or predicate is supplied at all', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-nomap-'))
  try {
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-3p', desktop3pRows('sess-3p'))
    const provider = createClaudeBackfillProvider({
      homeDir,
      stateFile: path.join(homeDir, 'sc.jsonl'),
    })
    const { ctx } = runContext()

    const items = await collectItems(provider.run(ctx))

    assert.equal(items.length, 0)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// Container admission keys on the runner's plugin-list predicate alone:
// the owners map only has entries for plugins that declare
// `transcript_entrypoints` values, and Desktop's remaining value claims are
// vestigial for its container, so dropping them one day must not silently
// switch off Desktop's own backfill.
// @ref LLP 0140#container-root-owns [tests]: a configured Desktop declaring no entrypoint values still imports its container
test('backfill imports the container for a configured Desktop that declares no entrypoint values', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-novalues-'))
  try {
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-3p', desktop3pRows('sess-3p'))
    const provider = createClaudeBackfillProvider({
      homeDir,
      stateFile: path.join(homeDir, 'sc.jsonl'),
    })
    // No claude-desktop entry anywhere in the owners map, but the plugin is
    // in the effective config.
    const owners = new Map([
      ['cli', { client: 'claude', plugin: '@hypaware/claude', configured: true }],
    ])
    const configured = new Set(['@hypaware/claude', '@hypaware/claude-desktop'])
    const { ctx } = runContext({
      entrypointOwners: owners,
      isPluginConfigured: (p) => configured.has(p),
    })

    const items = await collectItems(provider.run(ctx))

    assert.equal(items.length, 1)
    assert.equal(items[0]?.provenance?.client_name, 'claude-desktop')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// A container session's subagent rows carry the same
// `spawned_by_tool_use_id` provenance as every other backfilled session:
// the agent-meta sidecars live inside the sandbox trees, so the primary-
// tree-only scan found none of them.
test('backfill stamps subagent provenance from sidecars inside the 3p container', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-agentmeta-'))
  try {
    const projectsDir = siblingSandboxProjectsDir(homeDir)
    const rows = [
      ...desktop3pRows('sess-3p'),
      {
        sessionId: 'sess-3p',
        uuid: 'u-agent-1',
        parentUuid: null,
        type: 'assistant',
        agentId: 'ag1',
        isSidechain: true,
        entrypoint: 'local-agent',
        message: { role: 'assistant', content: [{ type: 'text', text: 'subagent says hi' }] },
        timestamp: '2026-07-29T23:05:03.000Z',
      },
    ]
    await writeTranscriptAt(projectsDir, 'sess-3p', rows)
    const sidecarDir = path.join(projectsDir, 'sess-3p', 'subagents')
    await fs.mkdir(sidecarDir, { recursive: true })
    await fs.writeFile(
      path.join(sidecarDir, 'agent-ag1.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_spawn_1' }),
      'utf8'
    )
    const provider = createClaudeBackfillProvider({
      homeDir,
      stateFile: path.join(homeDir, 'sc.jsonl'),
    })
    const { ctx } = runContext({
      entrypointOwners: new Map(),
      isPluginConfigured: (p) => p === '@hypaware/claude-desktop',
    })

    const items = await collectItems(provider.run(ctx))

    assert.equal(items.length, 1)
    const messages = /** @type {any} */ (items[0]?.value)?.messages ?? []
    const subagentRow = messages.find((m) => m.agent_id === 'ag1')
    assert.ok(subagentRow, 'subagent line is projected')
    assert.equal(subagentRow.attributes?.claude?.spawned_by_tool_use_id, 'toolu_spawn_1')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('backfill gates a 3p sandbox session when its owner is not configured', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-gated-'))
  try {
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-3p', desktop3pRows('sess-3p'))
    const provider = createClaudeBackfillProvider({
      homeDir,
      stateFile: path.join(homeDir, 'sc.jsonl'),
    })
    const owners = new Map([
      ['claude-desktop', { client: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: false }],
    ])
    const { ctx, entries } = runContext({
      entrypointOwners: owners,
      isPluginConfigured: () => false,
    })

    const items = await collectItems(provider.run(ctx))

    assert.equal(items.length, 0)
    assert.ok(
      entries.some((e) => e.message === 'claude.backfill.entrypoint_not_configured'),
      'gate decision is logged'
    )
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// The live projector resolves the 3p roots on every primary-tree miss, and
// for an attached Desktop every exchange is a primary miss, so uncached
// discovery re-swept a container that grows with every conversation.
test('createDesktop3pDirsCache serves cached roots within the TTL and re-sweeps after it', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-cache-'))
  try {
    const sibling = siblingSandboxProjectsDir(homeDir)
    await fs.mkdir(sibling, { recursive: true })
    let nowMs = 0
    const cache = createDesktop3pDirsCache({ ttlMs: 1000, now: () => nowMs })

    const first = cache.get(homeDir)
    assert.equal(first.cached, false)
    assert.deepEqual(first.dirs, [path.dirname(sibling)])

    // A second sandbox appears; within the TTL the stale list is served.
    const nested = nestedSandboxProjectsDir(homeDir)
    await fs.mkdir(nested, { recursive: true })
    nowMs = 999
    const second = cache.get(homeDir)
    assert.equal(second.cached, true)
    assert.deepEqual(second.dirs, [path.dirname(sibling)])

    // A forced refresh, and any get after the TTL, sweep fresh.
    const refreshed = cache.get(homeDir, { refresh: true })
    assert.equal(refreshed.cached, false)
    assert.deepEqual(refreshed.dirs.sort(), [path.dirname(sibling), path.dirname(nested)].sort())
    nowMs = 2000
    assert.equal(cache.get(homeDir).cached, false)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// The cache must stay invisible to correctness: a sandbox home created
// after the cached sweep (a brand-new Desktop session) is still found,
// because a miss inside the cached list forces one fresh re-sweep.
test('loadTranscript finds a sandbox home created after the root cache was primed', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-fresh-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-a', desktop3pRows('sess-a'))

    // Primes the module-level cache with only the sibling sandbox.
    const first = await loadTranscript({ projectsDir, sessionId: 'sess-a', homeDir })
    assert.equal(first.length, 2)

    // A new conversation starts: a new sandbox home appears.
    await writeTranscriptAt(nestedSandboxProjectsDir(homeDir), 'sess-b', desktop3pRows('sess-b'))
    const second = await loadTranscript({ projectsDir, sessionId: 'sess-b', homeDir })
    assert.equal(second.length, 2, 'refresh-on-miss finds the new sandbox home')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})
