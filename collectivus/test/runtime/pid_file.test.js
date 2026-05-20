import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { readPidFile, removePidFile, writePidFile } from '../../src/runtime/pid_file.js'

describe('writePidFile / removePidFile / readPidFile', () => {
  /** @type {string} */
  let dir
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collectivus-pid-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes the current PID and reads it back when the process is alive', async () => {
    const pidPath = path.join(dir, 'collectivus.pid')
    await writePidFile(pidPath)
    /** @type {(p: number) => boolean} */
    function probe(p) { return p === process.pid }
    const out = await readPidFile(pidPath, { probe })
    expect(out).toBe(process.pid)
  })

  it('creates intermediate directories on demand', async () => {
    const pidPath = path.join(dir, 'a', 'b', 'collectivus.pid')
    await writePidFile(pidPath)
    expect((await fs.stat(pidPath)).isFile()).toBe(true)
  })

  it('overwrites a stale PID file', async () => {
    const pidPath = path.join(dir, 'collectivus.pid')
    await fs.writeFile(pidPath, '999999\n', 'utf8')
    await writePidFile(pidPath)
    const out = await readPidFile(pidPath, { probe: () => true })
    expect(out).toBe(process.pid)
  })

  it('returns undefined for a missing PID file', async () => {
    const pidPath = path.join(dir, 'missing.pid')
    const out = await readPidFile(pidPath)
    expect(out).toBeUndefined()
  })

  it('returns undefined when the file content is not a positive integer', async () => {
    const pidPath = path.join(dir, 'bad.pid')
    await fs.writeFile(pidPath, 'not-a-pid\n', 'utf8')
    const out = await readPidFile(pidPath, { probe: () => true })
    expect(out).toBeUndefined()
  })

  it('returns undefined when the probe says the process is dead', async () => {
    const pidPath = path.join(dir, 'collectivus.pid')
    await writePidFile(pidPath)
    const out = await readPidFile(pidPath, { probe: () => false })
    expect(out).toBeUndefined()
  })

  it('removePidFile is a no-op for a missing path', async () => {
    await removePidFile(path.join(dir, 'never-existed.pid'))
  })

  it('removePidFile unlinks the file', async () => {
    const pidPath = path.join(dir, 'collectivus.pid')
    await writePidFile(pidPath)
    await removePidFile(pidPath)
    /** @type {Awaited<ReturnType<typeof fs.stat>> | undefined} */
    let stats
    try {
      stats = await fs.stat(pidPath)
    } catch (err) {
      if (err && typeof err === 'object' && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        stats = undefined
      } else {
        throw err
      }
    }
    expect(stats).toBeUndefined()
  })
})
