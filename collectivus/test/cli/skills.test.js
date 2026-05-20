import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSkillsArgs, runSkills } from '../../src/cli/skills.js'

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-skills-cli-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseSkillsArgs', function() {
  it('shows help when no command is provided', function() {
    expect(parseSkillsArgs([])).toMatchObject({ help: true })
  })

  it('parses install defaults', function() {
    expect(parseSkillsArgs(['install'])).toMatchObject({
      command: 'install', client: 'all', force: false, dryRun: false, help: false,
    })
  })

  it('parses flags', function() {
    expect(parseSkillsArgs(['install', '--client', 'claude', '--force', '--dry-run'])).toMatchObject({
      client: 'claude', force: true, dryRun: true,
    })
    expect(parseSkillsArgs(['install', '--client=codex'])).toMatchObject({ client: 'codex' })
  })

  it('rejects invalid commands and clients', function() {
    expect(parseSkillsArgs(['remove']).error).toMatch(/unknown skills command/)
    expect(parseSkillsArgs(['install', '--client', 'zed']).error).toMatch(/expected claude, codex, or all/)
    expect(parseSkillsArgs(['install', '--mystery']).error).toMatch(/unknown argument/)
  })
})

describe('runSkills', function() {
  it('prints help', async function() {
    const stdout = memo()
    const code = await runSkills(['--help'], { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on parse errors', async function() {
    const stderr = memo()
    const code = await runSkills(['install', '--client', 'zed'], { stdout: memo(), stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/expected claude, codex, or all/)
  })

  it('installs all clients by default', async function() {
    const stdout = memo()
    /** @type {object[]} */
    const calls = []
    const code = await runSkills(['install'], {
      stdout,
      stderr: memo(),
      homeDir: tmpDir,
      codexHome: path.join(tmpDir, 'codex-home'),
      sourceDir: path.join(tmpDir, 'source'),
      installSkill(opts) {
        calls.push(opts)
        return Promise.resolve({
          destinations: [
            { client: 'claude', path: path.join(tmpDir, '.claude', 'skills', 'collectivus-query'), action: 'installed' },
            { client: 'codex', path: path.join(tmpDir, '.agents', 'skills', 'collectivus-query'), action: 'installed' },
            { client: 'codex', path: path.join(tmpDir, 'codex-home', 'skills', 'collectivus-query'), action: 'installed' },
          ],
        })
      },
    })
    expect(code).toBe(0)
    expect(calls).toEqual([{
      client: 'all',
      force: false,
      dryRun: false,
      homeDir: tmpDir,
      codexHome: path.join(tmpDir, 'codex-home'),
      sourceDir: path.join(tmpDir, 'source'),
    }])
    expect(stdout.value()).toMatch(/Installed Claude Code skill/)
    expect(stdout.value()).toMatch(/Installed Codex skill/)
  })

  it('passes client, force, and dry-run flags', async function() {
    /** @type {object[]} */
    const calls = []
    const code = await runSkills(['install', '--client', 'codex', '--force', '--dry-run'], {
      stdout: memo(),
      stderr: memo(),
      installSkill(opts) {
        calls.push(opts)
        return Promise.resolve({
          destinations: [{ client: 'codex', path: '/tmp/codex/skills/collectivus-query', action: 'would-update' }],
        })
      },
    })
    expect(code).toBe(0)
    expect(calls[0]).toMatchObject({ client: 'codex', force: true, dryRun: true })
  })

  it('reports install failures', async function() {
    const stderr = memo()
    const code = await runSkills(['install'], {
      stdout: memo(),
      stderr,
      installSkill() { return Promise.reject(new Error('collision')) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to install.*collision/)
  })
})
