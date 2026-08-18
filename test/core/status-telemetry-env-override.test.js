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
