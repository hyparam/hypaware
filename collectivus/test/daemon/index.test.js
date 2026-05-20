import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DaemonError, installDaemon, uninstallDaemon } from '../../src/daemon/index.js'

/**
 * @import { LaunchctlAdapter, SystemctlAdapter } from '../../src/daemon/types.d.ts'
 */

/** @type {string} */
let tmpDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-daemon-idx-'))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ok = { exitCode: 0, stdout: '', stderr: '' }
const notLoaded = { exitCode: 113, stdout: '', stderr: '' }

/**
 * @returns {{ calls: string[], adapter: LaunchctlAdapter }}
 */
function makeRecordingLaunchctl() {
  /** @type {string[]} */
  const calls = []
  return {
    calls,
    adapter: {
      load(p) { calls.push(`load ${p}`); return Promise.resolve(ok) },
      unload(p) { calls.push(`unload ${p}`); return Promise.resolve(ok) },
      list(l) { calls.push(`list ${l}`); return Promise.resolve(notLoaded) },
    },
  }
}

/**
 * @returns {{ calls: string[], adapter: SystemctlAdapter }}
 */
function makeRecordingSystemctl() {
  /** @type {string[]} */
  const calls = []
  return {
    calls,
    adapter: {
      daemonReload() { calls.push('daemon-reload'); return Promise.resolve(ok) },
      enable(u) { calls.push(`enable ${u}`); return Promise.resolve(ok) },
      disable(u) { calls.push(`disable ${u}`); return Promise.resolve(ok) },
      restart(u) { calls.push(`restart ${u}`); return Promise.resolve(ok) },
      stop(u) { calls.push(`stop ${u}`); return Promise.resolve(ok) },
      show(u) { calls.push(`show ${u}`); return Promise.resolve(ok) },
    },
  }
}

/**
 * Run `fn` with `process.platform` temporarily set to `value`, restoring the
 * original descriptor afterward (process.platform is a non-writable getter
 * by default, hence the defineProperty dance).
 *
 * @param {NodeJS.Platform} value
 * @param {() => Promise<void> | void} fn
 * @returns {Promise<void>}
 */
async function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true, writable: true })
  try {
    await fn()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

describe('installDaemon / uninstallDaemon', () => {
  it('throws DaemonError on unsupported platforms', async () => {
    await withPlatform('win32', async () => {
      await expect(installDaemon({
        label: 'l', binPath: 'b', configPath: 'c', logDir: tmpDir,
      })).rejects.toThrow(DaemonError)
      await expect(uninstallDaemon({ label: 'l' })).rejects.toThrow(/unsupported platform: win32/)
    })
  })

  it('dispatches to the macos backend on darwin', async () => {
    const fake = makeRecordingLaunchctl()
    const plistDir = path.join(tmpDir, 'plists')

    await withPlatform('darwin', async () => {
      await installDaemon({
        label: 'com.test.dispatch',
        binPath: '/bin/x',
        configPath: '/etc/x.json',
        logDir: tmpDir,
        plistDir,
        launchctl: fake.adapter,
      })
    })
    expect(fake.calls).toContain('load ' + path.join(plistDir, 'com.test.dispatch.plist'))
  })

  it('dispatches to the linux backend on linux for install', async () => {
    const fake = makeRecordingSystemctl()
    const unitDir = path.join(tmpDir, 'units')

    await withPlatform('linux', async () => {
      await installDaemon({
        label: 'com.test.dispatch',
        binPath: '/bin/x',
        configPath: '/etc/x.json',
        logDir: tmpDir,
        unitDir,
        systemctl: fake.adapter,
      })
    })
    expect(fs.existsSync(path.join(unitDir, 'com.test.dispatch.service'))).toBe(true)
    expect(fake.calls).toEqual([
      'daemon-reload',
      'enable com.test.dispatch.service',
      'restart com.test.dispatch.service',
    ])
  })

  it('dispatches to the linux backend on linux for uninstall', async () => {
    const fake = makeRecordingSystemctl()
    const unitDir = path.join(tmpDir, 'units')
    fs.mkdirSync(unitDir, { recursive: true })
    const unitPath = path.join(unitDir, 'com.test.dispatch.service')
    fs.writeFileSync(unitPath, 'placeholder')

    await withPlatform('linux', async () => {
      await uninstallDaemon({
        label: 'com.test.dispatch',
        unitDir,
        systemctl: fake.adapter,
      })
    })
    expect(fs.existsSync(unitPath)).toBe(false)
    expect(fake.calls).toEqual([
      'stop com.test.dispatch.service',
      'disable com.test.dispatch.service',
      'daemon-reload',
    ])
  })
})
