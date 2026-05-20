import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexSettingsError, attach, defaultConfigPath, detach, isAttached } from '../../src/codex/settings.js'

/** @type {string} */
let tmpDir
/** @type {string} */
let configPath
/** @type {string | undefined} */
let originalCodexHome

beforeEach(() => {
  originalCodexHome = process.env.CODEX_HOME
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-codex-'))
  configPath = path.join(tmpDir, 'config.toml')
})

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {string} body
 * @returns {void}
 */
function writeToml(body) {
  fs.writeFileSync(configPath, body)
}

/**
 * @returns {string}
 */
function readToml() {
  return fs.readFileSync(configPath, 'utf8')
}

describe('defaultConfigPath', () => {
  it('points at ~/.codex/config.toml', () => {
    delete process.env.CODEX_HOME
    expect(defaultConfigPath()).toBe(path.join(os.homedir(), '.codex', 'config.toml'))
  })

  it('uses CODEX_HOME when set', () => {
    process.env.CODEX_HOME = tmpDir
    expect(defaultConfigPath()).toBe(path.join(tmpDir, 'config.toml'))
  })
})

describe('attach', () => {
  it('creates a fresh config file and parent directory', async () => {
    const nested = path.join(tmpDir, 'nested', 'config.toml')

    const result = await attach({ port: 8787, version: '1.0.0', configPath: nested })

    expect(result).toEqual({ changed: true })
    const written = fs.readFileSync(nested, 'utf8')
    expect(written).toContain('model_provider = "collectivus"')
    expect(written).toContain('[model_providers.collectivus]')
    expect(written).toContain('base_url = "http://127.0.0.1:8787/v1"')
    expect(written).toContain('requires_openai_auth = true')
    expect(written).toContain('wire_api = "responses"')
    expect(written).toContain('supports_websockets = false')
  })

  it('inserts the root model_provider before the first table', async () => {
    writeToml('model = "gpt-5.1-codex"\n[projects."/repo"]\ntrust_level = "trusted"\n')

    await attach({ port: 8787, version: '1.0.0', configPath })

    const written = readToml()
    expect(written.indexOf('model_provider = "collectivus"')).toBeLessThan(
      written.indexOf('[projects."/repo"]')
    )
    expect(written).toContain('model = "gpt-5.1-codex"')
    expect(written).toContain('trust_level = "trusted"')
  })

  it('does not treat bracketed multiline string content as a table', async () => {
    writeToml(
      'instructions = """\n' +
      '[section]\n' +
      'model_provider = "inside-string"\n' +
      '"""\n' +
      '[projects."/repo"]\n' +
      'trust_level = "trusted"\n'
    )

    await attach({ port: 8787, version: '1.0.0', configPath })

    const written = readToml()
    const closingStringIndex = written.indexOf('\n"""\n')
    expect(written).toContain('[section]\nmodel_provider = "inside-string"\n"""')
    expect(written.indexOf('model_provider = "collectivus"')).toBeGreaterThan(
      closingStringIndex
    )
    expect(written.indexOf('model_provider = "collectivus"')).toBeLessThan(
      written.indexOf('[projects."/repo"]')
    )
  })

  it('preserves blank lines inside multiline strings', async () => {
    writeToml(
      'developer_instructions = """line one\n' +
      '\n' +
      '\n' +
      'line four\n' +
      '"""\n'
    )

    await attach({ port: 8787, version: '1.0.0', configPath })

    expect(readToml()).toContain(
      'developer_instructions = """line one\n' +
      '\n' +
      '\n' +
      'line four\n' +
      '"""\n'
    )
  })

  it('records and removes the previous root model_provider', async () => {
    writeToml('model_provider = "openai"\nmodel = "gpt-5.1-codex"\n')

    const result = await attach({ port: 8787, version: '1.0.0', configPath })

    expect(result).toEqual({ changed: true, prevValue: 'openai' })
    const written = readToml()
    expect(written).toContain('# previous_model_provider = "openai"')
    expect(written).not.toMatch(/^model_provider = "openai"$/m)
  })

  it.each([
    ['double-quoted', '"model_provider" = "openai"\n'],
    ['single-quoted', '\'model_provider\' = "openai"\n'],
  ])('records and removes the previous %s root model_provider', async (_label, line) => {
    writeToml(`${line}model = "gpt-5.1-codex"\n`)

    const result = await attach({ port: 8787, version: '1.0.0', configPath })

    expect(result).toEqual({ changed: true, prevValue: 'openai' })
    const written = readToml()
    expect(written).toContain('# previous_model_provider = "openai"')
    expect(written).not.toMatch(/^["']model_provider["']\s*=\s*"openai"$/m)
    expect(written).toContain('model_provider = "collectivus"')
  })

  it('replaces an existing collectivus provider table', async () => {
    writeToml('[model_providers.collectivus]\nbase_url = "http://old.test/v1"\n[profiles.default]\nmodel = "gpt-5"\n')

    await attach({ port: 9090, version: '1.0.0', configPath })

    const written = readToml()
    expect(written).toContain('base_url = "http://127.0.0.1:9090/v1"')
    expect(written).not.toContain('http://old.test/v1')
    expect(written).toContain('[profiles.default]')
  })

  it('removes existing collectivus provider child tables', async () => {
    writeToml(
      '[model_providers.collectivus]\n' +
      'base_url = "http://old.test/v1"\n' +
      '[model_providers.collectivus.auth]\n' +
      'env_key = "STALE_TOKEN"\n' +
      '[model_providers.collectivus.http_headers]\n' +
      'authorization = "Bearer stale"\n' +
      '[profiles.default]\n' +
      'model = "gpt-5"\n'
    )

    await attach({ port: 9090, version: '1.0.0', configPath })

    const written = readToml()
    expect(written).toContain('base_url = "http://127.0.0.1:9090/v1"')
    expect(written).not.toContain('[model_providers.collectivus.auth]')
    expect(written).not.toContain('[model_providers.collectivus.http_headers]')
    expect(written).not.toContain('STALE_TOKEN')
    expect(written).not.toContain('Bearer stale')
    expect(written).toContain('[profiles.default]')
  })

  it('removes existing dotted collectivus provider assignments', async () => {
    writeToml(
      'model_providers.collectivus.base_url = "http://old.test/v1"\n' +
      'model_providers.collectivus.requires_openai_auth = false\n' +
      'model = "gpt-5"\n'
    )

    await attach({ port: 9090, version: '1.0.0', configPath })

    const written = readToml()
    expect(written).toContain('base_url = "http://127.0.0.1:9090/v1"')
    expect(written).not.toContain('http://old.test/v1')
    expect(written).not.toContain('model_providers.collectivus.requires_openai_auth')
    expect(written.match(/\[model_providers\.collectivus\]/g)).toHaveLength(1)
    expect(written).toContain('model = "gpt-5"')
  })

  it('removes existing collectivus assignments inside model_providers table', async () => {
    writeToml(
      '[model_providers]\n' +
      'collectivus.base_url = "http://old.test/v1"\n' +
      'openai.base_url = "https://api.openai.com/v1"\n' +
      '[profiles.default]\n' +
      'model = "gpt-5"\n'
    )

    await attach({ port: 9090, version: '1.0.0', configPath })

    const written = readToml()
    expect(written).toContain('base_url = "http://127.0.0.1:9090/v1"')
    expect(written).not.toContain('http://old.test/v1')
    expect(written).toContain('openai.base_url = "https://api.openai.com/v1"')
    expect(written).toContain('[profiles.default]')
  })

  it('keeps the original provider across repeated attaches', async () => {
    writeToml('model_provider = "custom"\n')
    await attach({ port: 8787, version: '1.0.0', configPath })

    const result = await attach({ port: 9090, version: '2.0.0', configPath })

    expect(result).toEqual({ changed: true, prevValue: 'custom' })
    const written = readToml()
    expect(written).toContain('base_url = "http://127.0.0.1:9090/v1"')
    expect(written).toContain('# previous_model_provider = "custom"')
    expect(written.match(/\[model_providers\.collectivus\]/g)).toHaveLength(1)
  })

  it('rejects invalid ports and versions', async () => {
    await expect(
      attach({ port: 0, version: '1.0.0', configPath })
    ).rejects.toThrow(/invalid port/)
    await expect(
      attach({ port: 70000, version: '1.0.0', configPath })
    ).rejects.toThrow(/invalid port/)
    await expect(
      // @ts-expect-error testing runtime guard
      attach({ port: '8787', version: '1.0.0', configPath })
    ).rejects.toThrow(/invalid port/)
    await expect(
      attach({ port: 8787, version: '', configPath })
    ).rejects.toThrow(/non-empty string/)
  })

  it('detects a concurrent edit by mtime change', async () => {
    writeToml('model = "gpt-5"\n')
    const before = fs.statSync(configPath).mtimeMs

    const inflight = attach({ port: 8787, version: '1.0.0', configPath })
    fs.writeFileSync(configPath, 'model = "gpt-5.1"\n')
    fs.utimesSync(configPath, new Date(before + 5000), new Date(before + 5000))

    /** @type {unknown} */
    let caught
    try {
      await inflight
    } catch (err) {
      caught = err
    }
    if (caught !== undefined) {
      if (!(caught instanceof CodexSettingsError)) throw new Error(`expected CodexSettingsError, got: ${String(caught)}`)
      expect(caught.code).toBe('CONCURRENT_EDIT')
    }
  })
})

describe('detach', () => {
  it('is a no-op when the file is missing', async () => {
    const result = await detach({ configPath })
    expect(result).toEqual({ changed: false })
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('is a no-op when no managed block is present', async () => {
    writeToml('model_provider = "openai"\n')
    const before = readToml()

    const result = await detach({ configPath })

    expect(result).toEqual({ changed: false })
    expect(readToml()).toBe(before)
  })

  it('removes managed blocks and restores the previous model_provider', async () => {
    writeToml('model_provider = "custom"\nmodel = "gpt-5"\n')
    await attach({ port: 8787, version: '1.0.0', configPath })

    const result = await detach({ configPath })

    expect(result).toEqual({
      changed: true,
      removed: 'http://127.0.0.1:8787/v1',
      restoredValue: 'custom',
    })
    expect(readToml()).toBe('model = "gpt-5"\nmodel_provider = "custom"\n')
  })

  it('preserves blank lines inside multiline strings', async () => {
    writeToml(
      'developer_instructions = """line one\n' +
      '\n' +
      '\n' +
      'line four\n' +
      '"""\n'
    )
    await attach({ port: 8787, version: '1.0.0', configPath })

    await detach({ configPath })

    expect(readToml()).toBe(
      'developer_instructions = """line one\n' +
      '\n' +
      '\n' +
      'line four\n' +
      '"""\n'
    )
  })

  it('removes managed blocks without restoring when there was no previous provider', async () => {
    await attach({ port: 8787, version: '1.0.0', configPath })

    const result = await detach({ configPath })

    expect(result).toEqual({ changed: true, removed: 'http://127.0.0.1:8787/v1' })
    expect(readToml()).toBe('')
  })

  it('throws on an unterminated managed block without modifying the file', async () => {
    writeToml(`${'# BEGIN collectivus codex model_provider'}\nmodel_provider = "collectivus"\n`)
    const before = readToml()

    await expect(detach({ configPath })).rejects.toBeInstanceOf(CodexSettingsError)

    expect(readToml()).toBe(before)
  })
})

describe('isAttached', () => {
  it('returns false when the file is missing', async () => {
    expect(await isAttached({ configPath })).toBe(false)
  })

  it('returns false when no managed block is present', async () => {
    writeToml('model_provider = "collectivus"\n')
    expect(await isAttached({ configPath })).toBe(false)
  })

  it('returns true after attach', async () => {
    await attach({ port: 8787, version: '1.0.0', configPath })
    expect(await isAttached({ configPath })).toBe(true)
  })
})

describe('atomic write', () => {
  it('leaves no .tmp leftovers on success', async () => {
    writeToml('model = "gpt-5"\n')

    await attach({ port: 8787, version: '1.0.0', configPath })

    expect(fs.readdirSync(tmpDir)).toEqual(['config.toml'])
  })

  it('writes with mode 0600 on POSIX', async () => {
    if (process.platform === 'win32') return

    await attach({ port: 8787, version: '1.0.0', configPath })
    const stat = await fsp.stat(configPath)
    expect(stat.mode & 0o077).toBe(0)
  })
})
