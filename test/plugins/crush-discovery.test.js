// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_DATABASES,
  createDiscoveryState,
  discoverDatabases,
} from '../../hypaware-core/plugins-workspace/crush/src/discovery.js'
import { crushSourceStatus } from '../../hypaware-core/plugins-workspace/crush/src/index.js'

/**
 * Tests for `@hypaware/crush` database discovery over `projects.json` and
 * `data_dirs`.
 *
 * @ref LLP 0573#discovery [tests]: dedupe by real path, stale entries counted,
 *   a malformed index keeps the last good list, an unchanged index is not
 *   reread, and the 1,024-database cap.
 */

/** @param {string} prefix */
function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/**
 * Make `<root>/<name>/.crush/crush.db` and return the `.crush` dir.
 *
 * @param {string} root
 * @param {string} name
 */
function makeProject(root, name) {
  const dataDir = path.join(root, name, '.crush')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'crush.db'), '')
  return dataDir
}

/**
 * Write a `projects.json` in Crush's shape.
 *
 * @param {string} indexPath
 * @param {string[]} dataDirs
 */
function writeIndex(indexPath, dataDirs) {
  const projects = dataDirs.map((d) => ({ path: path.dirname(d), data_dir: d, last_accessed: '2026-11-03T00:00:00Z' }))
  fs.writeFileSync(indexPath, JSON.stringify({ projects }))
}

test('no index and no data_dirs finds nothing and reads nothing', () => {
  const root = tmp('crush-disc-')
  try {
    const result = discoverDatabases(createDiscoveryState(), { indexPath: path.join(root, 'projects.json'), dataDirs: [] })
    assert.equal(result.indexPresent, false)
    assert.equal(result.indexUnreadable, false)
    assert.deepEqual([result.databases.length, result.listed, result.stale, result.overCap], [0, 0, 0, 0])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('two index entries sharing one data_dir give one database', () => {
  const root = tmp('crush-disc-')
  try {
    const dataDir = makeProject(root, 'a')
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'a-link'))
    const indexPath = path.join(root, 'projects.json')
    writeIndex(indexPath, [dataDir, path.join(root, 'a-link', '.crush'), dataDir])
    const result = discoverDatabases(createDiscoveryState(), { indexPath, dataDirs: [dataDir] })
    assert.equal(result.databases.length, 1)
    assert.deepEqual(result.databases[0], {
      dataDir,
      dbPath: path.join(dataDir, 'crush.db'),
      projectDir: path.join(root, 'a'),
    })
    assert.equal(result.listed, 1)
    assert.equal(result.stale, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a stale entry is counted and does not stop the rest', () => {
  const root = tmp('crush-disc-')
  try {
    const live = makeProject(root, 'live')
    const noDb = path.join(root, 'nodb', '.crush')
    fs.mkdirSync(noDb, { recursive: true })
    const gone = path.join(root, 'gone', '.crush')
    const indexPath = path.join(root, 'projects.json')
    writeIndex(indexPath, [gone, noDb, live])
    const result = discoverDatabases(createDiscoveryState(), { indexPath, dataDirs: ['relative/.crush'] })
    assert.equal(result.databases.length, 1)
    assert.equal(result.databases[0].dataDir, live)
    assert.equal(result.listed, 4)
    assert.equal(result.stale, 3)
    const status = crushSourceStatus(result, { indexPath, pollIntervalMs: 60_000, rowsWritten: 0 })
    assert.equal(status.state, 'ready')
    assert.equal(status.message, 'polling 1 crush projects every 60000ms, no sessions yet; 3 listed projects have no crush.db')
    assert.ok(!JSON.stringify(status).includes(live), 'status never names a project path')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a malformed index keeps the last good list and reports index_unreadable', () => {
  const root = tmp('crush-disc-')
  try {
    const a = makeProject(root, 'a')
    const indexPath = path.join(root, 'projects.json')
    writeIndex(indexPath, [a])
    const state = createDiscoveryState()
    assert.equal(discoverDatabases(state, { indexPath, dataDirs: [] }).databases.length, 1)

    fs.writeFileSync(indexPath, '{"projects": [ truncated')
    const broken = discoverDatabases(state, { indexPath, dataDirs: [] })
    assert.equal(broken.indexUnreadable, true)
    assert.equal(broken.databases.length, 1)
    assert.equal(broken.databases[0].dataDir, a)
    const status = crushSourceStatus(broken, { indexPath, pollIntervalMs: 60_000, rowsWritten: 0 })
    assert.equal(status.state, 'degraded')
    assert.equal(status.details?.error_kind, 'index_unreadable')
    assert.equal(status.lastError, `cannot read the crush index at ${indexPath}`)

    fs.writeFileSync(indexPath, JSON.stringify({ projects: 'nope' }))
    assert.equal(discoverDatabases(state, { indexPath, dataDirs: [] }).indexUnreadable, true)

    writeIndex(indexPath, [a, makeProject(root, 'b')])
    const healed = discoverDatabases(state, { indexPath, dataDirs: [] })
    assert.equal(healed.indexUnreadable, false)
    assert.equal(healed.databases.length, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unchanged index is not reread', () => {
  const root = tmp('crush-disc-')
  try {
    const a = makeProject(root, 'a')
    const indexPath = path.join(root, 'projects.json')
    writeIndex(indexPath, [a])
    const state = createDiscoveryState()
    discoverDatabases(state, { indexPath, dataDirs: [] })
    const sig = state.indexSig
    assert.ok(sig)

    const realRead = fs.readFileSync
    let reads = 0
    // @ts-ignore counting reads of the index only
    fs.readFileSync = (/** @type {any} */ p, /** @type {any} */ o) => {
      if (p === indexPath) reads++
      return realRead(p, o)
    }
    try {
      for (let i = 0; i < 3; i++) assert.equal(discoverDatabases(state, { indexPath, dataDirs: [] }).databases.length, 1)
      assert.equal(reads, 0)
      writeIndex(indexPath, [a, makeProject(root, 'b')])
      assert.equal(discoverDatabases(state, { indexPath, dataDirs: [] }).databases.length, 2)
      assert.equal(reads, 1)
    } finally {
      fs.readFileSync = realRead
    }
    assert.notEqual(state.indexSig, sig)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a deleted index drops its list; data_dirs still count', () => {
  const root = tmp('crush-disc-')
  try {
    const a = makeProject(root, 'a')
    const b = makeProject(root, 'b')
    const indexPath = path.join(root, 'projects.json')
    writeIndex(indexPath, [a])
    const state = createDiscoveryState()
    assert.equal(discoverDatabases(state, { indexPath, dataDirs: [b] }).databases.length, 2)
    fs.rmSync(indexPath)
    const result = discoverDatabases(state, { indexPath, dataDirs: [b] })
    assert.equal(result.indexPresent, false)
    assert.deepEqual(result.databases.map((d) => d.dataDir), [b])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('past the cap, entries are counted and skipped and the source is degraded', () => {
  const root = tmp('crush-disc-')
  try {
    const dirs = []
    for (let i = 0; i < MAX_DATABASES + 3; i++) dirs.push(makeProject(root, `p${String(i).padStart(4, '0')}`))
    const indexPath = path.join(root, 'projects.json')
    writeIndex(indexPath, dirs)
    const result = discoverDatabases(createDiscoveryState(), { indexPath, dataDirs: [] })
    assert.equal(result.databases.length, MAX_DATABASES)
    assert.equal(result.overCap, 3)
    assert.equal(result.listed, MAX_DATABASES + 3)
    assert.equal(result.databases[MAX_DATABASES - 1].dataDir, dirs[MAX_DATABASES - 1])
    const status = crushSourceStatus(result, { indexPath, pollIntervalMs: 60_000, rowsWritten: 0 })
    assert.equal(status.state, 'degraded')
    assert.equal(status.details?.error_kind, 'too_many_projects')
    assert.equal(status.message, '3 crush projects skipped over the 1,024 limit')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an index with no projects reads as lists no projects yet', () => {
  const root = tmp('crush-disc-')
  try {
    const indexPath = path.join(root, 'projects.json')
    writeIndex(indexPath, [])
    const result = discoverDatabases(createDiscoveryState(), { indexPath, dataDirs: [] })
    const status = crushSourceStatus(result, { indexPath, pollIntervalMs: 60_000, rowsWritten: 0 })
    assert.equal(status.state, 'ready')
    assert.equal(status.message, `crush index at ${indexPath} lists no projects yet`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
