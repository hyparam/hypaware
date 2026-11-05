// @ts-check

/**
 * Test-side entry to the shared Crush database fixture in
 * `hypaware-core/smoke/lib/crush_fixture.js`, plus a temp directory helper.
 */

import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export { CRUSH_V0_99_0_SCHEMA, createCrushDb, insertMessage, insertSession, openWriter } from '../../hypaware-core/smoke/lib/crush_fixture.js'

/** @returns {Promise<string>} */
export async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crush-db-'))
  // Canonicalize away a win32 8.3 short name: a GitHub runner's %TEMP% is
  // `C:\Users\RUNNER~1\...`, and the crush source realpaths each data dir
  // with the non-native `realpathSync`, which preserves whatever form it is
  // handed. Hand it the one long form `realpathSync.native` resolves, or the
  // fixture's own `fs.realpath` paths and the source's diverge on the short
  // vs long spelling of the same directory. A no-op where there is no 8.3.
  return realpathSync.native(dir)
}
