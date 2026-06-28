// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { dispatch } from '../../src/core/cli/dispatch.js'
import {
  buildConfiguredMenuOptions,
  legacyConfiguredActionPrompt,
  renderConfigSummary,
} from '../../src/core/cli/core_commands.js'

// Re-running `hypaware` on a configured install fronts the first-run
// picker with a friendly summary + menu instead of starting fresh.
// @ref LLP 0011#returning-to-a-configured-install [tests]

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
 * renderer reads — keeps the text assertions deterministic without
 * booting a kernel.
 *
 * @param {Partial<import('../../src/core/daemon/types.d.ts').HypAwareStatusReport>} over
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

  assert.match(text, /HypAware is set up — managed by your fleet\./)
  assert.match(text, /Settings are locked here and managed centrally\./)
  assert.match(text, /Saving to:\s+central fleet sink/)
})

test('renderConfigSummary: no sinks falls back to local cache only', () => {
  const stdout = makeBuf()
  renderConfigSummary({ report: makeReport({ sinks: [] }), locked: false, stdout })
  assert.match(stdout.text(), /Saving to:\s+local query cache only/)
})

test('buildConfiguredMenuOptions: locked configs drop the Reconfigure option', () => {
  const unlocked = buildConfiguredMenuOptions(false).map((o) => o.value)
  assert.deepEqual(unlocked, ['reconfigure', 'status', 'quit'])

  const locked = buildConfiguredMenuOptions(true).map((o) => o.value)
  assert.deepEqual(locked, ['status', 'quit'])
})

/** @param {string} input */
function ctxWithStdin(input) {
  const stdout = makeBuf()
  return {
    ctx: /** @type {any} */ ({ stdin: Readable.from([input]), stdout }),
    stdout,
  }
}

test('legacyConfiguredActionPrompt: a bare enter takes the default (quit)', async () => {
  const { ctx, stdout } = ctxWithStdin('\n')
  const choice = await legacyConfiguredActionPrompt(ctx, buildConfiguredMenuOptions(false))
  assert.equal(choice, 'quit')
  // The numbered menu was printed for the user.
  assert.match(stdout.text(), /1\) Reconfigure/)
  assert.match(stdout.text(), /What would you like to do\?/)
})

test('legacyConfiguredActionPrompt: a valid number selects that option', async () => {
  const { ctx } = ctxWithStdin('1\n')
  const choice = await legacyConfiguredActionPrompt(ctx, buildConfiguredMenuOptions(false))
  assert.equal(choice, 'reconfigure')
})

test('legacyConfiguredActionPrompt: an out-of-range answer quits rather than guessing', async () => {
  const { ctx } = ctxWithStdin('9\n')
  const choice = await legacyConfiguredActionPrompt(ctx, buildConfiguredMenuOptions(false))
  assert.equal(choice, 'quit')
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
