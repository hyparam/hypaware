// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Recursively copy a directory. Regular files and directories only:
 * symlinks and other special entries are skipped, which is what the
 * skill/agent installers want (a template tree copied into a client's
 * config directory).
 *
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
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
