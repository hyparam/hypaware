// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions, HypAwareStatusReport } from '../../src/core/daemon/types.js' */

// With no runtime registry attached, `hyp status` takes its `sources:` block
// straight off the daemon's `status.json`. That file outlives the process that
// wrote it, so on a machine whose daemon has exited the block was printing the
// dead daemon's `[started]` two rows under a daemon line reading `not running,
// last state=healthy` - a present-tense claim on a machine capturing nothing
// (issue #1410). These pin that the snapshot is read as a record when nothing
// runs, and still as a claim about now when something does.
// @ref LLP 0348#stale-heartbeat-is-unresponsive [tests]: a snapshot left by an exited daemon is a record, not a claim about now

const NL = String.fromCharCode(10)

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-dead-daemon-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  // Stub the launch-agent probe so the machine's real daemon install cannot
  // leak in; liveness then comes from the pid file alone.
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

/** @param {string} stateRoot */
function writeSnapshot(stateRoot) {
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    healthyAt: new Date().toISOString(),
    uptimeMs: 0,
    sources: [
      { name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started' },
      { name: 'otlp', plugin: '@hypaware/otel', state: 'failed', error: 'bind refused' },
    ],
    sinks: [{ instance: 'central', plugin: '@hypaware/central', kind: 'request' }],
  }))
}

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/** @param {HypAwareStatusReport} report */
function renderText(report) {
  const buf = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/cache', stdout: buf })
  return buf.text()
}

/** @param {string} text */
function sourcesBlock(text) {
  return text.split('  sources:' + NL)[1].split('  sinks:' + NL)[0]
}

test('an exited daemon\'s snapshot sources are not reported as started', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // No pid file: the daemon that wrote the snapshot is gone.
  writeSnapshot(stateRoot)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.running, false, 'no process is running')

  const text = renderText(report)
  assert.match(text, /daemon:.*not running, last state=healthy/, 'the daemon line says so')
  const block = sourcesBlock(text)
  assert.ok(!block.includes('[started]'), 'and no source claims to be started')
  assert.match(block, /ai-gateway.*\[stopped\]/, 'the source is still named, as stopped')
  // `failed` records why the last run went wrong and claims nothing about now,
  // so it survives verbatim with its error.
  assert.match(block, /otlp.*\[failed\]/, 'a failed source keeps its recorded verdict')

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/cache' })
  assert.equal(json.sources[0].state, 'stopped', 'the machine plane agrees')
  assert.equal(json.sources[1].state, 'failed')
  assert.equal(json.sources[1].error, 'bind refused')

  // The sink block carries no liveness word, so it stays the record it is
  // rather than becoming a false `(none)` on a machine that has a sink.
  assert.match(text, /central.*@hypaware\/central, request/)
})

test('a running daemon\'s snapshot sources still render present-tense', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  writeSnapshot(stateRoot)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.running, true, 'a live process owns the pid')

  const block = sourcesBlock(renderText(report))
  assert.match(block, /ai-gateway.*\[started\]/, 'a live daemon\'s source is started')
  assert.match(block, /otlp.*\[failed\]/)
})
