// @ts-check

/**
 * Test-side entry to the shared Crush database fixture in
 * `hypaware-core/smoke/lib/crush_fixture.js`, plus a temp directory helper.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export { CRUSH_V0_99_0_SCHEMA, createCrushDb, insertMessage, insertSession, openWriter } from '../../hypaware-core/smoke/lib/crush_fixture.js'

/** @returns {Promise<string>} */
export async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'crush-db-'))
}
