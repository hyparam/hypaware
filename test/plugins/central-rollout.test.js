// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDatasetRolloutStore } from '../../hypaware-core/plugins-workspace/central/src/rollout.js'

test('dataset rollout state persists per sink instance and distinguishes missing from corrupt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-central-rollout-'))
  try {
    const store = createDatasetRolloutStore({
      paths: /** @type {any} */ ({ stateDir: root }),
      instanceName: 'central-primary',
    })

    assert.equal(await store.read('claude_telemetry_events'), null)
    const written = await store.write(
      'claude_telemetry_events',
      ['source=unknown', 'source=claude', 'source=unknown'],
      null
    )
    assert.deepEqual(written.partitions, ['source=claude', 'source=unknown'])
    assert.deepEqual(await store.read('claude_telemetry_events'), written)

    await fs.writeFile(store.filePath('claude_telemetry_events'), '{not-json', 'utf8')
    await assert.rejects(
      store.read('claude_telemetry_events'),
      /rollout state .* is corrupt/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('dataset rollout state rejects unsafe persisted partition keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-central-rollout-'))
  try {
    const store = createDatasetRolloutStore({
      paths: /** @type {any} */ ({ stateDir: root }),
      instanceName: 'central-primary',
    })
    await assert.rejects(
      store.write('claude_telemetry_events', ['../../outside'], null),
      /rollout partition key/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
