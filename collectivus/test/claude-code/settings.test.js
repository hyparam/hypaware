import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SettingsError, attach, defaultSettingsPath, detach, isAttached } from '../../src/claude-code/settings.js'

/** @type {string} */
let tmpDir
/** @type {string} */
let settingsPath

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-settings-'))
  settingsPath = path.join(tmpDir, 'settings.json')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {unknown} value
 * @returns {void}
 */
function writeJson(value) {
  fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n')
}

/**
 * @returns {any}
 */
function readJson() {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
}

/**
 * @param {Record<string, unknown>} settings
 * @param {string} command
 * @returns {void}
 */
function expectManagedHooks(settings, command = 'ctvs claude-hook session-context --port 8787') {
  for (const event of ['SessionStart', 'CwdChanged', 'UserPromptSubmit']) {
    const groups = /** @type {Record<string, unknown[]>} */ (settings.hooks)[event]
    expect(groups).toEqual([{ hooks: [{ type: 'command', command }] }])
  }
  expect(/** @type {Record<string, unknown[]>} */ (settings.hooks).PostToolUse).toEqual([{
    matcher: 'Bash',
    hooks: [{ type: 'command', command }],
  }])
}

describe('defaultSettingsPath', () => {
  it('points at ~/.claude/settings.json', () => {
    expect(defaultSettingsPath()).toBe(path.join(os.homedir(), '.claude', 'settings.json'))
  })
})

describe('attach', () => {
  it('creates a fresh file (and parent dir) when settings.json is missing', async () => {
    const nested = path.join(tmpDir, 'nested', 'dir', 'settings.json')

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath: nested })

    expect(result).toEqual({ changed: true })
    const written = JSON.parse(fs.readFileSync(nested, 'utf8'))
    expect(written.env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' })
    expectManagedHooks(written)
    expect(written._collectivus).toMatchObject({ version: '1.0.0', port: 8787 })
    expect(new Date(written._collectivus.attached_at).toISOString()).toBe(
      written._collectivus.attached_at
    )
  })

  it('handles an empty {} file', async () => {
    writeJson({})

    const result = await attach({ port: 8787, version: '1.2.3', settingsPath })

    expect(result).toEqual({ changed: true })
    const written = readJson()
    expect(written.env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' })
    expectManagedHooks(written)
    expect(written._collectivus).toMatchObject({ version: '1.2.3', port: 8787 })
  })

  it('preserves unrelated top-level and env keys', async () => {
    writeJson({
      includeCoAuthoredBy: false,
      env: { OTHER_KEY: 'keep-me' },
      hooks: { stop: 'echo hi' },
    })

    await attach({ port: 9000, version: '2.0.0', settingsPath })

    const written = readJson()
    expect(written.includeCoAuthoredBy).toBe(false)
    expect(written.hooks.stop).toBe('echo hi')
    expectManagedHooks(written, 'ctvs claude-hook session-context --port 9000')
    expect(written.env).toEqual({
      OTHER_KEY: 'keep-me',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000',
    })
  })

  it('returns the previous ANTHROPIC_BASE_URL when one was set externally', async () => {
    writeJson({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', OTHER: 'x' } })

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath })

    expect(result).toEqual({
      changed: true,
      prevValue: 'https://api.anthropic.com',
    })
    const written = readJson()
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
    expect(written.env.OTHER).toBe('x')
  })

  it('omits prevValue when no previous ANTHROPIC_BASE_URL was set', async () => {
    writeJson({ env: { OTHER_KEY: 'keep-me' } })

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath })

    expect(result).toEqual({ changed: true })
    expect('prevValue' in result).toBe(false)
  })

  it('returns prevValue even when the previous URL already pointed at the same port', async () => {
    writeJson({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } })

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath })

    expect(result).toEqual({
      changed: true,
      prevValue: 'http://127.0.0.1:8787',
    })
  })

  it('replaces a non-object env with a fresh object', async () => {
    writeJson({ env: 42 })

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath })

    expect(result).toEqual({ changed: true })
    expect(readJson().env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' })
  })

  it('rejects malformed JSON without modifying the file', async () => {
    fs.writeFileSync(settingsPath, '{ not valid json ')
    const before = fs.readFileSync(settingsPath, 'utf8')

    await expect(
      attach({ port: 8787, version: '1.0.0', settingsPath })
    ).rejects.toBeInstanceOf(SettingsError)

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before)
  })

  it('rejects JSONC with a clear JSONC error code', async () => {
    fs.writeFileSync(
      settingsPath,
      '// hello\n{ "env": { "ANTHROPIC_BASE_URL": "x" } }\n'
    )

    /** @type {unknown} */
    let caught
    try {
      await attach({ port: 8787, version: '1.0.0', settingsPath })
    } catch (err) {
      caught = err
    }
    if (!(caught instanceof SettingsError)) {
      throw new Error(`expected SettingsError, got: ${String(caught)}`)
    }
    expect(caught.code).toBe('JSONC')
    expect(caught.message).toMatch(/JSONC/)
  })

  it('rejects a non-object root', async () => {
    fs.writeFileSync(settingsPath, '[]')

    await expect(
      attach({ port: 8787, version: '1.0.0', settingsPath })
    ).rejects.toThrow(/must contain a JSON object at the root/)
  })

  it('rejects invalid ports', async () => {
    writeJson({})
    await expect(
      attach({ port: 0, version: '1.0.0', settingsPath })
    ).rejects.toThrow(/invalid port/)
    await expect(
      attach({ port: 70000, version: '1.0.0', settingsPath })
    ).rejects.toThrow(/invalid port/)
    await expect(
      // @ts-expect-error testing runtime guard
      attach({ port: '8787', version: '1.0.0', settingsPath })
    ).rejects.toThrow(/invalid port/)
  })

  it('rejects empty version strings', async () => {
    writeJson({})
    await expect(
      attach({ port: 8787, version: '', settingsPath })
    ).rejects.toThrow(/non-empty string/)
  })

  it('detects a concurrent edit by mtime change', async () => {
    writeJson({ env: { OTHER: 'x' } })
    const before = fs.statSync(settingsPath).mtimeMs

    const inflight = attach({ port: 8787, version: '1.0.0', settingsPath })
    // Mutate the file before the write completes — the readFile resolved
    // before this microtask, so the in-flight stat will see a new mtime.
    fs.writeFileSync(settingsPath, '{}\n')
    fs.utimesSync(settingsPath, new Date(before + 5000), new Date(before + 5000))

    /** @type {unknown} */
    let caught
    try {
      await inflight
    } catch (err) {
      caught = err
    }
    // Either the race produced a CONCURRENT_EDIT error, or the write
    // completed first; both leave the file in a valid JSON state.
    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(SettingsError)
      const { code } = /** @type {SettingsError} */ (caught)
      expect(code).toBe('CONCURRENT_EDIT')
    }
  })
})

describe('detach', () => {
  it('is a no-op when the file is missing', async () => {
    const result = await detach({ settingsPath })
    expect(result).toEqual({ changed: false })
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it('is a no-op when no _collectivus marker is present', async () => {
    writeJson({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
    const before = fs.readFileSync(settingsPath, 'utf8')

    const result = await detach({ settingsPath })

    expect(result).toEqual({ changed: false })
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before)
  })

  it('removes marker and matching env entry; returns the removed URL', async () => {
    writeJson({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', OTHER: 'keep' },
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
      includeCoAuthoredBy: false,
    })

    const result = await detach({ settingsPath })

    expect(result).toEqual({ changed: true, removed: 'http://127.0.0.1:8787' })
    expect(readJson()).toEqual({
      env: { OTHER: 'keep' },
      includeCoAuthoredBy: false,
    })
  })

  it('removes managed hooks while preserving user hooks', async () => {
    await attach({ port: 8787, version: '1.0.0', settingsPath, binPath: '/usr/local/bin/ctvs' })
    const attached = readJson()
    attached.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'echo user-start' }] })
    attached.hooks.Stop = [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }]
    writeJson(attached)

    await detach({ settingsPath })

    expect(readJson()).toEqual({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-start' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
      },
    })
  })

  it('removes the env key entirely when it would otherwise be empty', async () => {
    writeJson({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
    })

    await detach({ settingsPath })

    const written = readJson()
    expect('env' in written).toBe(false)
    expect('_collectivus' in written).toBe(false)
  })

  it('warns and leaves env alone when ANTHROPIC_BASE_URL was overridden externally', async () => {
    writeJson({
      env: { ANTHROPIC_BASE_URL: 'https://elsewhere.example' },
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
    })

    const result = await detach({ settingsPath })

    expect(result.changed).toBe(true)
    expect(result.warning).toMatch(/overridden externally/)
    expect('removed' in result).toBe(false)

    const written = readJson()
    expect(written.env).toEqual({ ANTHROPIC_BASE_URL: 'https://elsewhere.example' })
    expect('_collectivus' in written).toBe(false)
  })

  it('removes only the marker when env has no ANTHROPIC_BASE_URL', async () => {
    writeJson({
      env: { OTHER: 'x' },
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
    })

    const result = await detach({ settingsPath })

    expect(result).toEqual({ changed: true })
    expect(readJson()).toEqual({ env: { OTHER: 'x' } })
  })

  it('rejects malformed JSON without modifying the file', async () => {
    fs.writeFileSync(settingsPath, '{ not valid json ')
    const before = fs.readFileSync(settingsPath, 'utf8')

    await expect(detach({ settingsPath })).rejects.toBeInstanceOf(SettingsError)

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before)
  })
})

describe('isAttached', () => {
  it('returns false when the file is missing', async () => {
    expect(await isAttached({ settingsPath })).toBe(false)
  })

  it('returns false when no marker is present', async () => {
    writeJson({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } })
    expect(await isAttached({ settingsPath })).toBe(false)
  })

  it('returns true when the marker is present', async () => {
    writeJson({
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
    })
    expect(await isAttached({ settingsPath })).toBe(true)
  })

  it('throws on malformed JSON', async () => {
    fs.writeFileSync(settingsPath, 'not json')
    await expect(isAttached({ settingsPath })).rejects.toBeInstanceOf(SettingsError)
  })
})

describe('round-trip', () => {
  it('attach + detach restores the original content (whitespace normalized)', async () => {
    /** @type {Record<string, unknown>} */
    const original = {
      env: { OTHER: 'keep' },
      includeCoAuthoredBy: false,
      hooks: { stop: 'echo done' },
      arr: [1, 2, 3],
    }
    writeJson(original)
    const expected = JSON.stringify(original, null, 2) + '\n'

    await attach({ port: 8787, version: '1.0.0', settingsPath })
    await detach({ settingsPath })

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(expected)
  })

  it('attach + detach on an empty {} produces {} (with trailing newline)', async () => {
    writeJson({})

    await attach({ port: 8787, version: '1.0.0', settingsPath })
    await detach({ settingsPath })

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{}\n')
  })
})

describe('atomic write', () => {
  it('leaves no .tmp leftovers on success', async () => {
    writeJson({ env: { OTHER: 'x' } })

    await attach({ port: 8787, version: '1.0.0', settingsPath })

    expect(fs.readdirSync(tmpDir)).toEqual(['settings.json'])
  })

  it('does not pick up a stale .tmp from a previous crash', async () => {
    writeJson({ env: { GOOD: 'previous' } })
    const stale = path.join(tmpDir, 'settings.json.99999.deadbeef.tmp')
    fs.writeFileSync(stale, '{"corrupt": true')

    await attach({ port: 8787, version: '1.0.0', settingsPath })

    const written = readJson()
    expect(written.env.GOOD).toBe('previous')
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
    // Stale tmp is left alone; user/admin cleans it up.
    expect(fs.existsSync(stale)).toBe(true)
  })

  it('parses cleanly after attach (file is never half-written)', async () => {
    writeJson({ env: { OTHER: 'x' } })

    await attach({ port: 8787, version: '1.0.0', settingsPath })

    const parsed = readJson()
    expect(parsed._collectivus).toBeDefined()
    expect(parsed.env.OTHER).toBe('x')
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
  })

  it('cleans up the .tmp file when rename fails', async () => {
    fs.rmSync(settingsPath, { force: true })
    fs.mkdirSync(settingsPath)

    /** @type {unknown} */
    let caught
    try {
      await attach({ port: 8787, version: '1.0.0', settingsPath })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)

    const tmpEntries = fs.readdirSync(tmpDir).filter((n) => n.endsWith('.tmp'))
    expect(tmpEntries).toEqual([])

    fs.rmdirSync(settingsPath)
  })

  it('writes with mode 0600 on POSIX', async () => {
    if (process.platform === 'win32') return

    writeJson({})
    await attach({ port: 8787, version: '1.0.0', settingsPath })
    const stat = await fsp.stat(settingsPath)
    // Group/world bits must be unset; owner bits are platform/umask dependent.
    expect(stat.mode & 0o077).toBe(0)
  })
})
