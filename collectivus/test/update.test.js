import { describe, expect, it } from 'vitest'
import { canSelfUpdate, fetchLatestVersion, isSupervised, runNpmInstall, selfUpdate } from '../src/update.js'

/**
 * Minimal stdout/stderr collector.
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

describe('canSelfUpdate', () => {
  it('returns true for a globally-installed bin path', () => {
    expect(canSelfUpdate('/usr/local/lib/node_modules/collectivus/bin/cli.js')).toBe(true)
    expect(canSelfUpdate('/opt/homebrew/lib/node_modules/collectivus/bin/cli.js')).toBe(true)
    expect(canSelfUpdate('/Users/x/.nvm/versions/node/v20.0.0/lib/node_modules/collectivus/bin/cli.js')).toBe(true)
  })

  it('returns false for a source checkout', () => {
    expect(canSelfUpdate('/Users/dev/code/collectivus/bin/cli.js')).toBe(false)
    expect(canSelfUpdate('/home/dev/projects/collectivus/bin/cli.js')).toBe(false)
  })

  it('returns false for npx-resolved paths', () => {
    expect(canSelfUpdate('/Users/x/.npm/_npx/abc123/node_modules/collectivus/bin/cli.js')).toBe(false)
  })

  it('returns false for empty / non-string input', () => {
    expect(canSelfUpdate('')).toBe(false)
    expect(canSelfUpdate(/** @type {*} */ (undefined))).toBe(false)
    expect(canSelfUpdate(/** @type {*} */ (null))).toBe(false)
  })
})

describe('fetchLatestVersion', () => {
  /**
   * @param {{ ok: boolean, body: unknown }} response
   * @returns {typeof fetch}
   */
  function stubFetch(response) {
    function fakeFetch() {
      return Promise.resolve(/** @type {Response} */ (/** @type {unknown} */ ({
        ok: response.ok,
        json() { return Promise.resolve(response.body) },
      })))
    }
    return /** @type {typeof fetch} */ (/** @type {unknown} */ (fakeFetch))
  }

  it('returns the version field from a 200 response', async () => {
    const fetchFn = stubFetch({ ok: true, body: { version: '9.9.9', other: 'stuff' } })
    expect(await fetchLatestVersion({ fetchFn })).toBe('9.9.9')
  })

  it('returns undefined on non-200', async () => {
    const fetchFn = stubFetch({ ok: false, body: { version: '9.9.9' } })
    expect(await fetchLatestVersion({ fetchFn })).toBeUndefined()
  })

  it('returns undefined when payload has no version', async () => {
    const fetchFn = stubFetch({ ok: true, body: {} })
    expect(await fetchLatestVersion({ fetchFn })).toBeUndefined()
  })

  it('returns undefined on fetch rejection (network/abort)', async () => {
    function failingFetch() { return Promise.reject(new Error('network down')) }
    const fetchFn = /** @type {typeof fetch} */ (/** @type {unknown} */ (failingFetch))
    expect(await fetchLatestVersion({ fetchFn })).toBeUndefined()
  })
})

describe('runNpmInstall', () => {
  it('returns true on exit code 0', async () => {
    /** @type {string[]} */
    let receivedArgs = []
    const ok = await runNpmInstall('1.2.3', {
      run: (_command, args) => {
        receivedArgs = args
        return Promise.resolve(0)
      },
    })
    expect(ok).toBe(true)
    expect(receivedArgs).toEqual(['install', '-g', 'collectivus@1.2.3'])
  })

  it('returns false on non-zero exit', async () => {
    expect(await runNpmInstall('1.2.3', { run: () => Promise.resolve(1) })).toBe(false)
  })

  it('returns false when the spawn rejects', async () => {
    expect(await runNpmInstall('1.2.3', { run: () => Promise.reject(new Error('npm not found')) })).toBe(false)
  })
})

describe('selfUpdate', () => {
  const installedBinPath = '/usr/local/lib/node_modules/collectivus/bin/cli.js'

  it('returns undefined when bin path is not safe to replace', async () => {
    let installCalls = 0
    const log = memo()
    const result = await selfUpdate({
      binPath: '/Users/dev/code/collectivus/bin/cli.js',
      readVersion: () => '1.0.0',
      fetchLatest: () => Promise.resolve('2.0.0'),
      install: () => { installCalls++; return Promise.resolve(true) },
      log,
    })
    expect(result).toBeUndefined()
    expect(installCalls).toBe(0)
    expect(log.value()).toBe('')
  })

  it('returns undefined when registry returns no version', async () => {
    let installCalls = 0
    const result = await selfUpdate({
      binPath: installedBinPath,
      readVersion: () => '1.0.0',
      fetchLatest: () => Promise.resolve(undefined),
      install: () => { installCalls++; return Promise.resolve(true) },
      log: memo(),
    })
    expect(result).toBeUndefined()
    expect(installCalls).toBe(0)
  })

  it('returns undefined when already at latest', async () => {
    let installCalls = 0
    const result = await selfUpdate({
      binPath: installedBinPath,
      readVersion: () => '1.2.3',
      fetchLatest: () => Promise.resolve('1.2.3'),
      install: () => { installCalls++; return Promise.resolve(true) },
      log: memo(),
    })
    expect(result).toBeUndefined()
    expect(installCalls).toBe(0)
  })

  it('installs and returns the new version when newer', async () => {
    /** @type {string[]} */
    const installedVersions = []
    const log = memo()
    const result = await selfUpdate({
      binPath: installedBinPath,
      readVersion: () => '1.0.0',
      fetchLatest: () => Promise.resolve('2.0.0'),
      install: (v) => { installedVersions.push(v); return Promise.resolve(true) },
      log,
    })
    expect(result).toBe('2.0.0')
    expect(installedVersions).toEqual(['2.0.0'])
    expect(log.value()).toMatch(/update available: 1\.0\.0 -> 2\.0\.0/)
    expect(log.value()).toMatch(/installed 2\.0\.0/)
  })

  it('returns undefined and logs failure when the install fails', async () => {
    const log = memo()
    const result = await selfUpdate({
      binPath: installedBinPath,
      readVersion: () => '1.0.0',
      fetchLatest: () => Promise.resolve('2.0.0'),
      install: () => Promise.resolve(false),
      log,
    })
    expect(result).toBeUndefined()
    expect(log.value()).toMatch(/self-update to 2\.0\.0 failed; staying on 1\.0\.0/)
  })

  it('swallows a throwing readVersion and returns undefined', async () => {
    const log = memo()
    let installCalls = 0
    const result = await selfUpdate({
      binPath: installedBinPath,
      readVersion: () => { throw new Error('boom') },
      fetchLatest: () => Promise.resolve('2.0.0'),
      install: () => { installCalls++; return Promise.resolve(true) },
      log,
    })
    expect(result).toBeUndefined()
    expect(installCalls).toBe(0)
  })

  it('swallows a throwing fetchLatest and returns undefined', async () => {
    const result = await selfUpdate({
      binPath: installedBinPath,
      readVersion: () => '1.0.0',
      fetchLatest: () => Promise.reject(new Error('network exploded')),
      install: () => Promise.resolve(true),
      log: memo(),
    })
    expect(result).toBeUndefined()
  })
})

describe('isSupervised', () => {
  it('returns true when COLLECTIVUS_SUPERVISED=1', () => {
    expect(isSupervised({ COLLECTIVUS_SUPERVISED: '1' })).toBe(true)
  })

  it('returns true under launchd (XPC_SERVICE_NAME set)', () => {
    expect(isSupervised({ XPC_SERVICE_NAME: 'com.collectivus.daemon' })).toBe(true)
  })

  it('returns true under systemd (INVOCATION_ID set)', () => {
    expect(isSupervised({ INVOCATION_ID: 'abc123' })).toBe(true)
  })

  it('returns false in a plain shell', () => {
    expect(isSupervised({})).toBe(false)
    expect(isSupervised({ COLLECTIVUS_SUPERVISED: '0', XPC_SERVICE_NAME: '', INVOCATION_ID: '' })).toBe(false)
  })
})
