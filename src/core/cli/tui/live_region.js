// @ts-check

import { lineRows } from '../style.js'

const CLEAR_TO_END = '\x1b[J'

/**
 * The bottom of the screen that is redrawn in place: each draw erases the
 * previous frame and writes the next, and a clear leaves the screen as it
 * was before the first draw. It tracks the physical rows of the last frame,
 * so it is only correct while nothing else writes below it and while every
 * frame goes to the one stream it was given.
 *
 * @ref LLP 0437#regions [implements]: the live region, redrawn from state and cleared when its step ends
 * @param {{ write(chunk: string): unknown }} stdout
 */
export function createLiveRegion(stdout) {
  let rows = 0
  let lastHead = ''
  let lastColumns = 0
  let lastTailRows = 0

  return {
    /**
     * Replace the current frame with `head` + `frame`. Width is passed per
     * frame, not once: a resize between draws must reach the row count, or
     * the next erase moves the cursor by a stale amount.
     *
     * `head` is lines above the frame that rarely change (a sign-in URL
     * over a spinner). While it, the width, and the frame's row count are
     * unchanged, only the frame's rows are rewritten: cells a redraw
     * clears lose any selection on them, and the head is what a user
     * copies from.
     *
     * @param {string} frame
     * @param {number} columns
     * @param {string} [head]
     */
    draw(frame, columns, head = '') {
      const tailRows = countPhysicalRows(frame, columns)
      if (rows > 0 && head === lastHead && columns === lastColumns && tailRows === lastTailRows) {
        stdout.write(`\x1b[${tailRows}A\r${CLEAR_TO_END}${frame}`)
        return
      }
      const erase = rows > 0 ? `\x1b[${rows}A\r${CLEAR_TO_END}` : ''
      rows = countPhysicalRows(head, columns) + tailRows
      lastHead = head
      lastColumns = columns
      lastTailRows = tailRows
      stdout.write(erase + head + frame)
    },
    /** Erase the current frame, leaving the cursor where the region began. */
    clear() {
      if (rows === 0) return
      const up = rows
      rows = 0
      stdout.write(`\x1b[${up}A\r${CLEAR_TO_END}`)
    },
  }
}

/**
 * Count the number of *physical* terminal rows a frame occupies. The
 * runtime uses this to know how far to move the cursor up before
 * clearing the previous frame. A naive newline count is wrong whenever
 * a logical line is wider than the terminal: the terminal soft-wraps it
 * onto multiple rows, so the cursor descended further than the number of
 * `\n` written. Undercounting here leaves stale rows on screen on every
 * redraw: the classic "the question keeps duplicating when I move the
 * cursor" symptom.
 *
 * Frames always end with a trailing `\n`; the empty segment after it
 * contributes no row.
 *
 * @param {string} frame
 * @param {number} columns
 * @returns {number}
 */
export function countPhysicalRows(frame, columns) {
  const lines = frame.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let count = 0
  for (const line of lines) count += lineRows(line, columns)
  return count
}
