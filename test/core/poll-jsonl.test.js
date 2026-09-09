// @ts-check

// The poll the live-daemon suites read their spans with reads a file the
// exporter is still appending to, so it has to survive a half written tail
// line without hiding a genuinely malformed record (issue #1516).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { pollJsonlFor } from '../helpers/poll_jsonl.js'

/** @returns {Promise<string>} */
async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-poll-jsonl-'))
  return path.join(dir, 'traces-1.jsonl')
}

test('a torn tail line is polled past, and read once the writer completes it', async () => {
  const filePath = await tempFile()
  const record = { name: 'maintenance.tick', status: 'degraded' }
  const line = JSON.stringify(record)
  // What a reader sees between the two writes of one torn append.
  await fs.writeFile(filePath, '{"name":"cache.compact"}\n' + line.slice(0, 20))

  const wanted = (/** @type {any} */ r) => r.name === 'maintenance.tick'
  // The poll runs to its deadline rather than throwing the tail's SyntaxError.
  assert.equal(await pollJsonlFor(filePath, wanted, 25), undefined)

  await fs.appendFile(filePath, line.slice(20) + '\n')
  assert.deepEqual(await pollJsonlFor(filePath, wanted, 5000), record)
})

test('a malformed complete line still throws', async () => {
  const filePath = await tempFile()
  await fs.writeFile(filePath, '{"name":"cache.compact"\n{"name":"maintenance.tick"}\n')

  await assert.rejects(
    () => pollJsonlFor(filePath, (r) => r.name === 'maintenance.tick', 5000),
    SyntaxError
  )
})

test('a file that does not exist yet is waited for, not thrown on', async () => {
  const filePath = await tempFile()
  const polled = pollJsonlFor(filePath, (r) => r.name === 'maintenance.tick', 5000)
  await fs.writeFile(filePath, '{"name":"maintenance.tick"}\n')
  assert.equal((await polled).name, 'maintenance.tick')
})
