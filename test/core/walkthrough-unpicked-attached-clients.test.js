// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'

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
