// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

/** Fresh test-owned directory, removed when the calling test finishes (node:test
 * binds a module-level `after` to whatever is running), or when the file finishes
 * when called outside a test. Do not hand one to a later test.
 *
 * The removal is an `after` hook registered now, and node:test runs a test's
 * `after` hooks in registration order and skips the rest once one throws. A
 * test that starts processes writing into the directory must therefore stop
 * them before this hook runs, or own the directory itself and remove it with
 * `removeTemporaryDirectory` once they have exited.
 * @param {string} prefix
 */
export function temporaryDirectory(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  after(() => removeTemporaryDirectory(dir))
  return dir
}

/** Remove a test-owned directory. Retries (about 2.75 s at most) ride out the
 * ENOTEMPTY/EBUSY a just-exited process's last writes can still cause on a
 * loaded machine.
 * @param {string} dir
 */
export function removeTemporaryDirectory(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
