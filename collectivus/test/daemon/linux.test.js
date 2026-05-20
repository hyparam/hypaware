import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  SystemdUnitError,
  buildUnit,
  installSystemdUnit,
  isSystemdUnitInstalled,
  systemdUnitStatus,
  uninstallSystemdUnit,
} from '../../src/daemon/linux.js'

/**
 * @import { LinuxFakeCall, LinuxFakeSystemctl, LinuxFakeResponses } from '../types.js'
 */

/** @type {string} */
let tmpDir
/** @type {string} */
let unitDir
/** @type {string} */
let logDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-systemd-'))
  unitDir = path.join(tmpDir, 'systemd-user')
  logDir = path.join(tmpDir, 'logs')
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ok = { exitCode: 0, stdout: '', stderr: '' }
const notFound = { exitCode: 5, stdout: '', stderr: 'Unit not loaded\n' }

/**
 * @param {LinuxFakeResponses} [responses]
 * @returns {LinuxFakeSystemctl}
 */
function makeFakeSystemctl(responses = {}) {
  /** @type {LinuxFakeCall[]} */
  const calls = []
  let showIdx = 0
  return {
    calls,
    daemonReload() {
      calls.push({ op: 'daemonReload' })
      return Promise.resolve(responses.daemonReload ?? ok)
    },
    enable(unit) {
      calls.push({ op: 'enable', arg: unit })
      return Promise.resolve(responses.enable ?? ok)
    },
    disable(unit) {
      calls.push({ op: 'disable', arg: unit })
      return Promise.resolve(responses.disable ?? ok)
    },
    restart(unit) {
      calls.push({ op: 'restart', arg: unit })
      return Promise.resolve(responses.restart ?? ok)
    },
    stop(unit) {
      calls.push({ op: 'stop', arg: unit })
      return Promise.resolve(responses.stop ?? ok)
    },
    show(unit) {
      calls.push({ op: 'show', arg: unit })
      const r = responses.show
      const idx = showIdx++
      if (typeof r === 'function') return Promise.resolve(r(unit, idx))
      return Promise.resolve(r ?? notFound)
    },
  }
}

describe('buildUnit', () => {
  it('produces a stable, well-formed unit with the required sections', () => {
    const unit = buildUnit({
      description: 'Collectivus daemon',
      nodePath: '/usr/local/bin/node',
      binPath: '/opt/collectivus/bin/cli.js',
      configPath: '/etc/collectivus/config.json',
      logDir: '/var/log/collectivus',
    })

    expect(unit).toContain('[Unit]\nDescription=Collectivus daemon')
    expect(unit).toContain('[Service]')
    expect(unit).toContain('Type=simple')
    expect(unit).toContain('ExecStart=/usr/local/bin/node /opt/collectivus/bin/cli.js --config /etc/collectivus/config.json')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('RestartSec=5')
    expect(unit).toContain('StandardOutput=append:/var/log/collectivus/collectivus.log')
    expect(unit).toContain('StandardError=append:/var/log/collectivus/collectivus.err.log')
    expect(unit).toContain('[Install]\nWantedBy=default.target')
    expect(unit.endsWith('\n')).toBe(true)
  })

  it('omits Environment when env is not provided', () => {
    const unit = buildUnit({
      description: 'd',
      nodePath: 'n',
      binPath: 'b',
      configPath: 'c',
      logDir: 'l',
    })
    expect(unit).not.toContain('Environment=')
  })

  it('emits Environment entries when env has entries', () => {
    const unit = buildUnit({
      description: 'd',
      nodePath: 'n',
      binPath: 'b',
      configPath: 'c',
      logDir: 'l',
      env: { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=512' },
    })
    expect(unit).toContain('Environment="PATH=/usr/bin"')
    expect(unit).toContain('Environment="NODE_OPTIONS=--max-old-space-size=512"')
  })

  it('respects restart=false (no Restart=always, no RestartSec)', () => {
    const unit = buildUnit({
      description: 'd',
      nodePath: 'n',
      binPath: 'b',
      configPath: 'c',
      logDir: 'l',
      restart: false,
    })
    expect(unit).toContain('Restart=no')
    expect(unit).not.toContain('Restart=always')
    expect(unit).not.toContain('RestartSec=')
  })

  it('quotes ExecStart arguments that contain whitespace or special characters', () => {
    const unit = buildUnit({
      description: 'd',
      nodePath: '/usr/bin/node',
      binPath: '/path with spaces/cli.js',
      configPath: '/etc/conf with "quote".json',
      logDir: '/l',
    })
    expect(unit).toContain('ExecStart=/usr/bin/node "/path with spaces/cli.js" --config "/etc/conf with \\"quote\\".json"')
  })

  it('escapes backslashes and double quotes in Environment values', () => {
    const unit = buildUnit({
      description: 'd',
      nodePath: 'n',
      binPath: 'b',
      configPath: 'c',
      logDir: 'l',
      env: { TRICKY: 'a "b" \\c' },
    })
    expect(unit).toContain('Environment="TRICKY=a \\"b\\" \\\\c"')
  })

  it('throws SystemdUnitError when required fields are missing', () => {
    // @ts-expect-error - intentionally invalid for runtime check
    expect(() => buildUnit({})).toThrow(SystemdUnitError)
    // @ts-expect-error - missing logDir
    expect(() => buildUnit({ description: 'd', nodePath: 'n', binPath: 'b', configPath: 'c' })).toThrow(/logDir is required/)
  })

  it('rejects non-string env values', () => {
    expect(() => buildUnit({
      description: 'd', nodePath: 'n', binPath: 'b', configPath: 'c', logDir: 'l',
      // @ts-expect-error - intentional bad type
      env: { X: 5 },
    })).toThrow(/env\.X must be a string/)
  })

  it('rejects non-object env values', () => {
    expect(() => buildUnit({
      description: 'd', nodePath: 'n', binPath: 'b', configPath: 'c', logDir: 'l',
      // @ts-expect-error - intentional bad type
      env: 'not an object',
    })).toThrow(/env must be an object/)
  })
})

describe('installSystemdUnit', () => {
  it('writes the unit atomically and runs daemon-reload, enable, restart', async () => {
    const fake = makeFakeSystemctl()
    await installSystemdUnit({
      label: 'com.test.alpha',
      binPath: '/bin/x',
      configPath: '/etc/x.json',
      logDir,
      nodePath: '/usr/local/bin/node',
      unitDir,
      systemctl: fake,
    })

    const unitPath = path.join(unitDir, 'com.test.alpha.service')
    expect(fs.existsSync(unitPath)).toBe(true)
    const content = fs.readFileSync(unitPath, 'utf8')
    expect(content).toContain('Description=Collectivus daemon (com.test.alpha)')
    expect(content).toContain('ExecStart=/usr/local/bin/node /bin/x --config /etc/x.json')

    expect(fake.calls).toEqual([
      { op: 'daemonReload' },
      { op: 'enable', arg: 'com.test.alpha.service' },
      { op: 'restart', arg: 'com.test.alpha.service' },
    ])
  })

  it('creates unitDir and logDir if they do not exist', async () => {
    const fake = makeFakeSystemctl()
    expect(fs.existsSync(unitDir)).toBe(false)
    expect(fs.existsSync(logDir)).toBe(false)
    await installSystemdUnit({
      label: 'l', binPath: 'b', configPath: 'c', logDir, unitDir, systemctl: fake,
    })
    expect(fs.existsSync(unitDir)).toBe(true)
    expect(fs.existsSync(logDir)).toBe(true)
  })

  it('replaces an existing unit file on reinstall (idempotent)', async () => {
    fs.mkdirSync(unitDir, { recursive: true })
    const unitPath = path.join(unitDir, 'l.service')
    fs.writeFileSync(unitPath, 'old content')

    const fake = makeFakeSystemctl()
    await installSystemdUnit({
      label: 'l', binPath: 'b', configPath: 'c', logDir, unitDir, systemctl: fake,
    })

    const content = fs.readFileSync(unitPath, 'utf8')
    expect(content).toContain('[Service]')
    expect(content).not.toContain('old content')
  })

  it('does not leave a tmp file behind on success', async () => {
    const fake = makeFakeSystemctl()
    await installSystemdUnit({
      label: 'l', binPath: 'b', configPath: 'c', logDir, unitDir, systemctl: fake,
    })
    const entries = fs.readdirSync(unitDir)
    expect(entries).toEqual(['l.service'])
  })

  it('throws when daemon-reload returns non-zero', async () => {
    const fake = makeFakeSystemctl({
      daemonReload: { exitCode: 1, stdout: '', stderr: 'reload boom\n' },
    })
    await expect(installSystemdUnit({
      label: 'l', binPath: 'b', configPath: 'c', logDir, unitDir, systemctl: fake,
    })).rejects.toThrow(/failed to systemctl --user daemon-reload: reload boom/)
  })

  it('throws when enable returns non-zero', async () => {
    const fake = makeFakeSystemctl({
      enable: { exitCode: 1, stdout: '', stderr: 'enable boom\n' },
    })
    await expect(installSystemdUnit({
      label: 'l', binPath: 'b', configPath: 'c', logDir, unitDir, systemctl: fake,
    })).rejects.toThrow(/failed to enable systemd user unit l\.service: enable boom/)
  })

  it('throws when restart returns non-zero', async () => {
    const fake = makeFakeSystemctl({
      restart: { exitCode: 1, stdout: '', stderr: 'restart boom\n' },
    })
    await expect(installSystemdUnit({
      label: 'l', binPath: 'b', configPath: 'c', logDir, unitDir, systemctl: fake,
    })).rejects.toThrow(/failed to restart systemd user unit l\.service: restart boom/)
  })

  it('uses process.execPath when nodePath is not provided', async () => {
    const fake = makeFakeSystemctl()
    await installSystemdUnit({
      label: 'l', binPath: 'b', configPath: 'c', logDir, unitDir, systemctl: fake,
    })
    const content = fs.readFileSync(path.join(unitDir, 'l.service'), 'utf8')
    expect(content).toContain(`ExecStart=${process.execPath} b --config c`)
  })

  it('uses a custom description when provided', async () => {
    const fake = makeFakeSystemctl()
    await installSystemdUnit({
      label: 'l',
      binPath: 'b',
      configPath: 'c',
      logDir,
      unitDir,
      systemctl: fake,
      description: 'Custom collector for staging',
    })
    const content = fs.readFileSync(path.join(unitDir, 'l.service'), 'utf8')
    expect(content).toContain('Description=Custom collector for staging')
  })

  it('honors restart=false in the rendered unit', async () => {
    const fake = makeFakeSystemctl()
    await installSystemdUnit({
      label: 'l', binPath: 'b', configPath: 'c', logDir, unitDir, systemctl: fake, restart: false,
    })
    const content = fs.readFileSync(path.join(unitDir, 'l.service'), 'utf8')
    expect(content).toContain('Restart=no')
    expect(content).not.toContain('RestartSec=')
  })
})

describe('uninstallSystemdUnit', () => {
  it('is a no-op when the unit file does not exist', async () => {
    const fake = makeFakeSystemctl()
    await uninstallSystemdUnit({ label: 'missing', unitDir, systemctl: fake })
    expect(fake.calls).toEqual([])
  })

  it('stops, disables, removes the unit file, and reloads when present', async () => {
    fs.mkdirSync(unitDir, { recursive: true })
    const unitPath = path.join(unitDir, 'l.service')
    fs.writeFileSync(unitPath, 'x')

    const fake = makeFakeSystemctl()
    await uninstallSystemdUnit({ label: 'l', unitDir, systemctl: fake })

    expect(fake.calls).toEqual([
      { op: 'stop', arg: 'l.service' },
      { op: 'disable', arg: 'l.service' },
      { op: 'daemonReload' },
    ])
    expect(fs.existsSync(unitPath)).toBe(false)
  })

  it('still removes the unit file when stop and disable fail (already-stopped case)', async () => {
    fs.mkdirSync(unitDir, { recursive: true })
    const unitPath = path.join(unitDir, 'l.service')
    fs.writeFileSync(unitPath, 'x')

    const fake = makeFakeSystemctl({
      stop: { exitCode: 5, stdout: '', stderr: 'Unit not loaded\n' },
      disable: { exitCode: 1, stdout: '', stderr: 'No such file\n' },
    })
    await uninstallSystemdUnit({ label: 'l', unitDir, systemctl: fake })
    expect(fs.existsSync(unitPath)).toBe(false)
  })

  it('tolerates a daemon-reload failure during uninstall', async () => {
    fs.mkdirSync(unitDir, { recursive: true })
    const unitPath = path.join(unitDir, 'l.service')
    fs.writeFileSync(unitPath, 'x')

    const fake = makeFakeSystemctl({
      daemonReload: { exitCode: 1, stdout: '', stderr: 'reload boom\n' },
    })
    await expect(uninstallSystemdUnit({ label: 'l', unitDir, systemctl: fake })).resolves.toBeUndefined()
    expect(fs.existsSync(unitPath)).toBe(false)
  })
})

describe('isSystemdUnitInstalled', () => {
  it('returns true when the unit file exists', async () => {
    fs.mkdirSync(unitDir, { recursive: true })
    fs.writeFileSync(path.join(unitDir, 'present.service'), 'x')
    expect(await isSystemdUnitInstalled({ label: 'present', unitDir })).toBe(true)
  })

  it('returns false when the unit file does not exist', async () => {
    expect(await isSystemdUnitInstalled({ label: 'absent', unitDir })).toBe(false)
  })

  it('accepts labels that already include the .service suffix', async () => {
    fs.mkdirSync(unitDir, { recursive: true })
    fs.writeFileSync(path.join(unitDir, 'mounted.service'), 'x')
    expect(await isSystemdUnitInstalled({ label: 'mounted.service', unitDir })).toBe(true)
  })
})

describe('systemdUnitStatus', () => {
  it('returns { loaded: false } when systemctl exits non-zero', async () => {
    const fake = makeFakeSystemctl()
    expect(await systemdUnitStatus({ label: 'l', systemctl: fake })).toEqual({ loaded: false })
  })

  it('returns { loaded: false } when LoadState is not loaded', async () => {
    const stdout = 'LoadState=not-found\nActiveState=inactive\nMainPID=0\n'
    const fake = makeFakeSystemctl({ show: { exitCode: 0, stdout, stderr: '' } })
    expect(await systemdUnitStatus({ label: 'l', systemctl: fake })).toEqual({ loaded: false })
  })

  it('returns { loaded: true, pid } when MainPID is positive', async () => {
    const stdout = 'LoadState=loaded\nActiveState=active\nMainPID=12345\n'
    const fake = makeFakeSystemctl({ show: { exitCode: 0, stdout, stderr: '' } })
    expect(await systemdUnitStatus({ label: 'l', systemctl: fake })).toEqual({ loaded: true, pid: 12345 })
  })

  it('returns { loaded: true } without a pid when MainPID is 0', async () => {
    const stdout = 'LoadState=loaded\nActiveState=inactive\nMainPID=0\n'
    const fake = makeFakeSystemctl({ show: { exitCode: 0, stdout, stderr: '' } })
    expect(await systemdUnitStatus({ label: 'l', systemctl: fake })).toEqual({ loaded: true })
  })

  it('ignores malformed lines without an =', async () => {
    const stdout = 'LoadState=loaded\nbogus line\nMainPID=42\n'
    const fake = makeFakeSystemctl({ show: { exitCode: 0, stdout, stderr: '' } })
    expect(await systemdUnitStatus({ label: 'l', systemctl: fake })).toEqual({ loaded: true, pid: 42 })
  })
})
