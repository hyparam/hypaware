// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { sha256Hex } from '../../src/core/util/json_util.js'

/**
 * `hyp status` names a central sink stopped by its kept service token, and
 * the remedy, without printing the record (LLP 0547 D3).
 */

const SECRET = `hsa_0123456789abcdef_${'A'.repeat(43)}`

/** @param {string} home */
function env(home) {
  return { ...process.env, HOME: home, HYP_HOME: home, HYP_CONFIG: '', CLAUDE_HOME: '' }
}

async function joined() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-svc-'))
  const sink = { write: () => true }
  /** @type {any} */
  const stdin = { isTTY: false, async *[Symbol.asyncIterator]() { yield SECRET } }
  const code = await dispatch(['join', 'https://central.example', '-', '--no-daemon'], { stdout: sink, stderr: sink, stdin, env: env(home) })
  assert.equal(code, 0)
  return { home, recordPath: path.join(home, 'hypaware', 'plugins', '@hypaware/central', 'service-token') }
}

/** @param {string} home */
async function stopped(home) {
  const report = await collectHypAwareStatus({ env: env(home) })
  return report.diagnostics.filter((d) => d.kind === 'central_service_token_stopped')
}

test('a live kept record raises nothing', async () => {
  const { home } = await joined()
  assert.deepEqual(await stopped(home), [])
})

test('a stored stop is named with its remedy', async () => {
  for (const [code, what] of [
    ['service_token_revoked', 'service token revoked'],
    ['service_account_disabled', 'service account disabled'],
  ]) {
    const { home, recordPath } = await joined()
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'))
    await fs.writeFile(recordPath, JSON.stringify({ ...record, stopped_code: code }))
    const found = await stopped(home)
    assert.equal(found.length, 1)
    assert.equal(found[0].severity, 'error')
    assert.match(found[0].message, new RegExp(`stopped: ${what}$`))
    assert.match(String(found[0].repair), /create a new token/)
    assert.ok(!JSON.stringify(found).includes(SECRET) && !JSON.stringify(found).includes(record.fingerprint))
  }
})

test('an unreadable record is a stop that names the file, not its contents', async () => {
  const { home, recordPath } = await joined()
  await fs.writeFile(recordPath, `{"secret":"${SECRET}"`)
  const found = await stopped(home)
  assert.equal(found.length, 1)
  assert.match(found[0].message, /stopped: service token file unreadable \(.*service-token\)/)
  assert.match(String(found[0].repair), /hyp join/)
  assert.ok(!JSON.stringify(found).includes(SECRET))
})

test('a stop for another credential or destination raises nothing; one for this identity does', async () => {
  const OTHER = `hsa_fedcba9876543210_${'B'.repeat(43)}`
  /**
   * @param {(ctx: { home: string, seedPath: string, identityPath: string }) => Promise<void>} change
   */
  const after = async (change) => {
    const { home, recordPath } = await joined()
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'))
    await fs.writeFile(recordPath, JSON.stringify({ ...record, stopped_code: 'service_token_revoked' }))
    const seedPath = path.join(home, 'hypaware', 'state', 'managed-config.seed.json')
    await change({ home, seedPath, identityPath: path.join(path.dirname(recordPath), 'identity.json') })
    return stopped(home)
  }
  /** @param {string} seedPath @param {(config: any) => void} edit */
  const editSink = async (seedPath, edit) => {
    const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'))
    edit(seed.sinks.central.config)
    await fs.writeFile(seedPath, JSON.stringify(seed))
  }
  /** @param {string} identityPath @param {Record<string, unknown>} fields */
  const writeIdentity = (identityPath, fields) => fs.writeFile(identityPath, JSON.stringify({ jwt: 'x.y.z', expires_at: 2_000_000_000, gateway_id: 'gw', central_url: 'https://central.example', ...fields }))

  assert.deepEqual(await after(({ seedPath }) => editSink(seedPath, (c) => { c.identity.bootstrap_token = OTHER })), [], 'different seed')
  assert.deepEqual(await after(({ seedPath }) => editSink(seedPath, (c) => { c.url = 'https://other.example' })), [], 'different destination')
  assert.deepEqual(await after(async ({ seedPath, identityPath }) => {
    await editSink(seedPath, (c) => { delete c.identity })
    await writeIdentity(identityPath, { origin: 'login' })
  }), [], 'login identity')
  const own = await after(async ({ seedPath, identityPath }) => {
    await editSink(seedPath, (c) => { delete c.identity })
    await writeIdentity(identityPath, { bootstrap_token_fp: sha256Hex(SECRET) })
  })
  assert.equal(own.length, 1, 'identity the record enrolled')
})
