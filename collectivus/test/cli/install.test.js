import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError } from '../../src/config.js'
import { parseInstallArgs, runInstall } from '../../src/cli/install.js'

/**
 * @import { InstallCall, AttachCall, InstallMocks } from '../types.js'
 */

/**
 * Minimal in-memory stream collector matching the existing CLI test helper.
 *
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

/** @type {string} */
let tmpDir
beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-install-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {{
 *   installError?: Error,
 *   attachError?: Error,
 *   attachResult?: { changed: true, prevValue?: string },
 *   loadConfigImpl?: (p: string) => any,
 * }} [opts]
 * @returns {InstallMocks}
 */
function makeMocks(opts = {}) {
  /** @type {InstallCall[]} */
  const installCalls = []
  /** @type {AttachCall[]} */
  const attachCalls = []
  return {
    installCalls,
    attachCalls,
    installLaunchAgent(o) {
      installCalls.push({ ...o })
      if (opts.installError) return Promise.reject(opts.installError)
      return Promise.resolve()
    },
    attach(o) {
      attachCalls.push({ ...o })
      if (opts.attachError) return Promise.reject(opts.attachError)
      return Promise.resolve(opts.attachResult ?? { changed: true })
    },
    loadConfig(p) {
      if (opts.loadConfigImpl) return opts.loadConfigImpl(p)
      return { version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] }, sink: { type: 'file', dir: '/tmp/x' } }
    },
  }
}

describe('parseInstallArgs', function() {
  it('returns error when no args', function() {
    const r = parseInstallArgs([])
    expect(r.error).toBeUndefined()
    expect(r.configPath).toBeUndefined()
    expect(r.yes).toBe(false)
    expect(r.no).toBe(false)
  })

  it('parses --config <path>', function() {
    expect(parseInstallArgs(['--config', '/tmp/c.json'])).toEqual({
      configPath: '/tmp/c.json', yes: false, no: false, help: false,
    })
  })

  it('parses --config=<path>', function() {
    expect(parseInstallArgs(['--config=/tmp/c.json']).configPath).toBe('/tmp/c.json')
  })

  it('parses --yes and --no', function() {
    expect(parseInstallArgs(['--config', 'c', '--yes']).yes).toBe(true)
    expect(parseInstallArgs(['--config', 'c', '--no']).no).toBe(true)
  })

  it('rejects --yes and --no together', function() {
    const r = parseInstallArgs(['--config', 'c', '--yes', '--no'])
    expect(r.error).toMatch(/mutually exclusive/)
  })

  it('rejects --config without value', function() {
    expect(parseInstallArgs(['--config']).error).toMatch(/requires a path/)
    expect(parseInstallArgs(['--config=']).error).toMatch(/requires a path/)
  })

  it('rejects unknown args', function() {
    expect(parseInstallArgs(['--mystery']).error).toMatch(/unknown argument/)
  })

  it('returns help mode for --help / -h', function() {
    expect(parseInstallArgs(['--help']).help).toBe(true)
    expect(parseInstallArgs(['-h']).help).toBe(true)
  })
})

describe('runInstall', function() {
  /**
   * @param {object} cfg
   * @returns {string}
   */
  function writeConfig(cfg) {
    const p = path.join(tmpDir, 'config.json')
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
    return p
  }

  it('prints help and exits 0 on --help', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runInstall(['--help'], {
      stdout, stderr, binPath: '/usr/local/bin/collectivus',
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on bad args', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runInstall(['--mystery'], { stdout, stderr, binPath: '/usr/local/bin/collectivus' })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown argument/)
  })

  it('exits 2 when --config is missing and no default exists', async function() {
    const stdout = memo()
    const stderr = memo()
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-install-home-'))
    try {
      const code = await runInstall([], {
        stdout, stderr, binPath: '/usr/local/bin/collectivus', homeDir: emptyHome,
      })
      expect(code).toBe(2)
      expect(stderr.value()).toMatch(/--config is required/)
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true })
    }
  })

  it('falls back to ~/.hyp/collectivus.json when --config is omitted', async function() {
    const stdout = memo()
    const stderr = memo()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-install-home-'))
    try {
      fs.mkdirSync(path.join(home, '.hyp'), { recursive: true })
      fs.writeFileSync(
        path.join(home, '.hyp', 'collectivus.json'),
        JSON.stringify({ version: 1, otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp/x' } })
      )
      const m = makeMocks({
        loadConfigImpl() {
          return { version: 1, otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp/x' } }
        },
      })
      const code = await runInstall([], {
        stdout, stderr,
        binPath: '/usr/local/bin/collectivus',
        homeDir: home,
        logDir: path.join(tmpDir, 'logs'),
        plistDir: path.join(tmpDir, 'plist'),
        settingsPath: path.join(tmpDir, 'settings.json'),
        installLaunchAgent: m.installLaunchAgent,
        attach: m.attach,
        loadConfig: m.loadConfig,
      })
      expect(code).toBe(0)
      expect(m.installCalls).toHaveLength(1)
      expect(m.installCalls[0].configPath).toBe(path.join(home, '.hyp', 'collectivus.json'))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses to install when invoked via npx', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({})
    const m = makeMocks()
    const code = await runInstall(['--config', cfgPath], {
      stdout, stderr,
      binPath: '/Users/u/.npm/_npx/abc/node_modules/collectivus/bin/cli.js',
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/requires a global install/)
    expect(m.installCalls).toHaveLength(0)
  })

  it('reports config errors with code 1', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({
      loadConfigImpl() { throw new ConfigError('config file not found: /tmp/x') },
    })
    const code = await runInstall(['--config', '/tmp/x'], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/config error.*not found/)
    expect(m.installCalls).toHaveLength(0)
  })

  it('installs and skips attach when config has no proxy listener', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp/x' } })
    const m = makeMocks({
      loadConfigImpl() {
        return { version: 1, otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp/x' } }
      },
    })
    const code = await runInstall(['--config', cfgPath], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
    })
    expect(code).toBe(0)
    expect(m.installCalls).toHaveLength(1)
    expect(m.attachCalls).toHaveLength(0)
    expect(stderr.value()).not.toMatch(/not a TTY/)
    expect(stdout.value()).toMatch(/no proxy configured/)
  })

  it('--yes installs and attaches without prompting', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] } })
    const m = makeMocks()
    /** @type {string[]} */
    const promptCalls = []
    const code = await runInstall(['--config', cfgPath, '--yes'], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '9.9.9',
      logDir: path.join(tmpDir, 'logs'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
      prompt(q) { promptCalls.push(q); return Promise.resolve('') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(promptCalls).toHaveLength(0)
    expect(m.installCalls).toHaveLength(1)
    expect(m.installCalls[0]).toMatchObject({
      binPath: '/usr/local/bin/collectivus',
      configPath: cfgPath,
      label: 'com.hyparam.collectivus',
      logDir: path.join(tmpDir, 'logs'),
    })
    expect(m.attachCalls).toEqual([{
      port: 8787,
      version: '9.9.9',
      settingsPath: path.join(tmpDir, 'settings.json'),
      binPath: '/usr/local/bin/collectivus',
    }])
    expect(stdout.value()).toMatch(/Daemon installed/)
    expect(stdout.value()).toMatch(/Claude Code attached/)
  })

  it('--no installs without attach and without prompting', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] } })
    const m = makeMocks()
    /** @type {string[]} */
    const promptCalls = []
    const code = await runInstall(['--config', cfgPath, '--no'], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
      prompt(q) { promptCalls.push(q); return Promise.resolve('y') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(promptCalls).toHaveLength(0)
    expect(m.installCalls).toHaveLength(1)
    expect(m.attachCalls).toHaveLength(0)
    expect(stdout.value()).toMatch(/Claude Code attach: skipped/)
  })

  it('TTY without flags: empty answer attaches (Y default)', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] } })
    const m = makeMocks()
    const code = await runInstall(['--config', cfgPath], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
      prompt() { return Promise.resolve('') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(m.attachCalls).toHaveLength(1)
  })

  it('TTY without flags: explicit yes attaches', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] } })
    const m = makeMocks()
    const code = await runInstall(['--config', cfgPath], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
      prompt() { return Promise.resolve('Yes') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(m.attachCalls).toHaveLength(1)
  })

  it('TTY without flags: explicit no skips attach', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] } })
    const m = makeMocks()
    const code = await runInstall(['--config', cfgPath], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
      prompt() { return Promise.resolve('n') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(m.installCalls).toHaveLength(1)
    expect(m.attachCalls).toHaveLength(0)
    expect(stdout.value()).toMatch(/Claude Code attach: skipped/)
  })

  it('non-TTY without flags: warns and skips attach', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] } })
    const m = makeMocks()
    /** @type {string[]} */
    const promptCalls = []
    const code = await runInstall(['--config', cfgPath], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
      prompt(q) { promptCalls.push(q); return Promise.resolve('') },
      isTTY: false,
    })
    expect(code).toBe(0)
    expect(promptCalls).toHaveLength(0)
    expect(m.installCalls).toHaveLength(1)
    expect(m.attachCalls).toHaveLength(0)
    expect(stderr.value()).toMatch(/not a TTY/)
  })

  it('exits 1 when LaunchAgent install fails', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] } })
    const m = makeMocks({ installError: new Error('launchctl exploded') })
    const code = await runInstall(['--config', cfgPath, '--yes'], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to install daemon.*launchctl exploded/)
    expect(m.attachCalls).toHaveLength(0)
  })

  it('exits 1 when attach fails after install', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] } })
    const m = makeMocks({ attachError: new Error('settings.json missing') })
    const code = await runInstall(['--config', cfgPath, '--yes'], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
    })
    expect(code).toBe(1)
    expect(m.installCalls).toHaveLength(1)
    expect(m.attachCalls).toHaveLength(1)
    expect(stderr.value()).toMatch(/failed to attach Claude Code/)
  })

  it('reports prevValue when attach overwrote ANTHROPIC_BASE_URL', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:8787', upstreams: [] } })
    const m = makeMocks({ attachResult: { changed: true, prevValue: 'https://elsewhere.test' } })
    const code = await runInstall(['--config', cfgPath, '--yes'], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/previous ANTHROPIC_BASE_URL was https:\/\/elsewhere\.test/)
  })

  it('errors clearly when proxy.listen is not parseable', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: 'garbage', upstreams: [] } })
    const m = makeMocks({
      loadConfigImpl() { return { version: 1, proxy: { listen: 'garbage', upstreams: [] } } },
    })
    const code = await runInstall(['--config', cfgPath, '--yes'], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/invalid listen value/)
  })

  it('forwards plistDir to installDaemon when supplied (test injection)', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = writeConfig({ version: 1, proxy: { listen: '127.0.0.1:9090', upstreams: [] } })
    const m = makeMocks()
    const code = await runInstall(['--config', cfgPath, '--no'], {
      stdout, stderr,
      binPath: '/usr/local/bin/collectivus',
      version: '1.0.0',
      logDir: path.join(tmpDir, 'logs'),
      plistDir: path.join(tmpDir, 'LaunchAgents'),
      installLaunchAgent: m.installLaunchAgent,
      attach: m.attach,
      loadConfig: m.loadConfig,
    })
    expect(code).toBe(0)
    expect(m.installCalls[0].plistDir).toBe(path.join(tmpDir, 'LaunchAgents'))
  })
})
