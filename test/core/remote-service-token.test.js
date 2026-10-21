// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  hasServiceTokenPrefix,
  isServiceStopCode,
  isServiceTokenShape,
  keptServiceToken,
  readKeptServiceToken,
  retireKeptServiceToken,
  serviceTokenPath,
  writeKeptServiceToken,
} from '../../src/core/remote/service_token.js'
import { sha256Hex } from '../../src/core/util/json_util.js'

const SECRET = `hsa_0123456789abcdef_${'A'.repeat(43)}`

function tmpRecordPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-svc-token-'))
  return path.join(dir, 'central', 'service-token')
}

/** @param {string} code */
const fail = (code) => async () => { throw Object.assign(new Error(code), { code }) }

test('prefix routes, shape decides, and only the two permanent codes stop', () => {
  assert.equal(hasServiceTokenPrefix('hsa_x'), true)
  assert.equal(hasServiceTokenPrefix('ci-token'), false)
  assert.equal(hasServiceTokenPrefix(undefined), false)
  assert.equal(isServiceTokenShape(SECRET), true)
  assert.equal(isServiceTokenShape('hsa_x'), false)
  assert.equal(isServiceTokenShape(`hsa_0123456789ABCDEF_${'A'.repeat(43)}`), false)
  assert.equal(isServiceTokenShape(`${SECRET}A`), false)
  assert.equal(isServiceStopCode('service_token_revoked'), true)
  assert.equal(isServiceStopCode('service_account_disabled'), true)
  assert.equal(isServiceStopCode('bootstrap_token_invalid'), false)
  assert.equal(isServiceStopCode('forbidden'), false)
})

test('the record sits beside identity.json and follows a custom persisted_path', () => {
  assert.equal(serviceTokenPath('/h/state/central/identity.json'), '/h/state/central/service-token')
  assert.equal(serviceTokenPath('/elsewhere/gw/id.json'), '/elsewhere/gw/service-token')
})

test('a written record reads back, private from creation', async () => {
  const p = tmpRecordPath()
  const record = keptServiceToken({ secret: SECRET, centralUrl: 'https://c.example', now: 0 })
  assert.deepEqual(record, {
    version: 1,
    secret: SECRET,
    central_url: 'https://c.example',
    fingerprint: sha256Hex(SECRET),
    written_at: '1970-01-01T00:00:00.000Z',
  })
  assert.deepEqual(await writeKeptServiceToken(p, record), { outcome: 'written' })
  assert.equal(fs.statSync(p).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700)
  assert.deepEqual(await readKeptServiceToken(p), { state: 'ok', record })
  const stopped = { ...record, stopped_code: 'service_token_revoked' }
  await writeKeptServiceToken(p, stopped)
  assert.deepEqual(await readKeptServiceToken(p), { state: 'ok', record: stopped })
})

test('read states: absent, and each unreadable reason without the contents', async () => {
  const p = tmpRecordPath()
  assert.deepEqual(await readKeptServiceToken(p), { state: 'absent' })
  const good = keptServiceToken({ secret: SECRET, centralUrl: 'https://c.example' })
  /** @type {Array<[string, string]>} */
  const cases = [
    [`{"secret":"${SECRET}"`, 'bad_json'],
    ['[]', 'not_object'],
    [JSON.stringify({ ...good, version: 2 }), 'unknown_version'],
    [JSON.stringify({ ...good, secret: 'hsa_short' }), 'bad_shape'],
    [JSON.stringify({ ...good, central_url: '' }), 'missing_field'],
    [JSON.stringify({ ...good, written_at: undefined }), 'missing_field'],
    [JSON.stringify({ ...good, fingerprint: sha256Hex('other') }), 'fingerprint_mismatch'],
    [JSON.stringify({ ...good, stopped_code: 7 }), 'bad_field'],
  ]
  fs.mkdirSync(path.dirname(p), { recursive: true })
  for (const [body, reason] of cases) {
    fs.writeFileSync(p, body)
    const read = await readKeptServiceToken(p)
    assert.deepEqual(read, { state: 'unreadable', reason })
    assert.ok(!JSON.stringify(read).includes(SECRET))
  }
  fs.rmSync(p)
  fs.mkdirSync(p)
  assert.deepEqual(await readKeptServiceToken(p), { state: 'unreadable', reason: 'EISDIR' })
  assert.deepEqual(
    await readKeptServiceToken(p, { fs: /** @type {typeof fsp} */ ({ ...fsp, readFile: fail('EACCES') }) }),
    { state: 'unreadable', reason: 'EACCES' }
  )
})

test('a failed write is classified by reading the target back once', async () => {
  const record = keptServiceToken({ secret: SECRET, centralUrl: 'https://c.example' })

  // The rename never happened and nothing was there: not written.
  const none = tmpRecordPath()
  const noRename = /** @type {typeof fsp} */ ({ ...fsp, rename: fail('EIO') })
  assert.deepEqual(await writeKeptServiceToken(none, record, { fs: noRename }), { outcome: 'not_written', error: 'EIO' })
  assert.deepEqual(fs.readdirSync(path.dirname(none)), [])

  // The rename never happened over an older record: still not written.
  const older = tmpRecordPath()
  await writeKeptServiceToken(older, record)
  const stopped = { ...record, stopped_code: 'service_account_disabled' }
  assert.deepEqual(await writeKeptServiceToken(older, stopped, { fs: noRename }), { outcome: 'not_written', error: 'EIO' })

  // The rename happened, the directory sync failed: visible.
  const visible = tmpRecordPath()
  const noDirSync = /** @type {typeof fsp} */ ({
    ...fsp,
    open: async (/** @type {any} */ target, /** @type {any} */ flags, /** @type {any} */ mode) => {
      if (flags === 'r') throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return fsp.open(target, flags, mode)
    },
  })
  assert.deepEqual(await writeKeptServiceToken(visible, record, { fs: noDirSync }), { outcome: 'visible', error: 'EIO' })
  assert.deepEqual(await readKeptServiceToken(visible), { state: 'ok', record })

  // The write and the read-back both fail: unreadable.
  const blind = tmpRecordPath()
  const noRead = /** @type {typeof fsp} */ ({ ...fsp, rename: fail('EIO'), readFile: fail('EACCES') })
  assert.deepEqual(await writeKeptServiceToken(blind, record, { fs: noRead }), { outcome: 'unreadable', error: 'EIO' })
})

test('retire removes the record, treats a missing one as done, and throws any other error', async () => {
  const p = tmpRecordPath()
  await writeKeptServiceToken(p, keptServiceToken({ secret: SECRET, centralUrl: 'https://c.example' }))
  assert.equal(await retireKeptServiceToken(p), true)
  assert.equal(fs.existsSync(p), false)
  assert.equal(await retireKeptServiceToken(p), false)
  await assert.rejects(
    retireKeptServiceToken(p, { fs: /** @type {typeof fsp} */ ({ ...fsp, unlink: fail('EPERM') }) }),
    /EPERM/
  )
})
