// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { snappyCompress as writerFallbackCompress } from 'hyparquet-writer/src/snappy.js'
import { snappyCompressor } from 'hysnappy'

import { openStreamingAppend } from '../../src/core/cache/iceberg/stream_append.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'body', type: 'STRING', nullable: true },
]

// The SNAPPY decompressor the query path wires for reads (see
// query/parquet-source.js). Typed optional on `Compressors`, so resolve it
// once and fail here rather than at each use.
if (!compressors.SNAPPY) throw new Error('hyparquet-compressors exposes no SNAPPY decompressor')
/** @type {(bytes: Uint8Array, outputLength?: number) => Uint8Array} */
const snappyUncompress = compressors.SNAPPY

/**
 * Deterministic high-entropy text. hysnappy and hyparquet-writer's own JS
 * snappy agree byte for byte on short or highly repetitive pages, so a page
 * that tells the two apart has to be one where their match-finding diverges.
 *
 * @param {number} length
 * @param {number} seed
 * @returns {string}
 */
function noise(length, seed) {
  let state = seed
  let out = ''
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648
    out += String.fromCharCode(33 + Math.floor((state / 2147483648) * 90))
  }
  return out
}

/**
 * Run one streaming append into a fresh table and hand back the data files
 * it wrote.
 *
 * @param {string} dir
 * @param {Record<string, unknown>[]} rows
 * @returns {Promise<string[]>}
 */
async function writeThroughCache(dir, rows) {
  const tableDir = path.join(dir, 'table')
  const sink = await openStreamingAppend({
    tableDir,
    columns: COLUMNS,
    targetFileBytes: 512 * 1024 * 1024,
  })
  if (rows.length) await sink.write(rows)
  await sink.close()
  const dataDir = path.join(tableDir, 'data')
  const names = (await fs.readdir(dataDir)).filter((name) => name.endsWith('.parquet'))
  return names.map((name) => path.join(dataDir, name))
}

/**
 * Read a data file back, intercepting the SNAPPY decompressor so every page's
 * stored bytes and its plaintext are captured on the way through. hyparquet
 * consults `compressors[codec]` ahead of its own built-in, so this is the
 * page bytes exactly as the writer laid them down.
 *
 * @param {string} filePath
 * @returns {Promise<{ rows: Record<string, any>[], pages: { stored: Uint8Array, plain: Uint8Array }[] }>}
 */
async function readCapturingPages(filePath) {
  /** @type {{ stored: Uint8Array, plain: Uint8Array }[]} */
  const pages = []
  const rows = await parquetReadObjects({
    file: await asyncBufferFromFile(filePath),
    compressors: {
      SNAPPY: (input, outputLength) => {
        const plain = snappyUncompress(input, outputLength)
        pages.push({ stored: Uint8Array.from(input), plain: Uint8Array.from(plain) })
        return plain
      },
    },
  })
  return { rows, pages }
}

/** @param {Uint8Array} a @param {Uint8Array} b @returns {boolean} */
function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// The cache's streaming compaction writer is the largest single producer of
// parquet bytes in the process (a rewrite re-encodes every live row of a
// table), and until this it built its `ParquetWriter` with a `codec` but no
// `compressors`, so it silently used hyparquet-writer's JS snappy while the
// sink export encoder used hysnappy. Nothing about a file says which
// compressor wrote it, so the only honest assertion is on the page bytes:
// recover each page's plaintext through the reader, re-compress it with both
// implementations, and require the stored bytes to be hysnappy's. The
// `divergent` counter is what gives that teeth - the two agree on most
// pages, so without proof that at least one page distinguishes them the
// assertion would pass on either wiring.
test('the cache compaction writer compresses pages with hysnappy, not the writer fallback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cache-codec-'))
  try {
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, body: noise(200, 7919 + i) }))
    const files = await writeThroughCache(dir, rows)
    assert.equal(files.length, 1)

    const { rows: readBack, pages } = await readCapturingPages(files[0])
    assert.equal(readBack.length, rows.length, 'the file has to be readable to say anything about it')
    assert.ok(pages.length > 0, 'expected at least one SNAPPY page')

    const compressWithHysnappy = snappyCompressor()
    let divergent = 0
    for (const page of pages) {
      const hysnappyBytes = compressWithHysnappy(page.plain)
      const fallbackBytes = writerFallbackCompress(page.plain)
      if (!sameBytes(hysnappyBytes, fallbackBytes)) divergent += 1
      assert.ok(
        sameBytes(page.stored, hysnappyBytes),
        `page of ${page.plain.length} plaintext bytes was not hysnappy's encoding ` +
          `(stored ${page.stored.length}, hysnappy ${hysnappyBytes.length}, fallback ${fallbackBytes.length})`
      )
    }
    assert.ok(
      divergent > 0,
      'no page distinguished the two snappy implementations, so this test proved nothing'
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Round-tripping is the other half, and it is the half a codec mistake shows
// up in: a write path that emits the framed snappy stream format instead of
// raw blocks, or that hands back a view into a buffer it later reuses, still
// produces a file - it just cannot be read back. The reader here is the one
// the query path wires (`hyparquet-compressors`), not hysnappy's own
// decompressor, so the two ends are independent implementations. The row
// shapes are the ones a page can degenerate to: all-null (an empty page),
// one byte per value, incompressible, highly compressible, and values fat
// enough to push a page well past the writer's 1 MiB default.
test('every page shape the cache writes reads back through the query path decompressor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cache-codec-shapes-'))
  try {
    /** @type {Record<string, Record<string, unknown>[]>} */
    const shapes = {
      nulls: Array.from({ length: 8 }, (_, i) => ({ id: i, body: null })),
      one_byte: Array.from({ length: 8 }, (_, i) => ({ id: i, body: 'a' })),
      incompressible: Array.from({ length: 300 }, (_, i) => ({ id: i, body: noise(300, 104729 + i) })),
      compressible: Array.from({ length: 300 }, (_, i) => ({ id: i, body: 'hello world '.repeat(40) })),
      oversize_pages: Array.from({ length: 24 }, (_, i) => ({ id: i, body: noise(120_000, 15485863 + i) })),
    }
    for (const [name, rows] of Object.entries(shapes)) {
      const files = await writeThroughCache(path.join(dir, name), rows)
      /** @type {Record<string, any>[]} */
      let readBack = []
      for (const file of files) {
        readBack = readBack.concat(await parquetReadObjects({
          file: await asyncBufferFromFile(file),
          compressors,
        }))
      }
      readBack.sort((a, b) => Number(a.id) - Number(b.id))
      assert.equal(readBack.length, rows.length, `${name}: row count`)
      for (let i = 0; i < rows.length; i++) {
        assert.equal(Number(readBack[i].id), rows[i].id, `${name}: id at ${i}`)
        assert.equal(readBack[i].body ?? null, rows[i].body, `${name}: body at ${i}`)
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
