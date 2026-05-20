import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonlEntryBatches } from '../../src/query/iceberg/jsonl.js'

/** @type {string} */
let tmpDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-jsonl-'))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('readJsonlEntryBatches', function() {
  it('streams complete lines in bounded batches and leaves a trailing partial unread', async function() {
    const filePath = path.join(tmpDir, 'rows.jsonl')
    const line1 = JSON.stringify({ id: 1 })
    const line2 = JSON.stringify({ id: 2 })
    const partial = JSON.stringify({ id: 3 })
    fs.writeFileSync(filePath, `${line1}\n${line2}\n${partial}`)

    /** @type {import('../../src/query/iceberg/types.d.ts').JsonlEntryBatch[]} */
    const batches = []
    const result = await readJsonlEntryBatches(
      filePath,
      { batchRows: 1 },
      (batch) => {
        batches.push(batch)
      }
    )

    expect(batches).toHaveLength(2)
    expect(batches.map((batch) => batch.entries[0].raw)).toEqual([{ id: 1 }, { id: 2 }])
    expect(result.nextLineNumber).toBe(2)
    expect(result.nextByteOffset).toBe(Buffer.byteLength(`${line1}\n${line2}\n`))
  })

  it('advances cursors across malformed and empty complete lines without yielding rows', async function() {
    const filePath = path.join(tmpDir, 'bad.jsonl')
    const content = '\nnot-json\n'
    fs.writeFileSync(filePath, content)

    /** @type {import('../../src/query/iceberg/types.d.ts').JsonlEntryBatch[]} */
    const batches = []
    const result = await readJsonlEntryBatches(filePath, {}, (batch) => {
      batches.push(batch)
    })

    expect(batches).toHaveLength(0)
    expect(result.nextLineNumber).toBe(2)
    expect(result.nextByteOffset).toBe(Buffer.byteLength(content))
  })
})
