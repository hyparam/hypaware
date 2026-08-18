// @ts-check

/**
 * The body spool's deterministic contract: the fixed path under the
 * HypAware home, owner-only creation, and the byte cap with strictly
 * oldest-first eviction.
 *
 * @ref LLP 0257#testing [tests]: spool cap eviction order is unit tested in the
 *   root suite
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_SPOOL_MAX_BYTES,
  claudeBodySpoolDir,
  enforceClaudeBodySpoolCap,
  ensureClaudeBodySpool,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/spool.js'
import {
  readSpoolConfig,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
import { validateClaudeConfig } from '../../hypaware-core/plugins-workspace/claude/src/config.js'

async function tmpSpool() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-spool-'))
  return path.join(root, 'spool', 'claude-bodies')
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {number} size
 * @param {string} mtime ISO timestamp
 */
async function spoolFile(dir, name, size, mtime) {
  const file = path.join(dir, name)
  await fsp.writeFile(file, Buffer.alloc(size, 0x61))
  const when = new Date(mtime)
  await fsp.utimes(file, when, when)
  return file
}

/** @param {string} dir */
async function names(dir) {
  return (await fsp.readdir(dir)).sort()
}

test('the spool path is fixed under the HypAware home', () => {
  assert.equal(claudeBodySpoolDir('/home/u/.hyp'), path.join('/home/u/.hyp', 'spool', 'claude-bodies'))
})

test('ensureClaudeBodySpool creates the directory owner-only', async () => {
  const dir = await tmpSpool()
  await ensureClaudeBodySpool(dir)
  const stat = await fsp.stat(dir)
  assert.equal(stat.mode & 0o777, 0o700)
})

test('an existing spool with loose permissions is tightened, not trusted', async () => {
  const dir = await tmpSpool()
  // Claude Code creates the directory itself when it writes the first
  // body before the daemon ever ran; that copy gets the default umask.
  await fsp.mkdir(dir, { recursive: true, mode: 0o755 })
  await fsp.chmod(dir, 0o755)
  await ensureClaudeBodySpool(dir)
  const stat = await fsp.stat(dir)
  assert.equal(stat.mode & 0o777, 0o700)
})

test('a spool under its cap is left alone', async () => {
  const dir = await tmpSpool()
  await ensureClaudeBodySpool(dir)
  await spoolFile(dir, 'a.request.json', 100, '2026-08-17T10:00:00Z')
  await spoolFile(dir, 'b.request.json', 100, '2026-08-17T11:00:00Z')
  const result = await enforceClaudeBodySpoolCap(dir, 500)
  assert.deepEqual(result, { spoolBytes: 200, evictedCount: 0, evictedBytes: 0 })
  assert.deepEqual(await names(dir), ['a.request.json', 'b.request.json'])
})

test('eviction removes strictly the oldest files until the total fits', async () => {
  const dir = await tmpSpool()
  await ensureClaudeBodySpool(dir)
  // Write in an order unrelated to age so mtime, not creation order or
  // directory order, decides who goes.
  await spoolFile(dir, 'newest.response.json', 100, '2026-08-17T12:00:00Z')
  await spoolFile(dir, 'oldest.request.json', 300, '2026-08-17T09:00:00Z')
  await spoolFile(dir, 'middle.request.json', 200, '2026-08-17T10:30:00Z')

  const result = await enforceClaudeBodySpoolCap(dir, 350)
  // 600 bytes over a 350 cap: oldest (300) goes first, leaving 300,
  // which fits; middle and newest survive.
  assert.deepEqual(result, { spoolBytes: 300, evictedCount: 1, evictedBytes: 300 })
  assert.deepEqual(await names(dir), ['middle.request.json', 'newest.response.json'])

  const again = await enforceClaudeBodySpoolCap(dir, 120)
  // Still oldest-first: middle (200) goes before newest (100).
  assert.deepEqual(again, { spoolBytes: 100, evictedCount: 1, evictedBytes: 200 })
  assert.deepEqual(await names(dir), ['newest.response.json'])
})

test('a cap smaller than every file empties the spool oldest-first', async () => {
  const dir = await tmpSpool()
  await ensureClaudeBodySpool(dir)
  await spoolFile(dir, 'one.request.json', 100, '2026-08-17T09:00:00Z')
  await spoolFile(dir, 'two.request.json', 100, '2026-08-17T10:00:00Z')
  const result = await enforceClaudeBodySpoolCap(dir, 50)
  assert.deepEqual(result, { spoolBytes: 0, evictedCount: 2, evictedBytes: 200 })
  assert.deepEqual(await names(dir), [])
})

test('tied mtimes fall back to name order, so eviction stays deterministic', async () => {
  const dir = await tmpSpool()
  await ensureClaudeBodySpool(dir)
  await spoolFile(dir, 'b-second.json', 100, '2026-08-17T09:00:00Z')
  await spoolFile(dir, 'a-first.json', 100, '2026-08-17T09:00:00Z')
  const result = await enforceClaudeBodySpoolCap(dir, 150)
  assert.equal(result.evictedCount, 1)
  assert.deepEqual(await names(dir), ['b-second.json'])
})

test('a missing spool directory reads as empty, not as an error', async () => {
  const dir = path.join(await tmpSpool(), 'never-created')
  const result = await enforceClaudeBodySpoolCap(dir, 100)
  assert.deepEqual(result, { spoolBytes: 0, evictedCount: 0, evictedBytes: 0 })
})

test('the spool config resolves the fixed dir and defaults the cap to 512 MB', () => {
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: '/tmp/hyp-home' },
    config: {},
    log: { warn: () => {} },
  })
  const spool = readSpoolConfig(ctx)
  assert.equal(spool.dir, path.join('/tmp/hyp-home', 'spool', 'claude-bodies'))
  assert.equal(spool.maxBytes, DEFAULT_SPOOL_MAX_BYTES)
  assert.equal(DEFAULT_SPOOL_MAX_BYTES, 512 * 1024 * 1024)
})

test('a configured cap wins, and a mistyped one warns and falls back', () => {
  const warnings = /** @type {any[]} */ ([])
  const good = /** @type {any} */ ({
    env: { HYP_HOME: '/tmp/hyp-home' },
    config: { telemetry: { spool_max_bytes: 65536 } },
    log: { warn: (/** @type {any} */ m) => warnings.push(m) },
  })
  assert.equal(readSpoolConfig(good).maxBytes, 65536)
  assert.equal(warnings.length, 0)

  const bad = /** @type {any} */ ({
    env: { HYP_HOME: '/tmp/hyp-home' },
    config: { telemetry: { spool_max_bytes: '512mb' } },
    log: { warn: (/** @type {any} */ m) => warnings.push(m) },
  })
  assert.equal(readSpoolConfig(bad).maxBytes, DEFAULT_SPOOL_MAX_BYTES)
  assert.equal(warnings.length, 1)
})

test('the config validator accepts a positive integer cap and rejects the rest', () => {
  assert.equal(validateClaudeConfig({ telemetry: { spool_max_bytes: 1024 } }).ok, true)
  const zero = validateClaudeConfig({ telemetry: { spool_max_bytes: 0 } })
  assert.equal(zero.ok, false)
  assert.equal(zero.errors?.[0].pointer, '/telemetry/spool_max_bytes')
  const fractional = validateClaudeConfig({ telemetry: { spool_max_bytes: 1.5 } })
  assert.equal(fractional.ok, false)
  const typo = validateClaudeConfig({ telemetry: { spool_max_byte: 1024 } })
  assert.equal(typo.ok, false)
  assert.equal(typo.errors?.[0].pointer, '/telemetry/spool_max_byte')
})
