import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, run } from '../src/cli.js'

/**
 * @import { ChildProcessWithoutNullStreams } from 'node:child_process'
 */

const cliPath = fileURLToPath(new URL('../bin/cli.js', import.meta.url))

/**
 * @param {ChildProcessWithoutNullStreams} child
 * @param {string} needle
 * @param {'stdout' | 'stderr'} [stream]
 * @returns {Promise<void>}
 */
function waitForOutput(child, needle, stream = 'stdout') {
  return new Promise((resolve, reject) => {
    let buf = ''
    const target = stream === 'stderr' ? child.stderr : child.stdout
    function onData(/** @type {Buffer} */ chunk) {
      buf += chunk.toString()
      if (buf.includes(needle)) {
        target.off('data', onData)
        resolve()
      }
    }
    target.on('data', onData)
    child.once('error', reject)
    child.once('exit', () => reject(new Error(`exited before "${needle}": ${buf}`)))
  })
}

/**
 * Minimal in-memory stream collector for `run()` hooks.
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

function noop() {}

describe('parseArgs', () => {
  it('returns config mode without configPath when nothing is supplied', () => {
    // The "no config source" error has moved into `run()` so it can fall back
    // to `~/.hyp/collectivus.json` when that file exists.
    expect(parseArgs([])).toEqual({ mode: 'config', printConfig: false, strict: false })
  })

  it('parses --config <path>', () => {
    expect(parseArgs(['--config', '/tmp/c.json'])).toEqual({
      mode: 'config', configPath: '/tmp/c.json', printConfig: false, strict: false,
    })
  })

  it('parses --config=<path>', () => {
    expect(parseArgs(['--config=/tmp/c.json'])).toEqual({
      mode: 'config', configPath: '/tmp/c.json', printConfig: false, strict: false,
    })
  })

  it('parses --config-env <env-var>', () => {
    expect(parseArgs(['--config-env', 'COLLECTIVUS_CONFIG_JSON'])).toEqual({
      mode: 'config', configEnv: 'COLLECTIVUS_CONFIG_JSON', printConfig: false, strict: false,
    })
  })

  it('rejects invalid --config-env names', () => {
    const r = parseArgs(['--config-env', 'not-valid'])
    expect(r.mode).toBe('error')
    if (r.mode === 'error') expect(r.message).toMatch(/environment variable name/)
  })

  it('parses --config-endpoint <url>', () => {
    expect(parseArgs(['--config-endpoint', 'https://central.example/v1/bootstrap-config?token=t'])).toEqual({
      mode: 'config',
      configPath: 'https://central.example/v1/bootstrap-config?token=t',
      printConfig: false,
      strict: false,
    })
  })

  it('rejects --config-endpoint without an http(s) URL', () => {
    const r = parseArgs(['--config-endpoint', '/tmp/c.json'])
    expect(r.mode).toBe('error')
    if (r.mode === 'error') expect(r.message).toMatch(/http\(s\) URL/)
  })

  it('rejects --config with --config-endpoint', () => {
    const r = parseArgs(['--config', '/tmp/c.json', '--config-endpoint', 'https://central.example/config'])
    expect(r.mode).toBe('error')
    if (r.mode === 'error') expect(r.message).toMatch(/mutually exclusive/)
  })

  it('rejects --config-env with --config', () => {
    const r = parseArgs(['--config-env', 'COLLECTIVUS_CONFIG_JSON', '--config', '/tmp/c.json'])
    expect(r.mode).toBe('error')
    if (r.mode === 'error') expect(r.message).toMatch(/mutually exclusive/)
  })

  it('parses --config <path> --print-config', () => {
    expect(parseArgs(['--config', '/tmp/c.json', '--print-config'])).toEqual({
      mode: 'config', configPath: '/tmp/c.json', printConfig: true, strict: false,
    })
  })

  it('parses --config <path> --strict', () => {
    expect(parseArgs(['--config', '/tmp/c.json', '--strict'])).toEqual({
      mode: 'config', configPath: '/tmp/c.json', printConfig: false, strict: true,
    })
  })

  it('returns help mode for --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({ mode: 'help' })
    expect(parseArgs(['-h'])).toEqual({ mode: 'help' })
  })

  it('returns version mode for --version, -V, and -v', () => {
    expect(parseArgs(['--version'])).toEqual({ mode: 'version' })
    expect(parseArgs(['-V'])).toEqual({ mode: 'version' })
    expect(parseArgs(['-v'])).toEqual({ mode: 'version' })
  })

  it('accepts --print-config without --config (run() resolves the default)', () => {
    expect(parseArgs(['--print-config'])).toEqual({ mode: 'config', printConfig: true, strict: false })
  })

  it('rejects unknown arguments', () => {
    const r = parseArgs(['--mystery'])
    expect(r.mode).toBe('error')
    if (r.mode === 'error') expect(r.message).toMatch(/unknown argument/)
  })

  it('rejects --config without a value', () => {
    expect(parseArgs(['--config']).mode).toBe('error')
    expect(parseArgs(['--config=']).mode).toBe('error')
  })

  it('all error results carry exit code 2', () => {
    const r = parseArgs(['--mystery'])
    if (r.mode === 'error') expect(r.exitCode).toBe(2)
    else throw new Error('expected error')
  })
})

describe('run(): help and arg errors', () => {
  it('prints help and exits 0 on --help', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--help'], {}, { stdout, stderr })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('prints version and exits 0 on --version', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--version'], {}, { stdout, stderr })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/^\d+\.\d+\.\d+/)
    expect(stderr.value()).toBe('')
  })

  it('prints error + usage and exits 2 on bad args', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--mystery'], {}, { stdout, stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown argument/)
    expect(stderr.value()).toMatch(/Usage:/)
  })

  it('prints error + usage and exits 2 when --config is missing and no default exists', async () => {
    const stdout = memo()
    const stderr = memo()
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-empty-home-'))
    try {
      const code = await run([], {}, { stdout, stderr, homeDir: emptyHome })
      expect(code).toBe(2)
      expect(stderr.value()).toMatch(/--config <path\|url>, --config-env <env-var>, or --config-endpoint <url> is required/)
      expect(stderr.value()).toMatch(/Usage:/)
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true })
    }
  })

  it('falls back to ~/.hyp/collectivus.json when no --config is supplied', async () => {
    const stdout = memo()
    const stderr = memo()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-home-'))
    try {
      fs.mkdirSync(path.join(home, '.hyp'), { recursive: true })
      fs.writeFileSync(
        path.join(home, '.hyp', 'collectivus.json'),
        JSON.stringify({ version: 1, otel: { listen: '127.0.0.1:0' }, sink: { type: 'file', dir: '/tmp/x' } })
      )
      const code = await run(['--print-config'], {}, { stdout, stderr, homeDir: home })
      expect(code).toBe(0)
      expect(stdout.value()).toMatch(/"otel"/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('run(): walkthrough dispatch', () => {
  it('routes empty argv on a TTY into the init walkthrough', async () => {
    const stdout = memo()
    const stderr = memo()
    let initCalls = 0
    const code = await run([], {}, {
      stdout, stderr,
      isTTY: true,
      runInit: () => { initCalls++; return Promise.resolve(0) },
    })
    expect(code).toBe(0)
    expect(initCalls).toBe(1)
    expect(stderr.value()).toBe('')
  })

  it('falls through to the --config error when not a TTY and no default exists', async () => {
    const stdout = memo()
    const stderr = memo()
    let initCalls = 0
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-empty-home-'))
    try {
      const code = await run([], {}, {
        stdout, stderr,
        isTTY: false,
        runInit: () => { initCalls++; return Promise.resolve(0) },
        homeDir: emptyHome,
      })
      expect(code).toBe(2)
      expect(initCalls).toBe(0)
      expect(stderr.value()).toMatch(/--config <path\|url>, --config-env <env-var>, or --config-endpoint <url> is required/)
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true })
    }
  })
})

describe('run(): --config <path>', () => {
  /** @type {string} */
  let tmpDir
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cli-cfg-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * @param {object} cfg
   * @returns {string}
   */
  function writeConfig(cfg) {
    const p = path.join(tmpDir, 'config.json')
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
    return p
  }

  it('returns 1 on missing config file', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--config', path.join(tmpDir, 'nope.json')], {}, { stdout, stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/config error.*not found/)
  })

  it('returns 1 on invalid config schema', async () => {
    const cfgPath = writeConfig({ version: 1, mystery: 1 })
    const stdout = memo()
    const stderr = memo()
    // --strict promotes the unknown-key warning to an error.
    const code = await run(['--config', cfgPath, '--strict'], {}, { stdout, stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/config error.*unknown key "mystery"/)
  })

  it('warns but proceeds on unknown top-level key without --strict', async () => {
    const cfg = {
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
      mystery: 'kept',
    }
    const cfgPath = writeConfig(cfg)
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('OTLP listener bound'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stderr.value()).toMatch(/warning: unknown config key "mystery" ignored/)
  })

  it('returns 1 on a v0 config (missing version field)', async () => {
    const cfg = { otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp' } }
    const cfgPath = writeConfig(cfg)
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--config', cfgPath], {}, { stdout, stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/config error.*missing "version" field/)
    expect(stderr.value()).toMatch(/requires version: 1/)
  })

  it('--print-config round-trips a v1 config unchanged', async () => {
    const cfg = {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      sink: { type: 'file', dir: '/tmp/x' },
      upload: { bucket: 'b' },
    }
    const cfgPath = writeConfig(cfg)
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--config', cfgPath, '--print-config'], {}, { stdout, stderr })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.value())).toEqual(cfg)
  })

  it('--config-env loads config JSON from the environment', async () => {
    const cfg = {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      sink: { type: 'file', dir: '/tmp/x' },
    }
    const stdout = memo()
    const stderr = memo()
    const code = await run(
      ['--config-env', 'COLLECTIVUS_CONFIG_JSON', '--print-config'],
      { COLLECTIVUS_CONFIG_JSON: JSON.stringify(cfg) },
      { stdout, stderr }
    )
    expect(code).toBe(0)
    expect(JSON.parse(stdout.value())).toEqual(cfg)
  })

  it('--config-env reports a config error when the environment variable is missing', async () => {
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--config-env', 'COLLECTIVUS_CONFIG_JSON'], {}, { stdout, stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/environment variable COLLECTIVUS_CONFIG_JSON is not set/)
  })

  it('starts the uploader when upload is configured and AWS creds are present', async () => {
    const sinkDir = path.join(tmpDir, 'data')
    const cfg = {
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: sinkDir },
      upload: { bucket: 'b', prefix: 'collectivus', time: '03:14' },
    }
    const cfgPath = writeConfig(cfg)
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    // sinkDir/services does not exist → discoverJobs returns [] →
    // uploader.start()'s catch-up tick is a no-op and never touches S3.
    const env = { AWS_ACCESS_KEY_ID: 'test-id', AWS_SECRET_ACCESS_KEY: 'test-secret' }
    const result = run(['--config', cfgPath], env, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('Uploader scheduled'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.value()).toMatch(/Uploader scheduled for 03:14 UTC, target s3:\/\/b\/collectivus/)
    expect(stderr.value()).not.toMatch(/AWS_ACCESS_KEY/)
  })

  it('starts the uploader when upload is configured with ECS task-role credentials', async () => {
    const sinkDir = path.join(tmpDir, 'data')
    const cfg = {
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: sinkDir },
      upload: { bucket: 'b', prefix: 'collectivus', time: '03:14' },
    }
    const cfgPath = writeConfig(cfg)
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const env = { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task' }
    const result = run(['--config', cfgPath], env, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('Uploader scheduled'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.value()).toMatch(/Uploader scheduled for 03:14 UTC, target s3:\/\/b\/collectivus/)
    expect(stderr.value()).not.toMatch(/credential source/)
  })

  it('exits 1 with a config error before binding any listener when AWS creds are missing', async () => {
    const sinkDir = path.join(tmpDir, 'data')
    const cfg = {
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: sinkDir },
      upload: { bucket: 'b' },
    }
    const cfgPath = writeConfig(cfg)
    const stdout = memo()
    const stderr = memo()
    // Empty env: no AWS creds in scope.
    const code = await run(['--config', cfgPath], {}, { stdout, stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(
      /config error: upload\.bucket is set but no AWS credential source is available; set AWS_ACCESS_KEY_ID\/AWS_SECRET_ACCESS_KEY or run with an ECS task role\./
    )
    // Boot must fail before the otel listener gets a chance to bind.
    expect(stdout.value()).not.toMatch(/OTLP listener bound/)
  })

  it('skips the AWS env precheck for --print-config so config inspection still works without creds', async () => {
    const cfg = {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      sink: { type: 'file', dir: '/tmp/x' },
      upload: { bucket: 'b' },
    }
    const cfgPath = writeConfig(cfg)
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--config', cfgPath, '--print-config'], {}, { stdout, stderr })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.value())).toEqual(cfg)
    expect(stderr.value()).not.toMatch(/AWS_ACCESS_KEY/)
  })

  it('starts otel listener from config and exits cleanly on shutdown', async () => {
    const sinkDir = path.join(tmpDir, 'data')
    const cfg = { version: 1, otel: { listen: '127.0.0.1:0' }, sink: { type: 'file', dir: sinkDir } }
    const cfgPath = writeConfig(cfg)
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    // Wait for the listener to come up
    await waitFor(() => stdout.value().includes('OTLP listener bound'))
    trigger('SIGTERM')
    const code = await result
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Received SIGTERM/)
    expect(stdout.value()).toMatch(/Shutdown complete/)
    // 127.0.0.1:0 means kernel-assigned port; make sure we logged the host
    expect(stdout.value()).toMatch(/127\.0\.0\.1:\d+/)
  })

  it('starts both otel and proxy listeners when both are configured', async () => {
    const cfg = {
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      proxy: {
        listen: '127.0.0.1:0',
        upstreams: [{ name: 'a', base_url: 'https://x.test', match: { path_prefix: '/v1' } }],
      },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
    }
    const cfgPath = writeConfig(cfg)
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => /OTLP listener bound/.test(stdout.value()) && /Proxy listener bound/.test(stdout.value()))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.value()).toMatch(/Proxy listener bound on 127\.0\.0\.1:\d+/)
    expect(stdout.value()).toMatch(/recording to .*\/proxy\/<UTC-date>\.jsonl/)
    expect(stderr.value()).not.toMatch(/not yet implemented/)
  })

  it('returns 1 when config has no enabled listeners', async () => {
    const cfgPath = writeConfig({ version: 1 })
    const stdout = memo()
    const stderr = memo()
    const code = await run(['--config', cfgPath], {}, { stdout, stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/no listeners configured/)
  })

  it('returns 1 when the listener cannot bind (port already in use)', async () => {
    // Hold a port so the configured listener (also binding the same address)
    // collides with EADDRINUSE.
    const blocker = await import('node:http').then((http) => {
      const server = http.createServer()
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
    })
    const addr = blocker.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    try {
      const cfg = {
        version: 1,
        otel: { listen: `127.0.0.1:${addr.port}` },
        sink: { type: 'file', dir: path.join(tmpDir, 'data') },
      }
      const cfgPath = writeConfig(cfg)
      const stdout = memo()
      const stderr = memo()
      const code = await run(['--config', cfgPath], {}, { stdout, stderr })
      expect(code).toBe(1)
      expect(stderr.value()).toMatch(/failed to start listener/)
    } finally {
      await new Promise((resolve) => blocker.close(() => resolve(undefined)))
    }
  })
})

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('CLI signal handling (spawned)', () => {
  it('shuts down gracefully on SIGTERM', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-sigterm-'))
    const cfgPath = path.join(tmp, 'config.json')
    const sinkDir = path.join(tmp, 'data')
    fs.writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: sinkDir },
    }))
    const child = spawn(process.execPath, [cliPath, '--config', cfgPath])
    try {
      await waitForOutput(child, 'OTLP listener bound')
      const exit = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })
      child.kill('SIGTERM')
      const result = await exit
      expect(result).toEqual({ code: 0, signal: null })
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }, 10000)

  it('--config <path> smoke: launches listener, accepts traffic, shuts down', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-smoke-'))
    const cfgPath = path.join(tmp, 'config.json')
    const sinkDir = path.join(tmp, 'data')
    fs.writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: sinkDir },
    }))
    const child = spawn(process.execPath, [cliPath, '--config', cfgPath])
    /** @type {string} */
    let buf = ''
    child.stdout.on('data', (chunk) => { buf += chunk.toString() })
    try {
      await waitFor(() => /127\.0\.0\.1:(\d+)/.test(buf), 5000)
      const portMatch = /127\.0\.0\.1:(\d+)/.exec(buf)
      if (!portMatch) throw new Error(`did not capture port; buf=${buf}`)
      const res = await fetch(`http://127.0.0.1:${portMatch[1]}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      })
      expect(res.status).toBe(200)
      const exit = new Promise((resolve) => {
        child.once('exit', (code) => resolve(code))
      })
      child.kill('SIGTERM')
      expect(await exit).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }, 10000)
})
