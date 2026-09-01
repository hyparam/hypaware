// @ts-check

/**
 * The stderr capture the cursor-refusal suites count lines with.
 *
 * The refusal mirror writes to the real `process.stderr` on purpose (LLP
 * 0329#consequences), so the only way to count its lines is to stand in
 * front of that descriptor. Three suites had grown their own copy of that,
 * and the part worth having once is the `finally`: a capture that leaks a
 * patched `process.stderr.write` into the next test swallows every later
 * line, which is exactly the silence these suites exist to detect, arriving
 * from the harness instead of from the code.
 */

/**
 * Capture what `fn` writes to the real `process.stderr` and return the
 * captured lines carrying `token`.
 *
 * @param {() => unknown} fn
 * @param {string} token
 * @param {string} [exclude] a token whose lines do not count, for a refusal
 *   and a retraction where one carries the other's token as a substring
 * @returns {Promise<string[]>}
 */
export async function stderrLinesFrom(fn, token, exclude) {
  const realWrite = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = /** @type {typeof process.stderr.write} */ ((chunk) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })
  try {
    await fn()
  } finally {
    process.stderr.write = realWrite
  }
  return captured
    .split('\n')
    .filter((line) => line.includes(token) && !(exclude !== undefined && line.includes(exclude)))
}
