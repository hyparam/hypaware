// @ts-check

/** @param {unknown} stream */
export function isTty(stream) {
  return !!stream && typeof stream === 'object' && /** @type {{ isTTY?: boolean }} */ (stream).isTTY === true
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
