// @ts-check

import { parentPort } from 'node:worker_threads'

import { readCursorSession, safeError } from './native.js'

/**
 * The worker end of the Cursor native decode. One message is one graph:
 * a session descriptor in, a projected snapshot out.
 *
 * The SQLite handle, the per-blob sha256, and the per-record `JSON.parse`
 * all live here, so the read transaction Cursor's store is held under is
 * no longer coupled to the daemon's event loop in either direction: the
 * loop never waits on the decode, and the decode never waits on the loop.
 *
 * Errors travel as a message, not as a throw: a graph the reader refuses
 * must fail that one session, not tear down the thread mid-pass. Only the
 * fixed `CursorReadError` codes cross the boundary, because a raw SQLite
 * message can carry private paths or row data.
 *
 * @import { CursorSession } from '../../../../hypaware-core/plugins-workspace/cursor/src/types.js'
 */

if (!parentPort) throw new Error('native_decoder_thread must be started as a worker thread')
const port = parentPort

port.on('message', (/** @type {{ id: number, session: CursorSession, previousRoot?: string }} */ message) => {
  try {
    port.postMessage({ id: message.id, snapshot: readCursorSession(message.session, message.previousRoot) })
  } catch (err) {
    port.postMessage({ id: message.id, error: safeError(err).message })
  }
})
