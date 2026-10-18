// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { createHeldDatasetStore, heldDatasetsPath, readHeldDatasets } from '../../src/core/sinks/held_datasets.js'

// @ref LLP 0537#snapshot [tests]: current holds only, scoped to the destination, durable across processes
const URL_A = 'https://server-a.example:8740'
const URL_B = 'https://server-b.example:8740'

test('a hold is durable for a fresh reader and never writes the URL', async () => {
  const dir = temporaryDirectory('hyp-held-')
  const store = createHeldDatasetStore({ stateDir: dir, destination: URL_A })
  await store.load(new Set(['graph_edges', 'claude_telemetry_events']))
  await store.hold('graph_edges')
  await store.hold('claude_telemetry_events')
  await store.hold('graph_edges')

  assert.deepEqual(await readHeldDatasets(dir, URL_A), { datasets: ['claude_telemetry_events', 'graph_edges'] })
  const raw = await fs.readFile(heldDatasetsPath(dir), 'utf8')
  assert.equal(raw.includes('server-a'), false)
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['datasets', 'destination', 'updatedAt', 'v'])

  await store.clear('graph_edges')
  assert.deepEqual(await readHeldDatasets(dir, URL_A), { datasets: ['claude_telemetry_events'] })
})

test('another destination inherits nothing, and load drops the old record', async () => {
  const dir = temporaryDirectory('hyp-held-')
  const first = createHeldDatasetStore({ stateDir: dir, destination: URL_A })
  await first.load(new Set(['graph_edges']))
  await first.hold('graph_edges')

  assert.deepEqual(await readHeldDatasets(dir, URL_B), { datasets: [] })

  const replaced = createHeldDatasetStore({ stateDir: dir, destination: URL_B })
  await replaced.load(new Set(['graph_edges']))
  assert.deepEqual(await readHeldDatasets(dir, URL_A), { datasets: [] }, 'the old server\'s hold is gone, not parked')
})

test('load keeps only datasets still eligible to forward', async () => {
  const dir = temporaryDirectory('hyp-held-')
  const before = createHeldDatasetStore({ stateDir: dir, destination: URL_A })
  await before.load(new Set(['a', 'b', 'c']))
  await before.hold('a')
  await before.hold('b')
  await before.hold('c')

  const restarted = createHeldDatasetStore({ stateDir: dir, destination: URL_A })
  await restarted.load(new Set(['b', 'd']))
  assert.deepEqual(await readHeldDatasets(dir, URL_A), { datasets: ['b'] })
  // The loaded hold is live state: clearing it after a restart persists.
  await restarted.clear('b')
  assert.deepEqual(await readHeldDatasets(dir, URL_A), { datasets: [] })
})

test('an unparseable record reads as unreadable, never as empty, and load repairs it', async () => {
  const dir = temporaryDirectory('hyp-held-')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(heldDatasetsPath(dir), '{"v":1,')
  assert.deepEqual(await readHeldDatasets(dir, URL_A), { unreadable: 'corrupt' })

  await fs.writeFile(heldDatasetsPath(dir), JSON.stringify({ v: 1, destination: 'x', datasets: [7] }))
  assert.deepEqual(await readHeldDatasets(dir, URL_A), { unreadable: 'invalid' })

  const store = createHeldDatasetStore({ stateDir: dir, destination: URL_A })
  await store.load(new Set(['a']))
  assert.deepEqual(await readHeldDatasets(dir, URL_A), { datasets: [] })
})

test('a failed write rejects and the next call rewrites the lost state', async () => {
  const root = temporaryDirectory('hyp-held-')
  await fs.mkdir(root, { recursive: true })
  const blocker = path.join(root, 'blocker')
  await fs.writeFile(blocker, '')
  const dir = path.join(blocker, 'instance')
  const store = createHeldDatasetStore({ stateDir: dir, destination: URL_A })

  await assert.rejects(store.hold('graph_edges'))
  await fs.rm(blocker)
  // Same name, already held in memory: a clean store would skip this call.
  await store.hold('graph_edges')
  assert.deepEqual(await readHeldDatasets(dir, URL_A), { datasets: ['graph_edges'] })
})

test('overlapping holds and clears land in call order', async () => {
  const dir = temporaryDirectory('hyp-held-')
  const store = createHeldDatasetStore({ stateDir: dir, destination: URL_A })
  await Promise.all([
    store.hold('a'),
    store.hold('b'),
    store.clear('a'),
    store.hold('c'),
    store.clear('c'),
    store.hold('a'),
    store.clear('b'),
  ])
  assert.deepEqual(await readHeldDatasets(dir, URL_A), { datasets: ['a'] })
})
