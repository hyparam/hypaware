// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { REPO, TOKEN, makeBuf, shellSplit, startFastaskServer, waitFor } from '../lib/fastask_fixture.js'

/**
 * Hermetic smoke for the agent-directed path (LLP 0487#decision, LLP 0481
 * T15): an agent chains `hyp query team-graph discover`, `neighbors`,
 * `search` and `hyp query evidence`, each step taking the ids the previous
 * one printed and running its printed follow-up command as printed. The
 * plugin is enabled the way it is before enablement (an explicit `plugins[]`
 * entry in a temp install), against T10's loopback team server (snapshot
 * routes and MCP).
 *
 *   warm  a real daemon syncs the replica; discover and neighbors read its
 *         warm index, search and evidence read the server
 *   cold  the daemon is stopped; discover and neighbors load the replica
 *
 * Signals: one `fastask.team_graph.*` span per operation with its source
 * path, and no terms or text in any span.
 *
 * @ref LLP 0487#decision [tests]: discover, neighbors, search and evidence chain through their printed ids and commands, warm and cold
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) throw new Error('fastask_team_graph_chain: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')

  /** @param {string} name */
  const stepBag = (name) => ({
    [Attr.COMPONENT]: 'smoke', [Attr.OPERATION]: 'step', [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name, [Attr.DEV_RUN_ID]: harness.devRunId, status: 'ok',
  })
  /** @template T @param {string} name @param {() => Promise<T>} fn @returns {Promise<T>} */
  const step = (name, fn) => runRoot(`smoke.step.${name}`, stepBag(name), fn)

  const server = await startFastaskServer()
  await server.publish('g1', new Date(Date.now() - 3_600_000).toISOString())
  const configPath = path.join(harness.hypHome, 'fastask-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    plugins: [{ name: '@hypaware/fastask' }],
    query: { default_remote: 'fx', remotes: { fx: { url: server.url } } },
  }))
  const repo = path.join(harness.tmpDir, 'fx-repo')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  await fs.writeFile(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:${REPO}.git\n`)
  const env = { ...process.env, HYP_CONFIG: configPath, HYP_REMOTE_TOKEN_FX: TOKEN }

  /** Run `hyp <argv>` in the caller's repository. @param {string[]} argv */
  const hyp = async (argv) => {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(argv, { stdout, stderr, env, cwd: repo })
    return { code, out: stdout.text(), err: stderr.text() }
  }
  /**
   * Run a printed command as printed, expecting exit 0 and a JSON document.
   * @param {string} label @param {string} command
   */
  const runPrinted = async (label, command) => {
    const argv = shellSplit(command)
    expect.that(`${label}: the printed command starts with hyp`, argv[0], (v) => v === 'hyp')
    const r = await hyp(argv.slice(1))
    expect.that(`${label}: exits 0`, { command, code: r.code, err: r.err }, (v) => v.code === 0)
    return JSON.parse(r.out)
  }

  /** @type {Awaited<ReturnType<typeof runDaemon>> | undefined} */
  let handle
  try {
    // ----- smoke_step: warm -----
    await step('warm', async () => {
      handle = await runDaemon({ hypHome: harness.hypHome, configPath, env, runId: harness.devRunId, tickIntervalMs: 50, installSignalHandlers: false })
      const daemon = handle
      await waitFor(() => daemon.snapshot().sources.find((s) => s.name === 'team-graph-replica')?.details?.index_generation === 'g1', 20_000, 'the daemon to sync and index g1')
      await waitFor(async () => {
        const status = JSON.parse(await fs.readFile(path.join(harness.stateDir, 'run', 'status.json'), 'utf8').catch(() => '{}'))
        return (status.sources ?? []).some((/** @type {any} */ s) => s.name === 'team-graph-replica' && s.details?.control_routes?.includes('fastask/neighbors'))
      }, 10_000, 'status.json to carry the neighbors route')

      const discovered = await runPrinted('warm discover', 'hyp query team-graph discover login.js --json')
      expect.that('warm discover: answered by the warm replica', [discovered.source.kind, discovered.source.path], (v) => v[0] === 'team_replica' && v[1] === 'warm')
      expect.that('warm discover: the login.js sessions, with node ids', discovered.sessions, (s) => s.length >= 2 && s.every((/** @type {any} */ x) => /^fx-session-login-/.test(x.session_id) && typeof x.node_id === 'string'))
      expect.that('warm discover: the anchor is proven in the caller\'s repository', discovered.anchors[0], (a) => a?.key === `${REPO}:src/login.js` && a?.proven === true && typeof a?.node_id === 'string')

      const near = await runPrinted('warm neighbors', discovered.next.neighbors)
      expect.that('warm neighbors: answered by the warm replica', near.source.path, (p) => p === 'warm')
      expect.that('warm neighbors: the sessions that touched login.js', near.neighbors.map((/** @type {any} */ n) => n.node.key).sort(), (keys) => keys.join(',') === 'fx-session-login-a,fx-session-login-b')

      const found = await runPrinted('search', discovered.next.search)
      expect.that('search: read from the team server', found.source.kind, (k) => k === 'team_server')
      const hit = found.sessions.flatMap((/** @type {any} */ s) => s.hits)[0]
      expect.that('search: a hit names its message and carries a read command', hit, (h) => typeof h?.message_id === 'string' && typeof h?.read_command === 'string')

      const read = await runPrinted('evidence', hit.read_command)
      expect.that('evidence: the original text around the hit', read.sessions?.[0]?.parts?.length, (n) => n > 0)
    })

    // ----- smoke_step: cold -----
    await step('cold', async () => {
      await /** @type {any} */ (handle).stop()
      await /** @type {any} */ (handle).done
      handle = undefined
      const discovered = await runPrinted('cold discover', 'hyp query team-graph discover login.js --json')
      expect.that('cold discover: answered by the replica on disk', [discovered.source.kind, discovered.source.path], (v) => v[0] === 'team_replica' && v[1] === 'cold')
      const near = await runPrinted('cold neighbors', discovered.next.neighbors)
      expect.that('cold neighbors: answered by the replica on disk', near.source.path, (p) => p === 'cold')
      expect.that('cold neighbors: the same sessions', near.neighbors.length, (n) => n === 2)
    })
  } finally {
    if (handle) {
      try { await handle.stop() } catch { /* already stopping */ }
      try { await handle.done } catch { /* surface the original failure */ }
    }
    await server.close()
    await obs.shutdown()
  }

  // ----- telemetry: each operation ran on the path it names -----
  const traces = /** @type {any[]} */ (await expect.traces())
  const ops = traces.filter((t) => typeof t.name === 'string' && t.name.startsWith('fastask.team_graph.'))
  const seen = new Set(ops.map((t) => `${t.name.slice('fastask.team_graph.'.length)}:${t.attributes?.source_path}`))
  expect.that('telemetry: discover and neighbors ran warm and cold, search on the server', [...seen].sort().join(','),
    (v) => v === 'discover:cold,discover:warm,neighbors:cold,neighbors:warm,search:team_server')
  expect.that('telemetry: no terms in any span', JSON.stringify(ops), (s) => !s.includes('login.js'))
}
