// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

/** Fresh test-owned directory, removed when the calling test finishes (node:test
 * binds a module-level `after` to whatever is running), or when the file finishes
 * when called outside a test. Do not hand one to a later test.
 * @param {string} prefix
 */
export function temporaryDirectory(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}
