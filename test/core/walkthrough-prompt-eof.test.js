// @ts-check

// The wizard's three legacy readline prompts on a stdin that can no longer
// answer. `rl.question()` leaves its promise permanently unsettled at EOF,
// so a scripted run whose input runs out (or any run whose terminal drops)
// hung on the prompt forever instead of taking the default it had just
// printed. The run that reaches all three is a partially scripted wizard:
// answer the fork, let stdin dry up, and the express gate, the commit-point
// confirm and the backfill consent each read the spent stream. A fully
// unanswered `hyp init` never gets this far - `wizard/fork.js` still asks
// through `rl.question` on the wizard's first screen and hangs there.
// `hyp attach <client>`'s own backfill consent is the other caller, and it
// is reached only from a terminal (`maybeInteractiveEnableAttach` refuses a
// non-TTY stdin) with the TUI off, so what lands on it there is a dropped
// terminal rather than a pipe. Each case below is raced against a timer,
// because the pre-fix failure mode is a hang rather than a wrong value and
// an unraced assertion would never run at all.
//
// @ref LLP 0190#sync-gate [tests]: a spent stdin lands on the prompt's stated default rather than waiting on an answer that can never come

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import {
  defaultBackfillConsentPromptFactory,
  defaultConfirmSelectPromptFactory,
  defaultOverwriteConfirmFactory,
} from '../../src/core/cli/walkthrough.js'

/** Long enough to be unambiguous, short enough that a hang fails fast. */
const SETTLE_MS = 500

/** Sentinel the race resolves to when the prompt never answers. */
const HUNG = Symbol('hung')

/**
 * Resolve `promise` or fail the test with the hang it is guarding against.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {string} what
 * @returns {Promise<T>}
 */
async function settles(promise, what) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(HUNG), SETTLE_MS)
  })
  try {
    const result = await Promise.race([promise, timeout])
    assert.notEqual(result, HUNG, `${what} never settled within ${SETTLE_MS}ms - the prompt hung on EOF`)
    return /** @type {T} */ (result)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    write(/** @type {string} */ chunk) {
      chunks.push(chunk)
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

test('overwrite confirm takes its printed default on a stdin that ends without a line', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const confirm = defaultOverwriteConfirmFactory({ stdin: /** @type {any} */ (stdin), stdout })
  const answer = confirm('/tmp/hypaware.toml')
  stdin.end()

  assert.equal(await settles(answer, 'overwrite confirm at EOF'), true)
  // The question is still printed, byte for byte: the default is taken
  // because it was advertised, not instead of advertising it. That default
  // is a yes, so a spent stdin completes the run (over a backup) rather
  // than discarding the answers the walk just collected.
  assert.match(stdout.text(), /Continue\? \[Y\/n\]: $/)
})

test('overwrite confirm takes its printed default on a stdin that was already spent', async () => {
  // Readline registers its `end` listener at construction, so an interface
  // built over an already-ended stream never emits `close`. This is the case
  // a `close`-only guard still hangs on.
  const stdin = new PassThrough()
  stdin.resume()
  stdin.end()
  await new Promise((resolve) => setImmediate(resolve))

  const confirm = defaultOverwriteConfirmFactory({ stdin: /** @type {any} */ (stdin), stdout: makeBuf() })
  assert.equal(await settles(confirm('/tmp/hypaware.toml'), 'overwrite confirm on a spent stdin'), true)
})

// An explicit `n` rather than an explicit `y`: the default is a yes, so only
// the decline distinguishes an answered prompt from a defaulted one.
test('overwrite confirm still honours an explicit no', async () => {
  const stdin = new PassThrough()
  const confirm = defaultOverwriteConfirmFactory({ stdin: /** @type {any} */ (stdin), stdout: makeBuf() })
  const answer = confirm('/tmp/hypaware.toml')
  stdin.write('n\n')

  assert.equal(await settles(answer, 'overwrite confirm with an answer'), false)
})

test('defaults gate takes its stated default on a stdin that ends without a line', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout,
    env: { HYP_NO_TUI: '1' },
  })
  const answer = ask(/** @type {any} */ ({
    title: 'Record these sources?',
    options: [
      { value: 'accept', label: 'Yes, record these' },
      { value: 'choose', label: 'Let me choose' },
    ],
    default: 'choose',
  }))
  stdin.end()

  assert.equal(await settles(answer, 'defaults gate at EOF'), 'choose')
  assert.match(stdout.text(), /select \[2\]: $/)
})

test('defaults gate still honours an explicit pick', async () => {
  const stdin = new PassThrough()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout: makeBuf(),
    env: { HYP_NO_TUI: '1' },
  })
  const answer = ask(/** @type {any} */ ({
    title: 'Record these sources?',
    options: [
      { value: 'accept', label: 'Yes, record these' },
      { value: 'choose', label: 'Let me choose' },
    ],
    default: 'choose',
  }))
  stdin.write('1\n')

  assert.equal(await settles(answer, 'defaults gate with an answer'), 'accept')
})

// The disconnect gate is the one select whose stated default acts: it runs
// `hyp leave`, tearing down the org connection. Landing a spent stdin on
// that default would let a piped `hyp setup` disconnect a managed machine
// with nobody at the terminal, so the question names an `eofValue` and EOF
// takes that instead. The prompt still prints `select [1]` - the default is
// what the person is offered, `eofValue` is what happens when there is no
// person.
//
// @ref LLP 0299#eof-declines [tests]: a stdin that cannot answer declines the gates that would act
test('a gate naming an eofValue takes it, not the acting default, when stdin ends', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout,
    env: { HYP_NO_TUI: '1' },
  })
  const answer = ask(/** @type {any} */ ({
    title: 'This machine syncs to your team server. Disconnect and go local-only?',
    options: [
      { value: 'disconnect', label: 'Yes, disconnect' },
      { value: 'stay', label: 'No, stay connected' },
    ],
    default: 'disconnect',
    eofValue: 'stay',
  }))
  stdin.end()

  assert.equal(await settles(answer, 'disconnect gate at EOF'), 'stay')
  assert.match(stdout.text(), /select \[1\]: $/, 'the acting default is still the one offered')
})

test('a gate naming an eofValue still honours an explicit pick', async () => {
  const stdin = new PassThrough()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout: makeBuf(),
    env: { HYP_NO_TUI: '1' },
  })
  const answer = ask(/** @type {any} */ ({
    title: 'This machine syncs to your team server. Disconnect and go local-only?',
    options: [
      { value: 'disconnect', label: 'Yes, disconnect' },
      { value: 'stay', label: 'No, stay connected' },
    ],
    default: 'disconnect',
    eofValue: 'stay',
  }))
  stdin.write('1\n')

  assert.equal(await settles(answer, 'disconnect gate with an answer'), 'disconnect')
})

test('backfill consent takes its printed default on a stdin that ends without a line', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const ask = defaultBackfillConsentPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout,
    env: { HYP_NO_TUI: '1' },
  })
  const answer = ask({ providers: ['claude'], retentionDays: 30 })
  stdin.end()

  assert.equal(await settles(answer, 'backfill consent at EOF'), true)
  assert.match(stdout.text(), /\[Y\/n\]: $/)
})

test('backfill consent still honours an explicit no', async () => {
  const stdin = new PassThrough()
  const ask = defaultBackfillConsentPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout: makeBuf(),
    env: { HYP_NO_TUI: '1' },
  })
  const answer = ask({ providers: ['claude'], retentionDays: 30 })
  stdin.write('n\n')

  assert.equal(await settles(answer, 'backfill consent with an answer'), false)
})
