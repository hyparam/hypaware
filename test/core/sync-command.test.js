// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { runSync } from '../../src/core/commands/sync.js'
import {
  firstSyncHoldMarkerPath,
  writeFirstSyncHoldMarker,
} from '../../src/core/usage-policy/first_sync_hold.js'
import { writeClientSyncEntries, writeLocalOnlyEntries } from '../../src/core/usage-policy/index.js'

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

function captureStream() {
  let buf = ''
  return {
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
      async exportBatch(/** @type {unknown} */ batch) {
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
 * @param {{ hypHome: string, sinks: any[], tty?: boolean, answer?: string, remotes?: Record<string, { url: string }> }} args
 */
function makeCtx({ hypHome, sinks, tty = false, answer, remotes }) {
  const stdout = captureStream()
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
  assert.match(text, /FIRST SYNC - nothing has left this machine yet/)
  assert.match(text, /Your review window runs until /)
  assert.match(text, /cannot be un-sent/)
  assert.match(text, /hyp privacy set <path> local-only/)
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

test('the plan names each destination and whether it leaves the machine', async () => {
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
  assert.match(text, /central\s+the 'prod' server\s+\(leaves this machine\)/)
  assert.doesNotMatch(text, /https:\/\//)
  assert.match(text, /\(run 'hyp remote list' to see server URLs\)/)
  assert.match(text, /parquet\s+\/home\/u\/exports\s+\(stays on this machine\)/)
  // An undeclarable destination says nothing rather than guessing either way.
  assert.match(text, /mystery\s+@hypaware\/fake\n/)
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

  assert.match(stdout.text, /central\s+elsewhere\.example\.com\s+\(leaves this machine\)/)
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

  assert.match(stdout.text, /withholding 2 directories marked local-only, 1 directory marked ignore/)
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

  assert.match(stdout.text, /keeping these clients local-only: hermes · openclaw/)
  assert.doesNotMatch(stdout.text, /no directories or clients are marked/)
})

test('with nothing marked, the plan says so in one line covering both stores', async () => {
  const hypHome = await makeHome('no-exclusions')
  const { ctx, stdout } = makeCtx({
    hypHome,
    sinks: [fakeSink('central', { url: 'https://hypaware.example.com' })],
    tty: true,
  })

  await runSync(['--dry-run'], ctx)

  assert.match(stdout.text, /no directories or clients are marked local-only or ignore/)
})

test('with no hold, --yes exports without inventing a review window', async () => {
  const hypHome = await makeHome('unheld')
  const sink = fakeSink('parquet', { dir: '/home/u/exports' })
  const { ctx, stdout } = makeCtx({ hypHome, sinks: [sink] })

  const code = await runSync(['--yes'], ctx)

  assert.equal(code, 0)
  assert.equal(sink.exported.length, 1)
  assert.doesNotMatch(stdout.text, /FIRST SYNC/)
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
