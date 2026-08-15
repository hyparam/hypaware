// @ts-check

// The readline prompts outside `walkthrough.js` on a stdin that can no
// longer answer. `rl.question()` leaves its promise permanently unsettled
// at EOF, so each of these waited forever on an answer that could never
// arrive instead of taking the default it had just printed.
//
// The wizard's fork menu is the exposed one: it is the first screen `hyp
// init` shows, so a terminal whose stdin dries up or drops never got past
// it. The two `[y/N]` confirms are behind a TTY gate (LLP 0104,
// LLP 0155#delete-confirm), so what lands on them is a ctrl+D or a dropped
// session rather than a pipe.
//
// Every case is raced against a timer, because the pre-fix failure mode is
// a hang rather than a wrong value and an unraced assertion would never
// run at all.
//
// @ref LLP 0190#eof-everywhere [tests]: a spent stdin lands on the prompt's stated default rather than waiting on an answer that can never come
// @ref LLP 0129#fork [tests]: quit stays the fork's answer when the terminal stops answering, so nothing is reconfigured by accident

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { askYesNo } from '../../src/core/cli/confirm.js'
import {
  buildForkOptions,
  buildReturningGateOptions,
  legacyForkPrompt,
  legacyReturningGatePrompt,
} from '../../src/core/cli/wizard/fork.js'
import { buildTtyPrompt } from '../../src/core/plugin_install/confirm.js'

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

/**
 * A stream that has already ended before the readline interface is built.
 * Readline registers its `end` listener at construction, so this one never
 * emits `close` - the case a `close`-only guard still hangs on.
 *
 * @returns {Promise<PassThrough>}
 */
async function spentStdin() {
  const stdin = new PassThrough()
  stdin.resume()
  stdin.end()
  await new Promise((resolve) => setImmediate(resolve))
  return stdin
}

test('fork menu takes its printed default on a stdin that ends without a line', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const choice = legacyForkPrompt({ stdout: /** @type {any} */ (stdout), stderr: /** @type {any} */ (makeBuf()), stdin, env: {} }, buildForkOptions())
  stdin.end()

  // Quit, the default the menu printed, and the answer a bare enter gives:
  // `runInitWizard` turns it into exit 0 with nothing written, which is
  // also what the TUI path returns for a real ctrl+c at this screen.
  assert.equal(await settles(choice, 'fork menu at EOF'), 'quit')
  // The question is still asked, byte for byte: the default is taken
  // because it was advertised, not instead of advertising it.
  assert.match(stdout.text(), /Choose \[1-3, default 3\]: $/)
})

test('fork menu takes its printed default on a stdin that was already spent', async () => {
  const stdin = await spentStdin()
  const choice = legacyForkPrompt({ stdout: /** @type {any} */ (makeBuf()), stderr: /** @type {any} */ (makeBuf()), stdin, env: {} }, buildForkOptions())

  assert.equal(await settles(choice, 'fork menu on a spent stdin'), 'quit')
})

test('fork menu still honours an explicit pick', async () => {
  const stdin = new PassThrough()
  const choice = legacyForkPrompt({ stdout: /** @type {any} */ (makeBuf()), stderr: /** @type {any} */ (makeBuf()), stdin, env: {} }, buildForkOptions())
  stdin.write('1\n')

  assert.equal(await settles(choice, 'fork menu with an answer'), 'team')
})

test('returning gate menu takes its printed default on a stdin that ends without a line', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const choice = legacyReturningGatePrompt(
    { stdout: /** @type {any} */ (stdout), stderr: /** @type {any} */ (makeBuf()), stdin, env: {} },
    buildReturningGateOptions()
  )
  stdin.end()

  assert.equal(await settles(choice, 'returning gate at EOF'), 'quit')
  assert.match(stdout.text(), /Choose \[1-3, default 3\]: $/)
})

test('askYesNo declines on a stdin that ends without a line', async () => {
  const stdin = new PassThrough()
  const stderr = makeBuf()
  const answered = askYesNo(/** @type {any} */ ({ stdin, stderr }), 'Delete everything? [y/N] ')
  stdin.end()

  // The `[y/N]` says no is the default, and an irreversible verb has to
  // land there when the terminal stops being able to say otherwise.
  assert.equal(await settles(answered, 'askYesNo at EOF'), false)
  assert.match(stderr.text(), /\[y\/N\] $/)
})

test('askYesNo declines on a stdin that was already spent', async () => {
  const stdin = await spentStdin()
  const answered = askYesNo(
    /** @type {any} */ ({ stdin, stderr: makeBuf() }),
    'Delete everything? [y/N] '
  )

  assert.equal(await settles(answered, 'askYesNo on a spent stdin'), false)
})

test('askYesNo still honours an explicit yes', async () => {
  const stdin = new PassThrough()
  const answered = askYesNo(
    /** @type {any} */ ({ stdin, stderr: makeBuf() }),
    'Delete everything? [y/N] '
  )
  stdin.write('yes\n')

  assert.equal(await settles(answered, 'askYesNo with an answer'), true)
})

test('plugin install confirm declines on a stdin that ends without a line', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const ask = buildTtyPrompt({ stdin, stdout: /** @type {any} */ (stdout) })
  const answered = ask()
  stdin.end()

  assert.equal(await settles(answered, 'plugin install confirm at EOF'), false)
  assert.match(stdout.text(), /Proceed\? \[y\/N\] $/)
})

test('plugin install confirm declines on a stdin that was already spent', async () => {
  const stdin = await spentStdin()
  const ask = buildTtyPrompt({ stdin, stdout: /** @type {any} */ (makeBuf()) })

  assert.equal(await settles(ask(), 'plugin install confirm on a spent stdin'), false)
})

test('plugin install confirm still honours an explicit yes', async () => {
  const stdin = new PassThrough()
  const ask = buildTtyPrompt({ stdin, stdout: /** @type {any} */ (makeBuf()) })
  const answered = ask()
  stdin.write('y\n')

  assert.equal(await settles(answered, 'plugin install confirm with an answer'), true)
})
