import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError } from '../../src/config.js'
import { SettingsError } from '../../src/claude-code/settings.js'
import { parseStatusArgs, runStatus } from '../../src/cli/status.js'

/**
 * @import { CollectivusConfig } from '../../src/types.js'
 * @import { StatusHooks } from '../../src/cli/types.d.ts'
 */

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

/**
 * Default loadConfig stub that surfaces ENOENT-style errors as ConfigError so
 * status reports "missing" rather than "invalid". Tests that need a real
 * config or a different error pass their own loadConfig hook.
 *
 * @returns {never}
 */
function noConfig() {
  throw new ConfigError('config file not found: <test>')
}

/** @type {string} */
let tmpDir
beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-status-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Hooks shared by the simple cases: tmpDir-scoped paths plus the no-op
 * config/log/sink stubs so we don't read user state from disk.
 *
 * @returns {StatusHooks}
 */
function baseHooks() {
  return {
    plistPath: path.join(tmpDir, 'plist'),
    settingsPath: path.join(tmpDir, 'settings.json'),
    logDir: path.join(tmpDir, 'logs'),
    configPath: path.join(tmpDir, 'collectivus.json'),
    loadConfig: noConfig,
    statFile() { return Promise.resolve(undefined) },
    countSinkFiles() { return Promise.resolve(undefined) },
  }
}

describe('parseStatusArgs', function() {
  it('treats no args as default', function() {
    expect(parseStatusArgs([])).toEqual({ help: false })
  })

  it('returns help mode for --help', function() {
    expect(parseStatusArgs(['--help']).help).toBe(true)
    expect(parseStatusArgs(['-h']).help).toBe(true)
  })

  it('rejects unknown args', function() {
    expect(parseStatusArgs(['--mystery']).error).toMatch(/unknown argument/)
  })
})

describe('runStatus', function() {
  it('prints help on --help', async function() {
    const stdout = memo()
    const code = await runStatus(['--help'], { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on bad args', async function() {
    const stderr = memo()
    const code = await runStatus(['--mystery'], { stdout: memo(), stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown argument/)
  })

  it('reports daemon not installed and Claude Code not attached', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr,
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return undefined },
      readSettingsRaw() { return Promise.resolve(undefined) },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(/Daemon\n {2}Status: not installed/)
    expect(out).toMatch(/Config\n {2}Path: .*collectivus\.json\n {2}Status: missing/)
    expect(out).toMatch(/Claude Code\n {2}Status: not attached/)
  })

  it('reports daemon loaded with PID and config from plist', async function() {
    const stdout = memo()
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr: memo(),
      isLaunchAgentInstalled() { return Promise.resolve(true) },
      launchAgentStatus() { return Promise.resolve({ loaded: true, pid: 4242 }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() {
        return {
          configPath: '/etc/collectivus.json',
          stdoutPath: '/var/log/collectivus.log',
          stderrPath: '/var/log/collectivus.err.log',
        }
      },
      readSettingsRaw() { return Promise.resolve(undefined) },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(/Status: loaded \(PID 4242\)/)
    expect(out).toMatch(/Daemon[\s\S]*Config: \/etc\/collectivus\.json/)
    expect(out).toMatch(/stdout: \/var\/log\/collectivus\.log/)
    expect(out).toMatch(/stderr: \/var\/log\/collectivus\.err\.log/)
    // Config section path is taken from the plist when installed.
    expect(out).toMatch(/Config\n {2}Path: \/etc\/collectivus\.json/)
  })

  it('reports loaded without PID gracefully', async function() {
    const stdout = memo()
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr: memo(),
      isLaunchAgentInstalled() { return Promise.resolve(true) },
      launchAgentStatus() { return Promise.resolve({ loaded: true }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return {} },
      readSettingsRaw() { return Promise.resolve(undefined) },
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/loaded \(no PID/)
  })

  it('falls back to default log paths when plist fields are absent', async function() {
    const stdout = memo()
    const logDir = path.join(tmpDir, 'logs')
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr: memo(),
      logDir,
      isLaunchAgentInstalled() { return Promise.resolve(true) },
      launchAgentStatus() { return Promise.resolve({ loaded: true, pid: 1 }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return {} },
      readSettingsRaw() { return Promise.resolve(undefined) },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(new RegExp(`stdout: ${logDir.replace(/\//g, '\\/')}\\/collectivus\\.log`))
    expect(out).toMatch(new RegExp(`stderr: ${logDir.replace(/\//g, '\\/')}\\/collectivus\\.err\\.log`))
  })

  it('reports Claude Code attached and parses marker', async function() {
    const stdout = memo()
    const settingsPath = path.join(tmpDir, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
      _collectivus: { attached_at: '2026-01-02T03:04:05.000Z', version: '1.2.3', port: 8787 },
    }))
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr: memo(),
      settingsPath,
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(true) },
      readInstalledPlist() { return undefined },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(/Status: attached/)
    expect(out).toMatch(/Attached at: 2026-01-02T03:04:05\.000Z/)
    expect(out).toMatch(/Port: 8787/)
    expect(out).toMatch(/Marker version: 1\.2\.3/)
  })

  it('exits 1 when settings.json is malformed (isAttached throws)', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr,
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.reject(new SettingsError('malformed JSON')) },
      readInstalledPlist() { return undefined },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to read.*malformed JSON/)
    expect(stdout.value()).toMatch(/Status: unknown/)
  })

  it('exits 1 when isLaunchAgentInstalled fails', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr,
      isLaunchAgentInstalled() { return Promise.reject(new Error('disk explode')) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return undefined },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to check daemon installation.*disk explode/)
  })

  it('reports valid config and lists configured listeners', async function() {
    const stdout = memo()
    const sinkDir = path.join(tmpDir, 'sink')
    /** @type {CollectivusConfig} */
    const cfg = {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      proxy: {
        listen: '127.0.0.1:8787',
        upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
      },
      sink: { type: 'file', dir: sinkDir },
    }
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr: memo(),
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return undefined },
      loadConfig() { return cfg },
      statFile() { return Promise.resolve(undefined) },
      findLatestProxyFile() {
        return Promise.resolve({
          size: 4096,
          mtimeMs: Date.now() - 60_000,
          name: 'tester/proxy/2026-05-11.jsonl',
        })
      },
      countSinkFiles() { return Promise.resolve(3) },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(/Config\n {2}Path: .*collectivus\.json\n {2}Status: valid/)
    expect(out).toMatch(/proxy: {2}127\.0\.0\.1:8787 {2}\(anthropic → https:\/\/api\.anthropic\.com\/v1\/messages\)/)
    expect(out).toMatch(/otel: {3}0\.0\.0\.0:4318/)
    expect(out).toMatch(new RegExp(`sink: {3}${sinkDir.replace(/\//g, '\\/')}`))
    expect(out).toMatch(/Recordings\n {2}Sink: /)
    expect(out).toMatch(/Proxy: {2}tester\/proxy\/2026-05-11\.jsonl 4\.0 KB, last write \d{4}-\d{2}-\d{2}T.* \(\d+m ago\)/)
    expect(out).toMatch(/OTLP: {3}3 files under <id>\/\{logs,traces,metrics\}\//)
  })

  it('reports invalid config and exits 1', async function() {
    const stdout = memo()
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr: memo(),
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return undefined },
      loadConfig() { throw new ConfigError('unknown key "foo"', { pointer: '/foo' }) },
    })
    expect(code).toBe(1)
    expect(stdout.value()).toMatch(/Config\n {2}Path: .*\n {2}Status: invalid \(\/foo: unknown key "foo"\)/)
  })

  it('reports proxy.jsonl missing and no OTLP recordings when sink is fresh', async function() {
    const stdout = memo()
    /** @type {CollectivusConfig} */
    const cfg = {
      version: 1,
      proxy: {
        listen: '127.0.0.1:8787',
        upstreams: [{ name: 'a', base_url: 'https://x', match: { path_prefix: '/v1' } }],
      },
      sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
    }
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr: memo(),
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return undefined },
      loadConfig() { return cfg },
      statFile() { return Promise.resolve(undefined) },
      countSinkFiles() { return Promise.resolve(undefined) },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(/Proxy: {2}no exchanges recorded yet/)
    expect(out).toMatch(/OTLP: {3}no recordings/)
  })

  it('reports the proxy file as empty when it exists but is zero bytes', async function() {
    const stdout = memo()
    /** @type {CollectivusConfig} */
    const cfg = {
      version: 1,
      proxy: {
        listen: '127.0.0.1:8787',
        upstreams: [{ name: 'a', base_url: 'https://x', match: { path_prefix: '/v1' } }],
      },
      sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
    }
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr: memo(),
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return undefined },
      loadConfig() { return cfg },
      statFile() { return Promise.resolve(undefined) },
      findLatestProxyFile() {
        return Promise.resolve({
          size: 0,
          mtimeMs: Date.now(),
          name: 'tester/proxy/2026-05-11.jsonl',
        })
      },
      countSinkFiles() { return Promise.resolve(0) },
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Proxy: {2}tester\/proxy\/2026-05-11\.jsonl is empty/)
  })

  it('reports log file existence with size when daemon is installed', async function() {
    const stdout = memo()
    const logDir = path.join(tmpDir, 'logs')
    const code = await runStatus([], {
      ...baseHooks(),
      stdout, stderr: memo(),
      logDir,
      isLaunchAgentInstalled() { return Promise.resolve(true) },
      launchAgentStatus() { return Promise.resolve({ loaded: true, pid: 99 }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return {} },
      statFile(p) {
        if (p.endsWith('.err.log')) return Promise.resolve(undefined)
        return Promise.resolve({ size: 2048, mtimeMs: Date.now() })
      },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(/stdout: .*collectivus\.log \(2\.0 KB\)/)
    expect(out).toMatch(/stderr: .*collectivus\.err\.log \(missing\)/)
  })
})
