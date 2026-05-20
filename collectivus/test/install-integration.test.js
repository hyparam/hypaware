import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../bin/cli.js', import.meta.url))
const isDarwin = process.platform === 'darwin'

/**
 * Run the CLI in a fully sandboxed environment.
 *
 * - `HOME` is redirected to `tmpHome` so the implementation's `os.homedir()`
 *   calls touch the temp settings.json, plist dir, and log dir.
 * - `PATH` is prefixed with a temp directory containing a `launchctl` shim
 *   that always exits 0, so we don't pollute the real launchd domain.
 *
 * @param {string[]} args
 * @param {{ home: string, launchctlBin: string }} ctx
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function runCli(args, ctx) {
  return new Promise(function(resolve, reject) {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: ctx.home,
        PATH: `${path.dirname(ctx.launchctlBin)}:${process.env.PATH ?? ''}`,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', function(c) { stdout += c.toString() })
    child.stderr.on('data', function(c) { stderr += c.toString() })
    child.once('error', reject)
    child.once('exit', function(code) {
      // The CLI's best-effort npm registry check writes an update notice to
      // stderr whenever the published "latest" tag disagrees with the local
      // package.json (e.g. running tests against an in-development version
      // newer than what's on the registry). It's not an error; strip it so
      // the assertions can still demand empty stderr for real failures.
      const filtered = stderr
        .split('\n')
        .filter(function(line) {
          return !/A newer version of collectivus is available/.test(line)
            && !/Run 'npm install -g collectivus' to update/.test(line)
        })
        .join('\n')
      resolve({ exitCode: code ?? -1, stdout, stderr: filtered })
    })
  })
}

describe.skipIf(!isDarwin)('install + uninstall round-trip (macOS)', function() {
  /** @type {string} */
  let tmpHome
  /** @type {string} */
  let plistPath
  /** @type {string} */
  let settingsPath
  /** @type {string} */
  let configPath
  /** @type {string} */
  let launchctlBin
  /** @type {string} */
  let logDir

  beforeEach(function() {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-int-'))
    plistPath = path.join(tmpHome, 'Library', 'LaunchAgents', 'com.hyparam.collectivus.plist')
    settingsPath = path.join(tmpHome, '.claude', 'settings.json')
    logDir = path.join(tmpHome, '.hyp', 'collectivus')
    configPath = path.join(tmpHome, 'collectivus.json')

    // Pre-existing settings.json with unrelated keys we expect to survive.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      permissions: { allow: ['Bash(npm test)'] },
      env: { EXISTING: 'kept' },
    }, null, 2))

    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      proxy: {
        listen: '127.0.0.1:8787',
        upstreams: [
          { name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/' } },
        ],
      },
      sink: { type: 'file', dir: path.join(tmpHome, 'sink') },
    }, null, 2))

    // launchctl shim — exits 0 for every invocation. Stays on disk for the
    // duration of the test; the tmpHome cleanup removes it with everything else.
    const shimDir = path.join(tmpHome, 'shim-bin')
    fs.mkdirSync(shimDir, { recursive: true })
    launchctlBin = path.join(shimDir, 'launchctl')
    fs.writeFileSync(launchctlBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  })

  afterEach(function() {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('install --yes writes plist + marker; uninstall reverts both, preserving unrelated keys', async function() {
    const installResult = await runCli(['install', '--yes', '--config', configPath], {
      home: tmpHome, launchctlBin,
    })
    expect(installResult.stderr, installResult.stderr).toBe('')
    expect(installResult.exitCode).toBe(0)
    expect(installResult.stdout).toMatch(/Daemon installed/)
    expect(installResult.stdout).toMatch(/Claude Code attached/)

    expect(fs.existsSync(plistPath), 'plist file should exist after install').toBe(true)
    const plistXml = fs.readFileSync(plistPath, 'utf8')
    expect(plistXml).toMatch(/com\.hyparam\.collectivus/)
    expect(plistXml).toMatch(new RegExp(escapeRegExp(configPath)))

    const afterInstall = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(afterInstall._collectivus).toMatchObject({
      port: 8787,
      version: expect.any(String),
      attached_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
    expect(afterInstall.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
    // Unrelated keys preserved.
    expect(afterInstall.theme).toBe('dark')
    expect(afterInstall.permissions).toEqual({ allow: ['Bash(npm test)'] })
    expect(afterInstall.env.EXISTING).toBe('kept')

    // Log directory is created during install.
    expect(fs.existsSync(logDir), 'log dir should be created').toBe(true)

    const uninstallResult = await runCli(['uninstall'], {
      home: tmpHome, launchctlBin,
    })
    expect(uninstallResult.stderr, uninstallResult.stderr).toBe('')
    expect(uninstallResult.exitCode).toBe(0)
    expect(uninstallResult.stdout).toMatch(/Daemon removed/)
    expect(uninstallResult.stdout).toMatch(/Claude Code reverted/)

    expect(fs.existsSync(plistPath), 'plist file should be removed after uninstall').toBe(false)

    const afterUninstall = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(afterUninstall._collectivus, 'marker should be gone').toBeUndefined()
    expect(afterUninstall.env?.ANTHROPIC_BASE_URL, 'managed BASE_URL should be gone').toBeUndefined()
    // Unrelated keys still preserved.
    expect(afterUninstall.theme).toBe('dark')
    expect(afterUninstall.permissions).toEqual({ allow: ['Bash(npm test)'] })
    expect(afterUninstall.env?.EXISTING).toBe('kept')
  }, 20000)
})

if (!isDarwin) {
  describe('install + uninstall round-trip', function() {
    it('skipped: integration test runs on macOS only', function() {
      expect(isDarwin).toBe(false)
    })
  })
}

/**
 * Escape `value` so it can be embedded inside a RegExp literal as a literal
 * substring. Keeps the test resilient to tmp paths that contain regex
 * metacharacters.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
