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
  let out = ''
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  }
  return out
}
