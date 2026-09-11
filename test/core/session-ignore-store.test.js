// @ts-check

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'

// @ref LLP 0403#storage [tests]: exact IDs, independent readers, bounded state.
test('saved IDs survive a separate process and live reads need no disk access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'))
  try {
    const ids = [' padded ', '../outside', 'unicode-é', 'nul\0id', 'surrogate-\ud800']
    const set = new SessionIgnoreSet(root)
    for (const id of ids) set.add(id)
    set.add(ids[0])
    const moduleUrl = new URL('../../src/core/control/session_ignore_store.js', import.meta.url).href
    const out = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { SessionIgnoreSet } from ${JSON.stringify(moduleUrl)}\nprocess.stdout.write(JSON.stringify([...new SessionIgnoreSet(process.argv[1])]))`, root], { encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    assert.deepEqual(JSON.parse(out.stdout).sort(), ids.sort())
    for (const name of fs.readdirSync(set.directory)) {
      assert.match(name, /^[a-f0-9]{64}\.json$/)
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(set.directory, name)).mode & 0o777, 0o600)
    }
    if (process.platform !== 'win32') assert.equal(fs.statSync(set.directory).mode & 0o777, 0o700)
    fs.renameSync(set.directory, `${set.directory}-away`)
    for (const id of ids) assert.equal(set.has(id), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('independent writers retain other IDs and refresh removals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'))
  try {
    const a = new SessionIgnoreSet(root)
    const b = new SessionIgnoreSet(root)
    a.add('one')
    b.add('two')
    a.delete('one')
    a.refresh()
    assert.deepEqual([...a], ['two'])
    a.add('one')
    b.refresh()
    assert.deepEqual([...b].sort(), ['one', 'two'])
    b.delete('one')
    b.delete('one')
    assert.deepEqual([...new SessionIgnoreSet(root)], ['two'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed saves and removals preserve the last in-memory membership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'))
  try {
    const set = new SessionIgnoreSet(root)
    set.add('keep')
    fs.renameSync(set.directory, `${set.directory}-away`)
    fs.writeFileSync(set.directory, 'unavailable')
    assert.throws(() => set.add('new'))
    assert.throws(() => set.delete('keep'))
    assert.equal(set.has('new'), false)
    assert.equal(set.has('keep'), true)
    assert.throws(() => new SessionIgnoreSet(root))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('corrupt and oversized markers fail closed without replacing memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'))
  try {
    const set = new SessionIgnoreSet(root)
    set.add('keep')
    const file = path.join(set.directory, fs.readdirSync(set.directory)[0])
    for (const data of ['broken json', '"different-id"', 'x'.repeat(65537)]) {
      fs.writeFileSync(file, data)
      assert.throws(() => new SessionIgnoreSet(root))
      assert.throws(() => set.refresh())
      assert.equal(set.has('keep'), true)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
