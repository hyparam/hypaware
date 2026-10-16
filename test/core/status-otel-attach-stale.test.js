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

// `client_attach_stale` compares the attach marker's recorded GATEWAY port
// against the port the gateway is bound to now. An `otel` marker records that
// port like every other marker does, but nothing that client sends goes there:
// it talks to Anthropic directly and exports its telemetry to the listener.
// A gateway rebind therefore printed "attached at port X but the gateway is now
// bound to Y - re-attach" at a client whose capture the rebind did not touch,
// while `client_telemetry_stale` watches the port that actually decides whether
// anything is captured.
//
// @ref LLP 0086#status-drift-diagnostic [tests]: the drift warning has to name a port the attach mode depends on
// @ref LLP 0257#status-and-health [tests]: S17b - on the otel path that port is the listener's

const HOUR = 3_600_000

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-otel-attach-stale-'))
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
 * A fake $HOME whose Claude marker was written when the gateway was on 8787.
 *
 * @param {{ mode: string }} opts
 */
async function makeClientHome({ mode }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-otel-attach-stale-home-'))
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  const env = mode === 'otel'
    // Pointed at the live listener, so the endpoint comparison is satisfied and
    // the only diagnostic left in play is the gateway-port one.
    ? { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4319' }
    : { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' }
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    _hypaware: {
      attached_at: new Date(Date.now() - 6 * HOUR).toISOString(),
      version: '2.0.0',
      port: 8787,
      mode,
      managed: { env, hooks: [] },
    },
    env,
  }) + '\n')
  // One recent transcript, so the capture-health block has both halves and
  // does not raise a gap of its own.
  const dir = path.join(home, '.claude', 'projects', '-Users-t-proj')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'aaaa-session.jsonl')
  await fs.writeFile(file, '{}\n')
  const mtime = new Date(Date.now() - 60_000)
  await fs.utimes(file, mtime, mtime)
  return home
}

/** The gateway rebound to 9797; the telemetry listener is where the marker says. */
function writeDaemon(/** @type {string} */ stateRoot) {
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    sources: [
      {
        name: 'ai-gateway',
        plugin: '@hypaware/ai-gateway',
        state: 'started',
        details: { host: '127.0.0.1', port: 9797 },
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
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'foreground' }))
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

test('a gateway rebind raises no attach-stale warning against an otel-attached client', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome({ mode: 'otel' })
  try {
    writeDaemon(stateRoot)
    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(
      report.diagnostics.some((d) => d.kind === 'client_attach_stale'),
      false,
      'the gateway port is not an address this client uses'
    )
    // And the diagnostic that does watch this mode's port stays quiet too,
    // because the endpoint and the live listener agree.
    assert.equal(report.diagnostics.some((d) => d.kind === 'client_telemetry_stale'), false)
    assert.equal(report.overall, 'healthy')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('the same rebind still raises attach-stale against a gateway-routed client', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome({ mode: 'base_url' })
  try {
    writeDaemon(stateRoot)
    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    const stale = report.diagnostics.find((d) => d.kind === 'client_attach_stale')
    assert.ok(stale, 'a base-URL attach really is pointed at the port that moved')
    assert.match(stale.message, /port 8787/)
    assert.match(stale.message, /port 9797/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})
