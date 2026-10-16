// @ts-check

import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'

import { startGraphSource, FIRST_PROJECTION_DELAY_MS, PROJECTION_INTERVAL_MS } from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/source.js'

/** @import { TestContext } from 'node:test' */

/** @param {TestContext} t */
async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = { rowCount: 1, epoch: 0, pending: false, calls: 0, discoveryError: false }
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
    },
    query: { getDataset: () => ({ discoverPartitions: async () => [{ tablePath: '/cache/spool' }] }) },
    log: {
      info: (event, attrs) => logs.push({ event, attrs }),
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
