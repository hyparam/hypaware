// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  localOnlyListPath,
  readLocalOnlyDirs,
  writeLocalOnlyDirs,
  LocalOnlyListUnreadableError,
  LOCAL_ONLY_LIST_UNREADABLE_ERROR_KIND,
} from '../../src/core/usage-policy/local_only.js'

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-local-only-'))
}

// --- localOnlyListPath ----------------------------------------------------

test('localOnlyListPath derives <stateDir>/usage-policy/local-only.json', () => {
  assert.equal(
    localOnlyListPath('/state'),
    path.join('/state', 'usage-policy', 'local-only.json')
  )
})

test('localOnlyListPath requires a stateDir', () => {
  assert.throws(() => localOnlyListPath(''))
})

// --- readLocalOnlyDirs: missing file ---------------------------------------

test('readLocalOnlyDirs returns [] when the list has never been written (the common case)', async () => {
  const stateDir = await makeTmpDir()
  assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [])
})

// --- round-trip -------------------------------------------------------------

test('writeLocalOnlyDirs then readLocalOnlyDirs round-trips the directory set', async () => {
  const stateDir = await makeTmpDir()
  const dirA = path.join(stateDir, 'side-project')
  const dirB = path.join(stateDir, 'clients', 'acme')

  const written = await writeLocalOnlyDirs({ stateDir, dirs: [dirA, dirB] })
  assert.deepEqual(written, [dirA, dirB].sort())

  const read = await readLocalOnlyDirs({ stateDir })
  assert.deepEqual(read, [dirA, dirB].sort())
})

test('writeLocalOnlyDirs persists the LLP 0071 on-disk shape', async () => {
  const stateDir = await makeTmpDir()
  const dir = path.join(stateDir, 'proj')
  await writeLocalOnlyDirs({ stateDir, dirs: [dir] })

  const raw = await fs.readFile(localOnlyListPath(stateDir), 'utf8')
  const parsed = JSON.parse(raw)
  assert.deepEqual(parsed, { version: 1, dirs: [dir] })
})

// --- dedupe / normalize ------------------------------------------------------

test('writeLocalOnlyDirs normalizes to absolute paths, dedupes, and sorts', async () => {
  const stateDir = await makeTmpDir()
  const relative = path.join('nested', 'dir')
  const absoluteEquivalent = path.resolve(relative)
  const other = path.join(stateDir, 'zzz-last')
  const first = path.join(stateDir, 'aaa-first')

  const written = await writeLocalOnlyDirs({
    stateDir,
    // duplicate entries (relative + its absolute equivalent) must collapse
    dirs: [other, relative, first, absoluteEquivalent],
  })

  assert.deepEqual(written, [first, absoluteEquivalent, other].sort())
  assert.equal(written.length, 3, 'the relative/absolute duplicate collapses to one entry')
  assert.deepEqual(written, [...written].sort(), 'result is sorted')
})

test('readLocalOnlyDirs re-normalizes a hand-edited file with duplicates/relative-looking entries', async () => {
  const stateDir = await makeTmpDir()
  const dir = path.join(stateDir, 'dup')
  await fs.mkdir(path.dirname(localOnlyListPath(stateDir)), { recursive: true })
  await fs.writeFile(
    localOnlyListPath(stateDir),
    JSON.stringify({ version: 1, dirs: [dir, dir] }),
    'utf8'
  )
  assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [dir])
})

// --- corrupt => throw --------------------------------------------------------

test('readLocalOnlyDirs throws LocalOnlyListUnreadableError on unparseable JSON', async () => {
  const stateDir = await makeTmpDir()
  await fs.mkdir(path.dirname(localOnlyListPath(stateDir)), { recursive: true })
  await fs.writeFile(localOnlyListPath(stateDir), '{ not valid json', 'utf8')

  await assert.rejects(
    () => readLocalOnlyDirs({ stateDir }),
    (err) => {
      assert.ok(err instanceof LocalOnlyListUnreadableError)
      assert.equal(err.error_kind, LOCAL_ONLY_LIST_UNREADABLE_ERROR_KIND)
      assert.equal(err.error_kind, 'local_only_list_unreadable')
      assert.equal(err.filePath, localOnlyListPath(stateDir))
      return true
    }
  )
})

test('readLocalOnlyDirs throws LocalOnlyListUnreadableError on a wrong-shape file', async () => {
  const stateDir = await makeTmpDir()
  await fs.mkdir(path.dirname(localOnlyListPath(stateDir)), { recursive: true })
  await fs.writeFile(
    localOnlyListPath(stateDir),
    JSON.stringify({ version: 2, dirs: ['/a'] }),
    'utf8'
  )
  await assert.rejects(() => readLocalOnlyDirs({ stateDir }), LocalOnlyListUnreadableError)
})

test('readLocalOnlyDirs throws LocalOnlyListUnreadableError when dirs is not a string array', async () => {
  const stateDir = await makeTmpDir()
  await fs.mkdir(path.dirname(localOnlyListPath(stateDir)), { recursive: true })
  await fs.writeFile(
    localOnlyListPath(stateDir),
    JSON.stringify({ version: 1, dirs: [1, 2] }),
    'utf8'
  )
  await assert.rejects(() => readLocalOnlyDirs({ stateDir }), LocalOnlyListUnreadableError)
})

// --- atomic replace -----------------------------------------------------------

test('writeLocalOnlyDirs is atomic write-rename and leaves no temp files', async () => {
  const stateDir = await makeTmpDir()
  await writeLocalOnlyDirs({ stateDir, dirs: [path.join(stateDir, 'a')] })

  const dir = path.dirname(localOnlyListPath(stateDir))
  const entries = await fs.readdir(dir)
  assert.ok(entries.every((e) => !e.includes('.tmp.')), `no temp file should survive: ${entries}`)
})

test('writeLocalOnlyDirs replaces the file in place (latest wins, single file)', async () => {
  const stateDir = await makeTmpDir()
  const first = path.join(stateDir, 'first')
  const second = path.join(stateDir, 'second')

  await writeLocalOnlyDirs({ stateDir, dirs: [first] })
  await writeLocalOnlyDirs({ stateDir, dirs: [second] })

  assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [second])

  const dir = path.dirname(localOnlyListPath(stateDir))
  const entries = await fs.readdir(dir)
  assert.deepEqual(entries, ['local-only.json'], 'one file, no accumulation')
})

test('writeLocalOnlyDirs mkdir -p s the usage-policy parent directory on demand', async () => {
  const stateDir = await makeTmpDir()
  // stateDir exists but usage-policy/ does not yet.
  await assert.doesNotReject(() => fs.access(stateDir))
  await assert.rejects(() => fs.access(path.dirname(localOnlyListPath(stateDir))))

  await writeLocalOnlyDirs({ stateDir, dirs: [] })
  await assert.doesNotReject(() => fs.access(path.dirname(localOnlyListPath(stateDir))))
  assert.deepEqual(await readLocalOnlyDirs({ stateDir }), [])
})
