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

/** @import { CollectStatusOptions, HypAwareStatusReport, SourceHealth } from '../../src/core/daemon/types.js' */
/** @import { TestContext } from 'node:test' */

// A source that reports itself broken through the published `lastError` used
// to reach no operator surface at all (issue #1490). These pin the read side:
// what the daemon recorded is on the machine plane whole, and on the text
// plane exactly when the source is saying something is wrong.
// @ref LLP 0394#quiet-when-healthy [tests]: the text plane speaks for a source reporting trouble and stays quiet for one that is not

const NL = String.fromCharCode(10)

/** @param {TestContext} t */
async function makeHome(t) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-source-health-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + NL)
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  return { hypHome, stateRoot }
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
 * @param {string} stateRoot
 * @param {unknown} health
 */
function writeSnapshot(stateRoot, health) {
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    pid: process.pid,
    healthyAt: new Date().toISOString(),
    uptimeMs: 0,
    sources: [{ name: 'github', plugin: '@hypaware/github', state: 'started', health }],
    sinks: [],
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

test('a source reporting a failure says so on both planes', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  writeSnapshot(stateRoot, /** @type {SourceHealth} */ ({
    state: 'degraded',
    message: 'polling every 5m',
    rowsWritten: 12,
    lastError: 'projection budget exhausted',
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const block = sourcesBlock(renderText(report))
  assert.match(block, /github.*\[started\]/, 'the lifecycle verdict is unchanged')
  assert.match(block, /reports degraded: projection budget exhausted/, 'and the source is heard')

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/cache' })
  assert.deepEqual(json.sources[0].health, {
    state: 'degraded',
    message: 'polling every 5m',
    rows_written: 12,
    last_error: 'projection budget exhausted',
  })
})

test('a healthy source adds no line to the text plane and still answers the machine one', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  writeSnapshot(stateRoot, /** @type {SourceHealth} */ ({
    state: 'ready',
    message: 'polling every 5m',
    rowsWritten: 12,
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const block = sourcesBlock(renderText(report))
  assert.equal(block.split(NL).filter((line) => line.trim().length > 0).length, 1, 'one line, as before')
  assert.ok(!block.includes('reports'), 'a working source says nothing extra')

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/cache' })
  assert.deepEqual(json.sources[0].health, { state: 'ready', message: 'polling every 5m', rows_written: 12 })
})

test('a ready source still reporting a last error is not silent', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  // `ready` with a `lastError` is what a source that recovered but wants the
  // last failure remembered looks like. The word is not what makes it worth
  // printing; the error is.
  writeSnapshot(stateRoot, /** @type {SourceHealth} */ ({ state: 'ready', lastError: 'token expired' }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.match(sourcesBlock(renderText(report)), /reports ready: token expired/)
})

test('a hostile or absent health does not break either plane', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  // `readStatusFile` validates only "is an object", so `health` can be any
  // JSON value, written by any build. `hyp status` is the one command an
  // operator runs on a broken install: it has to answer.
  for (const health of [undefined, 'degraded', 5, null, {}, { state: 'nonsense' }]) {
    writeSnapshot(stateRoot, health)
    const report = await collectHypAwareStatus(collectOpts(hypHome))
    const block = sourcesBlock(renderText(report))
    assert.match(block, /github.*\[started\]/, `source still rendered for health ${JSON.stringify(health)}`)
    assert.ok(!block.includes('reports'), 'and nothing unusable is reported as health')
    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/cache' })
    assert.equal(json.sources[0].health, undefined, 'nor carried onto the machine plane')
  }
})

test('a terminal escape in a reported error cannot repaint the screen', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  // The daemon cleans these at the point of record, but the file outlives the
  // build that wrote it, so the render cleans them again like every other
  // string it reads back out of status.json.
  const esc = String.fromCharCode(27)
  writeSnapshot(stateRoot, /** @type {SourceHealth} */ ({
    state: 'error',
    lastError: `${esc}[2Kforged${NL}  daemon: healthy`,
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const block = sourcesBlock(renderText(report))
  assert.ok(!block.includes(esc), 'no escape reaches the terminal')
  assert.equal(block.trim().split(NL).length, 2, 'and no forged line either')
})
