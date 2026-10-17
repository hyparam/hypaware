// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { runInitWizard } from '../../src/core/cli/wizard/index.js'

// Setup on a platform with no service manager used to sign in, enroll and
// write config, and only then have the daemon installer refuse (#975). Every
// setup form now refuses at dispatch, before the boot and the first network
// call, while help, status and query keep working on that machine.

function makeBuf(isTTY = false) {
  let value = ''
  return {
    isTTY,
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A stdin already at end of input, so a regressed interactive form reads EOF
 * and fails the assertions below instead of waiting on a prompt.
 * @param {boolean} isTTY
 */
function closedStdin(isTTY) {
  return /** @type {any} */ (Object.assign(Readable.from([]), { isTTY }))
}

/** A temp HOME holding HYP_HOME at `.hyp`, plus a `--from-file` input outside it. */
async function makeHome() {
  const home = await temporaryDirectory('hyp-setup-platform-')
  const hypHome = path.join(home, '.hyp')
  const fromFile = path.join(await temporaryDirectory('hyp-setup-platform-input-'), 'incoming.json')
  await fs.writeFile(fromFile, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/otel' }] }) + '\n')
  return { home, hypHome, fromFile, env: { ...process.env, HOME: home, HYP_HOME: hypHome, HYP_CONFIG: '' } }
}

/**
 * Every file under `dir` with its bytes.
 * @param {string} dir
 * @returns {Promise<Map<string, string>>}
 */
async function snapshot(dir) {
  /** @type {Map<string, string>} */
  const files = new Map()
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath, entry.name)
    files.set(path.relative(dir, full), await fs.readFile(full, 'utf8'))
  }
  return files
}

/**
 * Run `fn` as if on `platform`, with every `fetch` recorded and refused.
 * @template T
 * @param {NodeJS.Platform} platform
 * @param {(fetches: string[]) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function onPlatform(platform, fn) {
  const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(process, 'platform'))
  const realFetch = globalThis.fetch
  /** @type {string[]} */
  const fetches = []
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  globalThis.fetch = /** @type {typeof fetch} */ (async (input) => {
    fetches.push(String(input))
    throw new Error('network refused by test')
  })
  try {
    return await fn(fetches)
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    globalThis.fetch = realFetch
  }
}

/** @param {string} fromFile @returns {Array<[string, string[], boolean]>} */
function setupForms(fromFile) {
  return [
    // Scripted forms first: a regressed interactive form waits on a sign-in
    // redirect rather than returning, so these fail fast with a message.
    ['scripted --source', ['setup', '--yes', '--source', 'codex'], false],
    ['dry run', ['setup', '--yes', '--dry-run', '--source', 'codex'], false],
    ['JSON config --from-file', ['setup', '--yes', '--from-file', fromFile], false],
    ['preset', ['setup', 'local'], false],
    ['non-TTY setup guide', ['setup'], false],
    ['interactive walkthrough (bare hyp on a TTY)', [], true],
    ['interactive setup', ['setup'], true],
    ['init alias', ['init'], true],
  ]
}

test('every setup form refuses an unsupported platform before any sign-in, enrollment or write', { timeout: 60_000 }, async () => {
  const { fromFile } = await makeHome()
  for (const [label, argv, tty] of setupForms(fromFile)) {
    const { home, env } = await makeHome()
    const stdout = makeBuf(tty)
    const stderr = makeBuf()
    const before = await snapshot(home)
    const { code, fetches } = await onPlatform('win32', async (fetches) => ({
      code: await dispatch(argv, { stdout, stderr, stdin: closedStdin(tty), env }),
      fetches,
    }))
    assert.equal(code, 1, `${label}: exit`)
    assert.match(stderr.text(), /hyp setup: unsupported platform: win32 \(only macOS and Linux are supported\)/, `${label}: message`)
    assert.deepEqual(fetches, [], `${label}: no network call`)
    assert.deepEqual(await snapshot(home), before, `${label}: no file written under HOME`)
    assert.equal(stdout.text(), '', `${label}: no wizard or guide output`)
  }
})

test('a direct runInitWizard call refuses an unsupported platform before any lane runs', async () => {
  /** @type {Array<[string, object | undefined, string | undefined]>} */
  const cases = [
    ['interactive, platform option', undefined, 'win32'],
    ['scripted picks, platform option', { sources: ['codex'] }, 'win32'],
    ['interactive, process.platform', undefined, undefined],
  ]
  for (const [label, picks, platform] of cases) {
    const { home, hypHome, env } = await makeHome()
    const stdout = makeBuf()
    const stderr = makeBuf()
    /** @type {string[]} */
    const calls = []
    /** @param {string} name */
    const seam = (name) => async () => { calls.push(name); throw new Error(`${name} ran`) }
    const before = await snapshot(home)
    const result = await onPlatform('win32', () => runInitWizard(/** @type {any} */ ({
      stdout, stderr, env, ...(platform ? { platform } : {}), ...(picks ? { picks } : {}),
      gate: seam('gate'), fork: seam('fork'), express: seam('express'), pick: seam('pick'),
      configure: seam('configure'), finaleRunner: seam('finale'),
      finale: { configPath: path.join(hypHome, 'hypaware-config.json') },
    })))
    assert.deepEqual(result, { exitCode: 1 }, `${label}: result`)
    assert.deepEqual(calls, [], `${label}: no lane ran`)
    assert.match(stderr.text(), /hyp setup: unsupported platform: win32 \(only macOS and Linux are supported\)/, `${label}: message`)
    assert.deepEqual(await snapshot(home), before, `${label}: no file written under HOME`)
    assert.equal(stdout.text(), '', `${label}: no output`)
  }
})

test('help, status and query still run on an unsupported platform', async () => {
  const { env } = await makeHome()
  await onPlatform('win32', async () => {
    for (const argv of [['--help'], ['setup', '--help'], ['init', '--yes', '--help'], ['status'], ['query', '--help']]) {
      const stdout = makeBuf()
      const stderr = makeBuf()
      const code = await dispatch(argv, { stdout, stderr, env })
      assert.doesNotMatch(stderr.text(), /unsupported platform/, `${argv.join(' ')}: not refused`)
      assert.notEqual(stdout.text(), '', `${argv.join(' ')}: ran and printed`)
      if (argv.includes('--help')) assert.equal(code, 0, `${argv.join(' ')}: exit`)
    }
  })
})

test('a supported platform is not refused', async () => {
  for (const platform of /** @type {NodeJS.Platform[]} */ (['linux', 'darwin'])) {
    const { env } = await makeHome()
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await onPlatform(platform, () =>
      dispatch(['setup', '--yes', '--dry-run', '--no-daemon', '--source', 'codex'], { stdout, stderr, env })
    )
    assert.doesNotMatch(stderr.text(), /unsupported platform/, platform)
    assert.equal(code, 0, `${platform}: ${stderr.text()}`)
  }
})
