// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { createReplicaSource } from '../../plugins-workspace/graph-cache/src/replica_source.js'
import { REFRESH_ROUTE, TOKEN_FILE } from '../../plugins-workspace/graph-cache/src/replica_source.js'
import { TOKEN, startFastaskServer, waitFor } from '../lib/fastask_fixture.js'

/**
 * Hermetic smoke for the team graph replica's sync loop (LLP 0480#sync, LLP
 * 0481 T10), in the remote_oidc_login.js style: the real `team-graph-replica`
 * source runs in-process against one loopback server playing the team
 * server's snapshot routes, and every check after the first is started
 * through the source's own token-guarded `fastask/refresh` route, as
 * `hyp graph replica refresh` starts it.
 *
 * Steps, each under a `smoke_step`-tagged root span:
 *
 *   first_sync      200: download, verify, index, activate generation g1
 *   not_modified    304: the lease renews, nothing is downloaded
 *   new_generation  200 with g2: g2 activated, g1 pruned
 *   pending         503 snapshot_pending: the replica keeps serving, and the
 *                   next check comes at retry-after, not the poll interval
 *   withdrawn       403 snapshot_access_withdrawn: the replica is deleted now
 *
 * Each step asserts the user-visible result (the status line `hyp status`
 * and `hyp graph replica status` print, the files on disk) and the internal
 * signal that proves the path ran (`replica.check` answers, downloads,
 * activations, the delete reason).
 *
 * Not here: `hyp leave`. The plan's "leave deletes and suspends" was reverted
 * by LLP 0482 (leave keeps the replica), and nothing in leave touches it.
 *
 * @ref LLP 0480#sync [tests]: the check-interpret-download-verify-activate loop against the server answers, end to end
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) throw new Error('fastask_replica_sync: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')

  /** @param {string} name */
  const stepBag = (name) => ({
    [Attr.COMPONENT]: 'smoke', [Attr.OPERATION]: 'step', [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name, [Attr.DEV_RUN_ID]: harness.devRunId, status: 'ok',
  })
  /** @template T @param {string} name @param {() => Promise<T>} fn @returns {Promise<T>} */
  const step = (name, fn) => runRoot(`smoke.step.${name}`, stepBag(name), fn)

  const server = await startFastaskServer()
  const stateDir = path.join(harness.stateDir, 'plugins', '@hypaware/graph-cache')
  /** @type {import('../../../hypaware-plugin-kernel-types.js').StartedSource | undefined} */
  let source
  try {
    // ----- smoke_step: first_sync -----
    await step('first_sync', async () => {
      await server.publish('g1', '2026-10-09T01:00:00.000Z')
      const start = createReplicaSource({
        resolveTarget: async () => ({
          target: 'fx', url: server.url, org: null,
          token: async () => ({ ok: true, token: TOKEN, source: 'env', kind: 'static' }),
        }),
      })
      source = await start(/** @type {any} */ ({ paths: { stateDir }, log: getLogger('plugin-fastask'), config: {} }))
      await waitFor(async () => (await details()).index_generation === 'g1', 15_000, 'g1 indexed')
      const d = await details()
      expect.that('first_sync: state synced on g1', [d.state, d.generation], (v) => v[0] === 'synced' && v[1] === 'g1')
      expect.that('first_sync: both files downloaded once', server.dataRequests().length, (n) => n === 2)
      expect.that('first_sync: the status line says synced with the data age', d.summary_line, (s) => /^team graph: synced, data as of /.test(s))
      expect.that('first_sync: the generation is on disk', await generationsOnDisk(), (g) => g.length === 1)
    })

    // ----- smoke_step: not_modified -----
    await step('not_modified', async () => {
      const checks = server.snapshotChecks().length
      const data = server.dataRequests().length
      await refresh()
      await waitFor(async () => server.snapshotChecks().length > checks && !(await details()).refresh_in_progress, 10_000, 'the 304 check')
      const last = server.snapshotChecks().at(-1)
      expect.that('not_modified: the check carried If-None-Match "g1"', last?.ifNoneMatch, (v) => v === '"g1"')
      expect.that('not_modified: nothing downloaded', server.dataRequests().length, (n) => n === data)
      expect.that('not_modified: still synced on g1', (await details()).generation, (g) => g === 'g1')
    })

    // ----- smoke_step: new_generation -----
    await step('new_generation', async () => {
      await server.publish('g2', '2026-10-09T02:00:00.000Z')
      await refresh()
      await waitFor(async () => (await details()).index_generation === 'g2', 15_000, 'g2 indexed')
      const d = await details()
      expect.that('new_generation: synced on g2', [d.state, d.generation], (v) => v[0] === 'synced' && v[1] === 'g2')
      expect.that('new_generation: g1 pruned once g2 is live', await generationsOnDisk(), (g) => g.length === 1 && g[0] === 'g2')
    })

    // ----- smoke_step: pending -----
    await step('pending', async () => {
      server.state.answer = 'pending'
      server.state.retryAfter = '2'
      const checks = server.snapshotChecks().length
      await refresh()
      await waitFor(async () => (await details()).reason === 'pending', 10_000, 'the 503 answer')
      const d = await details()
      expect.that('pending: the replica keeps serving g2', [d.servable, d.generation], (v) => v[0] === true && v[1] === 'g2')
      expect.that('pending: the status line names the wait', d.summary_line, (s) => /^team graph: /.test(s) && /g2|data as of/.test(String(s)))
      // The next check is the server's retry-after (2 s), not the 15-minute poll.
      await waitFor(() => server.snapshotChecks().length >= checks + 2, 8_000, 'a re-check at retry-after')
      server.state.answer = 'ok'
      await waitFor(async () => (await details()).state === 'synced', 8_000, 'synced again after the server recovered')
    })

    // ----- smoke_step: withdrawn -----
    await step('withdrawn', async () => {
      server.state.answer = 'withdrawn'
      await refresh()
      await waitFor(async () => (await details()).state === 'withdrawn', 10_000, 'the 403 answer')
      const d = await details()
      expect.that('withdrawn: nothing is served', [d.servable, d.generation, d.index_generation], (v) => v[0] === false && v[1] === null && v[2] === null)
      expect.that('withdrawn: the status line says access was withdrawn', d.summary_line, (s) => /^team graph: removed, access to .* was withdrawn$/.test(s))
      expect.that('withdrawn: the generation files are gone', await generationsOnDisk(), (g) => g.length === 0)
    })
  } finally {
    await source?.stop()
    await server.close()
    await obs.shutdown()
  }

  // ----- telemetry: the sync path's spans -----
  const traces = /** @type {any[]} */ (await expect.traces())
  const steps = new Set(traces.filter((t) => t.name?.startsWith('smoke.step.')).map((t) => t.attributes?.smoke_step))
  expect.that('telemetry: every smoke_step ran', [...steps].sort().join(','), (v) => v === 'first_sync,new_generation,not_modified,pending,withdrawn')
  const answers = traces.filter((t) => t.name === 'replica.check').map((t) => String(t.attributes?.answer))
  expect.that('telemetry: replica.check saw 200, 304, 503 and 403', answers, (a) => a.includes('200') && a.includes('304') && a.some((x) => x.startsWith('503')) && a.some((x) => x.startsWith('403')))
  expect.that('telemetry: two generations activated', traces.filter((t) => t.name === 'replica.activate').length, (n) => n === 2)
  expect.that('telemetry: four files downloaded and verified', [traces.filter((t) => t.name === 'replica.download').length, traces.filter((t) => t.name === 'replica.verify').length], (v) => v[0] === 4 && v[1] === 2)
  expect.that('telemetry: replica.index built both generations', traces.filter((t) => t.name === 'replica.index').length, (n) => n >= 2)
  expect.that('telemetry: index ownership and memory were recorded', traces.filter((t) => t.name === 'replica.index'), (rows) => rows.every(t => t.attributes?.index_pid > 0 && t.attributes?.index_rss > t.attributes?.bytes))
  expect.that('telemetry: the delete names its reason', traces.filter((t) => t.name === 'replica.delete').map((t) => t.attributes?.reason), (r) => r.includes('withdrawn'))
  const logs = /** @type {any[]} */ (await expect.logs())
  expect.that('telemetry: the source logged its start', logs.some((l) => l.body === 'fastask.source_started' || l.attributes?.event === 'fastask.source_started' || JSON.stringify(l).includes('fastask.source_started')), (v) => v === true)

  /** The source's status details, as status.json records them. */
  async function details() {
    const status = await /** @type {any} */ (source).status()
    return /** @type {Record<string, any>} */ (status.details)
  }

  /**
   * Start a check through the source's control route, as the CLI does. A
   * refresh is coalesced with a pass already in flight (LLP 0480#sync), so
   * wait for the previous pass to settle first: each step's check is its own.
   */
  async function refresh() {
    await waitFor(async () => !(await details()).refresh_in_progress, 10_000, 'the previous pass to settle')
    const d = await details()
    const token = (await fs.readFile(path.join(stateDir, TOKEN_FILE), 'utf8')).trim()
    const res = await fetch(`http://${d.listen_host}:${d.listen_port}/_hypaware/${REFRESH_ROUTE}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    })
    expect.that('refresh: the control route accepted the request', res.status, (s) => s === 202)
    await res.body?.cancel()
  }

  /** Generation directories of every replica on disk. */
  async function generationsOnDisk() {
    const root = path.join(stateDir, 'replicas')
    /** @type {string[]} */
    const found = []
    for (const key of await fs.readdir(root).catch(() => [])) {
      for (const g of await fs.readdir(path.join(root, key, 'generations')).catch(() => [])) found.push(g)
    }
    return found
  }
}
