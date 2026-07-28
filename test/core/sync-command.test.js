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
import { writeLocalOnlyEntries } from '../../src/core/usage-policy/index.js'

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

/**
 * @param {{ hypHome: string, sinks: any[], tty?: boolean, answer?: string }} args
 */
function makeCtx({ hypHome, sinks, tty = false, answer }) {
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
    config: { version: 2 },
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
  assert.match(text, /hyp policy set <path> local-only/)
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
  })

  await runSync(['--dry-run'], ctx)

  const text = stdout.text
  assert.match(text, /central\s+https:\/\/hypaware\.example\.com\s+\(leaves this machine\)/)
  assert.match(text, /parquet\s+\/home\/u\/exports\s+\(stays on this machine\)/)
  // An undeclarable destination says nothing rather than guessing either way.
  assert.match(text, /mystery\s+@hypaware\/fake\n/)
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

test('an instance argument ticks only that sink', async () => {
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
