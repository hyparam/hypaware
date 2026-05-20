import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  LaunchAgentError,
  buildPlist,
  installLaunchAgent,
  isLaunchAgentInstalled,
  launchAgentStatus,
  uninstallLaunchAgent,
} from '../../src/daemon/macos.js'

/**
 * @import { MacosFakeCall, MacosFakeLaunchctl, MacosFakeResponses } from '../types.js'
 */

/** @type {string} */
let tmpDir
/** @type {string} */
let plistDir
/** @type {string} */
let logDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-daemon-'))
  plistDir = path.join(tmpDir, 'LaunchAgents')
  logDir = path.join(tmpDir, 'logs')
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ok = { exitCode: 0, stdout: '', stderr: '' }
const notLoaded = { exitCode: 113, stdout: '', stderr: 'Could not find service\n' }

/**
 * @param {MacosFakeResponses} [responses]
 * @returns {MacosFakeLaunchctl}
 */
function makeFakeLaunchctl(responses = {}) {
  /** @type {MacosFakeCall[]} */
  const calls = []
  let listIdx = 0
  return {
    calls,
    load(plistPath) {
      calls.push({ op: 'load', arg: plistPath })
      return Promise.resolve(responses.load ?? ok)
    },
    unload(plistPath) {
      calls.push({ op: 'unload', arg: plistPath })
      return Promise.resolve(responses.unload ?? ok)
    },
    list(label) {
      calls.push({ op: 'list', arg: label })
      const r = responses.list
      const idx = listIdx++
      if (typeof r === 'function') return Promise.resolve(r(label, idx))
      return Promise.resolve(r ?? notLoaded)
    },
  }
}

describe('buildPlist', () => {
  it('produces a stable, well-formed plist with the required keys', () => {
    const xml = buildPlist({
      label: 'com.hyparam.collectivus',
      nodePath: '/usr/local/bin/node',
      binPath: '/opt/collectivus/bin/cli.js',
      configPath: '/etc/collectivus/config.json',
      logDir: '/var/log/collectivus',
    })

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
    expect(xml).toContain('<!DOCTYPE plist PUBLIC')
    expect(xml).toContain('<plist version="1.0">')
    expect(xml).toContain('<key>Label</key>\n  <string>com.hyparam.collectivus</string>')
    expect(xml).toContain('<string>/usr/local/bin/node</string>')
    expect(xml).toContain('<string>/opt/collectivus/bin/cli.js</string>')
    expect(xml).toContain('<string>--config</string>')
    expect(xml).toContain('<string>/etc/collectivus/config.json</string>')
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(xml).toContain('<key>KeepAlive</key>\n  <true/>')
    expect(xml).toContain('<string>/var/log/collectivus/collectivus.log</string>')
    expect(xml).toContain('<string>/var/log/collectivus/collectivus.err.log</string>')
    expect(xml.endsWith('</plist>\n')).toBe(true)
  })

  it('omits EnvironmentVariables when env is not provided', () => {
    const xml = buildPlist({
      label: 'l', nodePath: 'n', binPath: 'b', configPath: 'c', logDir: 'd',
    })
    expect(xml).not.toContain('EnvironmentVariables')
  })

  it('emits EnvironmentVariables when env has entries', () => {
    const xml = buildPlist({
      label: 'l', nodePath: 'n', binPath: 'b', configPath: 'c', logDir: 'd',
      env: { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=512' },
    })
    expect(xml).toContain('<key>EnvironmentVariables</key>')
    expect(xml).toContain('<key>PATH</key>\n    <string>/usr/bin</string>')
    expect(xml).toContain('<key>NODE_OPTIONS</key>\n    <string>--max-old-space-size=512</string>')
  })

  it('emits an empty dict when env is an empty object', () => {
    const xml = buildPlist({
      label: 'l', nodePath: 'n', binPath: 'b', configPath: 'c', logDir: 'd',
      env: {},
    })
    expect(xml).toContain('<key>EnvironmentVariables</key>\n  <dict/>')
  })

  it('respects keepAlive=false and runAtLoad=false overrides', () => {
    const xml = buildPlist({
      label: 'l', nodePath: 'n', binPath: 'b', configPath: 'c', logDir: 'd',
      keepAlive: false, runAtLoad: false,
    })
    expect(xml).toContain('<key>RunAtLoad</key>\n  <false/>')
    expect(xml).toContain('<key>KeepAlive</key>\n  <false/>')
  })

  it('XML-escapes special characters in string values', () => {
    const xml = buildPlist({
      label: 'a&b<c>d',
      nodePath: '/n',
      binPath: '/b',
      configPath: '/c',
      logDir: '/l',
      env: { 'K&Y': '<v>' },
    })
    expect(xml).toContain('<string>a&amp;b&lt;c&gt;d</string>')
    expect(xml).toContain('<key>K&amp;Y</key>')
    expect(xml).toContain('<string>&lt;v&gt;</string>')
  })

  it('throws LaunchAgentError when required fields are missing', () => {
    // @ts-expect-error - intentionally invalid for runtime check
    expect(() => buildPlist({})).toThrow(LaunchAgentError)
    // @ts-expect-error - missing logDir
    expect(() => buildPlist({ label: 'l', nodePath: 'n', binPath: 'b', configPath: 'c' })).toThrow(/logDir is required/)
  })

  it('rejects non-string env values', () => {
    expect(() => buildPlist({
      label: 'l', nodePath: 'n', binPath: 'b', configPath: 'c', logDir: 'd',
      // @ts-expect-error - intentional bad type
      env: { X: 5 },
    })).toThrow(/env\.X must be a string/)
  })
})

describe('installLaunchAgent', () => {
  it('writes the plist atomically and loads it when not previously loaded', async () => {
    const fake = makeFakeLaunchctl()
    await installLaunchAgent({
      label: 'com.test.alpha',
      binPath: '/bin/x',
      configPath: '/etc/x.json',
      logDir,
      nodePath: '/usr/local/bin/node',
      plistDir,
      launchctl: fake,
    })

    const plistPath = path.join(plistDir, 'com.test.alpha.plist')
    expect(fs.existsSync(plistPath)).toBe(true)
    const content = fs.readFileSync(plistPath, 'utf8')
    expect(content).toContain('<string>com.test.alpha</string>')
    expect(content).toContain('<string>/bin/x</string>')

    expect(fake.calls.map((c) => c.op)).toEqual(['list', 'load'])
    expect(fake.calls[1].arg).toBe(plistPath)
  })

  it('creates plistDir and logDir if they do not exist', async () => {
    const fake = makeFakeLaunchctl()
    expect(fs.existsSync(plistDir)).toBe(false)
    expect(fs.existsSync(logDir)).toBe(false)
    await installLaunchAgent({
      label: 'l', binPath: 'b', configPath: 'c', logDir, plistDir, launchctl: fake,
    })
    expect(fs.existsSync(plistDir)).toBe(true)
    expect(fs.existsSync(logDir)).toBe(true)
  })

  it('unloads the existing agent before reloading when already loaded', async () => {
    fs.mkdirSync(plistDir, { recursive: true })
    const plistPath = path.join(plistDir, 'l.plist')
    fs.writeFileSync(plistPath, '<plist>old</plist>')

    const fake = makeFakeLaunchctl({
      list: { exitCode: 0, stdout: '{ "Label" = "l"; "PID" = 9999; };', stderr: '' },
    })
    await installLaunchAgent({
      label: 'l', binPath: 'b', configPath: 'c', logDir, plistDir, launchctl: fake,
    })

    expect(fake.calls.map((c) => c.op)).toEqual(['list', 'unload', 'load'])
    expect(fake.calls[1].arg).toBe(plistPath)
    expect(fake.calls[2].arg).toBe(plistPath)
    // file replaced with new content
    expect(fs.readFileSync(plistPath, 'utf8')).toContain('<plist version="1.0">')
  })

  it('skips the unload step when launchctl reports loaded but no plist file exists', async () => {
    const fake = makeFakeLaunchctl({
      list: { exitCode: 0, stdout: '{ "Label" = "l"; };', stderr: '' },
    })
    await installLaunchAgent({
      label: 'l', binPath: 'b', configPath: 'c', logDir, plistDir, launchctl: fake,
    })
    // no unload because the file did not exist when we checked
    expect(fake.calls.map((c) => c.op)).toEqual(['list', 'load'])
  })

  it('does not leave the tmp file behind on success', async () => {
    const fake = makeFakeLaunchctl()
    await installLaunchAgent({
      label: 'l', binPath: 'b', configPath: 'c', logDir, plistDir, launchctl: fake,
    })
    const entries = fs.readdirSync(plistDir)
    expect(entries).toEqual(['l.plist'])
  })

  it('throws when launchctl load returns non-zero', async () => {
    const fake = makeFakeLaunchctl({
      load: { exitCode: 5, stdout: '', stderr: 'Load failed: 5: Input/output error\n' },
    })
    await expect(installLaunchAgent({
      label: 'l', binPath: 'b', configPath: 'c', logDir, plistDir, launchctl: fake,
    })).rejects.toThrow(/failed to load LaunchAgent l: Load failed: 5/)
  })

  it('throws when unload of an existing loaded agent fails', async () => {
    fs.mkdirSync(plistDir, { recursive: true })
    fs.writeFileSync(path.join(plistDir, 'l.plist'), 'pre-existing')
    const fake = makeFakeLaunchctl({
      list: { exitCode: 0, stdout: '{};', stderr: '' },
      unload: { exitCode: 1, stdout: '', stderr: 'unload boom\n' },
    })
    await expect(installLaunchAgent({
      label: 'l', binPath: 'b', configPath: 'c', logDir, plistDir, launchctl: fake,
    })).rejects.toThrow(/failed to unload existing LaunchAgent l: unload boom/)
  })

  it('uses process.execPath when nodePath is not provided', async () => {
    const fake = makeFakeLaunchctl()
    await installLaunchAgent({
      label: 'l', binPath: 'b', configPath: 'c', logDir, plistDir, launchctl: fake,
    })
    const content = fs.readFileSync(path.join(plistDir, 'l.plist'), 'utf8')
    expect(content).toContain(`<string>${process.execPath}</string>`)
  })
})

describe('uninstallLaunchAgent', () => {
  it('is a no-op when the plist file does not exist', async () => {
    const fake = makeFakeLaunchctl()
    await uninstallLaunchAgent({ label: 'missing', plistDir, launchctl: fake })
    expect(fake.calls).toEqual([])
  })

  it('unloads then removes the plist file when present', async () => {
    fs.mkdirSync(plistDir, { recursive: true })
    const plistPath = path.join(plistDir, 'l.plist')
    fs.writeFileSync(plistPath, 'x')
    const fake = makeFakeLaunchctl()
    await uninstallLaunchAgent({ label: 'l', plistDir, launchctl: fake })
    expect(fake.calls.map((c) => c.op)).toEqual(['unload'])
    expect(fake.calls[0].arg).toBe(plistPath)
    expect(fs.existsSync(plistPath)).toBe(false)
  })

  it('still removes the plist file when launchctl unload fails (already unloaded)', async () => {
    fs.mkdirSync(plistDir, { recursive: true })
    const plistPath = path.join(plistDir, 'l.plist')
    fs.writeFileSync(plistPath, 'x')
    const fake = makeFakeLaunchctl({
      unload: { exitCode: 113, stdout: '', stderr: 'Could not find\n' },
    })
    await uninstallLaunchAgent({ label: 'l', plistDir, launchctl: fake })
    expect(fs.existsSync(plistPath)).toBe(false)
  })
})

describe('isLaunchAgentInstalled', () => {
  it('returns true when the plist file exists', async () => {
    fs.mkdirSync(plistDir, { recursive: true })
    fs.writeFileSync(path.join(plistDir, 'present.plist'), 'x')
    expect(await isLaunchAgentInstalled({ label: 'present', plistDir })).toBe(true)
  })

  it('returns false when the plist file does not exist', async () => {
    expect(await isLaunchAgentInstalled({ label: 'absent', plistDir })).toBe(false)
  })
})

describe('launchAgentStatus', () => {
  it('returns { loaded: false } when launchctl reports the service is missing', async () => {
    const fake = makeFakeLaunchctl()
    expect(await launchAgentStatus({ label: 'l', launchctl: fake })).toEqual({ loaded: false })
  })

  it('returns { loaded: true, pid } when the agent is running', async () => {
    const stdout = '{\n\t"Label" = "l";\n\t"PID" = 12345;\n};\n'
    const fake = makeFakeLaunchctl({ list: { exitCode: 0, stdout, stderr: '' } })
    expect(await launchAgentStatus({ label: 'l', launchctl: fake })).toEqual({ loaded: true, pid: 12345 })
  })

  it('returns { loaded: true } without a pid when the agent is loaded but not currently running', async () => {
    const stdout = '{\n\t"Label" = "l";\n\t"LastExitStatus" = 0;\n};\n'
    const fake = makeFakeLaunchctl({ list: { exitCode: 0, stdout, stderr: '' } })
    expect(await launchAgentStatus({ label: 'l', launchctl: fake })).toEqual({ loaded: true })
  })
})

const integrationDescribe = process.platform === 'darwin' ? describe : describe.skip
const RANDOM_SUFFIX = `${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}`
const TEST_LABEL = `com.hyparam.collectivus.test.${RANDOM_SUFFIX}`

integrationDescribe('LaunchAgent integration (darwin)', () => {
  it('loads, observes, and unloads a no-op LaunchAgent', async () => {
    const integrationPlistDir = path.join(tmpDir, 'real-plists')
    const integrationLogDir = path.join(tmpDir, 'real-logs')

    try {
      // /usr/bin/true ignores its arguments and exits 0; KeepAlive=false stops
      // launchd from continuously respawning a process that exits immediately.
      await installLaunchAgent({
        label: TEST_LABEL,
        nodePath: '/usr/bin/true',
        binPath: '/dev/null',
        configPath: '/dev/null',
        logDir: integrationLogDir,
        plistDir: integrationPlistDir,
        keepAlive: false,
        runAtLoad: false,
      })

      const installed = await isLaunchAgentInstalled({ label: TEST_LABEL, plistDir: integrationPlistDir })
      expect(installed).toBe(true)

      const status = await launchAgentStatus({ label: TEST_LABEL })
      expect(status.loaded).toBe(true)
    } finally {
      await uninstallLaunchAgent({ label: TEST_LABEL, plistDir: integrationPlistDir })
      const after = await launchAgentStatus({ label: TEST_LABEL })
      expect(after.loaded).toBe(false)
    }
  })
})
