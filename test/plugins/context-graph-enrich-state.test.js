// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readState, writeState } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/state.js'

/** @returns {string} */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-state-'))
}

const STATE_FILE = 'enrich-state.json'

test('readState returns an empty mark map + no job when the sidecar is missing', () => {
  const dir = tmpDir()
  const state = readState(dir)
  assert.equal(state.schema_version, 4)
  assert.deepEqual(state.session_marks, {})
  assert.equal(state.curate_job, null)
})

test('writeState then readState round-trips the per-session marks', () => {
  const dir = tmpDir()
  writeState(dir, { schema_version: 4, session_marks: { A: { ts: 1750000000000, id: 'part-9' }, B: { ts: 1751000000000, id: 'part-3' } }, curate_job: null })
  const state = readState(dir)
  assert.deepEqual(state.session_marks, { A: { ts: 1750000000000, id: 'part-9' }, B: { ts: 1751000000000, id: 'part-3' } })
})

test('writeState then readState round-trips the in-flight curate job', () => {
  const dir = tmpDir()
  const job = { id: 'batch_1', submitted_at: '2026-06-18T00:00:00.000Z', clusters: [{ customId: 'c0', prospectIds: ['p1', 'p2'] }] }
  writeState(dir, { schema_version: 4, session_marks: {}, curate_job: job })
  assert.deepEqual(readState(dir).curate_job, job)
})

test('writeState creates the state dir and persists atomically (no leftover temp files)', () => {
  const dir = path.join(tmpDir(), 'nested', 'state')
  writeState(dir, { schema_version: 4, session_marks: {}, curate_job: null })
  const entries = fs.readdirSync(dir)
  assert.deepEqual(entries, [STATE_FILE], 'only the final file remains — temp was renamed')
})

test('readState falls back to an empty state on malformed JSON', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, STATE_FILE), '{ not json', 'utf8')
  assert.deepEqual(readState(dir).session_marks, {})
  assert.equal(readState(dir).curate_job, null)
})

test('readState ignores an older schema_version (the global-cursor v2 sidecar is discarded)', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ schema_version: 2, propose_cursor: { ts: 1, id: 'p' } }), 'utf8')
  const state = readState(dir)
  assert.equal(state.schema_version, 4)
  assert.deepEqual(state.session_marks, {})
})

test('readState drops only the malformed marks, keeping the well-formed ones', () => {
  const dir = tmpDir()
  fs.writeFileSync(
    path.join(dir, STATE_FILE),
    JSON.stringify({ schema_version: 4, session_marks: { A: { ts: 5, id: 'p1' }, B: { ts: 'x' }, C: { id: 'p2' } }, curate_job: null }),
    'utf8'
  )
  assert.deepEqual(readState(dir).session_marks, { A: { ts: 5, id: 'p1' } })
})

test('readState drops a malformed curate job (no clusters array)', () => {
  const dir = tmpDir()
  fs.writeFileSync(
    path.join(dir, STATE_FILE),
    JSON.stringify({ schema_version: 4, session_marks: {}, curate_job: { id: 'batch_1' } }),
    'utf8'
  )
  assert.equal(readState(dir).curate_job, null)
})
