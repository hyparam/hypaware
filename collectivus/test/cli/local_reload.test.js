import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runWithConfig } from '../../src/cli.js'
import { readPidFile } from '../../src/runtime/pid_file.js'

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return { write: (s) => { buf += s }, value: () => buf }
}

/**
 * Placeholder used while we wait for `runWithConfig` to wire its signal
 * handler hooks. The real handler replaces this on first call.
 *
 * @param {string} signal
 * @returns {void}
 */
function noopSignal(signal) { void signal /* replaced by runWithConfig handler */ }

/**
 * @param {() => unknown} predicate
 * @param {{ timeoutMs?: number, message?: string }} [opts]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 2000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(opts.message ?? `waitFor: predicate never became truthy in ${timeoutMs}ms`)
}

/** @type {string} */
let tmpDir
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctvs-localreload-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('runWithConfig: PID file lifecycle', () => {
  it('writes the daemon PID at startup and removes it on graceful shutdown', async () => {
    const cfg = {
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
    }
    const pidFilePath = path.join(tmpDir, 'collectivus.pid')
    /** @type {(signal: string) => void} */
    let trigger = noopSignal
    const stdout = memo()
    const stderr = memo()
    const result = runWithConfig(/** @type {never} */ (cfg), process.env, {
      stdout, stderr,
      pidFilePath,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => fs.existsSync(pidFilePath), { timeoutMs: 5000 })
    const pid = await readPidFile(pidFilePath, { probe: () => true })
    expect(pid).toBe(process.pid)
    trigger('SIGTERM')
    await result
    expect(fs.existsSync(pidFilePath)).toBe(false)
  })

  it('does not write a PID file in gateway role (supervised by launchd/systemd/k8s)', async () => {
    // Quick smoke that a non-standalone role skips the pid file. We use
    // role: server here because gateway requires central_server boot which
    // is more setup; the cli's gating check covers both roles identically.
    const cfg = {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '127.0.0.1:0',
        public_url: 'http://127.0.0.1',
        identity_issuer: { secret: 'a-very-very-long-test-secret-string' },
        admin: { token: 'a-very-very-long-admin-token-string-x' },
        data_dir: path.join(tmpDir, 'serverdata'),
      },
    }
    const pidFilePath = path.join(tmpDir, 'collectivus.pid')
    /** @type {(signal: string) => void} */
    let trigger = noopSignal
    const stdout = memo()
    const stderr = memo()
    const result = runWithConfig(/** @type {never} */ (cfg), process.env, {
      stdout, stderr,
      pidFilePath,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('Control-plane listener bound'), { timeoutMs: 5000 })
    expect(fs.existsSync(pidFilePath)).toBe(false)
    trigger('SIGTERM')
    await result
  })
})

describe('runWithConfig: SIGHUP local reload', () => {
  /**
   * Drive a fake SIGHUP via the `onSighupRequested` hook so we don't have
   * to interfere with real process signals (which would cross the
   * test/process boundary). The handler the daemon registers via the
   * hook reloads from `localConfigPath`.
   *
   * @param {object} initialCfg
   * @returns {Promise<{ result: Promise<number>, sighup: () => void, shutdown: (signal: string) => void, stdout: ReturnType<typeof memo>, stderr: ReturnType<typeof memo>, configPath: string }>}
   */
  async function bootDaemon(initialCfg) {
    const configPath = path.join(tmpDir, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify(initialCfg, null, 2))
    /** @type {(() => void) | undefined} */
    let sighup
    /** @type {(signal: string) => void} */
    let shutdown = noopSignal
    const stdout = memo()
    const stderr = memo()
    const pidFilePath = path.join(tmpDir, 'collectivus.pid')
    // We replicate what run() does: read the file once for the initial
    // boot, then hand the path through localConfigPath so SIGHUP can
    // re-read it.
    const result = runWithConfig(/** @type {never} */ (initialCfg), process.env, {
      stdout, stderr,
      pidFilePath,
      localConfigPath: configPath,
      onShutdownRequested: (handler) => { shutdown = handler },
      onSighupRequested: (handler) => { sighup = handler },
    })
    // Wait for both the listener boot log AND the sighup wiring — the
    // OTLP listener prints its line slightly before runLifecycle reaches
    // the SIGHUP wire-up step, so polling on the log alone races the
    // handler registration.
    await waitFor(
      () =>
        sighup !== undefined &&
        (stdout.value().includes('OTLP listener bound') || stdout.value().includes('Gascity source')),
      { timeoutMs: 5000, message: `boot did not complete: ${stdout.value()}` }
    )
    return { result, sighup: /** @type {() => void} */ (sighup), shutdown, stdout, stderr, configPath }
  }

  it('SIGHUP after editing the config starts a gascity source that wasn\'t there before', async () => {
    const initialCfg = {
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
    }
    const booted = await bootDaemon(initialCfg)
    // Write a NEW config object to disk — never mutate the one passed
    // to runWithConfig (`currentCfg` inside runLifecycle holds the same
    // reference, and a mutation would defeat the diff).
    const updatedCfg = {
      ...initialCfg,
      gascity: [{ name: 'hyptown', api_url: 'http://127.0.0.1:65500' }],
    }
    fs.writeFileSync(booted.configPath, JSON.stringify(updatedCfg, null, 2))
    booted.sighup()
    try {
      await waitFor(
        () => booted.stdout.value().includes('local reload: gascity started'),
        { timeoutMs: 3000, message: 'did not see gascity reload log' }
      )
    } catch (err) {
      booted.shutdown('SIGTERM')
      await booted.result
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
        `stdout: ${booted.stdout.value()}\n` +
        `stderr: ${booted.stderr.value()}`
      )
    }
    booted.shutdown('SIGTERM')
    await booted.result
  })

  it('SIGHUP that drops a gascity entry stops the source', async () => {
    const initialCfg = {
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
      gascity: [{ name: 'hyptown', api_url: 'http://127.0.0.1:65501' }],
    }
    const booted = await bootDaemon(initialCfg)
    // Build a clean object without gascity rather than `delete`-ing on
    // the boot-time config (same shared-reference trap as above).
    const updatedCfg = {
      version: initialCfg.version,
      otel: initialCfg.otel,
      sink: initialCfg.sink,
    }
    fs.writeFileSync(booted.configPath, JSON.stringify(updatedCfg, null, 2))
    booted.sighup()
    try {
      await waitFor(
        () => booted.stdout.value().includes('local reload: gascity stopped'),
        { timeoutMs: 3000, message: 'did not see gascity stopped log' }
      )
    } catch (err) {
      booted.shutdown('SIGTERM')
      await booted.result
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
        `stdout: ${booted.stdout.value()}\n` +
        `stderr: ${booted.stderr.value()}`
      )
    }
    booted.shutdown('SIGTERM')
    await booted.result
  })

  it('SIGHUP that swaps cities applies the diff in place (not a full restart)', async () => {
    const initialCfg = {
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
      gascity: [{ name: 'hyptown', api_url: 'http://127.0.0.1:65502' }],
    }
    const booted = await bootDaemon(initialCfg)
    const updatedCfg = {
      ...initialCfg,
      gascity: [
        { name: 'hyptown', api_url: 'http://127.0.0.1:65502' },
        { name: 'second', api_url: 'http://127.0.0.1:65503' },
      ],
    }
    fs.writeFileSync(booted.configPath, JSON.stringify(updatedCfg, null, 2))
    booted.sighup()
    try {
      await waitFor(
        () => booted.stdout.value().includes('local reload: gascity diff applied'),
        { timeoutMs: 3000, message: 'did not see gascity diff applied log' }
      )
    } catch (err) {
      booted.shutdown('SIGTERM')
      await booted.result
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
        `stdout: ${booted.stdout.value()}\n` +
        `stderr: ${booted.stderr.value()}`
      )
    }
    booted.shutdown('SIGTERM')
    await booted.result
  })
})
