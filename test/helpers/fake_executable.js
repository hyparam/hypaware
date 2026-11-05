// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Write a fake executable `name` into `dir` the way the host can actually
 * execute (and PATH-probe) it: an executable `#!/bin/sh` script on POSIX, a
 * `.cmd` batch script on win32, where the PATH probes honor PATHEXT and an
 * extensionless shell script is not executable at all.
 *
 * The default body exits with `exitCode`. A fixture that needs more than an
 * exit passes both spellings itself (`posix` body with shebang, `cmd` body),
 * so a test cannot accidentally ship a script only one platform can run.
 *
 * @param {string} dir
 * @param {string} name command name without extension
 * @param {{ exitCode?: number, posix?: string, cmd?: string }} [options]
 * @returns {Promise<string>} the written file's path
 */
export async function writeFakeExecutable(dir, name, options = {}) {
  const { exitCode = 0, posix, cmd } = options
  await fs.mkdir(dir, { recursive: true })
  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.cmd`)
    await fs.writeFile(file, cmd ?? `@exit /b ${exitCode}\r\n`)
    return file
  }
  const file = path.join(dir, name)
  await fs.writeFile(file, posix ?? `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 })
  return file
}
