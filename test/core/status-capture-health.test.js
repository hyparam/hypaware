// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  CAPTURE_GAP_ERROR_MS,
  CAPTURE_GAP_WARNING_MS,
  assessCaptureHealth,
  collectHypAwareStatus,
  formatGapDuration,
  probeClientActivityFromDescriptor,
  writeStatusFile,
} from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// The capture-health line (LLP 0257 S17, the RFC 0262 open-question-1 duty):
// on the otel path a broken exporter, a stale endpoint, and a down daemon all
// fail into the same silence, so `hyp status` holds the client's own
// transcript trail against the last event the listener recorded and gets
// loud when they diverge.
// @ref LLP 0257#status-and-health [tests]:

const MIN = 60_000
const HOUR = 3_600_000

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-capture-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:8787',
          upstreams: [
            { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' },
          ],
        },
      },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
    ],
  }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * A fake $HOME whose `.claude/settings.json` carries an attach marker, and
 * whose `.claude/projects` tree holds one transcript with a chosen mtime.
 *
 * @param {{ mode?: string, attachedAt?: string, transcriptMtime?: Date }} [opts]
 */
async function makeClientHome(opts = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-capture-home-'))
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  if (opts.mode !== undefined) {
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      _hypaware: {
        attached_at: opts.attachedAt ?? new Date(Date.now() - 24 * HOUR).toISOString(),
        version: '2.0.0',
        port: 8787,
        mode: opts.mode,
        managed: { env: {}, hooks: [] },
      },
      env: {},
    }) + '\n')
  }
  if (opts.transcriptMtime) {
    const dir = path.join(home, '.claude', 'projects', '-Users-t-proj')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'aaaa-session.jsonl')
    await fs.writeFile(file, '{}\n')
    await fs.utimes(file, opts.transcriptMtime, opts.transcriptMtime)
  }
  return home
}

/**
 * @param {string} stateRoot
 * @param {string | null} lastEventAt
 */
function writeDaemonStatus(stateRoot, lastEventAt) {
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    sources: [
      {
        name: 'ai-gateway',
        plugin: '@hypaware/ai-gateway',
        state: 'started',
        details: { host: '127.0.0.1', port: 8787 },
      },
      {
        name: 'claude-telemetry',
        plugin: '@hypaware/claude',
        state: 'started',
        details: { listen_host: '127.0.0.1', listen_port: 4319, last_event_at: lastEventAt },
      },
    ],
    sinks: [],
  }))
}

/**
 * @param {string} hypHome
 * @param {string} homeDir
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome, homeDir) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    homeDir,
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

/** @param {string} hypHome @param {string} homeDir */
async function cleanup(hypHome, homeDir) {
  await fs.rm(hypHome, { recursive: true, force: true })
  await fs.rm(homeDir, { recursive: true, force: true })
}

/* ---------- assessCaptureHealth: the threshold contract ---------- */

test('capture in lockstep is ok, and a transcript slightly ahead stays under the threshold', () => {
  const now = Date.now()
  const ok = assessCaptureHealth({
    lastEventAt: new Date(now - 2 * MIN).toISOString(),
    lastTranscriptActivityAt: new Date(now - 1 * MIN).toISOString(),
    attachedAt: new Date(now - 5 * HOUR).toISOString(),
  })
  assert.equal(ok.state, 'ok')
  assert.equal(ok.gapMs, 1 * MIN)
})

test('a transcript past the warning threshold is a warning gap, past the error threshold an error', () => {
  const now = Date.now()
  const warn = assessCaptureHealth({
    lastEventAt: new Date(now - 30 * MIN).toISOString(),
    lastTranscriptActivityAt: new Date(now).toISOString(),
    attachedAt: new Date(now - 5 * HOUR).toISOString(),
  })
  assert.equal(warn.state, 'gap')
  assert.equal(warn.severity, 'warning')
  assert.equal(warn.gapMs, 30 * MIN)

  const error = assessCaptureHealth({
    lastEventAt: new Date(now - 5 * HOUR).toISOString(),
    lastTranscriptActivityAt: new Date(now).toISOString(),
    attachedAt: new Date(now - 6 * HOUR).toISOString(),
  })
  assert.equal(error.state, 'gap')
  assert.equal(error.severity, 'error')
})

test('the boundary values sit exactly on the documented thresholds', () => {
  const base = Date.parse('2026-08-17T12:00:00.000Z')
  const at = (/** @type {number} */ ms) => new Date(ms).toISOString()
  const attachedAt = at(base - 24 * HOUR)
  const onWarn = assessCaptureHealth({
    lastEventAt: at(base),
    lastTranscriptActivityAt: at(base + CAPTURE_GAP_WARNING_MS),
    attachedAt,
  })
  assert.equal(onWarn.state, 'ok')
  const pastWarn = assessCaptureHealth({
    lastEventAt: at(base),
    lastTranscriptActivityAt: at(base + CAPTURE_GAP_WARNING_MS + 1),
    attachedAt,
  })
  assert.deepEqual([pastWarn.state, pastWarn.severity], ['gap', 'warning'])
  const onError = assessCaptureHealth({
    lastEventAt: at(base),
    lastTranscriptActivityAt: at(base + CAPTURE_GAP_ERROR_MS),
    attachedAt,
  })
  assert.deepEqual([onError.state, onError.severity], ['gap', 'warning'])
  const pastError = assessCaptureHealth({
    lastEventAt: at(base),
    lastTranscriptActivityAt: at(base + CAPTURE_GAP_ERROR_MS + 1),
    attachedAt,
  })
  assert.deepEqual([pastError.state, pastError.severity], ['gap', 'error'])
})

test('with no events the attach timestamp is the baseline, and pre-attach activity proves nothing', () => {
  const now = Date.now()
  // Months of transcripts from before the attach: the usual shape right
  // after a proxy-to-otel migration. Not a gap.
  const preAttach = assessCaptureHealth({
    lastEventAt: null,
    lastTranscriptActivityAt: new Date(now - 3 * 24 * HOUR).toISOString(),
    attachedAt: new Date(now - 1 * HOUR).toISOString(),
  })
  assert.deepEqual([preAttach.state, preAttach.gapMs], ['ok', 0])
  // Activity after the attach with still no events is the broken-path shape.
  const broken = assessCaptureHealth({
    lastEventAt: null,
    lastTranscriptActivityAt: new Date(now - 1 * MIN).toISOString(),
    attachedAt: new Date(now - 1 * HOUR).toISOString(),
  })
  assert.deepEqual([broken.state, broken.severity], ['gap', 'warning'])
})

test('missing halves never fabricate a gap', () => {
  const now = new Date().toISOString()
  assert.equal(assessCaptureHealth({ lastEventAt: now, lastTranscriptActivityAt: null, attachedAt: now }).state, 'ok')
  assert.equal(assessCaptureHealth({ lastEventAt: null, lastTranscriptActivityAt: now, attachedAt: null }).state, 'ok')
  assert.equal(
    assessCaptureHealth({ lastEventAt: 'not a date', lastTranscriptActivityAt: now, attachedAt: 'nope' }).state,
    'ok'
  )
})

test('formatGapDuration is coarse: minutes, then hours, then days', () => {
  assert.equal(formatGapDuration(20 * MIN), '20m')
  assert.equal(formatGapDuration(90 * MIN), '1h')
  assert.equal(formatGapDuration(30 * HOUR), '30h')
  assert.equal(formatGapDuration(3 * 24 * HOUR), '3d')
})

/* ---------- probeClientActivityFromDescriptor ---------- */

test('the activity probe reports the newest matching mtime, filtered by suffix', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-activity-probe-'))
  try {
    const projects = path.join(home, '.claude', 'projects')
    const older = path.join(projects, 'proj-a', 'old.jsonl')
    const newest = path.join(projects, 'proj-b', 'sess', 'subagents', 'agent-1.jsonl')
    const decoy = path.join(projects, 'proj-b', 'newer-but-wrong-suffix.txt')
    for (const file of [older, newest, decoy]) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, '{}\n')
    }
    const t0 = new Date('2026-08-17T10:00:00.000Z')
    const t1 = new Date('2026-08-17T11:00:00.000Z')
    const t2 = new Date('2026-08-17T12:00:00.000Z')
    await fs.utimes(older, t0, t0)
    await fs.utimes(newest, t1, t1)
    await fs.utimes(decoy, t2, t2)

    const descriptor = /** @type {any} */ ({
      plugin: '@hypaware/claude',
      name: 'claude',
      skillDir: '.claude/skills',
      activityProbe: { dir: '.claude/projects', file_suffix: '.jsonl' },
    })
    const seen = await probeClientActivityFromDescriptor({ descriptor, homeDir: home, env: {} })
    assert.equal(seen, t1.toISOString())
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a missing tree, a missing probe, and an escaping dir all read as no claim', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-activity-probe-'))
  try {
    const base = /** @type {any} */ ({ plugin: '@hypaware/claude', name: 'claude', skillDir: '.claude/skills' })
    assert.equal(
      await probeClientActivityFromDescriptor({
        descriptor: { ...base, activityProbe: { dir: '.claude/projects' } },
        homeDir: home,
        env: {},
      }),
      undefined
    )
    assert.equal(await probeClientActivityFromDescriptor({ descriptor: base, homeDir: home, env: {} }), undefined)
    assert.equal(
      await probeClientActivityFromDescriptor({
        descriptor: { ...base, activityProbe: { dir: '../outside' } },
        homeDir: home,
        env: {},
      }),
      undefined
    )
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* ---------- collect + render ---------- */

test('an otel-attached client in lockstep renders the line, healthy, in text and json', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 6 * HOUR).toISOString(),
    transcriptMtime: new Date(now - 1 * MIN),
  })
  try {
    writeDaemonStatus(stateRoot, new Date(now - 2 * MIN).toISOString())

    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(report.captureHealth.length, 1)
    const health = report.captureHealth[0]
    assert.equal(health.client, 'claude')
    assert.equal(health.source, 'claude-telemetry')
    assert.equal(health.state, 'ok')
    assert.equal(report.diagnostics.some((d) => d.kind === 'capture_gap'), false)
    assert.equal(report.overall, 'healthy')

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
    const text = stdout.text()
    assert.match(text, /capture health:/)
    assert.match(text, /- claude {2}last event 2m ago, last transcript activity 1m ago\n/)
    assert.doesNotMatch(text, /\[capture gap\]/)

    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache') })
    assert.equal(json.capture_health.length, 1)
    assert.equal(json.capture_health[0].client, 'claude')
    assert.equal(json.capture_health[0].state, 'ok')
    assert.equal(typeof json.capture_health[0].last_event_at, 'string')
    assert.equal(typeof json.capture_health[0].last_transcript_activity_at, 'string')
    // The attach marker's mode rides the client_attach entry (LLP 0258).
    const claude = json.client_attach.find((/** @type {any} */ c) => c.name === 'claude')
    assert.equal(claude?.mode, 'otel')
  } finally {
    await cleanup(hypHome, home)
  }
})

test('transcripts running hours past the last event degrade overall through an error diagnostic', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 24 * HOUR).toISOString(),
    transcriptMtime: new Date(now - 1 * MIN),
  })
  try {
    writeDaemonStatus(stateRoot, new Date(now - 5 * HOUR).toISOString())

    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(report.captureHealth[0]?.state, 'gap')
    const diag = report.diagnostics.find((d) => d.kind === 'capture_gap')
    assert.ok(diag, JSON.stringify(report.diagnostics, null, 2))
    assert.equal(diag.severity, 'error')
    assert.match(diag.message, /not being captured/)
    assert.ok(diag.repair.some((r) => r.includes('hyp daemon restart')))
    assert.ok(diag.repair.some((r) => r.includes('hyp attach --client claude')))
    assert.equal(report.overall, 'degraded')

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
    assert.match(stdout.text(), /- claude {2}last event 5h ago, last transcript activity 1m ago {2}\[capture gap\]\n/)
  } finally {
    await cleanup(hypHome, home)
  }
})

test('a moderate gap warns without degrading overall', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 24 * HOUR).toISOString(),
    transcriptMtime: new Date(now - 1 * MIN),
  })
  try {
    writeDaemonStatus(stateRoot, new Date(now - 40 * MIN).toISOString())

    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    const diag = report.diagnostics.find((d) => d.kind === 'capture_gap')
    assert.equal(diag?.severity, 'warning')
    assert.equal(report.overall, 'healthy')
  } finally {
    await cleanup(hypHome, home)
  }
})

test('no marker and a non-otel marker both keep the surface silent', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  for (const mode of [/** @type {string | undefined} */ (undefined), 'proxy']) {
    const home = await makeClientHome({ mode, transcriptMtime: new Date(now - 1 * MIN) })
    try {
      writeDaemonStatus(stateRoot, new Date(now - 5 * HOUR).toISOString())
      const report = await collectHypAwareStatus(collectOpts(hypHome, home))
      assert.deepEqual(report.captureHealth, [], `mode=${String(mode)}`)
      assert.equal(report.diagnostics.some((d) => d.kind === 'capture_gap'), false)

      const stdout = buffer()
      renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
      assert.doesNotMatch(stdout.text(), /capture health/)

      const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache') })
      assert.deepEqual(json.capture_health, [])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  }
  await fs.rm(hypHome, { recursive: true, force: true })
})

test('a daemon that never ran still yields the line, measured from the attach', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 2 * HOUR).toISOString(),
    transcriptMtime: new Date(now - 1 * MIN),
  })
  try {
    // No status.json at all: attach ran, the daemon never did. The listener
    // recorded nothing, and the transcripts kept moving.
    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(report.captureHealth.length, 1)
    const health = report.captureHealth[0]
    assert.equal(health.source, null)
    assert.equal(health.lastEventAt, null)
    assert.equal(health.state, 'gap')
    const diag = report.diagnostics.find((d) => d.kind === 'capture_gap')
    assert.match(diag?.message ?? '', /no telemetry has arrived/)

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
    assert.match(stdout.text(), /- claude {2}no events yet, last transcript activity 1m ago {2}\[capture gap\]\n/)
  } finally {
    await cleanup(hypHome, home)
  }
})
