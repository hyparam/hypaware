// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { compressors } from 'hyparquet-compressors'

import { resolveEncodeSettings } from '../../hypaware-core/plugins-workspace/format-parquet/src/index.js'

const ZSTD_AVAILABLE = typeof zlib.zstdCompressSync === 'function'

// The SNAPPY decompressor the query path wires for reads (see
// query/parquet-source.js). `Compressors` types every codec optional, so this
// resolves it once and fails loudly here rather than at each use.
const snappyUncompress = compressors.SNAPPY
if (!snappyUncompress) throw new Error('hyparquet-compressors exposes no SNAPPY decompressor')

/** Collect warn() calls so we can assert graceful-degradation logging. */
function fakeLogger() {
  const warnings = []
  return {
    logger: {
      debug() {},
      info() {},
      warn(message, fields) { warnings.push({ message, fields }) },
      error() {},
    },
    warnings,
  }
}

test('resolveEncodeSettings defaults to hysnappy compression', () => {
  const { logger, warnings } = fakeLogger()
  const r = resolveEncodeSettings(undefined, logger)
  assert.equal(r.codec, 'SNAPPY')
  assert.equal(typeof r.compressors?.SNAPPY, 'function')
  const input = new TextEncoder().encode('hypaware'.repeat(64))
  const out = r.compressors.SNAPPY(input)
  assert.ok(out instanceof Uint8Array)
  assert.deepEqual(snappyUncompress(out, input.length), input)
  assert.equal(r.pageSize, undefined)
  assert.equal(warnings.length, 0)
})

// The write-side codec and the read-side codec are two independent
// implementations of snappy (hysnappy's WASM compressor, hyparquet-compressors'
// decompressor), and Parquet wants RAW snappy blocks, not the framed stream
// format. Round-tripping through the reader the query path actually wires is
// what proves the pages this encoder emits are the pages that path can read;
// a hysnappy-to-hysnappy check would agree with itself either way. The inputs
// are the shapes a page can degenerate to: nothing, one byte, and a page that
// compresses LARGER than its input.
test('the SNAPPY compressor emits raw blocks the read path decodes, at every page size', () => {
  const { logger } = fakeLogger()
  const compress = resolveEncodeSettings(undefined, logger).compressors.SNAPPY
  const incompressible = new Uint8Array(4096)
  for (let i = 0; i < incompressible.length; i++) incompressible[i] = (i * 2654435761 >>> 13) & 0xff
  const cases = [
    new Uint8Array(0),
    new Uint8Array([0]),
    new Uint8Array([0xff, 0x00]),
    incompressible,
    new TextEncoder().encode('hypaware '.repeat(50_000)),
  ]
  for (const input of cases) {
    const out = compress(input)
    assert.ok(out instanceof Uint8Array, `page of ${input.length} bytes compresses to a Uint8Array`)
    assert.deepEqual(snappyUncompress(out, input.length), input, `page of ${input.length} bytes round-trips`)
  }
})

// One compressor instance is shared by every encode in the process (it owns a
// WASM instance, so building one per page would rebuild the module each time).
// Its hash table is never cleared between calls, which is safe only because a
// stale entry is re-validated against the current input; a compressor that got
// that wrong would emit a back-reference into the PREVIOUS page and corrupt
// silently, on a page whose content depends on what was encoded before it.
test('the shared SNAPPY compressor is reusable across pages of different sizes', () => {
  const { logger } = fakeLogger()
  const compress = resolveEncodeSettings(undefined, logger).compressors.SNAPPY
  let seed = 1
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let round = 0; round < 40; round++) {
    const size = 1 + Math.floor(next() * 8192)
    const input = new Uint8Array(size)
    // Alternate a low-entropy alphabet (many back-references) with a high one.
    const alphabet = round % 2 === 0 ? 4 : 256
    for (let i = 0; i < size; i++) input[i] = Math.floor(next() * alphabet)
    assert.deepEqual(snappyUncompress(compress(input), size), input, `round ${round}`)
  }
})

test('resolveEncodeSettings honours codec=ZSTD (case-insensitive) when zstd is available', { skip: !ZSTD_AVAILABLE }, () => {
  const { logger, warnings } = fakeLogger()
  const r = resolveEncodeSettings({ codec: 'zstd' }, logger)
  assert.equal(r.codec, 'ZSTD')
  assert.ok(r.compressors && typeof r.compressors.ZSTD === 'function')
  assert.equal(warnings.length, 0)
  // The compressor actually round-trips through Node's zstd.
  const input = new TextEncoder().encode('hypaware'.repeat(64))
  const out = r.compressors.ZSTD(input)
  assert.ok(out instanceof Uint8Array)
  const back = zlib.zstdDecompressSync(out)
  assert.deepEqual(new Uint8Array(back), input)
})

test('resolveEncodeSettings falls back to SNAPPY and warns when ZSTD is unavailable', { skip: ZSTD_AVAILABLE }, () => {
  const { logger, warnings } = fakeLogger()
  const r = resolveEncodeSettings({ codec: 'ZSTD' }, logger)
  assert.equal(r.codec, 'SNAPPY')
  assert.equal(typeof r.compressors?.SNAPPY, 'function')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].fields.fallback_codec, 'SNAPPY')
})

test('resolveEncodeSettings warns and falls back on an unknown codec', () => {
  const { logger, warnings } = fakeLogger()
  const r = resolveEncodeSettings({ codec: 'BROTLI' }, logger)
  assert.equal(r.codec, 'SNAPPY')
  assert.equal(typeof r.compressors?.SNAPPY, 'function')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].fields.requested_codec, 'BROTLI')
})

test('resolveEncodeSettings passes through a positive page_size and ignores invalid ones', () => {
  const { logger } = fakeLogger()
  assert.equal(resolveEncodeSettings({ page_size: 16 * 1048576 }, logger).pageSize, 16 * 1048576)
  assert.equal(resolveEncodeSettings({ page_size: 0 }, logger).pageSize, undefined)
  assert.equal(resolveEncodeSettings({ page_size: -5 }, logger).pageSize, undefined)
  assert.equal(resolveEncodeSettings({ page_size: 'big' }, logger).pageSize, undefined)
  assert.equal(resolveEncodeSettings({ page_size: 1024.9 }, logger).pageSize, 1024)
})
