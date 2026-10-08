// @ts-check

/** @import { Readable } from 'node:stream' */

// Match the subprocess diagnostic budget in self_update.js. Ref probes normally
// return one or two short lines; overflow must refuse parsing a partial result.
export const GIT_OUTPUT_LIMIT = 64 * 1024

/**
 * Retain a prefix while draining the entire pipe. Copy into one fixed buffer,
 * never retain chunk views or a growing array (even for one-byte writes).
 *
 * @param {Readable | null} stream
 * @param {boolean} [diagnostic]
 */
export function captureGitOutput(stream, diagnostic = false) {
  /** @type {Buffer | undefined} */
  let buffer
  let used = 0
  let overflow = false
  stream?.on('data', (/** @type {Buffer} */ chunk) => {
    const count = Math.min(chunk.length, GIT_OUTPUT_LIMIT - used)
    if (count > 0) {
      buffer ??= Buffer.allocUnsafe(GIT_OUTPUT_LIMIT)
      chunk.copy(buffer, used, 0, count)
      used += count
    }
    if (count < chunk.length) overflow = true
  })
  return {
    overflowed: () => overflow,
    read: () => {
      if (!buffer) return ''
      if (overflow && !diagnostic) return ''
      // An incomplete final line can contain URL userinfo whose closing @ was
      // discarded. Omit that line before redaction instead of leaking a prefix.
      const end = overflow ? buffer.lastIndexOf(10, used - 1) + 1 : used
      const text = buffer.toString('utf8', 0, end)
      return overflow ? `${text}\n[git output truncated at ${GIT_OUTPUT_LIMIT} bytes]` : text
    },
  }
}
