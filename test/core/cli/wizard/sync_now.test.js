// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { paintLine } from '../../../../src/core/cli/style.js'
import { runWizardSyncNow } from '../../../../src/core/cli/wizard/sync_now.js'
import {
  SYNC_HELD_NO_DESTINATIONS_EXIT,
  SYNC_HELD_NO_DESTINATIONS_NOTICE,
  firstSyncHoldMarkerPath,
  writeFirstSyncHoldMarker,
} from '../../../../src/core/usage-policy/first_sync_hold.js'

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

/** What the real child writes on the no-destinations path, notice first. */
const NO_DESTINATIONS_STDERR =
  `${SYNC_HELD_NO_DESTINATIONS_NOTICE}\n  The first-sync review window stays open...\n`

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
  /** @type {{ title: string, options: { value: string, label: string }[], default?: string, eofValue?: string }[]} */
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
 * A spawn stub that records its argv, writes `stderr` on the one piped stream
 * the real child has, and closes with `code`. Only stderr is faked: stdin and
 * stdout stay inherited, so the child owns the terminal it prompts on.
 *
 * `stderr` may be a list, which is how the real stream arrives: the notice is
 * one write in `runSync` but the reader sees whatever chunks the pipe hands
 * it, and a boundary inside the sentence must not hide it.
 *
 * The stderr stub is a real `EventEmitter`, not a handler bag: an `error`
 * with nobody listening has to throw here the way it throws on the real pipe,
 * or a test cannot tell the difference.
 *
 * @param {{ code?: number | null, error?: Error, stderr?: string | string[], stderrError?: Error }} [behaviour]
 */
function fakeSpawn(behaviour = {}) {
  /** @type {{ command: string, args: string[], options: any }[]} */
  const calls = []
  /** @type {any} */
  const spawnFn = (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    calls.push({ command, args, options })
    /** @type {Record<string, (arg: any) => void>} */
    const handlers = {}
    const stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    queueMicrotask(() => {
      if (behaviour.error) {
        handlers.error?.(behaviour.error)
        return
      }
      const chunks = behaviour.stderr === undefined
        ? []
        : (Array.isArray(behaviour.stderr) ? behaviour.stderr : [behaviour.stderr])
      for (const chunk of chunks) stderr.emit('data', chunk)
      if (behaviour.stderrError) stderr.emit('error', behaviour.stderrError)
      handlers.close?.(behaviour.code ?? 0)
    })
    return { stderr, on: (/** @type {string} */ event, /** @type {any} */ fn) => { handlers[event] = fn } }
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

test('the question offers send-now first, as the default, and declining spawns nothing', async () => {
  const o = opts({ answer: 'wait' })
  const result = await runWizardSyncNow(o.args)

  assert.equal(o.asked.length, 1)
  const question = o.asked[0]
  assert.equal(question.options[0].value, 'now')
  assert.equal(question.default, 'now')
  assert.equal(question.options[1].value, 'wait')
  assert.match(question.options[1].label, /^Wait until /)
  assert.deepEqual(result, { asked: true, released: false, reason: 'declined' })
  // The narration upstream dropped its `hyp sync` sentence for this offer,
  // and the offer's own frame is cleared when it resolves, so the wait has
  // to leave the way out on screen or nothing names it.
  // @ref LLP 0188#never-silent [tests]: the modal wait still names the release verb
  assert.match(o.stdout.text(), /Nothing was sent/)
  assert.match(o.stdout.text(), /run `hyp sync` any time/)
})

// The default here acts: `now` spawns `hyp sync` on this terminal. The child's
// own confirm is not the backstop it looks like, because it inherits the
// terminal rather than the stream - on a real tty a ctrl+D is a keypress, not
// a spent stream, so the child asks again instead of declining, and a terminal
// that gave up ends on a sync it started. So the question names waiting as the
// answer for "there is nobody left to press enter".
//
// @ref LLP 0299#eof-declines [tests]: a select whose stated default acts names an eofValue that does not
test('the send-now offer names waiting as its eofValue, so a spent stdin never starts the sync', async () => {
  const spawn = fakeSpawn({ code: 0 })
  const o = opts({ answer: 'wait', spawnFn: spawn.spawnFn })
  await runWizardSyncNow(o.args)

  assert.equal(o.asked.length, 1)
  assert.equal(o.asked[0].eofValue, 'wait')
  assert.notEqual(o.asked[0].eofValue, o.asked[0].default, 'the acting default must not also be the EOF answer')
  assert.equal(spawn.calls.length, 0)
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
  // stdin and stdout stay on the terminal the child prompts on; only its
  // diagnostics are piped, so setup can read what the child said about them.
  assert.deepEqual(call.options.stdio, ['inherit', 'inherit', 'pipe'])
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

// The other way the marker survives the child, and not the same outcome: a
// `hyp sync` that found no destination never rendered a plan, so nobody read
// one and nobody declined it. Counting it as `sync-declined` puts a machine
// that cannot send anything into the rate LLP 0203 #consequences reads as
// "the window is sized wrong", and the plain restatement then points the user
// back at the command that just found nothing to send.
// @ref LLP 0203#read-back [tests]: the exit code separates the two ways a held marker outlives the child
test('a child that found no destinations is not counted as a declined plan', async () => {
  const spawn = fakeSpawn({
    code: SYNC_HELD_NO_DESTINATIONS_EXIT,
    stderr: NO_DESTINATIONS_STDERR,
  })
  const o = opts({
    answer: 'now',
    spawnFn: spawn.spawnFn,
    readDeadline: async () => DEADLINE,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'no-destinations' })
  assert.match(o.stdout.text(), /Nothing was sent/)
  assert.match(o.stdout.text(), /no destinations are configured/)
  assert.doesNotMatch(o.stdout.text(), /run `hyp sync` any time/)
})

// The marker re-read fails open (LLP 0101: a corrupt or lapsed marker reads as
// absent), so an absent marker on its own is not proof of a release. This exit
// code is proof of the opposite: it comes back before the child touched an
// export, so it outranks whatever the re-read says.
// @ref LLP 0203#read-back [tests]: a run that provably sent nothing is never reported as released
test('a no-destinations child is not a release even when the marker reads absent', async () => {
  const spawn = fakeSpawn({
    code: SYNC_HELD_NO_DESTINATIONS_EXIT,
    stderr: NO_DESTINATIONS_STDERR,
  })
  const o = opts({
    answer: 'now',
    spawnFn: spawn.spawnFn,
    readDeadline: async () => null,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'no-destinations' })
  assert.match(o.stdout.text(), /no destinations are configured/)
})

// Exit 3 is not proof on its own. It is a small integer any process can
// return: Node itself exits 3 on an internal parse error, before a line of
// `hyp sync` has run, and nothing stops a later `runSync` path from picking
// the same code for something else. A child that never reached the
// no-destinations branch never printed its notice either, so setup falls back
// to the marker rather than explaining a machine state nobody observed.
// @ref LLP 0203#read-back [tests]: the exit code is read alongside the sentence the child prints with it
test('an exit 3 the child never explained falls back to the marker, not to no-destinations', async () => {
  const spawn = fakeSpawn({ code: SYNC_HELD_NO_DESTINATIONS_EXIT })
  const o = opts({
    answer: 'now',
    spawnFn: spawn.spawnFn,
    readDeadline: async () => DEADLINE,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'sync-declined' })
  assert.match(o.stdout.text(), /Nothing was sent/)
  assert.doesNotMatch(o.stdout.text(), /no destinations are configured/)
})

// Reading the child's stderr must not consume it. Piping it is a means to the
// corroboration above, not a decision to swallow the child's diagnostics: the
// terminal still owes the user everything `hyp sync` said, in the order it
// said it.
// @ref LLP 0203#child-process [tests]: the piped stderr is echoed, not withheld
test('the child keeps its voice: everything on its stderr is written back out', async () => {
  const spawn = fakeSpawn({ code: 1, stderr: ['hyp sync: something broke\n', '  and then more\n'] })
  const o = opts({
    answer: 'now',
    spawnFn: spawn.spawnFn,
    readDeadline: async () => DEADLINE,
  })
  await runWizardSyncNow(o.args)

  assert.equal(o.stderr.text(), 'hyp sync: something broke\n  and then more\n')
})

// Piping a stream means owning its failures. An `error` nobody listens for is
// an uncaught exception, and it would land on a setup that had already done
// every one of its acts - the same defect `installStreamErrorHandlers` exists
// for on the write side. The read is best-effort; the run is not.
// @ref LLP 0203#child-process [tests]: a failed read pipe does not take the wizard down with it
test('a stderr pipe that fails does not take the run down: the exit code is still judged', async () => {
  const spawn = fakeSpawn({ code: 0, stderrError: Object.assign(new Error('read failed'), { code: 'EIO' }) })
  const o = opts({
    answer: 'now',
    spawnFn: spawn.spawnFn,
    readDeadline: async () => null,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: true })
})

// The notice arrives as pipe chunks, not as the one write that produced it,
// and it arrives as the child *printed* it: `colorizeStderr` paints the
// `hyp sync:` prefix of this very line, which drops a reset inside the
// sentence. Neither may hide the corroboration, or exit 3 is back to being
// believed or disbelieved for reasons nobody can see.
// @ref LLP 0203#read-back [tests]: the notice is recognised as the child writes it, chunked and styled
test('a notice split across chunks and painted by severity colour is still read', async () => {
  const painted = paintLine(SYNC_HELD_NO_DESTINATIONS_NOTICE)
  const spawn = fakeSpawn({
    code: SYNC_HELD_NO_DESTINATIONS_EXIT,
    stderr: [painted.slice(0, 12), painted.slice(12), '\n  and a trailing line\n'],
  })
  const o = opts({
    answer: 'now',
    spawnFn: spawn.spawnFn,
    readDeadline: async () => DEADLINE,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'no-destinations' })
  assert.match(o.stdout.text(), /no destinations are configured/)
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
  // An esc is the same wait, and leaves the same erased frame behind it.
  assert.match(o.stdout.text(), /run `hyp sync` any time/)
})
