import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../bin/cli.js', import.meta.url))

/** @type {string} */
let emptyHome
beforeAll(function() {
  // Point HOME at an empty directory so the CLI can't pick up the developer's
  // real ~/.hyp/collectivus.json and turn "missing --config" into a load.
  emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-dispatch-home-'))
})
afterAll(function() {
  fs.rmSync(emptyHome, { recursive: true, force: true })
})

/**
 * Spawn the CLI with the given args and capture stdio + exit code.
 *
 * @param {string[]} args
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function runCli(args) {
  return new Promise(function(resolve, reject) {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', function(c) { stdout += c.toString() })
    child.stderr.on('data', function(c) { stderr += c.toString() })
    child.once('error', reject)
    child.once('exit', function(code) { resolve({ exitCode: code ?? -1, stdout, stderr }) })
  })
}

describe('bin/cli.js — subcommand dispatch', function() {
  it('dispatches `install --help`', async function() {
    const r = await runCli(['install', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs install/)
  })

  it('dispatches `uninstall --help`', async function() {
    const r = await runCli(['uninstall', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs uninstall/)
  })

  it('dispatches `attach --help`', async function() {
    const r = await runCli(['attach', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs attach/)
  })

  it('dispatches `detach --help`', async function() {
    const r = await runCli(['detach', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs detach/)
  })

  it('dispatches `status --help`', async function() {
    const r = await runCli(['status', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs status/)
  })

  it('dispatches `config --help`', async function() {
    const r = await runCli(['config', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs config set/)
  })

  it('dispatches `export --help`', async function() {
    const r = await runCli(['export', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs export/)
  })

  it('dispatches `query --help`', async function() {
    const r = await runCli(['query', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs query/)
  })

  it('dispatches `collect --help`', async function() {
    const r = await runCli(['collect', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs collect/)
  })

  it('dispatches `rendezvous --help`', async function() {
    const r = await runCli(['rendezvous', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs rendezvous/)
  })

  it('dispatches `join --help`', async function() {
    const r = await runCli(['join', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs join/)
  })

  it('dispatches `skills --help`', async function() {
    const r = await runCli(['skills', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+ctvs skills install/)
  })

  it('passes subcommand args through (install with no --config)', async function() {
    const r = await runCli(['install'])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/--config is required/)
  })

  it('falls through to listener mode for non-subcommand args', async function() {
    const r = await runCli(['--help'])
    expect(r.exitCode).toBe(0)
    // Top-level USAGE wording, not a subcommand-specific Usage.
    expect(r.stdout).toMatch(/--config <path\|url>\]\s+Run with config file/)
  })
})
