import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseAdminArgs, runAdmin } from '../../src/cli/admin.js'
import { adminConfigPath, readAdminConfig } from '../../src/cli/common.js'

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-admin-cli-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('adminConfigPath', function() {
  it('resolves to ~/.hyp/collectivus/admin.json under the supplied home', function() {
    expect(adminConfigPath(tmpDir)).toBe(path.join(tmpDir, '.hyp', 'collectivus', 'admin.json'))
  })
})

describe('parseAdminArgs', function() {
  it('returns help for --help and -h', function() {
    expect(parseAdminArgs(['--help']).kind).toBe('help')
    expect(parseAdminArgs(['-h']).kind).toBe('help')
  })

  it('errors when no subcommand is given', function() {
    expect(parseAdminArgs([])).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('rejects unknown subcommands', function() {
    expect(parseAdminArgs(['rotate'])).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('parses a valid configure invocation', function() {
    expect(parseAdminArgs(['configure', '--central', 'https://example.com', '--admin-token', 'abcd'])).toEqual({
      kind: 'configure',
      central: 'https://example.com',
      adminToken: 'abcd',
    })
  })

  it('supports --flag=value form', function() {
    expect(parseAdminArgs(['configure', '--central=https://example.com', '--admin-token=abcd'])).toEqual({
      kind: 'configure',
      central: 'https://example.com',
      adminToken: 'abcd',
    })
  })

  it('rejects non-http(s) central URLs', function() {
    expect(parseAdminArgs(['configure', '--central', 'ftp://example.com', '--admin-token', 'abcd']))
      .toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseAdminArgs(['configure', '--central', 'not-a-url', '--admin-token', 'abcd']))
      .toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('requires both flags', function() {
    expect(parseAdminArgs(['configure', '--central', 'https://example.com']))
      .toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseAdminArgs(['configure', '--admin-token', 'abcd']))
      .toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('rejects unknown configure arguments', function() {
    expect(parseAdminArgs(['configure', '--central', 'https://example.com', '--admin-token', 'abcd', '--mystery']))
      .toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('shows per-verb help', function() {
    expect(parseAdminArgs(['configure', '--help']).kind).toBe('configure-help')
    expect(parseAdminArgs(['status', '--help']).kind).toBe('status-help')
    expect(parseAdminArgs(['clear', '--help']).kind).toBe('clear-help')
  })
})

describe('runAdmin configure', function() {
  it('writes a JSON file with mode 0600 under the injected home', async function() {
    const stdout = memo()
    const code = await runAdmin([
      'configure', '--central', 'https://central.example.com', '--admin-token', 'super-secret-token-ABCD',
    ], { homeDir: tmpDir, stdout })
    expect(code).toBe(0)
    const configFile = adminConfigPath(tmpDir)
    expect(fs.existsSync(configFile)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    expect(parsed).toEqual({
      central_url: 'https://central.example.com',
      admin_token: 'super-secret-token-ABCD',
    })
    if (process.platform !== 'win32') {
      const stat = fs.statSync(configFile)
      expect(stat.mode & 0o777).toBe(0o600)
    }
    expect(stdout.value()).toContain(configFile)
  })

  it('rejects non-http URLs with exit code 2 and writes nothing', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runAdmin(
      ['configure', '--central', 'file:///etc/passwd', '--admin-token', 'abcd'],
      { homeDir: tmpDir, stdout, stderr }
    )
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/http or https/)
    expect(fs.existsSync(adminConfigPath(tmpDir))).toBe(false)
  })

  it('rejects empty tokens with exit code 2', async function() {
    const stderr = memo()
    const code = await runAdmin(
      ['configure', '--central', 'https://example.com', '--admin-token', ''],
      { homeDir: tmpDir, stdout: memo(), stderr }
    )
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/--admin-token/)
    expect(fs.existsSync(adminConfigPath(tmpDir))).toBe(false)
  })
})

describe('runAdmin status', function() {
  it('prints the central URL and a redacted token, exits 0', async function() {
    await runAdmin(
      ['configure', '--central', 'https://central.example.com', '--admin-token', 'super-secret-token-ABCD'],
      { homeDir: tmpDir, stdout: memo() }
    )
    const stdout = memo()
    const code = await runAdmin(['status'], { homeDir: tmpDir, stdout })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toContain('central_url: https://central.example.com')
    expect(out).toContain('admin_token: …ABCD')
    expect(out).not.toContain('super-secret-token-ABCD')
  })

  it('exits nonzero with a clear message when no config exists', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runAdmin(['status'], { homeDir: tmpDir, stdout, stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/no admin config/)
    expect(stdout.value()).toBe('')
  })

  it('rejects unknown arguments', async function() {
    const stderr = memo()
    const code = await runAdmin(['status', '--mystery'], { homeDir: tmpDir, stdout: memo(), stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown argument/)
  })
})

describe('runAdmin clear', function() {
  it('removes an existing config and is idempotent on a missing one', async function() {
    await runAdmin(
      ['configure', '--central', 'https://example.com', '--admin-token', 'abcd-1234'],
      { homeDir: tmpDir, stdout: memo() }
    )
    const configFile = adminConfigPath(tmpDir)
    expect(fs.existsSync(configFile)).toBe(true)

    const firstOut = memo()
    const firstCode = await runAdmin(['clear'], { homeDir: tmpDir, stdout: firstOut })
    expect(firstCode).toBe(0)
    expect(firstOut.value()).toMatch(/Removed/)
    expect(fs.existsSync(configFile)).toBe(false)

    const secondOut = memo()
    const secondCode = await runAdmin(['clear'], { homeDir: tmpDir, stdout: secondOut })
    expect(secondCode).toBe(0)
    expect(secondOut.value()).toMatch(/nothing to remove/)
  })
})

describe('readAdminConfig round-trip', function() {
  it('writeAdminConfig followed by readAdminConfig returns the same fields', async function() {
    const code = await runAdmin(
      ['configure', '--central', 'http://localhost:8787', '--admin-token', 'tok-9999'],
      { homeDir: tmpDir, stdout: memo() }
    )
    expect(code).toBe(0)
    expect(readAdminConfig(adminConfigPath(tmpDir))).toEqual({
      central_url: 'http://localhost:8787',
      admin_token: 'tok-9999',
    })
  })

  it('returns undefined when the file is absent', function() {
    expect(readAdminConfig(adminConfigPath(tmpDir))).toBeUndefined()
  })

  it('throws on malformed JSON', function() {
    const configFile = adminConfigPath(tmpDir)
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, '{ not json', { mode: 0o600 })
    expect(() => readAdminConfig(configFile)).toThrow(/not valid JSON/)
  })

  it('throws when required fields are missing', function() {
    const configFile = adminConfigPath(tmpDir)
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify({ central_url: 'https://example.com' }), { mode: 0o600 })
    expect(() => readAdminConfig(configFile)).toThrow(/admin_token/)
  })
})
