// @ts-check

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withSpinner } from '../../../src/core/cli/spinner.js'

/**
 * @param {{ isTTY?: boolean, columns?: number }} [opts]
 */
function makeStdout({ isTTY = false, columns = undefined } = {}) {
  let text = ''
  return {
    isTTY,
    columns,
    /** @param {string} chunk */
    write(chunk) {
      text += String(chunk)
      return true
    },
    text: () => text,
  }
}

test('withSpinner off a TTY prints the label once and nothing else', async () => {
  const stdout = makeStdout()
  const result = await withSpinner({ stdout, label: 'backfill claude: importing…', env: {} }, async () => 42)
  assert.equal(result, 42)
  assert.equal(stdout.text(), 'backfill claude: importing…\n')
})

test('withSpinner under HYP_NO_TUI=1 stays on the plain path even on a TTY', async () => {
  const stdout = makeStdout({ isTTY: true })
  await withSpinner({ stdout, label: 'waiting', env: { HYP_NO_TUI: '1' } }, async () => {})
  assert.equal(stdout.text(), 'waiting\n')
})

test('withSpinner on a TTY animates in place and clears the line when done', async () => {
  const stdout = makeStdout({ isTTY: true })
  await withSpinner({ stdout, label: 'waiting', env: {}, intervalMs: 5 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const text = stdout.text()
  // Frames render the label behind a line-clearing carriage return, never a
  // bare newline: the line is transient, so nothing it wrote survives it.
  assert.match(text, /\r\x1b\[2K.* waiting/)
  assert.doesNotMatch(text, /waiting\n/)
  // The last write is the clear, leaving a clean line for the caller.
  assert.ok(text.endsWith('\r\x1b[2K'))
})

// A frame wider than the terminal wraps, and `\x1b[2K` cannot erase the row
// it wrapped from: the spinner would walk down the screen a row per frame.
test('withSpinner keeps a long label inside the terminal width', async () => {
  const stdout = makeStdout({ isTTY: true, columns: 20 })
  const label = "Replaying 'claude-desktop' history to central-production..."
  await withSpinner({ stdout, label, env: {}, intervalMs: 5 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  for (const frame of stdout.text().split('\r\x1b[2K').filter(Boolean)) {
    assert.ok(frame.length <= 19, `frame wider than the terminal: ${JSON.stringify(frame)}`)
  }
})

test('withSpinner clears the line and rethrows when the work fails', async () => {
  const stdout = makeStdout({ isTTY: true })
  await assert.rejects(
    () => withSpinner({ stdout, label: 'waiting', env: {}, intervalMs: 5 }, async () => {
      throw new Error('boom')
    }),
    /boom/
  )
  assert.ok(stdout.text().endsWith('\r\x1b[2K'))
})
