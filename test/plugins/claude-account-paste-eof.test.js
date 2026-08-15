// @ts-check

// The `Code: ` paste fallback in `claude-account login` on a stdin that can
// no longer answer. `rl.question()` leaves its promise permanently unsettled
// at EOF, so a login with no loopback listener to race waited forever on a
// paste that could never arrive.
//
// The two halves are asymmetric on purpose, and that is what these cases
// pin: with no listener there is nothing else that can finish the login, so
// EOF is a failure and says so; with a listener up the browser can still
// land on it, so the paste lane must not settle and take the race away from
// a sign-in that was still on its way.
//
// Raced against a timer, because the pre-fix failure mode is a hang.
//
// @ref LLP 0190#eof-everywhere [tests]: a spent stdin settles the prompt instead of waiting on an answer that can never come

import test from 'node:test'
import assert from 'node:assert/strict'
import readline from 'node:readline/promises'
import { PassThrough } from 'node:stream'

import { pasteAuthorizationLane } from '../../hypaware-core/plugins-workspace/claude-account/src/index.js'

const SETTLE_MS = 500
const HUNG = Symbol('hung')

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T | typeof HUNG>}
 */
async function raceSettle(promise) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(HUNG), SETTLE_MS)
  })
  try {
    return await Promise.race([promise.then((v) => /** @type {any} */ ({ ok: v })), timeout])
  } catch (err) {
    return /** @type {any} */ ({ err })
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
 * @param {PassThrough} stdin
 * @param {{ write(chunk: string): unknown }} stdout
 */
function makeRl(stdin, stdout) {
  return readline.createInterface({
    input: stdin,
    output: /** @type {any} */ (stdout),
    terminal: false,
  })
}

test('paste lane fails, rather than hanging, when stdin ends with no listener to wait on', async () => {
  const stdin = new PassThrough()
  const stdout = makeBuf()
  const rl = makeRl(stdin, stdout)
  const lane = pasteAuthorizationLane({ rl, stdin, hasCallback: false })
  stdin.end()

  const settled = /** @type {any} */ (await raceSettle(lane))
  assert.notEqual(settled, HUNG, 'the paste lane never settled - it hung on EOF')
  assert.ok(settled.err instanceof Error, 'EOF with no listener is a login failure, not a silent wait')
  assert.match(settled.err.message, /stdin ended/)
  assert.equal(stdout.text(), 'Code: ')
  rl.close()
})

test('paste lane fails, rather than hanging, on a stdin that was already spent', async () => {
  const stdin = new PassThrough()
  stdin.resume()
  stdin.end()
  await new Promise((resolve) => setImmediate(resolve))

  const rl = makeRl(stdin, makeBuf())
  const settled = /** @type {any} */ (await raceSettle(pasteAuthorizationLane({ rl, stdin, hasCallback: false })))
  assert.notEqual(settled, HUNG, 'the paste lane never settled on an already-spent stdin')
  assert.ok(settled.err instanceof Error)
  rl.close()
})

test('paste lane leaves the loopback listener to finish when stdin ends under it', async () => {
  const stdin = new PassThrough()
  const rl = makeRl(stdin, makeBuf())
  const lane = pasteAuthorizationLane({ rl, stdin, hasCallback: true })
  lane.catch(() => {})
  stdin.end()

  // The race a real login runs. An EOF on the fallback input is not
  // evidence about the browser flow, so the listener still wins it.
  const callbackResult = new Promise((resolve) => {
    setTimeout(() => resolve({ code: 'from-browser', state: 'st' }), 20)
  })
  const settled = /** @type {any} */ (await raceSettle(Promise.race([callbackResult, lane])))
  assert.deepEqual(settled.ok, { code: 'from-browser', state: 'st' })
  rl.close()
})

test('paste lane still parses a pasted code', async () => {
  const stdin = new PassThrough()
  const rl = makeRl(stdin, makeBuf())
  const lane = pasteAuthorizationLane({ rl, stdin, hasCallback: true })
  stdin.write('the-code#the-state\n')

  const settled = /** @type {any} */ (await raceSettle(lane))
  assert.deepEqual(settled.ok, { code: 'the-code', state: 'the-state' })
  rl.close()
})
