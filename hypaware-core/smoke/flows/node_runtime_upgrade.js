// @ts-check

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger, installObservability } from '../../../src/core/observability/index.js'
import { ensureNodeRuntime, runNodeRuntimeCommand } from '../../../src/core/update/node_runtime.js'
import { replaceServiceNode, repointNodeRuntime } from '../../../src/core/update/node_runtime_handover.js'
import { buildPlist } from '../../../src/core/daemon/macos.js'
import { buildUnit } from '../../../src/core/daemon/linux.js'

/**
 * Hermetic integrity and service-handover workflow. The archive is a local
 * fixture whose executable delegates to this smoke's patched Node; the real
 * nodejs.org download and a real service manager remain installed-host gates.
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('node_runtime_upgrade requires macOS or Linux')
  const obs = installObservability()
  const logger = getLogger('node-runtime-smoke')
  const log = (event, fields = {}) => logger.info(event, {
    [Attr.COMPONENT]: 'node-runtime', [Attr.DEV_RUN_ID]: harness.devRunId,
    smoke_name: harness.smokeName, smoke_step: event, ...fields,
  })
  try {
    const top = `node-v${process.versions.node}-${process.platform}-${process.arch}`
    const fixture = path.join(harness.tmpDir, top)
    await fs.mkdir(path.join(fixture, 'bin'), { recursive: true })
    const quoted = "'" + process.execPath.replaceAll("'", "'\\''") + "'"
    await fs.writeFile(path.join(fixture, 'bin', 'node'), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 })
    const archive = path.join(harness.tmpDir, 'node-fixture.tar.gz')
    const packed = await runNodeRuntimeCommand('tar', ['-czf', archive, '-C', harness.tmpDir, top], { env: process.env })
    expect.that('fixture archive built', packed.exitCode, code => code === 0)
    const bytes = await fs.readFile(archive)
    const artifact = {
      version: process.versions.node, platform: process.platform, arch: process.arch,
      filename: top + '.tar.gz', sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }
    const runtime = await ensureNodeRuntime({
      env: process.env, artifact, download: async (_artifact, destination) => { await fs.copyFile(archive, destination) }, log,
    })
    expect.that('verified runtime has a stable executable path', await fs.realpath(runtime.nodePath), file => file.endsWith('/bin/node'))

    for (const platform of ['darwin', 'linux']) {
      const file = path.join(harness.tmpDir, platform + '-service')
      const options = { nodePath: '/old/bin/node', binPath: '/original/bin/hyp', configPath: '/original/config.json', logDir: '/original/logs', env: { CUSTOM: 'preserved' } }
      const original = platform === 'darwin' ? buildPlist(options) : buildUnit(options)
      await fs.writeFile(file, original)
      const steps = []
      await repointNodeRuntime({
        env: process.env, platform, file, oldNodePath: options.nodePath, binPath: options.binPath, nodePath: runtime.nodePath, oldPid: 123,
        stop: async () => { steps.push('stop') }, reload: async () => { steps.push('reload') },
        start: async () => { steps.push('start') }, healthy: async () => { steps.push('healthy') }, log,
      })
      const expected = replaceServiceNode(original, platform, options.nodePath, runtime.nodePath, options.binPath)
      expect.that(`${platform}: service interpreter changed without losing custom settings`, await fs.readFile(file, 'utf8'), value => value === expected)
      expect.that(`${platform}: health was verified after restart`, steps.join(','), value => value === 'stop,reload,start,healthy')
    }
  } finally { await obs.shutdown() }
  const logs = await expect.logs()
  for (const event of ['node_runtime.downloading', 'node_runtime.verified', 'node_runtime.daemon_repointed']) {
    expect.that(`telemetry: ${event} identifies its workflow step`, logs, records => records.some(record => record.body === event && record.attributes?.smoke_step === event))
  }
}
