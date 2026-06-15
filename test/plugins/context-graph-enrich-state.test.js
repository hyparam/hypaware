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

test('readState returns a null cursor when the sidecar is missing', () => {
  const dir = tmpDir()
  const state = readState(dir)
  assert.equal(state.schema_version, 2)
  assert.equal(state.propose_cursor, null)
})

test('writeState then readState round-trips the keyset cursor', () => {
  const dir = tmpDir()
  writeState(dir, { schema_version: 2, propose_cursor: { ts: 1750000000000, id: 'part-9' } })
  const state = readState(dir)
  assert.deepEqual(state.propose_cursor, { ts: 1750000000000, id: 'part-9' })
})

test('writeState creates the state dir and persists atomically (no leftover temp files)', () => {
  const dir = path.join(tmpDir(), 'nested', 'state')
  writeState(dir, { schema_version: 2, propose_cursor: null })
  const entries = fs.readdirSync(dir)
  assert.deepEqual(entries, [STATE_FILE], 'only the final file remains — temp was renamed')
})

test('readState falls back to null on malformed JSON', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, STATE_FILE), '{ not json', 'utf8')
  assert.equal(readState(dir).propose_cursor, null)
})

test('readState ignores an older schema_version (starts fresh, no partial migration)', () => {
  const dir = tmpDir()
  // The v1 sidecar stored propose_cursor as a bare timestamp string.
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ schema_version: 1, propose_cursor: '2026-01-01T00:00:00.000Z' }), 'utf8')
  const state = readState(dir)
  assert.equal(state.schema_version, 2)
  assert.equal(state.propose_cursor, null)
})

test('readState coerces a malformed cursor (missing id) to null', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ schema_version: 2, propose_cursor: { ts: 'x' } }), 'utf8')
  assert.equal(readState(dir).propose_cursor, null)
})
