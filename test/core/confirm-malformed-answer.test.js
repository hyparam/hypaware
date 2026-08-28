// @ts-check

// An answer that is neither the default's bare enter nor a word the prompt
// understands. While every confirm here was `[y/N]`, rounding one to the
// default was harmless: the default declined, so a mistyped "nope" and a
// clean "no" reached the same place. LLP 0299 flipped the polarity, and the
// same rounding now reads a typo as consent - "nope" at `hyp sync`'s send
// confirm clears the first-sync hold, and a non-numeric answer at the
// enrolled fork's disconnect gate runs `hyp leave`. So the default belongs
// to the bare enter that was advertised and to nothing else.
//
// The two prompt families land there differently, because their askers
// differ. `askYesNo` asks once (`askLineOnce` keeps `rl.question` for its
// cursor bookkeeping, and a re-ask would wait on a line already gone by),
// so an unreadable answer declines outright. The wizard's numbered fallback
// reads through `queuedLineAsker`, which holds those lines, so it re-asks
// once and only then falls back - to `eofValue` where the question named
// one, since a spent budget and a spent stdin are the same "nobody chose".
//
// Each case is raced against a timer, as the EOF tests beside it are: a
// prompt that waits on an answer that will never come is the failure mode
// here, and an unraced assertion would hang the suite rather than fail it.
//
// @ref LLP 0299#decision [tests]: only the bare enter takes the default, so an unreadable answer never acts

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { askYesNo } from '../../src/core/cli/confirm.js'
import { defaultConfirmSelectPromptFactory } from '../../src/core/cli/walkthrough.js'

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
    assert.notEqual(result, HUNG, `${what} never settled within ${SETTLE_MS}ms`)
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

/** The enrolled fork's disconnect gate, whose default runs `hyp leave`. */
function disconnectGate() {
  return /** @type {any} */ ({
    title: 'This machine syncs to your team server. Disconnect and go local-only?',
    options: [
      { value: 'disconnect', label: 'Yes, disconnect' },
      { value: 'stay', label: 'No, stay connected' },
    ],
    default: 'disconnect',
    eofValue: 'stay',
  })
}

test('a yes-default confirm declines a word it cannot read rather than taking the yes', async () => {
  const stdin = new PassThrough()
  const stderr = makeBuf()
  const answered = askYesNo(/** @type {any} */ ({ stdin, stderr }), 'Send now? [Y/n] ', { defaultYes: true })
  stdin.write('nope\n')

  assert.equal(await settles(answered, 'askYesNo on a mistyped no'), false)
  // The decline is spoken, not silent: the user typed something, and a verb
  // that just stopped without a word for why reads as a bug.
  assert.match(stderr.text(), /didn't catch 'nope'/)
})

test('a stray keystroke before enter does not send', async () => {
  const stdin = new PassThrough()
  const answered = askYesNo(/** @type {any} */ ({ stdin, stderr: makeBuf() }), 'Send now? [Y/n] ', {
    defaultYes: true,
  })
  stdin.write('q\n')

  assert.equal(await settles(answered, 'askYesNo on a stray keystroke'), false)
})

test('a bare enter still takes the yes a [Y/n] printed', async () => {
  const stdin = new PassThrough()
  const answered = askYesNo(/** @type {any} */ ({ stdin, stderr: makeBuf() }), 'Send now? [Y/n] ', {
    defaultYes: true,
  })
  stdin.write('\n')

  assert.equal(await settles(answered, 'askYesNo on a bare enter'), true)
})

test('a no-default confirm is unchanged: an unreadable answer still declines', async () => {
  const stdin = new PassThrough()
  const answered = askYesNo(/** @type {any} */ ({ stdin, stderr: makeBuf() }), 'Delete everything? [y/N] ')
  stdin.write('sure\n')

  assert.equal(await settles(answered, 'askYesNo on a [y/N] typo'), false)
})

test('the disconnect gate re-asks a yes/no word rather than reading it as the disconnect', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout,
    env: { HYP_NO_TUI: '1' },
  })
  const answer = ask(disconnectGate())
  // The phrasing invites a yes/no word, and the fallback reads row numbers.
  stdin.write('n\n')
  stdin.write('2\n')

  assert.equal(await settles(answer, 'disconnect gate on a typed n'), 'stay')
  assert.match(stdout.text(), /nothing matched 'n'/)
})

test('the disconnect gate declines an answer still unreadable after the re-ask', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout,
    env: { HYP_NO_TUI: '1' },
  })
  const answer = ask(disconnectGate())
  stdin.write('no\n')
  stdin.write('stay\n')

  // The same landing EOF gets, and for the same reason: nobody chose a row.
  assert.equal(await settles(answer, 'disconnect gate on two unreadable answers'), 'stay')
})

test('a gate with no eofValue falls back to its printed default, not to a re-ask loop', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout,
    env: { HYP_NO_TUI: '1' },
  })
  const answer = ask(/** @type {any} */ ({
    title: 'Use these defaults?',
    options: [
      { value: 'accept', label: 'Accept the defaults' },
      { value: 'customize', label: 'Show me the menu' },
    ],
    default: 'accept',
  }))
  stdin.write('yes\n')
  stdin.write('yep\n')

  assert.equal(await settles(answer, 'defaults gate on two unreadable answers'), 'accept')
})

test('a bare enter still takes the gate default as a real choice', async () => {
  const stdin = new PassThrough()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (stdin),
    stdout: makeBuf(),
    env: { HYP_NO_TUI: '1' },
  })
  // Enter is what the prompt advertises, so it takes the acting default even
  // where an unreadable answer would land on `eofValue` instead.
  const answer = ask(disconnectGate())
  stdin.write('\n')

  assert.equal(await settles(answer, 'disconnect gate on a bare enter'), 'disconnect')
})
