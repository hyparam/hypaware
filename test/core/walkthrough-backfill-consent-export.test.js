// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { defaultBackfillConsentPromptFactory } from '../../src/core/cli/walkthrough.js'

/**
 * Drives a legacy `readline`-backed prompt: writes `answer` to `input` as
 * soon as the expected `[Y/n]: ` suffix shows up on stdout, mirroring the
 * pattern in walkthrough-prompt.test.js.
 *
 * @param {PassThrough} input
 * @param {string} answer
 */
function answerDrivenOutput(input, answer) {
  let value = ''
  let answered = false
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      const text = String(chunk)
      value += text
      if (!answered && text.includes('[Y/n]: ')) {
        answered = true
        input.write(answer)
        input.end()
      }
      return true
    },
    text() {
      return value
    },
  }
}

test('defaultBackfillConsentPromptFactory, imported directly, asks the exact finale copy for a sample question', async () => {
  const input = new PassThrough()
  const stdout = answerDrivenOutput(input, '\n')

  const ask = defaultBackfillConsentPromptFactory({
    stdin: /** @type {any} */ (input),
    stdout: /** @type {any} */ (stdout),
    env: {},
  })
  const consent = await ask({ providers: ['claude'], retentionDays: 14 })

  // Same title/copy shape the init finale shows today for this client:
  // "Import the <providers> history already on this machine (up to <days> days)?"
  assert.equal(stdout.text(), 'Import the Claude history already on this machine (up to 14 days)? [Y/n]: ')
  // Bare enter defaults to yes.
  assert.equal(consent, true)
})

test('defaultBackfillConsentPromptFactory renders the multi-provider title identically and honors an explicit no', async () => {
  const input = new PassThrough()
  const stdout = answerDrivenOutput(input, 'n\n')

  const ask = defaultBackfillConsentPromptFactory({
    stdin: /** @type {any} */ (input),
    stdout: /** @type {any} */ (stdout),
    env: {},
  })
  const consent = await ask({ providers: ['claude', 'codex'], retentionDays: 30 })

  assert.equal(stdout.text(), 'Import the Claude and Codex history already on this machine (up to 30 days)? [Y/n]: ')
  assert.equal(consent, false)
})
