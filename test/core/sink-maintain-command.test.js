// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fileCatalog,
  icebergAppend,
  icebergCreateTable,
  icebergRead,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import {
  createBlobStoreIO,
  tableUrlForBlobPrefix,
} from '../../hypaware-core/plugins-workspace/format-iceberg/src/blob-io.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'

/**
 * @import { BlobStore } from '../../collectivus-plugin-kernel-types.d.ts'
 */

const DATASET = 'maintain_rows'
const PREFIX = 'iceberg/datasets'

/**
 * In-memory BlobStore speaking the same conditional-write protocol the
 * iceberg blob-io adapter expects: a conflicting `ifNoneMatch: '*'` put
 * throws `errorKind: 'blob_precondition_failed'`.
 *
 * @returns {BlobStore & { objects: Map<string, Uint8Array> }}
 */
function makeMemoryBlobStore() {
  /** @type {Map<string, Uint8Array>} */
  const objects = new Map()
  return {
    kind: 'memory',
    objects,
    async putObject(input) {
      if (input.ifNoneMatch === '*' && objects.has(input.key)) {
        const err = /** @type {Error & { errorKind: string }} */ (
          new Error(`object already exists at '${input.key}'`)
        )
        err.errorKind = 'blob_precondition_failed'
        throw err
      }
      objects.set(input.key, input.body)
      return { key: input.key }
    },
    async getObject(input) {
      const bytes = objects.get(input.key)
      if (!bytes) return null
      return { body: bytes, contentLength: bytes.byteLength }
    },
    listObjects(input) {
      const prefix = input?.prefix ?? ''
      const keys = Array.from(objects.keys())
        .filter((key) => key.startsWith(prefix))
        .sort()
      return {
        async *[Symbol.asyncIterator]() {
          for (const key of keys) {
            const bytes = objects.get(key)
            yield { key, size: bytes?.byteLength ?? 0 }
          }
        },
      }
    },
    async deleteObject(input) {
      objects.delete(input.key)
    },
  }
}

/**
 * Create a real 2-data-file iceberg table in the memory blob store at
 * `<PREFIX>/<DATASET>` so `hyp sink maintain` discovers and (with
 * --compact + compact_file_count=2) rewrites it.
 *
 * @param {BlobStore} blobStore
 */
async function seedTable(blobStore) {
  const tableUrl = tableUrlForBlobPrefix(`${PREFIX}/${DATASET}`)
  const { resolver, lister } = await createBlobStoreIO(blobStore)
  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  const schema = {
    type: /** @type {const} */ ('struct'),
    'schema-id': 0,
    fields: [
      { id: 1, name: 'id', required: true, type: /** @type {const} */ ('long') },
      { id: 2, name: 'value', required: false, type: /** @type {const} */ ('string') },
    ],
  }
  await icebergCreateTable({ catalog, tableUrl, schema, formatVersion: 3 })
  await icebergAppend({ catalog, tableUrl, records: [{ id: 1n, value: 'a' }, { id: 2n, value: 'b' }] })
  await icebergAppend({ catalog, tableUrl, records: [{ id: 3n, value: 'c' }] })
  return { tableUrl, resolver, lister }
}

/**
 * @param {BlobStore} blobStore
 * @param {{ compact_file_count?: number }} [maintenance]
 */
function makeHandle(blobStore, maintenance) {
  return {
    kind: 'table-format',
    tableFormat: 'iceberg',
    instanceName: 'lake',
    blobStore,
    config: { prefix: PREFIX, maintenance: { compact_file_count: 2, ...maintenance } },
  }
}

/**
 * Run the registered `sink maintain` command body the same way dispatch
 * would, against a fake CommandRunContext carrying the sink handles.
 *
 * @param {string[]} argv
 * @param {object[]} handles
 */
async function runMaintain(argv, handles) {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const command = registry.get('sink maintain')
  assert.ok(command, 'sink maintain is registered')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    sinks: { listHandles: () => handles },
  })
  const code = await command.run(argv, ctx)
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

function makeBuf() {
  let value = ''
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * @param {{ tableUrl: string, resolver: any, lister: any }} io
 */
async function dataFileCount({ tableUrl, resolver, lister }) {
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  const currentId = metadata['current-snapshot-id']
  const snapshot = metadata.snapshots?.find((s) => String(s['snapshot-id']) === String(currentId))
  return Number(snapshot?.summary?.['total-data-files'] ?? NaN)
}

test('sink maintain without --compact never rewrites and exits 0', async () => {
  const blobStore = makeMemoryBlobStore()
  const io = await seedTable(blobStore)

  const { code, stdout } = await runMaintain([], [makeHandle(blobStore)])
  assert.equal(code, 0)
  assert.match(stdout, /data-file compaction is out-of-band: re-run with --compact/)
  assert.doesNotMatch(stdout, /compacted \d/)
  assert.equal(await dataFileCount(io), 2, 'table untouched by the default maintain path')
})

test('sink maintain --compact rewrites past the configured threshold and exits 0', async () => {
  const blobStore = makeMemoryBlobStore()
  const io = await seedTable(blobStore)

  const { code, stdout } = await runMaintain(['--compact'], [makeHandle(blobStore)])
  assert.equal(code, 0)
  assert.match(stdout, /lake\/maintain_rows: .*compacted 2 -> 1 data files/)
  assert.match(stdout, /1 tables compacted/)
  assert.equal(await dataFileCount(io), 1, 'rewrite consolidated the data files')

  const { metadata } = await loadLatestFileCatalogMetadata(io)
  const rows = await icebergRead({ tableUrl: io.tableUrl, metadata, resolver: io.resolver })
  assert.deepEqual(
    rows.map((r) => ({ id: r.id, value: r.value })).sort((a, b) => Number(a.id - b.id)),
    [{ id: 1n, value: 'a' }, { id: 2n, value: 'b' }, { id: 3n, value: 'c' }],
    'every row survives the CLI-driven rewrite'
  )
})

test('sink maintain --compact reports a commit conflict and exits 0', async () => {
  const blobStore = makeMemoryBlobStore()
  await seedTable(blobStore)

  // Lose the race on the rewrite's conditional metadata commit: the
  // dataset's table already has v1..v3, so the rewrite targets v4.
  let armed = true
  const conflicting = /** @type {BlobStore} */ ({
    ...blobStore,
    async putObject(input) {
      if (armed && input.ifNoneMatch === '*' && /metadata\/v\d+\.metadata\.json$/.test(input.key)) {
        armed = false
        const err = /** @type {Error & { errorKind: string }} */ (
          new Error(`object already exists at '${input.key}'`)
        )
        err.errorKind = 'blob_precondition_failed'
        throw err
      }
      return blobStore.putObject(input)
    },
  })

  const { code, stdout, stderr } = await runMaintain(['--compact'], [makeHandle(conflicting)])
  assert.equal(code, 0, 'a lost race is an expected outcome, not a failure')
  assert.match(stdout, /compaction_conflict/)
  assert.equal(stderr, '')
})

test('sink maintain --compact exits 1 when the rewrite fails', async () => {
  const blobStore = makeMemoryBlobStore()
  await seedTable(blobStore)

  const failing = /** @type {BlobStore} */ ({
    ...blobStore,
    async putObject(input) {
      if (input.ifNoneMatch === '*' && /metadata\/v\d+\.metadata\.json$/.test(input.key)) {
        throw new Error('s3 access denied')
      }
      return blobStore.putObject(input)
    },
  })

  const { code, stdout, stderr } = await runMaintain(['--compact'], [makeHandle(failing)])
  assert.equal(code, 1, 'unexpected rewrite errors exit nonzero (LLP 0022)')
  assert.match(stdout, /compaction_failed/)
  assert.match(stdout, /access denied/)
  assert.match(stderr, /1 rewrite\(s\) failed/)
})

test('sink maintain rejects unknown flags with exit 2', async () => {
  const { code, stderr } = await runMaintain(['--frobnicate'], [])
  assert.equal(code, 2)
  assert.match(stderr, /unknown flag '--frobnicate'/)
})
