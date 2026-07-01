// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  readCredentials,
  remoteCredentialsPath,
  remoteTokenEnvVar,
  removeToken,
  resolveToken,
  writeToken,
} from '../../src/core/remote/credentials.js'

async function tmpState() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-creds-'))
}

test('env var name is per-target and sanitized', () => {
  assert.equal(remoteTokenEnvVar('prod'), 'HYP_REMOTE_TOKEN_PROD')
  assert.equal(remoteTokenEnvVar('prod-eu'), 'HYP_REMOTE_TOKEN_PROD_EU')
  assert.equal(remoteTokenEnvVar('staging.1'), 'HYP_REMOTE_TOKEN_STAGING_1')
})

test('missing file reads as an empty map (not an error)', async () => {
  const dir = await tmpState()
  assert.deepEqual(await readCredentials(dir), {})
})

test('writeToken persists, is 0600, and round-trips', async () => {
  const dir = await tmpState()
  await writeToken(dir, 'prod', 'sk-1')
  const creds = await readCredentials(dir)
  assert.deepEqual(creds.prod, { kind: 'static', token: 'sk-1' })
  const st = await fs.stat(remoteCredentialsPath(dir))
  assert.equal(st.mode & 0o777, 0o600)
})

test('writeToken merges, removeToken drops only the named target', async () => {
  const dir = await tmpState()
  await writeToken(dir, 'prod', 'sk-1')
  await writeToken(dir, 'staging', 'sk-2')
  assert.equal(await removeToken(dir, 'prod'), true)
  assert.equal(await removeToken(dir, 'prod'), false) // already gone
  const creds = await readCredentials(dir)
  assert.equal(creds.prod, undefined)
  assert.deepEqual(creds.staging, { kind: 'static', token: 'sk-2' })
})

test('resolveToken order: env overrides file', async () => {
  const dir = await tmpState()
  await writeToken(dir, 'prod', 'file-token')
  const viaEnv = await resolveToken({ target: 'prod', env: { HYP_REMOTE_TOKEN_PROD: 'env-token' }, stateDir: dir })
  assert.deepEqual(viaEnv, { ok: true, token: 'env-token', source: 'env' })
  const viaFile = await resolveToken({ target: 'prod', env: {}, stateDir: dir })
  assert.deepEqual(viaFile, { ok: true, token: 'file-token', source: 'file' })
})

test('resolveToken errors with guidance when neither env nor file has a token', async () => {
  const dir = await tmpState()
  const r = await resolveToken({ target: 'prod', env: {}, stateDir: dir })
  assert.equal(r.ok, false)
  assert.match(/** @type {any} */ (r).error, /no token for 'prod' - run 'hyp remote login prod'/)
  assert.match(/** @type {any} */ (r).error, /HYP_REMOTE_TOKEN_PROD/)
})

test('a corrupt credentials file throws rather than silently masking', async () => {
  const dir = await tmpState()
  await fs.writeFile(remoteCredentialsPath(dir), '{not json')
  await assert.rejects(() => readCredentials(dir), /not valid JSON/)
})
