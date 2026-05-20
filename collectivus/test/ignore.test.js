import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  IgnoreFilter,
  defaultIgnoreConfigPath,
  findCtvsIgnoreMarker,
  normalizeIgnorePath,
} from '../src/ignore.js'

/** @type {string} */
let tmpDir
/** @type {string} */
let configPath

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-ignore-'))
  configPath = path.join(tmpDir, 'collectivus.json')
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('normalizeIgnorePath', function() {
  it('makes relative paths absolute against the supplied cwd', function() {
    const abs = normalizeIgnorePath('sub', { cwd: tmpDir })
    expect(abs).toBe(path.join(fs.realpathSync(tmpDir), 'sub'))
  })

  it('strips trailing separators', function() {
    fs.mkdirSync(path.join(tmpDir, 'with-trailing'))
    const abs = normalizeIgnorePath(path.join(tmpDir, 'with-trailing') + path.sep)
    expect(abs).toBe(fs.realpathSync(path.join(tmpDir, 'with-trailing')))
  })

  it('resolves symlinks via realpath when the target exists', function() {
    const real = path.join(tmpDir, 'real')
    const link = path.join(tmpDir, 'link')
    fs.mkdirSync(real)
    fs.symlinkSync(real, link)
    expect(normalizeIgnorePath(link)).toBe(fs.realpathSync(real))
  })

  it('accepts a path that does not yet exist', function() {
    const missing = path.join(tmpDir, 'does', 'not', 'exist')
    // The leaf does not exist so realpath can't resolve it, but the deepest
    // existing ancestor (tmpDir) is canonicalized — so the result lives under
    // realpath(tmpDir), not the raw `/var/...` symlink path.
    expect(normalizeIgnorePath(missing))
      .toBe(path.join(fs.realpathSync(tmpDir), 'does', 'not', 'exist'))
  })

  it('rejects empty input', function() {
    expect(() => normalizeIgnorePath('')).toThrow(/non-empty/)
  })

  it('collapses `..` segments via path.resolve before realpath', function() {
    const real = fs.realpathSync(tmpDir)
    fs.mkdirSync(path.join(tmpDir, 'a'))
    fs.mkdirSync(path.join(tmpDir, 'b'))
    expect(normalizeIgnorePath(path.join(tmpDir, 'a', '..', 'b'))).toBe(path.join(real, 'b'))
  })

  it('resolves a symlinked ancestor to its canonical form', function() {
    const real = path.join(tmpDir, 'real')
    const link = path.join(tmpDir, 'link')
    fs.mkdirSync(path.join(real, 'inner'), { recursive: true })
    fs.symlinkSync(real, link)
    // Querying via the symlink should canonicalize to the real path.
    expect(normalizeIgnorePath(path.join(link, 'inner'))).toBe(
      path.join(fs.realpathSync(real), 'inner')
    )
  })
})

describe('defaultIgnoreConfigPath', function() {
  it('lives under ~/.hyp/collectivus.json', function() {
    expect(defaultIgnoreConfigPath('/Users/test')).toBe('/Users/test/.hyp/collectivus.json')
  })
})

describe('findCtvsIgnoreMarker', function() {
  it('returns the ancestor directory holding .ctvsignore', function() {
    const ignoreDir = path.join(tmpDir, 'project')
    fs.mkdirSync(path.join(ignoreDir, 'deep', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(ignoreDir, '.ctvsignore'), '')
    expect(findCtvsIgnoreMarker(path.join(ignoreDir, 'deep', 'nested'))).toBe(ignoreDir)
  })

  it('returns undefined when no ancestor carries a marker', function() {
    fs.mkdirSync(path.join(tmpDir, 'clean'))
    expect(findCtvsIgnoreMarker(path.join(tmpDir, 'clean'))).toBeUndefined()
  })

  it('ignores directories named .ctvsignore that are not files', function() {
    const here = path.join(tmpDir, 'project')
    fs.mkdirSync(path.join(here, '.ctvsignore'), { recursive: true })
    expect(findCtvsIgnoreMarker(here)).toBeUndefined()
  })
})

describe('IgnoreFilter — paths', function() {
  it('loads ignored_paths from collectivus.json on construction', async function() {
    fs.writeFileSync(configPath, JSON.stringify({ ignored_paths: ['/a', '/b'] }))
    const f = new IgnoreFilter({ configPath })
    await f.load()
    expect(f.listPaths()).toEqual(['/a', '/b'])
  })

  it('tolerates a missing config file', async function() {
    const f = new IgnoreFilter({ configPath: path.join(tmpDir, 'missing.json') })
    await f.load()
    expect(f.listPaths()).toEqual([])
  })

  it('tolerates malformed JSON with a stderr warning', async function() {
    fs.writeFileSync(configPath, '{not json}')
    /** @type {string[]} */
    const stderrChunks = []
    const f = new IgnoreFilter({ configPath })
    await f.load({ stderr: { write: (s) => { stderrChunks.push(s) } } })
    expect(f.listPaths()).toEqual([])
    expect(stderrChunks.join('')).toMatch(/not valid JSON/)
  })

  it('persists paths back to disk and preserves unrelated keys', async function() {
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, ignored_paths: ['/old'] }))
    const f = new IgnoreFilter({ configPath })
    await f.load()
    await f.removePath('/old')
    await f.addPath(path.join(tmpDir, 'project'))
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(persisted.version).toBe(1)
    expect(persisted.ignored_paths).toEqual([path.join(tmpDir, 'project')])
  })

  it('add is idempotent', async function() {
    const f = new IgnoreFilter({ configPath })
    await f.load()
    expect((await f.addPath('/x')).added).toBe(true)
    expect((await f.addPath('/x')).added).toBe(false)
    expect(f.listPaths()).toEqual(['/x'])
  })

  it('matches a cwd that lives under an ignored ancestor', async function() {
    const f = new IgnoreFilter({ configPath })
    await f.load()
    await f.addPath(path.join(tmpDir, 'project'))
    expect(f.shouldDrop({ cwd: path.join(tmpDir, 'project') })).toBe(true)
    expect(f.shouldDrop({ cwd: path.join(tmpDir, 'project', 'src') })).toBe(true)
    expect(f.shouldDrop({ cwd: path.join(tmpDir, 'elsewhere') })).toBe(false)
  })

  it('does not match a prefix sibling without a separator boundary', async function() {
    const f = new IgnoreFilter({ configPath })
    await f.load()
    await f.addPath('/work/proj')
    // `/work/project` shares a prefix but is not a descendant of `/work/proj`.
    expect(f.shouldDrop({ cwd: '/work/project' })).toBe(false)
    expect(f.shouldDrop({ cwd: '/work/proj/src' })).toBe(true)
  })
})

describe('IgnoreFilter — sessions', function() {
  it('rejects empty session ids', function() {
    const f = new IgnoreFilter({ configPath })
    expect(() => f.addIgnoredSession('')).toThrow(/non-empty/)
  })

  it('reports running totals', function() {
    const f = new IgnoreFilter({ configPath })
    expect(f.addIgnoredSession('a').total).toBe(1)
    expect(f.addIgnoredSession('b').total).toBe(2)
    expect(f.removeIgnoredSession('a').total).toBe(1)
    expect(f.removeIgnoredSession('missing')).toEqual({ removed: false, total: 1 })
  })

  it('evicts the oldest session when capacity is exceeded (FIFO)', function() {
    const f = new IgnoreFilter({ configPath, maxIgnoredSessions: 3 })
    f.addIgnoredSession('a')
    f.addIgnoredSession('b')
    f.addIgnoredSession('c')
    f.addIgnoredSession('d')
    expect(f.listIgnoredSessions()).toEqual(['b', 'c', 'd'])
    expect(f.hasIgnoredSession('a')).toBe(false)
  })

  it('re-adding a session refreshes its FIFO position', function() {
    const f = new IgnoreFilter({ configPath, maxIgnoredSessions: 3 })
    f.addIgnoredSession('a')
    f.addIgnoredSession('b')
    f.addIgnoredSession('a')
    f.addIgnoredSession('c')
    f.addIgnoredSession('d')
    // Without re-promotion 'a' would have been evicted; with re-promotion 'b' is the oldest.
    expect(f.listIgnoredSessions()).toEqual(['a', 'c', 'd'])
  })
})

describe('IgnoreFilter — precedence', function() {
  it('temporary session beats persistent path which beats .ctvsignore', async function() {
    const project = path.join(tmpDir, 'project')
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(project, '.ctvsignore'), '')

    const f = new IgnoreFilter({ configPath })
    await f.load()

    // .ctvsignore only
    expect(f.evaluate({ cwd: project })).toEqual({
      drop: true, reason: 'ctvsignore', match: project,
    })

    // Add a persistent path — path wins over .ctvsignore for the same cwd.
    await f.addPath(project)
    expect(f.evaluate({ cwd: project })).toEqual({
      drop: true, reason: 'path', match: project,
    })

    // Add an ignored session — session wins over path.
    f.addIgnoredSession('sess-1')
    expect(f.evaluate({ sessionId: 'sess-1', cwd: project })).toEqual({
      drop: true, reason: 'session', match: 'sess-1',
    })
  })

  it('falls through to "record" when no rule matches', function() {
    const f = new IgnoreFilter({ configPath })
    expect(f.evaluate({ sessionId: 'unknown', cwd: '/nowhere' })).toEqual({ drop: false })
  })
})

describe('IgnoreFilter — .ctvsignore cache', function() {
  it('re-resolves when conversationId changes', function() {
    const project = path.join(tmpDir, 'project')
    const sub = path.join(project, 'sub')
    fs.mkdirSync(sub, { recursive: true })

    const f = new IgnoreFilter({ configPath })
    // First lookup: no marker, populates cache.
    expect(f.shouldDrop({ cwd: sub, conversationId: 'conv-a' })).toBe(false)
    // Add the marker after the cache was populated.
    fs.writeFileSync(path.join(project, '.ctvsignore'), '')
    // Same conversation — cache returns the stale "no marker" result.
    expect(f.shouldDrop({ cwd: sub, conversationId: 'conv-a' })).toBe(false)
    // Fresh conversation — cache invalidates per-cwd and we hit the new marker.
    expect(f.shouldDrop({ cwd: sub, conversationId: 'conv-b' })).toBe(true)
  })

  it('honors invalidateCtvsignoreCache for the same conversation', function() {
    const project = path.join(tmpDir, 'project')
    const sub = path.join(project, 'sub')
    fs.mkdirSync(sub, { recursive: true })

    const f = new IgnoreFilter({ configPath })
    expect(f.shouldDrop({ cwd: sub, conversationId: 'conv-a' })).toBe(false)
    fs.writeFileSync(path.join(project, '.ctvsignore'), '')
    f.invalidateCtvsignoreCache(sub)
    expect(f.shouldDrop({ cwd: sub, conversationId: 'conv-a' })).toBe(true)
  })
})
