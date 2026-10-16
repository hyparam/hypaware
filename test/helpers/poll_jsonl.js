// @ts-check

/**
 * The JSONL poll the live-daemon suites read their exported spans with.
 *
 * The tracer's JSONL exporter appends through an `fs.WriteStream` with no
 * flush hook these daemons ever call, so a span lands on disk async relative
 * to the tick's own promise resolving: polling for it is the only way to see
 * it. It lives here because two suites poll the same file the same way, and
 * a hole in the poll (issue #1516) is a hole in each of them.
 */

import fs from 'node:fs/promises'

/**
 * Poll `filePath` until a JSONL record satisfies `predicate`.
 *
 * Only whole lines are parsed. A read that lands mid-append sees the tail
 * line half written, and one appending stream writes in order and can only
 * have written a prefix of the record it is on, so torn content is always
 * the bytes after the last newline: dropping them forgives the partial write
 * the next poll will see whole, and nothing else. A `SyntaxError` on a line
 * the writer already terminated is real corruption and still throws.
 *
 * @param {string} filePath
 * @param {(record: any) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<any>} the matching record, or undefined on timeout
 */
export async function pollJsonlFor(filePath, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const lines = (await fs.readFile(filePath, 'utf8')).split('\n')
      // Whatever follows the last newline: empty once the writer has ended
      // the line, the torn fragment while it has not.
      lines.pop()
      for (const line of lines) {
        if (!line) continue
        const record = JSON.parse(line)
        if (predicate(record)) return record
      }
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
    }
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
