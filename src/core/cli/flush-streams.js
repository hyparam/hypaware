// @ts-check

/**
 * @import { Writable } from 'node:stream'
 */

/**
 * Resolve once a writable stream has drained its buffered output. Resolves
 * immediately when nothing is pending, and on `error` (e.g. EPIPE when the
 * reader has gone away) so a caller awaiting it before `process.exit` is
 * never blocked.
 *
 * `process.exit()` terminates synchronously and drops whatever is still
 * buffered in stdout/stderr: for a pipe that means output past the ~64KiB
 * pipe buffer is silently truncated. Awaiting this on stdout/stderr before
 * exiting guarantees every byte reached the OS first. (Writing to a file
 * never hit this because file writes complete synchronously.)
 *
 * @param {Writable} stream
 * @returns {Promise<void>}
 */
export function flushStream(stream) {
  return new Promise((resolve) => {
    if (stream.writableLength === 0) {
      resolve()
      return
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    stream.once('error', finish)
    // The write callback fires after this (empty) chunk and all preceding
    // buffered writes have been handed to the OS.
    stream.write('', finish)
  })
}
