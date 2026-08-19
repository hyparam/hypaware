// @ts-check

import { parentPort } from 'node:worker_threads'

import { parquetMetadataAsync, parquetSchema } from 'hyparquet'
import { ByteWriter } from 'hyparquet-writer'
import { createIndex } from 'hypgrep'

import { SEARCHABLE_COLUMNS } from './searchable_columns.js'

/**
 * The worker end of the grep sidecar build, ported from the server's
 * `index-worker-thread.js`. One message is one sidecar: source bytes in,
 * index bytes out, both moved by transfer, so neither multi-megabyte
 * buffer is duplicated to cross the thread boundary. Transfer is not the
 * same as never copying: `getBuffer()` slices the writer's backing store,
 * so the index is copied once here before it is handed to the transfer
 * list, and a source the caller could not transfer outright was copied
 * once on the way in.
 *
 * This thread does no IO. It never opens the cache and never writes a
 * sidecar: the caller reads the source and performs the single
 * write-then-rename that publishes the result. That is what keeps sidecar
 * existence honest as the completion marker (LLP 0264 #lifecycle) across
 * a thread that can be killed at any instant.
 *
 * @import { FileMetaData, SchemaTree } from 'hyparquet'
 */

if (!parentPort) throw new Error('index_worker_thread must be started as a worker thread')
const port = parentPort

port.on('message', (/** @type {{ id: number, source: ArrayBuffer }} */ message) => {
  void handle(message)
})

/**
 * Build one index and post it back. Errors travel as a message, not as an
 * uncaught rejection: a source file the builder cannot parse must fail
 * that one file, not tear down the thread mid-pass.
 *
 * @param {{ id: number, source: ArrayBuffer }} message
 */
async function handle({ id, source }) {
  try {
    const bytes = new Uint8Array(source)
    // hypgrep reads through an AsyncBuffer; the whole file is already
    // resident, so slicing is a copy out of memory.
    const sourceFile = {
      byteLength: bytes.byteLength,
      /**
       * @param {number} [start]
       * @param {number} [end]
       * @returns {ArrayBuffer}
       */
      slice(start, end) {
        const view = bytes.subarray(start ?? 0, end ?? bytes.byteLength)
        const out = new ArrayBuffer(view.byteLength)
        new Uint8Array(out).set(view)
        return out
      },
    }
    const indexFile = new ByteWriter()
    const metadata = await parquetMetadataAsync(sourceFile)
    // @ref LLP 0264#shared [implements]: only the searchable columns are indexed; hypgrep's default would n-gram every string column, and the server measured system_text alone at 90.8% of decoded index text
    const textColumns = searchableStringColumns(metadata)
    await createIndex({ sourceFile, sourceMetadata: metadata, indexFile, textColumns })
    const index = indexFile.getBuffer()
    port.postMessage({ id, index }, [index])
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    port.postMessage({ id, error })
  }
}

/**
 * The source's string leaf columns narrowed to the searchable set, in
 * schema order. hypgrep's root export offers no schema walk, so the
 * string-leaf test (UTF8 converted type or STRING logical type on a
 * childless node) is restated here against the same hyparquet schema tree
 * hypgrep itself reads. A source none of whose string columns are
 * searchable fails loudly: building an index that can never match is a
 * misconfiguration, not a degenerate success. The caller isolates the
 * throw, counts it against this file, and quarantines it after the
 * attempt budget; search still serves the file by scanning.
 *
 * @param {FileMetaData} metadata
 * @returns {string[]}
 */
function searchableStringColumns(metadata) {
  /** @type {string[]} */
  const stringColumns = []
  /** @param {SchemaTree} node */
  function walk(node) {
    const { element, children } = node
    const isString = element.converted_type === 'UTF8' || element.logical_type?.type === 'STRING'
    if (isString && children.length === 0) stringColumns.push(element.name)
    for (const child of children) walk(child)
  }
  walk(parquetSchema(metadata))
  const textColumns = stringColumns.filter((name) => SEARCHABLE_COLUMNS.has(name))
  if (textColumns.length === 0) {
    throw new Error(`source has no searchable string columns (string columns: ${stringColumns.join(', ') || 'none'})`)
  }
  return textColumns
}
