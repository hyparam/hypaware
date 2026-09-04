// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, installObservability } from '../../../src/core/observability/index.js'
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
import {
  dispatchText,
  fakeGithubClient,
  githubSessionRow,
  makeStep,
  noWithheldRepo,
  sqlCount,
} from '../lib/github_fixture.js'

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
  const step = makeStep(harness)
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({
    commandRegistry: registry,
    cacheRoot: path.join(harness.stateDir, 'cache'),
  })
  const lifetime = { kernel, registry }
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
      [githubSessionRow({
        gatewayId: 'gw-github-smoke',
        id: 'github-smoke-session',
        cwd: '/work/widgets',
        remote: 'git@github.com:Acme/Widgets.git',
      })]
    )
    await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })
  })

  // Keep the real observed-repository index and cache storage installed by
  // activate(), replacing only the network client with a deterministic fake.
  // Every session this half seeds is export-eligible, so it has no repository
  // to refuse at the seam; the sibling `github_local_only_withhold` owns that.
  const activatedRuntime = requireGithubRuntime()
  setGithubRuntime({ ...activatedRuntime, clientFactory: () => fakeGithubClient({ assertRepo: noWithheldRepo }) })

  await step('capture', async () => {
    const result = await dispatchText(['github', 'sync'], lifetime)
    expect.that('github sync: command exited 0', result.code, (value) => value === 0)
    expect.that('github sync: no stderr', result.stderr, (value) => value === '')
    expect.that(
      'github sync: one event from one session-observed repository',
      result.stdout,
      (value) => value.includes('1 event(s) across 1 repo(s)')
    )
  })

  await step('project', async () => {
    const result = await dispatchText(['graph', 'project'], lifetime)
    expect.that('graph project: command exited 0', result.code, (value) => value === 0)
    expect.that('graph project: no stderr', result.stderr, (value) => value === '')
  })

  const eventCount = await sqlCount(
    "select count(*) as n from github_events where repo = 'acme/widgets'",
    lifetime
  )
  expect.that('github_events: captured one issue row', eventCount, (value) => value === 1)

  const repoCount = await sqlCount(
    "select count(*) as n from node where node_type = 'Repo' and natural_key = 'acme/widgets'",
    lifetime
  )
  expect.that(
    'graph: session and GitHub contracts converge on one Repo node',
    repoCount,
    (value) => value === 1
  )

  const issueCount = await sqlCount(
    "select count(*) as n from node where node_type = 'Issue' and natural_key = 'acme/widgets#7'",
    lifetime
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
  expect.that(
    'telemetry: bounded capture reports request use and no remaining work',
    logs,
    (rows) => rows.some((row) =>
      row.body === 'github.capture_tick_completed' &&
      row.attributes?.mode === 'poll' &&
      row.attributes?.requests === 4 &&
      row.attributes?.pending === false
    )
  )
}
