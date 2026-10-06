// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import {
  DESKTOP_3P_SWEPT_SESSIONS_MAX,
  claudeDesktop3pSessionRoots,
  createDesktop3pDirsCache,
  findDesktop3pProjectsDirs,
  loadAgentMeta,
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
 * First-party layout observed on Desktop app 1.40609.1. The sandbox id
 * varies so a test can stage the home a later conversation adds.
 */
function firstPartySandboxProjectsDir(homeDir, sandboxId = 'ghi789') {
  return path.join(
    homeDir, 'Library', 'Application Support', 'Claude',
    'local-agent-mode-sessions', '99990000', '00000000', `local_${sandboxId}`,
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

test('findDesktop3pProjectsDirs discovers nested .claude/projects under all Desktop layouts', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-discover-'))
  try {
    const sibling = siblingSandboxProjectsDir(homeDir)
    const nested = nestedSandboxProjectsDir(homeDir)
    const firstParty = firstPartySandboxProjectsDir(homeDir)
    await fs.mkdir(sibling, { recursive: true })
    await fs.mkdir(nested, { recursive: true })
    await fs.mkdir(firstParty, { recursive: true })
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
      [path.dirname(sibling), path.dirname(nested), path.dirname(firstParty)].sort()
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

test('backfill imports a first-party sandbox session and attributes it to the configured Desktop owner', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-backfill-'))
  try {
    const filePath = await writeTranscriptAt(
      firstPartySandboxProjectsDir(homeDir), 'sess-1p', desktop3pRows('sess-1p')
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
    assert.equal(items[0]?.provenance?.native_id, 'sess-1p')
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
    // no plugin claims (the observed drift, 'local-agent' to 'local-agent-v2'),
    // and one under the current first-party Desktop root.
    const noEntrypoint = desktop3pRows('sess-noep').map(({ entrypoint, ...rest }) => rest)
    const drifted = desktop3pRows('sess-drift').map((r) => ({ ...r, entrypoint: 'local-agent-v2' }))
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-noep', noEntrypoint)
    await writeTranscriptAt(nestedSandboxProjectsDir(homeDir), 'sess-drift', drifted)
    await writeTranscriptAt(
      firstPartySandboxProjectsDir(homeDir), 'sess-1p', desktop3pRows('sess-1p')
    )
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
    assert.equal(gated.length, 3, 'all sessions are gated, whatever their tag or root layout')
    assert.ok(gated.every((e) => e.owner_plugin === '@hypaware/claude-desktop'))
    const complete = entries.find((e) => e.message === 'claude.backfill.scan_complete')
    assert.equal(complete?.sessions_gated, 3)
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

    // A forced re-sweep for a session none of the cached dirs held, and any
    // get after the TTL, sweep fresh.
    const refreshed = cache.refreshFor(homeDir, 'sess-missing', true)
    assert.deepEqual([...refreshed ?? []].sort(), [path.dirname(sibling), path.dirname(nested)].sort())
    nowMs = 2000
    assert.equal(cache.get(homeDir).cached, false)

    // The forced sweep is spent per session per container list, so a home
    // landing after its own session was memoised is not found at once. Both
    // routes back are what bound that wait, and neither was pinned: another
    // session's sweep sees the list change and drops the memo, and failing
    // that the TTL re-sweeps. Without one of them a memoised session would
    // never upgrade. `true` throughout is the `cached` a `get()` at this
    // instant hands back: the sweep at 2000 is inside the TTL.
    nowMs = 2001
    assert.equal(cache.refreshFor(homeDir, 'sess-missing', true)?.length, 2)
    assert.equal(cache.refreshFor(homeDir, 'sess-missing', true), null, 'the established miss is spent')
    await fs.mkdir(firstPartySandboxProjectsDir(homeDir, 'late0000'), { recursive: true })
    assert.equal(cache.refreshFor(homeDir, 'sess-missing', true), null, 'and stays spent against that list')
    assert.equal(cache.refreshFor(homeDir, 'sess-other', true)?.length, 3, 'another session still sees the new home')
    assert.equal(cache.refreshFor(homeDir, 'sess-missing', true)?.length, 3, 'whose sweep re-arms the memoised one')

    // With no other session to force a sweep, the TTL is the backstop.
    await fs.mkdir(firstPartySandboxProjectsDir(homeDir, 'late0001'), { recursive: true })
    assert.equal(cache.refreshFor(homeDir, 'sess-missing', true), null)
    nowMs = 4000
    assert.equal(cache.get(homeDir).dirs.length, 4, 'the TTL finds the late home unaided')
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

/**
 * Count the container discoveries a body performs. Every
 * `findDesktop3pProjectsDirs` sweep reads each of the three session roots
 * exactly once, so a readdir of a path named for a root is the sweep's
 * signature, whether or not that root exists.
 *
 * @template T
 * @param {() => Promise<T>} body
 * @returns {Promise<{ result: T, sweeps: number }>}
 */
async function countSweeps(body) {
  const real = fsSync.readdirSync
  let rootReads = 0
  // @ts-expect-error instrumented for the duration of the body
  fsSync.readdirSync = (dir, opts) => {
    if (String(dir).endsWith('local-agent-mode-sessions')) rootReads += 1
    return real(dir, opts)
  }
  try {
    const result = await body()
    return { result, sweeps: rootReads / claudeDesktop3pSessionRoots('/x').length }
  } finally {
    fsSync.readdirSync = real
  }
}

// Issue #1758. A session that will never match (SDK/headless traffic with no
// transcript, a harness aux exchange, a wire-only reminder) misses inside the
// cached root list, and the forced re-sweep re-stamped the cache's `atMs`, so
// the miss never settled into the TTL: every settle pass re-walked the whole
// container, and twice per exchange once `loadAgentMeta` grew the same leg.
// One sweep per session per container list is the bound, and a sandbox home
// that appears after the list was cached is still found on the settle that
// asks for it.
test('a never-matching session sweeps the container once, not once per settle', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-resweep-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-a', desktop3pRows('sess-a'))
    await writeTranscriptAt(nestedSandboxProjectsDir(homeDir), 'sess-b', desktop3pRows('sess-b'))
    await writeTranscriptAt(firstPartySandboxProjectsDir(homeDir), 'sess-c', desktop3pRows('sess-c'))

    // What one settle pass of an exchange does: both loaders resolve the same
    // session, each through the shared root cache.
    const settle = async (/** @type {string} */ sessionId) => {
      const entries = await loadTranscript({ projectsDir, sessionId, homeDir })
      const meta = loadAgentMeta({
        transcriptPath: path.join(homeDir, 'unresolvable', `${sessionId}.jsonl`),
        projectsDir,
        sessionId,
        homeDir,
      })
      return { entries, meta }
    }

    // Primes the module-level root cache for this home.
    assert.equal((await loadTranscript({ projectsDir, sessionId: 'sess-a', homeDir })).length, 2)

    const first = await countSweeps(() => settle('sess-never'))
    const second = await countSweeps(() => settle('sess-never'))
    assert.equal(first.result.entries.length, 0)
    assert.equal(second.result.entries.length, 0)
    assert.ok(
      first.sweeps + second.sweeps <= 1,
      `two settles of one never-matching session force at most one container sweep, got ${first.sweeps + second.sweeps}`
    )
    assert.equal(second.sweeps, 0, 'the established miss costs no sweep at all')

    // A new conversation starts: its sandbox home appears after the cached
    // list was swept, and it is still found and upgraded, transcript and
    // sidecar both. The memo is per session, not a container-wide stop.
    const lateDir = firstPartySandboxProjectsDir(homeDir, 'late0000')
    await writeTranscriptAt(lateDir, 'sess-late', desktop3pRows('sess-late'))
    await fs.mkdir(path.join(lateDir, 'sess-late', 'subagents'), { recursive: true })
    await fs.writeFile(
      path.join(lateDir, 'sess-late', 'subagents', 'agent-sa1.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_late' }),
      'utf8'
    )
    const late = await countSweeps(() => settle('sess-late'))
    assert.equal(late.result.entries.length, 2, 'the new sandbox home is found')
    assert.equal(late.result.meta.get('sa1')?.tool_use_id, 'toolu_late', 'and its sidecar with it')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// Issue #1795. Both loaders take the 3p leg in one settle pass, and the leg
// is gated on the root list having been served from cache. A `get()` that
// has to sweep (a cold home, or one whose TTL just rolled over) therefore
// settled no miss: nothing remembered that this session had already been
// walked for, so the second loader forced a walk of the identical container.
// The walk a session's own `get()` made is the walk it spends.
test('a never-matching session spends the walk its own get() made, not a second one', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-cold-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-a', desktop3pRows('sess-a'))
    await writeTranscriptAt(nestedSandboxProjectsDir(homeDir), 'sess-b', desktop3pRows('sess-b'))
    await writeTranscriptAt(firstPartySandboxProjectsDir(homeDir), 'sess-c', desktop3pRows('sess-c'))

    // One settle pass of an exchange, unprimed: the container has never been
    // swept for this home, so the first loader's `get()` sweeps it.
    const settle = async (/** @type {string} */ sessionId) => {
      const entries = await loadTranscript({ projectsDir, sessionId, homeDir })
      const meta = loadAgentMeta({
        transcriptPath: path.join(homeDir, 'unresolvable', `${sessionId}.jsonl`),
        projectsDir,
        sessionId,
        homeDir,
      })
      return { entries, meta }
    }

    const first = await countSweeps(() => settle('sess-never'))
    assert.equal(first.result.entries.length, 0)
    assert.equal(first.sweeps, 1, 'the two loaders of one settle pass walk the container once')
    const second = await countSweeps(() => settle('sess-never'))
    assert.equal(second.sweeps, 0, 'and the established miss still costs no walk at all')

    // The walk remains one per session, not a container-wide stop: a home
    // that appears after that list was swept is still found.
    const lateDir = firstPartySandboxProjectsDir(homeDir, 'late1795')
    await writeTranscriptAt(lateDir, 'sess-late', desktop3pRows('sess-late'))
    const late = await countSweeps(() => settle('sess-late'))
    assert.equal(late.result.entries.length, 2, 'the new sandbox home is found')
    assert.equal(late.sweeps, 1, 'by one walk: the loader that found it does not walk again, nor does the one after')

    // A session found inside the list costs nothing at all: it is the miss
    // that buys a walk, and `loadAgentMeta` has located it whether or not
    // the session has written a sidecar yet (it has not here).
    const settled = await countSweeps(() => settle('sess-late'))
    assert.equal(settled.result.entries.length, 2)
    assert.equal(settled.result.meta.size, 0)
    assert.equal(settled.sweeps, 0, 'a located session walks nothing')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// The same defect at the TTL rollover the issue names, where the sweeping
// `get()` is a re-sweep rather than a cold one. Real time cannot be wound
// forward through the module-level cache the loaders share, so this replays
// their leg against an injectable clock: each loader asks `get()` for the
// roots, misses inside them, and hands `refreshFor` the `cached` it got.
test('a settle exactly at the TTL rollover walks the container once, not twice', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-rollover-'))
  try {
    await fs.mkdir(siblingSandboxProjectsDir(homeDir), { recursive: true })
    let nowMs = 0
    const cache = createDesktop3pDirsCache({ ttlMs: 1000, now: () => nowMs })
    /** @type {boolean[]} */
    let served = []
    /** One loader's leg: resolve the roots, miss inside them, settle the miss. */
    const loaderLeg = (/** @type {string} */ sessionId) => {
      const { cached } = cache.get(homeDir)
      served.push(cached)
      return cache.refreshFor(homeDir, sessionId, cached)
    }
    const settle = (/** @type {string} */ sessionId) => {
      served = []
      return countSweeps(async () => {
        loaderLeg(sessionId)
        loaderLeg(sessionId)
      })
    }

    cache.get(homeDir)
    nowMs = 500
    assert.equal(cache.get(homeDir).cached, true)
    nowMs = 1000
    const rollover = await settle('sess-never')
    // `atMs` is stamped by the sweep alone, so the hit served at 500 left the
    // expiry where it was and this pass opens on it.
    assert.deepEqual(served, [false, true], 'the pass opens expired, and the second loader is served that sweep')
    assert.equal(rollover.sweeps, 1, 'the rollover walk settles the pass; the second loader repeats nothing')

    // Inside the new TTL that miss is spent, and a session that never missed
    // still buys the walk that finds a home added since. That walk finds the
    // container moving, which settles no miss by the standing rule, so this
    // pass makes the second one too: the walk that observes a settled
    // container is the one the session spends.
    nowMs = 1001
    assert.equal((await settle('sess-never')).sweeps, 0, 'the established miss costs no walk')
    await fs.mkdir(firstPartySandboxProjectsDir(homeDir, 'late1795'), { recursive: true })
    const other = await settle('sess-other')
    assert.equal(other.sweeps, 2, 'a walk that found the container moving settles no miss')
    assert.equal(cache.get(homeDir).dirs.length, 2, 'and the home added since is in the list')
    assert.equal((await settle('sess-other')).sweeps, 0, 'the settled miss is spent')

    // The same rule holds when it is the rollover walk that finds the
    // container moving: it settles no miss either, so the session keeps the
    // walk, and the second loader's is the one that observes a settled
    // container and spends it.
    nowMs = 2001
    await fs.mkdir(firstPartySandboxProjectsDir(homeDir, 'later1795'), { recursive: true })
    const moving = await settle('sess-moving')
    assert.deepEqual(served, [false, true])
    assert.equal(moving.sweeps, 2, 'a rollover walk that found the container moving settles no miss')
    assert.equal((await settle('sess-moving')).sweeps, 0, 'which the settled walk then spends')

    // Both arms write the same capped memo, so a daemon seeing an unbounded
    // stream of never-matching sessions cannot grow it with uptime: oldest
    // out first, and an evicted session costs one walk, never a wrong answer.
    for (let i = 0; i < 1100; i++) cache.refreshFor(homeDir, `sess-${i}`, false)
    assert.equal(cache.refreshFor(homeDir, 'sess-1099', true), null, 'the newest miss is remembered')
    assert.ok(cache.refreshFor(homeDir, 'sess-0', true), 'the oldest was evicted and walks again')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// Each loader settles its own pass: `loadAgentMeta` hands `refreshFor` the
// verdict of its own `get()`, not the other loader's, so a pass that reaches
// it with the container unswept still costs one walk rather than two.
test('loadAgentMeta alone spends the walk its own get() made', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-meta-cold-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await writeTranscriptAt(siblingSandboxProjectsDir(homeDir), 'sess-a', desktop3pRows('sess-a'))
    await writeTranscriptAt(firstPartySandboxProjectsDir(homeDir), 'sess-c', desktop3pRows('sess-c'))

    const meta = await countSweeps(async () => loadAgentMeta({
      transcriptPath: path.join(homeDir, 'unresolvable', 'sess-never.jsonl'),
      projectsDir,
      sessionId: 'sess-never',
      homeDir,
    }))
    assert.equal(meta.result.size, 0)
    assert.equal(meta.sweeps, 1, 'the walk its get() made is the walk it spends')

    // Spending it means settling the miss, which is what this loader gating
    // on its own `cached` alone would skip: the next pass inside the TTL is
    // served that same list and must not walk the container over again.
    const again = await countSweeps(async () => loadAgentMeta({
      transcriptPath: path.join(homeDir, 'unresolvable', 'sess-never.jsonl'),
      projectsDir,
      sessionId: 'sess-never',
      homeDir,
    }))
    assert.equal(again.result.size, 0)
    assert.equal(again.sweeps, 0, 'and the settled miss keeps the next pass free')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// The `!cached` arm reaches `remember` for every session a TTL rollover
// re-settles, and the memo already holds those sessions. At the cap, an
// unguarded re-add deleted the oldest peer first and then added a member
// already present, so one innocent session lost its slot (and one walk)
// per rollover. The invariant: remembering a session the memo already
// holds changes nothing. Built on a fresh cache filled to exactly the cap
// through the arm under test, so the oldest member is `sess-0` by
// construction and no assertion depends on a boundary survivor index.
test('re-remembering a memoised session at the cap evicts no peer', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-3p-cap-'))
  try {
    await fs.mkdir(siblingSandboxProjectsDir(homeDir), { recursive: true })
    const cache = createDesktop3pDirsCache({ ttlMs: 1000, now: () => 0 })
    cache.get(homeDir)
    for (let i = 0; i < DESKTOP_3P_SWEPT_SESSIONS_MAX; i++) cache.refreshFor(homeDir, `sess-${i}`, false)
    assert.equal(cache.refreshFor(homeDir, 'sess-0', true), null, 'the memo sits exactly at the cap with the oldest still held')

    // A rollover re-settles a session the memo already holds.
    cache.refreshFor(homeDir, 'sess-512', false)
    assert.equal(cache.refreshFor(homeDir, 'sess-0', true), null, 'a present member re-added costs no peer its slot')

    // A genuinely new session at the cap still takes the oldest slot, so
    // the guard did not unbound the memo or reorder eviction.
    cache.refreshFor(homeDir, 'sess-new', false)
    assert.ok(cache.refreshFor(homeDir, 'sess-0', true), 'a genuinely new session evicts oldest-first as before')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})
