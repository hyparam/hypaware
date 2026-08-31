// @ts-check

/**
 * The wizard's stream guard (LLP 0341): the one place a dying output
 * stream is absorbed, so no lane ever crashes the run through its own
 * narration and the orchestrator alone decides what a dead surface means.
 *
 * Both streams are wrapped before any lane runs. A write that throws is
 * caught and recorded; a stream that reports its failure asynchronously
 * (a real pipe's EPIPE arrives as an `error` event a tick after the
 * write call returned) is caught by the same guard through its `error`
 * listener. Once a sink is known dead, further writes become no-ops
 * rather than feeding a destroyed stream.
 *
 * Only stdout's death is the run's business: it is the consent surface,
 * and the orchestrator cancels at the next boundary when it goes
 * (LLP 0341 #dead-surface). stderr carries qualifiers, and its death
 * never ends the run (LLP 0341 #warnings).
 *
 * @import { WizardOutputGuard, WizardOutputSink } from '../../../../src/core/cli/wizard/types.js'
 */

/**
 * How long a boundary check waits for a real stream to settle its
 * pending writes before assuming it is merely slow. A dead pipe fails
 * its queued writes immediately, so the timeout is only ever paid by a
 * backpressured-but-alive reader, which must delay the run rather than
 * wedge it (LLP 0341 #absorb).
 */
const SETTLE_TIMEOUT_MS = 200

/**
 * @ref LLP 0341#absorb [implements]: both streams wrapped once, at the orchestrator; lane writes never throw and stream errors never surface uncaught
 * @param {{ stdout: WizardOutputSink, stderr: WizardOutputSink }} streams
 * @returns {WizardOutputGuard}
 */
export function guardWizardOutput({ stdout, stderr }) {
  const out = wrapSink(stdout)
  const err = wrapSink(stderr)
  return {
    stdout: out.sink,
    stderr: err.sink,
    outputDead: () => out.dead(),
    // The boundary check (LLP 0341 #dead-surface): settle stdout's
    // pending writes so the verdict includes a failure the stream has
    // not reported yet, then say whether the surface is still alive.
    // The config commit must never win the race against the knowledge
    // that the stream it narrated into is gone.
    // @ref LLP 0341#absorb [implements]: the boundary check settles pending writes before reading the verdict, so an act cannot outrun the death report
    checkpoint: async () => {
      if (out.dead()) return false
      await out.settle()
      return !out.dead()
    },
  }
}

/**
 * Wrap one sink. The wrapper delegates `isTTY` and `columns` (the two
 * properties the prompt runtime reads) so TTY detection and layout are
 * unchanged; only `write` is intercepted.
 *
 * @param {WizardOutputSink} sink
 * @returns {{ sink: WizardOutputSink, dead: () => boolean, settle: () => Promise<void> }}
 */
function wrapSink(sink) {
  let dead = false
  const raw = /** @type {any} */ (sink)
  // A real stream reports a failed write on its `error` event, often
  // after the write call already returned. Listening is also what stops
  // Node from turning that event into an uncaught exception.
  if (typeof raw.on === 'function') {
    raw.on('error', () => { dead = true })
  }
  const wrapped = /** @type {WizardOutputSink} */ ({
    /** @param {any[]} args */
    write(...args) {
      if (dead || raw.destroyed === true) {
        dead = true
        return false
      }
      try {
        return raw.write(...args)
      } catch {
        dead = true
        return false
      }
    },
    get isTTY() { return raw.isTTY },
    get columns() { return raw.columns },
  })
  return {
    sink: wrapped,
    dead: () => dead,
    settle: () => settleSink(raw, () => dead, () => { dead = true }),
  }
}

/**
 * Wait until the sink has processed everything queued before this call,
 * bounded. An empty write's callback fires after every earlier chunk has
 * been flushed or the stream has errored, which is exactly the ordering
 * guarantee the boundary check needs. A sink with no callback support (a
 * test buffer) has nothing pending by construction and resolves at once.
 *
 * The callback's own error argument is what records the death, not only
 * the stream's `error` event: both carry the same failure, but only the
 * callback is certain to be in hand at the moment the boundary check
 * reads its verdict. Reading the event alone left the check depending on
 * Node delivering it before the settle promise's continuation.
 *
 * @param {any} raw
 * @param {() => boolean} isDead
 * @param {() => void} markDead
 * @returns {Promise<void>}
 */
function settleSink(raw, isDead, markDead) {
  if (isDead()) return Promise.resolve()
  // A destroyed stream is gone whether or not it ever emitted `error`:
  // a bare `destroy()` (an embedder tearing its stream down, a socket
  // whose peer closed cleanly) emits nothing to listen for. `wrapSink`'s
  // `write` already reads `destroyed` that way, so the settle has to
  // read it the same way - reporting the surface alive here and dead on
  // the very next narration is exactly the split verdict the boundary
  // check exists to close.
  if (raw.destroyed === true) {
    markDead()
    return Promise.resolve()
  }
  if (typeof raw.on !== 'function') return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, SETTLE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      raw.write('', (err) => {
        if (err) markDead()
        finish()
      })
    } catch {
      // The probe write threw where a lane write would have, so it says
      // the same thing a lane write says: the surface is gone. Swallowing
      // it left the settle reporting a sink alive that `wrapSink.write`
      // would have marked dead on the very next narration.
      markDead()
      finish()
    }
  })
}
