// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, installObservability } from '../../../src/core/observability/index.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { runInitWizard } from '../../../src/core/cli/wizard/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { loginGithub, logoutGithub } from '../../plugins-workspace/github/src/auth.js'
import { createGithubClient } from '../../plugins-workspace/github/src/github_client.js'
import { readCursors } from '../../plugins-workspace/github/src/cursors.js'
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
 * projects it automatically, and converges with the separately projected session graph.
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

  await step('onboarding_github', async () => {
    const configPath = path.join(harness.tmpDir, 'onboarding.json')
    let loginRan = false
    const output = { write() {} }
    const result = await runInitWizard({
      stdout: output, stderr: output,
      env: { ...process.env, HYP_CONFIG: configPath },
      capabilities: kernel.capabilities,
      gate: async () => /** @type {any} */ ({ action: 'first-run' }),
      fork: async () => 'local',
      detect: async () => new Set(),
      prompt: async () => ['raw-openai'],
      github: { confirm: async () => 'yes' },
      ctx: /** @type {any} */ ({ commands: { run: async (name, argv) => {
        const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
        expect.that('onboarding: GitHub enabled before login', config.plugins, (plugins) => plugins.some((p) => p.name === '@hypaware/github'))
        expect.that('onboarding: existing browser login invoked', { name, argv }, (call) => call.name === 'github login' && call.argv.length === 0)
        loginRan = true
        return 0
      } } }),
    })
    expect.that('onboarding: opt-in completes', result.exitCode, (code) => code === 0 && loginRan)
  })

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

  await step('verify_automatic_projection', async () => {
    const issues = await sqlCount("select count(*) as n from node where node_type = 'Issue' and natural_key = 'acme/widgets#7'", lifetime)
    expect.that('automatic projection: GitHub issue exists before graph project', issues, (n) => n === 1)
    const edges = await sqlCount("select count(*) as n from edge where source_dataset = 'github_events'", lifetime)
    expect.that('automatic projection: GitHub edges exist before graph project', edges, (n) => n > 0)
    const sessions = await sqlCount("select count(*) as n from node where node_type = 'Session'", lifetime)
    expect.that('automatic projection: other source contracts were not run', sessions, (n) => n === 0)
  })

  await step('project_sessions', async () => {
    const result = await dispatchText(['graph', 'project', '--source', 'ai_gateway_messages'], lifetime)
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

  await step('oauth_one_time_import', async () => {
    const rt = requireGithubRuntime()
    const requests = []
    const token = 'hermetic-oauth-access'
    /** @type {typeof fetch} */
    const fetchImpl = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/login/device/code') return Response.json({
        device_code: 'hermetic-device', user_code: 'ABCD-EFGH', interval: 5,
        expires_in: 900, verification_uri: 'https://github.com/login/device',
      })
      if (url.pathname === '/login/oauth/access_token') return Response.json({ access_token: token, token_type: 'bearer', scope: 'repo' })
      expect.that('OAuth: API receives the saved credential', new Headers(init?.headers).get('Authorization'), (value) => value === `Bearer ${token}`)
      if (url.pathname === '/user') return Response.json({ login: 'smoke-user', id: 7 })
      requests.push(url.pathname)
      expect.that('OAuth: requested repository stays within explicit/evidenced selection', url.pathname,
        (value) => /^\/repos\/acme\/(manual|widgets)\//.test(value))
      return Response.json(url.pathname === '/repos/acme/manual/issues'
        ? [{ number: 8, state: 'open', created_at: '2026-09-01T00:00:00Z', body: 'content-must-not-be-stored', user: { login: 'smoke-user' } }]
        : [])
    }
    await loginGithub(rt.stateDir, { fetchImpl, onCode() {}, async sleep() {} })
    setGithubRuntime({ ...rt, captureRequestLimit: 1, clientFactory: () => createGithubClient({
      stateDir: rt.stateDir, tokenEnv: 'GITHUB_TOKEN', env: {}, log: rt.log, fetchImpl,
      ghToken: async () => { throw new Error('OAuth must not invoke gh') },
    }) })
    const imported = await dispatchText(['github', 'backfill', 'acme/manual'], lifetime)
    expect.that('one-time import: command succeeds', imported.code, (value) => value === 0)
    expect.that('one-time import: continuation is durable', readCursors(rt.stateDir).repos['acme/manual']?.one_time_import, (value) => value === true)
    for (let i = 0; i < 12 && readCursors(rt.stateDir).repos['acme/manual']?.one_time_import; i++) {
      const synced = await dispatchText(['github', 'sync'], lifetime)
      expect.that('one-time import: resume succeeds', synced.code, (value) => value === 0)
    }
    expect.that('one-time import: completion retires eligibility', readCursors(rt.stateDir).repos['acme/manual']?.one_time_import, (value) => value === undefined)
    const nodes = await sqlCount("select count(*) as n from node where node_type = 'Issue' and natural_key = 'acme/manual#8'", lifetime)
    expect.that('OAuth import: automatically projected its issue', nodes, (value) => value === 1)
    const events = await sqlCount("select count(*) as n from github_events where repo = 'acme/manual'", lifetime)
    expect.that('OAuth import: captured one structural row', events, (value) => value === 1)
    requests.length = 0
    await dispatchText(['github', 'sync'], lifetime)
    expect.that('OAuth import: completion does not subscribe', requests, (values) => values.every((value) => !value.includes('/manual/')))
    const evidence = await rt.observedRepos.list()
    expect.that('OAuth import: no manufactured session evidence', evidence, (values) => !values.includes('acme/manual'))
    await logoutGithub(rt.stateDir)
    const loggedOut = await dispatchText(['github', 'sync'], lifetime)
    expect.that('OAuth logout: running capture requires re-login', loggedOut.stderr, (value) => value.includes('hyp github login'))
  })

  await obs.shutdown()
  const traces = await expect.traces()
  for (const [name, status] of [['wizard.github.offer', 'accepted'], ['wizard.github.login', 'ok']]) {
    expect.that(`telemetry: ${name} outcome`, traces,
      (rows) => rows.some((row) => row.name === name && row.attributes?.status === status))
  }
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
    'telemetry: GitHub projection completed automatically',
    logs,
    (rows) => rows.some((row) => row.body === 'github.projection_completed'
      && row.attributes?.source_dataset === 'github_events'
      && row.attributes?.nodes_written > 0
      && row.attributes?.edges_written > 0)
  )
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
