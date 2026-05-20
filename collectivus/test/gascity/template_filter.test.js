import { describe, expect, it } from 'vitest'
import { compileFilter, globToRegex } from '../../src/gascity/template_filter.js'

describe('globToRegex', () => {
  it('matches an exact string', () => {
    const re = globToRegex('desktop/refinery')
    expect(re.test('desktop/refinery')).toBe(true)
    expect(re.test('desktop/refinery.extra')).toBe(false)
    expect(re.test('other/desktop/refinery')).toBe(false)
  })

  it('matches `**` against any sequence including slashes', () => {
    const re = globToRegex('**')
    expect(re.test('')).toBe(true)
    expect(re.test('a/b/c/d')).toBe(true)
  })

  it('matches `*` against a single segment', () => {
    const re = globToRegex('desktop/*')
    expect(re.test('desktop/refinery')).toBe(true)
    expect(re.test('desktop/witness')).toBe(true)
    expect(re.test('desktop/sub/refinery')).toBe(false)
  })

  it('escapes regex meta characters in literal text', () => {
    const re = globToRegex('a+b.c(d)')
    expect(re.test('a+b.c(d)')).toBe(true)
    expect(re.test('a-b-c-d')).toBe(false)
  })

  it('matches `?` against one non-slash character', () => {
    const re = globToRegex('rig-?')
    expect(re.test('rig-a')).toBe(true)
    expect(re.test('rig-/')).toBe(false)
    expect(re.test('rig-ab')).toBe(false)
  })
})

describe('compileFilter', () => {
  it('captures everything when both lists are omitted', () => {
    const matches = compileFilter(undefined, undefined)
    expect(matches('anything')).toBe(true)
    expect(matches('')).toBe(true)
    expect(matches(undefined)).toBe(true)
  })

  it('treats an empty include list as the default capture-all', () => {
    const matches = compileFilter([], [])
    expect(matches('desktop/refinery')).toBe(true)
  })

  it('captures only templates matching at least one include pattern', () => {
    const matches = compileFilter(['desktop/*'], [])
    expect(matches('desktop/refinery')).toBe(true)
    expect(matches('desktop/witness')).toBe(true)
    expect(matches('mobile/foo')).toBe(false)
  })

  it('drops templates matched by an exclude pattern even when include matches', () => {
    const matches = compileFilter(['**'], ['desktop/witness'])
    expect(matches('desktop/refinery')).toBe(true)
    expect(matches('desktop/witness')).toBe(false)
  })

  it('falls through to false when no include pattern matches a non-empty template', () => {
    const matches = compileFilter(['desktop/*'], [])
    expect(matches('mobile/refinery')).toBe(false)
  })
})
