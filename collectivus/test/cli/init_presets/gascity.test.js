import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInitSubcommand } from '../../../src/cli/init.js'
import { runQuery } from '../../../src/cli/query.js'

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
let gcRoot
/** @type {string} */
let sinkDir
/** @type {string} */
let configPath

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctvs-gascity-preset-'))
  gcRoot = path.join(tmpDir, 'hyptown')
  sinkDir = path.join(tmpDir, 'sink')
  configPath = path.join(tmpDir, 'config.json')
  fs.mkdirSync(path.join(gcRoot, '.gc', 'runtime', 'session-reconciler-trace', 'segments', '2026', '05', '14'), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    sink: { type: 'file', dir: sinkDir },
    query: { cache: { enabled: true } },
  }))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeEvents() {
  fs.writeFileSync(path.join(gcRoot, '.gc', 'events.jsonl'),
    [
      { seq: 1, type: 'bead.created', ts: '2026-05-14T00:00:00.000Z', actor: 'hypcity-overrides.boot', subject: 'hy-1' },
      { seq: 2, type: 'order.fired', ts: '2026-05-14T00:01:00.000Z', actor: 'hypcity-overrides.mayor', subject: 'hy-2' },
      { seq: 3, type: 'bead.closed', ts: '2026-05-14T00:02:00.000Z', actor: 'hypcity-overrides.mayor', subject: 'hy-1' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n')
}

/**
 * @param {string} name
 * @param {Record<string, unknown>[]} rows
 */
function writeSegment(name, rows) {
  fs.writeFileSync(
    path.join(gcRoot, '.gc', 'runtime', 'session-reconciler-trace', 'segments', '2026', '05', '14', name),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

describe('ctvs init gascity', function() {
  it('registers events + session_segments and writes the project-local skill', async function() {
    writeEvents()
    writeSegment('segment-000001.jsonl', [
      { ts: '2026-05-14T00:00:00.000Z', template: 'hypcity-overrides.mayor', fields: { sleep_reason: '', state: 'awake' } },
      { ts: '2026-05-14T00:00:30.000Z', template: 'collectivus/hypcity-overrides.polecat', fields: { state: 'idle' } },
    ])
    writeSegment('segment-000002.jsonl', [
      { ts: '2026-05-14T00:01:00.000Z', template: 'hypcity-overrides.mayor', fields: { sleep_reason: 'no_work', state: 'asleep' } },
    ])

    const stdout = memo()
    const stderr = memo()
    const code = await runInitSubcommand(['gascity', '--cwd', gcRoot, '--config', configPath], { stdout, stderr })
    expect(stderr.value()).toBe('')
    expect(code).toBe(0)

    expect(stdout.value()).toMatch(/events:.*3 row/)
    expect(stdout.value()).toMatch(/session_segments:.*3 row/)

    const skillPath = path.join(gcRoot, '.claude', 'skills', 'ctvs-gascity', 'SKILL.md')
    expect(fs.existsSync(skillPath)).toBe(true)
    const skillBody = fs.readFileSync(skillPath, 'utf8')
    expect(skillBody).toMatch(/name: ctvs-gascity/)
    expect(skillBody).toMatch(/events\.actor/)
    expect(skillBody).toMatch(/session_segments\.template/)

    const manifestPath = path.join(sinkDir, '.collectivus-query', 'collections.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(manifest.version).toBe(2)
    expect(manifest.collections.events.source_path).toBe(path.join(gcRoot, '.gc', 'events.jsonl'))
    expect(manifest.collections.session_segments.source_glob).toContain(path.join(gcRoot, '.gc', 'runtime'))
    expect(manifest.collections.events.timestamp_column).toBe('ts')
    expect(manifest.collections.session_segments.timestamp_column).toBe('ts')

    const sqlOut = memo()
    expect(await runQuery(['sql', 'select actor, count(*) as n from events group by actor order by n desc', '--config', configPath, '--format', 'json'], {
      stdout: sqlOut,
      stderr: memo(),
    })).toBe(0)
    const rows = JSON.parse(sqlOut.value())
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: 'hypcity-overrides.mayor', n: 2 }),
      expect.objectContaining({ actor: 'hypcity-overrides.boot', n: 1 }),
    ]))

    const segOut = memo()
    expect(await runQuery(['sql', 'select count(*) as n from session_segments where template like \'%mayor\'', '--config', configPath, '--format', 'json'], {
      stdout: segOut,
      stderr: memo(),
    })).toBe(0)
    expect(JSON.parse(segOut.value())).toEqual([{ n: 2 }])
  })

  it('is idempotent on re-run', async function() {
    writeEvents()
    writeSegment('segment-000001.jsonl', [
      { ts: '2026-05-14T00:00:00.000Z', template: 'hypcity-overrides.mayor' },
    ])

    expect(await runInitSubcommand(['gascity', '--cwd', gcRoot, '--config', configPath], { stdout: memo(), stderr: memo() })).toBe(0)
    const skillPath = path.join(gcRoot, '.claude', 'skills', 'ctvs-gascity', 'SKILL.md')
    const firstBody = fs.readFileSync(skillPath, 'utf8')

    const out = memo()
    expect(await runInitSubcommand(['gascity', '--cwd', gcRoot, '--config', configPath], { stdout: out, stderr: memo() })).toBe(0)
    expect(out.value()).toMatch(/skill already up-to-date/)
    expect(fs.readFileSync(skillPath, 'utf8')).toBe(firstBody)
    expect(fs.existsSync(`${skillPath}.new`)).toBe(false)
  })

  it('errors when cwd has no .gc/', async function() {
    const stderr = memo()
    const noGc = path.join(tmpDir, 'not-gascity')
    fs.mkdirSync(noGc, { recursive: true })
    const code = await runInitSubcommand(['gascity', '--cwd', noGc, '--config', configPath], { stdout: memo(), stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/not a gascity workspace/)
  })

  it('writes a .new file rather than clobbering a divergent existing skill', async function() {
    writeEvents()
    writeSegment('segment-000001.jsonl', [{ ts: '2026-05-14T00:00:00.000Z', template: 'mayor' }])

    const skillDir = path.join(gcRoot, '.claude', 'skills', 'ctvs-gascity')
    fs.mkdirSync(skillDir, { recursive: true })
    const customBody = '# my custom skill\n'
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), customBody)

    const out = memo()
    expect(await runInitSubcommand(['gascity', '--cwd', gcRoot, '--config', configPath], { stdout: out, stderr: memo() })).toBe(0)
    expect(out.value()).toMatch(/existing skill differs; wrote new version/)
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(customBody)
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md.new'))).toBe(true)
  })

  it('rejects unknown preset name', async function() {
    const stderr = memo()
    const code = await runInitSubcommand(['notapreset'], { stdout: memo(), stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown init preset/)
  })
})
