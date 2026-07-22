// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  credentialFilePath,
  clearStoredCredential,
  readStoredCredential,
  tokenFingerprint,
  withCredentialLock,
  writeStoredCredential,
} from '../../hypaware-core/plugins-workspace/claude-account/src/store.js'

/** @import { SubscriptionOauthRecord } from '../../hypaware-core/plugins-workspace/claude-account/src/types.js' */

/** @returns {SubscriptionOauthRecord} */
function sampleRecord() {
  return {
    kind: 'subscription_oauth',
    access_token: 'sk-ant-oat01-test-access',
    refresh_token: 'sk-ant-ort01-test-refresh',
    expires_at: 2_000_000_000,
    obtained_at: 1_900_000_000,
    scopes: ['user:inference'],
  }
}

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-store-'))
}

test('read returns undefined when no credential is stored', () => {
  const filePath = credentialFilePath(tmpStateDir())
  assert.equal(readStoredCredential(filePath), undefined)
})

test('write / read round-trips and sets 0600', () => {
  const filePath = credentialFilePath(tmpStateDir())
  const record = sampleRecord()
  writeStoredCredential(filePath, record)
  assert.deepEqual(readStoredCredential(filePath), record)
  const mode = fs.statSync(filePath).mode & 0o777
  assert.equal(mode, 0o600)
})

test('read throws on corrupt JSON and on an unrecognized shape', () => {
  const filePath = credentialFilePath(tmpStateDir())
  fs.writeFileSync(filePath, 'not json')
  assert.throws(() => readStoredCredential(filePath), /not valid JSON/)
  fs.writeFileSync(filePath, JSON.stringify({ kind: 'mystery' }))
  assert.throws(() => readStoredCredential(filePath), /unrecognized shape/)
})

test('clear removes the file and tolerates absence', () => {
  const filePath = credentialFilePath(tmpStateDir())
  writeStoredCredential(filePath, sampleRecord())
  clearStoredCredential(filePath)
  assert.equal(fs.existsSync(filePath), false)
  clearStoredCredential(filePath)
})

test('tokenFingerprint never contains the token', () => {
  const fp = tokenFingerprint('sk-ant-oat01-super-secret')
  assert.equal(fp.length, 12)
  assert.ok(!fp.includes('secret'))
  assert.equal(fp, tokenFingerprint('sk-ant-oat01-super-secret'))
})

test('withCredentialLock serializes concurrent critical sections', async () => {
  const filePath = credentialFilePath(tmpStateDir())
  /** @type {string[]} */
  const events = []
  await Promise.all([
    withCredentialLock(filePath, async () => {
      events.push('a:in')
      await new Promise((resolve) => setTimeout(resolve, 100))
      events.push('a:out')
    }),
    withCredentialLock(filePath, async () => {
      events.push('b:in')
      await new Promise((resolve) => setTimeout(resolve, 10))
      events.push('b:out')
    }),
  ])
  const first = events[0].split(':')[0]
  assert.deepEqual(events.slice(0, 2), [`${first}:in`, `${first}:out`])
})

test('withCredentialLock breaks a stale lock', async () => {
  const filePath = credentialFilePath(tmpStateDir())
  const lockPath = `${filePath}.lock`
  fs.writeFileSync(lockPath, '')
  const old = Date.now() - 60_000
  fs.utimesSync(lockPath, old / 1000, old / 1000)
  const result = await withCredentialLock(filePath, async () => 'ran')
  assert.equal(result, 'ran')
  assert.equal(fs.existsSync(lockPath), false)
})
