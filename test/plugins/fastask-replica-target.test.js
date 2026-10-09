// @ts-check

// The replica's target is the default remote when it has a login (LLP 0480
// #replica). Null, which makes the sync loop delete every replica, only when
// there definitely is no login.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { remoteTokenEnvVar, writeSession, writeToken } from '../../src/core/remote/credentials.js'
import { createDefaultTargetResolver } from '../../hypaware-core/plugins-workspace/graph-cache/src/replica_target.js'

/**
 * @import { TestContext } from 'node:test'
 * @import { HypAwareV2Config } from '../../hypaware-plugin-kernel-types.js'
 */

const config = /** @type {HypAwareV2Config} */ (/** @type {unknown} */ ({
  query: { default_remote: 'team', remotes: { team: { url: 'https://hyp.example/v1/mcp' } } },
}))

/** @param {TestContext} t */
function tempState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastask-target-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('an oidc login on the default remote resolves with its org', async (t) => {
  const hypStateDir = tempState(t)
  await writeSession(hypStateDir, 'team', { refreshToken: 'r', accessJwt: 'jwt', expiresAt: '2099-01-01T00:00:00.000Z', org: 'acme' })
  const target = await createDefaultTargetResolver({ config, env: {}, hypStateDir })()
  assert.ok(target)
  assert.equal(target.target, 'team')
  assert.equal(target.url, 'https://hyp.example/v1/mcp')
  assert.equal(target.org, 'acme')
  const bearer = await target.token(false)
  assert.deepEqual(bearer.ok && bearer.token, 'jwt')
})

test('a static token resolves with no org; the manifest supplies it later', async (t) => {
  const hypStateDir = tempState(t)
  await writeToken(hypStateDir, 'team', 'static-token')
  const target = await createDefaultTargetResolver({ config, env: {}, hypStateDir })()
  assert.equal(target?.org, null)
})

test('an env override alone is a login', async (t) => {
  const hypStateDir = tempState(t)
  const target = await createDefaultTargetResolver({ config, env: { [remoteTokenEnvVar('team')]: 'env-token' }, hypStateDir })()
  assert.equal(target?.target, 'team')
  const bearer = await target?.token(false)
  assert.equal(bearer?.ok && bearer.token, 'env-token')
})

test('no login on the default remote resolves to null', async (t) => {
  const hypStateDir = tempState(t)
  await writeToken(hypStateDir, 'other', 'x')
  assert.equal(await createDefaultTargetResolver({ config, env: {}, hypStateDir })(), null)
})

test('a default remote with no registered URL resolves to null', async (t) => {
  const hypStateDir = tempState(t)
  const missing = /** @type {HypAwareV2Config} */ (/** @type {unknown} */ ({ query: { default_remote: 'nowhere' } }))
  assert.equal(await createDefaultTargetResolver({ config: missing, env: {}, hypStateDir })(), null)
})
