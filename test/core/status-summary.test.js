// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { renderStatusSummary } from '../../src/core/commands/status.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'

/** @import { HypAwareStatusReport } from '../../src/core/daemon/types.js' */

/** @param {Partial<HypAwareStatusReport>} [overrides] */
function report(overrides = {}) {
  return /** @type {HypAwareStatusReport} */ ({
    overall: 'healthy', daemon: { running: true, state: 'healthy' },
    clients: [], sources: [], diagnostics: [], captureHealth: [],
    cache: { totalBytes: 605534235, oldestDate: null }, retention: { days: 90, source: 'config' },
    clientSync: null, layered: null, clientActions: null, usagePolicy: null,
    firstSyncHoldDeadline: null, cacheFlushFailures: [], cacheFlushFailuresTotal: 0,
    ...overrides,
  })
}

/** @param {HypAwareStatusReport} value */
function render(value) {
  let text = ''
  renderStatusSummary({ report: value, stdout: { write(chunk) { text += chunk } } })
  return text
}

const layered = /** @type {const} */ ({ hasCentral: true })
const managed = { ...layered, centralPlugins: [], centralSinks: [], drops: [], centralQueryIgnored: false }

test('compact status shows mixed sharing, probe-less sources, and hides unused clients', () => {
  const text = render(report({
    layered: managed,
    clients: [
      { name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true, attachable: true, mode: 'otel' },
      { name: 'codex', plugin: '@hypaware/codex', configured: true, attached: false, attachable: false },
      { name: 'cursor', plugin: '@hypaware/cursor', configured: false, attached: false, attachable: true },
    ],
    clientSync: { syncing: ['claude'], localOnly: ['codex', 'hermes'] },
  }))
  assert.match(text, /^HypAware · Healthy/)
  assert.match(text, /606 MB · 90-day retention/)
  assert.match(text, /claude\s+Attached \(otel\)\s+Sync/)
  assert.match(text, /codex\s+Configured\s+Local only/)
  assert.match(text, /hermes\s+Configured\s+Local only/)
  assert.doesNotMatch(text, /cursor|attach n\/a|active plugins|config:/)
  assert.match(text, /not delivery confirmation/)
})

test('missing enrolled policy stays unknown, while a solo client is local only', () => {
  const clients = [{ name: 'codex', plugin: '@hypaware/codex', configured: true, attached: false, attachable: false }]
  assert.match(render(report({ clients, layered: managed })), /codex\s+Configured\s+Unknown/)
  assert.match(render(report({ clients })), /codex\s+Configured\s+Local only/)
})

test('warning gaps show both ages and one primary repair without asserting lost sessions', () => {
  const now = Date.now()
  const text = render(report({
    clients: [{ name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true, attachable: true }],
    captureHealth: [{
      client: 'claude', plugin: '@hypaware/claude', source: 'claude-telemetry', state: 'gap',
      lastEventAt: new Date(now - 21 * 60000).toISOString(),
      lastTranscriptActivityAt: new Date(now - 60000).toISOString(),
      attachedAt: null, listenerStartedAt: null, gapMs: 20 * 60000,
    }],
    diagnostics: [{ severity: 'warning', kind: 'capture_gap', message: 'legacy gap message', repair: ['hyp daemon restart'] }],
  }))
  assert.match(text, /^HypAware · Needs attention/)
  assert.match(text, /Telemetry may be interrupted/)
  assert.match(text, /transcripts active 1m ago; last telemetry 21m ago/)
  assert.equal(text.split('hyp daemon restart').length - 1, 1)
  assert.doesNotMatch(text, /legacy gap|not being captured|No issues detected/)
})

test('sharing holds and privacy exclusions remain visible in compact status', () => {
  const text = render(report({
    layered: managed,
    firstSyncHoldDeadline: Date.now() + 60000,
    usagePolicy: { localOnlyDirCount: 2, folderAsk: 'sync' },
  }))
  assert.match(text, /withholding 2 directories/)
  assert.match(text, /sync without asking/)
  assert.match(text, /first sync:\s+held until/)
})

test('source and client probe errors remain visible and terminal-safe', () => {
  const text = render(report({
    sources: [{ name: 'github', plugin: '@hypaware/github', state: 'started', health: { state: 'ready', lastError: 'API timed out' } }],
    clients: [{ name: 'broken', plugin: '@acme/broken', configured: false, attached: false, attachable: true, error: 'bad\n\u001b[31msettings' }],
  }))
  assert.match(text, /^HypAware · Needs attention/)
  assert.match(text, /github: API timed out/)
  assert.match(text, /broken\s+Could not check/)
  assert.doesNotMatch(text, /\u001b|\nbad|\nsettings/)
})

test('flush evidence is capped while overflow counts and attempt tense survive', () => {
  const failures = Array.from({ length: 10 }, (_, i) => ({
    table: `table${i}`, failedAt: new Date().toISOString(), errorMessage: 'disk full', stillCoolingDown: true,
  }))
  const text = render(report({ cacheFlushFailures: failures, cacheFlushFailuresTotal: 10 }))
  assert.match(text, /table0: last flush attempt failed/)
  assert.match(text, /refresh cooling down/)
  assert.match(text, /2 more tables \(hyp status --json lists them all\)/)
  assert.doesNotMatch(text, /table8|table9/)
})

test('CLI selects compact, verbose, and unchanged JSON with JSON precedence', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-summary-'))
  try {
    const env = { ...isolatedClientEnv(process.env, temp), HYP_HOME: temp, HYP_CONFIG: '' }
    const run = (/** @type {string[]} */ flags) => {
      const result = spawnSync(process.execPath, ['bin/hypaware.js', 'status', ...flags], { env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout
    }
    assert.match(run([]), /^HypAware · Needs attention/)
    assert.match(run(['--verbose']), /active plugins:/)
    assert.deepEqual(JSON.parse(run(['--json', '--verbose'])), JSON.parse(run(['--json'])))
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('an error-rank diagnostic reads differently from a warning-only advisory at default verbosity', () => {
  const headline = (/** @type {string} */ text) => text.split('\n')[0]
  const advisory = render(report({
    diagnostics: [{ severity: 'warning', kind: 'client_attached_not_configured', message: 'codex still points at the gateway', repair: ['hyp client detach codex'] }],
  }))
  const outage = render(report({
    overall: 'degraded',
    diagnostics: [{ severity: 'error', kind: 'local_only_list_unreadable', message: 'local-only exclusion list is unreadable', repair: ['fix or remove the file'] }],
  }))
  assert.notEqual(headline(outage), headline(advisory))
  assert.equal(headline(advisory), 'HypAware · Needs attention')
  assert.equal(headline(outage), 'HypAware · Needs attention (degraded)')
  // A report that contradicts its own breakdown cannot suppress the rank: the
  // marker reads the error severity too, never the verdict alone.
  const contradictory = render(report({
    diagnostics: [{ severity: 'error', kind: 'config_invalid', message: 'bad', repair: [] }],
  }))
  assert.equal(headline(contradictory), 'HypAware · Needs attention (degraded)')
  // The other direction: a verdict degraded without any error-severity
  // diagnostic (the fresh no-config install) still carries the rank. The
  // marker reads the verdict too, never the severity scan alone.
  const freshInstall = render(report({
    overall: 'degraded',
    diagnostics: [{ severity: 'warning', kind: 'config_missing', message: 'no config file found', repair: ['hyp init'] }],
  }))
  assert.equal(headline(freshInstall), 'HypAware · Needs attention (degraded)')
  assert.equal(headline(render(report())), 'HypAware · Healthy')
})
