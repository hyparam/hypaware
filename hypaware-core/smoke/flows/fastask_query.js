// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { QUESTION, REPO, TOKEN, makeBuf, shellSplit, startFastaskServer, waitFor } from '../lib/fastask_fixture.js'

/**
 * Hermetic smoke for `hyp fastask` over every source (LLP 0480#sources, LLP
 * 0481 T10), with the plugin enabled the way it is before enablement: an
 * explicit `plugins[]` entry in a temp install. One loopback server plays the
 * team server (snapshot routes and MCP). Each step runs the real CLI through
 * `dispatch`, checks the answer, and then runs every follow-up command the
 * answer printed: each must exit 0 (journey 4: a suggested command that does
 * not run is a failure).
 *
 *   warm         a real daemon syncs the replica; fastask asks it, and the
 *                daemon forwards evidence over one kept-alive MCP session
 *   cold         the daemon is stopped; fastask loads the replica from disk
 *   team_server  --remote names another target: discovery by SQL on the server
 *   local        no remote login: local captures only
 *
 * Signals: `fastask.run` per step with its source kind and path, the
 * daemon's evidence session (one initialize across two warm runs), and the
 * server's own request log (the command never handshakes on the warm path).
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
   * `hyp fastask --json`, then every follow-up it printed.
   * @param {string} label @param {string[]} extra @param {NodeJS.ProcessEnv} [withEnv]
   */
  const ask = async (label, extra = [], withEnv = env) => {
    const r = await hyp(['fastask', QUESTION, '--json', ...extra], withEnv)
    expect.that(`${label}: hyp fastask exits 0`, { code: r.code, err: r.err }, (v) => v.code === 0)
    const doc = JSON.parse(r.out)
    expect.that(`${label}: a fastask/1 document`, doc.contract, (c) => c === 'fastask/1')
    expect.that(`${label}: timings name every phase`, Object.keys(doc.timings_ms).join(','), (k) => k === 'load,connect,discovery,evidence,total')
    for (const f of doc.followups) {
      const argv = shellSplit(f.command)
      expect.that(`${label}: follow-up starts with hyp`, argv[0], (v) => v === 'hyp')
      const ran = await hyp(argv.slice(1), withEnv)
      expect.that(`${label}: follow-up "${f.why}" exits 0`, { command: f.command, code: ran.code, err: ran.err }, (v) => v.code === 0)
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

      const doc = await ask('warm')
      expect.that('warm: answered by the warm replica', [doc.source.kind, doc.source.path], (v) => v[0] === 'team_replica' && v[1] === 'warm')
      expect.that('warm: a login.js session leads', doc.leads[0]?.session_id, (id) => /^fx-session-login-/.test(id))
      expect.that('warm: the anchor is proven in the caller\'s repository', doc.leads[0]?.why[0]?.anchor, (a) => a?.key === `${REPO}:src/login.js` && a?.proven === true)
      expect.that('warm: original text came back', doc.leads[0]?.evidence, (e) => e?.status === 'ok' && e.parts.length > 0 && e.parts.every((/** @type {any} */ p) => typeof p.content_text === 'string'))
      expect.that('warm: no load and no connect on the warm path', [doc.timings_ms.load, doc.timings_ms.connect], (v) => v[0] === 0 && v[1] === 0)
      await ask('warm-again')
      // The snapshot is the daemon's last status probe; give it a tick to see the forwards.
      await waitFor(() => (replica()?.evidence?.[0]?.last_round_trip_ms ?? null) !== null, 5_000, 'the daemon status to record its evidence session')
      const session = replica()?.evidence?.[0]
      expect.that('warm: the daemon kept one MCP session for both runs', session, (s) => s?.supports_evidence === true && s?.initializes === 1 && typeof s?.last_round_trip_ms === 'number')

      // The follow-ups above connect on their own; fastask itself, warm, must not.
      const handshakesBefore = server.toolCalls('initialize').length
      const text = await hyp(['fastask', QUESTION])
      expect.that('warm: fastask itself made no MCP handshake', server.toolCalls('initialize').length - handshakesBefore, (n) => n === 0)
      expect.that('warm: the human output names its source', text.out, (s) => s.startsWith('source: team_replica (warm) on fx'))
      const status = await hyp(['graph', 'replica', 'status'])
      expect.that('warm: graph replica status prints the synced line', status, (r) => r.code === 0 && /^team graph: synced, data as of /.test(r.out))
    })

    // ----- smoke_step: cold -----
    await step('cold', async () => {
      await /** @type {any} */ (handle).stop()
      await /** @type {any} */ (handle).done
      handle = undefined
      const doc = await ask('cold')
      expect.that('cold: answered by the replica on disk', [doc.source.kind, doc.source.path], (v) => v[0] === 'team_replica' && v[1] === 'cold')
      expect.that('cold: the load is labeled with its time', doc.source.note, (n) => /^daemon not running: loaded the team graph in \d+ ms$/.test(n))
      expect.that('cold: a login.js session leads, with evidence', doc.leads[0], (l) => /^fx-session-login-/.test(l?.session_id) && l?.evidence?.status === 'ok')
      const status = await hyp(['graph', 'replica', 'status'])
      expect.that('cold: graph replica status says the daemon is not running', status.out, (s) => /\(daemon not running\)\n$/.test(s))
    })

    // ----- smoke_step: team_server -----
    await step('team_server', async () => {
      const sqlBefore = server.toolCalls('query_sql').length
      const doc = await ask('team_server', ['--remote', 'fx2'])
      expect.that('team_server: answered by the server, labeled slow with the reason', [doc.source.kind, doc.source.note], (v) => v[0] === 'team_server' && /slow.*kept only for the default remote/.test(v[1]))
      expect.that('team_server: discovery ran by SQL on the server', server.toolCalls('query_sql').length - sqlBefore, (n) => n >= 3)
      expect.that('team_server: a login.js session leads, with evidence', doc.leads[0], (l) => /^fx-session-login-/.test(l?.session_id) && l?.evidence?.status === 'ok')
    })

    // ----- smoke_step: local -----
    await step('local', async () => {
      const localConfig = path.join(harness.hypHome, 'fastask-local-config.json')
      await fs.writeFile(localConfig, JSON.stringify({ version: 2, auto_update: false, plugins: [{ name: '@hypaware/fastask' }] }))
      /** @type {NodeJS.ProcessEnv} */
      const localEnv = { ...process.env, HYP_CONFIG: localConfig }
      delete localEnv.HYP_REMOTE_TOKEN_FX
      delete localEnv.HYP_REMOTE_TOKEN_FX2
      const doc = await ask('local', [], localEnv)
      expect.that('local: local captures only', [doc.source.kind, doc.source.note], (v) => v[0] === 'local' && /local captures only/.test(v[1]))
      const text = await hyp(['fastask', QUESTION], localEnv)
      expect.that('local: the human output ends with the local line', text.out, (s) => s.endsWith('local captures only\n'))
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
  const runs = traces.filter((t) => t.name === 'fastask.run')
  const paths = new Set(runs.map((t) => t.attributes?.source_path))
  expect.that('telemetry: fastask.run covered warm, cold, team_server and local', [...paths].sort().join(','), (v) => v === 'cold,local,team_server,warm')
  expect.that('telemetry: every fastask.run carries its timings', runs, (r) => r.every((t) => typeof t.attributes?.timing_total_ms === 'number'))
  const evidence = traces.filter((t) => t.name === 'fastask.evidence')
  expect.that('telemetry: evidence read through session_evidence on the replica and server paths', evidence.filter((t) => t.attributes?.path === 'session_evidence').length, (n) => n >= 4)
  expect.that('telemetry: replica sync spans from the daemon', traces.some((t) => t.name === 'replica.activate'), (v) => v === true)
  expect.that('telemetry: no question text in any span', JSON.stringify(traces), (s) => !s.includes(QUESTION))
}
