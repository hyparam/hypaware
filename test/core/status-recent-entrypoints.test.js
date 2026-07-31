// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  collectHypAwareStatus,
  recentEntrypointsFromSources,
  writeStatusFile,
} from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import {
  formatEntrypointAge,
  renderStatusJson,
  renderStatusText,
} from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// `hyp status` must be able to say "Codex Desktop traffic arrived N minutes
// ago" without activating a plugin and without reading the cache. The only
// place that answer can come from is the gateway's own status-file details.
// @ref LLP 0164#status-reads-it-from-the-status-file [tests]:

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-entrypoints-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} stateRoot
 * @param {Record<string, unknown>} details
 * @param {{ alive?: boolean }} [opts]
 */
function writeDaemonStatus(stateRoot, details, opts = {}) {
  if (opts.alive !== false) {
    writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'foreground' }))
  }
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    sources: [{ name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started', details }],
    sinks: [],
  }))
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

/** @returns {{ write(chunk: string): void, text(): string }} */
function buffer() {
  /** @type {string[]} */
  const chunks = []
  return { write: (chunk) => { chunks.push(chunk) }, text: () => chunks.join('') }
}

test('recentEntrypointsFromSources lifts the gateway detail, newest first', () => {
  const out = recentEntrypointsFromSources(/** @type {any} */ ([
    {
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      details: {
        host: '127.0.0.1',
        port: 18521,
        recent_entrypoints: [
          { entrypoint: 'codex-tui', client_name: 'codex', last_seen: '2026-07-30T09:00:00.000Z', rows: 40 },
          { entrypoint: 'Codex Desktop', client_name: 'codex', last_seen: '2026-07-30T11:00:00.000Z', rows: 6 },
        ],
      },
    },
  ]))
  assert.deepEqual(out, [
    { entrypoint: 'Codex Desktop', clientName: 'codex', lastSeen: '2026-07-30T11:00:00.000Z', rows: 6 },
    { entrypoint: 'codex-tui', clientName: 'codex', lastSeen: '2026-07-30T09:00:00.000Z', rows: 40 },
  ])
})

test('a malformed or partial entry is dropped, not repaired into a name no query can reproduce', () => {
  const out = recentEntrypointsFromSources(/** @type {any} */ ([
    {
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      details: {
        recent_entrypoints: [
          null,
          'codex-tui',
          { client_name: 'codex', last_seen: '2026-07-30T11:00:00.000Z' },
          { entrypoint: 'codex-tui', last_seen: 'not a date' },
          { entrypoint: 'local-agent', last_seen: '2026-07-30T11:00:00.000Z' },
        ],
      },
    },
  ]))
  assert.deepEqual(out, [
    { entrypoint: 'local-agent', clientName: null, lastSeen: '2026-07-30T11:00:00.000Z', rows: 0 },
  ])
})

test('a daemon with no gateway source, or an older daemon, yields an empty list', () => {
  assert.deepEqual(recentEntrypointsFromSources(undefined), [])
  assert.deepEqual(recentEntrypointsFromSources(/** @type {any} */ ([])), [])
  assert.deepEqual(
    recentEntrypointsFromSources(/** @type {any} */ ([
      { name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started', details: { host: '127.0.0.1', port: 18521 } },
    ])),
    []
  )
})

test('hyp status surfaces Codex Desktop traffic from status.json, with no cache read', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    writeDaemonStatus(stateRoot, {
      host: '127.0.0.1',
      port: 18521,
      recent_entrypoints: [
        { entrypoint: 'Codex Desktop', client_name: 'codex', last_seen: new Date(Date.now() - 5 * 60_000).toISOString(), rows: 6 },
        { entrypoint: 'codex-tui', client_name: 'codex', last_seen: new Date(Date.now() - 3 * 3_600_000).toISOString(), rows: 40 },
      ],
    })

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.deepEqual(report.recentEntrypoints.map((e) => e.entrypoint), ['Codex Desktop', 'codex-tui'])

    const stdout = buffer()
    renderStatusText({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
      stdout,
    })
    const text = stdout.text()
    assert.match(text, /recent clients:/)
    assert.match(text, /- Codex Desktop {2}\(codex\) {2}last seen 5m ago, 6 rows/)
    assert.match(text, /- codex-tui {2}\(codex\) {2}last seen 3h ago, 40 rows/)

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    assert.equal(json.recent_entrypoints.length, 2)
    assert.equal(json.recent_entrypoints[0].entrypoint, 'Codex Desktop')
    assert.equal(json.recent_entrypoints[0].client_name, 'codex')
    assert.equal(json.recent_entrypoints[0].rows, 6)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('an install that has never captured keeps the V1 text surface unchanged', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    writeDaemonStatus(stateRoot, { host: '127.0.0.1', port: 18521, recent_entrypoints: [] })
    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.deepEqual(report.recentEntrypoints, [])

    const stdout = buffer()
    renderStatusText({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
      stdout,
    })
    assert.doesNotMatch(stdout.text(), /recent clients/)

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    assert.deepEqual(json.recent_entrypoints, [])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('last-seen survives its daemon: a stopped daemon still reports what it saw', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    // No pid file: nothing is running. Unlike a bound port, "last seen at T"
    // does not become false when the daemon exits, and the rendered age
    // carries the staleness.
    writeDaemonStatus(stateRoot, {
      recent_entrypoints: [
        { entrypoint: 'Codex Desktop', client_name: 'codex', last_seen: new Date(Date.now() - 2 * 86_400_000).toISOString(), rows: 6 },
      ],
    }, { alive: false })

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.deepEqual(report.recentEntrypoints.map((e) => e.entrypoint), ['Codex Desktop'])

    const stdout = buffer()
    renderStatusText({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
      stdout,
    })
    assert.match(stdout.text(), /- Codex Desktop {2}\(codex\) {2}last seen 2d ago, 6 rows/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('formatEntrypointAge is coarse, and never renders a negative age', () => {
  const now = Date.parse('2026-07-30T12:00:00.000Z')
  assert.equal(formatEntrypointAge('2026-07-30T11:59:30.000Z', now), 'just now')
  assert.equal(formatEntrypointAge('2026-07-30T11:55:00.000Z', now), '5m ago')
  assert.equal(formatEntrypointAge('2026-07-30T09:00:00.000Z', now), '3h ago')
  assert.equal(formatEntrypointAge('2026-07-28T12:00:00.000Z', now), '2d ago')
  // Clock went backwards after the status file was written.
  assert.equal(formatEntrypointAge('2026-07-30T13:00:00.000Z', now), 'just now')
  assert.equal(formatEntrypointAge('not a date', now), 'at an unreadable time')
})

test('a client with no client_name renders without inventing one', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    writeDaemonStatus(stateRoot, {
      recent_entrypoints: [
        { entrypoint: 'local-agent', last_seen: new Date().toISOString(), rows: 1 },
      ],
    })
    const report = await collectHypAwareStatus(collectOpts(hypHome))
    const stdout = buffer()
    renderStatusText({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
      stdout,
    })
    assert.match(stdout.text(), /- local-agent {2}last seen just now, 1 row\n/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// `status.json` is a file. Core must not assume the daemon that wrote it was
// this version or was well behaved, and everything read here is about to be
// printed to a terminal.
test('recentEntrypointsFromSources cleans labels a foreign status file supplies', () => {
  const ESC = String.fromCharCode(27)
  const LF = String.fromCharCode(10)
  const recent = recentEntrypointsFromSources([
    {
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      state: 'started',
      details: {
        recent_entrypoints: [
          {
            entrypoint: `local-agent${ESC}[2K${LF}  daemon:   FORGED ALL GOOD`,
            client_name: `claude${LF}  x`,
            last_seen: '2026-07-30T09:55:00.000Z',
            rows: 3,
          },
          {
            entrypoint: 'C'.repeat(40000),
            client_name: null,
            last_seen: '2026-07-30T09:50:00.000Z',
            rows: 1,
          },
        ],
      },
    },
  ])

  assert.equal(recent.length, 2)
  for (const e of recent) {
    assert.equal(e.entrypoint.includes(ESC), false, 'no escape byte survives')
    assert.equal(e.entrypoint.includes(LF), false, 'no newline survives')
    assert.ok(e.entrypoint.length <= 128, `length ${e.entrypoint.length}`)
    assert.equal((e.clientName ?? '').includes(LF), false)
  }
  assert.match(recent[0].entrypoint, /^local-agent/)
})

test('a rendered recent-clients block cannot be forged by a hostile entrypoint', async () => {
  const ESC = String.fromCharCode(27)
  const LF = String.fromCharCode(10)
  const { hypHome, stateRoot } = await makeHome()
  writeDaemonStatus(stateRoot, {
    host: '127.0.0.1',
    port: 18521,
    recent_entrypoints: [
      {
        entrypoint: `x${LF}  daemon:   FORGED${LF}  cache:      /nowhere${ESC}[2K`,
        client_name: 'claude',
        last_seen: new Date().toISOString(),
        rows: 1,
      },
    ],
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const stdout = buffer()
  renderStatusText({
    report,
    clientNames: [],
    datasets: [],
    cacheRoot: path.join(stateRoot, 'cache'),
    stdout,
  })
  const text = stdout.text()

  // The surface is still named, on exactly one line, and nothing it contained
  // became a line of its own or an escape sequence.
  assert.match(text, /recent clients:/)
  assert.equal(text.includes(ESC), false, 'no escape byte reaches the terminal')
  assert.equal(text.includes(`${LF}  daemon:   FORGED`), false, 'no forged daemon line')
  // The whole payload collapses onto the single entry line, where it is inert
  // text inside the `- <entrypoint>  (<client>)  last seen ...` shape rather
  // than a line of its own.
  const block = text.slice(text.indexOf('  recent clients:')).split(LF)
  assert.match(block[1], /^ {4}- \S.* {2}\(claude\) {2}last seen just now, 1 row$/)
  assert.match(block[2], /^ {2}cache:/, 'the next line is the real one, not a forged one')
})

// `sanitizeLabel` bounds a label's bytes; nothing bounded how many of them
// core would read back. The gateway caps its own map, but core reads a *file*,
// and the same sentence that justifies sanitizing on read - this build did not
// necessarily write it - applies to the count.
test('a status file with an absurd number of entrypoints is capped on read', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({
    entrypoint: `surface-${i}`,
    client_name: null,
    last_seen: new Date(Date.now() - i * 1000).toISOString(),
    rows: 1,
  }))

  const recent = recentEntrypointsFromSources([
    {
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      state: 'started',
      details: { recent_entrypoints: many },
    },
  ])

  assert.equal(recent.length, 32)
  // Capped after the sort, so what survives is the most recently seen.
  assert.equal(recent[0].entrypoint, 'surface-0')
})
