// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusSummary, renderStatusText } from '../../src/core/commands/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { TestContext } from 'node:test' */

// A source may publish one plain `details.summary_line`, and `hyp status`
// prints it in every state, healthy included, unlike the health line that
// speaks only for trouble. The team graph replica is the first publisher: the
// age of the team's data matters even when nothing is wrong. A line left in
// the snapshot of a daemon that is gone is not printed, since it would claim
// a past state as current.
// @ref LLP 0480#status-line [tests]: the summary line prints in every state, from a live source only

const LINE = 'team graph: synced, data as of 14 h ago (acme), 52 MB'

/** @param {TestContext} t @param {{ live: boolean, line?: unknown }} opts */
async function report(t, { live, line = LINE }) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-summary-line-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  if (live) writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    pid: process.pid,
    healthyAt: new Date().toISOString(),
    uptimeMs: 0,
    sources: [
      { name: 'team-graph-replica', plugin: '@hypaware/fastask', state: 'started', details: { summary_line: line, listen_port: 1 }, health: { state: 'ready', message: String(line) } },
      { name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started', details: { listen_port: 2 } },
    ],
    sinks: [],
  }))
  return collectHypAwareStatus({ env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }, platform: 'darwin', isLaunchAgentInstalled: () => false })
}

function buffer() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

test('a running source\'s summary line prints in the compact, verbose and JSON views while healthy', async (t) => {
  const r = await report(t, { live: true })
  const compact = buffer()
  renderStatusSummary({ report: r, stdout: compact })
  assert.ok(compact.text().includes(`  ${LINE}\n`), compact.text())

  const verbose = buffer()
  renderStatusText({ report: r, clientNames: [], datasets: [], cacheRoot: '/cache', stdout: verbose })
  assert.ok(verbose.text().includes(`        ${LINE}\n`), 'under its source row')
  assert.equal(verbose.text().split(LINE).length - 1, 1, 'once, not also as a health line')

  const json = renderStatusJson({ report: r, clientNames: [], datasets: [], cacheRoot: '/cache' })
  assert.equal(json.sources.find((/** @type {any} */ s) => s.name === 'team-graph-replica')?.summary_line, LINE)
  assert.equal(json.sources.find((/** @type {any} */ s) => s.name === 'ai-gateway')?.summary_line, undefined, 'a source without one gains nothing')
})

test('a dead daemon\'s summary line is not printed', async (t) => {
  const r = await report(t, { live: false })
  const compact = buffer()
  renderStatusSummary({ report: r, stdout: compact })
  assert.ok(!compact.text().includes('team graph:'))
  const json = renderStatusJson({ report: r, clientNames: [], datasets: [], cacheRoot: '/cache' })
  assert.equal(json.sources[0].summary_line, undefined)
})

test('a summary line is made safe for the terminal and ignored when not a string', async (t) => {
  const hostile = await report(t, { live: true, line: 'team graph: synced\u001b[2J\nforged line' })
  const out = buffer()
  renderStatusSummary({ report: hostile, stdout: out })
  assert.ok(!out.text().includes('\u001b[2J'), 'no escape sequence reaches the terminal')
  assert.ok(!out.text().includes('\nforged line'), 'no forged extra line')

  const odd = await report(t, { live: true, line: 42 })
  const json = renderStatusJson({ report: odd, clientNames: [], datasets: [], cacheRoot: '/cache' })
  assert.equal(json.sources[0].summary_line, undefined)
})
