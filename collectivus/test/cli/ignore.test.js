import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseIgnoreArgs, runIgnore } from '../../src/cli/ignore.js'

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
/** @type {string} */
let configPath

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-ignore-'))
  configPath = path.join(tmpDir, 'collectivus.json')
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseIgnoreArgs', function() {
  it('returns help when no args are supplied', function() {
    expect(parseIgnoreArgs([])).toEqual({ help: true })
  })

  it('rejects an unknown subcommand', function() {
    expect(parseIgnoreArgs(['nope'])).toMatchObject({ error: expect.stringMatching(/unknown ignore command/) })
  })

  it('requires a path for add/remove', function() {
    expect(parseIgnoreArgs(['add'])).toMatchObject({ error: expect.stringMatching(/requires a path/) })
    expect(parseIgnoreArgs(['remove'])).toMatchObject({ error: expect.stringMatching(/requires a path/) })
  })

  it('rejects extra positional arguments', function() {
    expect(parseIgnoreArgs(['list', 'extra'])).toMatchObject({ error: expect.stringMatching(/unexpected/) })
    expect(parseIgnoreArgs(['add', '/a', '/b'])).toMatchObject({ error: expect.stringMatching(/unexpected/) })
  })

  it('parses add / remove / list', function() {
    expect(parseIgnoreArgs(['list'])).toEqual({ command: 'list' })
    expect(parseIgnoreArgs(['add', '/x'])).toEqual({ command: 'add', path: '/x' })
    expect(parseIgnoreArgs(['remove', '/x'])).toEqual({ command: 'remove', path: '/x' })
  })
})

describe('runIgnore', function() {
  it('adds a path and persists it', async function() {
    const stdout = memo()
    const code = await runIgnore(['add', '.'], {
      stdout,
      stderr: memo(),
      cwd: tmpDir,
      configPath,
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Ignoring/)
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(persisted.ignored_paths).toEqual([fs.realpathSync(tmpDir)])
  })

  it('preserves unrelated keys in collectivus.json', async function() {
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, proxy: { listen: '127.0.0.1:8787' } }))
    await runIgnore(['add', tmpDir], {
      stdout: memo(),
      stderr: memo(),
      configPath,
    })
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(persisted.version).toBe(1)
    expect(persisted.proxy).toEqual({ listen: '127.0.0.1:8787' })
    expect(persisted.ignored_paths).toEqual([fs.realpathSync(tmpDir)])
  })

  it('list prints ignored paths one per line', async function() {
    fs.writeFileSync(configPath, JSON.stringify({ ignored_paths: ['/a', '/b'] }))
    const stdout = memo()
    const code = await runIgnore(['list'], { stdout, stderr: memo(), configPath })
    expect(code).toBe(0)
    expect(stdout.value()).toBe('/a\n/b\n')
  })

  it('remove warns and exits non-zero when the path was not registered', async function() {
    const stderr = memo()
    const code = await runIgnore(['remove', tmpDir], {
      stdout: memo(),
      stderr,
      configPath,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/was not in the ignore list/)
  })

  it('add is idempotent and reports the second call as a no-op', async function() {
    const stdoutA = memo()
    await runIgnore(['add', tmpDir], { stdout: stdoutA, stderr: memo(), configPath })
    expect(stdoutA.value()).toMatch(/Ignoring/)
    const stdoutB = memo()
    await runIgnore(['add', tmpDir], { stdout: stdoutB, stderr: memo(), configPath })
    expect(stdoutB.value()).toMatch(/already ignoring/)
  })
})
