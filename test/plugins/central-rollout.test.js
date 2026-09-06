// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  bindDestinationState,
  createDatasetRolloutStore,
  markDestinationStateReady,
} from '../../hypaware-core/plugins-workspace/central/src/rollout.js'

test('destination state separates organizations and resumes each destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-central-destination-'))
  const paths = /** @type {any} */ ({ stateDir: root })
  try {
    const acme = await bindDestinationState({
      paths,
      instanceName: 'central',
      destination: { origin: 'https://central.example/path', org: 'acme.test' },
    })
    assert.equal(acme.phase, 'initializing-history')
    assert.equal(acme.destination.origin, 'https://central.example')
    assert.equal(acme.adoptedLegacy, false)

    // Simulate a crash after rollout state started but before the destination
    // binding became ready. Rebinding must preserve retained-history mode.
    const rollout = createDatasetRolloutStore({ stateDir: acme.stateDir })
    await rollout.write('claude_telemetry_events', ['source=claude'], null)
    const resumedInitialization = await bindDestinationState({
      paths,
      instanceName: 'central',
      destination: { origin: 'https://central.example', org: 'acme.test' },
    })
    assert.equal(resumedInitialization.phase, 'initializing-history')

    const acmeReady = await markDestinationStateReady(resumedInitialization)
    assert.equal(acmeReady.phase, 'ready')
    const beta = await bindDestinationState({
      paths,
      instanceName: 'central',
      destination: { origin: 'https://central.example', org: 'beta.test' },
    })
    assert.equal(beta.phase, 'initializing-history')
    assert.notEqual(beta.stateDir, acme.stateDir)

    await markDestinationStateReady(beta)
    const returnedAcme = await bindDestinationState({
      paths,
      instanceName: 'central',
      destination: { origin: 'https://central.example', org: 'acme.test' },
    })
    const returnedBeta = await bindDestinationState({
      paths,
      instanceName: 'central',
      destination: { origin: 'https://central.example', org: 'beta.test' },
    })
    assert.equal(returnedAcme.stateDir, acme.stateDir)
    assert.equal(returnedAcme.phase, 'ready')
    assert.equal(returnedBeta.stateDir, beta.stateDir)
    assert.equal(returnedBeta.phase, 'ready')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('existing unscoped progress is adopted once for the current destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-central-destination-'))
  const instanceDir = path.join(root, 'sink-instances', 'central')
  try {
    const watermarkPath = path.join(instanceDir, 'watermarks', 'logs', 'source=claude.json')
    await fs.mkdir(path.dirname(watermarkPath), { recursive: true })
    await fs.writeFile(watermarkPath, '{}', 'utf8')

    const bound = await bindDestinationState({
      paths: /** @type {any} */ ({ stateDir: root }),
      instanceName: 'central',
      destination: { origin: 'https://central.example', org: 'acme.test' },
    })
    assert.equal(bound.stateDir, instanceDir)
    assert.equal(bound.phase, 'ready')
    assert.equal(bound.adoptedLegacy, true)

    const binding = JSON.parse(await fs.readFile(path.join(instanceDir, 'destination.json'), 'utf8'))
    assert.deepEqual(binding.destination, { origin: 'https://central.example', org: 'acme.test' })
    assert.equal(binding.phase, 'ready')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

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
