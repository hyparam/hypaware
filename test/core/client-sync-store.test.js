// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  clientSyncListPath,
  readClientSyncEntries,
  writeClientSyncEntries,
  optedOutClientSourceIds,
  seedClientSyncStoreIfAbsent,
  ClientSyncListUnreadableError,
  CLIENT_SYNC_LIST_UNREADABLE_ERROR_KIND,
} from '../../src/core/usage-policy/client_sync.js'

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-client-sync-'))
}

// --- clientSyncListPath -----------------------------------------------------

test('clientSyncListPath derives <stateDir>/usage-policy/client-sync.json', () => {
  assert.equal(
    clientSyncListPath('/state'),
    path.join('/state', 'usage-policy', 'client-sync.json')
  )
})

test('clientSyncListPath requires a stateDir', () => {
  assert.throws(() => clientSyncListPath(''))
})

// --- absent vs empty (the LLP 0188 migration marker) ------------------------

test('readClientSyncEntries returns null when the store has never been written', async () => {
  const stateDir = await makeTmpDir()
  assert.equal(await readClientSyncEntries({ stateDir }), null)
})

test('an empty stamped store reads as [], distinct from absent', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [] })
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [])
})

// --- round-trip -------------------------------------------------------------

test('write then read round-trips the entry set', async () => {
  const stateDir = await makeTmpDir()
  const written = await writeClientSyncEntries({
    stateDir,
    entries: [
      { source: 'openclaw', class: 'local-only' },
      { source: 'hermes', class: 'local-only' },
    ],
  })
  assert.deepEqual(written, [
    { source: 'hermes', class: 'local-only' },
    { source: 'openclaw', class: 'local-only' },
  ])
  assert.deepEqual(await readClientSyncEntries({ stateDir }), written)
})

test('writeClientSyncEntries persists the version-1 shape', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  const raw = await fs.readFile(clientSyncListPath(stateDir), 'utf8')
  assert.deepEqual(JSON.parse(raw), {
    version: 1,
    entries: [{ source: 'hermes', class: 'local-only' }],
  })
})

test('writeClientSyncEntries dedupes by source (later wins) and sorts', async () => {
  const stateDir = await makeTmpDir()
  const written = await writeClientSyncEntries({
    stateDir,
    entries: [
      { source: 'zeta', class: 'local-only' },
      { source: 'alpha', class: 'local-only' },
      { source: 'zeta', class: 'local-only' },
    ],
  })
  assert.deepEqual(written.map((e) => e.source), ['alpha', 'zeta'])
})

// --- optedOutClientSourceIds -------------------------------------------------

test('optedOutClientSourceIds lists sources from entries and treats null as none', () => {
  assert.deepEqual(
    optedOutClientSourceIds([
      { source: 'hermes', class: 'local-only' },
      { source: 'openclaw', class: 'local-only' },
    ]),
    ['hermes', 'openclaw']
  )
  assert.deepEqual(optedOutClientSourceIds(null), [])
  assert.deepEqual(optedOutClientSourceIds([]), [])
})

// --- corrupt => throw --------------------------------------------------------

test('readClientSyncEntries throws ClientSyncListUnreadableError on unparseable JSON', async () => {
  const stateDir = await makeTmpDir()
  await fs.mkdir(path.dirname(clientSyncListPath(stateDir)), { recursive: true })
  await fs.writeFile(clientSyncListPath(stateDir), '{ not valid json', 'utf8')

  await assert.rejects(
    () => readClientSyncEntries({ stateDir }),
    (err) => {
      assert.ok(err instanceof ClientSyncListUnreadableError)
      assert.equal(err.error_kind, CLIENT_SYNC_LIST_UNREADABLE_ERROR_KIND)
      assert.equal(err.error_kind, 'client_sync_list_unreadable')
      assert.equal(err.filePath, clientSyncListPath(stateDir))
      return true
    }
  )
})

test('readClientSyncEntries throws on a wrong-shape file', async () => {
  const stateDir = await makeTmpDir()
  await fs.mkdir(path.dirname(clientSyncListPath(stateDir)), { recursive: true })
  await fs.writeFile(
    clientSyncListPath(stateDir),
    JSON.stringify({ version: 2, entries: [{ source: 'x', class: 'local-only' }] }),
    'utf8'
  )
  await assert.rejects(() => readClientSyncEntries({ stateDir }), ClientSyncListUnreadableError)
})

test('readClientSyncEntries throws when an entry has an unknown class or empty source', async () => {
  const stateDir = await makeTmpDir()
  await fs.mkdir(path.dirname(clientSyncListPath(stateDir)), { recursive: true })
  await fs.writeFile(
    clientSyncListPath(stateDir),
    JSON.stringify({ version: 1, entries: [{ source: 'x', class: 'ignore' }] }),
    'utf8'
  )
  await assert.rejects(() => readClientSyncEntries({ stateDir }), ClientSyncListUnreadableError)

  await fs.writeFile(
    clientSyncListPath(stateDir),
    JSON.stringify({ version: 1, entries: [{ source: '', class: 'local-only' }] }),
    'utf8'
  )
  await assert.rejects(() => readClientSyncEntries({ stateDir }), ClientSyncListUnreadableError)
})

// --- seedClientSyncStoreIfAbsent ---------------------------------------------

test('seedClientSyncStoreIfAbsent stamps an empty store once and is idempotent', async () => {
  const stateDir = await makeTmpDir()
  assert.equal(await seedClientSyncStoreIfAbsent({ stateDir }), true)
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [])
  assert.equal(await seedClientSyncStoreIfAbsent({ stateDir }), false)
})

test('seedClientSyncStoreIfAbsent never clobbers an existing entry list', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'hermes', class: 'local-only' }] })
  assert.equal(await seedClientSyncStoreIfAbsent({ stateDir }), false)
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'hermes', class: 'local-only' },
  ])
})

// --- atomic replace ----------------------------------------------------------

test('writeClientSyncEntries is atomic write-rename and leaves no temp files', async () => {
  const stateDir = await makeTmpDir()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'a', class: 'local-only' }] })
  const dir = path.dirname(clientSyncListPath(stateDir))
  const entries = await fs.readdir(dir)
  assert.ok(entries.every((e) => !e.includes('.tmp.')), `no temp file should survive: ${entries}`)
})
