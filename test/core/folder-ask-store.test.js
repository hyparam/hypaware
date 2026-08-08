// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readObservabilityEnv } from '../../src/core/observability/env.js'
import {
  DEFAULT_FOLDER_ASK_MODE,
  FolderAskUnreadableError,
  folderAskPath,
  isFolderAskMode,
  readFolderAskMode,
  readFolderAskModeSafe,
  writeFolderAskMode,
} from '../../src/core/usage-policy/folder_ask.js'

// The machine-local new-folder preference (LLP 0200): the store behind
// `hyp policy folders` and the wizard's sync gate. Absence is today's
// behavior; a corrupt file is loud for the CLI and quiet-but-asking for the
// session-start hook.
// @ref LLP 0200#store [tests]:
// @ref LLP 0200#fail-safe [tests]:

async function makeState() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-folder-ask-'))
  return { hypHome, stateDir: readObservabilityEnv({ HYP_HOME: hypHome }).stateDir }
}

test('the preference lives beside its sibling stores under HYP_HOME state', async () => {
  const { stateDir } = await makeState()
  const filePath = folderAskPath(stateDir)
  assert.equal(path.dirname(filePath), path.join(stateDir, 'usage-policy'))
  assert.equal(path.basename(filePath), 'folder-ask.json')
  assert.throws(() => folderAskPath(''), /stateDir is required/)
})

test('an absent preference reads as the product default: new folders sync, nobody is asked', async () => {
  const { stateDir } = await makeState()
  assert.equal(DEFAULT_FOLDER_ASK_MODE, 'sync')
  assert.equal(await readFolderAskMode({ stateDir }), 'sync')
  assert.equal(await readFolderAskModeSafe({ stateDir }), 'sync')
  await assert.rejects(fs.access(folderAskPath(stateDir)), 'reading never creates the file')
})

test('a written preference round-trips, and both modes are writable', async () => {
  const { stateDir } = await makeState()
  assert.equal(await writeFolderAskMode({ stateDir, mode: 'sync' }), 'sync')
  assert.equal(await readFolderAskMode({ stateDir }), 'sync')
  assert.deepEqual(JSON.parse(await fs.readFile(folderAskPath(stateDir), 'utf8')), { version: 1, mode: 'sync' })
  await writeFolderAskMode({ stateDir, mode: 'ask' })
  assert.equal(await readFolderAskMode({ stateDir }), 'ask')
})

test('an unknown mode is refused at the write, never persisted', async () => {
  const { stateDir } = await makeState()
  await assert.rejects(
    writeFolderAskMode({ stateDir, mode: /** @type {any} */ ('never') }),
    /unknown mode never/
  )
  await assert.rejects(fs.access(folderAskPath(stateDir)))
  assert.equal(isFolderAskMode('never'), false)
  assert.equal(isFolderAskMode('sync'), true)
  assert.equal(isFolderAskMode(undefined), false)
})

test('a corrupt or unrecognized file throws rather than resolving to a mode by accident', async () => {
  const { stateDir } = await makeState()
  const filePath = folderAskPath(stateDir)
  await fs.mkdir(path.dirname(filePath), { recursive: true })

  for (const body of ['{ nope', '{"version":2,"mode":"sync"}', '{"version":1,"mode":"whatever"}', '[]', 'null']) {
    await fs.writeFile(filePath, body)
    await assert.rejects(readFolderAskMode({ stateDir }), FolderAskUnreadableError, `body: ${body}`)
    // The hook's reader never throws. A file that *exists* is a preference
    // someone set, so an unreadable one falls to `ask`, not to the default:
    // the only guess that costs anything is "sync" for a user who asked to
    // be asked, and one extra question is the cheap failure.
    assert.equal(await readFolderAskModeSafe({ stateDir }), 'ask', `body: ${body}`)
  }
})

test('the unreadable error carries the file path and an error_kind for telemetry', async () => {
  const { stateDir } = await makeState()
  const filePath = folderAskPath(stateDir)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, 'not json')
  await assert.rejects(readFolderAskMode({ stateDir }), (/** @type {any} */ err) => {
    assert.ok(err instanceof FolderAskUnreadableError)
    assert.equal(err.filePath, filePath)
    assert.equal(err.error_kind, 'folder_ask_unreadable')
    return true
  })
})
