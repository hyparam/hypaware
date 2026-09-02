// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import {
  AI_GATEWAY_SCHEMA_COLUMNS,
  aiGatewayTablePath,
} from '../../plugins-workspace/ai-gateway/src/dataset.js'
import {
  requireGithubRuntime,
  setGithubRuntime,
} from '../../plugins-workspace/github/src/runtime.js'

/**
 * Hermetic proof that the bundled source discovers a repository from local
 * agent evidence, captures GitHub structure without network access, and
 * converges with the session graph after explicit projection.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0360#inventory [tests]: the default inventory is session evidence, not every repository visible to GitHub
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({
    commandRegistry: registry,
    cacheRoot: path.join(harness.stateDir, 'cache'),
  })
  const workspace = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  await step('activate', async () => {
    const { loaded } = await loadManifests([
      path.join(workspace, 'ai-gateway'),
      path.join(workspace, 'context-graph'),
      path.join(workspace, 'ai-gateway-graph'),
      path.join(workspace, 'github'),
    ])
    const byName = new Map(loaded.map((entry) => [entry.manifest.name, entry]))
    const order = [
      '@hypaware/ai-gateway',
      '@hypaware/context-graph',
      '@hypaware/ai-gateway-graph',
      '@hypaware/github',
    ]
    const entries = order.map((name) => {
      const entry = byName.get(name)
      if (!entry) throw new Error(`missing bundled manifest ${name}`)
      return { manifest: entry.manifest, rootDir: entry.rootDir, config: {} }
    })
    const activated = await activatePlugins({
      plugins: entries,
      stateRoot: harness.stateDir,
      runId: harness.devRunId,
      runtime: kernel,
      tmpRoot,
    })
    expect.that(
      'activation: all four bundled plugins activated',
      activated.results,
      (rows) => rows.length === 4 && rows.every((row) => row.ok)
    )
  })

  await step('seed_session_evidence', async () => {
    const tablePath = aiGatewayTablePath(kernel.storage)
    await kernel.storage.appendRows(
      tablePath,
      [...AI_GATEWAY_SCHEMA_COLUMNS],
      [sessionRow()]
    )
    await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })
  })

  // Keep the real observed-repository index and cache storage installed by
  // activate(), replacing only the network client with a deterministic fake.
  const activatedRuntime = requireGithubRuntime()
  setGithubRuntime({ ...activatedRuntime, clientFactory: () => fakeGithubClient() })

  await step('capture', async () => {
    const result = await dispatchText(['github', 'sync'], kernel, registry)
    expect.that('github sync: command exited 0', result.code, (value) => value === 0)
    expect.that('github sync: no stderr', result.stderr, (value) => value === '')
    expect.that(
      'github sync: one event from one session-observed repository',
      result.stdout,
      (value) => value.includes('1 event(s) across 1 repo(s)')
    )
  })

  await step('project', async () => {
    const result = await dispatchText(['graph', 'project'], kernel, registry)
    expect.that('graph project: command exited 0', result.code, (value) => value === 0)
    expect.that('graph project: no stderr', result.stderr, (value) => value === '')
  })

  const eventCount = await sqlCount(
    "select count(*) as n from github_events where repo = 'acme/widgets'",
    kernel,
    registry
  )
  expect.that('github_events: captured one issue row', eventCount, (value) => value === 1)

  const repoCount = await sqlCount(
    "select count(*) as n from node where node_type = 'Repo' and natural_key = 'acme/widgets'",
    kernel,
    registry
  )
  expect.that(
    'graph: session and GitHub contracts converge on one Repo node',
    repoCount,
    (value) => value === 1
  )

  const issueCount = await sqlCount(
    "select count(*) as n from node where node_type = 'Issue' and natural_key = 'acme/widgets#7'",
    kernel,
    registry
  )
  expect.that('graph: GitHub issue node was projected', issueCount, (value) => value === 1)

  await obs.shutdown()
  const traces = await expect.traces()
  expect.that(
    'telemetry: cache.append recorded the github_events write',
    traces,
    (rows) => rows.some((row) =>
      row.name === 'cache.append' &&
      row.attributes?.[Attr.DATASET] === 'github_events' &&
      row.attributes?.row_count === 1
    )
  )
  const logs = await expect.logs()
  expect.that(
    'telemetry: inventory resolution reports one selected repository without naming it',
    logs,
    (rows) => rows.some((row) =>
      row.body === 'github.inventory_resolved' &&
      row.attributes?.mode === 'session_repos' &&
      row.attributes?.selected_repos === 1
    )
  )

  /** @param {string} smokeStep @param {() => Promise<void>} fn */
  async function step(smokeStep, fn) {
    await runRoot(
      `smoke.step.${smokeStep}`,
      {
        [Attr.COMPONENT]: 'smoke',
        [Attr.OPERATION]: 'smoke.step',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: smokeStep,
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      fn
    )
  }
}

function fakeGithubClient() {
  return {
    async listViewerRepos() { throw new Error('session inventory must not enumerate GitHub') },
    async listIssues() {
      return [{
        number: 7,
        state: 'open',
        created_at: '2026-09-02T12:00:00.000Z',
        user: { login: 'octocat', type: 'User' },
      }]
    },
    async listPullRequests() { return [] },
    async listPullRequestFiles() { return [] },
    async listPullRequestReviews() { return [] },
    async listPullRequestCommits() { return [] },
    async listCommits() { return [] },
    async listCommitFiles() { return [] },
    async listIssueComments() { return [] },
  }
}

function sessionRow() {
  const ts = '2026-09-02T12:00:00.000Z'
  return {
    gateway_id: 'gw-github-smoke',
    schema_version: 1,
    session_id: 'github-smoke-session',
    conversation_id: 'github-smoke-session',
    provider: 'openai',
    model: 'gpt-5',
    client_name: 'codex',
    cwd: '/work/widgets',
    git_remote: 'git@github.com:Acme/Widgets.git',
    git_branch: 'main',
    head_sha: '0123456789abcdef0123456789abcdef01234567',
    repo_root: '/work/widgets',
    user_id: 'user-smoke',
    conversation_started_at: ts,
    message_created_at: ts,
    message_id: 'github-smoke-message',
    message_index: 0,
    role: 'user',
    part_type: 'text',
    part_index: 0,
    part_id: 'github-smoke-message#0',
    content_text: 'test fixture',
    date: '2026-09-02',
  }
}

async function sqlCount(sql, kernel, registry) {
  const result = await dispatchText(
    ['query', 'sql', sql, '--refresh', 'always', '--include-local-only', '--format', 'json'],
    kernel,
    registry
  )
  if (result.code !== 0 || result.stderr !== '') {
    throw new Error(`query failed: ${result.stderr || result.stdout}`)
  }
  const rows = JSON.parse(result.stdout)
  return Number(rows[0]?.n)
}

async function dispatchText(argv, kernel, registry) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(argv, {
    stdout,
    stderr,
    kernel,
    registry,
    env: { ...process.env, HYP_HOME: process.env.HYP_HOME },
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

function makeBuf() {
  const chunks = []
  return {
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() { return chunks.join('') },
  }
}
