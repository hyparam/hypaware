import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseUninstallArgs, runUninstall } from '../../src/cli/uninstall.js'

/**
 * @import { UninstallCall, DetachCall, UninstallMocks } from '../types.js'
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-uninstall-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {{
 *   uninstallError?: Error,
 *   detachError?: Error,
 *   detachResult?: { changed: boolean, removed?: string, warning?: string },
 *   codexDetachError?: Error,
 *   codexDetachResult?: { changed: boolean, removed?: string, restoredValue?: string, warning?: string },
 *   isAttachedResult?: boolean,
 *   isAttachedError?: Error,
 *   isCodexAttachedResult?: boolean,
 *   isCodexAttachedError?: Error,
 * }} [opts]
 * @returns {UninstallMocks}
 */
function makeMocks(opts = {}) {
  /** @type {UninstallCall[]} */
  const uninstallCalls = []
  /** @type {DetachCall[]} */
  const detachCalls = []
  /** @type {DetachCall[]} */
  const codexDetachCalls = []
  return {
    uninstallCalls,
    detachCalls,
    codexDetachCalls,
    uninstallLaunchAgent(o) {
      uninstallCalls.push({ ...o })
      if (opts.uninstallError) return Promise.reject(opts.uninstallError)
      return Promise.resolve()
    },
    detach(o) {
      detachCalls.push({ ...o })
      if (opts.detachError) return Promise.reject(opts.detachError)
      return Promise.resolve(opts.detachResult ?? { changed: true, removed: 'http://127.0.0.1:8787' })
    },
    detachCodex(o) {
      codexDetachCalls.push({ ...o })
      if (opts.codexDetachError) return Promise.reject(opts.codexDetachError)
      return Promise.resolve(opts.codexDetachResult ?? { changed: true, removed: 'http://127.0.0.1:8787/v1' })
    },
    isAttached() {
      if (opts.isAttachedError) return Promise.reject(opts.isAttachedError)
      return Promise.resolve(opts.isAttachedResult ?? true)
    },
    isCodexAttached() {
      if (opts.isCodexAttachedError) return Promise.reject(opts.isCodexAttachedError)
      return Promise.resolve(opts.isCodexAttachedResult ?? true)
    },
  }
}

describe('parseUninstallArgs', function() {
  it('treats no args as no help, no error', function() {
    expect(parseUninstallArgs([])).toEqual({ help: false })
  })

  it('returns help mode for --help / -h', function() {
    expect(parseUninstallArgs(['--help']).help).toBe(true)
    expect(parseUninstallArgs(['-h']).help).toBe(true)
  })

  it('rejects unknown args', function() {
    expect(parseUninstallArgs(['--mystery']).error).toMatch(/unknown argument/)
    expect(parseUninstallArgs(['--detach']).error).toMatch(/unknown argument/)
    expect(parseUninstallArgs(['--client', 'codex']).error).toMatch(/unknown argument/)
  })
})

describe('runUninstall', function() {
  it('prints help and exits 0 on --help', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runUninstall(['--help'], { stdout, stderr })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on bad args', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runUninstall(['--mystery'], { stdout, stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown argument/)
  })

  it('reverts both clients when both are attached', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({
      isAttachedResult: true,
      isCodexAttachedResult: true,
      codexDetachResult: { changed: true, restoredValue: 'openai' },
    })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'config.toml'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      detachCodex: m.detachCodex,
      isAttached: m.isAttached,
      isCodexAttached: m.isCodexAttached,
    })
    expect(code).toBe(0)
    expect(m.uninstallCalls).toEqual([{ label: 'com.hyparam.collectivus' }])
    expect(m.detachCalls).toEqual([{ settingsPath: path.join(tmpDir, 'settings.json') }])
    expect(m.codexDetachCalls).toEqual([{ configPath: path.join(tmpDir, 'config.toml') }])
    expect(stdout.value()).toMatch(/Daemon removed/)
    expect(stdout.value()).toMatch(/Claude Code reverted/)
    expect(stdout.value()).toMatch(/Codex reverted/)
    expect(stdout.value()).toMatch(/Restored model_provider=openai/)
  })

  it('reverts only Claude when only Claude is attached', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ isAttachedResult: true, isCodexAttachedResult: false })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'config.toml'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      detachCodex: m.detachCodex,
      isAttached: m.isAttached,
      isCodexAttached: m.isCodexAttached,
    })
    expect(code).toBe(0)
    expect(m.detachCalls).toHaveLength(1)
    expect(m.codexDetachCalls).toHaveLength(0)
    expect(stdout.value()).toMatch(/Claude Code reverted/)
    expect(stdout.value()).toMatch(/Codex: not attached/)
  })

  it('reverts only Codex when only Codex is attached', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ isAttachedResult: false, isCodexAttachedResult: true })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'config.toml'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      detachCodex: m.detachCodex,
      isAttached: m.isAttached,
      isCodexAttached: m.isCodexAttached,
    })
    expect(code).toBe(0)
    expect(m.detachCalls).toHaveLength(0)
    expect(m.codexDetachCalls).toHaveLength(1)
    expect(stdout.value()).toMatch(/Claude Code: not attached/)
    expect(stdout.value()).toMatch(/Codex reverted/)
  })

  it('removes daemon and reports neither client attached', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ isAttachedResult: false, isCodexAttachedResult: false })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'config.toml'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      detachCodex: m.detachCodex,
      isAttached: m.isAttached,
      isCodexAttached: m.isCodexAttached,
    })
    expect(code).toBe(0)
    expect(m.uninstallCalls).toHaveLength(1)
    expect(m.detachCalls).toHaveLength(0)
    expect(m.codexDetachCalls).toHaveLength(0)
    expect(stdout.value()).toMatch(/Claude Code: not attached/)
    expect(stdout.value()).toMatch(/Codex: not attached/)
  })

  it('exits 1 when uninstallDaemon fails', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ uninstallError: new Error('boom') })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      detachCodex: m.detachCodex,
      isAttached: m.isAttached,
      isCodexAttached: m.isCodexAttached,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to uninstall daemon.*boom/)
    expect(m.detachCalls).toHaveLength(0)
    expect(m.codexDetachCalls).toHaveLength(0)
  })

  it('exits 1 when Claude detach fails after uninstall', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ detachError: new Error('settings unreadable') })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      detachCodex: m.detachCodex,
      isAttached: m.isAttached,
      isCodexAttached: m.isCodexAttached,
    })
    expect(code).toBe(1)
    expect(m.uninstallCalls).toHaveLength(1)
    expect(stderr.value()).toMatch(/failed to revert Claude Code/)
  })

  it('surfaces detach warnings when ANTHROPIC_BASE_URL is overridden', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({
      isCodexAttachedResult: false,
      detachResult: { changed: true, warning: 'ANTHROPIC_BASE_URL was overridden externally; leaving in place' },
    })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      detachCodex: m.detachCodex,
      isAttached: m.isAttached,
      isCodexAttached: m.isCodexAttached,
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/warning: ANTHROPIC_BASE_URL was overridden/)
  })
})
