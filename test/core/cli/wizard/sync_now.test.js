// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runWizardSyncNow } from '../../../../src/core/cli/wizard/sync_now.js'
import { firstSyncHoldMarkerPath, writeFirstSyncHoldMarker } from '../../../../src/core/usage-policy/first_sync_hold.js'

// The closing "send now" offer (LLP 0203): setup asks whether to wait out the
// first-sync review window, and hands the user a real `hyp sync` rather than a
// sentence naming it. What it must never do is release anything itself, or
// claim a sync happened that did not.

function makeBuf() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/** A deadline far enough out that no clock skew makes it stale. */
const DEADLINE = Date.now() + 6 * 60 * 60_000

/**
 * @param {{
 *   answer?: string,
 *   deadline?: number | null,
 *   interactive?: boolean,
 *   spawnFn?: any,
 *   readDeadline?: () => Promise<number | null>,
 * }} [over]
 */
function opts(over = {}) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {{ title: string, options: { value: string, label: string }[], default?: string }[]} */
  const asked = []
  return {
    stdout,
    stderr,
    asked,
    args: {
      deadline: over.deadline === undefined ? DEADLINE : over.deadline,
      stdout,
      stderr,
      env: /** @type {NodeJS.ProcessEnv} */ ({}),
      interactive: over.interactive ?? true,
      confirm: async (/** @type {any} */ question) => {
        asked.push(question)
        return over.answer ?? 'wait'
      },
      // Default: a spawn that must not happen. Tests that expect one pass it.
      spawnFn: over.spawnFn ?? (() => {
        throw new Error('spawn must not be called')
      }),
      // Default: the hold is untouched, which is what "wait" means.
      readDeadline: over.readDeadline ?? (async () => DEADLINE),
    },
  }
}

/**
 * A spawn stub that records its argv and closes with `code`, recording nothing
 * else: `stdio: 'inherit'` means the child owns the terminal, so there are no
 * pipes to fake.
 *
 * @param {{ code?: number | null, error?: Error }} [behaviour]
 */
function fakeSpawn(behaviour = {}) {
  /** @type {{ command: string, args: string[], options: any }[]} */
  const calls = []
  /** @type {any} */
  const spawnFn = (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    calls.push({ command, args, options })
    /** @type {Record<string, (arg: any) => void>} */
    const handlers = {}
    queueMicrotask(() => {
      if (behaviour.error) handlers.error?.(behaviour.error)
      else handlers.close?.(behaviour.code ?? 0)
    })
    return { on: (/** @type {string} */ event, /** @type {any} */ fn) => { handlers[event] = fn } }
  }
  return { spawnFn, calls }
}

test('no hold means no question: an unenrolled install is never asked to sync', async () => {
  const o = opts({ deadline: null })
  const result = await runWizardSyncNow(o.args)
  assert.deepEqual(result, { asked: false, reason: 'no-hold' })
  assert.equal(o.asked.length, 0)
  assert.equal(o.stdout.text(), '')
})

test('a non-interactive run is never asked, and never sends', async () => {
  const o = opts({ interactive: false })
  const result = await runWizardSyncNow(o.args)
  assert.deepEqual(result, { asked: false, reason: 'not-interactive' })
  assert.equal(o.asked.length, 0)
  // The narration upstream drops its `hyp sync` sentence whenever this step
  // is expected to render, so the skip has to state the way out itself or
  // the run ends without ever naming it.
  // @ref LLP 0188#never-silent [tests]: the un-askable path still names the release verb
  assert.match(o.stdout.text(), /To send it sooner, run `hyp sync`/)
})

// @ref LLP 0203#offer [tests]: waiting leads and is the default, so a stray enter cannot release
test('the question offers wait first, as the default, and declining spawns nothing', async () => {
  const o = opts({ answer: 'wait' })
  const result = await runWizardSyncNow(o.args)

  assert.equal(o.asked.length, 1)
  const question = o.asked[0]
  assert.equal(question.options[0].value, 'wait')
  assert.equal(question.default, 'wait')
  assert.match(question.options[0].label, /^Wait until /)
  assert.equal(question.options[1].value, 'now')
  assert.deepEqual(result, { asked: true, released: false, reason: 'declined' })
})

// @ref LLP 0203#child-process [tests]: the release is a real `hyp sync` in a fresh process, not an in-wizard reimplementation
test('send now spawns `hyp sync` on the inherited terminal and reports the release', async () => {
  const spawn = fakeSpawn({ code: 0 })
  const o = opts({
    answer: 'now',
    spawnFn: spawn.spawnFn,
    // The child released: the marker is gone.
    readDeadline: async () => null,
  })
  const result = await runWizardSyncNow(o.args)

  assert.equal(spawn.calls.length, 1)
  const call = spawn.calls[0]
  assert.equal(call.command, process.execPath)
  assert.match(call.args[0], /bin\/hypaware\.js$/)
  assert.deepEqual(call.args.slice(1), ['sync'])
  assert.equal(call.options.stdio, 'inherit')
  assert.deepEqual(result, { asked: true, released: true })
  // Nothing claims the wait still stands; the child printed the sink report.
  assert.doesNotMatch(o.stdout.text(), /Nothing was sent/)
})

// @ref LLP 0203#read-back [tests]: `hyp sync` exits 0 on a declined plan too, so the marker decides
test('a child that exits 0 without releasing is reported as not sent', async () => {
  const spawn = fakeSpawn({ code: 0 })
  const o = opts({
    answer: 'now',
    spawnFn: spawn.spawnFn,
    readDeadline: async () => DEADLINE,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'sync-declined' })
  assert.match(o.stdout.text(), /Nothing was sent/)
  assert.match(o.stdout.text(), /run `hyp sync` any time/)
})

// @ref LLP 0203#read-back [tests]: an unreadable re-read is "still held", never a claimed release
test('a re-read that throws is reported as not sent, not as a release', async () => {
  const spawn = fakeSpawn({ code: 0 })
  const o = opts({
    answer: 'now',
    spawnFn: spawn.spawnFn,
    readDeadline: async () => {
      throw new Error('EACCES')
    },
  })
  const result = await runWizardSyncNow(o.args)

  // The child ran and may well have sent nothing; the one answer that cannot
  // be walked back is telling the user it sent. So: not released, and the
  // deadline is restated rather than the run ending on silence.
  assert.deepEqual(result, { asked: true, released: false, reason: 'sync-declined' })
  assert.match(o.stdout.text(), /Nothing was sent/)
})

test('a spawn failure never fails the install, and restates the wait', async () => {
  const spawn = fakeSpawn({ error: new Error('ENOENT') })
  const o = opts({ answer: 'now', spawnFn: spawn.spawnFn })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'spawn-failed' })
  assert.match(o.stderr.text(), /Could not start hyp sync: ENOENT/)
  assert.match(o.stdout.text(), /Nothing was sent/)
})

// Everything above replaces the re-read with the `readDeadline` seam, which
// means the step's own production body - resolve the state dir from the
// environment, then read the marker there - has never been run by a test. That
// is the body the release claim is decided in, and it is the one place where a
// wrong answer ("your history is on its way") cannot be walked back. A path
// helper that drifted, or a state dir resolved from the wrong variable, would
// find no marker, and every run would report a release that never happened -
// invisible to all eight tests above, because none of them execute the code.
//
// So these two drive it end to end against a real marker on disk, with no seam
// at all: the only thing standing in for `hyp sync` is a spawn stub that either
// clears the marker (a release) or leaves it (a declined plan).
//
// @ref LLP 0203#read-back [tests]: the marker on disk decides, so the read that consults it is exercised for real
for (const scenario of [
  { name: 'left in place', release: false, expected: { asked: true, released: false, reason: 'sync-declined' } },
  { name: 'cleared by the child', release: true, expected: { asked: true, released: true } },
]) {
  test(`the read-back resolves a real hold marker from the environment: ${scenario.name}`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-sync-now-'))
    const hypHome = path.join(home, '.hyp')
    const stateDir = path.join(hypHome, 'hypaware')
    await fs.mkdir(stateDir, { recursive: true })
    const deadline = await writeFirstSyncHoldMarker({ stateDir })
    assert.equal(typeof deadline, 'number')

    const o = opts({ answer: 'now', deadline })
    // The real environment resolution, and no `readDeadline` override.
    o.args.env = /** @type {NodeJS.ProcessEnv} */ ({ HYP_HOME: hypHome })
    delete (/** @type {{ readDeadline?: unknown }} */ (o.args)).readDeadline
    o.args.spawnFn = /** @type {any} */ ((/** @type {string} */ _cmd, /** @type {string[]} */ _args) => {
      /** @type {Record<string, (arg: any) => void>} */
      const handlers = {}
      queueMicrotask(async () => {
        if (scenario.release) await fs.rm(firstSyncHoldMarkerPath(stateDir), { force: true })
        handlers.close?.(0)
      })
      return { on: (/** @type {string} */ event, /** @type {any} */ fn) => { handlers[event] = fn } }
    })

    const result = await runWizardSyncNow(o.args)
    assert.deepEqual(result, scenario.expected)
    // A run that did not send always restates the wait; a run that did must
    // never print it, or the release reads as though it were withheld.
    if (scenario.release) assert.doesNotMatch(o.stdout.text(), /Nothing was sent/)
    else assert.match(o.stdout.text(), /Nothing was sent/)
  })
}

test('a cancelled prompt is a wait, not an error', async () => {
  const o = opts()
  o.args.confirm = async () => {
    const err = new Error('cancelled')
    err.name = 'PromptCancelledError'
    throw err
  }
  const result = await runWizardSyncNow(o.args)
  assert.deepEqual(result, { asked: true, released: false, reason: 'declined' })
})
