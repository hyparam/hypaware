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

const ERASE = /\x1b\[\d+A\r\x1b\[J/

/**
 * The spinner lines a TTY run drew, one per frame, without their newline.
 *
 * @param {string} text
 */
function spinnerLines(text) {
  return text.split(ERASE).filter(Boolean).map((frame) => frame.split('\n').at(-2) ?? '')
}

test('withSpinner off a TTY prints the label once and nothing else', async () => {
  const stdout = makeStdout()
  const result = await withSpinner({ stdout, label: 'backfill claude: importing…', env: {} }, async () => 42)
  assert.equal(result, 42)
  assert.equal(stdout.text(), 'backfill claude: importing…\n')
})

test('withSpinner renders live status and keeps ETA visible on an 80-column terminal', async () => {
  const stdout = makeStdout({ isTTY: true, columns: 80 })
  let status = 'central: 0/12,000 rows (0%) | ETA unavailable'
  await withSpinner({ stdout, label: 'Sending', env: {}, intervalMs: 5, status: () => status }, async () => {
    status = 'central: 5,000/12,000 rows (41%) | ETA ~14s'
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const frames = spinnerLines(stdout.text())
  assert.match(frames[frames.length - 1], /41%.*ETA ~14s$/)
  assert.ok(frames.every((frame) => [...frame].length < 80))
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
  // Each frame after the first erases the one before it, in place.
  assert.match(text, /\x1b\[1A\r\x1b\[J\S waiting\n/)
  // The last write is the clear, leaving a clean line for the caller.
  assert.ok(text.endsWith('\x1b[1A\r\x1b[J'))
})

// A spinner line wider than the terminal would wrap and push the elapsed
// counter onto a second row, so the line is clamped to one row.
test('withSpinner keeps a long label inside the terminal width', async () => {
  const stdout = makeStdout({ isTTY: true, columns: 20 })
  const label = "Replaying 'claude-desktop' history to central-production..."
  await withSpinner({ stdout, label, env: {}, intervalMs: 5 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const frames = spinnerLines(stdout.text())
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
  const frames = spinnerLines(stdout.text())
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
  const frames = spinnerLines(stdout.text())
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
  assert.ok(stdout.text().endsWith('\x1b[1A\r\x1b[J'))
})

test('withSpinner draws its lines above the spinner and erases them with it', async () => {
  const stdout = makeStdout({ isTTY: true, columns: 20 })
  await withSpinner({ stdout, label: 'waiting', env: {}, above: ['visit:', `  ${'u'.repeat(30)}`] }, async () => {})
  const text = stdout.text()
  assert.ok(text.startsWith(`visit:\n  ${'u'.repeat(30)}\n`))
  // One row for the heading, two for the wrapped URL, one for the spinner.
  assert.ok(text.endsWith('\x1b[4A\r\x1b[J'))
})

test('withSpinner off a TTY prints its lines above once, before the label', async () => {
  const stdout = makeStdout()
  await withSpinner({ stdout, label: 'waiting', env: {}, above: ['visit:', '  url'] }, async () => {})
  assert.equal(stdout.text(), 'visit:\n  url\nwaiting\n')
})

test('withSpinner reads a function above on every frame, and leaves it to the caller off a TTY', async () => {
  const tty = makeStdout({ isTTY: true, columns: 80 })
  /** @type {string[]} */
  let lines = []
  await withSpinner({ stdout: tty, label: 'waiting', env: {}, intervalMs: 5, above: () => lines }, async () => {
    lines = ['enter code: ABCD']
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.match(tty.text(), /enter code: ABCD\n\S waiting/)
  assert.ok(tty.text().endsWith('\x1b[2A\r\x1b[J'), 'the late line goes with the spinner')

  const plain = makeStdout()
  await withSpinner({ stdout: plain, label: 'waiting', env: {}, quietWhenPlain: true, above: () => ['never printed'] }, async () => {})
  assert.equal(plain.text(), '')
})
