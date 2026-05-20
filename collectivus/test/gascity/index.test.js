import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startGascitySource } from '../../src/gascity/index.js'

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memoStream() {
  let buf = ''
  return { write: (s) => { buf += s }, value: () => buf }
}

describe('startGascitySource', () => {
  /** @type {string} */
  let sinkRoot
  beforeEach(async () => {
    sinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-source-'))
  })
  afterEach(async () => {
    await fs.rm(sinkRoot, { recursive: true, force: true })
  })

  it('returns a no-op listener when no cities are configured', async () => {
    const stderr = memoStream()
    const listener = await startGascitySource({ cities: [], sinkRoot, stderr })
    expect(listener.description).toBe('Gascity source: no cities attached')
    await listener.stop()
    expect(stderr.value()).toBe('')
  })

  it('describes attached cities and stops them cleanly', async () => {
    const stderr = memoStream()
    const sleep = vi.fn().mockImplementation(() => new Promise(() => {}))
    const fetchFn = vi.fn().mockImplementation((/** @type {string} */ _url, /** @type {{ signal: AbortSignal }} */ opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const listener = await startGascitySource({
      cities: [
        { name: 'hyptown', api_url: 'http://127.0.0.1:8372' },
        { name: 'staging', api_url: 'http://127.0.0.1:8373' },
      ],
      sinkRoot,
      stderr,
      fetchFn,
      sleep,
    })
    expect(listener.description).toMatch(/Gascity source attached to 2 cities \(hyptown, staging\)/)
    await listener.stop()
  })

  it('uses the singular form when exactly one city is attached', async () => {
    const fetchFn = vi.fn().mockImplementation((_url, /** @type {{ signal: AbortSignal }} */ opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const listener = await startGascitySource({
      cities: [{ name: 'hyptown', api_url: 'http://127.0.0.1:8372' }],
      sinkRoot,
      stderr: memoStream(),
      fetchFn,
      sleep: () => new Promise(() => {}),
    })
    expect(listener.description).toMatch(/Gascity source attached to 1 city \(hyptown\)/)
    await listener.stop()
  })
})
