// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import {
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
      ['local-agent', { client: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: true }],
    ])
    const { ctx } = runContext({ entrypointOwners: owners })

    const items = await collectItems(provider.run(ctx))

    assert.equal(items.length, 1)
    assert.equal(items[0]?.provenance?.client_name, 'claude-desktop')
    assert.equal(items[0]?.provenance?.source_path, filePath)
    assert.equal(items[0]?.provenance?.native_id, 'sess-3p')
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
      ['local-agent', { client: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: false }],
    ])
    const { ctx, entries } = runContext({ entrypointOwners: owners })

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
