// @ts-check

/** @param {unknown} stream */
export function isTty(stream) {
  return !!stream && typeof stream === 'object' && /** @type {{ isTTY?: boolean }} */ (stream).isTTY === true
}

/**
 * Whether to emit ANSI on this stream: a TTY, and not vetoed by `NO_COLOR`.
 *
 * `isTty` alone is the wrong test. `NO_COLOR` (no-color.org) is set by
 * people whose terminal is a TTY and who still want plain text - low-vision
 * users on high-contrast themes, anyone piping through a pager that renders
 * escapes literally. The TUI already honours it; commands that reach for
 * `isTty` directly did not, so the same run could be half-coloured.
 *
 * @param {unknown} stream
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function useColor(stream, env = process.env) {
  if (env?.NO_COLOR) return false
  return isTty(stream)
}

/**
 * @param {unknown} stdin
 * @returns {Promise<string>}
 */
export async function readAllStdin(stdin) {
  const stream = /** @type {AsyncIterable<Buffer | string> | undefined} */ (stdin)
  if (!stream || typeof (/** @type {any} */ (stream))[Symbol.asyncIterator] !== 'function') return ''
  // Collect raw chunks and decode once at the end: a multibyte UTF-8
  // codepoint split across a chunk boundary must not be decoded per-chunk
  // (that yields U+FFFD replacement chars).
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}
