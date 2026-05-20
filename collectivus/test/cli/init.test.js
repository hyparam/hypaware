import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit, runInitSubcommand } from '../../src/cli/init.js'
import { loadConfig } from '../../src/config.js'

/**
 * @import { CollectivusConfig } from '../../src/types.js'
 */

/**
 * Minimal in-memory stream collector.
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

/**
 * Build a prompt mock that returns successive answers from `answers` and
 * records every question it was asked.
 *
 * @param {string[]} answers
 * @returns {{ prompt: (q: string) => Promise<string>, asked: string[] }}
 */
function scriptedPrompt(answers) {
  /** @type {string[]} */
  const asked = []
  const queue = answers.slice()
  return {
    asked,
    prompt(q) {
      asked.push(q)
      if (queue.length === 0) {
        return Promise.reject(new Error(`prompt exhausted at: ${q}`))
      }
      return Promise.resolve(queue.shift() ?? '')
    },
  }
}

/** @type {string} */
let tmpDir
/**
 * Path inside `tmpDir` that no test creates. Tests pass this as
 * `defaultConfigPath` so the "found existing config" branch sees nothing
 * and falls through to the question flow.
 *
 * @type {string}
 */
let absentDefaultCfg
beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-init-'))
  absentDefaultCfg = path.join(tmpDir, 'absent-default.json')
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('runInit', function() {
  describe('standalone mode', function() {
    it('writes a v1 config with localhost proxy + Anthropic upstream array', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'collectivus.json')
      const sinkDir = path.join(tmpDir, 'sink')
      const { prompt, asked } = scriptedPrompt([
        '2', // Claude Code
        '', // accept default sink
        cfgPath, // save path
      ])
      /** @type {string[]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'win32',
        cwd: tmpDir,
        defaultSinkDir: sinkDir,
        defaultConfigPath: absentDefaultCfg,
        hasGcBinary() { return false },
        runInstall(args) { installCalls.push(args.join(' ')); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toHaveLength(0)
      expect(fs.existsSync(cfgPath)).toBe(true)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.version).toBe(1)
      expect(written.proxy).toMatchObject({
        listen: '127.0.0.1:8787',
        upstreams: [
          {
            name: 'anthropic',
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          },
        ],
      })
      expect(written.proxy.redact_headers).toContain('x-api-key')
      expect(written.sink).toEqual({ type: 'file', dir: sinkDir })
      expect(written.query).toEqual({ cache: { enabled: true } })
      expect(written.otel).toBeUndefined()
      expect(written.upload).toBeUndefined()
      expect(stdout.value()).toMatch(/Wrote/)
      // Standalone does not ask about mode, provider, OTLP, upload, or proxy listen.
      expect(asked.some(function(q) { return /How will you use collectivus/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Provider \[1\]/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /OTLP/i.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Upload daily/i.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Proxy listen/i.test(q) })).toBe(false)
      expect(asked).toContain('Collect [all]: ')
      expect(function() { loadConfig(cfgPath) }).not.toThrow()
    })

    it('defaults to all available sources when gc is detected', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'collectivus.json')
      const sinkDir = path.join(tmpDir, 'sink')
      const citiesRoot = path.join(tmpDir, 'cities')
      const cityDir = path.join(citiesRoot, 'mycity')
      fs.mkdirSync(cityDir, { recursive: true })
      fs.writeFileSync(
        path.join(cityDir, 'city.toml'),
        'name = "mycity"\napi = "http://127.0.0.1:8372"\n',
        'utf8'
      )
      const { prompt, asked } = scriptedPrompt([
        '', // all available: OTEL + Claude Code + Gascity
        '', // default sink
        citiesRoot, // scan for gas cities
        '', // add discovered city
        '', // add no more cities
        '', // default OTLP listen
        cfgPath,
        'n', // skip historical gascity backfill
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultSinkDir: sinkDir,
        defaultConfigPath: absentDefaultCfg,
        hasGcBinary() { return true },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.proxy.listen).toBe('127.0.0.1:8787')
      expect(written.gascity).toEqual([{ name: 'mycity', api_url: 'http://127.0.0.1:8372' }])
      expect(written.otel).toEqual({ listen: '127.0.0.1:4318' })
      expect(written.sink).toEqual({ type: 'file', dir: sinkDir })
      expect(installCalls).toEqual([['--config', cfgPath, '--yes']])
      expect(asked).toContain('Collect [all]: ')
      expect(asked.some(function(q) { return /Install as background daemon/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Configure Claude Code/.test(q) })).toBe(false)
      expect(stdout.value()).toMatch(/3\) Gascity/)
    })

    it('defaults to OTEL and Claude Code when gc is not detected', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'collectivus.json')
      const sinkDir = path.join(tmpDir, 'sink')
      const { prompt, asked } = scriptedPrompt([
        '', // all available: OTEL + Claude Code
        '', // default sink
        '', // default OTLP listen
        cfgPath,
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultSinkDir: sinkDir,
        defaultConfigPath: absentDefaultCfg,
        hasGcBinary() { return false },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.proxy.listen).toBe('127.0.0.1:8787')
      expect(written.otel).toEqual({ listen: '127.0.0.1:4318' })
      expect(written.gascity).toBeUndefined()
      expect(installCalls).toEqual([['--config', cfgPath, '--yes']])
      expect(stdout.value()).not.toMatch(/Gascity/)
      expect(asked.some(function(q) { return /Gas city search path/.test(q) })).toBe(false)
    })

    it('rejects gascity selection when gc is not detected', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'collectivus.json')
      const sinkDir = path.join(tmpDir, 'sink')
      const { prompt, asked } = scriptedPrompt([
        '3', // unavailable without gc
        '2', // Claude Code
        '', // sink
        cfgPath,
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'win32',
        cwd: tmpDir,
        defaultSinkDir: sinkDir,
        defaultConfigPath: absentDefaultCfg,
        hasGcBinary() { return false },
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.proxy.listen).toBe('127.0.0.1:8787')
      expect(written.gascity).toBeUndefined()
      expect(stderr.value()).toMatch(/subset of: 1, 2/)
      expect(asked.filter(function(q) { return q === 'Collect [all]: ' })).toHaveLength(2)
    })

    it('supports a gascity-only source without asking to attach Claude Code', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gascity.json')
      const cityDir = path.join(tmpDir, 'mycity')
      fs.mkdirSync(cityDir, { recursive: true })
      fs.writeFileSync(
        path.join(cityDir, 'city.toml'),
        'name = "mycity"\napi = "http://127.0.0.1:8372"\n',
        'utf8'
      )
      const { prompt, asked } = scriptedPrompt([
        '3', // gascity only
        '', // default sink
        cityDir,
        '', // add discovered city
        '', // add no more cities
        cfgPath,
        'n', // skip historical gascity backfill
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: absentDefaultCfg,
        hasGcBinary() { return true },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.proxy).toBeUndefined()
      expect(written.otel).toBeUndefined()
      expect(written.gascity).toEqual([{ name: 'mycity', api_url: 'http://127.0.0.1:8372' }])
      expect(installCalls).toEqual([['--config', cfgPath, '--no']])
      expect(asked.some(function(q) { return /Configure Claude Code/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Install as background daemon/.test(q) })).toBe(false)
    })

    it('offers to backfill gascity history after writing the config', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gascity.json')
      const cityDir = path.join(tmpDir, 'mycity')
      fs.mkdirSync(cityDir, { recursive: true })
      fs.writeFileSync(
        path.join(cityDir, 'city.toml'),
        'name = "mycity"\napi = "http://127.0.0.1:8372"\n',
        'utf8'
      )
      const { prompt, asked } = scriptedPrompt([
        '3', // gascity only
        '', // default sink
        cityDir,
        '', // add discovered city
        '', // add no more cities
        cfgPath,
        'y', // run historical backfill
      ])
      /** @type {string[][]} */
      const backfillCalls = []
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: absentDefaultCfg,
        hasGcBinary() { return true },
        runGascityBackfill(args) { backfillCalls.push(args); return Promise.resolve(0) },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(backfillCalls).toEqual([['mycity', '--all', '--config', cfgPath]])
      expect(installCalls).toEqual([['--config', cfgPath, '--no']])
      expect(asked).toContain('Backfill all recoverable gascity sessions? [y/N]: ')
      expect(stdout.value()).toMatch(/This can take a while/)
    })

    it('defaults the save path to ~/.hyp/collectivus.json and creates the parent dir', async function() {
      const stdout = memo()
      const stderr = memo()
      const fakeHome = path.join(tmpDir, 'home')
      const expectedCfg = path.join(fakeHome, '.hyp', 'collectivus.json')
      const { prompt, asked } = scriptedPrompt([
        '2', // Claude Code
        '', // default sink
        '', // accept default save path
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'win32',
        cwd: tmpDir,
        defaultConfigPath: expectedCfg,
        hasGcBinary() { return false },
      })
      expect(code).toBe(0)
      expect(asked.some(function(q) { return q.includes(expectedCfg) })).toBe(true)
      expect(fs.existsSync(expectedCfg)).toBe(true)
      expect(fs.existsSync(path.dirname(expectedCfg))).toBe(true)
    })

    it('chains into runInstall with --yes when Claude Code is selected', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'collectivus.json')
      const { prompt, asked } = scriptedPrompt([
        '2', '', cfgPath,
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: absentDefaultCfg,
        hasGcBinary() { return false },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toEqual([['--config', cfgPath, '--yes']])
      expect(asked.some(function(q) { return /Install as background daemon/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Configure Claude Code/.test(q) })).toBe(false)
    })

    it('chains into runInstall with --no when no Claude Code proxy is configured', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt } = scriptedPrompt([
        '1', // OTEL only
        '', // sink
        '', // default OTLP listen
        cfgPath,
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: absentDefaultCfg,
        hasGcBinary() { return false },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toEqual([['--config', cfgPath, '--no']])
    })

    it('does not offer daemon install on unsupported platforms', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt, asked } = scriptedPrompt([
        '2', '', cfgPath,
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'win32',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
        hasGcBinary() { return false },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toHaveLength(0)
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(false)
    })

    it('bootstraps global install when running via npx and daemon install is selected', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt, asked } = scriptedPrompt([
        '2', '', cfgPath,
      ])
      /** @type {Array<{ args: string[], binPath: string | undefined }>} */
      const installCalls = []
      let globalInstallCalls = 0
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
        binPath: '/Users/test/.npm/_npx/abc123/node_modules/.bin/collectivus',
        hasGcBinary() { return false },
        installGlobal() { globalInstallCalls++; return Promise.resolve(true) },
        resolveGlobalBinPath() { return Promise.resolve('/usr/local/lib/node_modules/collectivus/bin/cli.js') },
        runInstall(args, hooks) {
          installCalls.push({ args, binPath: hooks?.binPath })
          return Promise.resolve(0)
        },
      })
      expect(code).toBe(0)
      expect(globalInstallCalls).toBe(1)
      expect(installCalls).toEqual([{
        args: ['--config', cfgPath, '--yes'],
        binPath: '/usr/local/lib/node_modules/collectivus/bin/cli.js',
      }])
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(false)
      expect(stdout.value()).toMatch(/Installing collectivus globally with npm/)
    })
  })

  describe('central-server walkthrough', function() {
    it('writes a valid role:server config with the operator-supplied data_dir', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const dataDir = path.join(tmpDir, 'server-data')
      const { prompt } = scriptedPrompt([
        '', // accept default central-server listen
        'https://collectivus.example.com:8788', // gateway-facing URL
        dataDir, // server data directory
        '', // generate identity-issuer secret
        '', // no S3 upload
        cfgPath, // save path
      ])
      const code = await runInitSubcommand(['server'], {
        stdout, stderr, prompt,
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.version).toBe(1)
      expect(written.role).toBe('server')
      expect(written.server.control_plane_listen).toBe('0.0.0.0:8788')
      expect(written.server.public_url).toBe('https://collectivus.example.com:8788')
      expect(written.server.data_dir).toBe(dataDir)
      expect(written.server.sink_dir).toBe(path.join(dataDir, 'ingested'))
      expect(written.server.identity_issuer.bootstrap_store_path).toBe(path.join(dataDir, 'bootstrap.json'))
      expect(typeof written.server.identity_issuer.secret).toBe('string')
      expect(written.server.identity_issuer.secret.length).toBe(64)
      expect(written.server.identity_issuer.secret).toMatch(/^[0-9a-f]+$/)
      expect(written.query).toEqual({ cache: { enabled: true } })
      const loaded = loadConfig(cfgPath)
      expect(loaded.role).toBe('server')
      expect(stdout.value()).toMatch(/ctvs config bootstrap-token issue/)
      expect(stdout.value()).toMatch(/npx collectivus --config-endpoint='https:\/\/collectivus\.example\.com:8788\/v1\/bootstrap-config\?token=<bootstrap-token>'/)
      expect(stdout.value()).toMatch(/ctvs config set <gateway-id>/)
    })

    it('falls back to a generated secret when the operator-supplied value is too short', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const { prompt } = scriptedPrompt([
        '127.0.0.1:9999', // explicit central-server listen
        '', // default gateway-facing URL derived from listen
        '', // default data_dir
        'too-short', // shorter than 32 chars
        '', // no upload
        cfgPath,
      ])
      const code = await runInitSubcommand(['server'], {
        stdout, stderr, prompt,
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      expect(stderr.value()).toMatch(/secret shorter than 32 chars/)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.server.public_url).toBe('http://127.0.0.1:9999')
      expect(written.server.identity_issuer.secret).not.toBe('too-short')
      expect(written.server.identity_issuer.secret.length).toBe(64)
    })

    it('attaches an upload block when the operator opts in', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const { prompt } = scriptedPrompt([
        '', // default listen
        '', // default gateway-facing URL
        path.join(tmpDir, 'server-data'),
        '', // generate secret
        'y', // upload
        'my-server-archive', // bucket
        '', // default region
        '', // default prefix
        '', // default time
        '', // default signals
        '', // no custom endpoint
        cfgPath,
      ])
      const code = await runInitSubcommand(['server'], {
        stdout, stderr, prompt,
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.upload.bucket).toBe('my-server-archive')
    })
  })

  describe('existing config reuse', function() {
    it('reuses an existing config and chains into runInstall', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'existing.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        proxy: {
          listen: '127.0.0.1:8787',
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
          redact_headers: ['authorization'],
        },
        sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
      }
      const { prompt, asked } = scriptedPrompt([
        '', // accept reuse (default = use)
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: cfgPath,
        readConfig() { return existing },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toEqual([['--config', cfgPath, '--yes']])
      expect(stdout.value()).toMatch(/Found an existing config/)
      expect(stdout.value()).toMatch(/127\.0\.0\.1:8787/)
      expect(stdout.value()).toMatch(/anthropic → https:\/\/api\.anthropic\.com\/v1\/messages/)
      // Did not ask the removed mode question, provider, daemon, or Claude attach prompts.
      expect(asked.some(function(q) { return /How will you use collectivus/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Provider \[1\]/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Install as background daemon/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Configure Claude Code/.test(q) })).toBe(false)
    })

    it('bootstraps global install when reusing an existing config via npx', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'existing.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        proxy: {
          listen: '127.0.0.1:8787',
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
        },
        sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
      }
      const { prompt, asked } = scriptedPrompt([
        '', // accept reuse
      ])
      /** @type {Array<{ args: string[], binPath: string | undefined }>} */
      const installCalls = []
      let globalInstallCalls = 0
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: cfgPath,
        binPath: '/Users/test/.npm/_npx/abc123/node_modules/.bin/collectivus',
        readConfig() { return existing },
        installGlobal() { globalInstallCalls++; return Promise.resolve(true) },
        resolveGlobalBinPath() { return Promise.resolve('/usr/local/lib/node_modules/collectivus/bin/cli.js') },
        runInstall(args, hooks) {
          installCalls.push({ args, binPath: hooks?.binPath })
          return Promise.resolve(0)
        },
      })
      expect(code).toBe(0)
      expect(globalInstallCalls).toBe(1)
      expect(installCalls).toEqual([{
        args: ['--config', cfgPath, '--yes'],
        binPath: '/usr/local/lib/node_modules/collectivus/bin/cli.js',
      }])
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(false)
      expect(stdout.value()).toMatch(/Installing collectivus globally with npm/)
    })

    it('declining the existing config falls through to the question flow', async function() {
      const stdout = memo()
      const stderr = memo()
      const existingPath = path.join(tmpDir, 'existing.json')
      const newCfgPath = path.join(tmpDir, 'new.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        proxy: {
          listen: '127.0.0.1:9999',
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
        },
        sink: { type: 'file', dir: path.join(tmpDir, 'old-sink') },
      }
      const { prompt } = scriptedPrompt([
        '2', // reject reuse
        '2', // Claude Code
        '', // default sink
        newCfgPath, // save to a new path
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'win32',
        cwd: tmpDir,
        defaultConfigPath: existingPath,
        hasGcBinary() { return false },
        readConfig() { return existing },
      })
      expect(code).toBe(0)
      expect(fs.existsSync(newCfgPath)).toBe(true)
      const written = JSON.parse(fs.readFileSync(newCfgPath, 'utf8'))
      expect(written.proxy.listen).toBe('127.0.0.1:8787')
    })

    it('reusing an otel-only config installs the daemon without Claude Code attach', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'existing.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        otel: { listen: '0.0.0.0:4318' },
        sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
      }
      const { prompt, asked } = scriptedPrompt([
        '1', // reuse explicitly
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: cfgPath,
        readConfig() { return existing },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toEqual([['--config', cfgPath, '--no']])
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Configure Claude Code/.test(q) })).toBe(false)
      expect(stdout.value()).toMatch(/Installing ctvs as a background daemon/)
    })

    it('summary surfaces the upload block when present', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'existing.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        proxy: {
          listen: '127.0.0.1:8787',
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
        },
        sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
        upload: {
          bucket: 'team-archive',
          region: 'us-east-1',
          prefix: 'collectivus',
          time: '00:10',
          signals: ['logs', 'traces', 'metrics'],
        },
      }
      const { prompt } = scriptedPrompt([
        '1', // reuse
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'win32',
        cwd: tmpDir,
        defaultConfigPath: cfgPath,
        readConfig() { return existing },
      })
      expect(code).toBe(0)
      expect(stdout.value()).toMatch(/upload: s3:\/\/team-archive\/collectivus daily at 00:10 UTC/)
    })
  })
})
