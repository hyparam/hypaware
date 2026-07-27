// @ts-check

/**
 * @import { Writable } from 'node:stream'
 */

/**
 * Survive an asynchronous write failure on stdout/stderr.
 *
 * A `try`/`catch` around a write catches a *synchronous* throw. On a pipe,
 * `process.stdout` is a socket and a failed write arrives later as an
 * `'error'` event, which no `try`/`catch` in the process can contain. With
 * no listener, Node treats that as an unhandled `'error'`: stack trace,
 * exit 1, from a command that had already done its work and simply had its
 * reader walk away.
 *
 * The common case is benign and deserves no output at all: `hyp ... | head`
 * closes the pipe once it has its lines, and the writer sees EPIPE. That is
 * the reader saying "enough", not a failure of the command.
 *
 * Why this is needed at all when small outputs already survive: a write
 * that fits the ~64 KiB pipe buffer completes before the reader's exit can
 * matter, so most commands never hit it. Anything larger does - and
 * `hyp query overview --json` is unbounded by design, since the row counts
 * behind the block's fold lines have to be exact.
 *
 * Errors are swallowed rather than exited on, so the run finishes its
 * normal path (observability shutdown included) and exits with the code the
 * command chose. Once a stream is broken, every later write to it fails the
 * same way; each is handled and ignored.
 *
 * @param {Writable[]} streams
 * @param {(message: string) => void} [onUnexpected] called once for a
 *   non-EPIPE stream error, which is worth a word even though nothing can
 *   be done about it
 * @returns {() => void} detaches the listeners
 */
export function installStreamErrorHandlers(streams, onUnexpected) {
  let reported = false
  /** @type {Array<() => void>} */
  const detach = []
  for (const stream of streams) {
    /** @param {NodeJS.ErrnoException} err */
    const handler = (err) => {
      if (err?.code === 'EPIPE') return
      if (reported) return
      reported = true
      onUnexpected?.(`hyp: output stream failed (${err?.code ?? err?.message ?? 'unknown'})\n`)
    }
    stream.on('error', handler)
    detach.push(() => stream.off('error', handler))
  }
  return () => { for (const off of detach) off() }
}
