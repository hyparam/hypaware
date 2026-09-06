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
 *   deadline?: number | null,
 *   interactive?: boolean,
 *   spawnFn?: any,
 *   readDeadline?: () => Promise<number | null>,
 * }} [over]
 */
function opts(over = {}) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  return {
    stdout,
    stderr,
    args: {
      deadline: over.deadline === undefined ? DEADLINE : over.deadline,
      stdout,
      stderr,
      env: /** @type {NodeJS.ProcessEnv} */ ({}),
      interactive: over.interactive ?? true,
      // Default: a spawn that must not happen. Tests that expect one pass it.
      // (An injected spawnFn is also what lets the step run without a tty.)
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
 * `holdOpen` is the pipe that outlives its writer: the child exits, and fd 2
 * stays open behind it the way a surviving descendant would hold it.
 *
 * @param {{ code?: number | null, error?: Error, stderr?: string | string[], stderrError?: Error, holdOpen?: boolean }} [behaviour]
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
      const code = behaviour.code ?? 0
      // Ordered as the real child orders it: 'exit' first, then whatever the
      // pipe still has to hand over, then 'close'. The notice arrives on the
      // far side of the exit, so a settle that did not wait would lose it.
      handlers.exit?.(code)
      const chunks = behaviour.stderr === undefined
        ? []
        : (Array.isArray(behaviour.stderr) ? behaviour.stderr : [behaviour.stderr])
      for (const chunk of chunks) stderr.emit('data', chunk)
      if (behaviour.stderrError) stderr.emit('error', behaviour.stderrError)
      if (behaviour.holdOpen) return
      handlers.close?.(code)
    })
    return { stderr, on: (/** @type {string} */ event, /** @type {any} */ fn) => { handlers[event] = fn } }
  }
  return { spawnFn, calls }
}

test('no hold means no question: an unenrolled install is never asked to sync', async () => {
  const o = opts({ deadline: null })
  const result = await runWizardSyncNow(o.args)
  assert.deepEqual(result, { asked: false, reason: 'no-hold' })
  assert.equal(o.stdout.text(), '')
})

test('a non-interactive run is never asked, and never sends', async () => {
  const o = opts({ interactive: false })
  const result = await runWizardSyncNow(o.args)
  assert.deepEqual(result, { asked: false, reason: 'not-interactive' })
  // The narration upstream goes quiet whenever this step is expected to
  // run, so the skip has to state the deadline, the way out, and the review
  // hint itself or the run ends without ever naming them.
  // @ref LLP 0188#never-silent [tests]: the un-askable path still names the release verb
  assert.match(o.stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
  assert.match(o.stdout.text(), /includes your imported history/)
  assert.match(o.stdout.text(), /`hyp status` shows the countdown/)
  assert.match(o.stdout.text(), /To send it sooner, run `hyp sync`/)
  assert.match(o.stdout.text(), /hypaware-privacy/)
})

// `spawnFn` is what lets every other test here run headless, and it is also
// what bypasses the terminal gate, so the gate is only reachable with no seam
// injected at all. Both halves of it matter: the child prompts on the
// inherited terminal, so both ends have to be one. `hyp init` gates the
// wizard on stdout alone, so the stdin half is a real attended run
// (`hyp init < file`), not a hypothetical.
// @ref LLP 0203#offer [tests]: attended-only means a terminal on both ends, and the un-askable attended run gets the full statement
for (const surfaces of [
  { name: 'a stdin that is not a terminal', stdin: false, stdout: true },
  { name: 'a stdout that is not a terminal', stdin: true, stdout: false },
]) {
  test(`${surfaces.name} is never asked, and states the whole hold instead`, async () => {
    const stdout = makeBuf()
    const result = await runWizardSyncNow({
      deadline: DEADLINE,
      stdout,
      stderr: makeBuf(),
      env: /** @type {NodeJS.ProcessEnv} */ ({}),
      interactive: true,
      stdin: /** @type {any} */ ({ isTTY: surfaces.stdin }),
      stdoutStream: /** @type {any} */ ({ isTTY: surfaces.stdout, write: () => true }),
      readDeadline: async () => DEADLINE,
    })
    assert.deepEqual(result, { asked: false, reason: 'not-interactive' })
    // Everything the privacy narration would have said, because it stood
    // down for a question this run cannot be asked.
    assert.match(stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
    assert.match(stdout.text(), /includes your imported history/)
    assert.match(stdout.text(), /`hyp status` shows the countdown/)
    assert.match(stdout.text(), /To send it sooner, run `hyp sync`/)
    assert.match(stdout.text(), /hypaware-privacy/)
  })
}

// The narration stood down for this step, so a step that throws and says
// nothing is the one remaining way an enrolled run ends with the deadline
// nowhere on screen.
// @ref LLP 0188#never-silent [tests]: even the unforeseen exit states the hold
test('an unforeseen throw states the hold rather than ending on nothing', async () => {
  const stdout = makeBuf()
  let firstWrite = true
  const result = await runWizardSyncNow({
    deadline: DEADLINE,
    stdout: {
      write(/** @type {string} */ chunk) {
        if (firstWrite) {
          firstWrite = false
          throw new Error('EPIPE')
        }
        return stdout.write(chunk)
      },
    },
    stderr: makeBuf(),
    env: /** @type {NodeJS.ProcessEnv} */ ({}),
    interactive: true,
    spawnFn: /** @type {any} */ (() => {
      throw new Error('spawn must not be reached')
    }),
    readDeadline: async () => DEADLINE,
  })
  assert.deepEqual(result, { asked: false, reason: 'error' })
  assert.match(stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
})

// @ref LLP 0203#child-process [tests]: the release is a real `hyp sync` in a fresh process, not an in-wizard reimplementation
test('the step spawns `hyp sync` on the inherited terminal, as the one question, and reports the release', async () => {
  const spawn = fakeSpawn({ code: 0 })
  const o = opts({
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
  // The wizard put no question of its own: one lead line, then the child.
  // @ref LLP 0203#no-new-consent [tests]: the informed prompt is the only prompt
  assert.match(o.stdout.text(), /`hyp sync` shows what would leave and asks before sending/)
  assert.doesNotMatch(o.stdout.text(), /Send now/)
  // Nothing claims the wait still stands; the child printed the sink report.
  assert.doesNotMatch(o.stdout.text(), /Nothing was sent/)
})

// @ref LLP 0203#read-back [tests]: `hyp sync` exits 0 on a declined plan too, so the marker decides
test('a child that exits 0 without releasing is reported as not sent', async () => {
  const spawn = fakeSpawn({ code: 0 })
  const o = opts({
    spawnFn: spawn.spawnFn,
    readDeadline: async () => DEADLINE,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'sync-declined' })
  assert.match(o.stdout.text(), /Nothing was sent/)
  assert.match(o.stdout.text(), /run `hyp sync` any time/)
})

// A decline exits 0, so a non-zero exit is a child that never reached its
// plan (an empty sink set, a boot that failed, a signal). Reading that as a
// decline would leave the run with none of what the narration stood down for
// and would count a crash as a user choosing the window.
// @ref LLP 0188#never-silent [tests]: a child that never showed its plan states the hold
test('a child that exits non-zero states the whole hold and is not counted as a decline', async () => {
  const spawn = fakeSpawn({ code: 1 })
  const o = opts({
    spawnFn: spawn.spawnFn,
    readDeadline: async () => DEADLINE,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'child-failed' })
  assert.match(o.stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
  assert.match(o.stdout.text(), /hypaware-privacy/)
  assert.doesNotMatch(o.stdout.text(), /Nothing was sent/)
})

// The read-back still decides first: a child that released and then failed
// must never be told its history is still here.
// @ref LLP 0203#read-back [tests]: a non-zero exit never overrides a marker that is gone
test('a child that released and then exited non-zero is still a release', async () => {
  const spawn = fakeSpawn({ code: 1 })
  const o = opts({
    spawnFn: spawn.spawnFn,
    readDeadline: async () => null,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: true })
  assert.doesNotMatch(o.stdout.text(), /Nothing has been uploaded yet/)
})

// The one non-zero exit that is not a run that broke, and so not the generic
// held statement above: a `hyp sync` that found no destination sent nothing
// because there was nowhere to send, and the statement that names the
// deadline as if a destination existed would point the user back at the
// command that just found nothing to send.
// @ref LLP 0203#read-back [tests]: the exit code separates the two ways a held marker outlives the child
test('a child that found no destinations gets its own line, not the held statement', async () => {
  const spawn = fakeSpawn({
    code: SYNC_HELD_NO_DESTINATIONS_EXIT,
    stderr: NO_DESTINATIONS_STDERR,
  })
  const o = opts({
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
// to the outcome every other non-zero exit gets rather than explaining a
// machine state nobody observed.
// @ref LLP 0203#read-back [tests]: the exit code is read alongside the sentence the child prints with it
test('an exit 3 the child never explained is a plain child-failed, not no-destinations', async () => {
  const spawn = fakeSpawn({ code: SYNC_HELD_NO_DESTINATIONS_EXIT })
  const o = opts({
    spawnFn: spawn.spawnFn,
    readDeadline: async () => DEADLINE,
  })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'child-failed' })
  assert.match(o.stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
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

// A child that never started never printed its plan, so this run saw nothing
// the narration would have said - the same hole as the run that could not be
// asked, and it takes the same whole statement rather than the short one.
// @ref LLP 0188#never-silent [tests]: a failed spawn states the hold, not only the wait
test('a spawn failure never fails the install, and states the whole hold', async () => {
  const spawn = fakeSpawn({ error: new Error('ENOENT') })
  const o = opts({ spawnFn: spawn.spawnFn })
  const result = await runWizardSyncNow(o.args)

  assert.deepEqual(result, { asked: true, released: false, reason: 'spawn-failed' })
  assert.match(o.stderr.text(), /Could not start hyp sync: ENOENT/)
  assert.match(o.stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
  assert.match(o.stdout.text(), /includes your imported history/)
  assert.match(o.stdout.text(), /To send it sooner, run `hyp sync`/)
  assert.match(o.stdout.text(), /hypaware-privacy/)
})

// Everything above replaces the re-read with the `readDeadline` seam, which
// means the step's own production body - resolve the state dir from the
// environment, then read the marker there - has never been run by a test. That
// is the body the release claim is decided in, and it is the one place where a
// wrong answer ("your history is on its way") cannot be walked back. A path
// helper that drifted, or a state dir resolved from the wrong variable, would
// find no marker, and every run would report a release that never happened -
// invisible to the tests above, because none of them execute the code.
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

    const o = opts({ deadline })
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

// The pipe outlives the process that wrote to it: `close` fires only once the
// piped stderr has closed, and any descendant that inherited the child's fd 2
// holds it open for as long as it lives, so waiting on `close` alone leaves
// setup's last step waiting on a stranger. Without the bound this test does
// not fail, it hangs, so it carries its own deadline.
// @ref LLP 0203#read-back [tests]: the exit code is still judged when the pipe never closes
test('a child whose stderr never closes still resolves, and still reports its exit code', { timeout: 5000 }, async () => {
  const { spawnFn } = fakeSpawn({ code: 1, holdOpen: true })
  const o = opts({ spawnFn })
  const result = await runWizardSyncNow(o.args)

  // Judged exactly as it would be had the pipe closed on time: a non-zero
  // exit is a child that never reached its plan.
  assert.deepEqual(result, { asked: true, released: false, reason: 'child-failed' })
  assert.match(o.stdout.text(), /Nothing has been uploaded yet: nothing leaves this machine before/)
})
