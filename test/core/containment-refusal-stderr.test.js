// @ts-check

// LLP 0329: a containment refusal must be observable, and the channel is the
// process's stderr. On a default install (no HYP_DEV_TELEMETRY, no
// OTEL_EXPORTER_OTLP_ENDPOINT) no logger provider exists and the WARN each
// guard emits is constructed and dropped, so before the mirror a refused
// purge was byte-identical to purging an already-empty install
// (hyparam/hypaware#1108). These are the first tests that can see any of the
// refusals at all.
//
// The cursor guard is pinned through the packaged CLI as a real subprocess,
// because the mirror writes to `process.stderr` rather than the
// dispatch-bound `ctx.stderr` (LLP 0329#consequences) and an in-process seam
// would not prove the line reaches a terminal. The other two guards are
// pinned in-process by capturing `process.stderr` writes.
//
// @ref LLP 0329#testable [tests]: the refusal reaches stderr; the ordinary path stays silent.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createCacheSpool, SPOOL_DIR } from '../../src/core/cache/spool.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = path.join(REPO_ROOT, 'bin', 'hypaware.js')

/** @type {ColumnSpec[]} */
const SESSION_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
]

/**
 * Run the packaged CLI against `hypHome` on a default install's telemetry
 * footing: the dev-telemetry and OTLP variables are stripped so the run has
 * no logger provider, which is the substrate LLP 0329#dark-substrate records
 * and exactly the environment where the refusal used to vanish. `spawnSync`
 * rather than `execFileSync`, because the refusing runs exit 0 by design and
 * their stderr is the whole assertion.
 *
 * @param {string} hypHome
 * @param {string[]} argv
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCliCaptured(hypHome, argv) {
  /** @type {Record<string, string|undefined>} */
  const env = { ...process.env, HYP_HOME: hypHome }
  delete env.HYP_DEV_TELEMETRY
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete env.DEV_RUN_ID
  const out = spawnSync(process.execPath, [BIN, ...argv], { env, encoding: 'utf8' })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

/**
 * A HYP_HOME whose one cache partition carries a source-table cursor whose
 * default generation name `table` resolves to a planted symlink: the shape
 * LLP 0326#not-a-symlink refuses at every cursor read.
 *
 * @param {{ planted: boolean }} shape
 * @returns {Promise<{ root: string, hypHome: string }>}
 */
async function makeHome({ planted }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-stderr-'))
  const hypHome = path.join(root, 'home')
  const partition = path.join(hypHome, 'hypaware', 'cache', 'datasets', 'ai_gateway_messages', 'source=claude')
  await fs.mkdir(partition, { recursive: true })
  if (planted) {
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, path.join(partition, 'table'), 'dir')
  } else {
    await fs.mkdir(path.join(partition, 'table'), { recursive: true })
  }
  await fs.writeFile(
    path.join(partition, 'cursor.json'),
    JSON.stringify({ epoch: 1, rowCount: 3, compaction: null, layout: 'source-table' })
  )
  return { root, hypHome }
}

test('a refused cursor is named on the real CLI\'s stderr, and the verb still exits 0', async () => {
  const { root, hypHome } = await makeHome({ planted: true })
  try {
    const run = runCliCaptured(hypHome, ['purge', '--all', '--yes', '--json'])
    assert.equal(run.status, 0, 'the refusal is a standing condition, not a failed purge')
    const summary = JSON.parse(run.stdout.trim())
    assert.equal(summary.rowsDeleted, 0, 'nothing was purged through the refused partition')
    assert.match(run.stderr, /cursor_table_dir_escapes_partition/, 'the refusal reaches stderr on a default install')
    assert.match(run.stderr, /WARN/, 'at its own severity')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The other direction, which is the whole risk of the mirror: an empty spool
// and an ordinary reclaim must stay quiet, so a refused run and a healthy
// no-op run stay distinguishable by exactly one line.
test('the same verb over a healthy cache writes no WARN to stderr at all', async () => {
  const { root, hypHome } = await makeHome({ planted: false })
  try {
    const run = runCliCaptured(hypHome, ['purge', '--all', '--yes', '--json'])
    assert.equal(run.status, 0)
    assert.doesNotMatch(run.stderr, /WARN/, 'the mirror is on the refusals, not on a level: an ordinary run stays silent')
    assert.doesNotMatch(run.stderr, /\[hypaware:/, 'no mirror line of any kind on the no-op path')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

/**
 * Capture what `fn` writes to the real `process.stderr`, which is where the
 * mirror deliberately writes (LLP 0329#consequences).
 *
 * @param {() => Promise<void>} fn
 * @returns {Promise<string>}
 */
async function captureProcessStderr(fn) {
  const realWrite = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = /** @type {typeof process.stderr.write} */ ((chunk) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })
  try {
    await fn()
  } finally {
    process.stderr.write = realWrite
  }
  return captured
}

test('the flush\'s refusal of a symlinked spool directory reaches process stderr', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-spool-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const tablePath = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    const outside = path.join(root, 'outside')
    await fs.mkdir(tablePath, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, path.join(tablePath, SPOOL_DIR), 'dir')

    const spool = createCacheSpool({
      cacheRoot,
      appendChunk: async () => ({ bytesWritten: 1 }),
    })
    const stderr = await captureProcessStderr(async () => {
      await spool.append(tablePath, SESSION_COLUMNS, [{ id: 1, session_id: 's-1' }])
      await spool.flushTable(tablePath, { reason: 'test' })
    })
    assert.match(stderr, /spool_dir_is_symlink/, 'the flush says which spool it refused, somewhere visible')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('the sweep\'s refusal of a symlinked component reaches process stderr', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-sweep-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const outside = path.join(root, 'outside')
    await fs.mkdir(path.join(outside, 'metadata'), { recursive: true })
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 1, session_id: 's-1' }]
    )
    const generation = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude', 'table')
    await fs.rm(path.join(generation, 'metadata'), { recursive: true, force: true })
    await fs.symlink(path.join(outside, 'metadata'), path.join(generation, 'metadata'), 'dir')

    const stderr = await captureProcessStderr(async () => {
      await maintainCache({ cacheRoot })
    })
    assert.match(stderr, /sweep_path_is_symlink/, 'the sweep says which component it refused, somewhere visible')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// And the in-process control: ordinary maintenance over a healthy cache
// writes no mirror line, so a green maintenance tick stays quiet in the
// daemon's log too.
test('ordinary maintenance over a healthy cache writes nothing to process stderr', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-quiet-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 1, session_id: 's-1' }]
    )
    const stderr = await captureProcessStderr(async () => {
      await maintainCache({ cacheRoot })
    })
    assert.doesNotMatch(stderr, /\[hypaware:/, 'no refusal, no line')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
