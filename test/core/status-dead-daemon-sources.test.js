// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, statusFilePath, writeStatusFile } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { runDaemonStatus } from '../../src/core/commands/daemon.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions, HypAwareStatusReport } from '../../src/core/daemon/types.js' */
/** @import { TestContext } from 'node:test' */

// With no runtime registry attached, `hyp status` takes its `sources:` block
// straight off the daemon's `status.json`. That file outlives the process that
// wrote it, so on a machine whose daemon has exited the block was printing the
// dead daemon's `[started]` two rows under a daemon line reading `not running,
// last state=healthy` - a present-tense claim on a machine capturing nothing
// (issue #1410). These pin that the snapshot is read as a record when nothing
// runs, and still as a claim about now when something does.
// @ref LLP 0348#stale-heartbeat-is-unresponsive [tests]: a snapshot left by an exited daemon is a record, not a claim about now

const NL = String.fromCharCode(10)

/** @param {TestContext} t */
async function makeHome(t) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-dead-daemon-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
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

test('an exited daemon\'s snapshot sources are not reported as started', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
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

test('a dead daemon publishes the verdict on one machine surface and the record on the other', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  // One dead run read on both machine surfaces. `hyp status --json` renders
  // the collector's report, so it says what is up now; `hyp daemon status
  // --json` is the status file's copy, so it says what the run last recorded.
  // Issue #1416 asked which of the two the first surface carries, and this
  // pins both: neither reading is lost, and each is on the command whose
  // subject it is.
  // @ref LLP 0385#the-file-copy-is-daemon-status [tests]: the terminal recorded state stays reachable on the machine plane, on the surface whose contract is the file
  writeSnapshot(stateRoot)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/cache' })
  assert.equal(json.sources[0].state, 'stopped', 'hyp status --json reports the verdict')

  const stdout = makeBuf()
  const code = await runDaemonStatus(['--json'], /** @type {any} */ ({
    env: { HYP_HOME: hypHome },
    stdout,
    stderr: makeBuf(),
  }))
  assert.equal(code, 0)
  const recorded = JSON.parse(stdout.text())
  assert.equal(recorded.running, false, 'the same dead daemon')
  assert.equal(recorded.sources[0].state, 'started', 'and the file copy still carries what it recorded')
  assert.equal(recorded.sources[1].state, 'failed')
})

test('a running daemon\'s snapshot sources still render present-tense', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  writeSnapshot(stateRoot)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.running, true, 'a live process owns the pid')

  const block = sourcesBlock(renderText(report))
  assert.match(block, /ai-gateway.*\[started\]/, 'a live daemon\'s source is started')
  assert.match(block, /otlp.*\[failed\]/)
})

test('a live pid the daemon did not take does not revive its predecessor\'s sources', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  // `processIsAlive` proves a pid is taken, not that the daemon took it: after
  // a hard kill the OS is free to reissue the number, and the collector already
  // derives `snapshotIsThisProcess` for exactly that (LLP 0348). Reading
  // `daemon.running` alone would let the dead run's `started` through on the
  // machine issue #1410 is about.
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    pid: process.pid + 1,
    healthyAt: new Date().toISOString(),
    uptimeMs: 0,
    sources: [{ name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started' }],
    sinks: [],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.daemon.running, true, 'the pid is taken')

  const block = sourcesBlock(renderText(report))
  assert.ok(!block.includes('[started]'), 'but not by the daemon that wrote the snapshot')
  assert.match(block, /ai-gateway.*\[stopped\]/)
})

test('a status file whose sources are not a list does not break the report', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  // `readStatusFile` validates only "is an object", so `sources` can be any
  // JSON value at all. A string has a `length` and no `.map`, and `hyp status`
  // is the one command an operator runs on a broken install: it has to answer.
  await fs.writeFile(statusFilePath(stateRoot), JSON.stringify({
    state: 'healthy',
    sources: 'abcd',
    sinks: [],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const text = renderText(report)
  assert.match(text, /daemon:.*not running/, 'the report is still rendered')
  assert.match(sourcesBlock(text), /\(none\)/, 'and an unreadable list names no sources')
})

test('a non-object entry inside the snapshot lists does not break the report', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  // Same reason the list itself is shape-checked: `readStatusFile` knows only
  // that it read an object, so an entry can be any JSON value. Every reader
  // past the fallback dereferences `.name` / `.instance`, so a `null` left in
  // the list would take `hyp status` out at the render instead.
  await fs.writeFile(statusFilePath(stateRoot), JSON.stringify({
    state: 'healthy',
    sources: [null, { name: 'otlp', plugin: '@hypaware/otel', state: 'started' }],
    sinks: [null, { instance: 'central', plugin: '@hypaware/central', kind: 'request' }],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const text = renderText(report)
  assert.match(sourcesBlock(text), /otlp.*\[stopped\]/, 'the readable source still renders')
  assert.equal(report.sources.length, 1, 'and the unreadable entry is dropped, not carried')
  assert.equal(report.sinks.length, 1)
  assert.match(text, /central.*@hypaware\/central, request/)
})

test('a status file whose sinks are not a list does not break the report', async (t) => {
  const { hypHome, stateRoot } = await makeHome(t)
  // A number is not iterable, so the spread threw straight out of the
  // collector; a string is, so it spread into one blank row per character.
  for (const sinks of [5, 'ab']) {
    await fs.writeFile(statusFilePath(stateRoot), JSON.stringify({ state: 'healthy', sources: [], sinks }))
    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.deepEqual(report.sinks, [], `sinks ${JSON.stringify(sinks)} names no sink`)
    assert.match(renderText(report), /daemon:.*not running/, 'and the report is still rendered')
  }
})
