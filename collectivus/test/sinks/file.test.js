import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileSink } from '../../src/sinks/file.js'

const GATEWAY_ID = 'tester'

/** @type {string} */
let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-sink-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.useRealTimers()
})

/**
 * @returns {string}
 */
function proxyDir() {
  return path.join(tmpDir, GATEWAY_ID, 'proxy')
}

/**
 * @returns {unknown[]}
 */
function readJsonl() {
  const dir = proxyDir()
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()
  /** @type {unknown[]} */
  const rows = []
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    if (text.length === 0) continue
    for (const line of text.split('\n')) {
      if (line.length > 0) rows.push(JSON.parse(line))
    }
  }
  return rows
}

describe('FileSink', () => {
  it('appends one row per line to <dir>/<gateway_id>/proxy/<date>.jsonl', async () => {
    const sink = new FileSink(tmpDir, GATEWAY_ID)
    await sink.writeRow({ a: 1 })
    await sink.writeRow({ a: 2 })
    await sink.close()
    expect(readJsonl()).toEqual([{ a: 1 }, { a: 2 }])
    // Layout matches the server's `<sink_dir>/<gateway_id>/<signal>/<date>.jsonl`.
    const dir = proxyDir()
    const files = fs.readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)
  })

  it('creates the target directory lazily on first write', async () => {
    const nested = path.join(tmpDir, 'nested', 'further')
    expect(fs.existsSync(nested)).toBe(false)
    const sink = new FileSink(nested, GATEWAY_ID)
    expect(fs.existsSync(nested)).toBe(false)
    await sink.writeRow({ ok: true })
    await sink.close()
    expect(fs.existsSync(path.join(nested, GATEWAY_ID, 'proxy'))).toBe(true)
  })

  it('preserves submission order under concurrent writeRow calls', async () => {
    const sink = new FileSink(tmpDir, GATEWAY_ID)
    const writes = []
    for (let i = 0; i < 50; i++) writes.push(sink.writeRow({ i }))
    await Promise.all(writes)
    await sink.close()
    const rows = readJsonl()
    /** @type {{ i: number }[]} */
    const typedRows = []
    for (const row of rows) {
      if (typeof row === 'object' && row !== null && 'i' in row && typeof row.i === 'number') {
        typedRows.push({ i: row.i })
      }
    }
    expect(typedRows.map((row) => row.i)).toEqual(Array.from({ length: 50 }, (_, i) => i))
  })

  it('accepts close() with no writes and creates no file', async () => {
    const sink = new FileSink(tmpDir, GATEWAY_ID)
    await sink.close()
    expect(fs.existsSync(proxyDir())).toBe(false)
  })

  it('rejects writeRow after close', async () => {
    const sink = new FileSink(tmpDir, GATEWAY_ID)
    await sink.writeRow({ a: 1 })
    await sink.close()
    await expect(sink.writeRow({ a: 2 })).rejects.toThrow(/after close/)
  })

  it('close() is idempotent', async () => {
    const sink = new FileSink(tmpDir, GATEWAY_ID)
    await sink.writeRow({ a: 1 })
    await sink.close()
    await sink.close()
    expect(readJsonl()).toEqual([{ a: 1 }])
  })

  it('appends across separate sink instances (does not truncate existing file)', async () => {
    const a = new FileSink(tmpDir, GATEWAY_ID)
    await a.writeRow({ run: 1 })
    await a.close()
    const b = new FileSink(tmpDir, GATEWAY_ID)
    await b.writeRow({ run: 2 })
    await b.close()
    expect(readJsonl()).toEqual([{ run: 1 }, { run: 2 }])
  })

  it('persists writes that occur right before close (fsync-on-close)', async () => {
    // Fire writeRow without awaiting individually; close() must drain the queue.
    const sink = new FileSink(tmpDir, GATEWAY_ID)
    sink.writeRow({ i: 1 })
    sink.writeRow({ i: 2 })
    sink.writeRow({ i: 3 })
    await sink.close()
    expect(readJsonl()).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }])
  })

  it('rejects construction without a gatewayId', () => {
    // @ts-expect-error - constructor refuses the legacy single-arg shape
    expect(() => new FileSink(tmpDir)).toThrow(/gatewayId is required/)
  })

  it('rotates files on UTC date change', async () => {
    // Pin the clock to 23:59:30Z so the first write lands in day N and the
    // second (after a 60-second jump) lands in day N+1. The sink keys off
    // `Date.toISOString()` so faking the system clock is enough.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-15T23:59:30Z'))
    const sink = new FileSink(tmpDir, GATEWAY_ID)
    await sink.writeRow({ day: 'first' })

    vi.setSystemTime(new Date('2025-06-16T00:00:30Z'))
    await sink.writeRow({ day: 'second' })
    await sink.close()

    const dir = proxyDir()
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(['2025-06-15.jsonl', '2025-06-16.jsonl'])
    expect(fs.readFileSync(path.join(dir, '2025-06-15.jsonl'), 'utf8'))
      .toBe(JSON.stringify({ day: 'first' }) + '\n')
    expect(fs.readFileSync(path.join(dir, '2025-06-16.jsonl'), 'utf8'))
      .toBe(JSON.stringify({ day: 'second' }) + '\n')
  })
})
