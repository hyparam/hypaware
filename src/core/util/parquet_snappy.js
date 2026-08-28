// @ts-check

import { snappyCompressor } from 'hysnappy'

/**
 * The process's one hysnappy page compressor, shared by the two parquet
 * write paths in this repo that can be handed a `compressors` map: the
 * sink export encoder and the cache's streaming compaction writer.
 *
 * The other parquet writes in the process deliberately do NOT reach it,
 * and none of them can without an upstream change. Everything that routes
 * through icebird's `writeParquet` takes a `codec` but no
 * `compressors` at all: cache ingest FLUSH (`partition.js` ->
 * `appendRowsToTable`), and `stream_append.js`'s own `legacyAppend`
 * fallback for a table it cannot stream into. The grep sidecar build
 * (`search/index_worker_thread.js`) is hypgrep's `createIndex`, which
 * constructs its own `ParquetWriter` inside the library. So the fast
 * codec reaching "the cache" is the streamed compaction REWRITE, not
 * every byte the cache writes.
 *
 * There are two reasons it is a singleton and not a per-writer value.
 *
 * `snappyCompressor()` instantiates a WASM module and returns a closure
 * over its instance, so building one per encode (or per page) would
 * recompile the module every time and give the speedup back. The instance
 * is safe to share: compression is synchronous with no await inside, so
 * two encodes can never interleave in it, and the hash table it carries
 * between calls is re-validated against the current input rather than
 * trusted. It hands back a copy (`byteArray.slice(...)` out of WASM
 * memory), not a view into it, so a caller may hold the returned page
 * across later calls.
 *
 * The cost of sharing it is a memory FLOOR, and it is worth stating
 * because nothing else here leaks: a WASM memory only ever grows, so the
 * instance ends up sized to the largest page it has ever seen (roughly
 * twice that page, input copy plus output room) and holds it for the life
 * of the daemon. Pages are usually the writer's page size, but a page is
 * cut AFTER the value that overflowed it, so one fat cell (a big `tools`
 * or `content_text` blob) sets the floor for every later write. That is
 * bounded by the same fat-row limits the encoders bound their peak heap
 * with, not unbounded. Which is the second reason for the singleton: two
 * instances would be two floors, each sized to its own worst page, for no
 * gain over one sized to the worse of the two.
 *
 * Instantiation is deferred to first use so that importing this module
 * (or anything that re-exports it) does not build a WASM instance in a
 * process that never writes parquet.
 *
 * @type {((bytes: Uint8Array) => Uint8Array) | null}
 */
let shared = null

/**
 * The `compressors` map to hand a `hyparquet-writer` writer so its SNAPPY
 * pages go through hysnappy's WASM compressor instead of the writer's own
 * JS fallback. Only the SNAPPY entry is supplied: `ParquetWriter` merges
 * `{ SNAPPY: <js fallback>, ...compressors }`, so every other codec keeps
 * whatever the caller or the writer already had.
 *
 * @returns {Record<string, (bytes: Uint8Array) => Uint8Array>}
 */
export function snappyPageCompressors() {
  if (!shared) shared = snappyCompressor()
  return { SNAPPY: shared }
}
