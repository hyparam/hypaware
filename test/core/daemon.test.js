// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { renderDaemonInstall } from '../../src/core/daemon/install.js'
import { runDaemon } from '../../src/core/daemon/runtime.js'
import { readStatusFile, statusFilePath, writeStatusFile } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

/**
 * @import { DaemonStatus } from '../../src/core/daemon/types.d.ts'
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
