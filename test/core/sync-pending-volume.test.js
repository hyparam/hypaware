// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
import { runSync } from '../../src/core/commands/sync.js'
import { previewPendingRows } from '../../src/core/sinks/pending.js'

// `hyp sync`'s plan is the consent surface: it is where a person decides
// whether to let captured data leave the machine. Naming the destinations
// without naming the volume made every machine's plan look the same, so the
// prompt could not answer the first question a careful operator asks - how
// much, and how far back.
//
// The load-bearing claims:
//   1. The plan states pending rows and the resume point, per destination.
//   2. Withheld rows are stated on their own line, never folded into the
//      pending count and never silently dropped from the summary.
//   3. A machine with no backlog renders differently from one with a backlog,
//      and a rewound watermark changes what the plan says.
//   4. A count that is a floor says "at least"; a count that could not be
//      taken says "unknown". Neither is ever rendered as zero.
//   5. The count is per destination, not per machine: a dataset one
//      destination refuses to forward must not be quoted on its line.
// @ref LLP 0101#no-release [tests]: the "prints what would leave" half, in rows
// @ref LLP 0070#incremental [tests]: withheld rows are disclosed apart from the payload rows

const CACHE_SUBDIR = 'cache'

/** @param {string} prefix */
async function makeHome(prefix) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-syncvol-${prefix}-`))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function stateDir(hypHome) {
  return path.join(hypHome, 'hypaware')
}

/** @param {string} hypHome */
function cacheRoot(hypHome) {
  return path.join(hypHome, CACHE_SUBDIR)
}

/** @param {string} hypHome */
function tablePathFor(hypHome) {
  return path.join(cacheRoot(hypHome), 'datasets', 'ai_gateway_messages', 'source=claude')
}

/**
 * Write a watermark file at the layout the sink plugins actually use, spelled
 * out here rather than derived from the kernel helper: a preview that read the
 * wrong file would report a backlog of zero on a machine that has one, and a
 * test that reuses the helper could not catch that.
 *
 * @param {{ hypHome: string, plugin: string, instance: string, seq: string, updatedAt: string }} args
 */
async function writeWatermark({ hypHome, plugin, instance, seq, updatedAt }) {
  const file = path.join(
    stateDir(hypHome),
    'plugins',
    plugin,
    'sink-instances',
    instance,
    'watermarks',
    'ai_gateway_messages',
    'source=claude.json'
  )
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({ v: 1, continuation: { v: 1, seq }, exportedRowCount: Number(seq), updatedAt })
  )
}

function captureStream() {
  let buf = ''
  return {
    write(/** @type {string} */ chunk) { buf += String(chunk); return true },
    get text() { return buf },
  }
}

/**
 * @param {string} instanceName
 * @param {Record<string, unknown>} config
 * @param {string} [plugin]
 */
function fakeSink(instanceName, config, plugin = '@hypaware/fake') {
  return {
    instanceName,
    plugin,
    kind: 'blob',
    config,
    sink: {
      async exportBatch() {
        return { status: 'exported', partitionsExported: 0, bytesWritten: 0 }
      },
    },
  }
}

/**
 * A storage stub whose `readRowsSince` replays a described entry sequence,
 * honouring `since` exactly as the real seam does (`seq > since`). `dropped`
 * entries stand in for rows the export seam withholds.
 *
 * @param {{ hypHome: string, entries: { seq: number, dropped?: boolean }[] | (() => Iterable<{ seq: number, dropped?: boolean }>), throws?: string }} args
 */
function fakeStorage({ hypHome, entries, throws }) {
  const table = tablePathFor(hypHome)
  return {
    cacheRoot: cacheRoot(hypHome),
    tableExists: (/** @type {string} */ p) => p === table,
    hasPendingSync: () => false,
    async flushTable() {},
    async *readRowsSince(/** @type {string} */ p, /** @type {any} */ opts = {}) {
      if (throws) throw new Error(throws)
      if (p !== table) return
      const since = opts.since ? Number(opts.since.seq) : 0
      const source = typeof entries === 'function' ? entries() : entries
      for (const entry of source) {
        if (entry.seq <= since) continue
        const after = { v: 1, seq: String(entry.seq) }
        if (entry.dropped) yield { after, dropped: true }
        else yield { row: { id: entry.seq }, after }
      }
    },
  }
}

/** @param {string} hypHome */
function fakeQuery(hypHome) {
  return {
    listDatasets: () => [
      {
        name: 'ai_gateway_messages',
        discoverPartitions: () => [
          {
            dataset: 'ai_gateway_messages',
            partition: { source: 'claude' },
            tablePath: tablePathFor(hypHome),
          },
        ],
      },
    ],
  }
}

/**
 * @param {{ hypHome: string, sinks: any[], storage: any, remotes?: Record<string, { url: string }> }} args
 */
function makeCtx({ hypHome, sinks, storage, remotes }) {
  const stdout = captureStream()
  const stderr = captureStream()
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    env: { HYP_HOME: hypHome, HYP_CONFIG: '' },
    cwd: '/home/u',
    config: remotes ? { version: 2, query: { remotes } } : { version: 2 },
    query: fakeQuery(hypHome),
    storage,
    sinks: { listHandles: () => sinks },
  })
  return { ctx, stdout, stderr }
}

/** Twelve captured rows; two of them (5 and 9) are withheld at the export seam. */
const TWELVE_ROWS = Array.from({ length: 12 }, (_, i) => ({
  seq: i + 1,
  dropped: i + 1 === 5 || i + 1 === 9,
}))

test('the plan states pending rows, the resume point, and withheld rows per destination', async () => {
  const hypHome = await makeHome('backlog')
  await writeWatermark({
    hypHome,
    plugin: '@hypaware/central',
    instance: 'central',
    seq: '3',
    updatedAt: '2026-08-12T00:50:31.004Z',
  })
  const sinks = [
    fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central'),
    fakeSink('local', { dir: '/home/u/exports' }, '@hypaware/local-fs'),
  ]
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks,
    storage: fakeStorage({ hypHome, entries: TWELVE_ROWS }),
    remotes: { hyperparam: { url: 'https://hypaware.example.com' } },
  })

  const code = await runSync(['--dry-run'], ctx)

  assert.equal(code, 0)
  // Past watermark seq 3: nine entries, two of them withheld.
  assert.match(stdout.text, /7 rows pending, captured since 2026-08-12T00:50Z/)
  assert.match(stdout.text, /2 rows withheld by policy \(not sent\)/)
  // No watermark for `local` at all, so its range is the whole local history.
  assert.match(stdout.text, /10 rows pending, the full local history/)
  // The withheld rows are stated apart from the pending ones, never added in.
  assert.doesNotMatch(stdout.text, /9 rows pending/)
  assert.doesNotMatch(stdout.text, /12 rows pending/)
})

test('a machine with no backlog renders differently from one with a backlog', async () => {
  const hypHome = await makeHome('empty')
  const sinks = [fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')]
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks,
    storage: fakeStorage({ hypHome, entries: [] }),
  })

  const code = await runSync(['--dry-run'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /nothing pending/)
  assert.doesNotMatch(stdout.text, /rows pending/)
  assert.doesNotMatch(stdout.text, /withheld by policy/)

  // The same command on a machine that has a backlog must not print this.
  const busy = await makeHome('empty-contrast')
  const { ctx: busyCtx, stdout: busyOut } = makeCtx({
    hypHome: busy,
    sinks: [fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')],
    storage: fakeStorage({ hypHome: busy, entries: TWELVE_ROWS }),
  })
  await runSync(['--dry-run'], busyCtx)
  assert.notEqual(busyOut.text, stdout.text, 'a size-free plan is the defect: these must differ')
  assert.doesNotMatch(busyOut.text, /nothing pending/)
})

test('rewinding a watermark changes what the dry-run plan discloses', async () => {
  const hypHome = await makeHome('rewind')
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')
  const storage = fakeStorage({ hypHome, entries: TWELVE_ROWS })

  await writeWatermark({
    hypHome,
    plugin: '@hypaware/central',
    instance: 'central',
    seq: '10',
    updatedAt: '2026-08-20T09:00:00.000Z',
  })
  const before = makeCtx({ hypHome, sinks: [sink], storage })
  await runSync(['--dry-run'], before.ctx)
  assert.match(before.stdout.text, /2 rows pending, captured since 2026-08-20T09:00Z/)

  await writeWatermark({
    hypHome,
    plugin: '@hypaware/central',
    instance: 'central',
    seq: '0',
    updatedAt: '2026-08-20T09:00:00.000Z',
  })
  const after = makeCtx({ hypHome, sinks: [sink], storage })
  await runSync(['--dry-run'], after.ctx)
  assert.match(after.stdout.text, /10 rows pending, captured since 2026-08-20T09:00Z/)
  assert.notEqual(after.stdout.text, before.stdout.text)
})

test('a count that hits its scan budget is disclosed as a floor, never as a total', async () => {
  const hypHome = await makeHome('floor')
  const sinks = [fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')]
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks,
    storage: fakeStorage({
      hypHome,
      entries: function* () {
        for (let seq = 1; seq <= 250000; seq += 1) yield { seq }
      },
    }),
  })

  const code = await runSync(['--dry-run'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /at least 200,000 rows pending, the full local history/)
  assert.doesNotMatch(stdout.text, /nothing pending/)
})

test('a count that cannot be taken says unknown, never zero', async () => {
  const hypHome = await makeHome('unknown')
  const sinks = [fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')]
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks,
    storage: fakeStorage({ hypHome, entries: [], throws: 'cache is unreadable' }),
  })

  const code = await runSync(['--dry-run'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /pending volume unknown/)
  assert.doesNotMatch(stdout.text, /nothing pending/)
  assert.doesNotMatch(stdout.text, /0 rows pending/)
})

test('a spent wall-clock budget yields unknown, not a floor built from one partial partition', async () => {
  const hypHome = await makeHome('budget')
  const handles = /** @type {any[]} */ ([
    fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central'),
    fakeSink('local', { dir: '/home/u/exports' }, '@hypaware/local-fs'),
  ])

  // A clock that jumps past the budget the moment the preview starts counting:
  // the first reading sets the deadline, every later one is past it.
  let readings = 0
  const now = () => (readings++ === 0 ? 1_000 : 9_000)

  const volumes = await previewPendingRows({
    handles,
    query: /** @type {any} */ (fakeQuery(hypHome)),
    storage: /** @type {any} */ (fakeStorage({ hypHome, entries: TWELVE_ROWS })),
    stateRoot: stateDir(hypHome),
    budgetMs: 100,
    now,
  })

  for (const instance of ['central', 'local']) {
    const volume = /** @type {any} */ (volumes.get(instance))
    assert.equal(volume.status, 'unknown', `${instance} must not claim a count it never took`)
    assert.equal(volume.rows, 0)
  }
})

test('a slow scan degrades every destination to a floor, not the first to precision and the rest to unknown', async () => {
  const hypHome = await makeHome('slices')
  const handles = /** @type {any[]} */ ([
    fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central'),
    fakeSink('local', { dir: '/home/u/exports' }, '@hypaware/local-fs'),
  ])

  // A clock driven by the scan itself: each row pulled from storage costs one
  // millisecond of fake time. Two thousand rows against a 600ms budget cannot
  // be counted exactly for both destinations, so this is the machine where the
  // budget's spending order decides who gets an answer. Releasing the
  // first-sync hold is all-or-nothing, so a plan line reading `unknown` covers
  // a destination the confirmation forwards anyway - each destination must land
  // on a labelled floor instead.
  // @ref LLP 0325#slices [tests]: destination i of n counts until scanStart + remaining * (i + 1) / n, so a spent first slice cannot spend the second destination down to unknown
  let t = 0
  const now = () => t
  const entries = function* () {
    for (let seq = 1; seq <= 2000; seq++) {
      t += 1
      yield { seq }
    }
  }

  const volumes = await previewPendingRows({
    handles,
    query: /** @type {any} */ (fakeQuery(hypHome)),
    storage: /** @type {any} */ (fakeStorage({ hypHome, entries })),
    stateRoot: stateDir(hypHome),
    budgetMs: 600,
    now,
  })

  for (const instance of ['central', 'local']) {
    const volume = /** @type {any} */ (volumes.get(instance))
    assert.equal(volume.status, 'partial', `${instance} must report a labelled floor, not '${volume.status}'`)
    assert.ok(volume.rows > 0, `${instance} must have counted something before its deadline`)
  }
})

test('partition discovery is charged to no slice, so the first destination is not the one left unknown', async () => {
  const hypHome = await makeHome('discovery-cost')
  const handles = /** @type {any[]} */ ([
    fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central'),
    fakeSink('local', { dir: '/home/u/exports' }, '@hypaware/local-fs'),
    fakeSink('archive', { dir: '/home/u/archive' }, '@hypaware/local-fs'),
    fakeSink('bucket', { url: 'https://s3.example.com/b' }, '@hypaware/s3'),
  ])

  // Discovery is one shared cost paid before any destination counts, and it is
  // plugin-backed: `discoverPartitions` over a cold cache is exactly the call
  // that takes a large fraction of the budget. Anchoring the slices at the
  // preview's start rather than after discovery charges all of it to slice 0,
  // whose deadline then falls before its first row is read - the first
  // destination reports `unknown` while every later one reports a floor, which
  // is the failure the slices exist to remove, moved rather than removed.
  // 900ms of a 3000ms budget across four destinations ends slice 0 150ms early.
  // @ref LLP 0325#discovery-off-the-top [tests]: the shared discovery cost comes off the top, so no destination inherits an already-spent deadline
  let t = 0
  const now = () => t
  const query = {
    listDatasets: () => [
      {
        name: 'ai_gateway_messages',
        discoverPartitions: async () => {
          t += 900
          return [{ dataset: 'ai_gateway_messages', partition: { source: 'claude' }, tablePath: tablePathFor(hypHome) }]
        },
      },
    ],
  }
  const entries = function* () {
    for (let seq = 1; seq <= 4000; seq++) {
      t += 1
      yield { seq }
    }
  }

  const volumes = await previewPendingRows({
    handles,
    query: /** @type {any} */ (query),
    storage: /** @type {any} */ (fakeStorage({ hypHome, entries })),
    stateRoot: stateDir(hypHome),
    budgetMs: 3000,
    now,
  })

  for (const instance of ['central', 'local', 'archive', 'bucket']) {
    const volume = /** @type {any} */ (volumes.get(instance))
    assert.equal(volume.status, 'partial', `${instance} must report a labelled floor, not '${volume.status}'`)
    assert.ok(volume.rows > 0, `${instance} must have counted something before its deadline`)
  }
  // The bound the budget exists to enforce: discovery plus every slice still
  // fits inside it, so paying discovery off the top buys fairness and not time.
  assert.ok(t <= 3000 + CLOCK_CHECK_SLACK, `the preview overran its budget: ${t}ms`)
})

/**
 * One in-flight `readRowsSince` block may overshoot a deadline, because the row
 * loop checks the clock every 512 rows rather than every row. Four destinations
 * can therefore each overshoot by up to one block.
 */
const CLOCK_CHECK_SLACK = 4 * 512

test('a budget discovery has already overrun leaves every destination unknown, at any destination count', async () => {
  const hypHome = await makeHome('spent-budget')
  // The slices are divided in floating point over `Date.now()` magnitudes,
  // where a share smaller than half a ULP rounds away completely. A budget
  // discovery has already spent leaves a negative remainder, and dividing that
  // across enough destinations hands the early ones a deadline of exactly
  // `scanStart` - not in the past, so they count a spent clock's worth of rows
  // and report an *exact* total. This is the one place a spent budget can stop
  // looking spent, and it is the disclosure the budget exists to bound, so it
  // is floored rather than left to rounding.
  // @ref LLP 0325#spent-is-spent [tests]: a spent budget puts every deadline in the past at every n, not only where the share survives rounding
  const handles = /** @type {any[]} */ (
    Array.from({ length: 20000 }, (_, i) => fakeSink(`sink${i}`, {}, '@hypaware/local-fs'))
  )
  // A real wall-clock magnitude: the rounding only bites at `Date.now()` scale.
  let t = 1788035340357
  const now = () => t
  const query = {
    listDatasets: () => [
      {
        name: 'ai_gateway_messages',
        discoverPartitions: async () => {
          t += 3001
          return [{ dataset: 'ai_gateway_messages', partition: { source: 'claude' }, tablePath: tablePathFor(hypHome) }]
        },
      },
    ],
  }
  for (const instance of ['sink0', 'sink1', 'sink2']) {
    await writeWatermark({
      hypHome,
      plugin: '@hypaware/local-fs',
      instance,
      seq: '10',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })
  }

  const volumes = await previewPendingRows({
    handles,
    query: /** @type {any} */ (query),
    storage: /** @type {any} */ (fakeStorage({ hypHome, entries: TWELVE_ROWS })),
    stateRoot: stateDir(hypHome),
    budgetMs: 3000,
    now,
  })

  assert.equal(volumes.size, 20000)
  const notUnknown = [...volumes.entries()].filter(([, v]) => v.status !== 'unknown')
  assert.deepEqual(
    notUnknown.map(([name, v]) => `${name}:${v.status}`),
    [],
    'a budget already spent by discovery must leave no destination with a count'
  )
})

test('rows still buffered in the spool make the count a floor rather than a silent undercount', async () => {
  const hypHome = await makeHome('spool')
  const storage = fakeStorage({ hypHome, entries: TWELVE_ROWS })
  storage.hasPendingSync = () => true
  const sinks = [fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')]
  const { ctx, stdout } = makeCtx({ hypHome, sinks, storage })

  const code = await runSync(['--dry-run'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /at least 10 rows pending/)
})

test('a plan still renders when the count itself throws: unknown, never a missing or zero line', async () => {
  const hypHome = await makeHome('throws')
  const sinks = [fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')]
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks,
    storage: fakeStorage({ hypHome, entries: [] }),
  })
  // The dataset catalog is plugin-backed, so listing it can fail outright. The
  // plan is the consent surface: it has to render anyway.
  ctx.query = { listDatasets() { throw new Error('catalog is corrupt') } }

  const code = await runSync(['--dry-run'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /central/)
  assert.match(stdout.text, /pending volume unknown/)
  assert.doesNotMatch(stdout.text, /nothing pending/)
})

test('previewPendingRows never rejects, even when storage itself throws on every call', async () => {
  const hypHome = await makeHome('nothrow')
  const exploding = {
    get cacheRoot() { throw new Error('storage is gone') },
    tableExists() { throw new Error('storage is gone') },
    hasPendingSync() { throw new Error('storage is gone') },
    async *readRowsSince() { throw new Error('storage is gone') },
  }
  const volumes = await previewPendingRows({
    handles: /** @type {any[]} */ ([fakeSink('central', {}, '@hypaware/central')]),
    query: /** @type {any} */ (fakeQuery(hypHome)),
    storage: /** @type {any} */ (exploding),
    stateRoot: stateDir(hypHome),
  })

  const volume = /** @type {any} */ (volumes.get('central'))
  assert.equal(volume.status, 'unknown')
  assert.equal(volume.rows, 0)
})

test('a truncated count never claims a resume point it did not survey', async () => {
  const hypHome = await makeHome('resume')
  // Two partitions. The first is enormous and carries a recent watermark; the
  // second has no watermark at all, so the destination would forward the whole
  // local history through it. A count that stops inside the first partition
  // must not report the first partition's cursor as the destination's range.
  const cache = cacheRoot(hypHome)
  const big = path.join(cache, 'datasets', 'ai_gateway_messages', 'source=claude')
  const virgin = path.join(cache, 'datasets', 'ai_gateway_messages', 'source=codex')
  await writeWatermark({
    hypHome,
    plugin: '@hypaware/central',
    instance: 'central',
    seq: '0',
    updatedAt: '2026-08-24T23:00:00.000Z',
  })
  const storage = {
    cacheRoot: cache,
    tableExists: () => true,
    hasPendingSync: () => false,
    async *readRowsSince(/** @type {string} */ p) {
      const total = p === big ? 500000 : 3
      for (let seq = 1; seq <= total; seq += 1) yield { row: { seq }, after: { v: 1, seq: String(seq) } }
    },
  }
  const query = {
    listDatasets: () => [{
      name: 'ai_gateway_messages',
      discoverPartitions: () => [
        { dataset: 'ai_gateway_messages', partition: { source: 'claude' }, tablePath: big },
        { dataset: 'ai_gateway_messages', partition: { source: 'codex' }, tablePath: virgin },
      ],
    }],
  }

  const volumes = await previewPendingRows({
    handles: /** @type {any[]} */ ([fakeSink('central', {}, '@hypaware/central')]),
    query: /** @type {any} */ (query),
    storage: /** @type {any} */ (storage),
    stateRoot: stateDir(hypHome),
  })

  const volume = /** @type {any} */ (volumes.get('central'))
  assert.equal(volume.status, 'partial', 'the row count stopped at the scan budget')
  // The unsurveyed-by-the-row-pass partition has no cursor, so the range is the
  // machine's whole history: reporting the big partition's recent cursor would
  // understate the reach on the one line consent is given from.
  assert.equal(volume.resume.kind, 'beginning')
  assert.notEqual(volume.resume.kind, 'since')
})

test('a destination whose whole pending range is withheld never renders "at least 0 rows pending"', async () => {
  const hypHome = await makeHome('allwithheld')
  const storage = fakeStorage({
    hypHome,
    entries: Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, dropped: true })),
  })
  storage.hasPendingSync = () => true
  const sinks = [fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')]
  const { ctx, stdout } = makeCtx({ hypHome, sinks, storage })

  const code = await runSync(['--dry-run'], ctx)

  assert.equal(code, 0)
  assert.doesNotMatch(stdout.text, /at least 0 rows pending/)
  assert.doesNotMatch(stdout.text, /nothing pending/)
  assert.match(stdout.text, /pending volume not fully counted/)
  // The floor mark belongs on this line too, and this is the branch where it
  // carries the whole magnitude: the payload line has stood down to "not fully
  // counted", so the withheld tally is the only number on screen. An
  // unqualified `6` here would be the one exact-looking figure on an
  // admittedly incomplete count.
  assert.match(stdout.text, /at least 6 rows withheld by policy \(not sent\)/)
})

test('one partition whose cursor cannot be derived costs that partition, not the whole count', async () => {
  const hypHome = await makeHome('badcursor')
  const cache = cacheRoot(hypHome)
  const countable = path.join(cache, 'datasets', 'ai_gateway_messages', 'source=claude')
  // A partition whose table path is not under the cache datasets root: deriving
  // a watermark key for it throws, so its cursor never resolves. That is one
  // partition's problem. Throwing the *other* partition's ten counted rows away
  // and blaming a scan budget that was never spent tells the person at the
  // prompt two untrue things at once.
  const stray = path.join(hypHome, 'elsewhere', 'ai_gateway_messages', 'source=codex')
  const storage = {
    cacheRoot: cache,
    tableExists: () => true,
    hasPendingSync: () => false,
    async *readRowsSince(/** @type {string} */ p) {
      const total = p === countable ? 10 : 5
      for (let seq = 1; seq <= total; seq += 1) yield { row: { seq }, after: { v: 1, seq: String(seq) } }
    },
  }
  const query = {
    listDatasets: () => [{
      name: 'ai_gateway_messages',
      discoverPartitions: () => [
        { dataset: 'ai_gateway_messages', partition: { source: 'claude' }, tablePath: countable },
        { dataset: 'ai_gateway_messages', partition: { source: 'codex' }, tablePath: stray },
      ],
    }],
  }

  const volumes = await previewPendingRows({
    handles: /** @type {any[]} */ ([fakeSink('central', {}, '@hypaware/central')]),
    query: /** @type {any} */ (query),
    storage: /** @type {any} */ (storage),
    stateRoot: stateDir(hypHome),
  })

  const volume = /** @type {any} */ (volumes.get('central'))
  assert.equal(volume.status, 'partial', 'the readable partition still yields a floor')
  assert.equal(volume.rows, 10)
  assert.equal(volume.reason, 'part of the cache could not be read')
  assert.notEqual(volume.reason, 'the count hit its scan budget')
})

test('a cursor whose timestamp will not parse never lets another partition stand as the range', async () => {
  const hypHome = await makeHome('badstamp')
  const cache = cacheRoot(hypHome)
  const recent = path.join(cache, 'datasets', 'ai_gateway_messages', 'source=claude')
  const undated = path.join(cache, 'datasets', 'ai_gateway_messages', 'source=codex')
  const dir = path.join(
    stateDir(hypHome), 'plugins', '@hypaware/central', 'sink-instances', 'central',
    'watermarks', 'ai_gateway_messages'
  )
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'source=claude.json'),
    JSON.stringify({ v: 1, continuation: { v: 1, seq: '5' }, exportedRowCount: 5, updatedAt: '2026-08-24T23:00:00.000Z' })
  )
  // A valid cursor with no readable timestamp. It bounds nothing, so the recent
  // partition's cursor must not stand in for the destination's whole range: the
  // undated partition may reach much further back, and understating the reach
  // is the one direction this disclosure must never be wrong in.
  await fs.writeFile(
    path.join(dir, 'source=codex.json'),
    JSON.stringify({ v: 1, continuation: { v: 1, seq: '2' }, exportedRowCount: 2 })
  )
  const storage = {
    cacheRoot: cache,
    tableExists: () => true,
    hasPendingSync: () => false,
    async *readRowsSince(/** @type {string} */ _p, /** @type {any} */ opts = {}) {
      const since = opts.since ? Number(opts.since.seq) : 0
      for (let seq = 1; seq <= 10; seq += 1) {
        if (seq > since) yield { row: { seq }, after: { v: 1, seq: String(seq) } }
      }
    },
  }
  const query = {
    listDatasets: () => [{
      name: 'ai_gateway_messages',
      discoverPartitions: () => [
        { dataset: 'ai_gateway_messages', partition: { source: 'claude' }, tablePath: recent },
        { dataset: 'ai_gateway_messages', partition: { source: 'codex' }, tablePath: undated },
      ],
    }],
  }

  const volumes = await previewPendingRows({
    handles: /** @type {any[]} */ ([fakeSink('central', {}, '@hypaware/central')]),
    query: /** @type {any} */ (query),
    storage: /** @type {any} */ (storage),
    stateRoot: stateDir(hypHome),
  })

  const volume = /** @type {any} */ (volumes.get('central'))
  assert.equal(volume.rows, 13)
  assert.equal(volume.resume.kind, 'unknown')
  assert.notEqual(volume.resume.kind, 'since')
})

test('an incomplete count marks the withheld line as a floor too, and an exact count does not', async () => {
  // Both tallies come off one pass, so whatever shortened it shortened both. A
  // withheld line that renders an exact-looking number beside "at least N rows
  // pending" understates what policy held back, on the one line that tells the
  // person at the prompt policy is working at all.
  //
  // The renderer keys off `status === 'partial'`, not off which shortfall
  // produced it, so one shortfall proves the rendering for all of them. This
  // case uses the cheapest one to stage, an unflushed spool: `runSync` does not
  // plumb `rowLimit`/`budgetMs`, so reaching `partial` by scan budget through it
  // costs a 250,000-row fixture, which is the price the floor case above pays.
  const short = await makeHome('withheld-floor')
  const shortStorage = fakeStorage({ hypHome: short, entries: TWELVE_ROWS })
  // Buffered rows the preview will not flush to count: the same short pass
  // produced both numbers.
  shortStorage.hasPendingSync = () => true
  const shortRun = makeCtx({
    hypHome: short,
    sinks: [fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')],
    storage: shortStorage,
  })

  assert.equal(await runSync(['--dry-run'], shortRun.ctx), 0)
  assert.match(shortRun.stdout.text, /at least 10 rows pending/)
  assert.match(shortRun.stdout.text, /at least 2 rows withheld by policy \(not sent\)/)
  assert.doesNotMatch(
    shortRun.stdout.text,
    /^ +2 rows withheld by policy/m,
    'an unqualified withheld count next to a floor claims a precision the scan never had'
  )

  // The mark is earned, not decorative: a complete count still states an exact
  // withheld total.
  const whole = await makeHome('withheld-exact')
  const wholeRun = makeCtx({
    hypHome: whole,
    sinks: [fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central')],
    storage: fakeStorage({ hypHome: whole, entries: TWELVE_ROWS }),
  })

  assert.equal(await runSync(['--dry-run'], wholeRun.ctx), 0)
  assert.match(wholeRun.stdout.text, /^ +2 rows withheld by policy \(not sent\)/m)
  assert.doesNotMatch(wholeRun.stdout.text, /at least 2 rows withheld/)
})

// ---------------------------------------------------------------------------
// Claim 5: the count belongs to the destination, not to the machine.
// ---------------------------------------------------------------------------

/**
 * A real `@hypaware/central` forward sink, built only far enough to answer
 * `datasetDisposition`. Its `fetchFn` throws on purpose: the preview asks this
 * sink what it would forward and must never make it forward anything.
 *
 * @param {{ query: unknown, storage: unknown }} args
 */
function centralForwardSink({ query, storage }) {
  const noop = () => {}
  return createForwardSink({
    config: /** @type {any} */ ({ url: 'http://server:8740', identity: {} }),
    identityClient: /** @type {any} */ ({ async getCurrentJwt() { return 'jwt' }, async refresh() {} }),
    query: /** @type {any} */ (query),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ ({
      keyFor: () => ({ dataset: 'unused', partitionKey: 'unused' }),
      filePath: () => 'unused',
      async read() { return null },
      async write() { throw new Error('the preview must not move a watermark') },
    }),
    rollouts: /** @type {any} */ ({
      filePath: () => 'unused',
      async read() { return null },
      async write() { throw new Error('the preview must not write a rollout manifest') },
    }),
    log: /** @type {any} */ ({ debug: noop, info: noop, warn: noop, error: noop }),
    fetchFn: /** @type {any} */ (async () => { throw new Error('the preview must not reach the network') }),
    sleepFn: async () => {},
  })
}

test('a local-only dataset counts for a local-fs destination and not for a central one', async () => {
  // The over-count LLP 0324 exists to remove. `@hypaware/central` refuses any
  // dataset declaring `localOnlyContentColumns`, so quoting its rows on the
  // central line tells the person at the prompt that data leaves the machine
  // which never will. `@hypaware/local-fs` exports that same dataset, so the
  // rows are real for it - which is exactly why the kernel cannot filter them
  // generically and has to ask each destination.
  //
  // The load-bearing assertion is that the two lines differ. Two destinations
  // over one machine's cache quoting one number is the defect.
  // @ref LLP 0324#disposition-seam [tests]: one dataset, two destinations, two different pending counts
  // @ref LLP 0324#skips [tests]: a skipped dataset leaves the destination's tally entirely rather than moving to the withheld line
  const hypHome = await makeHome('localonly')
  const table = path.join(cacheRoot(hypHome), 'datasets', 'context_graph_nodes', 'source=claude')
  const dataset = {
    name: 'context_graph_nodes',
    plugin: '@hypaware/context-graph',
    schema: { fields: [{ name: 'id', type: 'string' }] },
    localOnlyContentColumns: ['content_text'],
    discoverPartitions: () => [
      { dataset: 'context_graph_nodes', partition: { source: 'claude' }, tablePath: table },
    ],
  }
  const query = { listDatasets: () => [dataset], getDataset: () => dataset }
  const storage = {
    cacheRoot: cacheRoot(hypHome),
    tableExists: (/** @type {string} */ p) => p === table,
    hasPendingSync: () => false,
    async flushTable() {},
    async *readRowsSince(/** @type {string} */ p, /** @type {any} */ opts = {}) {
      if (p !== table) return
      const since = opts.since ? Number(opts.since.seq) : 0
      for (let seq = 1; seq <= 12; seq += 1) {
        if (seq > since) yield { row: { id: seq }, after: { v: 1, seq: String(seq) } }
      }
    },
  }

  const central = {
    ...fakeSink('central', { url: 'https://hypaware.example.com' }, '@hypaware/central'),
    sink: centralForwardSink({ query, storage }),
  }
  const local = fakeSink('local', { dir: '/home/u/exports' }, '@hypaware/local-fs')

  const volumes = await previewPendingRows({
    handles: /** @type {any[]} */ ([central, local]),
    query: /** @type {any} */ (query),
    storage: /** @type {any} */ (storage),
    stateRoot: stateDir(hypHome),
  })
  const centralVolume = /** @type {any} */ (volumes.get('central'))
  const localVolume = /** @type {any} */ (volumes.get('local'))

  assert.equal(localVolume.rows, 12, 'local-fs exports this dataset, so all twelve rows are real for it')
  assert.equal(centralVolume.rows, 0, 'central refuses this dataset, so none of these rows leave through it')
  assert.notEqual(
    centralVolume.rows,
    localVolume.rows,
    'two destinations with different forwarding rules must not quote one number'
  )
  // A skipped dataset is not a policy drop: its cursor never advances, so
  // folding it into the withheld line would overstate what policy did.
  assert.equal(centralVolume.withheldRows, 0)
  // Nor is it a range: central would forward nothing, so it reaches nowhere.
  assert.equal(centralVolume.resume.kind, 'unknown')
  assert.notEqual(centralVolume.resume.kind, 'beginning')
  // Zero here is the destination's real answer, not a count that failed, so it
  // is a counted zero and the plan may say so.
  assert.equal(centralVolume.status, 'counted')

  const { ctx, stdout } = makeCtx({ hypHome, sinks: [central, local], storage })
  ctx.query = query
  assert.equal(await runSync(['--dry-run'], ctx), 0)
  assert.match(stdout.text, /12 rows pending, the full local history/)
  assert.match(stdout.text, /nothing pending/)
  assert.doesNotMatch(stdout.text, /withheld by policy/)
})

// ---------------------------------------------------------------------------
// The disposition seam's degraded and non-central answers. Central answers only
// `forwards` and `skips`, so nothing else in the suite reaches the kernel's
// `starts-from-now` arm or its fail-open path, and an untested arm on a consent
// surface is an arm that can rot into under-disclosure unnoticed.
// ---------------------------------------------------------------------------

/** Twelve plain rows, nothing withheld, so a count is either 12 or a decision. */
const TWELVE_PLAIN_ROWS = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1 }))

/**
 * One destination whose sink answers `datasetDisposition` however the caller
 * says, over the twelve-row cache every other test in this file uses.
 *
 * @param {{ hypHome: string, disposition?: (dataset: any) => unknown }} args
 */
async function previewWithDisposition({ hypHome, disposition }) {
  const sink = /** @type {any} */ ({
    async exportBatch() { return { status: 'exported', partitionsExported: 0, bytesWritten: 0 } },
  })
  if (disposition) sink.datasetDisposition = disposition
  const handle = /** @type {any} */ ({
    instanceName: 'dest', plugin: '@hypaware/fake', kind: 'blob', config: {}, sink,
  })
  const volumes = await previewPendingRows({
    handles: [handle],
    query: /** @type {any} */ (fakeQuery(hypHome)),
    storage: /** @type {any} */ (fakeStorage({ hypHome, entries: TWELVE_PLAIN_ROWS })),
    stateRoot: stateDir(hypHome),
  })
  return /** @type {any} */ (volumes.get('dest'))
}

test('every answer the kernel cannot use is counted as `forwards`, not as a skip', async () => {
  // The degraded direction is chosen. `forwards` is today's behaviour and the
  // over-disclosing answer, so a sink that cannot be asked, throws when asked,
  // or answers something outside the union is counted in full rather than
  // quietly dropped off the prompt.
  // @ref LLP 0324#fail-open-loud [tests]: absence, a throw, and an unrecognized answer all read as `forwards`
  /** @type {[string, ((dataset: any) => unknown) | undefined][]} */
  const answers = [
    ['no method at all', undefined],
    ['a method that throws', () => { throw new Error('plugin blew up') }],
    ['undefined', () => undefined],
    ['null', () => null],
    ['a number', () => 3],
    ['the near-miss string `skip`', () => 'skip'],
    ['the wrong case `SKIPS`', () => 'SKIPS'],
    ['an object that stringifies to `skips`', () => ({ toString: () => 'skips' })],
    ['a promise of `skips`', async () => 'skips'],
  ]
  for (const [label, disposition] of answers) {
    const hypHome = await makeHome('failopen')
    const volume = await previewWithDisposition({ hypHome, disposition })
    assert.equal(volume.rows, 12, `${label} must be counted in full, not silently removed from the prompt`)
    assert.equal(volume.withheldRows, 0, label)
    assert.equal(volume.resume.kind, 'beginning', `${label} must still claim the reach it would have`)
  }
})

test('a `starts-from-now` destination counts zero without a cursor and incrementally with one', async () => {
  // The kernel arm LLP 0324 built for a sink whose baseline is not written at
  // creation. No central sink answers this today, so this synthetic one is the
  // only thing holding the rule.
  // @ref LLP 0324#starts-from-now [tests]: a missing watermark means zero, not the beginning, and a present one counts incrementally
  const fresh = await makeHome('startnow-fresh')
  const freshVolume = await previewWithDisposition({
    hypHome: fresh,
    disposition: () => 'starts-from-now',
  })
  assert.equal(freshVolume.rows, 0, 'this destination ships none of the history it has no cursor for')
  assert.equal(freshVolume.status, 'counted', "zero here is the sink's own answer, not a count that failed")
  assert.notEqual(freshVolume.resume.kind, 'beginning', 'a range it does not reach must not be announced')

  const cursored = await makeHome('startnow-cursored')
  await writeWatermark({
    hypHome: cursored,
    plugin: '@hypaware/fake',
    instance: 'dest',
    seq: '3',
    updatedAt: '2026-08-12T00:50:31.004Z',
  })
  const cursoredVolume = await previewWithDisposition({
    hypHome: cursored,
    disposition: () => 'starts-from-now',
  })
  assert.equal(cursoredVolume.rows, 9, 'a partition with a cursor counts incrementally, unchanged')
  assert.equal(cursoredVolume.resume.kind, 'since')
})

test('a `skips` destination stays out of the withheld tally and out of the resume range', async () => {
  // A skipped dataset's cursor never advances, so folding it into the withheld
  // line would report policy activity that did not happen, and letting it claim
  // a resume range would describe a reach the destination does not have.
  // @ref LLP 0324#skips [tests]: a skipped dataset contributes to neither tally and claims no range, with or without a cursor
  const hypHome = await makeHome('skips-cursored')
  await writeWatermark({
    hypHome,
    plugin: '@hypaware/fake',
    instance: 'dest',
    seq: '3',
    updatedAt: '2026-08-12T00:50:31.004Z',
  })
  const volume = await previewWithDisposition({ hypHome, disposition: () => 'skips' })
  assert.equal(volume.rows, 0)
  assert.equal(volume.withheldRows, 0)
  assert.equal(volume.status, 'counted')
  assert.equal(volume.resume.kind, 'unknown')
})

test('a partition named after some other dataset is counted in full, not skipped on its behalf', async () => {
  // The seam is asked about a `DatasetRegistration`, but the driver routes a
  // partition by `partition.dataset`. When a registration emits a partition
  // under a different name, a `skips` answer describes a dataset the export
  // would not have routed under that name, so believing it could drop rows the
  // export ships. Fail open, like every other answer the preview cannot use.
  // @ref LLP 0324#fail-open-loud [tests]: a disposition that cannot be lined up with what the export routes counts as `forwards`
  const hypHome = await makeHome('namemismatch')
  const misnaming = {
    listDatasets: () => [
      {
        name: 'some_other_dataset',
        discoverPartitions: () => [
          { dataset: 'ai_gateway_messages', partition: { source: 'claude' }, tablePath: tablePathFor(hypHome) },
        ],
      },
    ],
  }
  const handle = /** @type {any} */ ({
    instanceName: 'dest',
    plugin: '@hypaware/fake',
    kind: 'blob',
    config: {},
    sink: {
      datasetDisposition: () => 'skips',
      async exportBatch() { return { status: 'exported', partitionsExported: 0, bytesWritten: 0 } },
    },
  })
  const volume = /** @type {any} */ ((await previewPendingRows({
    handles: [handle],
    query: /** @type {any} */ (misnaming),
    storage: /** @type {any} */ (fakeStorage({ hypHome, entries: TWELVE_PLAIN_ROWS })),
    stateRoot: stateDir(hypHome),
  })).get('dest'))
  assert.equal(volume.rows, 12)
  assert.equal(volume.resume.kind, 'beginning')
})
