// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { REPO, TOKEN, makeBuf, shellSplit, startFastaskServer, waitFor } from '../lib/fastask_fixture.js'

/**
 * Hermetic smoke for the agent path over every source (LLP 0480#sources,
 * LLP 0487#decision, LLP 0481 T10 as rewritten for LLP 0488#planner-deferred),
 * with the plugin enabled the way it is before enablement: an explicit
 * `plugins[]` entry in a temp install. One loopback server plays the team
 * server (snapshot routes and MCP). Each step runs `hyp query team-graph
 * discover` through `dispatch`, checks the answer, then runs every follow-up
 * it printed (neighbors, search, the next page) and every evidence read the
 * search printed: each must exit 0 (journey 4: a suggested command that does
 * not run is a failure).
 *
 *   warm         a real daemon syncs the replica; discover asks it
 *   cold         the daemon is stopped; discover loads the replica from disk
 *   team_server  --remote names another target: discovery by SQL on the server
 *   local        no remote login: local captures only
 *
 * Signals: `fastask.team_graph.discover` per step with its source path, and
 * the server's own request log (discover never handshakes on the warm path).
 *
 * @ref LLP 0480#sources [tests]: warm, cold, team_server and local each answer and name themselves; every printed follow-up runs
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) throw new Error('fastask_query: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')

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
    query: { default_remote: 'fx', remotes: { fx: { url: server.url }, fx2: { url: server.url } } },
  }))
  const repo = path.join(harness.tmpDir, 'fx-repo')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  await fs.writeFile(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:${REPO}.git\n`)
  const env = { ...process.env, HYP_CONFIG: configPath, HYP_REMOTE_TOKEN_FX: TOKEN, HYP_REMOTE_TOKEN_FX2: TOKEN }

  /**
   * Run `hyp <argv>` in the caller's repository.
   * @param {string[]} argv @param {NodeJS.ProcessEnv} [withEnv]
   */
  const hyp = async (argv, withEnv = env) => {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(argv, { stdout, stderr, env: withEnv, cwd: repo })
    return { code, out: stdout.text(), err: stderr.text() }
  }

  /**
   * A printed command, run as printed.
   * @param {string} label @param {string} command @param {NodeJS.ProcessEnv} withEnv
   */
  const runPrinted = async (label, command, withEnv) => {
    const argv = shellSplit(command)
    expect.that(`${label}: follow-up starts with hyp`, argv[0], (v) => v === 'hyp')
    const ran = await hyp(argv.slice(1), withEnv)
    expect.that(`${label}: follow-up exits 0`, { command, code: ran.code, err: ran.err }, (v) => v.code === 0)
    return ran
  }

  /**
   * `hyp query team-graph discover login.js --json`, then every follow-up it
   * printed, and every evidence read the search printed.
   * @param {string} label @param {string[]} extra @param {NodeJS.ProcessEnv} [withEnv]
   */
  const explore = async (label, extra = [], withEnv = env) => {
    const r = await hyp(['query', 'team-graph', 'discover', 'login.js', '--json', ...extra], withEnv)
    expect.that(`${label}: discover exits 0`, { code: r.code, err: r.err }, (v) => v.code === 0)
    const doc = JSON.parse(r.out)
    expect.that(`${label}: a team-graph-discover/1 document`, doc.contract, (c) => c === 'team-graph-discover/1')
    for (const [name, command] of Object.entries(doc.next)) {
      if (!command) continue
      const ran = await runPrinted(`${label} ${name}`, /** @type {string} */ (command), withEnv)
      if (name !== 'search') continue
      const found = JSON.parse(ran.out)
      const reads = found.sessions.flatMap((/** @type {any} */ s) => s.hits.map((/** @type {any} */ h) => h.read_command)).filter(Boolean)
      expect.that(`${label}: the search printed evidence reads`, reads.length, (n) => n > 0)
      for (const read of reads) {
        const evidence = JSON.parse((await runPrinted(`${label} evidence`, read, withEnv)).out)
        // The original text comes back for what the search found.
        expect.that(`${label}: the evidence read returned original text`, evidence.sessions?.[0]?.parts,
          (parts) => Array.isArray(parts) && parts.length > 0 && parts.every((/** @type {any} */ p) => typeof p.content_text === 'string'))
      }
    }
    return doc
  }

  /** @type {Awaited<ReturnType<typeof runDaemon>> | undefined} */
  let handle
  try {
    // ----- smoke_step: warm -----
    await step('warm', async () => {
      handle = await runDaemon({ hypHome: harness.hypHome, configPath, env, runId: harness.devRunId, tickIntervalMs: 50, installSignalHandlers: false })
      const daemon = handle
      const replica = () => /** @type {Record<string, any> | undefined} */ (daemon.snapshot().sources.find((s) => s.name === 'team-graph-replica')?.details)
      await waitFor(() => replica()?.index_generation === 'g1', 20_000, 'the daemon to sync and index g1')
      // The command reads status.json, which the daemon rewrites each tick.
      await waitFor(async () => {
        const status = JSON.parse(await fs.readFile(path.join(harness.stateDir, 'run', 'status.json'), 'utf8').catch(() => '{}'))
        return (status.sources ?? []).some((/** @type {any} */ s) => s.name === 'team-graph-replica' && s.details?.index_generation === 'g1')
      }, 10_000, 'status.json to carry the warm index')

      const doc = await explore('warm')
      expect.that('warm: answered by the warm replica', [doc.source.kind, doc.source.path], (v) => v[0] === 'team_replica' && v[1] === 'warm')
      expect.that('warm: a login.js session leads', doc.sessions[0]?.session_id, (id) => /^fx-session-login-/.test(id))
      expect.that('warm: the anchor is proven in the caller\'s repository', doc.anchors[0], (a) => a?.key === `${REPO}:src/login.js` && a?.proven === true)

      // The follow-ups above connect on their own; discover itself, warm, must not.
      const handshakesBefore = server.toolCalls('initialize').length
      const text = await hyp(['query', 'team-graph', 'discover', 'login.js'])
      expect.that('warm: discover itself made no MCP handshake', server.toolCalls('initialize').length - handshakesBefore, (n) => n === 0)
      expect.that('warm: the human output names its source', text.out, (s) => s.startsWith('source: team graph replica (warm'))
      const status = await hyp(['graph', 'replica', 'status'])
      expect.that('warm: graph replica status prints the synced line', status, (r) => r.code === 0 && /^team graph: synced, data as of /.test(r.out))
    })

    // ----- smoke_step: cold -----
    await step('cold', async () => {
      await /** @type {any} */ (handle).stop()
      await /** @type {any} */ (handle).done
      handle = undefined
      const doc = await explore('cold')
      expect.that('cold: answered by the replica on disk', [doc.source.kind, doc.source.path], (v) => v[0] === 'team_replica' && v[1] === 'cold')
      expect.that('cold: the load is labeled with its time', doc.source.note, (n) => /^daemon not running: loaded the team graph in \d+ ms$/.test(n))
      expect.that('cold: a login.js session leads', doc.sessions[0]?.session_id, (id) => /^fx-session-login-/.test(id))
      const status = await hyp(['graph', 'replica', 'status'])
      expect.that('cold: graph replica status says the daemon is not running', status.out, (s) => /\(daemon not running\)\n$/.test(s))
    })

    // ----- smoke_step: team_server -----
    await step('team_server', async () => {
      const sqlBefore = server.toolCalls('query_sql').length
      const doc = await explore('team_server', ['--remote', 'fx2'])
      expect.that('team_server: answered by the server, labeled slow with the reason', [doc.source.kind, doc.source.note], (v) => v[0] === 'team_server' && /slow.*kept only for the default remote/.test(v[1]))
      expect.that('team_server: discovery ran by SQL on the server', server.toolCalls('query_sql').length - sqlBefore, (n) => n >= 3)
      expect.that('team_server: a login.js session leads', doc.sessions[0]?.session_id, (id) => /^fx-session-login-/.test(id))
    })

    // ----- smoke_step: local -----
    await step('local', async () => {
      const localConfig = path.join(harness.hypHome, 'fastask-local-config.json')
      await fs.writeFile(localConfig, JSON.stringify({ version: 2, auto_update: false, plugins: [{ name: '@hypaware/fastask' }] }))
      /** @type {NodeJS.ProcessEnv} */
      const localEnv = { ...process.env, HYP_CONFIG: localConfig }
      delete localEnv.HYP_REMOTE_TOKEN_FX
      delete localEnv.HYP_REMOTE_TOKEN_FX2
      const doc = await explore('local', [], localEnv)
      expect.that('local: local captures only', [doc.source.kind, doc.source.note], (v) => v[0] === 'local' && /local captures only/.test(v[1]))
      const text = await hyp(['query', 'team-graph', 'discover', 'login.js'], localEnv)
      expect.that('local: the human output names local captures', text.out, (s) => s.startsWith('source: local captures'))
    })
  } finally {
    if (handle) {
      try { await handle.stop() } catch { /* already stopping */ }
      try { await handle.done } catch { /* surface the original failure */ }
    }
    await server.close()
    await obs.shutdown()
  }

  // ----- telemetry: every source path ran and named itself -----
  const traces = /** @type {any[]} */ (await expect.traces())
  const steps = new Set(traces.filter((t) => t.name?.startsWith('smoke.step.')).map((t) => t.attributes?.smoke_step))
  expect.that('telemetry: every smoke_step ran', [...steps].sort().join(','), (v) => v === 'cold,local,team_server,warm')
  const runs = traces.filter((t) => t.name === 'fastask.team_graph.discover')
  const paths = new Set(runs.map((t) => t.attributes?.source_path))
  expect.that('telemetry: discover covered warm, cold, team_server and local', [...paths].sort().join(','), (v) => v === 'cold,local,team_server,warm')
  expect.that('telemetry: replica sync spans from the daemon', traces.some((t) => t.name === 'replica.activate'), (v) => v === true)
  expect.that('telemetry: no terms in any team-graph span', JSON.stringify(traces.filter((t) => t.name?.startsWith('fastask.team_graph.'))), (s) => !s.includes('login.js'))
}
