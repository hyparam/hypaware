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
import { closeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { sweepCaptureSpool } from '../../src/core/capture_spool.js'
import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createCacheSpool, SPOOL_DIR } from '../../src/core/cache/spool.js'
import { JsonlSpanExporter } from '../../src/core/observability/jsonl_exporters.js'
import { getLogger } from '../../src/core/observability/logger.js'
import { installObservability, readObservabilityEnv } from '../../src/core/observability/index.js'
import { logs, trace, LoggerProvider, TracerProvider } from '../../src/core/observability/runtime.js'
import { Attr } from '../../src/core/observability/attrs.js'
// The mirror writes to the real `process.stderr` (LLP 0329#consequences), so
// the capture that stands in front of that descriptor is the shared one.
import { stderrTextFrom as captureProcessStderr } from '../helpers/stderr_lines.js'

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
    // Counted, not just matched. The verb reads the poisoned cursor twice
    // (partition discovery, then the post-delete recount) and both reads are
    // one standing condition, so the second line said nothing the first did
    // not (LLP 0332#per-read-bill). One line proves the throttle; the match
    // above proves it did not become zero, which would be the worse bug.
    const refusals = run.stderr.split('\n').filter((line) => line.includes('cursor_table_dir_escapes_partition'))
    assert.equal(refusals.length, 1, 'one standing refusal, one line per verb invocation')
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
    // Counted, not just matched. LLP 0329#consequences prices a standing
    // refusal at one line per refusing flush pass, and `runFlush` lists the
    // spool up to three times, so a report left on every list costs two
    // identical lines for one pass. That is a real bill: the sink driver's
    // default schedule is `* * * * *` and adapters flush once per partition
    // per tick, into a daemon log the service manager never truncates.
    const perPass = stderr.split('\n').filter((line) => line.includes('spool_dir_is_symlink'))
    assert.equal(perPass.length, 1, 'one refusing flush pass costs exactly one line')

    // And the other direction, which is what LLP 0329 actually settled: the
    // line repeats because the condition persists. Deduplicating within a
    // pass must not turn into suppressing the standing signal across passes.
    const second = await captureProcessStderr(async () => {
      await spool.flushTable(tablePath, { reason: 'test' })
    })
    const secondPass = second.split('\n').filter((line) => line.includes('spool_dir_is_symlink'))
    assert.equal(secondPass.length, 1, 'the next pass says it again; the standing signal is not throttled')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('the sweep\'s refusal of a symlinked component reaches process stderr', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-sweep-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const outside = path.join(root, 'outside')
    await fs.mkdir(path.join(outside, 'data'), { recursive: true })
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
      [{ id: 1, session_id: 's-1' }]
    )
    const generation = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude', 'table')
    // Planted at `data/`, which is a component BOTH passes open: the
    // unreferenced sweep joins `metadata/` and `data/` onto the generation,
    // and the index-scratch sweep lists `data/`. An earlier spelling of this
    // test planted at `metadata/`, which stopped being a component the scratch
    // sweep asks about when LLP 0331#guard-travels-with-the-delete moved that
    // pass's guard inside the pass and narrowed it to the two directories the
    // pass actually walks. That loosening is deliberate, and the property this
    // test exists for is unchanged by it: what is pinned is that each refusing
    // pass says so on stderr, so the plant has to be somewhere both of them
    // refuse.
    await fs.rm(path.join(generation, 'data'), { recursive: true, force: true })
    await fs.symlink(path.join(outside, 'data'), path.join(generation, 'data'), 'dir')

    const stderr = await captureProcessStderr(async () => {
      await maintainCache({ cacheRoot })
    })
    // Asserted per `operation`, not on the `error_kind` alone. Two passes walk
    // this same component on one tick for this dataset - the unreferenced-set
    // sweep and, because `ai_gateway_messages` is the grep-indexed dataset, the
    // index-scratch sweep - and both report through the one
    // `reportPlantedSweepPath`, so both lines carry the same
    // `sweep_path_is_symlink`. A bare match on the kind is satisfied by either
    // line, which means it stays green if one pass loses its guard entirely
    // while the other keeps reporting. The `operation` attribute is the only
    // field on the line that tells the two passes apart, so it is what the
    // assertion reads.
    const refusals = stderr.split('\n').filter((line) => line.includes('sweep_path_is_symlink'))
    const operations = refusals.map((line) => /"hyp_operation":"([^"]+)"/.exec(line)?.[1])
    assert.ok(
      operations.includes('cache.sweep_unreferenced'),
      'the unreferenced-set sweep names its own refusal, somewhere visible'
    )
    assert.ok(
      operations.includes('maintenance.grep_index'),
      'and so does the index-scratch sweep, which walks the same component'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The fourth guard in the series, and the one LLP 0329 could not reach when
// it was written: its code lived on hyparam/hypaware#1107's branch. That
// branch is merged, so the rule LLP 0329#stderr-mirror states in general ("a
// refusal that leaves every counter at zero must opt into the stderr mirror")
// applies to it here rather than as a follow-up. Without the opt-in a user who
// symlinks `<hyp-home>/spool/claude-bodies` onto a larger volume gets exactly
// the issue #1108 symptom: the spool stops being emptied, `hyp purge` and
// `hyp detach` both report success and zero, and nothing says why.
test('the capture-spool sweep\'s refusal reaches process stderr', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-capture-'))
  try {
    const home = path.join(root, 'home')
    const outside = path.join(root, 'outside')
    const spoolRoot = path.join(home, 'spool')
    const dir = path.join(spoolRoot, 'claude-bodies')
    await fs.mkdir(spoolRoot, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(outside, 'keep.txt'), 'not ours')
    await fs.symlink(outside, dir, 'dir')

    // A holder rather than a `let`: the assignment happens inside the
    // stderr-capturing closure, and control-flow narrowing does not cross that
    // boundary, so a plain binding reads back as `null` afterwards.
    /** @type {{ swept: { filesRemoved: number, bytesRemoved: number, failed: number } | null }} */
    const out = { swept: null }
    const stderr = await captureProcessStderr(async () => {
      out.swept = await sweepCaptureSpool(dir)
    })
    // The zero counts are the point: they are why the line has to exist.
    assert.deepEqual(out.swept, { filesRemoved: 0, bytesRemoved: 0, failed: 0 })
    assert.match(stderr, /capture_spool_path_is_symlink/, 'the sweep names the spool it refused, somewhere visible')
    assert.match(stderr, /WARN/, 'at its own severity')
    const refusals = stderr.split('\n').filter((line) => line.includes('capture_spool_path_is_symlink'))
    assert.equal(refusals.length, 1, 'one refused component, one line')
    // Its own error_kind, not the cache's (LLP 0328#loud-refusal): two spools
    // in two subsystems that an operator resolves differently.
    assert.doesNotMatch(stderr, /sweep_path_is_symlink|spool_dir_is_symlink/)
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'not ours')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// And its quiet control, the same shape as the cache ones: an ordinary spool
// is emptied without a word.
test('an ordinary capture-spool sweep writes nothing to process stderr', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-capture-quiet-'))
  try {
    const dir = path.join(root, 'home', 'spool', 'claude-bodies')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'body-1.json'), '{}')
    /** @type {{ swept: { filesRemoved: number, bytesRemoved: number, failed: number } | null }} */
    const out = { swept: null }
    const stderr = await captureProcessStderr(async () => {
      out.swept = await sweepCaptureSpool(dir)
    })
    assert.equal(out.swept?.filesRemoved, 1, 'the ordinary sweep still empties the spool')
    assert.doesNotMatch(stderr, /\[hypaware:/, 'no refusal, no line')
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

// --- The mirror must outlive the substrate it exists to outlive ------------
//
// LLP 0329#stderr-mirror rests its guarantee on the mirror sitting *beside*
// the OTel emit rather than behind it. Until hyparam/hypaware#1122 it sat
// behind it: `getLogger`'s emit ran the OTel half first, and
// `LoggerProvider.exportRecord` looped its exporters unguarded, so a single
// exporter that threw synchronously threw out of `otelLogger.emit` and the
// `process.stderr.write` below it never ran. That silences all four
// containment guards at once, on any install whose provider carries such an
// exporter. It was latent only because both in-tree exporters swallow their
// own failures, which is per-exporter discipline rather than a contract.
//
// @ref LLP 0329#stderr-mirror [tests]: the refusal still reaches stderr when an installed exporter throws.

/**
 * Install a global logger provider carrying `exporters` for the duration of
 * `fn`, then take it away again. `shutdown` clears the global slot, so the
 * rest of this file keeps running on the default install's footing (no
 * provider) that every other test here assumes.
 *
 * @param {Array<{ exportBatch(records: unknown[]): unknown }>} exporters
 * @param {() => Promise<void>|void} fn
 */
async function withLoggerProvider(exporters, fn) {
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ (exporters),
  })
  logs.setGlobalLoggerProvider(provider)
  try {
    await fn()
  } finally {
    await provider.shutdown()
  }
}

test('a refusal still reaches stderr when the installed exporter throws', async () => {
  class ThrowingMirrorExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) {
      throw new Error('this exporter is broken')
    }
  }

  const stderr = await captureProcessStderr(async () => {
    await withLoggerProvider([new ThrowingMirrorExporter()], () => {
      getLogger('cache', { mirrorStderr: true }).warn('a symlink stands where a generation name resolves', {
        [Attr.COMPONENT]: 'cache',
        [Attr.OPERATION]: 'cache.read_cursor',
        [Attr.ERROR_KIND]: 'cursor_table_dir_escapes_partition',
      })
    })
  })

  assert.match(stderr, /cursor_table_dir_escapes_partition/, 'the mirror is not hostage to the exporter')
  assert.match(stderr, /\[hypaware:cache\] WARN/, 'and it is the same line, at the same severity')
  // Losing the telemetry is acceptable; losing the refusal is not. But a
  // broken exporter must not become undiagnosable either.
  assert.match(stderr, /telemetry_export_threw/, 'the broken exporter names itself')
  assert.match(stderr, /this exporter is broken/, 'with what it threw')
})

test('a throwing exporter does not stop the caller, nor its sibling exporters', async () => {
  class ThrowingSiblingExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) {
      throw new Error('first exporter is broken')
    }
  }
  /** @type {unknown[]} */
  const delivered = []
  const healthy = {
    /** @param {unknown[]} records */
    exportBatch(records) { delivered.push(...records) },
  }

  await captureProcessStderr(async () => {
    await withLoggerProvider([new ThrowingSiblingExporter(), healthy], () => {
      getLogger('cache').warn('a record that one exporter cannot take')
      getLogger('cache').warn('and a second one')
    })
  })

  assert.equal(delivered.length, 2, 'the healthy exporter behind the broken one still received every record')
})

test('the broken-exporter report is bounded to one line, not one per record', async () => {
  class NoisyBrokenExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) {
      throw new Error('still broken')
    }
  }
  const stderr = await captureProcessStderr(async () => {
    await withLoggerProvider([new NoisyBrokenExporter()], () => {
      const log = getLogger('cache')
      for (let i = 0; i < 25; i++) log.warn(`record ${i}`)
    })
  })
  const reports = stderr.split('\n').filter((line) => line.includes('telemetry_export_threw'))
  assert.equal(reports.length, 1, 'a broken exporter is diagnosed once, not on every record it drops')
})

// The end-to-end half: one real guard, refusing for real, with a broken
// exporter installed. This is the shape an install with a third-party log
// exporter actually has, and it is the case LLP 0329 promises.
test('a real containment guard still names its refusal with a throwing exporter installed', async () => {
  class ThrowingSweepExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) {
      throw new Error('sweep-path exporter is broken')
    }
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-throwing-'))
  try {
    const home = path.join(root, 'home')
    const outside = path.join(root, 'outside')
    const dir = path.join(home, 'spool', 'claude-bodies')
    await fs.mkdir(path.join(home, 'spool'), { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, dir, 'dir')

    /** @type {{ swept: { filesRemoved: number, bytesRemoved: number, failed: number } | null }} */
    const out = { swept: null }
    const stderr = await captureProcessStderr(async () => {
      await withLoggerProvider([new ThrowingSweepExporter()], async () => {
        out.swept = await sweepCaptureSpool(dir)
      })
    })
    assert.deepEqual(out.swept, { filesRemoved: 0, bytesRemoved: 0, failed: 0 })
    assert.match(stderr, /capture_spool_path_is_symlink/, 'the guard reaches stderr through a broken provider')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The emit seam's bound is per installed provider, not per process. On the
// seam's name alone the first broken provider consumes the one line and every
// provider installed after it is undiagnosable, which is the diagnosability
// half of #1122 again, and it is why the second emit-seam case in this file
// had to be a subprocess before this.
test('a broken provider installed after another broken one is diagnosed too', async () => {
  /** @param {string} label */
  const broken = (label) => /** @type {any} */ ({
    resource: { attributes: {} },
    /** @param {unknown} _record */
    exportRecord(_record) { throw new Error(`broken provider ${label}`) },
  })
  const stderr = await captureProcessStderr(async () => {
    try {
      logs.setGlobalLoggerProvider(broken('one'))
      getLogger('cache').warn('a record the first one cannot take')
      logs.setGlobalLoggerProvider(broken('two'))
      getLogger('cache').warn('nor the second')
    } finally {
      logs.setGlobalLoggerProvider(/** @type {any} */ (null))
    }
  })
  const reports = stderr.split('\n').filter((line) => line.includes('telemetry_export_threw'))
  assert.equal(reports.length, 2, 'one line per installed provider, not one for the process')
  assert.match(stderr, /broken provider one/)
  assert.match(stderr, /broken provider two/)
})

// The same contract one seam later. `flushExporters` reaches its exporters
// through `Promise.allSettled(exporters.map(...))`, which absorbs rejections
// but not synchronous throws: the throw unwinds the `map` that was building
// allSettled's input, so it came back out of `provider.shutdown()` and left
// every exporter behind the broken one neither flushed nor closed. On the
// shutdown path that is a JSONL writer left open with records still in it.
test('an exporter whose forceFlush throws does not fail the shutdown, nor strand its siblings', async () => {
  class ThrowingFlushExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
    forceFlush() { throw new Error('forceFlush threw synchronously') }
  }
  const closed = { flushed: false, shut: false }
  const healthy = {
    /** @param {unknown[]} _records */
    exportBatch(_records) {},
    async forceFlush() { closed.flushed = true },
    async shutdown() { closed.shut = true },
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new ThrowingFlushExporter(), healthy]),
  })
  const stderr = await captureProcessStderr(async () => {
    await provider.shutdown()
  })
  assert.deepEqual(closed, { flushed: true, shut: true }, 'the exporter behind the broken one was still flushed and closed')
  assert.match(stderr, /telemetry_flush_threw/, 'and the broken flush names itself instead of being absorbed silently')
})

// Absorbing a close failure kept it from stranding the sibling exporters,
// but absorbing it silently meant a JSONL writer that fails to close at
// daemon shutdown lost its buffered records with no line anywhere
// (hyparam/hypaware#1130 item 2). The settled rejections now route through
// the same one-line report as a throwing export.
//
// @ref LLP 0335#close-failures [tests]: a failed flush or close is diagnosed once on stderr; a healthy close stays silent.
test('an exporter whose shutdown rejects is diagnosed on stderr, once, without stranding its sibling', async () => {
  class RejectingCloseExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
    async shutdown() { throw new Error('close failed; records still buffered') }
  }
  const closed = { shut: false }
  const healthy = {
    /** @param {unknown[]} _records */
    exportBatch(_records) {},
    async shutdown() { closed.shut = true },
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new RejectingCloseExporter(), healthy]),
  })
  const stderr = await captureProcessStderr(async () => {
    await provider.shutdown()
  })
  assert.equal(closed.shut, true, 'the exporter behind the broken one still closed')
  assert.match(stderr, /telemetry_shutdown_threw/, 'the failed close names itself')
  assert.match(stderr, /close failed; records still buffered/, 'with what it rejected with')
  assert.match(stderr, /buffered records may be lost/, 'and says what the failure costs')
  const reports = stderr.split('\n').filter((line) => line.includes('telemetry_shutdown_threw'))
  assert.equal(reports.length, 1, 'one line for the failed close, not one per settled rejection observer')
})

test('a persistently failing forceFlush is diagnosed once, not once per flush', async () => {
  class RejectingFlushExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
    async forceFlush() { throw new Error('flush keeps failing') }
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new RejectingFlushExporter()]),
  })
  const stderr = await captureProcessStderr(async () => {
    await provider.forceFlush()
    await provider.forceFlush()
    await provider.forceFlush()
  })
  const reports = stderr.split('\n').filter((line) => line.includes('telemetry_flush_threw'))
  assert.equal(reports.length, 1, 'the one-line bound holds across repeated flushes')
})

test('a healthy provider shuts down with nothing on stderr', async () => {
  const healthy = {
    /** @param {unknown[]} _records */
    exportBatch(_records) {},
    async forceFlush() {},
    async shutdown() {},
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([healthy]),
  })
  const stderr = await captureProcessStderr(async () => {
    await provider.forceFlush()
    await provider.shutdown()
  })
  assert.equal(stderr, '', 'no failure, no line')
})

// The operation lives in the dedupe key, which is the clause that makes the
// close report worth having: on a key of `source#index` alone, an exporter
// that breaks on export spends the report there, and the same exporter losing
// its buffered records at close is then silent, which is the JSONL-writer
// case LLP 0335#close-failures exists to end. Pinned because collapsing the
// key back is otherwise an invisible regression.
//
// @ref LLP 0335#close-failures [tests]: the export line and the close line are bounded independently.
test('an exporter that breaks on export and again on close is diagnosed for both, not deduped into one', async () => {
  class BrokenBothWays {
    /** @param {unknown[]} _records */
    exportBatch(_records) { throw new Error('export is broken') }
    async shutdown() { throw new Error('close is broken too') }
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new BrokenBothWays()]),
  })
  const stderr = await captureProcessStderr(async () => {
    provider.exportRecord(/** @type {any} */ ({ body: 'a record this exporter cannot take', attributes: {} }))
    await provider.shutdown()
  })
  const exportReports = stderr.split('\n').filter((line) => line.includes('telemetry_export_threw'))
  const closeReports = stderr.split('\n').filter((line) => line.includes('telemetry_shutdown_threw'))
  assert.equal(exportReports.length, 1, 'the broken export is diagnosed once')
  assert.equal(closeReports.length, 1, 'and the broken close is diagnosed too, not swallowed as a duplicate')
  assert.match(stderr, /close is broken too/, 'each line carries its own failure')
})

// The export line's exact shape, recorded in LLP 0335#one-line and relied on
// by anyone grepping a daemon log for `telemetry_export_threw`. Pinned as a
// whole line rather than by substring because the close-failure fix rebuilt
// the message and two of the attributes out of an `operation` template
// (hyparam/hypaware#1130 item 2), and a template that drifts silently breaks
// every grep already written against it.
//
// @ref LLP 0335#one-line [tests]: the export report's message and attributes are exactly what the contract records.
test('the export report is one line of exactly the recorded shape', async () => {
  class NamedBrokenExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) { throw new Error('boom') }
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new NamedBrokenExporter()]),
  })
  const stderr = await captureProcessStderr(async () => {
    provider.exportRecord(/** @type {any} */ ({ body: 'a record', attributes: {} }))
  })
  const expected = '[hypaware:observability] WARN a telemetry export threw; the record is dropped '
    + JSON.stringify({
      hyp_component: 'observability',
      hyp_operation: 'observability.export_logs',
      error_kind: 'telemetry_export_threw',
      telemetry_channel: 'logs',
      telemetry_source: 'NamedBrokenExporter',
      error_message: 'boom',
    })
    + '\n'
  assert.equal(stderr, expected, 'the export line is unchanged by the operation parameter')
})

// The `#index#` half of the settled key, which the export path pins for
// itself two tests above and this path did not. Two exporters of one class is
// a shape only a third party builds (two OTLP endpoints, say) and it is two
// things to fix; on a key of `source#operation` the first to break at close
// consumes the report and the second is undiagnosable for the life of the
// process, which is the bug LLP 0335#one-line minted the index for.
//
// @ref LLP 0335#one-line [tests]: two exporters of one class are two closes to diagnose, not one.
test('two exporters of the same class that both fail to close are each diagnosed', async () => {
  class TwinCloseFailure {
    /** @param {string} label */
    constructor(label) { this.label = label }
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
    async shutdown() { throw new Error(`close failed in ${this.label}`) }
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new TwinCloseFailure('first'), new TwinCloseFailure('second')]),
  })
  const stderr = await captureProcessStderr(async () => {
    await provider.shutdown()
  })
  const reports = stderr.split('\n').filter((line) => line.includes('telemetry_shutdown_threw'))
  assert.equal(reports.length, 2, 'both siblings are diagnosed, not one consuming the other report')
  assert.match(stderr, /close failed in first/, 'the first names itself')
  assert.match(stderr, /close failed in second/, 'and so does the second')
})

// Every other test on this seam uses the logs channel, so a `'logs'` literal
// pasted into the tracer or meter provider's flush and shutdown calls would
// mislabel the report with nothing to catch it. The channel is what tells an
// operator which substrate is broken.
//
// @ref LLP 0335#close-failures [tests]: the report names the channel whose provider is closing.
test('a close failure on the traces channel is reported as traces, not logs', async () => {
  class RejectingCloseExporter {
    /** @param {unknown[]} _spans */
    exportBatch(_spans) {}
    async shutdown() { throw new Error('trace exporter will not close') }
  }
  const provider = new TracerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new RejectingCloseExporter()]),
  })
  const stderr = await captureProcessStderr(async () => {
    await provider.shutdown()
  })
  assert.match(stderr, /"telemetry_channel":"traces"/, 'the channel is the one that was closing')
  assert.match(stderr, /"hyp_operation":"observability\.shutdown_traces"/, 'and the operation names it too')
})

// The property the whole contract rests on, at the seam this change added.
// `reportSettledFailures` runs after the await inside `shutdownExporters`, so
// a report that throws there rejects `provider.shutdown()` into the caller
// and skips the `globalLoggerProvider = null` teardown on the next line: the
// escape LLP 0335#never-throws exists to close, reintroduced by the line that
// reports it. The bound's `reported` set is a public field, which is the
// cheapest way to make the report itself throw at that exact seam.
//
// @ref LLP 0335#never-throws [tests]: a report that throws cannot reject the close it was reporting on.
test('a report that throws does not reject the shutdown it was diagnosing', async () => {
  class RejectingCloseExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
    async shutdown() { throw new Error('close failed') }
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new RejectingCloseExporter()]),
  })
  provider.reportedExporterFailures = /** @type {any} */ ({
    has() { throw new Error('the report itself is broken') },
    add() {},
  })
  await captureProcessStderr(async () => {
    await provider.shutdown()
  })
})

// Not rejecting is only half of what that guard buys. The other half is the
// line after the await: a rejecting `shutdown` skips
// `globalTracerProvider = null`, leaving a provider that failed to close
// still installed and still taking every later span. Pinned on the tracer
// channel because its global slot is the one readable from outside.
//
// @ref LLP 0335#never-throws [tests]: a report that throws cannot strand the provider it was reporting on.
test('a report that throws still lets the provider deregister itself', async () => {
  class RejectingCloseExporter {
    /** @param {unknown[]} _spans */
    exportBatch(_spans) {}
    async shutdown() { throw new Error('close failed') }
  }
  const provider = new TracerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new RejectingCloseExporter()]),
  })
  provider.register()
  assert.equal(trace.getTracerProvider(), provider, 'the provider under test is the installed one')
  provider.reportedExporterFailures = /** @type {any} */ ({
    has() { throw new Error('the report itself is broken') },
    add() {},
  })
  await captureProcessStderr(async () => {
    await provider.shutdown()
  })
  assert.notEqual(trace.getTracerProvider(), provider, 'and it still deregistered itself')
})

// `reported.add(key)` precedes the `process.stderr.write`, so a write syscall
// that itself throws (an EPIPE'd stderr) spends the report instead of being
// retried once per record for the life of the daemon. LLP 0335#one-line calls
// that trade deliberate and nothing pinned it: moving the `add` below the
// write leaves every other test green.
//
// @ref LLP 0335#one-line [tests]: the report is marked spent before the write, so a dead stderr is not retried per record.
test('a report whose own write throws is spent, not retried once per record', async () => {
  class BrokenExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) { throw new Error('boom') }
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new BrokenExporter()]),
  })
  const realWrite = process.stderr.write.bind(process.stderr)
  let attempts = 0
  process.stderr.write = /** @type {typeof process.stderr.write} */ (() => {
    attempts += 1
    throw new Error('EPIPE')
  })
  try {
    for (let index = 0; index < 5; index++) {
      provider.exportRecord(/** @type {any} */ ({ body: 'a record this exporter cannot take', attributes: {} }))
    }
  } finally {
    process.stderr.write = realWrite
  }
  assert.equal(attempts, 1, 'one write attempt is the whole budget; a stderr that is gone is not retried per record')
})

// The other half of what keeps the report safe on the path of every record:
// one line, and a bounded one. An exporter that throws a megabyte of context
// would otherwise put all of it in the daemon log.
//
// @ref LLP 0335#one-line [tests]: the message is capped, so a broken exporter cannot spill its whole context into the log.
test('an enormous thrown message is capped, and still one line', async () => {
  class VerboseBrokenExporter {
    /** @param {unknown[]} _records */
    exportBatch(_records) { throw new Error('x'.repeat(5000)) }
  }
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new VerboseBrokenExporter()]),
  })
  const stderr = await captureProcessStderr(async () => {
    provider.exportRecord(/** @type {any} */ ({ body: 'a record', attributes: {} }))
  })
  assert.equal(stderr.split('\n').filter(Boolean).length, 1, 'still one line')
  const attributes = JSON.parse(stderr.slice(stderr.indexOf('{'), stderr.lastIndexOf('}') + 1))
  assert.equal(attributes.error_message.length, 200, 'the message is capped at the recorded length')
})

// The settled results are labelled from names taken before the await, not
// read back off `provider.exporters` afterwards: that field is public and
// mutable, so a name read on the far side of the await can belong to a
// different exporter than the result it is about to describe. Nothing
// in-tree rewrites the array mid-shutdown, which is exactly why the
// precaution is invisible to every other test.
//
// @ref LLP 0335#close-failures [tests]: a result is named for the exporter that produced it, not for whatever sits at its index later.
test('a close report names the exporter that failed, even if the array is rewritten mid-shutdown', async () => {
  class Impostor {
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
  }
  class FailingClose {
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
    async shutdown() { throw new Error('close failed') }
  }
  class RewritesTheArray {
    /** @param {{ exporters: unknown[] }} provider */
    constructor(provider) { this.provider = provider }
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
    async shutdown() { this.provider.exporters.splice(0, 2, new Impostor(), new Impostor()) }
  }
  /** @type {any} */
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new FailingClose()]),
  })
  provider.exporters.push(new RewritesTheArray(provider))
  const stderr = await captureProcessStderr(async () => {
    await provider.shutdown()
  })
  assert.match(stderr, /"telemetry_source":"FailingClose"/, 'the report names the exporter that actually failed')
  assert.doesNotMatch(stderr, /Impostor/, 'not whatever took its index while the close was in flight')
})

// Same precaution one seam earlier. `flushExporters` takes its own names
// before its own await, and a flush is the path a long-lived daemon walks
// repeatedly, so the two are pinned separately rather than trusting the
// shutdown case to cover both.
//
// @ref LLP 0335#close-failures [tests]: the flush path names its results from before its await too.
test('a flush report names the exporter that failed, even if the array is rewritten mid-flush', async () => {
  class Impostor {
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
  }
  class FailingFlush {
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
    async forceFlush() { throw new Error('flush failed') }
  }
  class RewritesTheArray {
    /** @param {{ exporters: unknown[] }} provider */
    constructor(provider) { this.provider = provider }
    /** @param {unknown[]} _records */
    exportBatch(_records) {}
    async forceFlush() { this.provider.exporters.splice(0, 2, new Impostor(), new Impostor()) }
  }
  /** @type {any} */
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: /** @type {any} */ ([new FailingFlush()]),
  })
  provider.exporters.push(new RewritesTheArray(provider))
  const stderr = await captureProcessStderr(async () => {
    await provider.forceFlush()
  })
  assert.match(stderr, /"telemetry_source":"FailingFlush"/, 'the report names the exporter that actually failed')
  assert.doesNotMatch(stderr, /Impostor/, 'not whatever took its index while the flush was in flight')
})

// And what the diagnosis itself must survive. `String(Object.create(null))`
// is a TypeError, so a rejection carrying one used to throw out of the
// rejection handler, which is an unhandled rejection again: the exact outcome
// the async guard exists to prevent, reintroduced by the line that reports it.
test('a thrown value that cannot be stringified is still reported, and still does not kill the process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-exotic-'))
  try {
    const run = await runModule(root, [
      'class ExoticRejectingExporter {',
      '  async exportBatch() {',
      '    await Promise.resolve()',
      '    throw Object.create(null)',
      '  }',
      '}',
      'logs.setGlobalLoggerProvider(new LoggerProvider({',
      '  resource: { attributes: {} },',
      '  exporters: [new ExoticRejectingExporter()],',
      '}))',
    ])
    assertSurvivedAndDiagnosed(run, /a value that cannot be described/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The bound is per broken exporter, not per class name. Two exporters of one
// class is a shape only a third party builds, and it is two things to fix: a
// name-only key would diagnose whichever broke first and hide the other for
// the life of the process, which is the diagnosability half of #1122 again in
// miniature.
test('two broken exporters of the same class are each diagnosed once', async () => {
  class SameNameBrokenExporter {
    /** @param {string} label */
    constructor(label) { this.label = label }
    /** @param {unknown[]} _records */
    exportBatch(_records) { throw new Error(`broken exporter ${this.label}`) }
  }
  const stderr = await captureProcessStderr(async () => {
    await withLoggerProvider(
      [new SameNameBrokenExporter('one'), new SameNameBrokenExporter('two')],
      () => {
        const log = getLogger('cache')
        log.warn('a record neither of them can take')
        log.warn('and a second one')
      }
    )
  })
  const reports = stderr.split('\n').filter((line) => line.includes('telemetry_export_threw'))
  assert.equal(reports.length, 2, 'one line per broken exporter, still not one per record')
  assert.match(stderr, /broken exporter one/)
  assert.match(stderr, /broken exporter two/)
})

// The other exporter shape, and the one that matters more. `exportBatch` is
// typed as returning `unknown` precisely because an exporter may do its work
// asynchronously, and an asynchronous exporter does not throw, it rejects: a
// synchronous try/catch never sees it, and Node's default
// unhandled-rejection policy ends the process. The mirror line does get
// written, one tick before the process dies, so an in-process test that reads
// captured stderr passes while the daemon is dying. These two have to be real
// subprocesses, judged by exit status.

/**
 * Run `lines` as an ES module in a fresh node process, on top of two imports
 * of the real observability sources and a tail that emits five refusals
 * through the mirror and then says it is still alive.
 *
 * @param {string} root a scratch directory to write the module into
 * @param {string[]} lines
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string }>}
 */
async function runModule(root, lines) {
  const script = path.join(root, 'telemetry-probe.mjs')
  const runtimeUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'observability', 'runtime.js')).href
  const loggerUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'observability', 'logger.js')).href
  await fs.writeFile(script, [
    `import { logs, LoggerProvider } from '${runtimeUrl}'`,
    `import { getLogger } from '${loggerUrl}'`,
    ...lines,
    "const log = getLogger('capture-spool', { mirrorStderr: true })",
    "for (let i = 0; i < 5; i++) log.warn('a symlink stands on the spool sweep path', { error_kind: 'capture_spool_path_is_symlink' })",
    "setTimeout(() => process.stdout.write('SURVIVED\\n'), 20)",
    '',
  ].join('\n'))
  const out = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

/**
 * Both subprocess cases assert the same property: the process lived, the
 * refusal was mirrored anyway, the broken component named itself and said
 * what it rejected with, and it said it once rather than once per record.
 *
 * @param {{ status: number|null, stdout: string, stderr: string }} run
 * @param {RegExp} threw what the broken component rejected with
 */
function assertSurvivedAndDiagnosed(run, threw) {
  assert.equal(run.status, 0, 'a rejection must not end the process whose refusals it is dropping')
  assert.match(run.stdout, /SURVIVED/, 'and the process is still running after the rejection settles')
  assert.match(run.stderr, /capture_spool_path_is_symlink/, 'the mirror still wrote the refusal')
  assert.match(run.stderr, /telemetry_export_threw/, 'and the broken component still names itself')
  assert.match(run.stderr, threw, 'with what it rejected with')
  const reports = run.stderr.split('\n').filter((line) => line.includes('telemetry_export_threw'))
  assert.equal(reports.length, 1, 'still one line, not one per record it dropped')
}

test('an exporter that rejects after an await is diagnosed, and the process lives', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-async-'))
  try {
    const run = await runModule(root, [
      'class AsyncRejectingExporter {',
      '  async exportBatch() {',
      '    await Promise.resolve()',
      "    throw new Error('async exporter blew up after an await')",
      '  }',
      '}',
      'logs.setGlobalLoggerProvider(new LoggerProvider({',
      '  resource: { attributes: {} },',
      '  exporters: [new AsyncRejectingExporter()],',
      '}))',
    ])
    assertSurvivedAndDiagnosed(run, /async exporter blew up after an await/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// And the same shape one seam out, for the foreign provider that
// `setGlobalLoggerProvider` will accept from anyone.
test('a foreign provider whose exportRecord rejects is diagnosed, and the process lives', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-async-foreign-'))
  try {
    const run = await runModule(root, [
      'logs.setGlobalLoggerProvider({',
      '  resource: { attributes: {} },',
      '  async exportRecord() {',
      '    await Promise.resolve()',
      "    throw new Error('this provider is not ours and it rejects')",
      '  },',
      '})',
    ])
    assertSurvivedAndDiagnosed(run, /this provider is not ours and it rejects/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// And the control for the fix itself: a healthy provider must stay as quiet
// as no provider at all. Guarding the exporter loop must not turn ordinary
// telemetry into stderr noise.
test('an installed healthy exporter adds no stderr line of its own', async () => {
  /** @type {unknown[]} */
  const delivered = []
  const healthy = {
    /** @param {unknown[]} records */
    exportBatch(records) { delivered.push(...records) },
  }
  const stderr = await captureProcessStderr(async () => {
    await withLoggerProvider([healthy], () => {
      getLogger('cache').warn('an ordinary warn with no mirror asked for')
    })
  })
  assert.equal(delivered.length, 1, 'the record was exported')
  assert.equal(stderr, '', 'and nothing was printed')
})

// The second seam. `logs.setGlobalLoggerProvider` is exported and takes any
// provider-shaped object, so guarding our own exporter loop only covers the
// providers we build. The mirror has to survive an installed provider whose
// `exportRecord` itself throws, which is what "beside the emit, not behind
// it" has to mean if it means anything.
test('a refusal reaches stderr even when the installed provider itself throws', async () => {
  const foreign = /** @type {any} */ ({
    resource: { attributes: {} },
    /** @param {unknown} _record */
    exportRecord(_record) {
      throw new Error('this provider is not ours and it is broken')
    },
  })
  const stderr = await captureProcessStderr(async () => {
    logs.setGlobalLoggerProvider(foreign)
    try {
      getLogger('capture-spool', { mirrorStderr: true }).warn('a symlink stands on the spool sweep path', {
        [Attr.ERROR_KIND]: 'capture_spool_path_is_symlink',
      })
    } finally {
      logs.setGlobalLoggerProvider(/** @type {any} */ (null))
    }
  })
  assert.match(stderr, /capture_spool_path_is_symlink/, 'the mirror survives a provider that throws')
  assert.match(stderr, /telemetry_export_threw/, 'and the broken provider is diagnosed once')
})

// The two guards inside the guards. Both were added by the review of #1122
// and neither was pinned: removing either left the file green, which for a
// change whose whole subject is "a guard that can itself throw" is the one
// omission that matters.

// A Proxy exporter is the reason `exporterName` exists. The premise of the
// whole seam is an exporter we did not write, and one whose `get` trap throws
// throws from `exporter.constructor.name` as readily as from `exportBatch`.
// Read straight inside the `catch`, that throw is outside every guard: it
// escapes `exportGuarded` and takes the mirror below it with it.
test('an exporter that throws when asked its own name is still diagnosed, under a fallback name', async () => {
  const hostile = /** @type {any} */ (new Proxy({}, {
    /** @param {object} _target @param {string|symbol} key */
    get(_target, key) {
      if (key === 'exportBatch') return () => { throw new Error('this exporter is a hostile proxy') }
      throw new Error(`every other read on this exporter throws: ${String(key)}`)
    },
  }))
  const stderr = await captureProcessStderr(async () => {
    await withLoggerProvider([hostile], () => {
      getLogger('capture-spool', { mirrorStderr: true }).warn('a symlink stands on the spool sweep path', {
        [Attr.ERROR_KIND]: 'capture_spool_path_is_symlink',
      })
    })
  })
  assert.match(stderr, /capture_spool_path_is_symlink/, 'the mirror is not hostage to an exporter that cannot be named')
  assert.match(stderr, /this exporter is a hostile proxy/, 'and the exporter is diagnosed with what it threw')
  assert.match(stderr, /"telemetry_source":"exporter"/, 'under a fallback name, rather than throwing while reading its own')
})

// And the report's own last line of defence. `guardTelemetryResult` is
// exported, and its contract says the seam is read only on the failure path
// "so a caller on a hot path can pass one that costs something to describe":
// a seam that costs something to describe is a seam that can throw while
// being described. That throw happens inside a rejection handler, so
// unwrapped it is an unhandled rejection again, which is the exact outcome
// the handler exists to prevent. Nothing in tree can hand it such a seam
// today, so this reaches for the exported function directly, and it has to be
// a subprocess: the failure is the process dying a tick later, and an
// in-process assertion would already have passed by then.
test('a seam that throws while being described does not turn the rejection back into an unhandled one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-refusal-seam-'))
  try {
    const script = path.join(root, 'seam-probe.mjs')
    const runtimeUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'observability', 'runtime.js')).href
    await fs.writeFile(script, [
      `import { guardTelemetryResult } from '${runtimeUrl}'`,
      'const hostileSeam = {',
      "  channel: 'logs',",
      "  source: 'a seam that cannot be described',",
      "  get key() { throw new Error('describing this seam throws') },",
      '  reported: new Set(),',
      '}',
      "guardTelemetryResult(Promise.reject(new Error('the export rejected')), hostileSeam)",
      "setTimeout(() => process.stdout.write('SURVIVED\\n'), 20)",
      '',
    ].join('\n'))
    const out = spawnSync(process.execPath, [script], { encoding: 'utf8' })
    assert.equal(out.status, 0, 'a seam that throws while being described must not end the process')
    assert.match(out.stdout, /SURVIVED/, 'and the process is still running once the rejection has settled')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The seam ahead of the guard. `buildAttrs` runs before both the emit and the
// mirror, so a value it could not describe threw out of `warn()` and skipped
// the refusal below it: hyparam/hypaware#1122 again, one line earlier, and
// without needing a provider at all. `attrs.js` reached for `String(value)`
// as its last resort, which is a TypeError for a null-prototype object, the
// same trap `describeThrown` was hardened against on the other side of the
// emit.
test('a field value that cannot be described costs the field, not the refusal', async () => {
  const undescribable = Object.create(null)
  undescribable.self = undescribable
  const stderr = await captureProcessStderr(async () => {
    getLogger('capture-spool', { mirrorStderr: true }).warn('a symlink stands on the spool sweep path', {
      [Attr.ERROR_KIND]: 'capture_spool_path_is_symlink',
      detail: undescribable,
    })
  })
  assert.match(stderr, /capture_spool_path_is_symlink/, 'the refusal still reaches stderr on a default install')
  assert.match(stderr, /\[hypaware:capture-spool\] WARN/, 'at its own severity')
  assert.doesNotMatch(stderr, /"detail"/, 'and the one field nobody can describe is simply dropped')
})

// And the field bag itself, one step further out: the spread that feeds
// `buildAttrs` reads every own enumerable property of `fields`, so a throwing
// getter there is ahead of everything. It costs the fields, not the refusal.
test('a field bag whose getter throws costs the fields, not the refusal', async () => {
  const hostileFields = {
    [Attr.ERROR_KIND]: 'capture_spool_path_is_symlink',
    get detail() { throw new Error('reading this field throws') },
  }
  const stderr = await captureProcessStderr(async () => {
    getLogger('capture-spool', { mirrorStderr: true }).warn('a symlink stands on the spool sweep path', hostileFields)
  })
  assert.match(stderr, /\[hypaware:capture-spool\] WARN a symlink stands on the spool sweep path/, 'the refusal still reaches stderr')
  assert.match(stderr, /"hyp_component":"capture-spool"/, 'with the attributes that survive the loss')
})

// The generation key has to be read when the record is emitted, not when a
// rejection settles. Held as a lazy getter on a module constant it was read a
// microtask late, so a rejection belonging to the provider that emitted it
// was filed against whichever provider had been installed since and dropped
// as that one's duplicate: the older provider never diagnosed, which is
// exactly what the generation key was added to prevent.
test('a provider that rejects is diagnosed even if another is installed before the rejection settles', async () => {
  const stderr = await captureProcessStderr(async () => {
    try {
      const rejecting = /** @type {any} */ ({
        resource: { attributes: {} },
        async exportRecord() {
          await Promise.resolve()
          throw new Error('the provider that emitted this rejected')
        },
      })
      const throwing = /** @type {any} */ ({
        resource: { attributes: {} },
        exportRecord() { throw new Error('the provider installed after it threw') },
      })
      logs.setGlobalLoggerProvider(rejecting)
      getLogger('cache').warn('a record the first one cannot take')
      logs.setGlobalLoggerProvider(throwing)
      getLogger('cache').warn('nor the second')
      await new Promise((resolve) => { setTimeout(resolve, 10) })
    } finally {
      logs.setGlobalLoggerProvider(/** @type {any} */ (null))
    }
  })
  assert.match(stderr, /the provider installed after it threw/, 'the newer provider is diagnosed')
  assert.match(stderr, /the provider that emitted this rejected/, 'and so is the one whose rejection landed after it was replaced')
})

// The in-tree half of the close-failure gap. LLP 0335#close-failures could
// name the report but not demonstrate it on anything this repo ships:
// `JsonlWriter.close` resolved from `stream.end`'s callback without reading
// the error that callback is handed, so a disk that took none of the buffered
// records produced a clean shutdown and no line anywhere
// (hyparam/hypaware#1130 item 2, hyparam/hypaware#1137 item 3). The stream is
// broken the way the operating system breaks it, by taking the descriptor
// away, rather than by a fake that agrees with the assertion.
//
// @ref LLP 0337#close-rejects [tests]: a JSONL close that lost its records is diagnosed once on stderr.
test('a JSONL exporter whose stream fails at close says so instead of reporting a clean shutdown', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-jsonl-close-'))
  try {
    const exporter = new JsonlSpanExporter({ dir, pid: 4242 })
    const writer = /** @type {any} */ (exporter).writer
    writer.writeBatch([{ note: 'a record the disk will not keep' }])
    await new Promise((resolve) => { writer.stream.once('open', resolve) })
    // Everything after this write has nowhere to land. The stream reports it
    // asynchronously, which is the failure mode the old close could not see.
    closeSync(writer.stream.fd)
    writer.writeBatch([{ note: 'nor this one' }])

    const provider = new TracerProvider({
      resource: { attributes: { service_name: 'hypaware-test' } },
      exporters: /** @type {any} */ ([exporter]),
    })
    const stderr = await captureProcessStderr(async () => {
      await provider.shutdown()
    })
    assert.match(stderr, /telemetry_shutdown_threw/, 'the failed close names itself')
    assert.match(stderr, /"telemetry_source":"JsonlSpanExporter"/, 'as the exporter that lost the records')
    assert.match(stderr, /buffered records may be lost/, 'and says what the failure costs')
    assert.match(stderr, /EBADF/, 'carrying what the stream actually failed with')
    const reports = stderr.split('\n').filter((line) => line.includes('telemetry_shutdown_threw'))
    assert.equal(reports.length, 1, 'one line for the failed close')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The other direction, and the standing constraint on every line above: a
// JSONL exporter that closes cleanly writes nothing to stderr and everything
// to its file.
test('a healthy JSONL exporter closes silently, with its records on disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-jsonl-close-ok-'))
  try {
    const exporter = new JsonlSpanExporter({ dir, pid: 4243 })
    const writer = /** @type {any} */ (exporter).writer
    writer.writeBatch([{ note: 'a record the disk keeps' }])
    const provider = new TracerProvider({
      resource: { attributes: { service_name: 'hypaware-test' } },
      exporters: /** @type {any} */ ([exporter]),
    })
    const stderr = await captureProcessStderr(async () => {
      await provider.forceFlush()
      await provider.shutdown()
    })
    assert.equal(stderr, '', 'a healthy close is byte-silent')
    const written = await fs.readFile(path.join(dir, 'traces-4243.jsonl'), 'utf8')
    assert.match(written, /a record the disk keeps/, 'and the records are on disk')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The boundary LLP 0335#never-throws named as outside every seam it has: a
// component that fails on a resource it owns rather than on the call we made.
// An `fs.WriteStream` reports such a failure on its own 'error' event, and an
// unlistened 'error' event ends the process - the exact outcome the guard
// exists to prevent, reached without passing through it. A subprocess,
// because the assertion is that the process is still alive.
//
// @ref LLP 0337#writer-owns-its-stream [tests]: a write that fails after the write call returned costs the telemetry, not the process.
test('a JSONL write that fails after the write call returned does not end the process', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-jsonl-async-'))
  try {
    const exportersUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'observability', 'jsonl_exporters.js')).href
    const script = [
      "import fs from 'node:fs'",
      `import { JsonlSpanExporter } from '${exportersUrl}'`,
      `const exporter = new JsonlSpanExporter({ dir: ${JSON.stringify(dir)}, pid: 4244 })`,
      "const writer = exporter.writer",
      "writer.writeBatch([{ note: 'the first record' }])",
      "await new Promise((resolve) => { writer.stream.once('open', resolve) })",
      "fs.closeSync(writer.stream.fd)",
      "writer.writeBatch([{ note: 'the record the closed descriptor cannot take' }])",
      "await new Promise((resolve) => { setTimeout(resolve, 300) })",
      "process.stdout.write('still running\\n')",
    ].join('\n')
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.equal(run.status, 0, `the process survived its telemetry: ${run.stderr}`)
    assert.match(run.stdout, /still running/, 'and went on doing its work')
    assert.doesNotMatch(run.stderr, /Unhandled 'error' event/, 'no uncaught stream error')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The other boundary #close-failures named: a close that hangs rather than
// rejecting. `installObservability`'s shutdown races each provider against a
// budget whose timeout arm resolves, so a provider that never settles lost the
// race, the process exited, and everything it still buffered went with it -
// indistinguishable from a clean shutdown (hyparam/hypaware#1137 item 1).
//
// @ref LLP 0337#budget-report [tests]: a close that outruns the budget is named on stderr, and one that finishes inside it is not.
test('a provider whose close never settles is named when the shutdown budget runs out', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-close-budget-'))
  /** @type {NodeJS.Timeout|undefined} */
  let stuck
  try {
    // No dev telemetry, so the budget is the short one and the test does not
    // wait five seconds to prove it; an endpoint, so providers exist at all.
    const env = readObservabilityEnv({
      HYP_HOME: root,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
    })
    const obs = installObservability({ env })
    // A close that hangs the way a real one does, on something that keeps the
    // event loop alive. A promise pending on nothing at all is a different
    // failure: the loop empties, the process exits, and no report of any kind
    // can run after that (LLP 0337#budget-report names it as the residue).
    const hanging = {
      /** @param {unknown[]} _batch */
      exportBatch(_batch) {},
      shutdown() {
        return new Promise((resolve) => { stuck = setTimeout(resolve, 60_000) })
      },
    }
    const provider = /** @type {any} */ (obs.tracer.provider)
    provider.exporters.push(hanging)
    const stderr = await captureProcessStderr(async () => {
      await obs.shutdown()
    })
    assert.match(stderr, /telemetry_shutdown_timed_out/, 'the hung close is named')
    assert.match(stderr, /"telemetry_channel":"traces"/, 'on the channel whose provider hung')
    assert.match(stderr, /shutdown budget/, 'saying the budget ran out rather than that something threw')
    assert.match(stderr, /buffered records may be lost/, 'and what that costs')
    assert.doesNotMatch(stderr, /"telemetry_channel":"logs"/, 'the providers that closed in time say nothing')
    const reports = stderr.split('\n').filter((line) => line.includes('telemetry_shutdown_timed_out'))
    assert.equal(reports.length, 1, 'one line, not one per provider')
    // Leave no globally registered provider behind for whatever runs next.
    provider.exporters.pop()
    await provider.shutdown()
  } finally {
    if (stuck) clearTimeout(stuck)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a shutdown whose providers all close inside the budget stays byte-silent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-close-budget-ok-'))
  try {
    const env = readObservabilityEnv({
      HYP_HOME: root,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
    })
    const obs = installObservability({ env })
    const stderr = await captureProcessStderr(async () => {
      await obs.shutdown()
    })
    assert.equal(stderr, '', 'a shutdown that finishes says nothing')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The window between `destroy(err)` and the `'error'` event it queues. Node
// sets `destroyed` and `errored` in the same synchronous step and emits ticks
// later, so a close landing in between saw an already-destroyed stream with
// nothing held against it and took the "settled from the held error" branch
// with no held error - a clean shutdown reported over records that were never
// written, which is the exact silence this file exists to end. The test above
// misses it only because it closes before `destroy` has run.
//
// @ref LLP 0337#close-rejects [tests]: a close inside the async-destroy window is still diagnosed.
test('a JSONL close that lands after destroy but before the error event is still diagnosed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-jsonl-destroy-window-'))
  try {
    const exporter = new JsonlSpanExporter({ dir, pid: 4245 })
    const writer = /** @type {any} */ (exporter).writer
    writer.writeBatch([{ note: 'a record the disk keeps' }])
    await new Promise((resolve) => { writer.stream.once('open', resolve) })
    closeSync(writer.stream.fd)
    writer.writeBatch([{ note: 'the record that goes nowhere' }])
    // Wait for the destroy, not for the event: this is the window.
    let spins = 0
    while (!writer.stream.destroyed && spins < 1000) {
      await new Promise((resolve) => { setImmediate(resolve) })
      spins++
    }
    assert.equal(writer.stream.destroyed, true, 'the stream destroyed itself')
    assert.equal(writer.streamError, null, 'and the error event has not arrived yet')

    const provider = new TracerProvider({
      resource: { attributes: { service_name: 'hypaware-test' } },
      exporters: /** @type {any} */ ([exporter]),
    })
    const stderr = await captureProcessStderr(async () => {
      await provider.shutdown()
    })
    assert.match(stderr, /telemetry_shutdown_threw/, 'the close in the window still names itself')
    assert.match(stderr, /EBADF/, 'carrying what the stream actually failed with')
    const written = await fs.readFile(path.join(dir, 'traces-4245.jsonl'), 'utf8')
    assert.doesNotMatch(written, /goes nowhere/, 'and the record really was lost')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The failure that never reaches a stream at all: the directory cannot be
// made, so `ensureOpen` throws and each `exportBatch`'s own `try`/`catch`
// swallows it. Every record is lost and, until the writer held this the way it
// holds what the stream reports, the close resolved clean over all of them.
//
// @ref LLP 0337#writer-owns-its-stream [tests]: a writer that could never open its file says so at close instead of closing clean.
test('a JSONL exporter that cannot open its file at all is diagnosed at close', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-jsonl-unopenable-'))
  try {
    // A file where the parent directory would have to be.
    const blocker = path.join(root, 'blocker')
    await fs.writeFile(blocker, 'not a directory')
    const exporter = new JsonlSpanExporter({ dir: path.join(blocker, 'telemetry'), pid: 4246 })
    const writer = /** @type {any} */ (exporter).writer
    writer.writeBatch([{ note: 'a record with nowhere to go' }])
    const provider = new TracerProvider({
      resource: { attributes: { service_name: 'hypaware-test' } },
      exporters: /** @type {any} */ ([exporter]),
    })
    const stderr = await captureProcessStderr(async () => {
      await provider.shutdown()
    })
    assert.match(stderr, /telemetry_shutdown_threw/, 'the close that lost everything names itself')
    assert.match(stderr, /ENOTDIR/, 'carrying why the file could never be opened')
    assert.match(stderr, /buffered records may be lost/, 'and says what it cost')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The bound on the report, on the writer's side of it: the failure belongs to
// the descriptor that had it, so the close that reported it takes it off, and
// a writer reopened after that close starts clean.
//
// @ref LLP 0337#close-rejects [tests]: a reported failure is not reported again against the next descriptor.
test('a JSONL writer reopened after a failed close does not re-report the old failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-jsonl-reopen-'))
  try {
    const exporter = new JsonlSpanExporter({ dir, pid: 4247 })
    const writer = /** @type {any} */ (exporter).writer
    writer.writeBatch([{ note: 'one' }])
    await new Promise((resolve) => { writer.stream.once('open', resolve) })
    closeSync(writer.stream.fd)
    writer.writeBatch([{ note: 'two' }])
    await assert.rejects(() => exporter.shutdown(), /EBADF/, 'the failed close rejects once')
    await exporter.shutdown()
    writer.writeBatch([{ note: 'three' }])
    const provider = new TracerProvider({
      resource: { attributes: { service_name: 'hypaware-test' } },
      exporters: /** @type {any} */ ([exporter]),
    })
    const stderr = await captureProcessStderr(async () => {
      await provider.shutdown()
    })
    assert.equal(stderr, '', 'the reopened writer closes silently')
    const written = await fs.readFile(path.join(dir, 'traces-4247.jsonl'), 'utf8')
    assert.match(written, /three/, 'with the records the new descriptor took')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The open failure held by `writeBatch` used to be cleared by the next
// `ensureOpen` that succeeded, on the reasoning that a new descriptor should
// not carry the old one's error. True of the error, false of the loss: an
// outage that clears mid-run leaves a healthy descriptor over records that are
// gone regardless, and the close resolved clean over them with nothing on
// stderr. The close is what takes a held failure off the writer now, so a
// recovery cannot erase a loss no close has reported yet.
//
// @ref LLP 0337#writer-owns-its-stream [tests]: a writer whose disk came back still says what it lost while the disk was gone.
test('a JSONL exporter that recovers mid-run still reports what it lost before it could open', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-jsonl-recovers-'))
  try {
    // A file where the parent directory has to be: `ensureOpen` throws, and
    // there is no stream for the failure to be reported on.
    const blocker = path.join(root, 'blocker')
    await fs.writeFile(blocker, 'not a directory')
    const dir = path.join(blocker, 'telemetry')
    const exporter = new JsonlSpanExporter({ dir, pid: 4248 })
    const writer = /** @type {any} */ (exporter).writer
    writer.writeBatch([{ note: 'a record lost while the disk was gone' }])
    // The outage clears, and the writer opens a perfectly healthy descriptor.
    await fs.rm(blocker)
    writer.writeBatch([{ note: 'a record the disk keeps' }])
    assert.ok(writer.stream, 'the writer reopened')

    const provider = new TracerProvider({
      resource: { attributes: { service_name: 'hypaware-test' } },
      exporters: /** @type {any} */ ([exporter]),
    })
    const stderr = await captureProcessStderr(async () => {
      await provider.shutdown()
    })
    assert.match(stderr, /ENOTDIR/, 'the loss the recovery would have erased is still named')
    assert.match(stderr, /buffered records may be lost/, 'and says what it cost')
    // The live descriptor is still closed, with its records on disk: the
    // report must not be paid for with the file the writer did open.
    const written = await fs.readFile(path.join(dir, 'traces-4248.jsonl'), 'utf8')
    assert.match(written, /a record the disk keeps/, 'and the healthy descriptor was still flushed and closed')
    assert.doesNotMatch(written, /while the disk was gone/, 'the lost record really was lost')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The last way a close could resolve clean over lost records: a stream
// destroyed with no error at all. `destroy()` throws the write buffer away and
// leaves `errored` null, so both places the writer reads a failure from are
// empty and the close took the already-destroyed branch and resolved.
//
// @ref LLP 0337#close-rejects [tests]: a destroyed stream with no error to show for it is still a loss, and the close says so.
test('a JSONL close over a stream destroyed with no error does not report a clean shutdown', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-jsonl-destroyed-'))
  try {
    const exporter = new JsonlSpanExporter({ dir, pid: 4249 })
    const writer = /** @type {any} */ (exporter).writer
    writer.writeBatch([{ note: 'the record the destroy throws away' }])
    writer.stream.destroy()
    assert.equal(writer.stream.destroyed, true, 'the stream is destroyed')
    assert.equal(writer.stream.errored, null, 'with no error to read off it')
    assert.equal(writer.streamError, null, 'and nothing held against it')

    const provider = new TracerProvider({
      resource: { attributes: { service_name: 'hypaware-test' } },
      exporters: /** @type {any} */ ([exporter]),
    })
    const stderr = await captureProcessStderr(async () => {
      await provider.shutdown()
    })
    assert.match(stderr, /telemetry_shutdown_threw/, 'the close names itself')
    assert.match(stderr, /destroyed before its records were written/, 'saying what happened to the records')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
