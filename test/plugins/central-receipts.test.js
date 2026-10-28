// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openReceipts } from '../../hypaware-core/plugins-workspace/central/src/receipts.js'

test('receipts isolate destinations and ignore torn records without losing later acknowledgements', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'receipts-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const scope = ['https://server', 'gateway', '/partition', 'logs', 'incremental']
  const first = await openReceipts(root, scope)
  const id = first.key('batch-one')
  await first.record(id)
  const file = path.join(root, (await fs.readdir(root))[0])
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  await fs.appendFile(file, 'partial-record')
  const restarted = await openReceipts(root, scope)
  assert.equal(restarted.has(id), true)
  const secondId = restarted.key('batch-two')
  await restarted.record(secondId)
  const again = await openReceipts(root, scope)
  assert.equal(again.has(id), true)
  assert.equal(again.has(secondId), true)
  for (let i = 0; i < scope.length; i++) {
    const changed = [...scope]
    changed[i] += '-different'
    assert.equal((await openReceipts(root, changed)).has(id), false)
  }
  await again.clear()
  assert.deepEqual(await fs.readdir(root), [])
})

test('receipt disk and memory reads stay capped; reaching the cap never blocks delivery', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'receipts-cap-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const journal = await openReceipts(root, ['scope'])
  const first = journal.key('one')
  await journal.record(first)
  const file = path.join(root, (await fs.readdir(root))[0])
  await fs.writeFile(file, (first + '\n').repeat(65_536))
  const second = journal.key('two')
  const capped = await openReceipts(root, ['scope'])
  await capped.record(second)
  assert.equal(capped.has(second), false)
  assert.equal((await fs.stat(file)).size, 65_536 * 65)
  await fs.appendFile(file, second + '\n')
  assert.equal((await openReceipts(root, ['scope'])).has(second), false, 'oversized journals are read only up to the cap')
})
