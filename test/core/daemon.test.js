// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { renderDaemonInstall } from '../../src/core/daemon/install.js'
import { runDaemon } from '../../src/core/daemon/runtime.js'
import {
  probeClientAttachFromDescriptor,
  readStatusFile,
  statusFilePath,
  writeStatusFile,
} from '../../src/core/daemon/status.js'
import { resolveClientSettingsPath } from '../../src/core/daemon/client_settings_path.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

/**
 * @import { ClientDescriptor } from '../../src/core/types.js'
 * @import { DaemonStatus } from '../../src/core/daemon/types.js'
 */

test('writeStatusFile writes an atomic readable status snapshot', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-status-test-'))
  /** @type {DaemonStatus} */
  const status = {
    state: 'healthy',
    pid: 12345,
    startedAt: '2026-05-21T00:00:00.000Z',
    healthyAt: '2026-05-21T00:00:01.000Z',
    uptimeMs: 1000,
    runId: 'test-run',
    mode: 'foreground',
    sources: [{ name: 'otel', plugin: '@hypaware/otel', state: 'started' }],
    sinks: [{ instance: 'local', plugin: '@hypaware/local-fs', kind: 'blob' }],
  }

  writeStatusFile(tmp, status)

  assert.deepEqual(readStatusFile(tmp), status)
  assert.equal(path.basename(statusFilePath(tmp)), 'status.json')
})

test('readStatusFile returns null before the daemon has written status', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-status-missing-test-'))

  assert.equal(readStatusFile(tmp), null)
})

test('resolveClientSettingsPath sanitizes client env override names', () => {
  assert.equal(
    resolveClientSettingsPath(
      'claude-desktop',
      '.claude-desktop/settings.json',
      { CLAUDE_DESKTOP_HOME: '/tmp/claude-desktop-home' },
      '/Users/hyp'
    ),
    '/tmp/claude-desktop-home/settings.json'
  )
  assert.equal(
    resolveClientSettingsPath('codex', '.codex/config.toml', {}, '/Users/hyp'),
    '/Users/hyp/.codex/config.toml'
  )
})

test('probeClientAttachFromDescriptor reads JSON attach markers', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-attach-json-'))
  const settingsPath = path.join(tmp, '.claude', 'settings.json')
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, JSON.stringify({ _hypaware: { version: '2.0.0', port: 4388 } }))

  const descriptor = /** @type {ClientDescriptor} */ ({
    plugin: '@hypaware/claude',
    name: 'claude',
    skillDir: '.claude/skills',
    attachProbe: {
      format: 'json',
      settings_file: '.claude/settings.json',
      marker_key: '_hypaware',
    },
  })

  assert.deepEqual(
    await probeClientAttachFromDescriptor({ descriptor, homeDir: tmp }),
    {
      attached: true,
      settingsPath,
      version: '2.0.0',
      port: '4388',
    }
  )
})

test('probeClientAttachFromDescriptor honors sanitized TOML home overrides', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-attach-toml-'))
  const overrideHome = path.join(tmp, 'claude-desktop-home')
  const settingsPath = path.join(overrideHome, 'config.toml')
  await fs.mkdir(overrideHome, { recursive: true })
  await fs.writeFile(settingsPath, '[hypaware.gateway]\n')

  const descriptor = /** @type {ClientDescriptor} */ ({
    plugin: '@third-party/claude-desktop',
    name: 'claude-desktop',
    skillDir: '.claude-desktop/skills',
    attachProbe: {
      format: 'toml',
      settings_file: '.claude-desktop/config.toml',
      marker_header: '[hypaware.gateway]',
    },
  })

  assert.deepEqual(
    await probeClientAttachFromDescriptor({
      descriptor,
      homeDir: tmp,
      env: { CLAUDE_DESKTOP_HOME: overrideHome },
    }),
    {
      attached: true,
      settingsPath,
    }
  )
})

test('renderDaemonInstall renders a deterministic systemd dry-run payload', () => {
  const plan = renderDaemonInstall({
    platform: 'linux',
    homeDir: '/home/hyp',
    binPath: '/opt/hypaware/bin/hypaware.js',
    nodePath: '/usr/local/bin/node',
    label: 'hypaware-test',
    env: { HYP_ENV: 'test value' },
    restartSec: 9,
  })

  assert.equal(plan.platform, 'linux')
  assert.equal(plan.serviceKind, 'systemd unit: hypaware.service')
  assert.equal(plan.targetPath, '/home/hyp/.config/systemd/user/hypaware-test.service')
  assert.equal(plan.configPath, '/home/hyp/.hyp/hypaware-config.json')
  assert.match(plan.content, /^ExecStart=\/usr\/local\/bin\/node \/opt\/hypaware\/bin\/hypaware\.js daemon run --foreground --config \/home\/hyp\/\.hyp\/hypaware-config\.json$/m)
  assert.match(plan.content, /^RestartSec=9$/m)
  assert.match(plan.content, /^Environment="HYP_ENV=test value"$/m)
  assert.deepEqual(plan.manageCommands[0], ['systemctl', '--user', 'daemon-reload'])
})

test('renderDaemonInstall renders a deterministic LaunchAgent dry-run payload', () => {
  const plan = renderDaemonInstall({
    platform: 'darwin',
    homeDir: '/Users/hyp',
    binPath: '/Applications/HypAware/bin/hypaware.js',
    nodePath: '/usr/local/bin/node',
    label: 'app.hyperparam.hypaware.test',
    env: { HYP_CONFIG_MODE: 'acceptance' },
    keepAlive: false,
    runAtLoad: false,
  })

  assert.equal(plan.platform, 'darwin')
  assert.equal(plan.serviceKind, 'LaunchAgent: com.hyperparam.hypaware')
  assert.equal(plan.targetPath, '/Users/hyp/Library/LaunchAgents/app.hyperparam.hypaware.test.plist')
  assert.match(plan.content, /<string>app\.hyperparam\.hypaware\.test<\/string>/)
  assert.match(plan.content, /<string>\/Applications\/HypAware\/bin\/hypaware\.js<\/string>/)
  assert.match(plan.content, /<key>KeepAlive<\/key>\n  <false\/>/)
  assert.match(plan.content, /<key>HYP_CONFIG_MODE<\/key>\n    <string>acceptance<\/string>/)
  assert.deepEqual(plan.manageCommands[2], [
    'launchctl',
    'kickstart',
    '-k',
    '<user-domain>/app.hyperparam.hypaware.test',
  ])
})

test('installers default to relaunch-on-exit (staged restart requirement, LLP 0017)', () => {
  // Defaults: no keepAlive/restart override. The service manager MUST
  // relaunch the daemon after a staged config-apply exit.
  const launchd = renderDaemonInstall({
    platform: 'darwin',
    homeDir: '/Users/hyp',
    binPath: '/opt/hypaware/bin/hypaware.js',
    nodePath: '/usr/local/bin/node',
  })
  assert.match(launchd.content, /<key>KeepAlive<\/key>\n  <true\/>/)

  const systemd = renderDaemonInstall({
    platform: 'linux',
    homeDir: '/home/hyp',
    binPath: '/opt/hypaware/bin/hypaware.js',
    nodePath: '/usr/local/bin/node',
  })
  assert.match(systemd.content, /^Restart=always$/m)
})

test('the staged-restart exit code is distinct from success and error exits', async () => {
  const { DAEMON_RESTART_EXIT_CODE } = await import('../../src/core/daemon/runtime.js')
  assert.equal(typeof DAEMON_RESTART_EXIT_CODE, 'number')
  /** @type {number} */
  const code = DAEMON_RESTART_EXIT_CODE
  assert.ok(code !== 0 && code !== 1 && code !== 2)
})

test('runDaemon reload refreshes plugin config before source.reload', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-daemon-reload-config-'))
  let handle
  try {
    const installDir = await stageReloadPlugin(hypHome)
    await writeLock(path.join(hypHome, 'hypaware'), {
      schema_version: 1,
      plugins: {
        '@third-party/reload-fixture': {
          name: '@third-party/reload-fixture',
          version: '0.1.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: 'a'.repeat(64),
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-05-22T00:00:00.000Z',
        },
      },
    })
    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      plugins: [{ name: '@third-party/reload-fixture', config: { value: 'before' } }],
    }))

    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'reload-config-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    const statePath = path.join(hypHome, 'hypaware', 'plugins', '@third-party/reload-fixture', 'reload-state.json')
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), {
      started: 'before',
      reloaded: null,
    })

    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      plugins: [{ name: '@third-party/reload-fixture', config: { value: 'after' } }],
    }))
    await handle.reload()

    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), {
      started: 'before',
      reloaded: 'after',
    })
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('runDaemon reload re-merges the central layer (does not re-read local alone) - #111 regression', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-daemon-reload-central-'))
  let handle
  try {
    const installDir = await stageReloadPlugin(hypHome)
    const stateRoot = path.join(hypHome, 'hypaware')
    await writeLock(stateRoot, {
      schema_version: 1,
      plugins: {
        '@third-party/reload-fixture': {
          name: '@third-party/reload-fixture',
          version: '0.1.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: 'a'.repeat(64),
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-05-22T00:00:00.000Z',
        },
      },
    })

    // The fixture's config lives ONLY in the central layer (the join
    // seed). The local layer exists and loads, but never names it: so a
    // reload that re-read the local layer alone would lose the central
    // config and write `reloaded: undefined`.
    const seedPath = centralSeedPath(stateRoot)
    await fs.mkdir(path.dirname(seedPath), { recursive: true })
    await fs.writeFile(seedPath, JSON.stringify({
      version: 2,
      plugins: [{ name: '@third-party/reload-fixture', config: { value: 'central' } }],
    }) + '\n')

    const configPath = defaultConfigPath(hypHome)
    await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }) + '\n')

    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'reload-central-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    const statePath = path.join(stateRoot, 'plugins', '@third-party/reload-fixture', 'reload-state.json')
    // Source started from the central layer's config.
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), {
      started: 'central',
      reloaded: null,
    })

    await handle.reload()

    // After SIGHUP the merge still carries the central layer's config:
    // not `undefined` from a local-only re-read.
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), {
      started: 'central',
      reloaded: 'central',
    })
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('runDaemon health event derives from aggregate state and excludes failed sources (#138)', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-daemon-degraded-health-'))
  let handle
  try {
    const installDir = await stageFailingSourcePlugin(hypHome)
    await writeLock(path.join(hypHome, 'hypaware'), {
      schema_version: 1,
      plugins: {
        '@third-party/failing-fixture': {
          name: '@third-party/failing-fixture',
          version: '0.1.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: 'a'.repeat(64),
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-05-22T00:00:00.000Z',
        },
      },
    })
    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      plugins: [{ name: '@third-party/failing-fixture' }],
    }))

    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'degraded-health-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    // The aggregate state written to status.json reports degraded with the
    // bad source marked failed and the good source started.
    const snap = handle.snapshot()
    assert.equal(snap.state, 'degraded')
    const byName = new Map(snap.sources.map((s) => [s.name, s.state]))
    assert.equal(byName.get('ok-source'), 'started')
    assert.equal(byName.get('failing-source'), 'failed')

    // Flush the log by stopping cleanly before inspecting daemon.log.
    await handle.stop()
    await handle.done
    handle = undefined

    const logPath = path.join(hypHome, 'hypaware', 'logs', 'daemon.log')
    const raw = await fs.readFile(logPath, 'utf8')
    const events = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    // (a) The boot health event reflects degraded: NOT daemon.healthy.
    assert.equal(
      events.some((e) => e.event === 'daemon.healthy'),
      false,
      'degraded boot must not emit daemon.healthy'
    )
    const degraded = events.find((e) => e.event === 'daemon.degraded')
    assert.ok(degraded, 'degraded boot must emit daemon.degraded')

    // (b) The health event lists only sources that came up; the failed
    // source is excluded from `sources` (and surfaced under failed_sources).
    assert.deepEqual(degraded.sources, ['ok-source'])
    assert.ok(
      Array.isArray(degraded.failed_sources) &&
        degraded.failed_sources.includes('failing-source')
    )
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

/**
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function stageReloadPlugin(hypHome) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', '@third-party/reload-fixture')
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name: '@third-party/reload-fixture',
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }))
  await fs.writeFile(
    path.join(installDir, 'index.js'),
    `
import fs from 'node:fs/promises'
import path from 'node:path'

export async function activate(ctx) {
  ctx.sources.register({
    name: 'reload-fixture',
    plugin: '@third-party/reload-fixture',
    async start(startCtx) {
      const file = path.join(ctx.paths.stateDir, 'reload-state.json')
      const startedValue = startCtx.config.value
      await fs.writeFile(file, JSON.stringify({ started: startedValue, reloaded: null }))
      return {
        async reload(reloadCtx) {
          await fs.writeFile(file, JSON.stringify({ started: startedValue, reloaded: reloadCtx.config.value }))
        },
        async stop() {},
      }
    },
  })
}
`
  )
  return installDir
}

/**
 * Stage a plugin registering two sources: one that starts cleanly and one
 * whose `start()` throws (mirroring an EADDRINUSE bind failure). Used to
 * drive a degraded boot for the #138 health-event regression.
 *
 * @param {string} hypHome
 * @returns {Promise<string>}
 */
async function stageFailingSourcePlugin(hypHome) {
  const installDir = path.join(hypHome, 'hypaware', 'plugins', '@third-party/failing-fixture')
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name: '@third-party/failing-fixture',
    version: '0.1.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }))
  await fs.writeFile(
    path.join(installDir, 'index.js'),
    `
export async function activate(ctx) {
  ctx.sources.register({
    name: 'ok-source',
    plugin: '@third-party/failing-fixture',
    async start() {
      return { async stop() {} }
    },
  })
  ctx.sources.register({
    name: 'failing-source',
    plugin: '@third-party/failing-fixture',
    async start() {
      throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:8787')
    },
  })
}
`
  )
  return installDir
}
