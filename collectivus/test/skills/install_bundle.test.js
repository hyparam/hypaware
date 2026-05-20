import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUNDLED_SKILLS, installSkillBundle } from '../../src/skills/install.js'

/** @type {string} */
let tmpDir
/** @type {string} */
let skillsRoot

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-skill-bundle-'))
  skillsRoot = path.join(tmpDir, 'skills-src')
  for (const skill of BUNDLED_SKILLS) {
    const dir = path.join(skillsRoot, skill.name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skill.name}\n---\n# ${skill.name}\n`)
  }
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('BUNDLED_SKILLS', function() {
  it('includes the three packaged skills with the expected client targets', function() {
    const summary = BUNDLED_SKILLS.map((s) => `${s.name}:${s.clients.join('+')}`)
    expect(summary).toEqual([
      'collectivus-query:claude+codex',
      'ctvs-ignore:claude',
      'ctvs-unignore:claude',
    ])
  })

  it('ships real SKILL.md files for every entry in the package', function() {
    for (const skill of BUNDLED_SKILLS) {
      const onDisk = path.join(process.cwd(), 'skills', skill.name, 'SKILL.md')
      expect(fs.existsSync(onDisk)).toBe(true)
    }
  })
})

describe('installSkillBundle', function() {
  it('installs every Claude skill when client=claude', async function() {
    const homeDir = path.join(tmpDir, 'home')
    const result = await installSkillBundle({ client: 'claude', homeDir, skillsRoot })

    const installed = result.destinations.map((d) => path.basename(d.path))
    expect(installed).toEqual(['collectivus-query', 'ctvs-ignore', 'ctvs-unignore'])
    for (const destination of result.destinations) {
      expect(destination.client).toBe('claude')
      expect(fs.existsSync(path.join(destination.path, 'SKILL.md'))).toBe(true)
    }
  })

  it('only installs collectivus-query when client=codex (the helper skills are Claude-only)', async function() {
    const homeDir = path.join(tmpDir, 'home')
    const codexHome = path.join(tmpDir, 'codex-home')
    const result = await installSkillBundle({ client: 'codex', homeDir, codexHome, skillsRoot })

    const names = new Set(result.destinations.map((d) => path.basename(d.path)))
    expect(names).toEqual(new Set(['collectivus-query']))
    for (const destination of result.destinations) {
      expect(destination.client).toBe('codex')
    }
  })

  it('client=all installs the full matrix', async function() {
    const homeDir = path.join(tmpDir, 'home')
    const codexHome = path.join(tmpDir, 'codex-home')
    const result = await installSkillBundle({ client: 'all', homeDir, codexHome, skillsRoot })

    /** @type {Set<string>} */
    const fingerprints = new Set()
    for (const destination of result.destinations) {
      fingerprints.add(`${destination.client}:${path.basename(destination.path)}`)
    }
    expect(fingerprints).toEqual(new Set([
      'claude:collectivus-query',
      'codex:collectivus-query',
      'claude:ctvs-ignore',
      'claude:ctvs-unignore',
    ]))
  })
})
