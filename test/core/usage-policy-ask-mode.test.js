// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  createUsagePolicyResolver,
  folderAskPath,
  isUnanswered,
  localOnlyListPath,
  readFolderAskMode,
  readLocalOnlyEntries,
  writeFolderAskMode,
  writeLocalOnlyEntries,
} from '../../src/core/usage-policy/index.js'
import { switchFolderAskMode } from '../../src/core/usage-policy/classification.js'

// LLP 0622: with the folder-ask mode on `ask`, a folder nothing governs is not
// collected. These pin the rule at the one place it lives, the shared
// resolver every adapter and the export seam consult.

/**
 * A state dir plus a project dir under it, both outside any repo so no
 * ancestor `.hypignore` can govern the project.
 */
async function makeMachine() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-mode-'))
  const stateDir = path.join(root, 'state')
  const project = path.join(root, 'work', 'project')
  await fs.mkdir(project, { recursive: true })
  return { root, stateDir, project, listPath: localOnlyListPath(stateDir) }
}

test('the default mode leaves an unmarked folder collected', async () => {
  const m = await makeMachine()
  try {
    const result = createUsagePolicyResolver({ localOnlyListPath: m.listPath }).resolve(m.project)
    assert.deepEqual(result, { class: 'full', governedBy: null, declared: null })
    assert.equal(isUnanswered(result), false)
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('an explicit sync mode leaves an unmarked folder collected', async () => {
  const m = await makeMachine()
  try {
    await writeFolderAskMode({ stateDir: m.stateDir, mode: 'sync' })
    assert.equal(createUsagePolicyResolver({ localOnlyListPath: m.listPath }).resolve(m.project).class, 'full')
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('with the ask on, an unmarked folder is not collected and still names no governor', async () => {
  const m = await makeMachine()
  try {
    await writeFolderAskMode({ stateDir: m.stateDir, mode: 'ask' })
    const resolver = createUsagePolicyResolver({ localOnlyListPath: m.listPath })
    const result = resolver.resolve(m.project)
    assert.deepEqual(result, { class: 'ignore', governedBy: null, declared: null })
    assert.equal(resolver.isIgnored(m.project), true)
    assert.equal(isUnanswered(result), true)
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('with the ask on, an explicit marking still wins, whatever its class', async () => {
  const m = await makeMachine()
  try {
    await writeFolderAskMode({ stateDir: m.stateDir, mode: 'ask' })
    const kept = path.join(m.root, 'work', 'kept')
    const local = path.join(m.root, 'work', 'local')
    const dotfile = path.join(m.root, 'work', 'dotfile')
    await fs.mkdir(dotfile, { recursive: true })
    await fs.writeFile(path.join(dotfile, '.hypignore'), '')
    await writeLocalOnlyEntries({
      stateDir: m.stateDir,
      entries: [{ dir: kept, class: 'full' }, { dir: local, class: 'local-only' }],
    })
    const resolver = createUsagePolicyResolver({ localOnlyListPath: m.listPath })

    // "sync" was answered: the explicit `full` entry is what starts collection.
    const answered = resolver.resolve(path.join(kept, 'sub'))
    assert.equal(answered.class, 'full')
    assert.equal(answered.governedBy, m.listPath)

    assert.equal(resolver.resolve(local).class, 'local-only')

    // A marked ignore is an ignore, not a folder waiting for an answer.
    const ignored = resolver.resolve(dotfile)
    assert.equal(ignored.class, 'ignore')
    assert.equal(isUnanswered(ignored), false)
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('an unreadable preference resolves toward not collecting', async () => {
  const m = await makeMachine()
  try {
    const file = folderAskPath(m.stateDir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ not json')
    assert.equal(createUsagePolicyResolver({ localOnlyListPath: m.listPath }).resolve(m.project).class, 'ignore')

    await fs.writeFile(file, JSON.stringify({ version: 1, mode: 'sometimes' }))
    assert.equal(createUsagePolicyResolver({ localOnlyListPath: m.listPath }).resolve(m.project).class, 'ignore')
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('a resolver with no machine-local state has no mode to read', async () => {
  const m = await makeMachine()
  try {
    await writeFolderAskMode({ stateDir: m.stateDir, mode: 'ask' })
    assert.equal(createUsagePolicyResolver().resolve(m.project).class, 'full')
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('the mode is part of the policy fingerprint, and the default keeps the old digest', async () => {
  const m = await makeMachine()
  try {
    const resolver = createUsagePolicyResolver({ localOnlyListPath: m.listPath })
    const before = resolver.fingerprint?.()
    assert.equal(before, 'absent')
    await writeFolderAskMode({ stateDir: m.stateDir, mode: 'ask' })
    assert.notEqual(resolver.fingerprint?.(), before)
    await writeFolderAskMode({ stateDir: m.stateDir, mode: 'sync' })
    assert.equal(resolver.fingerprint?.(), before)
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('a flipped mode is honored within the cache window, and at once after a fingerprint read', async () => {
  const m = await makeMachine()
  try {
    let clock = 1_000
    const resolver = createUsagePolicyResolver({ localOnlyListPath: m.listPath, now: () => clock, ttlMs: 5_000 })
    assert.equal(resolver.resolve(m.project).class, 'full')

    await writeFolderAskMode({ stateDir: m.stateDir, mode: 'ask' })
    // Inside the window the memo answers: the read is bounded, not per call.
    clock += 1_000
    assert.equal(resolver.resolve(m.project).class, 'full')
    // Past it, the mode is re-read.
    clock += 5_000
    assert.equal(resolver.resolve(m.project).class, 'ignore')

    // The export seam reads the digest first, which drops verdicts the mode
    // has outlived instead of waiting out the window.
    await writeFolderAskMode({ stateDir: m.stateDir, mode: 'sync' })
    resolver.fingerprint?.()
    assert.equal(resolver.resolve(m.project).class, 'full')
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

// LLP 0623: turning the ask on keeps the folders already recorded.

test('turning the ask on marks recorded folders sync, so they stay collected', async () => {
  const m = await makeMachine()
  try {
    const other = path.join(m.root, 'work', 'other')
    const result = await switchFolderAskMode({
      stateDir: m.stateDir,
      mode: 'ask',
      recordedFolders: async () => [m.project, other],
      homeDir: path.join(m.root, 'home'),
    })
    assert.deepEqual(result, { mode: 'ask', marked: 2 })
    assert.equal(await readFolderAskMode({ stateDir: m.stateDir }), 'ask')

    const resolver = createUsagePolicyResolver({ localOnlyListPath: m.listPath })
    assert.equal(resolver.resolve(m.project).class, 'full')
    assert.equal(resolver.resolve(other).class, 'full')
    // A folder the machine never recorded is new, and waits for an answer.
    assert.equal(isUnanswered(resolver.resolve(path.join(m.root, 'work', 'brand-new'))), true)
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('the switch leaves marked folders alone and writes one entry per tree', async () => {
  const m = await makeMachine()
  try {
    const local = path.join(m.root, 'work', 'local')
    await writeLocalOnlyEntries({ stateDir: m.stateDir, entries: [{ dir: local, class: 'local-only' }] })
    const { marked } = await switchFolderAskMode({
      stateDir: m.stateDir,
      mode: 'ask',
      // A parent and its child, a duplicate, a marked folder, and junk.
      recordedFolders: async () => [path.join(m.project, 'sub'), m.project, m.project, local, '', null, 'relative/path'],
      homeDir: path.join(m.root, 'home'),
    })
    assert.equal(marked, 1)
    const entries = await readLocalOnlyEntries({ stateDir: m.stateDir })
    assert.deepEqual(
      entries.map((e) => [e.dir, e.class]).sort(),
      [[local, 'local-only'], [m.project, 'full']].sort(),
    )
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('the switch never marks the home directory or anything above it', async () => {
  const m = await makeMachine()
  try {
    const home = path.join(m.root, 'work')
    const { marked } = await switchFolderAskMode({
      stateDir: m.stateDir,
      mode: 'ask',
      recordedFolders: async () => [home, m.root, m.project],
      homeDir: home,
    })
    // Only the project: an entry at home would answer for every future folder.
    assert.equal(marked, 1)
    const resolver = createUsagePolicyResolver({ localOnlyListPath: m.listPath })
    assert.equal(resolver.resolve(m.project).class, 'full')
    assert.equal(isUnanswered(resolver.resolve(path.join(home, 'later'))), true)
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('the switch never marks home through a symlinked spelling of it', async () => {
  const m = await makeMachine()
  try {
    const real = path.join(m.root, 'real-home')
    const link = path.join(m.root, 'link-home')
    const project = path.join(real, 'project')
    await fs.mkdir(project, { recursive: true })
    await fs.symlink(real, link, 'dir')
    // The rows spell home the real way; HOME names the link.
    const { marked } = await switchFolderAskMode({
      stateDir: m.stateDir,
      mode: 'ask',
      recordedFolders: async () => [real, project],
      homeDir: link,
    })
    assert.equal(marked, 1)
    const resolver = createUsagePolicyResolver({ localOnlyListPath: m.listPath })
    assert.equal(resolver.resolve(project).class, 'full')
    assert.equal(isUnanswered(resolver.resolve(path.join(real, 'later'))), true)
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('a folder the switch just marked is collected at once, whatever the list memo held', async () => {
  const m = await makeMachine()
  try {
    const marked = path.join(m.root, 'work', 'kept')
    const other = path.join(m.root, 'work', 'other')
    await fs.mkdir(marked, { recursive: true })
    await fs.mkdir(other, { recursive: true })
    await writeLocalOnlyEntries({ stateDir: m.stateDir, entries: [{ dir: other, class: 'full' }] })
    let clock = 1_000
    const resolver = createUsagePolicyResolver({ localOnlyListPath: m.listPath, now: () => clock, ttlMs: 5_000 })
    // The mode is read at t=1000 and the list again at t=6100, by a folder the
    // list governs (which needs no mode read).
    assert.equal(resolver.resolve(m.project).class, 'full')
    clock = 6_100
    assert.equal(resolver.resolve(other).class, 'full')
    // The switch writes its marking, then the mode.
    await switchFolderAskMode({ stateDir: m.stateDir, mode: 'ask', recordedFolders: async () => [marked], homeDir: path.join(m.root, 'home') })
    clock = 6_200
    assert.equal(resolver.resolve(marked).class, 'full')
    // Once the mode is seen, the marking still holds and an unmarked folder waits.
    clock = 11_200
    assert.equal(resolver.resolve(marked).class, 'full')
    assert.equal(isUnanswered(resolver.resolve(m.project)), true)
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('only the sync to ask transition marks anything', async () => {
  const m = await makeMachine()
  try {
    let listed = 0
    const recordedFolders = async () => { listed += 1; return [m.project] }
    const homeDir = path.join(m.root, 'home')

    await switchFolderAskMode({ stateDir: m.stateDir, mode: 'sync', recordedFolders, homeDir })
    assert.equal(listed, 0)

    await writeFolderAskMode({ stateDir: m.stateDir, mode: 'ask' })
    const again = await switchFolderAskMode({ stateDir: m.stateDir, mode: 'ask', recordedFolders, homeDir })
    assert.deepEqual(again, { mode: 'ask', marked: 0 })
    assert.equal(listed, 0)
    assert.deepEqual(await readLocalOnlyEntries({ stateDir: m.stateDir }), [])
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})

test('a failed listing leaves the mode unchanged', async () => {
  const m = await makeMachine()
  try {
    await assert.rejects(
      switchFolderAskMode({
        stateDir: m.stateDir,
        mode: 'ask',
        recordedFolders: async () => { throw new Error('cache unreadable') },
        homeDir: path.join(m.root, 'home'),
      }),
      /cache unreadable/,
    )
    assert.equal(await readFolderAskMode({ stateDir: m.stateDir }), 'sync')
  } finally {
    await fs.rm(m.root, { recursive: true, force: true })
  }
})
