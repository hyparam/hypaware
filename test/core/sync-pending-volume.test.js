// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

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
  assert.match(stdout.text, /6 rows withheld by policy \(not sent\)/)
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

test('a truncated scan marks the withheld line as a floor too, and an exact count does not', async () => {
  // Both tallies come off one scan, so one truncation applies to both. A
  // withheld line that renders an exact-looking number beside "at least N rows
  // pending" understates what policy held back, on the one line that tells the
  // person at the prompt policy is working at all.
  const short = await makeHome('withheld-floor')
  const shortStorage = fakeStorage({ hypHome: short, entries: TWELVE_ROWS })
  // Buffered rows the preview will not flush to count: the same short scan
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
