import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import packageJson from '../package.json' with { type: 'json' }

describe('package.json', () => {
  it('should have the correct name', () => {
    expect(packageJson.name).toBe('collectivus')
  })
  it('should have a valid version', () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
  it('should have MIT license', () => {
    expect(packageJson.license).toBe('MIT')
  })
  it('should have precise dependency versions', () => {
    const { dependencies, devDependencies } = packageJson
    Object.values({ ...dependencies, ...devDependencies }).forEach(version => {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    })
  })
  it('exposes ctvs and collectivus binaries', () => {
    expect(packageJson.bin).toMatchObject({
      ctvs: 'bin/cli.js',
      collectivus: 'bin/cli.js',
    })
  })
  it('should have direct query dependencies', () => {
    expect(packageJson.dependencies).toMatchObject({
      hyparquet: '1.25.8',
      'hyparquet-compressors': '1.1.1',
      icebird: '0.7.0',
      squirreling: '0.12.19',
    })
  })
  it('ships the bundled Collectivus query skill', () => {
    expect(packageJson.files).toContain('skills')
    const skillPath = fileURLToPath(new URL('../skills/collectivus-query/SKILL.md', import.meta.url))
    const referencePath = fileURLToPath(new URL('../skills/collectivus-query/references/query-cli.md', import.meta.url))
    expect(fs.readFileSync(skillPath, 'utf8')).toMatch(/name: collectivus-query/)
    expect(fs.readFileSync(referencePath, 'utf8')).toMatch(/ctvs query/)
  })
})
