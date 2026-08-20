// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// A per-signal OTLP variable in the user's own shell outranks the general
// endpoint an `otel` attach writes, so Claude Code exports its logs and
// metrics wherever that key points - including at nothing at all, when the
// key is exported empty. Every other surface stays healthy while this happens:
// the settings file is byte-perfect, the listener is bound and started, and
// the raw-body spool even keeps growing, because `OTEL_LOG_RAW_API_BODIES` is
// a file path and endpoint precedence cannot touch it. `capture_gap` notices
// the silence eventually and cannot name its cause. This diagnostic is the
// third leg next to it and `client_telemetry_stale`: the cause, named, from a
// value already in hand.
//
// @ref LLP 0271#status-names-it-too [tests]
// @ref LLP 0114#fallback-is-visible [tests]: a redirected export is visible in status rather than only silently wrong

const HOUR = 3_600_000

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-telemetry-envover-'))
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

/** A fake $HOME carrying a healthy `otel` attach marker plus one transcript. */
async function makeClientHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-telemetry-envover-home-'))
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4319' }
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    _hypaware: {
      attached_at: new Date(Date.now() - 6 * HOUR).toISOString(),
      version: '2.0.0',
      port: 8787,
      mode: 'otel',
      managed: { env, hooks: [] },
    },
    env,
  }) + '\n')
  const mtime = new Date(Date.now() - 60_000)
  const dir = path.join(home, '.claude', 'projects', '-Users-t-proj')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'aaaa-session.jsonl')
  await fs.writeFile(file, '{}\n')
  await fs.utimes(file, mtime, mtime)
  return home
}

/** @param {string} stateRoot */
function writeDaemon(stateRoot) {
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
          last_event_at: new Date(Date.now() - 120_000).toISOString(),
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
}

/**
 * @param {string} hypHome
 * @param {string} homeDir
 * @param {Record<string, string>} [extraEnv]
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome, homeDir, extraEnv = {}) {
  const base = { ...process.env }
  // The suite itself may run under a collector's exports; the scenario is
  // whatever this case sets, nothing inherited.
  for (const key of Object.keys(base)) {
    if (key.startsWith('OTEL_EXPORTER_OTLP_')) delete base[key]
  }
  return {
    env: { ...base, HYP_HOME: hypHome, HYP_CONFIG: '', ...extraEnv },
    homeDir,
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

/** @param {string} hypHome @param {string} homeDir */
async function cleanup(hypHome, homeDir) {
  await fs.rm(hypHome, { recursive: true, force: true })
  await fs.rm(homeDir, { recursive: true, force: true })
}

test('a per-signal OTLP key in the environment is named as redirecting capture', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome()
  try {
    writeDaemon(stateRoot)
    const report = await collectHypAwareStatus(collectOpts(hypHome, home, {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://token@collector.corp:4318',
    }))
    const found = report.diagnostics.find((d) => d.kind === 'client_telemetry_env_override')
    assert.ok(found, 'expected a client_telemetry_env_override diagnostic')
    assert.equal(found.severity, 'warning')
    assert.match(found.message, /OTEL_EXPORTER_OTLP_LOGS_ENDPOINT/)
    // The value is a collector URL that routinely carries a credential, and
    // this string is printed, logged, and serialised into `--json`.
    assert.doesNotMatch(found.message, /collector\.corp/)
    assert.doesNotMatch(found.message, /token/)
    assert.ok(found.repair.length > 0)
    // Non-degrading, like every other attach-drift warning: `hyp status` reads
    // the shell it was run from, which is not necessarily the one Claude Code
    // launches from, so this is a strong lead and not a proof.
    assert.equal(report.overall, 'healthy')
  } finally {
    await cleanup(hypHome, home)
  }
})

test('an empty per-signal value is the blackhole case and still raises the diagnostic', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome()
  try {
    writeDaemon(stateRoot)
    const report = await collectHypAwareStatus(collectOpts(hypHome, home, {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
    }))
    const found = report.diagnostics.find((d) => d.kind === 'client_telemetry_env_override')
    assert.ok(found, 'expected a client_telemetry_env_override diagnostic')
    assert.match(found.message, /OTEL_EXPORTER_OTLP_LOGS_ENDPOINT/)
  } finally {
    await cleanup(hypHome, home)
  }
})

test('a clean environment raises nothing', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome()
  try {
    writeDaemon(stateRoot)
    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(
      report.diagnostics.some((d) => d.kind === 'client_telemetry_env_override'),
      false
    )
  } finally {
    await cleanup(hypHome, home)
  }
})

test('a traces-only key redirects nothing this attach turns on, so it is not raised', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome()
  try {
    writeDaemon(stateRoot)
    const report = await collectHypAwareStatus(collectOpts(hypHome, home, {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.corp:4318',
    }))
    assert.equal(
      report.diagnostics.some((d) => d.kind === 'client_telemetry_env_override'),
      false
    )
  } finally {
    await cleanup(hypHome, home)
  }
})

// `hyp status` promises that "repair: lines are commands you can run directly"
// (core_commands.js). `unset A, B` is the one shape where that promise fails
// silently: bash exits 0 and unsets only `B`, leaving the key that was eating
// capture still exported while the user believes they ran the fix. Two keys is
// exactly the shape issue #858 was reported with.
test('the repair unsets every key in one runnable command, not a comma list', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome()
  try {
    writeDaemon(stateRoot)
    const report = await collectHypAwareStatus(collectOpts(hypHome, home, {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
    }))
    const found = report.diagnostics.find((d) => d.kind === 'client_telemetry_env_override')
    assert.ok(found, 'expected a client_telemetry_env_override diagnostic')
    const unsetLine = found.repair.find((r) => r.startsWith('unset '))
    assert.ok(unsetLine, `expected an unset repair line, got ${JSON.stringify(found.repair)}`)
    const command = unsetLine.split('#')[0].trim()
    assert.equal(
      command,
      'unset OTEL_EXPORTER_OTLP_LOGS_ENDPOINT OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'
    )
    assert.doesNotMatch(command, /,/)
  } finally {
    await cleanup(hypHome, home)
  }
})

// A headers key routes nothing. It is on the list for the opposite hazard
// (LLP 0271 #the-key-list): a collector credential riding requests aimed at the
// loopback listener. Reporting it with the redirect sentence would tell a user
// whose capture is working perfectly that none of it is captured, on every
// `hyp status` run - the standing false alarm that teaches people to skip the
// line that matters.
test('a headers key is reported as a credential leak, not as lost capture', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome()
  try {
    writeDaemon(stateRoot)
    const report = await collectHypAwareStatus(collectOpts(hypHome, home, {
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer sekrit',
    }))
    const found = report.diagnostics.find((d) => d.kind === 'client_telemetry_env_override')
    assert.ok(found, 'expected a client_telemetry_env_override diagnostic')
    assert.match(found.message, /OTEL_EXPORTER_OTLP_HEADERS/)
    assert.doesNotMatch(found.message, /none of it is captured/)
    assert.doesNotMatch(found.message, /outrank/)
    assert.doesNotMatch(found.message, /sekrit/)
    assert.equal(report.overall, 'healthy')
  } finally {
    await cleanup(hypHome, home)
  }
})

// The false alarm one list entry over from the headers one. A per-signal key
// outranks only its own signal, and attach turns on two exporters: a shell
// exporting nothing but `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to a collector -
// an ordinary setup - loses the token and cost counters while every prompt and
// response still reaches the listener. A blanket "none of it is captured" on
// every `hyp status` run is exactly what teaches a user to skip the line.
// @ref LLP 0271#the-key-list [tests]
test('a single-signal override names the signal instead of claiming total loss', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome()
  try {
    writeDaemon(stateRoot)
    const metricsOnly = await collectHypAwareStatus(collectOpts(hypHome, home, {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://collector.corp:4318',
    }))
    const metrics = metricsOnly.diagnostics.find((d) => d.kind === 'client_telemetry_env_override')
    assert.ok(metrics, 'expected a client_telemetry_env_override diagnostic')
    assert.match(metrics.message, /metrics are captured/)
    assert.doesNotMatch(metrics.message, /none of it is captured/)

    const logsOnly = await collectHypAwareStatus(collectOpts(hypHome, home, {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://collector.corp:4318',
    }))
    const logs = logsOnly.diagnostics.find((d) => d.kind === 'client_telemetry_env_override')
    assert.ok(logs, 'expected a client_telemetry_env_override diagnostic')
    assert.match(logs.message, /log records are captured/)
    assert.doesNotMatch(logs.message, /none of it is captured/)

    // Both signals overridden is the one case where the blanket claim is true.
    const both = await collectHypAwareStatus(collectOpts(hypHome, home, {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
    }))
    const all = both.diagnostics.find((d) => d.kind === 'client_telemetry_env_override')
    assert.ok(all, 'expected a client_telemetry_env_override diagnostic')
    assert.match(all.message, /none of it is captured/)
  } finally {
    await cleanup(hypHome, home)
  }
})

// Both hazards at once are two findings, because they have two different
// consequences and two different sentences. The routing one must keep its
// lost-capture claim, scoped to the signal it is about; the headers one must
// not acquire it.
test('a routing key and a headers key are reported apart', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome()
  try {
    writeDaemon(stateRoot)
    const report = await collectHypAwareStatus(collectOpts(hypHome, home, {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://collector.corp:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer sekrit',
    }))
    const found = report.diagnostics.filter((d) => d.kind === 'client_telemetry_env_override')
    assert.equal(found.length, 2)
    const routing = found.find((d) => d.message.includes('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'))
    const headers = found.find((d) => d.message.includes('OTEL_EXPORTER_OTLP_HEADERS'))
    assert.ok(routing && headers)
    assert.match(routing.message, /log records are captured/)
    assert.doesNotMatch(routing.message, /OTEL_EXPORTER_OTLP_HEADERS/)
    assert.doesNotMatch(headers.message, /is captured/)
  } finally {
    await cleanup(hypHome, home)
  }
})
