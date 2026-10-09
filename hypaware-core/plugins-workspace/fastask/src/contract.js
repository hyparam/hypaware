// @ts-check

import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

/**
 * @import { CompressedSource, MeasuredFile, SetDigest, SnapshotFileFacts, SnapshotFiles, SnapshotVerification } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

/**
 * The client side of the server's `hypaware.graph-snapshot/1` wire contract
 * (server LLP 0554#contract, readings settled by server LLP 0560): how a graph
 * row becomes one NDJSON line, the order-independent set digest over those
 * lines, and a streaming verifier that checks served files against their
 * manifest before a replica is activated.
 *
 * Ported from the server's reference module `src/graph/snapshot-contract.js`
 * at the commit recorded in `test/fixtures/contracts/graph-snapshot/v1/SOURCE.md`.
 * The function bodies are unchanged; only the type declarations moved to
 * `types.d.ts` for this repository's style. The pinned fixtures win over this
 * file and over prose when they disagree.
 *
 * Pure apart from `node:crypto` and `node:zlib`: no IO and no kernel imports.
 *
 * @ref LLP 0480#sync [implements]: the verify step (compressed SHA-256, rows, set digest) before activation
 */

export const PROTOCOL = 'hypaware.graph-snapshot/1'
export const PROTOCOL_MAJOR = 1
export const SCHEMA_VERSION = 1
export const ID_RECIPE = 'sha256-trunc24/v1'

/** Exact column order of every node line (server LLP 0554#manifest). */
export const NODE_COLUMNS = Object.freeze([
  'node_id', 'node_type', 'natural_key', 'label', 'props', 'first_seen',
  'source_dataset', 'source_keys', 'projector', 'projector_version',
])

/** Exact column order of every edge line (server LLP 0554#manifest). */
export const EDGE_COLUMNS = Object.freeze([
  'edge_id', 'edge_type', 'src_id', 'dst_id', 'src_type', 'dst_type', 'props',
  'first_seen', 'source_dataset', 'source_keys', 'projector', 'projector_version',
])

const JSON_COLUMNS = new Set(['props', 'source_keys'])
const TIMESTAMP_COLUMNS = new Set(['first_seen'])
const INTEGER_COLUMNS = new Set(['projector_version'])

/**
 * Encodes one row as a contract line, without the trailing newline.
 *
 * Every named column appears, in the given order. Absent values become
 * `null`; JSON columns (`props`, `source_keys`) are emitted as parsed JSON,
 * so a stored JSON string is parsed first; `first_seen` becomes ISO-8601 UTC
 * with milliseconds; `projector_version` is an integer; every other column
 * must be a string. Anything else throws, so a schema drift fails the build
 * instead of shipping a line the client cannot read.
 *
 * Output is `JSON.stringify`: non-ASCII text is raw UTF-8 and a lone
 * surrogate is escaped, so every line is valid UTF-8 and contains no newline.
 *
 * @param {Record<string, unknown>} row
 * @param {ReadonlyArray<string>} columns
 * @returns {string}
 */
export function encodeLine(row, columns) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const column of columns) out[column] = encodeValue(column, row[column])
  return JSON.stringify(out)
}

/**
 * @param {string} column
 * @param {unknown} value
 * @returns {unknown}
 */
function encodeValue(column, value) {
  if (value === undefined || value === null) return null
  if (JSON_COLUMNS.has(column)) {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      throw new TypeError(`graph snapshot: column ${column} holds text that is not JSON`)
    }
  }
  if (TIMESTAMP_COLUMNS.has(column)) {
    const date = value instanceof Date ? value
      : typeof value === 'number' || typeof value === 'string' ? new Date(value)
        : null
    if (!date || Number.isNaN(date.getTime())) {
      throw new TypeError(`graph snapshot: column ${column} is not a timestamp`)
    }
    return date.toISOString()
  }
  if (INTEGER_COLUMNS.has(column)) {
    const number = typeof value === 'bigint' ? Number(value) : value
    if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
      throw new TypeError(`graph snapshot: column ${column} is not an integer`)
    }
    return number
  }
  if (typeof value !== 'string') throw new TypeError(`graph snapshot: column ${column} is not a string`)
  return value
}

/**
 * Accumulates the set digest of one file: the sum modulo 2^256 of SHA-256
 * over each line's bytes (without its newline), hex big-endian. Addition
 * commutes, so line order does not matter and equal digests mean equal line
 * sets. State is eight 32-bit words, whatever the row count.
 *
 * @returns {SetDigest}
 */
export function createSetDigest() {
  // acc[0] is the most significant word.
  const acc = new Uint32Array(8)
  let rows = 0
  return {
    add(line) {
      const digest = createHash('sha256').update(line).digest()
      let carry = 0
      for (let i = 7; i >= 0; i--) {
        const sum = acc[i] + digest.readUInt32BE(i * 4) + carry
        acc[i] = sum >>> 0
        carry = sum > 0xffffffff ? 1 : 0
      }
      rows++
    },
    get rows() { return rows },
    hex() {
      let hex = ''
      for (const word of acc) hex += word.toString(16).padStart(8, '0')
      return hex
    },
  }
}

/**
 * Measures a compressed file exactly as served: SHA-256 and length of the
 * compressed bytes, then, while decompressing, line count, decompressed
 * length and set digest. Streams: memory is one chunk plus one partial line.
 *
 * `problems` reports format faults found on the way (not gzip, an empty line,
 * a missing final newline); facts are still returned for what was read.
 *
 * @param {CompressedSource} source
 * @returns {Promise<MeasuredFile>}
 */
export async function measureFile(source) {
  /** @type {string[]} */
  const problems = []
  const fileHash = createHash('sha256')
  const digest = createSetDigest()
  let bytes = 0
  let uncompressedBytes = 0
  let emptyLines = 0
  /** @type {Buffer[]} */
  let pending = []

  /** @param {AsyncIterable<Uint8Array>} chunks */
  async function* countCompressed(chunks) {
    for await (const chunk of chunks) {
      fileHash.update(chunk)
      bytes += chunk.byteLength
      yield chunk
    }
  }

  /** @param {AsyncIterable<Buffer>} chunks */
  async function splitLines(chunks) {
    for await (const chunk of chunks) {
      uncompressedBytes += chunk.byteLength
      let start = 0
      let newline
      while ((newline = chunk.indexOf(0x0a, start)) !== -1) {
        const tail = chunk.subarray(start, newline)
        const line = pending.length === 0 ? tail : Buffer.concat([...pending, tail])
        pending = []
        if (line.byteLength === 0) emptyLines++
        else digest.add(line)
        start = newline + 1
      }
      if (start < chunk.byteLength) pending.push(chunk.subarray(start))
    }
  }

  try {
    await pipeline(asIterable(source), countCompressed, createGunzip(), splitLines)
  } catch (err) {
    problems.push(`not a readable gzip stream (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'})`)
  }
  if (problems.length === 0 && pending.length > 0) {
    // Counted and digested so the row comparison still means something.
    digest.add(Buffer.concat(pending))
    problems.push('last line has no trailing newline')
  }
  if (emptyLines > 0) problems.push(`${emptyLines} empty line(s)`)

  return {
    facts: {
      rows: digest.rows,
      bytes,
      uncompressed_bytes: uncompressedBytes,
      sha256: fileHash.digest('hex'),
      set_digest: digest.hex(),
    },
    problems,
  }
}

/**
 * @param {CompressedSource} source
 * @returns {AsyncIterable<Uint8Array>}
 */
async function* asIterable(source) {
  if (source instanceof Uint8Array) {
    yield source
    return
  }
  yield* source
}

/**
 * Verifies a downloaded generation against its manifest before a client
 * activates it. `nodes` and `edges` are the compressed bytes as served (a
 * buffer, or a stream of chunks); the two files are read one after the
 * other, so memory stays at one chunk, one partial line and one digest
 * accumulator.
 *
 * Checks the protocol, schema version, id recipe and column order, then for
 * each file its `path`, `rows`, `bytes`, `uncompressed_bytes`, `sha256` and
 * `set_digest`.
 * It does not recompute `unresolved` (that needs every node id) and does not
 * parse lines; the importer parses as it loads.
 *
 * @param {SnapshotFiles} files
 * @returns {Promise<SnapshotVerification>}
 */
export async function verifyManifest(files) {
  const { manifest } = files
  /** @type {string[]} */
  const problems = []
  /** @type {Partial<Record<'nodes' | 'edges', SnapshotFileFacts>>} */
  const observed = {}

  if (manifest?.protocol !== PROTOCOL) problems.push(`protocol is ${JSON.stringify(manifest?.protocol)}, expected ${PROTOCOL}`)
  const schema = manifest?.schema
  if (schema?.schema_version !== SCHEMA_VERSION) problems.push(`schema.schema_version ${JSON.stringify(schema?.schema_version)} is not supported`)
  if (schema?.id_recipe !== ID_RECIPE) problems.push(`schema.id_recipe ${JSON.stringify(schema?.id_recipe)} is not supported`)
  if (!sameColumns(schema?.node_columns, NODE_COLUMNS)) problems.push('schema.node_columns differ from the v1 node columns')
  if (!sameColumns(schema?.edge_columns, EDGE_COLUMNS)) problems.push('schema.edge_columns differ from the v1 edge columns')

  for (const name of /** @type {const} */ (['nodes', 'edges'])) {
    const expected = manifest?.files?.[name]
    if (!expected || typeof expected !== 'object') {
      problems.push(`files.${name} is missing`)
      continue
    }
    const path = `generations/${manifest.generation}/${name}.ndjson.gz`
    if (expected.path !== path) problems.push(`${name}: path is ${JSON.stringify(expected.path)}, expected ${JSON.stringify(path)}`)
    const { facts, problems: fileProblems } = await measureFile(files[name])
    observed[name] = facts
    for (const problem of fileProblems) problems.push(`${name}: ${problem}`)
    for (const key of /** @type {const} */ (['rows', 'bytes', 'uncompressed_bytes', 'sha256', 'set_digest'])) {
      if (expected[key] !== facts[key]) {
        problems.push(`${name}: ${key} is ${JSON.stringify(facts[key])}, manifest says ${JSON.stringify(expected[key])}`)
      }
    }
  }
  return { ok: problems.length === 0, problems, observed }
}

/**
 * @param {unknown} actual
 * @param {ReadonlyArray<string>} expected
 * @returns {boolean}
 */
function sameColumns(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((c, i) => c === expected[i])
}

/**
 * The manifest's ETag: the generation in quotes (server LLP 0554#manifest).
 *
 * @param {string} generation
 * @returns {string}
 */
export function manifestEtag(generation) {
  return `"${generation}"`
}

/**
 * A data file's ETag: its compressed SHA-256 (server LLP 0554#data-files).
 *
 * @param {string} sha256
 * @returns {string}
 */
export function dataFileEtag(sha256) {
  return `"sha256:${sha256}"`
}
