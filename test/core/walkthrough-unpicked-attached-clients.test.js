// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { findAttachedNotConfiguredClients, runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { readObservabilityEnv } from '../../src/core/observability/env.js'

// Re-running the picker and unchecking a client the previous run attached
// leaves that client's settings pointing at the gateway while the regenerated
// config no longer collects it (issue #604). The finale cannot silently undo
// the attach, so it must at least name the stranded client and the detach
// command that clears it.

function makeBuf() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/** @param {string} prefix */
async function tmpEnv(prefix) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return { HOME: tmp, HYP_HOME: path.join(tmp, '.hyp') }
}

/**
 * Write the on-disk marker a previous run's `codex` attach left behind: the
 * managed block its `attach_probe` (`toml` / `[model_providers.hypaware]`)
 * reads back.
 *
 * @param {string} home
 */
async function writeCodexAttachMarker(home) {
  const dir = path.join(home, '.codex')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'config.toml'),
    [
      'model_provider = "hypaware"',
      '',
      '# BEGIN hypaware',
      '[model_providers.hypaware]',
      'name = "hypaware"',
      'base_url = "http://127.0.0.1:4319/openai/v1"',
      '# END hypaware',
      '',
    ].join('\n'),
    'utf8'
  )
}

/** Gateway capability stub with no adapters: the attach lane is not the subject. */
function gatewayCapability() {
  return /** @type {any} */ ({
    has: () => false,
    require: () => ({ getClient: () => undefined, localEndpoint: () => 'http://127.0.0.1:4319' }),
  })
}

test('the finale names a still-attached client the new config no longer collects', async () => {
  const env = await tmpEnv('hypaware-unpicked-attached-')
  await writeCodexAttachMarker(env.HOME)
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities: gatewayCapability(),
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 30 },
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.finale?.attachedNotConfigured, ['codex'])
  const out = stdout.text()
  assert.match(out, /codex/, out)
  assert.match(out, /hyp detach --client codex/, out)
})

test('a picked client that stays configured draws no stranded-attach warning', async () => {
  const env = await tmpEnv('hypaware-unpicked-attached-ok-')
  await writeCodexAttachMarker(env.HOME)
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities: gatewayCapability(),
    stdout,
    stderr,
    env,
    picks: { sources: ['codex'], exportChoice: 'keep-local', retentionDays: 30 },
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.finale?.attachedNotConfigured, [])
  assert.doesNotMatch(stdout.text(), /hyp detach --client/, stdout.text())
  assert.doesNotMatch(stderr.text(), /hyp detach --client/, stderr.text())
})

test('an unattached client the picker skipped is not warned about', async () => {
  const env = await tmpEnv('hypaware-unpicked-unattached-')
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities: gatewayCapability(),
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 30 },
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.finale?.attachedNotConfigured, [])
  assert.doesNotMatch(stdout.text(), /hyp detach --client/, stdout.text())
})

// The org lane is the reconciler's, forward and reverse: an adapter the central
// layer names is attached on its behalf, so the wizard's own picks must never
// be read as a reason to hand the operator a detach for it.
// @ref LLP 0185#scope [tests]: a centrally named adapter is never counted stranded by the local layer's picks
test('a client the central layer names is not stranded by an unpicking run', async () => {
  const env = await tmpEnv('hypaware-unpicked-central-')
  await writeCodexAttachMarker(env.HOME)
  const seedPath = centralSeedPath(readObservabilityEnv(env).stateDir)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(
    seedPath,
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/codex' }] }) + '\n',
    'utf8'
  )
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities: gatewayCapability(),
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 30 },
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.finale?.attachedNotConfigured, [])
  assert.doesNotMatch(stdout.text(), /hyp detach --client/, stdout.text())
})

// `hyp status` reads `enabled: false` as inactive when it builds the same set,
// and a switched-off entry collects exactly as little as an absent one. The two
// surfaces must not disagree about the same config.
test('a plugin entry left in the config with enabled false does not count as configured', async () => {
  const env = await tmpEnv('hypaware-unpicked-disabled-')
  await writeCodexAttachMarker(env.HOME)

  const stranded = await findAttachedNotConfiguredClients({
    clientsPicked: ['claude'],
    config: { version: 2, plugins: [{ name: '@hypaware/codex', enabled: false }] },
    env,
    homeDir: env.HOME,
  })

  assert.deepEqual(stranded, ['codex'])
})
