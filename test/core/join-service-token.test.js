// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { readKeptServiceToken } from '../../src/core/remote/service_token.js'

/**
 * `hyp join` with an org service secret keeps it beside the central sink's
 * identity (LLP 0547 D2); any other join, and `hyp leave`, retire it.
 */

const SECRET = `hsa_0123456789abcdef_${'A'.repeat(43)}`
const URL = 'https://central.example'

function makeBuf() {
  let value = ''
  return {
    write(/** @type {unknown} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-join-svc-test-'))
  const stateRoot = path.join(home, 'hypaware')
  const centralDir = path.join(stateRoot, 'plugins', '@hypaware/central')
  return { home, stateRoot, centralDir, recordPath: path.join(centralDir, 'service-token') }
}

/**
 * @param {string} home
 * @param {string[]} argv
 * @param {string} [stdinText]
 */
async function run(home, argv, stdinText) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {any} */
  const stdin = stdinText === undefined
    ? { isTTY: true }
    : { isTTY: false, async *[Symbol.asyncIterator]() { yield stdinText } }
  const env = { ...process.env, HOME: home, HYP_HOME: home, HYP_CONFIG: '', CLAUDE_HOME: '' }
  const code = await dispatch(argv, { stdout, stderr, stdin, env })
  return { code, out: stdout.text(), err: stderr.text() }
}

/** @param {string} p */
async function exists(p) {
  return fs.stat(p).then(() => true, () => false)
}

test('a service join keeps the secret beside identity.json, private, and never prints it', async () => {
  const { home, stateRoot, centralDir, recordPath } = await makeHome()
  const r = await run(home, ['join', URL, '-', '--no-daemon'], `${SECRET}\n`)
  assert.equal(r.code, 0, r.err)
  assert.ok(!r.out.includes(SECRET) && !r.err.includes(SECRET))

  const read = await readKeptServiceToken(recordPath)
  assert.equal(read.state, 'ok')
  assert.equal(read.state === 'ok' && read.record.secret, SECRET)
  assert.equal(read.state === 'ok' && read.record.central_url, URL)
  assert.equal(read.state === 'ok' && read.record.stopped_code, undefined)
  assert.equal((await fs.stat(recordPath)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(centralDir)).mode & 0o777, 0o700)
  await fs.stat(centralSeedPath(stateRoot))
})

test('a service join from --token-file keeps the same record', async () => {
  const { home, recordPath } = await makeHome()
  const tokenFile = path.join(home, 'token')
  await fs.writeFile(tokenFile, `${SECRET}\n`, { mode: 0o600 })
  const r = await run(home, ['join', URL, '--token-file', tokenFile, '--no-daemon'])
  assert.equal(r.code, 0, r.err)
  assert.equal((await readKeptServiceToken(recordPath)).state, 'ok')
})

test('a re-join clears a stored stop', async () => {
  const { home, recordPath } = await makeHome()
  assert.equal((await run(home, ['join', URL, '-', '--no-daemon'], SECRET)).code, 0)
  const read = await readKeptServiceToken(recordPath)
  assert.equal(read.state, 'ok')
  if (read.state !== 'ok') return
  await fs.writeFile(recordPath, JSON.stringify({ ...read.record, stopped_code: 'service_token_revoked' }))
  assert.equal((await run(home, ['join', URL, '-', '--no-daemon'], SECRET)).code, 0)
  const after = await readKeptServiceToken(recordPath)
  assert.equal(after.state === 'ok' && after.record.stopped_code, undefined)
})

test('a token with the prefix but not the shape is refused locally and writes nothing', async () => {
  const { home, stateRoot, recordPath } = await makeHome()
  const r = await run(home, ['join', URL, '-', '--no-daemon'], 'hsa_0123456789abcdef_clipped')
  assert.equal(r.code, 2)
  assert.match(r.err, /starts with 'hsa_' but is not a whole service token/)
  assert.ok(!r.err.includes('clipped'))
  assert.equal(await exists(recordPath), false)
  assert.equal(await exists(centralSeedPath(stateRoot)), false)
})

test('an ordinary join retires a kept record, and so does leave', async () => {
  const { home, recordPath } = await makeHome()
  assert.equal((await run(home, ['join', URL, '-', '--no-daemon'], SECRET)).code, 0)
  assert.equal(await exists(recordPath), true)
  const ordinary = await run(home, ['join', URL, 'policy-token-1', '--no-daemon'])
  assert.equal(ordinary.code, 0, ordinary.err)
  assert.equal(await exists(recordPath), false)

  assert.equal((await run(home, ['join', URL, '-', '--no-daemon'], SECRET)).code, 0)
  const leave = await run(home, ['leave'])
  assert.equal(leave.code, 0, leave.err)
  assert.equal(await exists(recordPath), false)
})

test('a record that cannot be retired stops the join before the seed changes', async () => {
  const { home, stateRoot, recordPath } = await makeHome()
  assert.equal((await run(home, ['join', URL, '-', '--no-daemon'], SECRET)).code, 0)
  const seedBefore = await fs.readFile(centralSeedPath(stateRoot), 'utf8')
  // A non-empty directory where the record sits: unlink fails with something
  // other than ENOENT.
  await fs.rm(recordPath)
  await fs.mkdir(path.join(recordPath, 'x'), { recursive: true })
  const r = await run(home, ['join', URL, 'policy-token-1', '--no-daemon'])
  assert.equal(r.code, 1)
  assert.match(r.err, /could not remove the kept service token/)
  assert.equal(await fs.readFile(centralSeedPath(stateRoot), 'utf8'), seedBefore)
})

test('a record that cannot be written stops the join before the seed is written', { skip: process.getuid?.() === 0 && 'root ignores directory modes' }, async () => {
  const { home, stateRoot, centralDir } = await makeHome()
  await fs.mkdir(centralDir, { recursive: true })
  await fs.chmod(centralDir, 0o500)
  try {
    const r = await run(home, ['join', URL, '-', '--no-daemon'], SECRET)
    assert.equal(r.code, 1)
    assert.match(r.err, /could not keep the service token/)
    assert.ok(!r.err.includes(SECRET))
    assert.equal(await exists(centralSeedPath(stateRoot)), false)
  } finally {
    await fs.chmod(centralDir, 0o700)
  }
})
