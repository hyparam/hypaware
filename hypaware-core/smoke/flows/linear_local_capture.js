// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { Attr, installObservability } from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { AI_GATEWAY_SCHEMA_COLUMNS, aiGatewayTablePath } from '../../plugins-workspace/ai-gateway/src/dataset.js'
import { GITHUB_EVENTS_COLUMNS, githubEventsTablePath } from '../../plugins-workspace/github/src/dataset.js'
import { requireLinearRuntime, setLinearRuntime } from '../../plugins-workspace/linear/src/runtime.js'
import { createLinearClient } from '../../plugins-workspace/linear/src/client.js'
import { DEFAULT_CLIENT_ID } from '../../plugins-workspace/linear/src/config.js'
import { dispatchText, sqlCount, githubSessionRow, makeStep } from '../lib/github_fixture.js'
import { callbackUri, fakeLinearApi, WORKSPACE_ID, ISSUE_ID, TEAM_ID } from '../lib/linear_fixture.js'

/** @param {{ harness: any, expect: any }} args */
// @ref LLP 0608#connect [tests]: one command signs in, enables Linear, and saves its team scope for the next boot
// @ref LLP 0592#verification [tests]: GraphQL capture and issue/PR/commit/session traversal with automatic Linear projection
export async function run({ harness, expect }) {
  const obs = installObservability()
  const step = makeStep(harness)
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot: path.join(harness.stateDir, 'cache') })
  const lifetime = { kernel, registry }
  const workspace = path.resolve(import.meta.dirname, '../../plugins-workspace')
  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })
  const redirectUri = await callbackUri()
  const api = fakeLinearApi()
  const configPath = path.join(harness.hypHome, 'hypaware-config.json')

  try {
    await step('connect', async () => {
      const nativeFetch = globalThis.fetch
      let callback = Promise.resolve()
      let output = ''
      let stderr = ''
      await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [
        { name: '@hypaware/linear', enabled: false, config: { redirect_uri: redirectUri } },
      ] }))
      globalThis.fetch = api.fetchImpl
      try {
        const code = await dispatch(['linear', 'connect', '--no-browser'], {
          env: { ...process.env, HYP_CONFIG: configPath, LINEAR_API_KEY: '', LINEAR_CLIENT_ID: '' },
          stdout: { write(chunk) {
            output += chunk
            const url = String(chunk).split('\n').find(line => line.startsWith('https://linear.app/oauth/authorize'))
            if (url) {
              callback = api.authorize(url, nativeFetch)
              callback.catch(() => {})
            }
            return true
          } },
          stderr: { write(chunk) { stderr += chunk; return true } },
        })
        expect.that('connect succeeds without an active plugin', { code, stderr }, r => r.code === 0 && !r.stderr)
        await callback
        const authorizationUrl = output.split('\n').find(line => line.startsWith('https://linear.app/oauth/authorize'))
        expect.that('connect uses the shared HypAware app without client configuration', authorizationUrl,
          url => Boolean(url) && new URL(url).searchParams.get('client_id') === DEFAULT_CLIENT_ID)
        expect.that('connected workspace and selected team are reported', output, text => text.includes('workspace smoke') && text.includes('Selected teams: HYP'))
        const saved = JSON.parse(await fs.readFile(configPath, 'utf8'))
        expect.that('saved config enables Linear and its graph dependency with the chosen team', saved.plugins, plugins =>
          plugins.some(plugin => plugin.name === '@hypaware/linear' && plugin.enabled === true && plugin.config.teams[0] === TEAM_ID) &&
          plugins.some(plugin => plugin.name === '@hypaware/context-graph'))
        output = ''
        const status = await dispatch(['linear', 'status'], {
          env: { ...process.env, HYP_CONFIG: configPath, LINEAR_API_KEY: '' },
          stdout: { write(chunk) { output += chunk; return true } },
          stderr: { write(chunk) { stderr += chunk; return true } },
        })
        expect.that('a fresh CLI boot sees the saved scope and credentials', { status, output, stderr }, r =>
          r.status === 0 && !r.stderr && r.output.includes('Linear workspace: smoke') && r.output.includes(TEAM_ID))
      } finally { globalThis.fetch = nativeFetch }
    })

    await step('activate', async () => {
      const saved = JSON.parse(await fs.readFile(configPath, 'utf8'))
      const linearConfig = saved.plugins.find(plugin => plugin.name === '@hypaware/linear').config
      const { loaded } = await loadManifests(['ai-gateway', 'context-graph', 'ai-gateway-graph', 'github', 'linear'].map(name => path.join(workspace, name)))
      const activated = await activatePlugins({ plugins: loaded.map(entry => ({ ...entry,
        config: entry.manifest.name === '@hypaware/linear' ? linearConfig : undefined,
      })), stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot })
      expect.that('all bundled source and graph contracts activate', activated.results, rows => rows.length === 5 && rows.every(row => row.ok))
    })

    await step('seed_git_context', async () => {
      const session = githubSessionRow({ gatewayId: 'linear-smoke', id: 'linear-session', cwd: '/work/widgets', remote: 'git@github.com:acme/widgets.git' })
      const gatewayTable = aiGatewayTablePath(kernel.storage)
      await kernel.storage.appendRows(gatewayTable, [...AI_GATEWAY_SCHEMA_COLUMNS], [session])
      const githubTable = githubEventsTablePath(kernel.storage)
      const base = Object.fromEntries(GITHUB_EVENTS_COLUMNS.map(column => [column.name, null]))
      await kernel.storage.appendRows(githubTable, [...GITHUB_EVENTS_COLUMNS], [
        { ...base, event_id: 'smoke-pr', event_type: 'pull_request', repo: 'acme/widgets', number: 42, created_at: '2026-10-01T00:00:00Z' },
        { ...base, event_id: 'smoke-commit', event_type: 'commit', repo: 'acme/widgets', sha: session.head_sha, pr_number: 42, created_at: '2026-10-01T00:00:00Z' },
      ])
      for (const dataset of ['github_events', 'ai_gateway_messages']) {
        const projected = await dispatchText(['graph', 'project', '--source', dataset], lifetime)
        expect.that(`seed ${dataset} projection succeeds`, projected, r => r.code === 0)
      }
    })

    const activated = requireLinearRuntime()
    const rt = { ...activated, env: { ...activated.env, LINEAR_API_KEY: '', LINEAR_CLIENT_ID: '' } }
    setLinearRuntime({ ...rt, clientFactory: signal => createLinearClient({ config: rt.config, stateDir: rt.stateDir, env: rt.env, signal, fetchImpl: api.fetchImpl }) })
    await step('capture', async () => {
      const result = await dispatchText(['linear', 'sync'], lifetime)
      expect.that('registered sync succeeds', result, r => r.code === 0 && r.stderr === '')
      expect.that('structural issue and attachment rows are queryable', await sqlCount('select count(*) as n from linear_events', lifetime), n => n === 2)
    })
    await step('verify_graph', async () => {
      const issue = `linear:${WORKSPACE_ID}:${ISSUE_ID}`
      expect.that('Linear issue is projected automatically', await sqlCount(`select count(*) as n from node where node_type = 'Issue' and natural_key = '${issue}'`, lifetime), n => n === 1)
      expect.that('GitHub and Linear converge on one PR', await sqlCount("select count(*) as n from node where node_type = 'PullRequest' and natural_key = 'acme/widgets#42'", lifetime), n => n === 1)
      const traversal = `select count(*) as n from edge l
        join edge p on p.src_id = l.dst_id
        join edge s on s.dst_id = p.dst_id
        where l.source_dataset = 'linear_events' and l.src_type = 'Issue' and l.dst_type = 'PullRequest'
          and p.src_type = 'PullRequest' and p.dst_type = 'Commit' and p.edge_type = 'references'
          and s.src_type = 'Session' and s.edge_type = 'at'`
      expect.that('issue connects through PR and commit to recorded session', await sqlCount(traversal, lifetime), n => n === 1)
      const result = await dispatchText(['linear', 'sync'], lifetime)
      expect.that('idle sync succeeds', result.code, code => code === 0)
      expect.that('idle sync does not reappend history', await sqlCount('select count(*) as n from linear_events', lifetime), n => n === 2)
    })
  } finally { await obs.shutdown() }
  const logs = await expect.logs()
  for (const name of ['linear.connect_authenticated', 'linear.connect_configured', 'linear.capture_completed', 'linear.projection_completed']) {
    expect.that(`telemetry proves ${name}`, logs, rows => rows.some(row => row.body === name))
  }
  expect.that('telemetry never contains credentials', JSON.stringify(logs), text => !/hermetic-access|hermetic-refresh|hermetic-code/.test(text))
  const traces = await expect.traces()
  expect.that('cache append span proves Linear write', traces, rows => rows.some(row => row.name === 'cache.append' && row.attributes?.[Attr.DATASET] === 'linear_events'))
}
