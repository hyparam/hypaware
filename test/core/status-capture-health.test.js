// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  CAPTURE_GAP_ERROR_MS,
  CAPTURE_GAP_WARNING_MS,
  assessCaptureHealth,
  collectHypAwareStatus,
  confirmClientActivityFromDescriptor,
  formatGapDuration,
  probeClientActivityFromDescriptor,
  writeStatusFile,
} from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
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
 * One conversation record: the shape that establishes a turn telemetry
 * should have carried.
 *
 * @param {Date | string} at
 * @param {string} [uuid]
 */
function assistantRecord(at, uuid = 'a1') {
  return {
    type: 'assistant',
    sessionId: 'sess',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    timestamp: typeof at === 'string' ? at : at.toISOString(),
  }
}

/**
 * A fake $HOME whose `.claude/settings.json` carries an attach marker, and
 * whose `.claude/projects` tree holds one transcript with a chosen mtime.
 *
 * `transcriptLines` overrides the file body, which defaults to a single
 * conversation record stamped at `transcriptMtime`: the mtime alone no
 * longer establishes activity, so a transcript that is supposed to read as
 * active has to say so in its own records.
 *
 * @param {{ mode?: string, attachedAt?: string, transcriptMtime?: Date, transcriptLines?: unknown[] }} [opts]
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
    const lines = opts.transcriptLines ?? [assistantRecord(opts.transcriptMtime)]
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
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
    assert.doesNotMatch(text, /\[telemetry may be interrupted\]/)

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
    assert.ok(diag.repair.some((r) => r.includes('hyp client attach claude')))
    assert.equal(report.overall, 'degraded')

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
    assert.match(stdout.text(), /- claude {2}last event 5h ago, last transcript activity 1m ago {2}\[telemetry may be interrupted\]\n/)
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
    assert.match(stdout.text(), /- claude {2}no events yet, last transcript activity 1m ago {2}\[telemetry may be interrupted\]\n/)
  } finally {
    await cleanup(hypHome, home)
  }
})

/* ---------- the restart baseline ---------- */

// `state.lastEventAt` lives only in the listener's process, so every daemon
// restart republishes `last_event_at: null` however long capture has been
// healthy. With the attach timestamp as the only fallback baseline, a machine
// attached a month ago and used an hour ago reported a month-long gap - an
// `error`, degrading `overall` - the moment someone ran `hyp daemon restart`,
// which is itself the first repair `capture_gap` prints. The running
// listener's own start is the third baseline that closes that loop.
// @ref LLP 0257#status-and-health [tests]: the gap is measured from a moment capture was actually supposed to be running

test('a listener that just started cannot be blamed for activity older than it', () => {
  const now = Date.now()
  const restarted = assessCaptureHealth({
    lastEventAt: null,
    lastTranscriptActivityAt: new Date(now - 1 * HOUR).toISOString(),
    attachedAt: new Date(now - 30 * 24 * HOUR).toISOString(),
    listenerStartedAt: new Date(now - 1 * MIN).toISOString(),
  })
  assert.deepEqual([restarted.state, restarted.gapMs], ['ok', 0])
})

test('a listener up long enough to have seen something still reports the gap', () => {
  const now = Date.now()
  const real = assessCaptureHealth({
    lastEventAt: null,
    lastTranscriptActivityAt: new Date(now - 1 * MIN).toISOString(),
    attachedAt: new Date(now - 30 * 24 * HOUR).toISOString(),
    listenerStartedAt: new Date(now - 5 * HOUR).toISOString(),
  })
  assert.deepEqual([real.state, real.severity], ['gap', 'error'])
})

test('an event newer than the listener start still wins the baseline', () => {
  const now = Date.now()
  const verdict = assessCaptureHealth({
    lastEventAt: new Date(now - 1 * MIN).toISOString(),
    lastTranscriptActivityAt: new Date(now).toISOString(),
    attachedAt: new Date(now - 30 * 24 * HOUR).toISOString(),
    listenerStartedAt: new Date(now - 5 * HOUR).toISOString(),
  })
  assert.equal(verdict.state, 'ok')
})

test('a routine daemon restart does not degrade a healthy install', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 30 * 24 * HOUR).toISOString(),
    transcriptMtime: new Date(now - 1 * HOUR),
  })
  try {
    // A live daemon whose listener came up a minute ago and has not been
    // POSTed to yet, because no Claude Code session has started since.
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
          details: {
            listen_host: '127.0.0.1',
            listen_port: 4319,
            last_event_at: null,
            listener_started_at: new Date(now - 1 * MIN).toISOString(),
          },
        },
      ],
      sinks: [],
    }))
    writePidFile(stateRoot, /** @type {any} */ ({
      pid: process.pid,
      runId: 'test-run',
      mode: 'foreground',
    }))

    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(report.captureHealth[0]?.state, 'ok')
    assert.equal(report.diagnostics.some((d) => d.kind === 'capture_gap'), false)
    assert.equal(report.overall, 'healthy')
    assert.equal(typeof report.captureHealth[0]?.listenerStartedAt, 'string')

    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache') })
    assert.equal(typeof json.capture_health[0].listener_started_at, 'string')
  } finally {
    await cleanup(hypHome, home)
  }
})

test('a dead daemon makes no restart excuse: its listener start bounds nothing now', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 30 * 24 * HOUR).toISOString(),
    transcriptMtime: new Date(now - 1 * HOUR),
  })
  try {
    // The same snapshot as above, but no pid file: the daemon that wrote it is
    // gone. "It only just started" stopped being true when the process ended,
    // and a daemon-down gap is exactly what this line exists to surface.
    writeStatusFile(stateRoot, /** @type {any} */ ({
      state: 'healthy',
      sources: [
        {
          name: 'claude-telemetry',
          plugin: '@hypaware/claude',
          state: 'started',
          details: {
            listen_host: '127.0.0.1',
            listen_port: 4319,
            last_event_at: null,
            listener_started_at: new Date(now - 1 * MIN).toISOString(),
          },
        },
      ],
      sinks: [],
    }))

    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(report.captureHealth[0]?.state, 'gap')
    assert.equal(report.captureHealth[0]?.listenerStartedAt, null)
    assert.equal(report.diagnostics.find((d) => d.kind === 'capture_gap')?.severity, 'error')
  } finally {
    await cleanup(hypHome, home)
  }
})

/* ---------- confirmClientActivityFromDescriptor: mtime nominates, content decides ---------- */
// Issue #2290: a transcript file is rewritten for reasons that produce no
// conversation and so owe no telemetry, and every one of them moves the mtime.
// The observed report had telemetry at 18:04:55, an informational
// `/auto-mode-setup` record at 18:06:27, an mtime of 18:24:50, and a last real
// assistant turn at 17:26:48 - a 20-minute "capture gap" over a conversation
// that had been idle for an hour, with `hyp daemon restart` offered as the fix.
// @ref LLP 0257#status-and-health [tests]:

/** @param {string} home @param {unknown[]} lines @param {Date | string} mtime @param {string} [name] */
async function writeTranscript(home, lines, mtime, name = 'aaaa-session.jsonl') {
  const dir = path.join(home, '.claude', 'projects', '-Users-t-proj')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
  await fs.writeFile(file, body + '\n')
  const at = typeof mtime === 'string' ? new Date(mtime) : mtime
  await fs.utimes(file, at, at)
  return file
}

const CONFIRM_DESCRIPTOR = /** @type {any} */ ({
  plugin: '@hypaware/claude',
  name: 'claude',
  skillDir: '.claude/skills',
  activityProbe: { dir: '.claude/projects', file_suffix: '.jsonl' },
})

/** @param {string} home @param {string | number} since */
function confirmIn(home, since) {
  return confirmClientActivityFromDescriptor({
    descriptor: CONFIRM_DESCRIPTOR,
    homeDir: home,
    env: {},
    sinceMs: typeof since === 'string' ? Date.parse(since) : since,
  })
}

/** @returns {Promise<string>} */
function makeProbeHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-confirm-activity-'))
}

test('metadata, local commands, and informational records do not establish activity', async () => {
  const home = await makeProbeHome()
  try {
    const lastAssistant = '2026-09-29T17:26:48.756Z'
    await writeTranscript(home, [
      assistantRecord(lastAssistant),
      // The record from the report: a local slash command's own output.
      {
        type: 'system',
        subtype: 'local_command',
        level: 'info',
        isMeta: false,
        sessionId: 'sess',
        uuid: 'c1',
        content: '<local-command-stdout>auto-mode-setup: ready</local-command-stdout>',
        timestamp: '2026-09-29T18:06:27.075Z',
      },
      // An expanded skill body injected into the context, not something said.
      {
        type: 'user',
        isMeta: true,
        sessionId: 'sess',
        uuid: 'm1',
        message: { role: 'user', content: [{ type: 'text', text: '# /loop' }] },
        timestamp: '2026-09-29T18:06:28.000Z',
      },
      { type: 'attachment', sessionId: 'sess', uuid: 'x1', attachment: { type: 'model' }, timestamp: '2026-09-29T18:06:29.000Z' },
      { type: 'file-history-snapshot', sessionId: 'sess', uuid: 'f1', timestamp: '2026-09-29T18:06:30.000Z' },
      { type: 'queue-operation', sessionId: 'sess', uuid: 'q1', timestamp: '2026-09-29T18:06:31.000Z' },
    ], '2026-09-29T18:24:50.310Z')

    const confirmed = await confirmIn(home, '2026-09-29T18:04:55.122Z')
    assert.deepEqual(confirmed, { activityAt: lastAssistant, certain: true })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a touched but otherwise unchanged transcript confirms only the turn it holds', async () => {
  const home = await makeProbeHome()
  try {
    const lastAssistant = '2026-09-29T17:26:48.756Z'
    await writeTranscript(home, [assistantRecord(lastAssistant)], '2026-09-29T18:24:50.310Z')
    const confirmed = await confirmIn(home, '2026-09-29T18:04:55.122Z')
    assert.equal(confirmed.activityAt, lastAssistant)
    assert.equal(confirmed.certain, true)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('the newest conversation record wins across files, and older files are not opened', async () => {
  const home = await makeProbeHome()
  try {
    const since = '2026-09-29T18:00:00.000Z'
    await writeTranscript(home, [assistantRecord('2026-09-29T18:10:00.000Z', 'a-old')], '2026-09-29T18:11:00.000Z', 'old.jsonl')
    await writeTranscript(home, [assistantRecord('2026-09-29T18:30:00.000Z', 'a-new')], '2026-09-29T18:31:00.000Z', 'new.jsonl')
    // Predates the baseline, so it cannot hold a record that matters and is
    // never opened - a file whose content would otherwise win.
    await writeTranscript(home, [assistantRecord('2026-09-29T19:00:00.000Z', 'a-stale')], '2026-09-29T17:00:00.000Z', 'stale.jsonl')
    const confirmed = await confirmIn(home, since)
    assert.deepEqual(confirmed, { activityAt: '2026-09-29T18:30:00.000Z', certain: true })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('malformed, truncated, and timestamp-less lines are skipped, not fatal', async () => {
  const home = await makeProbeHome()
  try {
    const lastAssistant = '2026-09-29T17:26:48.756Z'
    await writeTranscript(home, [
      assistantRecord(lastAssistant),
      'not json at all',
      '{"type":"assistant","timestamp":"2026-09-29T18:10:00.000Z","message":{"role":"assis',
      { type: 'assistant', sessionId: 'sess', uuid: 'n1', message: { role: 'assistant' } },
      { type: 'user', sessionId: 'sess', uuid: 'n2', timestamp: 'not a date' },
      '',
    ], '2026-09-29T18:24:50.310Z')
    const confirmed = await confirmIn(home, '2026-09-29T18:04:55.122Z')
    // Skipped, so the turn below them is still found and still dates the
    // activity. Not certain, though: each of those lines sits above that turn
    // and any of them could have been a newer one, so the answer is the turn
    // plus an admission, never the turn plus a clean bill of health.
    assert.deepEqual(confirmed, { activityAt: lastAssistant, certain: false })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a tail boundary that lands on a record edge does not eat that record', async () => {
  const home = await makeProbeHome()
  try {
    const since = Date.parse('2026-09-29T18:00:00.000Z')
    // The oldest line of the tail is the one that proves the read reached
    // back past the baseline. Start the read at the boundary itself and it is
    // indistinguishable from a mid-record cut, so the discard eats it and a
    // settled answer degrades to `unknown`; start one byte earlier and the
    // newline is there to tell them apart.
    const anchorLine = JSON.stringify({ type: 'mode', sessionId: 'sess', uuid: 'edge', timestamp: new Date(since - 60_000).toISOString() })
    /** @type {string[]} */
    const filler = []
    let tailBytes = Buffer.byteLength(anchorLine) + 1
    for (let i = 0; tailBytes < 128 * 1024 - 2_000; i++) {
      const line = JSON.stringify({ type: 'mode', sessionId: 'sess', uuid: `f${i}`, note: 'z'.repeat(300), timestamp: new Date(since + 60_000 + i).toISOString() })
      filler.push(line)
      tailBytes += Buffer.byteLength(line) + 1
    }
    // Pad the last record so the tail is exactly the read window: the
    // boundary then falls on `anchorLine`'s first byte.
    const shortfall = 128 * 1024 - tailBytes
    const padded = JSON.stringify({ type: 'mode', sessionId: 'sess', uuid: 'pad', note: '' , timestamp: new Date(since + 120_000).toISOString() })
    filler.push(padded.replace('"note":""', `"note":"${'z'.repeat(Math.max(0, shortfall - 1 - Buffer.byteLength(padded)))}"`))
    const body = 'x'.repeat(4_000) + '\n' + [anchorLine, ...filler].join('\n') + '\n'
    assert.equal(Buffer.byteLength(body) - Buffer.byteLength('x'.repeat(4_000) + '\n'), 128 * 1024)
    const dir = path.join(home, '.claude', 'projects', '-Users-t-proj')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'edge.jsonl')
    await fs.writeFile(file, body)
    const mtime = new Date(since + 600_000)
    await fs.utimes(file, mtime, mtime)

    assert.deepEqual(await confirmIn(home, since), { certain: true })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a half-written last record is not read as the absence of a turn', async () => {
  const home = await makeProbeHome()
  try {
    // What a live transcript looks like mid-append: the newest record is the
    // one most likely to be partly on disk when `hyp status` runs, and it is
    // exactly the record that would decide this.
    await writeTranscript(home, [
      { type: 'mode', sessionId: 'sess', uuid: 'm0', timestamp: '2026-09-29T17:00:00.000Z' },
      '{"type":"assistant","timestamp":"2026-09-29T18:10:00.000Z","message":{"role":"assis',
    ], '2026-09-29T18:24:50.310Z')
    assert.deepEqual(await confirmIn(home, '2026-09-29T18:04:55.122Z'), { certain: false })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a tail that runs out of budget before the baseline answers uncertain, not healthy', async () => {
  const home = await makeProbeHome()
  try {
    const since = '2026-09-29T18:00:00.000Z'
    /** @type {unknown[]} */
    const lines = [assistantRecord('2026-09-29T17:00:00.000Z')]
    // Past 64 KiB of post-baseline metadata the read can no longer see back to
    // the baseline, so whether a turn sits below the window is unknown.
    for (let i = 0; i < 400; i++) {
      lines.push({
        type: 'system',
        subtype: 'local_command',
        sessionId: 'sess',
        uuid: `p${i}`,
        content: 'x'.repeat(400),
        timestamp: new Date(Date.parse(since) + 60_000 + i).toISOString(),
      })
    }
    await writeTranscript(home, lines, '2026-09-29T18:30:00.000Z')
    const confirmed = await confirmIn(home, since)
    assert.equal(confirmed.activityAt, undefined)
    assert.equal(confirmed.certain, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a timestamp-less oversized tail is uncertain, and a timestamp-less small one is not', async () => {
  const big = await makeProbeHome()
  const small = await makeProbeHome()
  try {
    /** @type {unknown[]} */
    const lines = []
    for (let i = 0; i < 400; i++) lines.push({ type: 'mode', sessionId: 'sess', uuid: `p${i}`, note: 'y'.repeat(400) })
    await writeTranscript(big, lines, '2026-09-29T18:30:00.000Z')
    assert.deepEqual(await confirmIn(big, '2026-09-29T18:00:00.000Z'), { certain: false })

    await writeTranscript(small, [{ type: 'mode', sessionId: 'sess', uuid: 'p0' }], '2026-09-29T18:30:00.000Z')
    assert.deepEqual(await confirmIn(small, '2026-09-29T18:00:00.000Z'), { certain: true })
  } finally {
    await fs.rm(big, { recursive: true, force: true })
    await fs.rm(small, { recursive: true, force: true })
  }
})

test('more candidate files than the read budget answers uncertain', async () => {
  const home = await makeProbeHome()
  try {
    const since = Date.parse('2026-09-29T18:00:00.000Z')
    for (let i = 0; i < 20; i++) {
      await writeTranscript(
        home,
        [{ type: 'attachment', sessionId: 'sess', uuid: `x${i}`, timestamp: new Date(since + 60_000 + i * 1000).toISOString() }],
        new Date(since + 120_000 + i * 1000),
        `s${i}.jsonl`
      )
    }
    const confirmed = await confirmIn(home, since)
    assert.equal(confirmed.activityAt, undefined)
    assert.equal(confirmed.certain, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('an unreadable tree and a missing probe both answer uncertain, never healthy', async () => {
  const home = await makeProbeHome()
  try {
    assert.deepEqual(await confirmIn(home, Date.now()), { certain: true })
    const base = /** @type {any} */ ({ plugin: '@hypaware/claude', name: 'claude', skillDir: '.claude/skills' })
    assert.deepEqual(
      await confirmClientActivityFromDescriptor({ descriptor: base, homeDir: home, env: {}, sinceMs: 0 }),
      { certain: false }
    )
    assert.deepEqual(
      await confirmClientActivityFromDescriptor({
        descriptor: { ...base, activityProbe: { dir: '../outside' } },
        homeDir: home,
        env: {},
        sinceMs: 0,
      }),
      { certain: false }
    )
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a corner of the tree the walk could not read answers uncertain, never healthy', { skip: process.getuid?.() === 0 ? 'runs as root, where a mode-000 directory is still readable' : false }, async () => {
  const home = await makeProbeHome()
  const hidden = path.join(home, '.claude', 'projects', '-Users-t-hidden')
  try {
    // The turn is real and post-baseline; the walk just cannot see the
    // directory holding it. Skipping that corner silently would certify a
    // capture path this never looked at.
    await writeTranscript(home, [assistantRecord('2026-09-29T18:30:00.000Z')], '2026-09-29T18:31:00.000Z')
    await fs.mkdir(hidden, { recursive: true })
    await fs.writeFile(path.join(hidden, 'b-session.jsonl'), JSON.stringify(assistantRecord('2026-09-29T18:40:00.000Z')) + '\n')
    await fs.chmod(hidden, 0o000)
    const confirmed = await confirmIn(home, '2026-09-29T18:00:00.000Z')
    assert.equal(confirmed.certain, false)
  } finally {
    await fs.chmod(hidden, 0o700).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a symlinked transcript the walk will not follow answers uncertain, never healthy', async () => {
  const home = await makeProbeHome()
  try {
    // Symlinks are deliberately not followed, so the turn behind this one is
    // never read - which is a corner unlooked-at, not a tree with no turns
    // in it. The readable file carries the mtime that raised the suspicion.
    await writeTranscript(home, [
      { type: 'mode', sessionId: 'sess', uuid: 'm0', timestamp: '2026-09-29T18:20:00.000Z' },
    ], '2026-09-29T18:20:00.000Z')
    const outside = path.join(home, 'elsewhere.jsonl')
    await fs.writeFile(outside, JSON.stringify(assistantRecord('2026-09-29T18:40:00.000Z')) + '\n')
    await fs.symlink(outside, path.join(home, '.claude', 'projects', '-Users-t-proj', 'linked.jsonl'))
    assert.deepEqual(await confirmIn(home, '2026-09-29T18:00:00.000Z'), { certain: false })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a tail read that comes back short is uncertain, not a clean bill of health', async () => {
  const home = await makeProbeHome()
  const realOpen = fsp.open
  try {
    await writeTranscript(home, [assistantRecord('2026-09-29T18:30:00.000Z')], '2026-09-29T18:31:00.000Z')
    // A read that stops early drops the *newest* records, which is exactly the
    // half that decides this: the tail is refilled, and a file that will not
    // give its own size back is uncertain rather than healthy.
    fsp.open = async (/** @type {any[]} */ ...args) => {
      const handle = await realOpen(...(/** @type {[any]} */ (args)))
      handle.read = async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) })
      return handle
    }
    assert.deepEqual(await confirmIn(home, '2026-09-29T18:00:00.000Z'), { certain: false })
  } finally {
    fsp.open = realOpen
    await fs.rm(home, { recursive: true, force: true })
  }
})


/* ---------- collect + render: the false warning, end to end ---------- */

test('a metadata-only write after an idle conversation raises no capture gap', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const lastEventAt = new Date(now - 21 * MIN)
  const lastAssistant = new Date(now - 80 * MIN)
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 24 * HOUR).toISOString(),
    // The mtime is a minute old and twenty minutes past the last event: the
    // filesystem pass suspects a gap.
    transcriptMtime: new Date(now - 1 * MIN),
    transcriptLines: [
      assistantRecord(lastAssistant),
      {
        type: 'system',
        subtype: 'local_command',
        level: 'info',
        sessionId: 'sess',
        uuid: 'c1',
        content: '<local-command-stdout>auto-mode-setup: ready</local-command-stdout>',
        timestamp: new Date(now - 19 * MIN).toISOString(),
      },
    ],
  })
  try {
    writeDaemonStatus(stateRoot, lastEventAt.toISOString())

    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    const health = report.captureHealth[0]
    assert.equal(health?.state, 'ok')
    assert.equal(health?.gapMs, 0)
    // The line quotes the turn it confirmed, not the write that moved the mtime.
    assert.equal(health?.lastTranscriptActivityAt, lastAssistant.toISOString())
    assert.equal(report.diagnostics.some((d) => d.kind === 'capture_gap'), false)
    assert.equal(report.overall, 'healthy')

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
    assert.doesNotMatch(stdout.text(), /\[capture gap\]/)
    assert.doesNotMatch(stdout.text(), /\[capture unconfirmed\]/)
  } finally {
    await cleanup(hypHome, home)
  }
})

test('a healthy install is judged on the mtime alone: no transcript is opened', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const mtime = new Date(now - 1 * MIN)
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 6 * HOUR).toISOString(),
    transcriptMtime: mtime,
    // Content that would change the answer if it were read.
    transcriptLines: [assistantRecord(new Date(now - 10 * HOUR))],
  })
  try {
    writeDaemonStatus(stateRoot, new Date(now - 2 * MIN).toISOString())
    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(report.captureHealth[0]?.state, 'ok')
    assert.equal(report.captureHealth[0]?.lastTranscriptActivityAt?.slice(0, 19), mtime.toISOString().slice(0, 19))
  } finally {
    await cleanup(hypHome, home)
  }
})

test('a confirmed turn past the threshold still warns, and still escalates', async () => {
  for (const [sinceEvent, severity, overall] of /** @type {[number, string, string][]} */ ([
    [40 * MIN, 'warning', 'healthy'],
    [5 * HOUR, 'error', 'degraded'],
  ])) {
    const { hypHome, stateRoot } = await makeHome()
    const now = Date.now()
    const home = await makeClientHome({
      mode: 'otel',
      attachedAt: new Date(now - 24 * HOUR).toISOString(),
      transcriptMtime: new Date(now - 1 * MIN),
      transcriptLines: [
        assistantRecord(new Date(now - 2 * MIN)),
        { type: 'attachment', sessionId: 'sess', uuid: 'x1', attachment: { type: 'model' }, timestamp: new Date(now - 1 * MIN).toISOString() },
      ],
    })
    try {
      writeDaemonStatus(stateRoot, new Date(now - sinceEvent).toISOString())
      const report = await collectHypAwareStatus(collectOpts(hypHome, home))
      assert.equal(report.captureHealth[0]?.state, 'gap')
      assert.equal(report.diagnostics.find((d) => d.kind === 'capture_gap')?.severity, severity)
      assert.equal(report.overall, overall)
    } finally {
      await cleanup(hypHome, home)
    }
  }
})

test('an unconfirmable suspicion reports unknown: no gap claimed, no health claimed', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const lastEventAt = new Date(now - 5 * HOUR)
  /** @type {unknown[]} */
  const lines = [assistantRecord(new Date(now - 6 * HOUR))]
  for (let i = 0; i < 400; i++) {
    lines.push({
      type: 'system',
      subtype: 'local_command',
      sessionId: 'sess',
      uuid: `p${i}`,
      content: 'x'.repeat(400),
      timestamp: new Date(lastEventAt.getTime() + 60_000 + i).toISOString(),
    })
  }
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 24 * HOUR).toISOString(),
    transcriptMtime: new Date(now - 1 * MIN),
    transcriptLines: lines,
  })
  try {
    writeDaemonStatus(stateRoot, lastEventAt.toISOString())
    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(report.captureHealth[0]?.state, 'unknown')
    // Neither half of the claim: no diagnostic accusing the capture path, and
    // no `ok` certifying it.
    assert.equal(report.diagnostics.some((d) => d.kind === 'capture_gap'), false)
    assert.equal(report.overall, 'healthy')

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
    assert.match(stdout.text(), /\[capture unconfirmed\]/)

    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache') })
    assert.equal(json.capture_health[0].state, 'unknown')
  } finally {
    await cleanup(hypHome, home)
  }
})

test('a subtree whose readdir reports no file type is a corner unlooked-at, not a clean tree', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const now = Date.now()
  const lastEventAt = new Date(now - 5 * HOUR)
  const mtime = new Date(now - 1 * MIN)
  // Mixed tree. The half that reports dirent types carries a metadata-only
  // write, which is what moves the mtime and raises the suspicion; the real
  // uncaptured turn sits in the half that reports none. Certifying the whole
  // tree healthy off the half it could read is the failure this guards: a
  // walk that never looked at the file holding the turn cannot say there is
  // no turn.
  const home = await makeClientHome({
    mode: 'otel',
    attachedAt: new Date(now - 24 * HOUR).toISOString(),
    transcriptMtime: mtime,
    transcriptLines: [
      { type: 'file-history-snapshot', sessionId: 'sess', uuid: 'm0', timestamp: mtime.toISOString() },
    ],
  })
  const typeless = path.join(home, '.claude', 'projects', '-Users-t-nfs')
  await fs.mkdir(typeless, { recursive: true })
  const real = path.join(typeless, 'b-session.jsonl')
  await fs.writeFile(real, JSON.stringify(assistantRecord(mtime)) + '\n')
  await fs.utimes(real, mtime, mtime)
  const realReaddir = fsp.readdir
  try {
    writeDaemonStatus(stateRoot, lastEventAt.toISOString())
    // The dirent libuv yields wherever the filesystem's `readdir` reports no
    // `d_type` (NFS in many configurations, XFS made with `ftype=0`, several
    // FUSE filesystems): every `is*()` predicate answers false. Injected,
    // rather than mounted, because the shape is all that matters here.
    fsp.readdir = /** @type {any} */ (async (/** @type {any} */ dir, /** @type {any} */ opts) => {
      const entries = /** @type {any[]} */ (await realReaddir(dir, opts))
      if (!opts?.withFileTypes || !String(dir).endsWith('-Users-t-nfs')) return entries
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
      }))
    })
    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    fsp.readdir = realReaddir
    const entry = report.captureHealth[0]
    assert.equal(entry?.state, 'unknown')
    // Neither half of the claim, and the filesystem's suspicion is still the
    // number reported alongside it.
    assert.equal(report.diagnostics.some((d) => d.kind === 'capture_gap'), false)
    assert.ok((entry?.gapMs ?? 0) > 4 * HOUR)
  } finally {
    fsp.readdir = realReaddir
    await cleanup(hypHome, home)
  }
})
