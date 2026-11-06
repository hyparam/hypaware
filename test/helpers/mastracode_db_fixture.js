// @ts-check

/**
 * Test-side entry to the shared Mastra Code database fixture in
 * `hypaware-core/smoke/lib/mastracode_fixture.js`, plus a temp directory
 * helper.
 */

import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export * from '../../hypaware-core/smoke/lib/mastracode_fixture.js'

/** @returns {Promise<string>} */
export async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mastracode-db-'))
  // The long form of the directory, as crush_db_fixture.js explains: a
  // win32 runner's %TEMP% can be an 8.3 short name.
  return realpathSync.native(dir)
}
