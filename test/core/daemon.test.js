// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { renderDaemonInstall } from '../../src/core/daemon/install.js'
import { readStatusFile, statusFilePath, writeStatusFile } from '../../src/core/daemon/status.js'

test('writeStatusFile writes an atomic readable status snapshot', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-status-test-'))
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
