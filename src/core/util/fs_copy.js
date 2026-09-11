// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Recursively copy a directory. Regular files and directories only:
 * symlinks and other special entries are skipped, which is what the
 * skill/agent installers want (a template tree copied into a client's
 * config directory).
 *
 * The predicate is not local to this file: `hashTree` mirrors it so a source
 * tree and the copy made of it digest equal. Widening it here alone makes the
 * digest cover less than the copy carries, and the boot refresh re-copies such
 * an asset on every boot forever (issue #1666).
 *
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
 * @ref LLP 0401#digest-covers-the-copy [constrained-by]: the asset digest is
 *   defined as what this function carries, so the two sets move together.
 */
export async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(from, to)
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
    }
  }
}
