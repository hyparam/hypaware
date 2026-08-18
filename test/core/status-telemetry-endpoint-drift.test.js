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

// An `otel` attach writes ONE endpoint into the client's settings and nothing
// ever rewrites it. The listener, meanwhile, falls back to an ephemeral port
// when its default is taken (LLP 0114 §ephemeral-fallback), and an attach that
// ran with no live daemon could only write the default in the first place. The
// two drifting apart is silent capture loss with every other status line
// healthy - and the client keeps POSTing prompts and responses at whatever
// process holds the port it was told about. `client_telemetry_stale` is that
// comparison, made from data already on disk.
//
// @ref LLP 0114#fallback-is-visible [tests]: a listener on its ephemeral fallback is visible in status, here through the client left pointing at the port it vacated
// @ref LLP 0086#status-drift-diagnostic [tests]: warn and name the repair, against the port this attach mode actually writes

const HOUR = 3_600_000

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-telemetry-drift-'))
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
 * A fake $HOME carrying an `otel` attach marker whose managed env points the
 * exporter at `endpoint`, plus one transcript so the capture-health block has
 * both halves to work with.
 *
 * @param {{ endpoint?: string, transcriptMtime?: Date }} [opts]
 */
async function makeClientHome(opts = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-telemetry-drift-home-'))
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  const env = opts.endpoint === undefined
    ? {}
    : { OTEL_EXPORTER_OTLP_ENDPOINT: opts.endpoint }
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
  const mtime = opts.transcriptMtime ?? new Date(Date.now() - 60_000)
  const dir = path.join(home, '.claude', 'projects', '-Users-t-proj')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'aaaa-session.jsonl')
  await fs.writeFile(file, '{}\n')
  await fs.utimes(file, mtime, mtime)
  return home
}

/**
 * @param {string} stateRoot
 * @param {{ listenPort: number, running: boolean }} args
 */
function writeDaemon(stateRoot, { listenPort, running }) {
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
          listen_port: listenPort,
          last_event_at: new Date(Date.now() - 120_000).toISOString(),
        },
      },
    ],
    sinks: [],
  }))
  if (running) {
    writePidFile(stateRoot, /** @type {any} */ ({
      pid: process.pid,
      runId: 'test-run',
      mode: 'foreground',
    }))
  }
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

/** @param {string} hypHome @param {string} homeDir */
async function cleanup(hypHome, homeDir) {
  await fs.rm(hypHome, { recursive: true, force: true })
  await fs.rm(homeDir, { recursive: true, force: true })
}

test('a client exporting to the port the listener vacated is a warning naming both ports', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome({ endpoint: 'http://127.0.0.1:4319' })
  try {
    // The default was taken at boot, so the listener fell back to an
    // ephemeral bind - and 4319 is now held by someone else entirely.
    writeDaemon(stateRoot, { listenPort: 54321, running: true })

    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    const stale = report.diagnostics.find((d) => d.kind === 'client_telemetry_stale')
    assert.ok(stale, 'expected a client_telemetry_stale diagnostic')
    assert.equal(stale.severity, 'warning')
    assert.match(stale.message, /port 4319/)
    assert.match(stale.message, /port 54321/)
    assert.ok(stale.repair.includes('hyp attach --client claude'))
    // Non-degrading, like every other attach-drift warning.
    assert.equal(report.overall, 'healthy')

    const claude = report.clients.find((c) => c.name === 'claude')
    assert.equal(claude?.telemetryPort, 4319)
  } finally {
    await cleanup(hypHome, home)
  }
})

test('agreement between the marker endpoint and the live bind raises nothing', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome({ endpoint: 'http://127.0.0.1:4319' })
  try {
    writeDaemon(stateRoot, { listenPort: 4319, running: true })
    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(report.diagnostics.some((d) => d.kind === 'client_telemetry_stale'), false)
    assert.equal(report.clients.find((c) => c.name === 'claude')?.telemetryPort, 4319)
  } finally {
    await cleanup(hypHome, home)
  }
})

test('a dead daemon makes no drift claim: its snapshot cannot say where anything is bound now', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const home = await makeClientHome({ endpoint: 'http://127.0.0.1:4319' })
  try {
    writeDaemon(stateRoot, { listenPort: 54321, running: false })
    const report = await collectHypAwareStatus(collectOpts(hypHome, home))
    assert.equal(report.diagnostics.some((d) => d.kind === 'client_telemetry_stale'), false)
  } finally {
    await cleanup(hypHome, home)
  }
})

test('a marker with no telemetry endpoint, or a nonsense one, reads as no claim', async () => {
  for (const endpoint of [undefined, 'not a url', 'http://127.0.0.1/', 'http://127.0.0.1:0']) {
    const { hypHome, stateRoot } = await makeHome()
    const home = await makeClientHome({ endpoint })
    try {
      writeDaemon(stateRoot, { listenPort: 54321, running: true })
      const report = await collectHypAwareStatus(collectOpts(hypHome, home))
      assert.equal(
        report.diagnostics.some((d) => d.kind === 'client_telemetry_stale'),
        false,
        `expected no drift claim for endpoint ${String(endpoint)}`
      )
      assert.equal(report.clients.find((c) => c.name === 'claude')?.telemetryPort, undefined)
    } finally {
      await cleanup(hypHome, home)
    }
  }
})
