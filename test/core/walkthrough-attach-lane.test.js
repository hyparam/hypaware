// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'

// The finale attach lane over the real catalog derivation (LLP 0180). The
// derived `clientsPicked` includes Claude Desktop, whose plugin contributes a
// client for skill/agent ownership but deliberately registers no runtime
// adapter (LLP 0115#no-attach-on-join), so the lane must treat "no adapter
// registered" as not applicable rather than reporting a failure that is not
// real.

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
 * Gateway capability stub: `getClient` resolves from the given adapter map,
 * so a name absent from it behaves like a plugin that registered no adapter.
 *
 * @param {Record<string, { attach: (args: any) => Promise<void> }>} adapters
 */
function gatewayCapability(adapters) {
  return /** @type {any} */ ({
    has: (/** @type {string} */ name) => name === 'hypaware.ai-gateway',
    require: () => ({
      getClient: (/** @type {string} */ name) => adapters[name],
      localEndpoint: () => 'http://127.0.0.1:4317',
    }),
  })
}

// @ref LLP 0180#decision [tests]: an adapterless client contribution (Claude
// Desktop) is recorded as noAdapter, never printed as a failed attach
test('picking claude-desktop records a not-applicable attach, not a failure', async () => {
  const env = await tmpEnv('hypaware-attach-noadapter-')
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities: gatewayCapability({}),
    stdout,
    stderr,
    env,
    picks: { sources: ['claude-desktop'], exportChoice: 'keep-local', retentionDays: 30 },
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.clientsPicked, ['claude-desktop'])
  assert.deepEqual(result.finale?.attach, [
    { client: 'claude-desktop', dryRun: false, ok: true, noAdapter: true },
  ])
  // The run summary says nothing about a lane that was never applicable.
  assert.doesNotMatch(stdout.text(), /attach: claude-desktop/)
  assert.doesNotMatch(stderr.text(), /claude-desktop/)
})

test('a registered adapter that throws still reports a real attach failure', async () => {
  const env = await tmpEnv('hypaware-attach-failure-')
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities: gatewayCapability({
      claude: { attach: async () => { throw new Error('boom') } },
    }),
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 30 },
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.finale?.attach, [{ client: 'claude', dryRun: false, ok: false }])
  assert.match(stderr.text(), /attach claude failed: boom/)
  assert.match(stdout.text(), /attach: claude failed/)
})
