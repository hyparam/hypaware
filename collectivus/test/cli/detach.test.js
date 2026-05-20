import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDetachArgs, runDetach } from '../../src/cli/detach.js'

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-detach-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseDetachArgs', function() {
  it('treats no args as default', function() {
    expect(parseDetachArgs([])).toEqual({ help: false, client: 'claude' })
  })

  it('parses --client <name>', function() {
    expect(parseDetachArgs(['--client', 'codex'])).toMatchObject({
      help: false, client: 'codex',
    })
    expect(parseDetachArgs(['--client=all'])).toMatchObject({
      help: false, client: 'all',
    })
  })

  it('rejects unknown --client values', function() {
    expect(parseDetachArgs(['--client', 'zed']).error).toMatch(/expected claude, codex, or all/)
  })

  it('returns help mode for --help', function() {
    expect(parseDetachArgs(['--help']).help).toBe(true)
    expect(parseDetachArgs(['-h']).help).toBe(true)
  })

  it('rejects unknown args', function() {
    expect(parseDetachArgs(['--mystery']).error).toMatch(/unknown argument/)
  })
})

describe('runDetach', function() {
  it('prints help on --help', async function() {
    const stdout = memo()
    const code = await runDetach(['--help'], { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on bad args', async function() {
    const stderr = memo()
    const code = await runDetach(['--mystery'], { stdout: memo(), stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown argument/)
  })

  it('removes marker and reports the prior URL', async function() {
    const stdout = memo()
    /** @type {object[]} */
    const calls = []
    const code = await runDetach([], {
      stdout, stderr: memo(),
      settingsPath: path.join(tmpDir, 'settings.json'),
      detach(o) {
        calls.push(o)
        return Promise.resolve({ changed: true, removed: 'http://127.0.0.1:8787' })
      },
    })
    expect(code).toBe(0)
    expect(calls).toEqual([{ settingsPath: path.join(tmpDir, 'settings.json') }])
    expect(stdout.value()).toMatch(/Claude Code reverted/)
    expect(stdout.value()).toMatch(/Removed ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8787/)
  })

  it('--client codex: removes Codex marker and reports provider details', async function() {
    const stdout = memo()
    /** @type {object[]} */
    const claudeCalls = []
    /** @type {object[]} */
    const codexCalls = []
    const code = await runDetach(['--client', 'codex'], {
      stdout, stderr: memo(),
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'config.toml'),
      detachClaude(o) {
        claudeCalls.push(o)
        return Promise.resolve({ changed: true })
      },
      detachCodex(o) {
        codexCalls.push(o)
        return Promise.resolve({
          changed: true,
          removed: 'http://127.0.0.1:8787/v1',
          restoredValue: 'openai',
        })
      },
    })
    expect(code).toBe(0)
    expect(claudeCalls).toEqual([])
    expect(codexCalls).toEqual([{ configPath: path.join(tmpDir, 'config.toml') }])
    expect(stdout.value()).toMatch(/Codex reverted/)
    expect(stdout.value()).toMatch(/Removed base_url=http:\/\/127\.0\.0\.1:8787\/v1/)
    expect(stdout.value()).toMatch(/Restored model_provider=openai/)
  })

  it('--client all: reverts Claude Code and Codex', async function() {
    const stdout = memo()
    /** @type {object[]} */
    const claudeCalls = []
    /** @type {object[]} */
    const codexCalls = []
    const code = await runDetach(['--client', 'all'], {
      stdout, stderr: memo(),
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'config.toml'),
      detachClaude(o) {
        claudeCalls.push(o)
        return Promise.resolve({ changed: true })
      },
      detachCodex(o) {
        codexCalls.push(o)
        return Promise.resolve({ changed: true })
      },
    })
    expect(code).toBe(0)
    expect(claudeCalls).toHaveLength(1)
    expect(codexCalls).toHaveLength(1)
    expect(stdout.value()).toMatch(/Claude Code reverted/)
    expect(stdout.value()).toMatch(/Codex reverted/)
  })

  it('reports a warning when ANTHROPIC_BASE_URL was overridden externally', async function() {
    const stdout = memo()
    const code = await runDetach([], {
      stdout, stderr: memo(),
      settingsPath: path.join(tmpDir, 'settings.json'),
      detach() {
        return Promise.resolve({
          changed: true,
          warning: 'ANTHROPIC_BASE_URL was overridden externally; leaving in place',
        })
      },
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/warning: ANTHROPIC_BASE_URL was overridden/)
  })

  it('no-op when no marker is present', async function() {
    const stdout = memo()
    const code = await runDetach([], {
      stdout, stderr: memo(),
      settingsPath: path.join(tmpDir, 'settings.json'),
      detach() { return Promise.resolve({ changed: false }) },
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/nothing to do/)
  })

  it('exits 1 when detach throws', async function() {
    const stderr = memo()
    const code = await runDetach([], {
      stdout: memo(), stderr,
      detach() { return Promise.reject(new Error('settings malformed')) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to detach Claude Code.*settings malformed/)
  })

  it('exits 1 when Codex detach throws', async function() {
    const stderr = memo()
    const code = await runDetach(['--client', 'codex'], {
      stdout: memo(), stderr,
      detachCodex() { return Promise.reject(new Error('config.toml malformed')) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to detach Codex.*config\.toml malformed/)
  })
})
