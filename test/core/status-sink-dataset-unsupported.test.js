// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { createHeldDatasetStore, heldDatasetsPath } from '../../src/core/sinks/held_datasets.js'
import { instanceWatermarkStateDir } from '../../src/core/sinks/incremental.js'
import { pluginStateDir } from '../../src/core/runtime/paths.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// @ref LLP 0537#status-warning [tests]: a fresh status read names held datasets for the configured destination only, and degrades
const URL = 'http://server.example:8740'

/**
 * @param {Record<string, unknown>} [sinks]
 */
async function makeHome(sinks) {
  const hypHome = temporaryDirectory('hyp-status-held-')
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  const config = { version: 2, plugins: [{ name: '@hypaware/central' }], ...(sinks ? { sinks } : {}) }
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify(config) + '\n')
  const instanceDir = instanceWatermarkStateDir(pluginStateDir(stateRoot, '@hypaware/central'), 'central')
  return { hypHome, instanceDir }
}

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

/**
 * @param {string} dir
 * @param {string} destination
 * @param {string[]} names
 */
async function hold(dir, destination, names) {
  const store = createHeldDatasetStore({ stateDir: dir, destination })
  for (const name of names) await store.hold(name)
}

const CENTRAL_SINK = { central: { plugin: '@hypaware/central', config: { url: URL } } }

/** @param {Awaited<ReturnType<typeof collectHypAwareStatus>>} report */
const held = (report) => report.diagnostics.filter((d) => d.kind === 'sink_dataset_unsupported')

test('held datasets warn from disk alone and degrade the verdict', async () => {
  const { hypHome, instanceDir } = await makeHome(CENTRAL_SINK)
  const clean = await collectHypAwareStatus(collectOpts(hypHome))
  assert.deepEqual(held(clean), [])
  assert.equal(clean.overall, 'healthy', JSON.stringify(clean.diagnostics.map((d) => d.kind)))

  await hold(instanceDir, URL, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'])
  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diags = held(report)
  assert.equal(diags.length, 1)
  assert.equal(diags[0].severity, 'warning')
  assert.equal(diags[0].message, 'central: the server cannot accept 7 datasets (a1, a2, a3, a4, a5 and 2 more); their rows stay local')
  assert.match(diags[0].repair[0], /upgrade the server/)
  assert.equal(report.overall, 'degraded')
  assert.equal(report.diagnostics.some((d) => d.kind === 'sink_export_failing'), false, 'not a transport failure')
})

test('a hold recorded for another server does not warn', async () => {
  const { hypHome, instanceDir } = await makeHome(CENTRAL_SINK)
  await hold(instanceDir, 'http://old-server.example:8740', ['graph_edges'])
  assert.deepEqual(held(await collectHypAwareStatus(collectOpts(hypHome))), [])
})

test('a removed destination does not warn', async () => {
  const { hypHome, instanceDir } = await makeHome()
  await hold(instanceDir, URL, ['graph_edges'])
  assert.deepEqual(held(await collectHypAwareStatus(collectOpts(hypHome))), [])
})

test('an unreadable snapshot warns instead of reading as healthy', async () => {
  const { hypHome, instanceDir } = await makeHome(CENTRAL_SINK)
  await fs.mkdir(instanceDir, { recursive: true })
  await fs.writeFile(heldDatasetsPath(instanceDir), 'not json')
  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diags = held(report)
  assert.equal(diags.length, 1)
  assert.match(diags[0].message, /^central: held-dataset state is unreadable \(corrupt\)/)
  assert.equal(report.overall, 'degraded')
})
