// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// Issue #2547 part 4. A configured sink that never materialized has no row in
// the snapshot, so the daemon reported `healthy` and `hyp status` had nothing
// to name while nothing was exported. The daemon now degrades its boot and
// persists one warning per failed instance; `hyp status` raises it as an error.

const WARNING = "sink_materialize_failed: sink 'central' (sink_plugin_not_active): sink 'central': plugin '@hypaware/central' is not active"

async function makeHome() {
  const hypHome = temporaryDirectory('hyp-status-sink-materialize-')
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} stateRoot
 * @param {string[]} warnings
 */
function writeDegradedDaemon(stateRoot, warnings) {
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'foreground' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({ state: 'degraded', sources: [], sinks: [], warnings }))
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

test('a live daemon whose sink did not materialize reports it as an error', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeDegradedDaemon(stateRoot, [WARNING, 'processing_unavailable: unrelated'])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diags = report.diagnostics.filter((d) => d.kind === 'sink_materialize_failed')
  assert.equal(diags.length, 1)
  assert.equal(diags[0].severity, 'error')
  assert.match(diags[0].message, /sink 'central' \(sink_plugin_not_active\): sink 'central': plugin '@hypaware\/central' is not active/)
  assert.ok(diags[0].repair[0].startsWith('grep -s sink_materialize_failed '))
  assert.equal(report.overall, 'degraded')
})

test('a snapshot without the warning raises nothing', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeDegradedDaemon(stateRoot, ['processing_unavailable: unrelated'])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.some((d) => d.kind === 'sink_materialize_failed'), false)
})
