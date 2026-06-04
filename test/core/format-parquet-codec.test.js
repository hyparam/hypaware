// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { resolveEncodeSettings } from '../../hypaware-core/plugins-workspace/format-parquet/src/index.js'

const ZSTD_AVAILABLE = typeof zlib.zstdCompressSync === 'function'

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

test('resolveEncodeSettings defaults to SNAPPY with no explicit compressors', () => {
  const { logger, warnings } = fakeLogger()
  const r = resolveEncodeSettings(undefined, logger)
  assert.equal(r.codec, 'SNAPPY')
  // SNAPPY is supplied by hyparquet-writer's own default compressors.
  assert.equal(r.compressors, undefined)
  assert.equal(r.pageSize, undefined)
  assert.equal(warnings.length, 0)
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
  assert.equal(r.compressors, undefined)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].fields.fallback_codec, 'SNAPPY')
})

test('resolveEncodeSettings warns and falls back on an unknown codec', () => {
  const { logger, warnings } = fakeLogger()
  const r = resolveEncodeSettings({ codec: 'BROTLI' }, logger)
  assert.equal(r.codec, 'SNAPPY')
  assert.equal(r.compressors, undefined)
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
