// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'

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
