// @ts-check

/**
 * The stderr capture the refusal suites read.
 *
 * The refusal mirror writes to the real `process.stderr` on purpose (LLP
 * 0329#consequences), so the only way to see its lines is to stand in
 * front of that descriptor. Four suites had grown their own copy of that,
 * and the part worth having once is the `finally`: a capture that leaks a
 * patched `process.stderr.write` into the next test swallows every later
 * line, which is exactly the silence these suites exist to detect, arriving
 * from the harness instead of from the code.
 *
 * The copies differed only in what they did with the captured text, so the
 * patch and its restore live in `stderrTextFrom` and the counting suites'
 * filter is layered on top of it.
 */

/**
 * Capture what `fn` writes to the real `process.stderr` and return it whole.
 *
 * A capture that wants the text rather than a count: the containment suite
 * matches on it, splits it several ways per assertion, and reads absence as
 * evidence, so it may not be handed a set of lines already narrowed to one
 * token.
 *
 * @param {() => unknown} fn
 * @returns {Promise<string>}
 */
export async function stderrTextFrom(fn) {
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
}

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
  const captured = await stderrTextFrom(fn)
  return captured
    .split('\n')
    .filter((line) => line.includes(token) && !(exclude !== undefined && line.includes(exclude)))
}
