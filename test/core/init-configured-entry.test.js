// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { renderConfigSummary } from '../../src/core/cli/wizard/fork.js'

// Re-running `hypaware` on a configured install fronts the wizard with
// the returning gate's friendly summary + menu instead of starting
// fresh. The gate itself (options, legacy prompt, scoped re-entry) is
// unit-tested in test/core/cli/wizard/fork.test.js; this file keeps the
// summary renderer and the end-to-end dispatch shape.
// @ref LLP 0011#returning-to-a-configured-install [tests]:

/**
 * @import { HypAwareStatusReport } from '../../src/core/daemon/types.js'
 */

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * Minimal synthetic status report carrying only the fields the summary
 * renderer reads, keeping the text assertions deterministic without
 * booting a kernel.
 *
 * @param {Partial<HypAwareStatusReport>} over
 */
function makeReport(over = {}) {
  return /** @type {any} */ ({
    clients: [{ name: 'claude', configured: true, attached: true }],
    sources: [{ name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started' }],
    sinks: [{ instance: 'local', plugin: '@hypaware/format-parquet', kind: 'blob' }],
    daemon: { installed: true, running: true },
    cache: { totalBytes: 65 * 1024 * 1024, oldestDate: null },
    retention: { days: 30, source: 'default' },
    layered: null,
    ...over,
  })
}

test('renderConfigSummary: a local install reads as set up, not fleet-managed', () => {
  const stdout = makeBuf()
  renderConfigSummary({ report: makeReport(), locked: false, stdout })
  const text = stdout.text()

  assert.match(text, /HypAware is set up\./)
  assert.doesNotMatch(text, /managed by your fleet/)
  assert.doesNotMatch(text, /locked here/)
  assert.match(text, /Collecting:\s+Claude/)
  assert.match(text, /Saving to:\s+local Parquet files/)
  assert.match(text, /Daemon:\s+running/)
  assert.match(text, /Cache:\s+65 MB · 30-day retention/)
})

test('renderConfigSummary: a fleet-managed install says so and notes the lock', () => {
  const stdout = makeBuf()
  const report = makeReport({
    layered: /** @type {any} */ ({ hasCentral: true, centralPlugins: [], centralSinks: [], drops: [], centralQueryIgnored: false }),
    sinks: [{ instance: 'central', plugin: '@hypaware/central', kind: 'request' }],
  })
  renderConfigSummary({ report, locked: true, stdout })
  const text = stdout.text()

  assert.match(text, /HypAware is set up \(managed by your fleet\)\./)
  assert.match(text, /Settings are locked here and managed centrally\./)
  assert.match(text, /Saving to:\s+central fleet sink/)
})

test('renderConfigSummary: no sinks falls back to local cache only', () => {
  const stdout = makeBuf()
  renderConfigSummary({ report: makeReport({ sinks: [] }), locked: false, stdout })
  assert.match(stdout.text(), /Saving to:\s+local query cache only/)
})

// End-to-end through dispatch: a configured install run with no args
// shows the summary + menu and, on quit, exits 0 WITHOUT entering the
// first-run picker. HYP_NO_TUI=1 forces the readline menu so the fake
// streams don't drive a real terminal.
test('hyp init on a configured install fronts the picker with the summary menu', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-configured-entry-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] }) + '\n'
  )

  const stdout = /** @type {any} */ (makeBuf())
  stdout.isTTY = true
  const stderr = makeBuf()

  const code = await dispatch(['init'], {
    stdout,
    stderr,
    stdin: /** @type {any} */ (Readable.from(['\n'])),
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '', HYP_NO_TUI: '1' },
  })

  assert.equal(code, 0, stderr.text())
  assert.match(stdout.text(), /HypAware is set up\./)
  assert.match(stdout.text(), /What would you like to do\?/)
  // The first-run picker never ran.
  assert.doesNotMatch(stdout.text(), /Welcome to HypAware/)
})

// First run (no config): the gate falls through to the wizard's pathway
// fork, whose bare-enter default is quit - `hyp init` on a fresh machine
// never writes anything by accident (LLP 0129 #fork).
test('hyp init first run presents the pathway fork; a bare enter quits untouched', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-first-run-fork-'))

  const stdout = /** @type {any} */ (makeBuf())
  stdout.isTTY = true
  const stderr = makeBuf()

  const code = await dispatch(['init'], {
    stdout,
    stderr,
    stdin: /** @type {any} */ (Readable.from(['\n'])),
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '', HYP_NO_TUI: '1' },
  })

  assert.equal(code, 0, stderr.text())
  assert.match(stdout.text(), /Join a team, or set up HypAware locally\?/)
  assert.match(stdout.text(), /1\) Join a team/)
  assert.match(stdout.text(), /2\) Local install and configuration/)
  // Quit left no config behind.
  await assert.rejects(fs.access(path.join(hypHome, 'hypaware-config.json')))
})

// Choosing "See full status" must render the real status report off the
// same ctx init was given (proves runStatus works under the init boot
// profile, not just the status one). Option 2 in the unlocked menu.
test('hyp init: choosing "See full status" renders the status report and exits 0', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-configured-status-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] }) + '\n'
  )

  const stdout = /** @type {any} */ (makeBuf())
  stdout.isTTY = true
  const stderr = makeBuf()

  const code = await dispatch(['init'], {
    stdout,
    stderr,
    stdin: /** @type {any} */ (Readable.from(['2\n'])),
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '', HYP_NO_TUI: '1' },
  })

  assert.equal(code, 0, stderr.text())
  // The full status surface rendered (its distinctive lines), not just the
  // compact summary.
  assert.match(stdout.text(), /overall:/)
  assert.match(stdout.text(), /active plugins:/)
})
