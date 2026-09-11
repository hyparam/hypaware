// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

/** Fresh test-owned directory, removed after this test file finishes.
 * @param {string} prefix
 */
export function temporaryDirectory(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}
