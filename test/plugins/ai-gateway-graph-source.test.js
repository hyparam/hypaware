// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'

import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { executeQuerySql } from '../../src/core/query/sql.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import { createSourceRegistry } from '../../src/core/registry/sources.js'
import { aiGatewayDatasetRegistration, DATASET_NAME } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { startGraphSource, FIRST_PROJECTION_DELAY_MS, PROJECTION_INTERVAL_MS, STOP_GRACE_MS } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/source.js'
import { createAiGatewayGraphContract } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js'
import { edgeId, makeRowBuilders, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import { graphDatasetRegistration } from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'
import { projectGraph } from '../../hypaware-core/plugins-workspace/context-graph/src/project.js'

/** @import { TestContext } from 'node:test' */

/** @param {TestContext} t */
async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = { rowCount: 1, epoch: 0, pending: false, calls: 0, discoveryError: false, appends: /** @type {string[]} */ ([]) }
  /** @type {Array<{ event: string, attrs: any }>} */
  const logs = []
  const ctx = /** @type {any} */ ({
    storage: {
      cacheRoot: '/cache',
      discoverCachePartitions: async () => {
        if (state.discoveryError) throw new Error('discovery failed')
        return [{ path: '/cache/messages', epoch: state.epoch, rowCount: state.rowCount }]
      },
      hasPendingSync: () => state.pending,
      cacheTablePath: (dataset) => `/cache/${dataset}`,
      appendRows: async (tablePath) => { state.appends.push(tablePath) },
    },
    query: { getDataset: () => ({ discoverPartitions: async () => [{ tablePath: '/cache/spool' }] }) },
    log: {
      info: (event, attrs) => logs.push({ event, attrs }),
      warn: (event, attrs) => logs.push({ event, attrs }),
      error: (event, attrs) => logs.push({ event, attrs }),
    },
  })
  const graph = /** @type {any} */ ({
    project: async (dataset) => {
      assert.equal(dataset, 'ai_gateway_messages')
      state.calls++
      return { nodes: 2, edges: 1, nodesWritten: 2, edgesWritten: 1 }
    },
  })
  const source = await startGraphSource(ctx, graph)
  t.after(() => source.stop())
  /** @param {number} ms */
  async function advance(ms) {
    t.mock.timers.tick(ms)
    await setImmediate()
  }
  return { state, logs, ctx, graph, source, advance }
}

test('startup catches up, idle skips scans, committed and pending-only changes project', async t => {
  const f = await fixture(t)
  assert.equal(f.state.calls, 0, 'start does not block on projection')
  await f.advance(FIRST_PROJECTION_DELAY_MS)
  assert.equal(f.state.calls, 1)
  await f.advance(PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 1, 'idle tick does not call the projection engine')
  f.state.rowCount++
  await f.advance(PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 2)
  f.state.pending = true
  await f.advance(PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 3, 'unflushed rows reach the trigger')
  f.state.pending = false
  f.state.epoch++
  await f.advance(PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 4)
  assert.equal((await f.source.status?.())?.rowsWritten, 12)
  assert.ok(f.logs.some(l => l.event === 'graph.projection_completed' && l.attrs.nodes_written === 2))

  await f.source.stop()
  const restarted = await startGraphSource(f.ctx, f.graph)
  t.after(() => restarted.stop())
  await f.advance(FIRST_PROJECTION_DELAY_MS)
  assert.equal(f.state.calls, 5, 'restart catches up without a metadata change')
})

test('projection failures retry after a pending spool disappears; metadata failures recover', async t => {
  const f = await fixture(t)
  await f.advance(FIRST_PROJECTION_DELAY_MS)
  const project = f.graph.project
  f.state.pending = true
  f.graph.project = async () => {
    f.state.pending = false
    throw new Error('write failed')
  }
  await f.advance(PROJECTION_INTERVAL_MS)
  assert.equal((await f.source.status?.())?.state, 'error')
  assert.match((await f.source.status?.())?.lastError ?? '', /write failed/)
  assert.ok(f.logs.some(l => l.event === 'graph.projection_failed'))
  f.graph.project = project
  await f.advance(PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 2, 'unchanged fingerprint still retries failed work')
  assert.equal((await f.source.status?.())?.state, 'ready')
  f.state.discoveryError = true
  await f.advance(PROJECTION_INTERVAL_MS)
  assert.match((await f.source.status?.())?.lastError ?? '', /discovery failed/)
  f.state.discoveryError = false
  await f.advance(PROJECTION_INTERVAL_MS)
  assert.equal((await f.source.status?.())?.lastError, undefined)
})

test('capture during projection stays due, ticks do not overlap, and stop awaits work', async t => {
  const f = await fixture(t)
  const project = f.graph.project
  /** @type {() => void} */
  let finish = () => {}
  f.graph.project = async () => {
    const result = await project('ai_gateway_messages')
    await new Promise(resolve => { finish = () => resolve(undefined) })
    return result
  }
  await f.advance(FIRST_PROJECTION_DELAY_MS)
  f.state.rowCount++
  await f.advance(3 * PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 1)
  finish()
  await setImmediate()
  f.graph.project = project
  await f.advance(PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 2, 'pre-projection fingerprint preserves concurrent capture')

  f.state.rowCount++
  f.graph.project = async () => {
    await new Promise(resolve => { finish = () => resolve(undefined) })
    return project('ai_gateway_messages')
  }
  await f.advance(PROJECTION_INTERVAL_MS)
  let stopped = false
  const stopping = f.source.stop().then(() => { stopped = true })
  await setImmediate()
  assert.equal(stopped, false)
  finish()
  await stopping
  assert.equal((await f.source.status?.())?.state, 'stopped')
  await f.advance(2 * PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 3, 'shutdown never schedules another tick')
})

test('stop before the first tick cancels startup projection', async t => {
  const f = await fixture(t)
  await f.source.stop()
  await f.advance(FIRST_PROJECTION_DELAY_MS + PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 0)
})

/**
 * Route the fixture's capability through the real engine with a scripted SQL seam.
 * @param {any} f
 * @param {any} executeSql scripted SQL seam; resolves `{ rows }`
 */
function realProjection(f, executeSql) {
  f.graph.project = async (dataset, options) => {
    f.state.calls++
    return projectGraph({
      query: f.ctx.query,
      storage: f.ctx.storage,
      contracts: [{
        name: 'stop-probe',
        plugin: '@test/stop',
        sourceDataset: dataset,
        projector: 'test.t0',
        projectorVersion: 1,
        rules: [{ kind: 'node', type: 'Session', columns: ['session_id'], toRow: r => ({ node_id: `n-${r.session_id}`, first_seen: '2026-01-01T00:00:00.000Z' }) }],
      }],
      signal: options?.signal,
      __executeSql: executeSql,
    })
  }
}

test('stop cancels a stalled projection scan at once, writes nothing, and the next start catches up', async t => {
  const f = await fixture(t)
  /** @type {AbortSignal | undefined} */
  let seen
  realProjection(f, args => {
    seen = args.signal
    return new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }))
  })
  await f.advance(FIRST_PROJECTION_DELAY_MS)
  assert.equal(f.state.calls, 1)
  assert.ok(seen, 'the scan carries the stop signal')
  await f.source.stop()
  assert.deepEqual(f.state.appends, [], 'a cancelled projection writes no graph rows')
  assert.ok(f.logs.some(l => l.event === 'graph.projection_cancelled'))
  assert.ok(!f.logs.some(l => l.event === 'graph.projection_failed' || l.event === 'graph.projection_abandoned'))
  assert.equal((await f.source.status?.())?.lastError, undefined)

  realProjection(f, async () => ({ rows: [{ session_id: 's1' }] }))
  const restarted = await startGraphSource(f.ctx, f.graph)
  t.after(() => restarted.stop())
  await f.advance(FIRST_PROJECTION_DELAY_MS)
  assert.equal(f.state.calls, 2)
  assert.deepEqual(f.state.appends, ['/cache/node'], 'the next start projects the same rows')
})

test('stop after the reads but before the writes starts no graph write', async t => {
  const f = await fixture(t)
  /** @type {Promise<void> | undefined} */
  let stopping
  realProjection(f, async args => {
    if (args.query === 'SELECT node_id FROM node') stopping = f.source.stop()
    return { rows: args.query.includes('ai_gateway_messages') ? [{ session_id: 's1' }] : [] }
  })
  await f.advance(FIRST_PROJECTION_DELAY_MS)
  await stopping
  assert.equal(f.state.calls, 1)
  assert.deepEqual(f.state.appends, [])
  assert.ok(f.logs.some(l => l.event === 'graph.projection_cancelled'))
})

test('stop returns at the grace when a projection ignores the signal, and the next start catches up', async t => {
  const f = await fixture(t)
  const project = f.graph.project
  /** @type {() => void} */
  let release = () => {}
  f.graph.project = async () => {
    f.state.calls++
    await new Promise(resolve => { release = () => resolve(undefined) })
    return { nodes: 0, edges: 0, nodesWritten: 0, edgesWritten: 0 }
  }
  await f.advance(FIRST_PROJECTION_DELAY_MS)
  assert.equal(f.state.calls, 1)
  let stopped = false
  const stopping = f.source.stop().then(() => { stopped = true })
  await f.advance(STOP_GRACE_MS - 1)
  assert.equal(stopped, false, 'stop still waits inside the grace')
  await f.advance(1)
  await stopping
  assert.equal(stopped, true)
  assert.ok(f.logs.some(l => l.event === 'graph.projection_abandoned' && l.attrs.grace_ms === STOP_GRACE_MS))

  f.graph.project = project
  const restarted = await startGraphSource(f.ctx, f.graph)
  t.after(() => restarted.stop())
  await f.advance(FIRST_PROJECTION_DELAY_MS)
  assert.equal(f.state.calls, 2, 'the next start projects again')
  const completed = f.logs.filter(l => l.event === 'graph.projection_completed').length
  release()
  await setImmediate()
  await f.advance(2 * PROJECTION_INTERVAL_MS)
  assert.equal(f.state.calls, 2, 'the abandoned projection never schedules another tick')
  assert.equal(f.logs.filter(l => l.event === 'graph.projection_completed').length, completed, 'the abandoned run is not reported as completed')
  assert.ok(f.logs.some(l => l.event === 'graph.projection_cancelled' && l.attrs.reason === 'abandoned_at_stop_grace'))
})

// The round 2 reviewer probe (write-after-stop.mjs): real source registry,
// contract, engine, SQL and on-disk cache, with the first graph append held
// past the stop grace. Once it settles, no further graph write may start.
test('a projection abandoned during its first append starts no further write once that append settles', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-late-write-'))
  const query = createQueryRegistry()
  for (const d of [aiGatewayDatasetRegistration(), graphDatasetRegistration('node'), graphDatasetRegistration('edge')]) query.registerDataset(d)
  const row = { session_id: 'sess-1', conversation_id: null, cwd: '/repo', git_branch: 'main', client_name: 'claude-code', user_id: 'u1', model: 'sonnet', tool_name: null, tool_args: null, part_type: 'text', role: 'user', content_text: 'synthetic', message_created_at: new Date().toISOString(), attributes: '{}' }
  const columns = Object.keys(row).map(name => ({ name, type: 'STRING', nullable: name !== 'session_id' }))
  /** @type {Array<{ event: string, dataset?: string, stopped?: boolean, aborted?: boolean, attrs?: any }>} */
  const events = []
  /** @type {() => void} */
  let release = () => {}
  /** @type {() => void} */
  let entered = () => {}
  const gate = new Promise(resolve => { release = () => resolve(undefined) })
  const entry = new Promise(resolve => { entered = () => resolve(undefined) })
  /** @type {Promise<unknown> | undefined} */
  let projection
  /** @type {AbortSignal | undefined} */
  let signal
  let stopped = false
  const registry = createSourceRegistry()
  try {
    await appendRowsToSourceTable(cacheRoot, DATASET_NAME, ['source=claude'], /** @type {any} */ (columns), [row])
    const storage = createQueryStorageService({ cacheRoot })
    const append = storage.appendRows.bind(storage)
    storage.appendRows = async (table, cols, rows) => {
      const dataset = cols.some(c => c.name === 'node_id') ? 'node' : 'edge'
      events.push({ event: 'append-start', dataset, stopped, aborted: signal?.aborted })
      if (dataset === 'node') {
        entered()
        await gate
      }
      await append(table, cols, rows)
      events.push({ event: 'append-done', dataset, stopped })
    }
    /** @param {string} event @param {any} attrs */
    const log = (event, attrs) => { events.push({ event, attrs }) }
    const ctx = /** @type {any} */ ({ query, storage, log: { info: log, warn: log, error: log } })
    const graph = /** @type {any} */ ({
      project: (/** @type {string} */ _dataset, /** @type {any} */ opts) => {
        signal = opts.signal
        projection = projectGraph({ query, storage, contracts: [createAiGatewayGraphContract({ nodeId, edgeId, makeRowBuilders })], signal })
        return projection
      },
    })
    registry.register(/** @type {any} */ ({ name: 'ai-gateway-graph', plugin: '@hypaware/ai-gateway-graph', summary: 'probe', start: () => startGraphSource(ctx, graph) }))
    await registry.start('ai-gateway-graph', ctx)
    await entry

    await registry.stop('ai-gateway-graph')
    stopped = true
    assert.equal(signal?.aborted, true)
    assert.ok(events.some(e => e.event === 'graph.projection_abandoned'), 'stop returned at the grace')

    release()
    await assert.rejects(/** @type {Promise<unknown>} */ (projection), { name: 'AbortError' })
    await setImmediate()
    assert.deepEqual(events.filter(e => e.event === 'append-start').map(e => e.dataset), ['node'], 'only the append under way at stop ran')
    assert.deepEqual(events.filter(e => e.event === 'append-start' && e.stopped), [], 'no write starts after stop')
    assert.ok(!events.some(e => e.event === 'graph.projection_completed'), 'an abandoned run is not reported as completed')
    assert.ok(events.some(e => e.event === 'graph.projection_cancelled' && e.attrs.reason === 'abandoned_at_stop_grace'))

    const nodes = await executeQuerySql({ query: 'SELECT COUNT(*) AS n FROM node', registry: query, storage, refresh: 'always', includeLocalOnly: true })
    assert.equal(Number(nodes.rows[0].n), 3, 'the node append under way at stop settled')
    const edges = await executeQuerySql({ query: 'SELECT COUNT(*) AS n FROM edge', registry: query, storage, refresh: 'always', includeLocalOnly: true })
    assert.equal(Number(edges.rows[0].n), 0, 'no edge was written')
  } finally {
    release()
    await projection?.catch(() => {})
    await registry.stop('ai-gateway-graph')
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
