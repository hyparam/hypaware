import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError } from '../../src/config.js'
import { parseAttachArgs, runAttach } from '../../src/cli/attach.js'

/**
 * @import { AttachOptions, CollectivusConfig } from '../../src/types.js'
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

/** @type {string} */
let tmpDir
beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-attach-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseAttachArgs', function() {
  it('accepts no args (runAttach resolves the default config)', function() {
    const r = parseAttachArgs([])
    expect(r.error).toBeUndefined()
    expect(r.configPath).toBeUndefined()
    expect(r.port).toBeUndefined()
  })

  it('rejects both --config and --port', function() {
    expect(parseAttachArgs(['--config', 'c', '--port', '8787']).error).toMatch(/mutually exclusive/)
  })

  it('parses --config <path>', function() {
    expect(parseAttachArgs(['--config', '/tmp/c.json'])).toMatchObject({
      configPath: '/tmp/c.json', help: false,
    })
  })

  it('parses --port <n>', function() {
    expect(parseAttachArgs(['--port', '8787'])).toMatchObject({
      port: 8787, client: 'claude',
    })
  })

  it('parses --client <name>', function() {
    expect(parseAttachArgs(['--port', '8787', '--client', 'codex'])).toMatchObject({
      port: 8787, client: 'codex',
    })
    expect(parseAttachArgs(['--port=8787', '--client=all'])).toMatchObject({
      port: 8787, client: 'all',
    })
  })

  it('rejects unknown --client values', function() {
    expect(parseAttachArgs(['--port', '8787', '--client', 'zed']).error).toMatch(/expected claude, codex, or all/)
  })

  it('rejects out-of-range --port', function() {
    expect(parseAttachArgs(['--port=70000']).error).toMatch(/not a valid port/)
    expect(parseAttachArgs(['--port=0']).error).toMatch(/not a valid port/)
  })

  it('rejects non-numeric --port', function() {
    expect(parseAttachArgs(['--port=abc']).error).toMatch(/not a valid port/)
  })

  it('returns help mode for --help', function() {
    expect(parseAttachArgs(['--help']).help).toBe(true)
    expect(parseAttachArgs(['-h']).help).toBe(true)
  })

  it('rejects unknown args', function() {
    expect(parseAttachArgs(['--mystery']).error).toMatch(/unknown argument/)
  })
})

describe('runAttach', function() {
  it('prints help on --help', async function() {
    const stdout = memo()
    const code = await runAttach(['--help'], { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on missing args when no default config exists', async function() {
    const stderr = memo()
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-attach-home-'))
    try {
      const code = await runAttach([], { stdout: memo(), stderr, homeDir: emptyHome })
      expect(code).toBe(2)
      expect(stderr.value()).toMatch(/one of --config or --port/)
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true })
    }
  })

  it('falls back to ~/.hyp/collectivus.json when no args supplied', async function() {
    const stdout = memo()
    const stderr = memo()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-attach-home-'))
    try {
      fs.mkdirSync(path.join(home, '.hyp'), { recursive: true })
      fs.writeFileSync(path.join(home, '.hyp', 'collectivus.json'), '{}')
      /** @type {Array<AttachOptions>} */
      const calls = []
      /** @type {string[]} */
      const loadCalls = []
      const code = await runAttach([], {
        stdout, stderr,
        homeDir: home,
        version: '2.0.0',
        settingsPath: path.join(tmpDir, 'settings.json'),
        loadConfig(p) {
          loadCalls.push(p)
          return { version: 1, proxy: { listen: '127.0.0.1:7777', upstreams: [] } }
        },
        attach(o) { calls.push(o); return Promise.resolve({ changed: true }) },
      })
      expect(code).toBe(0)
      expect(loadCalls).toEqual([path.join(home, '.hyp', 'collectivus.json')])
      expect(calls).toHaveLength(1)
      expect(calls[0].port).toBe(7777)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('--port: attaches with given port', async function() {
    const stdout = memo()
    const stderr = memo()
    /** @type {object[]} */
    const calls = []
    const code = await runAttach(['--port', '9090'], {
      stdout, stderr,
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      attach(o) { calls.push(o); return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(0)
    expect(calls).toEqual([{
      port: 9090,
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      binPath: process.argv[1],
    }])
    expect(stdout.value()).toMatch(/Claude Code attached/)
    expect(stdout.value()).toMatch(/ANTHROPIC_BASE_URL = http:\/\/127\.0\.0\.1:9090/)
  })

  it('--client codex: attaches Codex with given port', async function() {
    const stdout = memo()
    const stderr = memo()
    /** @type {object[]} */
    const claudeCalls = []
    /** @type {object[]} */
    const codexCalls = []
    const code = await runAttach(['--port', '9090', '--client', 'codex'], {
      stdout, stderr,
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'codex.toml'),
      attachClaude(o) { claudeCalls.push(o); return Promise.resolve({ changed: true }) },
      attachCodex(o) { codexCalls.push(o); return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(0)
    expect(claudeCalls).toEqual([])
    expect(codexCalls).toEqual([{
      port: 9090, version: '2.0.0', configPath: path.join(tmpDir, 'codex.toml'),
    }])
    expect(stdout.value()).toMatch(/Codex attached/)
    expect(stdout.value()).toMatch(/base_url = http:\/\/127\.0\.0\.1:9090\/v1/)
  })

  it('--client codex: uses CODEX_HOME for the default Codex config path', async function() {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = path.join(tmpDir, 'codex-home')
    /** @type {object[]} */
    const codexCalls = []
    process.env.CODEX_HOME = codexHome
    try {
      const code = await runAttach(['--port', '9090', '--client', 'codex'], {
        stdout: memo(), stderr: memo(),
        version: '2.0.0',
        attachCodex(o) { codexCalls.push(o); return Promise.resolve({ changed: true }) },
      })
      expect(code).toBe(0)
      expect(codexCalls).toEqual([{
        port: 9090, version: '2.0.0', configPath: path.join(codexHome, 'config.toml'),
      }])
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = originalCodexHome
      }
    }
  })

  it('--client all: attaches Claude Code and Codex', async function() {
    const stdout = memo()
    /** @type {object[]} */
    const claudeCalls = []
    /** @type {object[]} */
    const codexCalls = []
    const code = await runAttach(['--port', '8787', '--client', 'all'], {
      stdout, stderr: memo(),
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'codex.toml'),
      attachClaude(o) { claudeCalls.push(o); return Promise.resolve({ changed: true }) },
      attachCodex(o) { codexCalls.push(o); return Promise.resolve({ changed: true, prevValue: 'openai' }) },
    })
    expect(code).toBe(0)
    expect(claudeCalls).toHaveLength(1)
    expect(codexCalls).toHaveLength(1)
    expect(stdout.value()).toMatch(/Claude Code attached/)
    expect(stdout.value()).toMatch(/Codex attached/)
    expect(stdout.value()).toMatch(/previous model_provider was openai/)
  })

  it('--config: derives port from proxy.listen', async function() {
    const stdout = memo()
    const stderr = memo()
    /** @type {CollectivusConfig} */
    const cfg = { version: 1, proxy: { listen: '0.0.0.0:8765', upstreams: [] } }
    /** @type {Array<AttachOptions>} */
    const calls = []
    const code = await runAttach(['--config', '/tmp/x'], {
      stdout, stderr,
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      loadConfig() { return cfg },
      attach(o) { calls.push(o); return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(0)
    expect(calls[0].port).toBe(8765)
  })

  it('--client codex with --config: requires a /v1/responses route', async function() {
    const stderr = memo()
    /** @type {CollectivusConfig} */
    const cfg = {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8765',
        upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
      },
    }
    const code = await runAttach(['--config', '/tmp/x', '--client', 'codex'], {
      stdout: memo(), stderr,
      loadConfig() { return cfg },
      attachCodex() { return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/routes \/v1\/responses/)
  })

  it('--client codex with --config: accepts a matching /v1 route', async function() {
    /** @type {CollectivusConfig} */
    const cfg = {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8765',
        upstreams: [{ name: 'openai', base_url: 'https://api.openai.com', match: { path_prefix: '/v1' } }],
      },
    }
    /** @type {object[]} */
    const calls = []
    const code = await runAttach(['--config', '/tmp/x', '--client', 'codex'], {
      stdout: memo(), stderr: memo(),
      version: '2.0.0',
      codexConfigPath: path.join(tmpDir, 'codex.toml'),
      loadConfig() { return cfg },
      attachCodex(o) { calls.push(o); return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(0)
    expect(calls).toEqual([{
      port: 8765, version: '2.0.0', configPath: path.join(tmpDir, 'codex.toml'),
    }])
  })

  it('--client codex with --config: rejects prefixes the proxy would not match', async function() {
    for (const prefix of ['/v1/', '/v1/res']) {
      const stderr = memo()
      /** @type {CollectivusConfig} */
      const cfg = {
        version: 1,
        proxy: {
          listen: '0.0.0.0:8765',
          upstreams: [{ name: 'openai', base_url: 'https://api.openai.com', match: { path_prefix: prefix } }],
        },
      }
      /** @type {object[]} */
      const codexCalls = []
      const code = await runAttach(['--config', '/tmp/x', '--client', 'codex'], {
        stdout: memo(), stderr,
        loadConfig() { return cfg },
        attachCodex(o) { codexCalls.push(o); return Promise.resolve({ changed: true }) },
      })
      expect(code).toBe(1)
      expect(stderr.value()).toMatch(/routes \/v1\/responses/)
      expect(codexCalls).toEqual([])
    }
  })

  it('--config: surfaces ConfigError as code 1', async function() {
    const stderr = memo()
    const code = await runAttach(['--config', '/tmp/x'], {
      stdout: memo(), stderr,
      loadConfig() { throw new ConfigError('config file not found: /tmp/x') },
      attach() { return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/config error.*not found/)
  })

  it('--config: errors when proxy is missing', async function() {
    const stderr = memo()
    const code = await runAttach(['--config', '/tmp/x'], {
      stdout: memo(), stderr,
      loadConfig() {
        /** @type {CollectivusConfig} */
        const cfg = { version: 1, otel: { listen: '0.0.0.0:4318' } }
        return cfg
      },
      attach() { return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/proxy.listen/)
  })

  it('auto-installs the Claude skill bundle after a successful Claude attach', async function() {
    /** @type {object[]} */
    const skillCalls = []
    const stdout = memo()
    const code = await runAttach(['--port', '8787'], {
      stdout, stderr: memo(),
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      attach() { return Promise.resolve({ changed: true }) },
      installSkillBundle(opts) {
        skillCalls.push(opts)
        return Promise.resolve({
          destinations: [
            { client: 'claude', path: path.join(tmpDir, 'skills', 'collectivus-query'), action: 'installed' },
            { client: 'claude', path: path.join(tmpDir, 'skills', 'ctvs-ignore'), action: 'installed' },
            { client: 'claude', path: path.join(tmpDir, 'skills', 'ctvs-unignore'), action: 'installed' },
          ],
        })
      },
    })
    expect(code).toBe(0)
    expect(skillCalls).toEqual([{ client: 'claude' }])
    const out = stdout.value()
    expect(out).toMatch(/Installed Claude skill collectivus-query/)
    expect(out).toMatch(/Installed Claude skill ctvs-ignore/)
    expect(out).toMatch(/Installed Claude skill ctvs-unignore/)
  })

  it('still succeeds when the skill bundle install fails (prints a warning)', async function() {
    const stderr = memo()
    const code = await runAttach(['--port', '8787'], {
      stdout: memo(), stderr,
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      attach() { return Promise.resolve({ changed: true }) },
      installSkillBundle() { return Promise.reject(new Error('skill dir collision')) },
    })
    expect(code).toBe(0)
    expect(stderr.value()).toMatch(/failed to install Claude helper skills.*skill dir collision/)
    expect(stderr.value()).toMatch(/ctvs skills install --client claude/)
  })

  it('does not auto-install when --client codex is used alone', async function() {
    /** @type {object[]} */
    const skillCalls = []
    const code = await runAttach(['--port', '8787', '--client', 'codex'], {
      stdout: memo(), stderr: memo(),
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'codex.toml'),
      attachCodex() { return Promise.resolve({ changed: true }) },
      installSkillBundle(opts) { skillCalls.push(opts); return Promise.resolve({ destinations: [] }) },
    })
    expect(code).toBe(0)
    expect(skillCalls).toEqual([])
  })

  it('reports prevValue when attach overwrote ANTHROPIC_BASE_URL', async function() {
    const stdout = memo()
    const code = await runAttach(['--port', '8787'], {
      stdout, stderr: memo(),
      version: '1.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      attach() { return Promise.resolve({ changed: true, prevValue: 'https://old.test' }) },
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/previous ANTHROPIC_BASE_URL was https:\/\/old\.test/)
  })

  it('exits 1 when attach throws', async function() {
    const stderr = memo()
    const code = await runAttach(['--port', '8787'], {
      stdout: memo(), stderr,
      attach() { return Promise.reject(new Error('settings malformed')) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to attach Claude Code.*settings malformed/)
  })

  it('exits 1 when Codex attach throws', async function() {
    const stderr = memo()
    const code = await runAttach(['--port', '8787', '--client', 'codex'], {
      stdout: memo(), stderr,
      attachCodex() { return Promise.reject(new Error('config.toml malformed')) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to attach Codex.*config\.toml malformed/)
  })
})
