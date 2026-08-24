// @ts-check

/**
 * @import { Interface } from 'node:readline/promises'
 */

/**
 * Ask one question and settle even when the stream can no longer answer.
 *
 * The same EOF defect `queuedLineAsker` documents below, for the prompts
 * that ask exactly once and are not built with `terminal: false`. There,
 * writing the query directly to the output stream is not equivalent to
 * asking: on a real terminal readline redraws the line it is editing from
 * its own cursor bookkeeping, and a query it never saw is a query it
 * cannot redraw. So this keeps `rl.question` as the thing that writes and
 * reads, and only replaces the promise, which is the part that is broken.
 *
 * Two settlements are added to it: `close`, for a stream that ends while
 * the question is on screen (a terminal that dropped, a ctrl+D), and the
 * stream's own `readableEnded`, for a stream that was already spent when
 * the interface was built. Readline registers its `end` listener at
 * construction, so the second case never emits `close` at all and a
 * `close`-only guard still hangs on it. Both resolve `null`, which is a
 * distinct value from the empty line and not a synonym for it: most
 * callers read it as the bare enter they would have got anyway, but a
 * caller whose default would *proceed* must tell the two apart (LLP 0299
 * #eof-declines), so this never collapses them on their behalf.
 *
 * Neither settlement may outrun an answer that did arrive, and both can:
 * `close` fires synchronously, while `rl.question` hands its answer back
 * through a promise, a microtask later. A stream that delivers the line
 * and EOF in one burst (`Readable.from(['y\n'])`, any readable that
 * pushes data and `null` together) would have `close` win that race and
 * discard a real `y`, so the EOF settlements are deferred a turn and the
 * delivered line settles first. Readline also routes the last line of a
 * stream that ends without a trailing newline to `line` rather than to
 * the pending question, which is a second answer `question` alone never
 * sees, so that one is taken too - but only at EOF, and only if the
 * question never got a line of its own. Readline emits `line` while no
 * question is pending, so the same event also carries anything typed or
 * pasted PAST the answer ("n\ny\n" in one burst), and settling on that
 * directly would answer with the last line of the burst rather than the
 * first: a typed `n` at an irreversible confirm would read as `y`.
 *
 * `rl.question`'s own promise is left permanently unsettled at EOF rather
 * than rejected, so nothing here can leak an unhandled rejection; the
 * handler attached to it is only there for the abort/close rejections
 * newer readline versions may raise.
 *
 * @ref LLP 0190#eof-everywhere [implements]: a spent stdin settles on the prompt's stated default instead of waiting on an answer that can never come
 *
 * @param {Interface} rl
 * @param {NodeJS.ReadableStream} input
 * @param {string} prompt
 * @returns {Promise<string | null>} the answer line, `null` once the stream is spent
 */
export function askLineOnce(rl, input, prompt) {
  return new Promise((resolve) => {
    let settled = false
    /** @param {string | null} line */
    const done = (line) => {
      if (settled) return
      settled = true
      resolve(line)
    }
    /**
     * The last line readline emitted outside the question, held rather
     * than settled on. Only read if the question itself never answered.
     * @type {string | null}
     */
    let unaskedLine = null
    // A turn behind the answer, never ahead of it: an answer delivered in
    // the same burst as the EOF has to settle first.
    const endOfInput = () => setImmediate(() => done(unaskedLine))
    rl.once('close', endOfInput)
    // Readline emits `line` only while no question is pending, so this is
    // either the unterminated last line of the stream (an answer the
    // question never sees) or a line that arrived past the answer. Holding
    // it for EOF takes the first without letting the second overwrite an
    // answer the question already has.
    rl.on('line', (line) => {
      unaskedLine = line
    })
    // Writes the query synchronously, on a spent stream too.
    rl.question(prompt).then(done, () => done(null))
    if (/** @type {{ readableEnded?: boolean }} */ (input).readableEnded === true) endOfInput()
  })
}

/**
 * Ceiling on the answer lines held for a still-unasked prompt. A prompt
 * interface asks a small fixed number of questions and is closed straight
 * after, so anything past a handful is unreadable backlog: a pipe that
 * floods stdin (`yes |`) must not grow an array for as long as the prompt
 * is on screen.
 */
const MAX_QUEUED_LINES = 4

/**
 * Read answer lines off a readline interface without losing one and
 * without ever waiting on a stream that can no longer answer.
 *
 * `rl.question()` cannot do either job here. It registers its `line`
 * listener only when it is called, so a second answer line arriving in
 * the same chunk as the first ("y\n3\n" from a pipe) is emitted and
 * dropped before a re-ask can ask: readline emits both synchronously
 * and the next `question()` is a microtask away. And at EOF its promise
 * is left permanently unsettled - the interface closes, `question`
 * neither resolves nor rejects - which is a hang, or a silent
 * "unsettled top-level await" exit. Queueing every line from
 * construction fixes the first; resolving the pending ask as `null` on
 * `close` fixes the second.
 *
 * `close` alone is not enough for the second job. Readline registers its
 * `end` listener when the interface is built, so an interface built over
 * a stream that has ALREADY ended never sees an `end` and never emits
 * `close` - the second prompt asked on a spent stdin would wait forever
 * even though the first resolved. The stream's own `readableEnded` is
 * the answer readline can no longer give, so it seeds `closed` here.
 *
 * This lives beside `stdio.js` and `flush-streams.js` rather than inside
 * any one prompt: every readline prompt in the tree has the same EOF
 * defect, and a shared asker is what keeps the answer to it in one place.
 *
 * @ref LLP 0190#eof-everywhere [implements]: a spent stdin settles on the prompt's stated default instead of waiting on an answer that can never come
 *
 * @param {Interface} rl
 * @param {NodeJS.ReadableStream} input
 * @param {NodeJS.WritableStream} output
 * @returns {(prompt: string) => Promise<string | null>} writes one prompt and takes the next line, `null` once the stream is spent
 */
export function queuedLineAsker(rl, input, output) {
  /** @type {string[]} */
  const queued = []
  /** @type {((line: string | null) => void) | null} */
  let waiting = null
  let closed = /** @type {{ readableEnded?: boolean }} */ (input).readableEnded === true
  const take = () => {
    const resolve = waiting
    waiting = null
    return resolve
  }
  rl.on('line', (line) => {
    const resolve = take()
    if (resolve) resolve(line)
    else if (queued.length < MAX_QUEUED_LINES) queued.push(line)
  })
  rl.on('close', () => {
    closed = true
    const resolve = take()
    if (resolve) resolve(null)
  })
  return function askLine(prompt) {
    // Byte-identical to what `rl.question` writes: with `terminal: false`
    // readline puts the query straight on the output stream.
    output.write(prompt)
    if (queued.length > 0) return Promise.resolve(/** @type {string} */ (queued.shift()))
    if (closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      waiting = resolve
    })
  }
}
