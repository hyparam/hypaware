import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCollect } from '../../src/cli/collect.js'
import { runQuery } from '../../src/cli/query.js'

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
let sinkDir
/** @type {string} */
let configPath
/** @type {string} */
let sourceRoot

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-collect-glob-'))
  sinkDir = path.join(tmpDir, 'sink')
  sourceRoot = path.join(tmpDir, 'segments')
  fs.mkdirSync(path.join(sourceRoot, 'a'), { recursive: true })
  fs.mkdirSync(path.join(sourceRoot, 'b'), { recursive: true })
  configPath = path.join(tmpDir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    sink: { type: 'file', dir: sinkDir },
    query: { cache: { enabled: true } },
  }))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {string} filePath
 * @param {Record<string, unknown>[]} rows
 */
function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

/**
 * @param {string} table
 * @returns {string}
 */
function collectionTableDir(table) {
  return path.join(sinkDir, '.collectivus-query', 'cache', 'collections', table)
}

/**
 * @param {string} tableDir
 * @returns {string[]}
 */
function sourcePartitionDirs(tableDir) {
  return fs.readdirSync(tableDir).filter((entry) => entry.startsWith('source=')).sort()
}

/**
 * @param {string} tableDir
 * @param {string} partitionDir
 * @returns {Record<string, any>}
 */
function readCursor(tableDir, partitionDir) {
  return JSON.parse(fs.readFileSync(path.join(tableDir, partitionDir, 'cursor.json'), 'utf8'))
}

describe('ctvs collect --glob', function() {
  it('registers a glob-backed table with one partition per matched file', async function() {
    const fileA = path.join(sourceRoot, 'a', 'segment-001.jsonl')
    const fileB = path.join(sourceRoot, 'a', 'segment-002.jsonl')
    const fileC = path.join(sourceRoot, 'b', 'segment-003.jsonl')
    writeJsonl(fileA, [{ ts: '2026-05-14T00:00:00Z', actor: 'mayor', n: 1 }])
    writeJsonl(fileB, [{ ts: '2026-05-14T00:01:00Z', actor: 'mayor', n: 2 }])
    writeJsonl(fileC, [{ ts: '2026-05-14T00:02:00Z', actor: 'refinery', n: 3 }])

    const glob = path.join(sourceRoot, '**/*.jsonl')
    const collectOut = memo()
    const collectErr = memo()
    const code = await runCollect(['--glob', glob, '--name', 'segs', '--config', configPath], {
      stdout: collectOut,
      stderr: collectErr,
    })
    expect(code).toBe(0)
    expect(collectErr.value()).toBe('')
    expect(collectOut.value()).toMatch(/Registered segs as table segs/)
    expect(collectOut.value()).toMatch(/3 row\(s\)/)

    const tableDir = collectionTableDir('segs')
    const partitionDirs = sourcePartitionDirs(tableDir)
    expect(partitionDirs.length).toBe(3)
    for (const dir of partitionDirs) {
      const cursor = readCursor(tableDir, dir)
      expect(cursor).toMatchObject({ kind: 'collection', table: 'segs', name: 'segs', source_epoch: 0 })
      const metadataDir = path.join(cursor.table_path, 'metadata')
      expect(fs.readdirSync(metadataDir).some((entry) => /\.metadata\.json$/.test(entry))).toBe(true)
    }

    const sqlOut = memo()
    expect(await runQuery(['sql', 'select count(*) as c from segs', '--config', configPath, '--format', 'json'], {
      stdout: sqlOut,
      stderr: memo(),
    })).toBe(0)
    expect(JSON.parse(sqlOut.value())).toEqual([{ c: 3 }])

    const filterOut = memo()
    expect(await runQuery(['sql', 'select count(*) as c from segs where actor = \'mayor\'', '--config', configPath, '--format', 'json'], {
      stdout: filterOut,
      stderr: memo(),
    })).toBe(0)
    expect(JSON.parse(filterOut.value())).toEqual([{ c: 2 }])
  })

  it('keeps cache-only partitions when a glob source file is deleted', async function() {
    const fileA = path.join(sourceRoot, 'a', 'segment-001.jsonl')
    const fileB = path.join(sourceRoot, 'a', 'segment-002.jsonl')
    writeJsonl(fileA, [{ ts: '2026-05-14T00:00:00Z', n: 1 }])
    writeJsonl(fileB, [{ ts: '2026-05-14T00:01:00Z', n: 2 }])

    const glob = path.join(sourceRoot, '**/*.jsonl')
    expect(await runCollect(['--glob', glob, '--name', 'segs', '--config', configPath], {
      stdout: memo(),
      stderr: memo(),
    })).toBe(0)

    const tableDir = collectionTableDir('segs')
    expect(sourcePartitionDirs(tableDir).length).toBe(2)

    fs.unlinkSync(fileB)

    const refreshOut = memo()
    expect(await runQuery(['refresh', '--all', 'segs', '--config', configPath], {
      stdout: refreshOut,
      stderr: memo(),
    })).toBe(0)
    expect(refreshOut.value()).not.toMatch(/pruned orphan partition/)
    expect(refreshOut.value()).toMatch(/fresh segs/)

    expect(sourcePartitionDirs(tableDir).length).toBe(2)

    const sqlOut = memo()
    expect(await runQuery(['sql', 'select count(*) as c from segs', '--config', configPath, '--format', 'json'], {
      stdout: sqlOut,
      stderr: memo(),
    })).toBe(0)
    expect(JSON.parse(sqlOut.value())).toEqual([{ c: 2 }])
  })

  it('only re-materializes partitions whose source files changed', async function() {
    const fileA = path.join(sourceRoot, 'a', 'segment-001.jsonl')
    const fileB = path.join(sourceRoot, 'a', 'segment-002.jsonl')
    writeJsonl(fileA, [{ ts: '2026-05-14T00:00:00Z', n: 1 }])
    writeJsonl(fileB, [{ ts: '2026-05-14T00:01:00Z', n: 2 }])

    const glob = path.join(sourceRoot, '**/*.jsonl')
    expect(await runCollect(['--glob', glob, '--name', 'segs', '--config', configPath], {
      stdout: memo(),
      stderr: memo(),
    })).toBe(0)

    const tableDir = collectionTableDir('segs')
    const partitions = sourcePartitionDirs(tableDir)
    const mtimes = Object.fromEntries(partitions.map((p) => [p, fs.statSync(path.join(tableDir, p, 'cursor.json')).mtimeMs]))
    const sources = Object.fromEntries(partitions.map((p) => [p, path.basename(readCursor(tableDir, p).source_path)]))

    await new Promise((resolve) => setTimeout(resolve, 25))
    writeJsonl(fileB, [
      { ts: '2026-05-14T00:01:00Z', n: 2 },
      { ts: '2026-05-14T00:02:00Z', n: 3 },
    ])

    expect(await runQuery(['refresh', '--all', 'segs', '--config', configPath], {
      stdout: memo(),
      stderr: memo(),
    })).toBe(0)

    const afterMtimes = Object.fromEntries(partitions.map((p) => [p, fs.statSync(path.join(tableDir, p, 'cursor.json')).mtimeMs]))
    let unchanged = 0
    let changed = 0
    for (const p of partitions) {
      if (sources[p] === 'segment-002.jsonl') {
        expect(afterMtimes[p]).toBeGreaterThan(mtimes[p])
        changed++
      } else {
        expect(afterMtimes[p]).toBe(mtimes[p])
        unchanged++
      }
    }
    expect(changed).toBe(1)
    expect(unchanged).toBe(1)
  })

  it('refreshes one glob-backed collection source file by path', async function() {
    const fileA = path.join(sourceRoot, 'a', 'segment-001.jsonl')
    const fileB = path.join(sourceRoot, 'a', 'segment-002.jsonl')
    writeJsonl(fileA, [{ ts: '2026-05-14T00:00:00Z', n: 1 }])
    writeJsonl(fileB, [{ ts: '2026-05-14T00:01:00Z', n: 2 }])

    const glob = path.join(sourceRoot, '**/*.jsonl')
    expect(await runCollect(['--glob', glob, '--name', 'segs', '--config', configPath], {
      stdout: memo(),
      stderr: memo(),
    })).toBe(0)

    await new Promise((resolve) => setTimeout(resolve, 25))
    writeJsonl(fileB, [
      { ts: '2026-05-14T00:01:00Z', n: 2 },
      { ts: '2026-05-14T00:02:00Z', n: 3 },
    ])

    const refreshOut = memo()
    expect(await runQuery(['refresh', fileB, '--config', configPath], {
      stdout: refreshOut,
      stderr: memo(),
    })).toBe(0)
    expect(refreshOut.value()).toMatch(/Done\. 1 file\(s\) written/)

    const sqlOut = memo()
    expect(await runQuery(['sql', 'select count(*) as c from segs', '--config', configPath, '--format', 'json'], {
      stdout: sqlOut,
      stderr: memo(),
    })).toBe(0)
    expect(JSON.parse(sqlOut.value())).toEqual([{ c: 3 }])
  })

  it('rejects mixing positional path and --glob', async function() {
    const file = path.join(sourceRoot, 'a', 'segment-001.jsonl')
    writeJsonl(file, [{ ts: '2026-05-14T00:00:00Z' }])
    const stderr = memo()
    const code = await runCollect([file, '--glob', path.join(sourceRoot, '*.jsonl'), '--name', 'mix', '--config', configPath], {
      stdout: memo(),
      stderr,
    })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/either a JSONL file path or --glob/)
  })
})
