// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { createSyncProgress, runSync } from '../../src/core/commands/sync.js'
import {
  SYNC_HELD_NO_DESTINATIONS_EXIT,
  firstSyncHoldMarkerPath,
  writeFirstSyncHoldMarker,
} from '../../src/core/usage-policy/first_sync_hold.js'
import { writeClientSyncEntries, writeLocalOnlyEntries } from '../../src/core/usage-policy/index.js'

test('sync progress estimates from acknowledged rows and resets per destination', () => {
  let now = 0
  const volumes = new Map([
    ['central', { status: /** @type {const} */ ('counted'), rows: 1000, withheldRows: 100, resume: { kind: /** @type {const} */ ('beginning') } }],
    ['archive', { status: /** @type {const} */ ('counted'), rows: 2000, withheldRows: 0, resume: { kind: /** @type {const} */ ('beginning') } }],
  ])
  const progress = createSyncProgress(volumes, () => now)
  progress.update('central')
  assert.match(progress.render(), /0\/1,000 rows \(0%\).*ETA unavailable/)
  now = 10_000
  // The 10s before the first acknowledgement was the driver's dataset
  // discovery and spool flush, which is paid once rather than per row, so it
  // is not in the rate.
  progress.update('central', { rows: 250, bytes: 1000 })
  assert.equal(progress.render(), 'central: 250/1,000 rows (25%) | ETA ~3s')
  now = 20_000
  progress.update('central', { rows: 250, bytes: 1000 })
  assert.equal(progress.render(), 'central: 500/1,000 rows (50%) | ETA ~10s')
  now = 35_000
  // 15s since the acknowledgement at 20s, not 35s since the destination
  // started: the number sits next to "waiting for progress" and is read as
  // how long it has been stuck.
  assert.match(progress.render(), /waiting for progress \(15s\).*ETA unavailable/)
  progress.update('central', { rows: 500, bytes: 3000 })
  assert.match(progress.render(), /1,000 rows sent.*finalizing/)
  assert.doesNotMatch(progress.render(), /100%/)
  progress.update('archive')
  assert.match(progress.render(), /archive: 0\/2,000 rows/)
  progress.update('archive', { rows: 2001, bytes: 4000 })
  assert.match(progress.render(), /2,001 rows sent.*ETA unavailable/)
  assert.doesNotMatch(progress.render(), /%/)
})

test('sync progress keeps ticking for a destination whose sink never reports', () => {
  let now = 0
  const volumes = new Map([
    ['archive', { status: /** @type {const} */ ('counted'), rows: 12_000, withheldRows: 0, resume: { kind: /** @type {const} */ ('beginning') } }],
  ])
  const progress = createSyncProgress(volumes, () => now)
  progress.update('archive')
  // `onProgress` is optional on the export contract, and half the shipped
  // sinks never call it: `@hypaware/s3`, and the table-format sink an iceberg
  // destination instantiates. This one line is then their whole export, so it
  // has to keep showing that something is still happening.
  const frames = [0, 37_000, 94_000].map((at) => { now = at; return progress.render() })
  assert.deepEqual(frames.map((frame) => /\((\d+)s\)/.exec(frame)?.[1]), ['0', '37', '94'])
  assert.equal(new Set(frames).size, 3, 'a destination that never reports must not render a frozen line')
})

test('sync progress keeps finalizing through a commit longer than the stall window', () => {
  let now = 0
  const volumes = new Map([
    ['central', { status: /** @type {const} */ ('counted'), rows: 1000, withheldRows: 0, resume: { kind: /** @type {const} */ ('beginning') } }],
  ])
  const progress = createSyncProgress(volumes, () => now)
  progress.update('central')
  now = 5_000
  progress.update('central', { rows: 1000, bytes: 4000 })
  const committing = progress.render()
  assert.match(committing, /central: 1,000 rows sent \| finalizing\.\.\. \(0s\)/)
  // The last chunk is acknowledged, so by construction no further
  // acknowledgement is coming: a commit that outlasts the stall window must
  // not report a finished transfer as "99% | waiting for progress". It must
  // still tick, though - a commit is the one wait long enough to need it.
  now = 60_000
  assert.match(progress.render(), /central: 1,000 rows sent \| finalizing\.\.\. \(55s\)/)
  assert.notEqual(progress.render(), committing, 'a long commit must not render a frozen line')
  assert.doesNotMatch(progress.render(), /waiting for progress|%/)
})

test('sync progress never treats a partial or missing count as a total', () => {
  const progress = createSyncProgress(new Map([
    ['central', { status: 'partial', rows: 10, withheldRows: 0, resume: { kind: 'unknown' } }],
  ]))
  for (const name of ['central', 'unknown']) {
    progress.update(name)
    progress.update(name, { rows: 5, bytes: 100 })
    assert.match(progress.render(), /5 rows sent.*ETA unavailable/)
    assert.doesNotMatch(progress.render(), /%/)
  }
})

test('sync threads acknowledged progress through the driver to the terminal', async () => {
  const hypHome = await makeHome('upload-progress')
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  sink.sink.exportBatch = async (_batch, opts) => {
    opts.onProgress({ rows: 123, bytes: 456 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    return { status: 'exported', partitionsExported: 1, bytesWritten: 456 }
  }
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink], stdoutTty: true })
  assert.equal(await runSync(['--yes'], ctx), 0)
  assert.match(stdout.text, /central: 123 rows sent/)
  assert.match(stdout.text, /central: exported/)
  await fs.rm(hypHome, { recursive: true, force: true })
})

test('sync reads a sink progress report the way it reads a sink result: a number or nothing', async () => {
  const hypHome = await makeHome('upload-progress-hostile')
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  sink.sink.exportBatch = async (_batch, opts) => {
    opts.onProgress({ rows: 7, bytes: 8 })
    // An argument-less call is the plugin saying nothing. It must not reach
    // the display as the kernel's own start-of-destination signal, which is
    // what an absent progress object means there.
    opts.onProgress()
    // Counts come from sink code the kernel does not own, and land in a line
    // somebody is watching an upload on.
    opts.onProgress({ rows: 'lots', bytes: null })
    // A negative is the same class of input, and the worse one: `rows`
    // accumulates, so it holds the running total below the real one for the
    // rest of the destination.
    opts.onProgress({ rows: -5000, bytes: -1 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    return { status: 'exported', partitionsExported: 1, bytesWritten: 8 }
  }
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink], stdoutTty: true })
  assert.equal(await runSync(['--yes'], ctx), 0)
  assert.doesNotMatch(stdout.text, /NaN/)
  assert.doesNotMatch(stdout.text, /-[\d,]+ rows sent/)
  assert.match(stdout.text, /central: 7 rows sent/)
  await fs.rm(hypHome, { recursive: true, force: true })
})

test('sync progress does not let a zero-row report stand in for progress', () => {
  let now = 0
  const volumes = new Map([
    ['central', { status: /** @type {const} */ ('counted'), rows: 1000, withheldRows: 0, resume: { kind: /** @type {const} */ ('beginning') } }],
  ])
  const progress = createSyncProgress(volumes, () => now)
  progress.update('central')
  now = 10_000
  progress.update('central', { rows: 250, bytes: 1000 })
  assert.equal(progress.render(), 'central: 250/1,000 rows (25%) | ETA ~3s')
  // A zero-row report is a truthy object with nothing acknowledged. Counting
  // one as an acknowledgement keeps the line quiet for as long as the reports
  // keep arriving, which is the stall the warning exists to surface.
  for (let at = 11_000; at <= 100_000; at += 1_000) {
    now = at
    progress.update('central', { rows: 0, bytes: 0 })
  }
  assert.equal(progress.render(), 'central: 250/1,000 rows (25%) | waiting for progress (90s) | ETA unavailable')
})

test('sync progress does not anchor its rate at a zero-row report', () => {
  let now = 0
  const volumes = new Map([
    ['central', { status: /** @type {const} */ ('counted'), rows: 1000, withheldRows: 0, resume: { kind: /** @type {const} */ ('beginning') } }],
  ])
  const progress = createSyncProgress(volumes, () => now)
  progress.update('central')
  // Zero-row reports arriving during the driver's setup work. Anchoring the
  // rate on one charges that one-time setup to the transfer rate.
  for (const at of [1_000, 5_000, 9_000]) {
    now = at
    progress.update('central', { rows: 0, bytes: 0 })
  }
  now = 10_000
  progress.update('central', { rows: 250, bytes: 1000 })
  now = 11_000
  // 250 rows in the 1s since the first acknowledgement, not in the 11s since
  // the destination started: 750 rows remaining at 250 rows/s.
  assert.equal(progress.render(), 'central: 250/1,000 rows (25%) | ETA ~3s')
})

test('a sink bare-calling onProgress cannot hold the stall warning off the line', async (t) => {
  const hypHome = await makeHome('upload-progress-bare-loop')
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  sink.sink.exportBatch = async (_batch, opts) => {
    opts.onProgress({ rows: 123, bytes: 456 })
    clock += 20_000
    // A third-party sink may call `onProgress` with no argument at all, which
    // the driver reads as zero rows. Twenty seconds of it is still a stall.
    for (let i = 0; i < 50; i += 1) opts.onProgress()
    await new Promise((resolve) => setTimeout(resolve, 200))
    return { status: 'exported', partitionsExported: 1, bytesWritten: 456 }
  }
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink], stdoutTty: true })
  assert.equal(await runSync(['--yes'], ctx), 0)
  assert.match(stdout.text, /central: 123 rows sent \| waiting for progress \(20s\)/)
  await fs.rm(hypHome, { recursive: true, force: true })
})

// `hyp sync` (LLP 0101 #no-release, as amended): the user-facing export verb
// that replaced `hyp sink force`. What these cover is the consent gate, not
// the tick - the driver's export path is already covered by the sink tests
// and the local_parquet_export smoke.
//
// The load-bearing claims:
//   1. Nothing exports without a confirmation, in either tier.
//   2. Confirming during the review window is the one thing that ends it early.
//   3. Declining, or having no TTY to ask, leaves the window intact.
// @ref LLP 0101#no-release [tests]: the confirmed release path and its refusals

/** @param {string} prefix */
async function makeHome(prefix) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-sync-${prefix}-`))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function stateDir(hypHome) {
  return path.join(hypHome, 'hypaware')
}

/** @param {boolean} [isTTY] */
function captureStream(isTTY = false) {
  let buf = ''
  return {
    isTTY,
    write(/** @type {string} */ chunk) { buf += String(chunk); return true },
    get text() { return buf },
  }
}

/**
 * A sink handle the driver can tick, recording every exportBatch call so a
 * test can assert that nothing was sent.
 *
 * @param {string} instanceName
 * @param {Record<string, unknown>} config
 * @param {{ status?: string }} [result]
 */
function fakeSink(instanceName, config, result = {}) {
  /** @type {unknown[]} */
  const exported = []
  return {
    instanceName,
    plugin: '@hypaware/fake',
    kind: 'blob',
    config,
    exported,
    sink: {
      async exportBatch(/** @type {unknown} */ batch, /** @type {any} */ _opts = {}) {
        exported.push(batch)
        return { status: result.status ?? 'exported', partitionsExported: 0, bytesWritten: 0 }
      },
    },
  }
}

/** @param {string} instanceName @param {Record<string, unknown>} config */
function fakeHistorySink(instanceName, config) {
  const replayed = []
  return {
    instanceName,
    plugin: '@hypaware/central',
    kind: 'request',
    config,
    replayed,
    sink: {
      async exportBatch() {
        throw new Error('ordinary export must not run in history mode')
      },
      async previewSourceHistory(/** @type {{ source: string }} */ request) {
        return { rows: request.source === 'claude' ? 12 : 0, withheldRows: 3 }
      },
      async replaySourceHistory(/** @type {{ source: string }} */ request) {
        replayed.push(request)
        return { status: 'exported', rowsReplayed: 12, bytesWritten: 345 }
      },
    },
  }
}

/**
 * `stdoutTty` is separate from `tty` (which is stdin's): the prompt reads
 * stdin and the spinner writes stdout, and most of these tests want an
 * answerable prompt without an animating stdout.
 *
 * @param {{ hypHome: string, sinks: any[], tty?: boolean, stdoutTty?: boolean, answer?: string, remotes?: Record<string, { url: string }> }} args
 */
function makeCtx({ hypHome, sinks, tty = false, stdoutTty = false, answer, remotes }) {
  const stdout = captureStream(stdoutTty)
  const stderr = captureStream()
  const stdin = Object.assign(new PassThrough(), { isTTY: tty })
  if (answer !== undefined) stdin.write(`${answer}\n`)
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    stdin,
    env: { HYP_HOME: hypHome, HYP_CONFIG: '' },
    cwd: '/home/u',
    config: remotes ? { version: 2, query: { remotes } } : { version: 2 },
    query: { listDatasets: () => [] },
    storage: {
      cacheRoot: path.join(hypHome, 'cache'),
      tableExists: () => false,
      hasPendingSync: () => false,
      async flushTable() {},
    },
    sinks: { listHandles: () => sinks },
  })
  return { ctx, stdout, stderr }
}

/** @param {string} hypHome */
async function holdExists(hypHome) {
  try {
    await fs.access(firstSyncHoldMarkerPath(stateDir(hypHome)))
    return true
  } catch {
    return false
  }
}

test('no TTY and no --yes: refuses, exports nothing, and leaves the hold standing', async () => {
  const hypHome = await makeHome('no-tty')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stderr } = makeCtx({ hypHome, sinks: [sink], tty: false })

  const code = await runSync([], ctx)

  assert.equal(code, 2)
  assert.match(stderr.text, /refusing to sync without confirmation/)
  assert.deepEqual(sink.exported, [], 'a refusal must not export')
  assert.ok(await holdExists(hypHome), 'a refusal must not end the review window')
})

test('declining at the prompt cancels, exports nothing, and leaves the hold standing', async () => {
  const hypHome = await makeHome('decline')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink], tty: true, answer: 'n' })

  const code = await runSync([], ctx)

  assert.equal(code, 0, 'declining is a normal outcome, not an error')
  assert.match(stdout.text, /sync cancelled/)
  assert.deepEqual(sink.exported, [])
  assert.ok(await holdExists(hypHome), 'declining must not end the review window')
})

test('confirming during the review window ends it and exports', async () => {
  const hypHome = await makeHome('confirm-held')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink], tty: true, answer: 'y' })

  const code = await runSync([], ctx)

  assert.equal(code, 0)
  assert.equal(sink.exported.length, 1, 'a confirmed sync exports')
  assert.equal(await holdExists(hypHome), false, 'the marker is cleared, not merely bypassed')
  assert.match(stdout.text, /central: exported/)
})

test('the held prompt states the window, the irreversibility, and the way out', async () => {
  const hypHome = await makeHome('held-warning')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks: [fakeSink('central', { url: 'https://hypaware.example.com' })],
    tty: true,
    answer: 'n',
  })

  await runSync([], ctx)

  const text = stdout.text
  assert.match(text, /First upload: .*including your imported history/)
  assert.match(text, /ends the review window/)
  assert.match(text, /cannot be undone/)
  assert.match(text, /hypaware-privacy skill/)
  assert.match(text, /hyp privacy`/)
})

test('--dry-run prints the plan, exports nothing, and keeps the window open', async () => {
  const hypHome = await makeHome('dry-run')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  // A TTY with no answer queued: a dry run must not reach the prompt at all,
  // so this would hang if it did.
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink], tty: true })

  const code = await runSync(['--dry-run'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /\[dry-run\] nothing was sent/)
  assert.deepEqual(sink.exported, [])
  assert.ok(await holdExists(hypHome))
})

// Both previews are full scans that run before this verb has printed
// anything, so a big backlog leaves the terminal blank for seconds between
// the keystroke and the plan. Off a TTY that path stays byte-identical.
test('the pending preview animates on a TTY and clears before the plan', async () => {
  const hypHome = await makeHome('preview-spinner')
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  // A TTY with no answer queued: `--dry-run` must not reach the prompt.
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink], tty: true, stdoutTty: true })

  assert.equal(await runSync(['--dry-run'], ctx), 0)

  const text = stdout.text
  assert.match(text, /\r\x1b\[2K\S Counting pending rows/, 'the preview wait animates')
  // Transient: every frame is behind a line-clearing carriage return, and the
  // plan renders after the last clear rather than under a leftover label.
  assert.doesNotMatch(text, /Counting pending rows[^\r]*\n/)
  assert.match(text.split('\r\x1b[2K').pop() ?? '', /hyp sync:/)
})

test('the pending preview writes nothing off a TTY', async () => {
  const hypHome = await makeHome('preview-plain')
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink] })

  assert.equal(await runSync(['--dry-run'], ctx), 0)

  assert.doesNotMatch(stdout.text, /Counting pending rows/)
  assert.doesNotMatch(stdout.text, /\x1b\[2K/)
})

test('the --history preview animates per destination on a TTY', async () => {
  const hypHome = await makeHome('history-preview-spinner')
  const central = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [central], tty: true, stdoutTty: true })

  assert.equal(await runSync(['--history', 'claude', '--dry-run'], ctx), 0)

  const text = stdout.text
  assert.match(text, /\r\x1b\[2K\S Counting retained 'claude' history on central/)
  assert.doesNotMatch(text, /Counting retained[^\r]*\n/)
  assert.match(text.split('\r\x1b[2K').pop() ?? '', /12 rows retained and eligible/)
})

test('the --history preview writes nothing off a TTY', async () => {
  const hypHome = await makeHome('history-preview-plain')
  const central = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [central] })

  assert.equal(await runSync(['--history', 'claude', '--dry-run'], ctx), 0)

  assert.doesNotMatch(stdout.text, /Counting retained/)
  assert.doesNotMatch(stdout.text, /\x1b\[2K/)
})

// @ref LLP 0345#command [tests]: retained history has its own preview,
// confirmation, and execution path, separate from an ordinary sink tick.
test('--history previews capable destinations and sends only after confirmation', async () => {
  const hypHome = await makeHome('history-confirm')
  const central = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  const parquet = fakeSink('parquet', { dir: '/home/u/exports' })
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks: [central, parquet],
    tty: true,
    answer: 'y',
    remotes: { prod: { url: 'https://hypaware.example.com' } },
  })

  const code = await runSync(['--history', 'claude'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /retained 'claude' history/)
  assert.match(stdout.text, /12 rows retained and eligible/)
  assert.match(stdout.text, /3 rows withheld by privacy policy \(not sent\)/)
  assert.match(stdout.text, /not replayed.*parquet/)
  assert.deepEqual(central.replayed, [{ source: 'claude' }])
  assert.deepEqual(parquet.exported, [], 'history mode never runs an ordinary tick')
})

test('--history --dry-run never calls the replay operation', async () => {
  const hypHome = await makeHome('history-dry-run')
  const central = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [central], tty: true })

  const code = await runSync(['--history', 'claude', '--dry-run'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /12 rows retained and eligible/)
  assert.match(stdout.text, /\[dry-run\] nothing was sent/)
  assert.deepEqual(central.replayed, [])
})

// `--history` matches `client_name`, which is not always the picker id, so a
// name that resolves to nothing is the likely outcome of a normal mistake.
// Reporting it as `exported (rows=0)` after a confirmation prompt reads as
// "your history was contributed".
test('--history says so when no retained history is attributed to the client', async () => {
  const hypHome = await makeHome('history-zero-rows')
  const central = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [central], tty: true, answer: 'y' })

  const code = await runSync(['--history', 'claude-desktop'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /no retained history is attributed to 'claude-desktop'/)
  // The fake withholds 3 rows for this source, so the name is not the only
  // candidate explanation and the output must not pin it on the name alone.
  assert.match(stdout.text, /withheld by privacy policy \(above\)/)
  assert.doesNotMatch(stdout.text, /exported/)
  assert.deepEqual(central.replayed, [], 'a zero-row replay never prompts or sends')
})

// Every capable destination replays the same retained history, so summing
// their previews would quote double the rows a two-sink machine replays.
test('--history quotes the rows once when two destinations can replay', async () => {
  const hypHome = await makeHome('history-two-destinations')
  const one = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  const two = fakeHistorySink('backup', { url: 'https://backup.example.com' })
  const { ctx, stderr } = makeCtx({ hypHome, sinks: [one, two], tty: true, answer: 'y' })

  const code = await runSync(['--history', 'claude'], ctx)

  assert.equal(code, 0)
  // The prompt goes to stderr (src/core/cli/confirm.js).
  assert.match(stderr.text, /Replay 12 retained rows/)
  assert.doesNotMatch(stderr.text, /24 retained rows/)
  assert.deepEqual(one.replayed, [{ source: 'claude' }])
  assert.deepEqual(two.replayed, [{ source: 'claude' }])
})

// An empty `--history=` value is falsy, so without an explicit guard the flag
// vanishes and the run silently becomes an ordinary all-destination sync that
// also ends the first-sync review window.
test('--history with an empty value is a usage error, not an ordinary sync', async () => {
  const hypHome = await makeHome('history-empty-value')
  const central = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  const parquet = fakeSink('parquet', { dir: '/home/u/exports' })
  const { ctx, stderr } = makeCtx({ hypHome, sinks: [central, parquet], tty: true, answer: 'y' })

  const code = await runSync(['--history=', '--yes'], ctx)

  assert.equal(code, 2)
  assert.match(stderr.text, /--history needs a client name/)
  assert.deepEqual(central.replayed, [])
  assert.deepEqual(parquet.exported, [])
})

test('--history reports a throwing destination as failed instead of crashing the command', async () => {
  const hypHome = await makeHome('history-execute-failure')
  const central = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  central.sink.replaySourceHistory = async () => { throw new Error('network unavailable') }
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [central], tty: true, answer: 'y' })

  const code = await runSync(['--history', 'claude'], ctx)

  assert.equal(code, 1)
  assert.match(stdout.text, /central: failed \(network unavailable\)/)
})

test('--history refuses while the client is still local-only', async () => {
  const hypHome = await makeHome('history-client-local')
  await writeClientSyncEntries({
    stateDir: stateDir(hypHome),
    entries: [{ source: 'claude', class: 'local-only' }],
  })
  const central = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stderr } = makeCtx({ hypHome, sinks: [central], tty: true, answer: 'y' })

  const code = await runSync(['--history', 'claude'], ctx)

  assert.equal(code, 1)
  assert.match(stderr.text, /'claude' is still local-only/)
  assert.match(stderr.text, /hyp privacy client claude sync/)
  assert.deepEqual(central.replayed, [])
})

test('--history cannot bypass the first-sync review window', async () => {
  const hypHome = await makeHome('history-held')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const central = fakeHistorySink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stderr } = makeCtx({ hypHome, sinks: [central], tty: true, answer: 'y' })

  const code = await runSync(['--history', 'claude'], ctx)

  assert.equal(code, 2)
  assert.match(stderr.text, /cannot bypass or clear that hold/)
  assert.deepEqual(central.replayed, [])
  assert.ok(await holdExists(hypHome))
})

test('a sharing plan shows upload targets without counting the accompanying file copy', async () => {
  const hypHome = await makeHome('plan')
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks: [
      fakeSink('central', { url: 'https://hypaware.example.com' }),
      fakeSink('parquet', { dir: '/home/u/exports' }),
      fakeSink('mystery', {}),
    ],
    tty: true,
    remotes: { prod: { url: 'https://hypaware.example.com/' } },
  })

  await runSync(['--dry-run'], ctx)

  const text = stdout.text
  // A server is named, never spelled as a URL a terminal would autolink
  // (LLP 0100 R1a's reason, applied to this surface).
  assert.match(text, /central\s+the 'prod' server\n/)
  assert.doesNotMatch(text, /https:\/\//)
  assert.match(text, /\(run 'hyp remote list' to see server URLs\)/)
  assert.doesNotMatch(text, /parquet|\/home\/u\/exports|destinations|leaves this machine|stays on this machine|local-only/)
  assert.match(text, /mystery\s+@hypaware\/fake\n/)
})

test('sharing shows only upload progress and results but still writes the file copy', async () => {
  for (const copyFirst of [true, false]) {
    const hypHome = await makeHome('shared-copy')
    const upload = fakeSink('central', { url: 'https://hypaware.example.com' })
    const copy = fakeSink('archive-copy', { dir: '/home/u/exports' })
    for (const handle of [upload, copy]) {
      const exportBatch = handle.sink.exportBatch
      handle.sink.exportBatch = async (batch, opts) => {
        opts.onProgress({ rows: 123, bytes: 456 })
        await new Promise((resolve) => setTimeout(resolve, 150))
        return exportBatch(batch, opts)
      }
    }
    const { ctx, stdout, stderr } = makeCtx({
      hypHome, sinks: copyFirst ? [copy, upload] : [upload, copy],
      tty: true, stdoutTty: true, answer: 'y',
    })
    assert.equal(await runSync([], ctx), 0)
    assert.match(stdout.text, /central: 123 rows sent/)
    assert.match(stdout.text, /central: exported/)
    // `Preparing upload` alone cannot tell the two orders apart: the spinner
    // renders its first frame before the tick starts, so that line is on
    // screen in both. What distinguishes them is `Finishing`, which only a
    // copy running *after* the upload can produce.
    assert.match(stdout.text, /Preparing upload/)
    assert[copyFirst ? 'doesNotMatch' : 'match'](stdout.text, /Finishing/)
    assert.match(stderr.text, /Send now to /)
    assert.doesNotMatch(stdout.text + stderr.text, /archive-copy|\/home\/u\/exports|\d destinations/)
    assert.equal(copy.exported.length, 1)
    assert.equal(upload.exported.length, 1)
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a failed accompanying copy remains visible and fails the command', async () => {
  const hypHome = await makeHome('shared-copy-failed')
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks: [
      fakeSink('central', { url: 'https://hypaware.example.com' }),
      fakeSink('archive-copy', { dir: '/home/u/exports' }, { status: 'failed' }),
    ],
  })
  assert.equal(await runSync(['--yes'], ctx), 1)
  assert.match(stdout.text, /archive-copy: failed/)
  await fs.rm(hypHome, { recursive: true, force: true })
})

test('a file-only sync still names its target and reports its result', async () => {
  const hypHome = await makeHome('file-only-plan')
  const { ctx, stdout } = makeCtx({
    hypHome, sinks: [fakeSink('archive', { dir: '/home/u/exports' })],
  })
  assert.equal(await runSync(['--yes'], ctx), 0)
  assert.match(stdout.text, /archive\s+\/home\/u\/exports/)
  assert.match(stdout.text, /archive: exported/)
  await fs.rm(hypHome, { recursive: true, force: true })
})

test('an unnamed server falls back to its host, still not a linkifiable URL', async () => {
  const hypHome = await makeHome('unnamed-server')
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks: [fakeSink('central', { url: 'https://elsewhere.example.com/ingest' })],
    tty: true,
    remotes: {},
  })

  await runSync(['--dry-run'], ctx)

  assert.match(stdout.text, /central\s+elsewhere\.example\.com\n/)
  assert.doesNotMatch(stdout.text, /https:\/\//)
})

test('a named instance cannot release the hold: the plan it showed was not the hold\'s scope', async () => {
  // The hold is driver-wide (LLP 0101 #hold). A plan built from one handle
  // omits every other destination, so confirming it would forward them
  // unseen - the silent first forward the hold exists to prevent.
  const hypHome = await makeHome('scoped-held')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const central = fakeSink('central', { url: 'https://hypaware.example.com' })
  const parquet = fakeSink('parquet', { dir: '/home/u/exports' })
  const { ctx, stderr } = makeCtx({
    hypHome,
    sinks: [central, parquet],
    tty: true,
    answer: 'y',
  })

  const code = await runSync(['parquet'], ctx)

  assert.equal(code, 2)
  assert.match(stderr.text, /review window is open until /)
  assert.match(stderr.text, /all-or-nothing/)
  assert.match(stderr.text, /would forward the others unseen/)
  assert.ok(await holdExists(hypHome), 'the marker must survive a scoped run')
  assert.deepEqual(parquet.exported, [], 'nothing exports while the window stands')
  assert.deepEqual(central.exported, [])
})

test('--yes cannot release the hold: #no-release licenses an attended confirmation only', async () => {
  const hypHome = await makeHome('yes-held')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stderr } = makeCtx({ hypHome, sinks: [sink], tty: false })

  const code = await runSync(['--yes'], ctx)

  assert.equal(code, 2)
  assert.match(stderr.text, /--yes cannot do it/)
  assert.ok(await holdExists(hypHome), 'a script must not end somebody else\'s review window')
  assert.deepEqual(sink.exported, [])
})

test('a hold that cannot be cleared fails loudly instead of exiting 0 with nothing sent', async () => {
  const hypHome = await makeHome('clear-fails')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const policyDir = path.dirname(firstSyncHoldMarkerPath(stateDir(hypHome)))
  await fs.chmod(policyDir, 0o500)
  const sink = fakeSink('central', { url: 'https://hypaware.example.com' })
  const { ctx, stderr } = makeCtx({ hypHome, sinks: [sink], tty: true, answer: 'y' })

  try {
    const code = await runSync([], ctx)

    assert.equal(code, 1, 'a held tick that exported nothing is not a success')
    assert.match(stderr.text, /could not end the review window/)
    assert.match(stderr.text, /Nothing was sent/)
    assert.deepEqual(sink.exported, [])
  } finally {
    await fs.chmod(policyDir, 0o700)
  }
})

test('the plan counts the directories being withheld', async () => {
  const hypHome = await makeHome('exclusions')
  await writeLocalOnlyEntries({
    stateDir: stateDir(hypHome),
    entries: [
      { dir: '/home/u/secret', class: 'local-only' },
      { dir: '/home/u/other', class: 'local-only' },
      { dir: '/home/u/never', class: 'ignore' },
    ],
  })
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks: [fakeSink('central', { url: 'https://hypaware.example.com' })],
    tty: true,
  })

  await runSync(['--dry-run'], ctx)

  assert.match(stdout.text, /excluded: 3 directories/)
})

test('the plan names the clients kept local-only (LLP 0188 #never-silent)', async () => {
  const hypHome = await makeHome('client-exclusions')
  await writeClientSyncEntries({
    stateDir: stateDir(hypHome),
    entries: [
      { source: 'openclaw', class: 'local-only' },
      { source: 'hermes', class: 'local-only' },
    ],
  })
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks: [fakeSink('central', { url: 'https://hypaware.example.com' })],
    tty: true,
  })

  await runSync(['--dry-run'], ctx)

  assert.match(stdout.text, /excluded clients: hermes · openclaw/)
  assert.doesNotMatch(stdout.text, /no directories or clients are marked/)
})

test('with no exclusions, the plan adds no policy narration', async () => {
  const hypHome = await makeHome('no-exclusions')
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks: [fakeSink('central', { url: 'https://hypaware.example.com' })],
    tty: true,
  })

  await runSync(['--dry-run'], ctx)

  assert.doesNotMatch(stdout.text, /local-only|ignore|excluded|no directories or clients/)
})

test('with no hold, --yes exports without inventing a review window', async () => {
  const hypHome = await makeHome('unheld')
  const sink = fakeSink('parquet', { dir: '/home/u/exports' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink] })

  const code = await runSync(['--yes'], ctx)

  assert.equal(code, 0)
  assert.equal(sink.exported.length, 1)
  assert.doesNotMatch(stdout.text, /First upload:/)
})

test('an unknown instance names the ones that exist', async () => {
  const hypHome = await makeHome('unknown')
  const { ctx, stderr } = makeCtx({
    hypHome,
    sinks: [fakeSink('central', { url: 'https://hypaware.example.com' })],
  })

  const code = await runSync(['nope', '--yes'], ctx)

  assert.equal(code, 1)
  assert.match(stderr.text, /no sink named 'nope'/)
  assert.match(stderr.text, /available: central/)
})

test('an instance argument ticks only that sink (no hold in play)', async () => {
  const hypHome = await makeHome('one-instance')
  const central = fakeSink('central', { url: 'https://hypaware.example.com' })
  const parquet = fakeSink('parquet', { dir: '/home/u/exports' })
  const { ctx } = makeCtx({ hypHome, sinks: [central, parquet] })

  const code = await runSync(['parquet', '--yes'], ctx)

  assert.equal(code, 0)
  assert.equal(parquet.exported.length, 1)
  assert.deepEqual(central.exported, [], 'a named instance must not wake the others')
})

test('a held machine with no destinations says so rather than exiting 0', async () => {
  const hypHome = await makeHome('held-no-sinks')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const { ctx, stderr } = makeCtx({ hypHome, sinks: [], tty: true, answer: 'y' })

  const code = await runSync([], ctx)

  assert.equal(code, SYNC_HELD_NO_DESTINATIONS_EXIT)
  assert.match(stderr.text, /no destinations are configured/)
  assert.match(stderr.text, /review window/)
  assert.ok(await holdExists(hypHome), 'nothing was sent, so the window still stands')
  assert.match(stderr.text, /run `hyp sync` again/, 'an attended caller can just rerun')
})

// "Run `hyp sync` again" is advice a `--yes` caller cannot take: with a
// destination configured, that rerun hits the held `--yes` refusal and exits 2.
test('the held no-destinations advice is followable by the --yes caller who got it', async () => {
  const hypHome = await makeHome('held-no-sinks-yes')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const { ctx, stderr } = makeCtx({ hypHome, sinks: [], tty: false })

  const code = await runSync(['--yes'], ctx)

  assert.equal(code, SYNC_HELD_NO_DESTINATIONS_EXIT)
  assert.match(stderr.text, /no destinations are configured/)
  assert.match(stderr.text, /from a terminal/)
  assert.match(stderr.text, /--yes cannot do it/)
  assert.doesNotMatch(
    stderr.text,
    /run `hyp sync` again/,
    'the bare rerun is what the held --yes refusal rejects'
  )
  assert.ok(await holdExists(hypHome), 'nothing was sent, so the window still stands')
})

// The report is for a run that offered to send. A dry run never did, so it
// keeps the exit code an inspection script reads as "I looked, nothing to
// see" - the same exemption `--dry-run` already has from the held refusals.
test('a held machine with no destinations still exits 0 under --dry-run', async () => {
  const hypHome = await makeHome('held-no-sinks-dry-run')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const { ctx, stdout, stderr } = makeCtx({ hypHome, sinks: [], tty: true })

  const code = await runSync(['--dry-run'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /no sinks instantiated; nothing to do/)
  assert.doesNotMatch(stderr.text, /review window/)
  assert.ok(await holdExists(hypHome))
})

// A replay can never end the window, so the new code has no early release to
// be silent about, and its advice ("run `hyp sync` again") names a command the
// caller did not run. This invocation kept exiting 0 before the code existed
// and has to keep doing so.
test('a held machine with no destinations still exits 0 under --history', async () => {
  const hypHome = await makeHome('held-no-sinks-history')
  await writeFirstSyncHoldMarker({ stateDir: stateDir(hypHome) })
  const { ctx, stdout, stderr } = makeCtx({ hypHome, sinks: [], tty: true })

  const code = await runSync(['--history', 'claude'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /no sinks instantiated; nothing to do/)
  assert.doesNotMatch(stderr.text, /review window/)
  assert.ok(await holdExists(hypHome))
})

test('no sinks at all is a no-op, not an error', async () => {
  const hypHome = await makeHome('no-sinks')
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [] })

  const code = await runSync([], ctx)

  assert.equal(code, 0)
  assert.match(stdout.text, /no sinks instantiated; nothing to do/)
})

test('a failed export reports a nonzero exit', async () => {
  const hypHome = await makeHome('failed')
  const sink = fakeSink('parquet', { dir: '/home/u/exports' }, { status: 'failed' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink] })

  const code = await runSync(['--yes'], ctx)

  assert.equal(code, 1)
  assert.match(stdout.text, /parquet: failed/)
})
