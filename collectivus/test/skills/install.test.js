import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SkillInstallError, installSkill, skillDestinations } from '../../src/skills/install.js'

/** @type {string} */
let tmpDir
/** @type {string} */
let sourceDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-skills-'))
  sourceDir = path.join(tmpDir, 'source')
  fs.mkdirSync(path.join(sourceDir, 'references'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '---\nname: collectivus-query\ndescription: Test skill\n---\n\n# Skill\n')
  fs.writeFileSync(path.join(sourceDir, 'references', 'query-cli.md'), '# Query\n')
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('skillDestinations', function() {
  it('returns Claude and both Codex paths for all', function() {
    const homeDir = path.join(tmpDir, 'home')
    const codexHome = path.join(tmpDir, 'codex-home')
    expect(skillDestinations({ client: 'all', homeDir, codexHome })).toEqual([
      { client: 'claude', path: path.join(homeDir, '.claude', 'skills', 'collectivus-query') },
      { client: 'codex', path: path.join(homeDir, '.agents', 'skills', 'collectivus-query') },
      { client: 'codex', path: path.join(codexHome, 'skills', 'collectivus-query') },
    ])
  })

  it('uses ~/.codex when CODEX_HOME is not supplied', function() {
    const homeDir = path.join(tmpDir, 'home')
    expect(skillDestinations({ client: 'codex', homeDir, codexHome: '' })).toEqual([
      { client: 'codex', path: path.join(homeDir, '.agents', 'skills', 'collectivus-query') },
      { client: 'codex', path: path.join(homeDir, '.codex', 'skills', 'collectivus-query') },
    ])
  })

  it('deduplicates overlapping Codex paths', function() {
    const homeDir = path.join(tmpDir, 'home')
    expect(skillDestinations({ client: 'codex', homeDir, codexHome: path.join(homeDir, '.agents') })).toEqual([
      { client: 'codex', path: path.join(homeDir, '.agents', 'skills', 'collectivus-query') },
    ])
  })
})

describe('installSkill', function() {
  it('installs to Claude and both Codex locations', async function() {
    const homeDir = path.join(tmpDir, 'home')
    const codexHome = path.join(tmpDir, 'codex-home')

    const result = await installSkill({ client: 'all', homeDir, codexHome, sourceDir })

    expect(result.destinations.map((d) => d.action)).toEqual(['installed', 'installed', 'installed'])
    for (const destination of result.destinations) {
      expect(fs.readFileSync(path.join(destination.path, 'SKILL.md'), 'utf8')).toMatch(/name: collectivus-query/)
      expect(fs.existsSync(path.join(destination.path, 'references', 'query-cli.md'))).toBe(true)
      expect(JSON.parse(fs.readFileSync(path.join(destination.path, '.collectivus-skill.json'), 'utf8'))).toMatchObject({
        managed_by: 'collectivus',
        skill: 'collectivus-query',
        client: destination.client,
      })
    }
  })

  it('installs the packaged skill with JSONL collection guidance', async function() {
    const homeDir = path.join(tmpDir, 'home')
    const codexHome = path.join(tmpDir, 'codex-home')

    const result = await installSkill({ client: 'all', homeDir, codexHome })

    expect(result.destinations.map((d) => d.action)).toEqual(['installed', 'installed', 'installed'])
    for (const destination of result.destinations) {
      const skill = fs.readFileSync(path.join(destination.path, 'SKILL.md'), 'utf8')
      const reference = fs.readFileSync(path.join(destination.path, 'references', 'query-cli.md'), 'utf8')
      expect(skill).toMatch(/ctvs collect <file\.jsonl> --name <name>/)
      expect(skill).toMatch(/registered collection tables/)
      expect(skill).toMatch(/ctvs query schema <table> --format json/)
      expect(skill).toContain('ctvs query sql \'select * from "random-log"\'')
      expect(skill).toMatch(/Repeat `--date`/)
      expect(reference).toMatch(/External JSONL collections/)
      expect(reference).toMatch(/ctvs query sql "select \* from random_log"/)
      expect(reference).toContain('ctvs query sql \'select * from "random-log"\' --format json')
      expect(reference).toMatch(/ctvs query schema <table> --format json/)
      expect(reference).toMatch(/--date 2026-05-14 --date 2026-05-15/)
    }
  })

  it('updates managed existing installs', async function() {
    const homeDir = path.join(tmpDir, 'home')
    await installSkill({ client: 'claude', homeDir, sourceDir })
    const dest = path.join(homeDir, '.claude', 'skills', 'collectivus-query')
    fs.writeFileSync(path.join(dest, 'stale.txt'), 'old')

    const result = await installSkill({ client: 'claude', homeDir, sourceDir })

    expect(result.destinations).toEqual([{ client: 'claude', path: dest, action: 'updated' }])
    expect(fs.existsSync(path.join(dest, 'stale.txt'))).toBe(false)
  })

  it('refuses unmanaged existing directories without force', async function() {
    const homeDir = path.join(tmpDir, 'home')
    const dest = path.join(homeDir, '.claude', 'skills', 'collectivus-query')
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), 'custom')

    await expect(
      installSkill({ client: 'claude', homeDir, sourceDir })
    ).rejects.toMatchObject({ code: 'EEXIST', path: dest })
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('custom')
  })

  it('overwrites unmanaged directories with force', async function() {
    const homeDir = path.join(tmpDir, 'home')
    const dest = path.join(homeDir, '.claude', 'skills', 'collectivus-query')
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), 'custom')

    const result = await installSkill({ client: 'claude', homeDir, sourceDir, force: true })

    expect(result.destinations).toEqual([{ client: 'claude', path: dest, action: 'updated' }])
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toMatch(/name: collectivus-query/)
  })

  it('dry-runs without writing or enforcing collisions', async function() {
    const homeDir = path.join(tmpDir, 'home')
    const dest = path.join(homeDir, '.claude', 'skills', 'collectivus-query')
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), 'custom')

    const result = await installSkill({ client: 'claude', homeDir, sourceDir, dryRun: true })

    expect(result.destinations).toEqual([{ client: 'claude', path: dest, action: 'would-update' }])
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('custom')
    expect(fs.existsSync(path.join(dest, '.collectivus-skill.json'))).toBe(false)
  })

  it('validates client and source', async function() {
    await expect(
      // @ts-expect-error testing runtime guard
      installSkill({ client: 'zed', sourceDir })
    ).rejects.toBeInstanceOf(SkillInstallError)

    await expect(
      installSkill({ client: 'claude', sourceDir: path.join(tmpDir, 'missing') })
    ).rejects.toMatchObject({ code: 'MISSING_SOURCE' })
  })
})
