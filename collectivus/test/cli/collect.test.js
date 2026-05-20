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

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-collect-'))
  sinkDir = path.join(tmpDir, 'sink')
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
 * @returns {Record<string, any>}
 */
function readOnlyCollectionCursor(table) {
  const tableDir = path.join(sinkDir, '.collectivus-query', 'cache', 'collections', table)
  const partitions = fs.readdirSync(tableDir).filter((entry) => entry.startsWith('source='))
  expect(partitions).toHaveLength(1)
  return JSON.parse(fs.readFileSync(path.join(tableDir, partitions[0], 'cursor.json'), 'utf8'))
}

describe('ctvs collect', function() {
  it('registers an external JSONL file as a normalized query table and refreshes it immediately', async function() {
    const jsonlPath = path.join(tmpDir, 'random-log.jsonl')
    writeJsonl(jsonlPath, [
      {
        timestamp: '2026-05-11T10:00:00.000Z',
        level: 'info',
        message: 'hello',
        count: 2,
        nested: { ok: true },
      },
      {
        timestamp: '2026-05-11T10:01:00.000Z',
        level: 'warn',
        message: 'careful',
        count: 3.5,
        nested: { ok: false },
      },
    ])

    const collectOut = memo()
    const collectErr = memo()
    const code = await runCollect([jsonlPath, '--name', 'random-log', '--config', configPath], {
      stdout: collectOut,
      stderr: collectErr,
    })
    expect(code).toBe(0)
    expect(collectErr.value()).toBe('')
    expect(collectOut.value()).toMatch(/Registered random-log as table random_log/)
    expect(collectOut.value()).toMatch(/Query with: ctvs query sql "select \* from random_log"/)

    const manifestPath = path.join(sinkDir, '.collectivus-query', 'collections.json')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toMatchObject({
      version: 2,
      collections: {
        random_log: {
          name: 'random-log',
          table: 'random_log',
          source_path: jsonlPath,
        },
      },
    })

    const sqlOut = memo()
    const sqlErr = memo()
    expect(await runQuery([
      'sql',
      'select message, count, nested from random_log order by timestamp asc',
      '--config', configPath,
      '--format', 'json',
    ], { stdout: sqlOut, stderr: sqlErr })).toBe(0)
    expect(sqlErr.value()).toBe('')
    expect(JSON.parse(sqlOut.value())).toEqual([
      { message: 'hello', count: 2, nested: { ok: true } },
      { message: 'careful', count: 3.5, nested: { ok: false } },
    ])

    const namedSqlOut = memo()
    const namedSqlErr = memo()
    expect(await runQuery([
      'sql',
      'select message from "random-log" order by timestamp asc',
      '--config', configPath,
      '--format', 'json',
    ], { stdout: namedSqlOut, stderr: namedSqlErr })).toBe(0)
    expect(namedSqlErr.value()).toBe('')
    expect(JSON.parse(namedSqlOut.value())).toEqual([
      { message: 'hello' },
      { message: 'careful' },
    ])

    const schemaOut = memo()
    expect(await runQuery(['schema', 'random-log', '--config', configPath, '--format', 'json'], {
      stdout: schemaOut,
      stderr: memo(),
    })).toBe(0)
    /** @type {Array<{ name: string, type: string, source_field: string }>} */
    const schema = JSON.parse(schemaOut.value())
    expect(schema).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '_ctvs_raw', type: 'JSON' }),
      expect.objectContaining({ name: 'timestamp', type: 'TIMESTAMP', source_field: 'timestamp' }),
      expect.objectContaining({ name: 'nested', type: 'JSON', source_field: 'nested' }),
    ]))

    const catalogOut = memo()
    expect(await runQuery(['catalog', '--config', configPath, '--format', 'json'], {
      stdout: catalogOut,
      stderr: memo(),
    })).toBe(0)
    expect(JSON.parse(catalogOut.value())).toEqual(expect.arrayContaining([
      expect.objectContaining({ dataset: 'random_log', source_signal: 'collection', source_partitions: 1, cached_rows: 2 }),
    ]))

    const sampleOut = memo()
    expect(await runQuery(['sample', 'random_log', '--config', configPath, '--format', 'json'], {
      stdout: sampleOut,
      stderr: memo(),
    })).toBe(0)
    expect(JSON.parse(sampleOut.value())[0]).toMatchObject({ message: 'hello' })
  })

  it('uses existing stale-cache warning behavior and refreshes changed collection files on demand', async function() {
    const jsonlPath = path.join(tmpDir, 'events.jsonl')
    writeJsonl(jsonlPath, [
      { timestamp: '2026-05-11T10:00:00.000Z', event: 'one' },
    ])
    expect(await runCollect([jsonlPath, '--name', 'events', '--config', configPath], {
      stdout: memo(),
      stderr: memo(),
    })).toBe(0)

    writeJsonl(jsonlPath, [
      { timestamp: '2026-05-11T10:00:00.000Z', event: 'one' },
      { timestamp: '2026-05-11T10:01:00.000Z', event: 'two' },
    ])

    const staleOut = memo()
    const staleErr = memo()
    expect(await runQuery(['sql', 'select count(*) as n from events', '--config', configPath], {
      stdout: staleOut,
      stderr: staleErr,
    })).toBe(0)
    expect(staleOut.value()).toMatch(/\b1\b/)
    expect(staleErr.value()).toMatch(/warning: query cache last refreshed at /)
    expect(staleErr.value()).toMatch(/events \(source size changed|events \(source mtime changed/)

    const refreshedOut = memo()
    const refreshedErr = memo()
    expect(await runQuery([
      'sql',
      'select count(*) as n from events',
      '--config', configPath,
      '--refresh', 'always',
    ], { stdout: refreshedOut, stderr: refreshedErr })).toBe(0)
    expect(refreshedErr.value()).toBe('')
    expect(refreshedOut.value()).toMatch(/\b2\b/)

    fs.unlinkSync(jsonlPath)
    const deletedOut = memo()
    const deletedErr = memo()
    expect(await runQuery(['sql', 'select count(*) as n from events', '--config', configPath], {
      stdout: deletedOut,
      stderr: deletedErr,
    })).toBe(0)
    expect(deletedOut.value()).toMatch(/\b2\b/)
    expect(deletedErr.value()).toBe('')
  })

  it('starts a new collection source epoch when appended rows introduce schema drift', async function() {
    const jsonlPath = path.join(tmpDir, 'events.jsonl')
    writeJsonl(jsonlPath, [
      { timestamp: '2026-05-11T10:00:00.000Z', event: 'one' },
    ])
    expect(await runCollect([jsonlPath, '--name', 'events', '--config', configPath], {
      stdout: memo(),
      stderr: memo(),
    })).toBe(0)

    const before = readOnlyCollectionCursor('events')
    expect(before.source_epoch).toBe(0)

    writeJsonl(jsonlPath, [
      { timestamp: '2026-05-11T10:00:00.000Z', event: 'one' },
      { timestamp: '2026-05-11T10:01:00.000Z', event: 'two', extra: 'new-column' },
    ])
    const refreshOut = memo()
    expect(await runQuery(['refresh', jsonlPath, '--config', configPath], {
      stdout: refreshOut,
      stderr: memo(),
    })).toBe(0)
    expect(refreshOut.value()).toMatch(/Done\. 1 file\(s\) written/)

    const after = readOnlyCollectionCursor('events')
    expect(after.source_epoch).toBe(1)
    expect(path.basename(after.table_path)).toBe('epoch=1')
    expect(after.row_count).toBe(2)
    const afterColumns = /** @type {{ name: string }[]} */ (after.columns)
    expect(afterColumns.map((column) => column.name)).toContain('extra')

    const sqlOut = memo()
    expect(await runQuery([
      'sql',
      'select event, extra from events order by timestamp asc',
      '--config', configPath,
      '--format', 'json',
    ], { stdout: sqlOut, stderr: memo() })).toBe(0)
    expect(JSON.parse(sqlOut.value())).toEqual([
      { event: 'one', extra: null },
      { event: 'two', extra: 'new-column' },
    ])
  })

  it('supports replace, list, and remove for registered collections', async function() {
    const firstPath = path.join(tmpDir, 'first.jsonl')
    const secondPath = path.join(tmpDir, 'second.jsonl')
    writeJsonl(firstPath, [{ timestamp: '2026-05-11T10:00:00.000Z', message: 'first' }])
    writeJsonl(secondPath, [{ timestamp: '2026-05-11T10:00:00.000Z', message: 'second' }])

    expect(await runCollect([firstPath, '--name', 'change-me', '--config', configPath], {
      stdout: memo(),
      stderr: memo(),
    })).toBe(0)

    const dupErr = memo()
    expect(await runCollect([secondPath, '--name', 'change-me', '--config', configPath], {
      stdout: memo(),
      stderr: dupErr,
    })).toBe(1)
    expect(dupErr.value()).toMatch(/already exists/)

    expect(await runCollect([secondPath, '--name', 'change-me', '--replace', '--config', configPath], {
      stdout: memo(),
      stderr: memo(),
    })).toBe(0)

    const listOut = memo()
    expect(await runCollect(['list', '--config', configPath, '--format', 'json'], {
      stdout: listOut,
      stderr: memo(),
    })).toBe(0)
    expect(JSON.parse(listOut.value())).toEqual([
      expect.objectContaining({ name: 'change-me', table: 'change_me', source: secondPath, mode: 'file' }),
    ])

    const sqlOut = memo()
    expect(await runQuery(['sql', 'select message from change_me', '--config', configPath], {
      stdout: sqlOut,
      stderr: memo(),
    })).toBe(0)
    expect(sqlOut.value()).toMatch(/second/)

    const removeOut = memo()
    expect(await runCollect(['remove', 'change-me', '--config', configPath], {
      stdout: removeOut,
      stderr: memo(),
    })).toBe(0)
    expect(removeOut.value()).toMatch(/Removed collection change_me/)

    const removedErr = memo()
    expect(await runQuery(['sql', 'select message from change_me', '--config', configPath], {
      stdout: memo(),
      stderr: removedErr,
    })).toBe(2)
    expect(removedErr.value()).toMatch(/unknown query table "change_me"/)
  })
})
