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
  const frames = stdout.text().split('\r\x1b[2K').filter(Boolean)
  // Without this the loop below asserts nothing when no frame was rendered.
  assert.ok(frames.length > 0)
  for (const frame of frames) {
    assert.ok(frame.length <= 19, `frame wider than the terminal: ${JSON.stringify(frame)}`)
  }
})

// A terminal that reports a width of 0 or 1 (a pty whose size ioctl did not
// resolve) is a known tiny width, not an unknown one: clamp, do not wrap.
test('withSpinner clamps at a degenerate terminal width', async () => {
  const stdout = makeStdout({ isTTY: true, columns: 1 })
  await withSpinner({ stdout, label: 'waiting for a long time', env: {}, intervalMs: 5 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const frames = stdout.text().split('\r\x1b[2K').filter(Boolean)
  assert.ok(frames.length > 0)
  for (const frame of frames) {
    assert.ok(frame.length <= 1, `frame wider than the terminal: ${JSON.stringify(frame)}`)
  }
})

// The elapsed counter is the point of the spinner, so it is the label that
// gives way to the width, not the tail.
test('withSpinner keeps the elapsed counter when it clamps', async () => {
  const stdout = makeStdout({ isTTY: true, columns: 24 })
  const label = "Replaying 'claude-desktop' history to central-production..."
  await withSpinner({ stdout, label, env: {}, intervalMs: 20 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100))
  })
  const frames = stdout.text().split('\r\x1b[2K').filter(Boolean)
  const last = frames[frames.length - 1]
  assert.match(last, /^\S Replaying.*… \(1s\)$/)
  assert.ok(last.length <= 23, `frame wider than the terminal: ${JSON.stringify(last)}`)
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
