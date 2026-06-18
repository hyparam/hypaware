// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  clearRemoteTarget,
  queryRemoteTargetPath,
  readRemoteTarget,
  writeRemoteTarget,
} from '../../src/core/query/remote-target.js'

async function tmpStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-remote-target-'))
}

test('write/read roundtrip returns the saved URL', async () => {
  const dir = await tmpStateDir()
  assert.equal(await readRemoteTarget(dir), null) // none yet
  await writeRemoteTarget(dir, 'http://h:8740')
  assert.deepEqual(await readRemoteTarget(dir), { serverUrl: 'http://h:8740' })
})

test('the target file is mode 0600 and holds only the URL (no token)', async () => {
  const dir = await tmpStateDir()
  await writeRemoteTarget(dir, 'https://central.example')
  const stat = await fs.stat(queryRemoteTargetPath(dir))
  assert.equal(stat.mode & 0o777, 0o600)
  const body = JSON.parse(await fs.readFile(queryRemoteTargetPath(dir), 'utf8'))
  assert.deepEqual(body, { version: 1, server_url: 'https://central.example' })
})

test('a malformed or empty target reads back as null, not an error', async () => {
  const dir = await tmpStateDir()
  await fs.writeFile(queryRemoteTargetPath(dir), '{ not json')
  assert.equal(await readRemoteTarget(dir), null)
  await fs.writeFile(queryRemoteTargetPath(dir), JSON.stringify({ version: 1 }))
  assert.equal(await readRemoteTarget(dir), null) // no server_url
})

test('clear is idempotent', async () => {
  const dir = await tmpStateDir()
  await writeRemoteTarget(dir, 'http://h:8740')
  assert.equal(await clearRemoteTarget(dir), true)
  assert.equal(await readRemoteTarget(dir), null)
  assert.equal(await clearRemoteTarget(dir), false) // nothing left to clear
})
