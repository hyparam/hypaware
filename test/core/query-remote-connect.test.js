// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { queryRemoteTargetPath, readRemoteTarget } from '../../src/core/query/remote-target.js'

function makeBuf() {
  let value = ''
  return { write(chunk) { value += String(chunk); return true }, text() { return value } }
}

/** @param {Record<string,string>} [extraEnv] */
async function makeOpts(extraEnv) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-remote-connect-'))
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '', ...extraEnv }
  return { hypHome, stdout, stderr, opts: { stdout, stderr, stdin: /** @type {any} */ ({ isTTY: true }), env } }
}

/** @param {string} hypHome */
const stateDir = (hypHome) => path.join(hypHome, 'hypaware')

test('connect --no-verify saves the URL and warns on plain http to a non-loopback host', async () => {
  const { hypHome, stdout, stderr, opts } = await makeOpts()
  const code = await dispatch(['query', 'connect', 'http://central.example:8740', '--no-verify'], opts)
  assert.equal(code, 0, stderr.text())
  assert.deepEqual(await readRemoteTarget(stateDir(hypHome)), { serverUrl: 'http://central.example:8740' })
  assert.match(stdout.text(), /saved http:\/\/central\.example:8740 as the query server \(unverified\)/)
  assert.match(stderr.text(), /sending the admin token over plain HTTP/)
})

test('connect --no-verify to loopback does not warn', async () => {
  const { stderr, opts } = await makeOpts()
  const code = await dispatch(['query', 'connect', 'http://127.0.0.1:8740', '--no-verify'], opts)
  assert.equal(code, 0)
  assert.doesNotMatch(stderr.text(), /plain HTTP/)
})

test('connect rejects a non-http(s) URL', async () => {
  const { stderr, opts } = await makeOpts()
  const code = await dispatch(['query', 'connect', 'ftp://nope', '--no-verify'], opts)
  assert.equal(code, 2)
  assert.match(stderr.text(), /url must be http\(s\)/)
})

test('disconnect clears the saved target and is idempotent', async () => {
  const { hypHome, opts } = await makeOpts()
  await dispatch(['query', 'connect', 'http://127.0.0.1:8740', '--no-verify'], opts)
  assert.ok(await readRemoteTarget(stateDir(hypHome)))

  const code = await dispatch(['query', 'disconnect'], opts)
  assert.equal(code, 0)
  assert.equal(await readRemoteTarget(stateDir(hypHome)), null)
  await assert.rejects(() => fs.stat(queryRemoteTargetPath(stateDir(hypHome))))

  const stdout2 = makeBuf()
  const code2 = await dispatch(['query', 'disconnect'], { ...opts, stdout: stdout2 })
  assert.equal(code2, 0)
  assert.match(stdout2.text(), /no saved query server/)
})

test('bare --server resolves the saved target; missing token fails fast', async () => {
  const { opts, stderr } = await makeOpts()
  // Save a target, then query it with bare --server and no token.
  await dispatch(['query', 'connect', 'http://127.0.0.1:8740', '--no-verify'], opts)
  delete opts.env.HYP_ADMIN_TOKEN
  const code = await dispatch(['query', 'sql', 'SELECT 1', '--server'], opts)
  assert.equal(code, 2, stderr.text())
  assert.match(stderr.text(), /HYP_ADMIN_TOKEN is not set/)
})

test('bare --server with no saved target errors', async () => {
  const { opts, stderr } = await makeOpts({ HYP_ADMIN_TOKEN: 'tok' })
  const code = await dispatch(['query', 'sql', 'SELECT 1', '--server'], opts)
  assert.equal(code, 2, stderr.text())
  assert.match(stderr.text(), /no saved server/)
})
