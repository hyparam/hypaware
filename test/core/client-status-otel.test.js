// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { projectClientStatus, renderClientStatusText } from '../../src/core/commands/status.js'

function buffer() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

function report() {
  return /** @type {any} */ ({
    layered: null,
    daemon: { installed: true, loaded: true, running: true, platform: 'linux' },
    clients: [
      {
        name: 'claude',
        plugin: '@hypaware/claude',
        configured: true,
        attachable: true,
        attached: true,
        mode: 'otel',
        telemetryPort: 4319,
      },
      {
        name: 'codex',
        plugin: '@hypaware/codex',
        configured: true,
        attachable: true,
        attached: true,
        mode: 'base_url',
      },
    ],
    sources: [
      {
        name: 'claude-telemetry',
        plugin: '@hypaware/claude',
        state: 'started',
        details: { listen_host: '127.0.0.1', listen_port: 54321 },
      },
    ],
    captureHealth: [
      {
        client: 'claude',
        plugin: '@hypaware/claude',
        source: 'claude-telemetry',
        lastEventAt: '2026-08-18T18:00:00.000Z',
        lastTranscriptActivityAt: '2026-08-18T19:00:00.000Z',
        attachedAt: '2026-08-18T17:00:00.000Z',
        listenerStartedAt: '2026-08-18T17:30:00.000Z',
        gapMs: 3_600_000,
        state: 'gap',
      },
    ],
    recentEntrypoints: [
      { clientName: 'claude', entrypoint: 'cli', lastSeen: '2026-08-18T18:00:00.000Z', rows: 4 },
      { clientName: 'codex', entrypoint: 'codex-tui', lastSeen: '2026-08-18T18:30:00.000Z', rows: 2 },
    ],
  })
}

test('client status projects OTEL mode, listener drift, and capture health from one report', () => {
  const source = report()
  const rows = projectClientStatus(source, source.clients)
  const claude = rows.find((row) => row.name === 'claude')

  assert.equal(claude?.mode, 'otel')
  assert.equal(claude?.telemetry_endpoint, 'http://127.0.0.1:4319')
  assert.equal(claude?.listener_endpoint, 'http://127.0.0.1:54321')
  assert.equal(claude?.endpoint_drift, true)
  assert.deepEqual(claude?.capture_health, {
    source: 'claude-telemetry',
    last_event_at: '2026-08-18T18:00:00.000Z',
    last_transcript_activity_at: '2026-08-18T19:00:00.000Z',
    attached_at: '2026-08-18T17:00:00.000Z',
    listener_started_at: '2026-08-18T17:30:00.000Z',
    gap_seconds: 3600,
    state: 'gap',
  })

  const stdout = buffer()
  renderClientStatusText(rows, stdout)
  assert.match(stdout.text(), /claude: configured, attached \(otel\), local/)
  assert.match(stdout.text(), /telemetry: http:\/\/127\.0\.0\.1:4319 -> http:\/\/127\.0\.0\.1:54321 \[endpoint drift\]/)
  assert.match(stdout.text(), /capture: gap; last event 2026-08-18T18:00:00\.000Z; last transcript activity 2026-08-18T19:00:00\.000Z \[capture gap\]/)
})

test('a filtered client projection cannot leak another client recorder health', () => {
  const source = report()
  const codexOnly = projectClientStatus(
    source,
    source.clients.filter((/** @type {any} */ client) => client.name === 'codex')
  )

  assert.equal(codexOnly.length, 1)
  assert.equal(codexOnly[0].name, 'codex')
  assert.equal(codexOnly[0].capture_health, null)
  assert.equal(codexOnly[0].telemetry_endpoint, null)
  assert.equal(codexOnly[0].listener_endpoint, null)

  const stdout = buffer()
  renderClientStatusText(codexOnly, stdout)
  assert.doesNotMatch(stdout.text(), /claude|capture gap|endpoint drift/)
})

// The drift line is a claim about where the listener is bound *now*. A stopped
// daemon leaves its last snapshot on disk, and `hyp client status` boots with
// no plugins, so that snapshot is all this projection can see. `hyp status`
// gates its equivalent `client_telemetry_stale` diagnostic on daemon liveness
// for exactly that reason, and the two surfaces must not disagree.
// @ref LLP 0248#client-status [tests]: a dead daemon's persisted port makes no drift claim here either
test('a stopped daemon reports no listener endpoint and no drift', () => {
  const source = report()
  source.daemon.running = false
  const rows = projectClientStatus(source, source.clients)
  const claude = rows.find((row) => row.name === 'claude')

  assert.equal(claude?.listener_endpoint, null)
  assert.equal(claude?.endpoint_drift, null)

  const stdout = buffer()
  renderClientStatusText(rows, stdout)
  assert.match(stdout.text(), /telemetry: http:\/\/127\.0\.0\.1:4319 -> listener not running/)
  assert.doesNotMatch(stdout.text(), /endpoint drift/)
})
