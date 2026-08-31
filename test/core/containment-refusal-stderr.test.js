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
import { fileURLToPath, pathToFileURL } from 'node:url'

import { sweepCaptureSpool } from '../../src/core/capture_spool.js'
import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createCacheSpool, SPOOL_DIR } from '../../src/core/cache/spool.js'
import { getLogger } from '../../src/core/observability/logger.js'
import { logs, LoggerProvider } from '../../src/core/observability/runtime.js'
import { Attr } from '../../src/core/observability/attrs.js'

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
  // Named uniquely: the provider reports a broken exporter once per exporter
  // name, so a shared name would let one test consume another's report.
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
  await provider.shutdown()
  assert.deepEqual(closed, { flushed: true, shut: true }, 'the exporter behind the broken one was still flushed and closed')
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
