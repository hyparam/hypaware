import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonlRows, readPartitionRows, walkPartitionFiles } from '../../src/upload/reader.js'

/** @type {string} */
let outputDir

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-reader-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

/**
 * Write a date file at `<outputDir>/<segments...>/<date>.jsonl`. Creates
 * intermediate directories as needed.
 *
 * @param {string[]} segments Directory segments under outputDir.
 * @param {string} fileName e.g. "2026-05-07.jsonl"
 * @param {object[]} rows
 */
function writeFile(segments, fileName, rows) {
  const dir = path.join(outputDir, ...segments)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, fileName),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )
}

describe('walkPartitionFiles', () => {
  it('walks <gateway_id>/<signal>/<date>.jsonl for the server layout', () => {
    writeFile(['gw-a', 'logs'], '2026-05-06.jsonl', [{ a: 1 }])
    writeFile(['gw-a', 'traces'], '2026-05-06.jsonl', [{ b: 2 }])
    writeFile(['gw-b', 'logs'], '2026-05-07.jsonl', [{ c: 3 }])

    const files = [...walkPartitionFiles(outputDir, ['gateway_id', 'signal'])]
      .map((f) => ({ partition: f.partition, signal: f.signal, date: f.date }))
      .sort((a, b) => `${a.partition.gateway_id}/${a.signal}/${a.date}`.localeCompare(`${b.partition.gateway_id}/${b.signal}/${b.date}`))

    expect(files).toEqual([
      { partition: { gateway_id: 'gw-a', signal: 'logs' }, signal: 'logs', date: '2026-05-06' },
      { partition: { gateway_id: 'gw-a', signal: 'traces' }, signal: 'traces', date: '2026-05-06' },
      { partition: { gateway_id: 'gw-b', signal: 'logs' }, signal: 'logs', date: '2026-05-07' },
    ])
  })

  it('returns absolute file paths under outputDir', () => {
    writeFile(['gw-a', 'logs'], '2026-05-06.jsonl', [{ x: 1 }])
    const [file] = [...walkPartitionFiles(outputDir, ['gateway_id', 'signal'])]
    expect(file.filePath).toBe(path.join(outputDir, 'gw-a', 'logs', '2026-05-06.jsonl'))
  })

  it('skips empty intermediate gateway and signal directories cleanly', () => {
    // Empty gateway: no signals at all.
    fs.mkdirSync(path.join(outputDir, 'gw-empty'), { recursive: true })
    // Gateway with an empty signal directory.
    fs.mkdirSync(path.join(outputDir, 'gw-half', 'logs'), { recursive: true })
    // A real file alongside, to prove the walk continues.
    writeFile(['gw-real', 'logs'], '2026-05-06.jsonl', [{ ok: true }])

    const files = [...walkPartitionFiles(outputDir, ['gateway_id', 'signal'])]
    expect(files).toHaveLength(1)
    expect(files[0].partition).toEqual({ gateway_id: 'gw-real', signal: 'logs' })
  })

  it('returns an empty iterator when outputDir does not exist', () => {
    const missing = path.join(outputDir, 'never-created')
    expect([...walkPartitionFiles(missing, ['gateway_id', 'signal'])]).toEqual([])
  })

  it('ignores non-date filenames at the leaf level', () => {
    writeFile(['gw-a', 'logs'], '2026-05-06.jsonl', [{ keep: 1 }])
    writeFile(['gw-a', 'logs'], 'README.txt', [{ ignore: 1 }])
    writeFile(['gw-a', 'logs'], '2026-05.jsonl', [{ partial: 1 }])
    writeFile(['gw-a', 'logs'], 'logs-2026-05-06.jsonl', [{ legacy: 1 }])

    const files = [...walkPartitionFiles(outputDir, ['gateway_id', 'signal'])]
    expect(files.map((f) => path.basename(f.filePath))).toEqual(['2026-05-06.jsonl'])
  })

  it('ignores non-directory entries at intermediate partition levels', () => {
    // A stray file at the gateway_id level — must not be treated as a gateway.
    fs.writeFileSync(path.join(outputDir, 'orphan.txt'), 'not a gateway')
    writeFile(['gw-real', 'logs'], '2026-05-06.jsonl', [{ ok: 1 }])

    const files = [...walkPartitionFiles(outputDir, ['gateway_id', 'signal'])]
    expect(files).toHaveLength(1)
    expect(files[0].partition.gateway_id).toBe('gw-real')
  })

  it('throws when partitionDimensions is empty', () => {
    expect(() => [...walkPartitionFiles(outputDir, [])]).toThrow(/must not be empty/)
  })

  it('throws when \'signal\' is not one of partitionDimensions', () => {
    expect(() => [...walkPartitionFiles(outputDir, ['gateway_id'])])
      .toThrow(/'signal' must be one of partitionDimensions/)
    expect(() => [...walkPartitionFiles(outputDir, ['service', 'tenant'])])
      .toThrow(/'signal' must be one of partitionDimensions/)
  })

  it('supports the legacy two-dimension layout when callers opt in', () => {
    // Note: legacy standalone uses `<services>/<service>/<signal>-<date>.jsonl`,
    // which the uploader's discoverLegacyJobs walks directly. walkPartitionFiles
    // implements the generic `<dim1>/<dim2>/<date>.jsonl` shape, which is what
    // a hypothetical `[service, signal]` opt-in would expect.
    writeFile(['svc-a', 'logs'], '2026-05-06.jsonl', [{ x: 1 }])
    const files = [...walkPartitionFiles(outputDir, ['service', 'signal'])]
    expect(files).toHaveLength(1)
    expect(files[0].partition).toEqual({ service: 'svc-a', signal: 'logs' })
  })
})

describe('readPartitionRows', () => {
  it('tags each row with a _partition map matching the partition argument', async () => {
    const filePath = path.join(outputDir, 'data.jsonl')
    fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n')

    const rows = []
    for await (const row of readPartitionRows(filePath, { gateway_id: 'gw-1', signal: 'logs' })) {
      rows.push(row)
    }
    expect(rows).toEqual([
      { a: 1, _partition: { gateway_id: 'gw-1', signal: 'logs' } },
      { b: 2, _partition: { gateway_id: 'gw-1', signal: 'logs' } },
    ])
  })

  it('overwrites a pre-existing _partition field on the row', async () => {
    // _partition is server-attribution metadata; client-supplied values must
    // not override it (mirrors the ingest endpoint's _ingest discipline).
    const filePath = path.join(outputDir, 'data.jsonl')
    fs.writeFileSync(filePath, '{"x":1,"_partition":{"gateway_id":"forged"}}\n')

    const rows = []
    for await (const row of readPartitionRows(filePath, { gateway_id: 'real', signal: 'logs' })) {
      rows.push(row)
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]._partition).toEqual({ gateway_id: 'real', signal: 'logs' })
    expect(rows[0].x).toBe(1)
  })

  it('preserves the row body fields verbatim', async () => {
    const filePath = path.join(outputDir, 'data.jsonl')
    const original = { serviceName: 'svc', body: { msg: 'hi' }, attributes: { k: 'v' } }
    fs.writeFileSync(filePath, JSON.stringify(original) + '\n')

    const rows = []
    for await (const row of readPartitionRows(filePath, { service: 'svc', signal: 'logs' })) {
      rows.push(row)
    }
    expect(rows[0].serviceName).toBe('svc')
    expect(rows[0].body).toEqual({ msg: 'hi' })
    expect(rows[0].attributes).toEqual({ k: 'v' })
  })

  it('shares one tag object across rows so callers cannot mutate per-row partition state', async () => {
    const filePath = path.join(outputDir, 'data.jsonl')
    fs.writeFileSync(filePath, '{"a":1}\n{"a":2}\n')

    const rows = []
    for await (const row of readPartitionRows(filePath, { gateway_id: 'gw', signal: 'logs' })) {
      rows.push(row)
    }
    expect(rows[0]._partition).toBe(rows[1]._partition)
  })

  it('yields nothing when the source file is empty', async () => {
    const filePath = path.join(outputDir, 'empty.jsonl')
    fs.writeFileSync(filePath, '')
    const rows = []
    for await (const row of readPartitionRows(filePath, { signal: 'logs' })) {
      rows.push(row)
    }
    expect(rows).toEqual([])
  })
})

describe('readJsonlRows', () => {
  // Smoke test the legacy reader continues to behave; it's the building block
  // readPartitionRows wraps and the rest of the standalone path still uses it
  // indirectly via discoverLegacyJobs / uploadJob.
  it('parses one object per line and skips blank lines', async () => {
    const filePath = path.join(outputDir, 'data.jsonl')
    fs.writeFileSync(filePath, '{"a":1}\n\n{"b":2}\n')
    const rows = []
    for await (const row of readJsonlRows(filePath)) rows.push(row)
    expect(rows).toEqual([{ a: 1 }, { b: 2 }])
  })
})
