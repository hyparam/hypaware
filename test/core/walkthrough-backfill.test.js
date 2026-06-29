// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPickerWalkthrough, WALKTHROUGH_CANCEL_EXIT_CODE } from '../../src/core/cli/walkthrough.js'
import { PromptCancelledError } from '../../src/core/cli/tui/runtime.js'

/** @import { BackfillFinaleResult } from '../../src/core/cli/types.d.ts' */

/**
 * Fake picker backfill runner. Records every `run` call and returns a
 * configurable per-provider finale entry, so the tests can assert both
 * the inputs the finale passed and the summary it collected.
 *
 * @param {string[]} available
 * @param {Record<string, BackfillFinaleResult>} [entries]
 */
function makeBackfill(available, entries = {}) {
  /** @type {Array<{ provider: string, dryRun: boolean, retentionDays: number, until: string }>} */
  const calls = []
  return {
    available,
    calls,
    /** @param {{ provider: string, dryRun: boolean, retentionDays: number, until: string }} args */
    async run(args) {
      calls.push(args)
      return (
        entries[args.provider] ?? {
          provider: args.provider,
          dryRun: args.dryRun,
          ok: true,
          scanned: 0,
          rowsWritten: 0,
          skipped: 0,
        }
      )
    },
  }
}

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

/** Capabilities stub: never has the gateway, so attach is skipped. */
const noGateway = /** @type {any} */ ({ has: () => false })

/** @param {string} prefix */
async function tmpEnv(prefix) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return { HOME: tmp, HYP_HOME: path.join(tmp, '.hyp') }
}

test('onboarding with claude selected runs the backfill step and records stats', async () => {
  const env = await tmpEnv('hypaware-bf-claude-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude'], {
    claude: { provider: 'claude', dryRun: false, ok: true, scanned: 3, rowsWritten: 5, skipped: 1 },
  })

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 14 },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  // The finale invoked the runner exactly once, for the claude provider,
  // bounded by the selected retention window and a valid ISO cutoff.
  assert.equal(backfill.calls.length, 1)
  assert.equal(backfill.calls[0].provider, 'claude')
  assert.equal(backfill.calls[0].dryRun, false)
  assert.equal(backfill.calls[0].retentionDays, 14)
  assert.ok(
    typeof backfill.calls[0].until === 'string' && !Number.isNaN(Date.parse(backfill.calls[0].until)),
    'until must be a valid ISO timestamp (the attach/start cutoff)'
  )
  // Finale summary carries the per-provider backfill stats.
  assert.deepEqual(result.finale?.backfill, [
    { provider: 'claude', dryRun: false, ok: true, scanned: 3, rowsWritten: 5, skipped: 1 },
  ])
  assert.match(stdout.text(), /backfill claude: ok \(scanned 3, wrote 5, skipped 1\)/)
})

test('--dry-run onboarding includes the backfill plan but writes nothing', async () => {
  const env = await tmpEnv('hypaware-bf-dry-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude'], {
    claude: { provider: 'claude', dryRun: true, ok: true, scanned: 2, rowsWritten: 0, skipped: 0 },
  })

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 30 },
    backfill,
    finale: { skipDaemon: true, dryRun: true },
  })

  assert.equal(result.exitCode, 0)
  // Dry-run propagates to the runner; the contract is scan-only (zero rows).
  assert.equal(backfill.calls.length, 1)
  assert.equal(backfill.calls[0].dryRun, true)
  assert.equal(result.finale?.backfill[0].dryRun, true)
  assert.equal(result.finale?.backfill[0].rowsWritten, 0)
  assert.match(stdout.text(), /\(dry-run\) backfill claude:/)
})

test('--yes mode runs bounded backfill automatically without a consent prompt', async () => {
  const env = await tmpEnv('hypaware-bf-yes-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude'])
  let consentAsked = false

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 7 },
    backfill,
    // Supplied but must NOT be consulted in non-interactive mode.
    backfillConsentPrompt: async () => {
      consentAsked = true
      return false
    },
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.equal(consentAsked, false, 'non-interactive (--yes) must not prompt for consent')
  assert.equal(backfill.calls.length, 1)
  assert.equal(backfill.calls[0].retentionDays, 7, 'backfill is bounded by the retention window')
})

test('--no-daemon still backfills - it is a local file import', async () => {
  const env = await tmpEnv('hypaware-bf-nodaemon-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude'])

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 30 },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.equal(backfill.calls.length, 1)
  assert.equal(result.finale?.daemonInstall.skipped, true)
})

test('interactive onboarding defaults backfill to enabled (consent yes runs it)', async () => {
  const env = await tmpEnv('hypaware-bf-interactive-yes-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude'])
  /** @type {Array<{ providers: string[], retentionDays: number }>} */
  const consentCalls = []

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    // No `picks` ⇒ interactive: prompts are driven by injected resolvers.
    prompt: async (q) => (q.pickType === 'sources' ? ['claude'] : ['keep-local']),
    retentionPrompt: async () => 30,
    backfillConsentPrompt: async (args) => {
      consentCalls.push(args)
      return true
    },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.clientsPicked, ['claude'])
  assert.equal(consentCalls.length, 1, 'interactive mode prompts for backfill consent')
  assert.deepEqual(consentCalls[0].providers, ['claude'])
  assert.equal(backfill.calls.length, 1)
})

test('interactive onboarding lets the user decline backfill', async () => {
  const env = await tmpEnv('hypaware-bf-interactive-no-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude'])

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    prompt: async (q) => (q.pickType === 'sources' ? ['claude'] : ['keep-local']),
    retentionPrompt: async () => 30,
    backfillConsentPrompt: async () => false,
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.equal(backfill.calls.length, 0, 'declining must skip the backfill run')
  assert.deepEqual(result.finale?.backfill, [])
  assert.match(stdout.text(), /backfill: skipped \(declined\)/)
})

test('interactive onboarding maps cancelled backfill consent to the cancel exit path', async () => {
  const env = await tmpEnv('hypaware-bf-interactive-cancel-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude'])

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    prompt: async (q) => (q.pickType === 'sources' ? ['claude'] : ['keep-local']),
    retentionPrompt: async () => 30,
    backfillConsentPrompt: async () => {
      throw new PromptCancelledError()
    },
    backfill,
    finale: { dryRun: true },
  })

  assert.equal(result.exitCode, WALKTHROUGH_CANCEL_EXIT_CODE)
  assert.deepEqual(result.sourcesPicked, ['claude'])
  assert.deepEqual(result.clientsPicked, ['claude'])
  assert.equal(result.retentionDays, 30)
  assert.equal(backfill.calls.length, 0, 'cancelling consent must skip the backfill run')
  assert.equal(result.finale?.cancelled, true)
  assert.deepEqual(result.finale?.backfill, [])
  assert.deepEqual(result.finale?.daemonRestart, { skipped: false, dryRun: true, ok: true })
  assert.match(stderr.text(), /hyp init: cancelled/)
  assert.match(stdout.text(), /backfill: skipped \(cancelled\)/)
  assert.match(stdout.text(), /\(dry-run\) Would restart the daemon/)
})

test('picked clients without a registered backfill provider are skipped', async () => {
  const env = await tmpEnv('hypaware-bf-noprovider-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  // The injected runner advertises only `claude`, so a codex pick has no
  // matching provider: the finale intersects picks with the runner's
  // `available` set and skips the rest. (In production both claude and
  // codex are registered. See the all-available boot test in
  // boot-installed.test.js. This exercises the empty-intersection path.)
  const backfill = makeBackfill(['claude'])

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['codex'], exportChoice: 'keep-local', retentionDays: 30 },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.clientsPicked, ['codex'])
  assert.equal(backfill.calls.length, 0, 'no provider for codex ⇒ no backfill run')
  assert.deepEqual(result.finale?.backfill, [])
})

test('a throwing backfill runner is caught and recorded as failed', async () => {
  const env = await tmpEnv('hypaware-bf-throw-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = {
    available: ['claude'],
    /** @param {{ provider: string }} _args */
    async run(_args) {
      throw new Error('boom')
    },
  }

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 30 },
    backfill,
    finale: { skipDaemon: true },
  })

  // The failure is contained: the walkthrough still completes (exit 0) and
  // the provider is recorded as failed rather than aborting the finale.
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.finale?.backfill, [
    { provider: 'claude', dryRun: false, ok: false, scanned: 0, rowsWritten: 0, skipped: 0 },
  ])
  assert.match(stderr.text(), /backfill claude failed: boom/)
})

test('the finale runs no backfill when no backfill runner is injected', async () => {
  const env = await tmpEnv('hypaware-bf-none-')
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 30 },
    // no `backfill`
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.finale?.backfill, [])
})

test('onboarding with codex selected runs the backfill step and records stats', async () => {
  const env = await tmpEnv('hypaware-bf-codex-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['codex'], {
    codex: { provider: 'codex', dryRun: false, ok: true, scanned: 4, rowsWritten: 6, skipped: 2 },
  })

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['codex'], exportChoice: 'keep-local', retentionDays: 14 },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  // The finale invoked the runner exactly once, for the codex provider,
  // bounded by the selected retention window and a valid ISO cutoff.
  assert.equal(backfill.calls.length, 1)
  assert.equal(backfill.calls[0].provider, 'codex')
  assert.equal(backfill.calls[0].dryRun, false)
  assert.equal(backfill.calls[0].retentionDays, 14)
  assert.ok(
    typeof backfill.calls[0].until === 'string' && !Number.isNaN(Date.parse(backfill.calls[0].until)),
    'until must be a valid ISO timestamp (the attach/start cutoff)'
  )
  // Finale summary carries the per-provider codex backfill stats.
  assert.deepEqual(result.finale?.backfill, [
    { provider: 'codex', dryRun: false, ok: true, scanned: 4, rowsWritten: 6, skipped: 2 },
  ])
  assert.match(stdout.text(), /backfill codex: ok \(scanned 4, wrote 6, skipped 2\)/)
})

test('onboarding with both claude and codex selected runs both providers', async () => {
  const env = await tmpEnv('hypaware-bf-both-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude', 'codex'], {
    claude: { provider: 'claude', dryRun: false, ok: true, scanned: 3, rowsWritten: 5, skipped: 0 },
    codex: { provider: 'codex', dryRun: false, ok: true, scanned: 2, rowsWritten: 4, skipped: 1 },
  })

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['claude', 'codex'], exportChoice: 'keep-local', retentionDays: 30 },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  // Both providers ran, in the deterministic [claude, codex] pick order.
  assert.deepEqual(backfill.calls.map((c) => c.provider), ['claude', 'codex'])
  assert.deepEqual(result.finale?.backfill, [
    { provider: 'claude', dryRun: false, ok: true, scanned: 3, rowsWritten: 5, skipped: 0 },
    { provider: 'codex', dryRun: false, ok: true, scanned: 2, rowsWritten: 4, skipped: 1 },
  ])
  assert.match(stdout.text(), /backfill claude: ok/)
  assert.match(stdout.text(), /backfill codex: ok/)
})

test('interactive onboarding prompts codex backfill consent and runs it on yes', async () => {
  const env = await tmpEnv('hypaware-bf-codex-interactive-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['codex'])
  /** @type {Array<{ providers: string[], retentionDays: number }>} */
  const consentCalls = []

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    // No `picks` ⇒ interactive: the source resolver picks codex.
    prompt: async (q) => (q.pickType === 'sources' ? ['codex'] : ['keep-local']),
    retentionPrompt: async () => 30,
    backfillConsentPrompt: async (args) => {
      consentCalls.push(args)
      return true
    },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.clientsPicked, ['codex'])
  assert.equal(consentCalls.length, 1, 'interactive mode prompts for codex backfill consent')
  assert.deepEqual(consentCalls[0].providers, ['codex'])
  assert.equal(backfill.calls.length, 1)
  assert.equal(backfill.calls[0].provider, 'codex')
})

test('a failing provider does not abort the other selected providers', async () => {
  const env = await tmpEnv('hypaware-bf-isolate-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {string[]} */
  const ran = []
  // claude throws; codex must still run and be recorded as ok. The failing
  // provider sits first in pick order, so this proves the loop continues
  // past a failure rather than short-circuiting the finale.
  const backfill = {
    available: ['claude', 'codex'],
    /** @param {{ provider: string, dryRun: boolean }} args */
    async run(args) {
      ran.push(args.provider)
      if (args.provider === 'claude') throw new Error('claude boom')
      return { provider: args.provider, dryRun: args.dryRun, ok: true, scanned: 1, rowsWritten: 1, skipped: 0 }
    },
  }

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    picks: { sources: ['claude', 'codex'], exportChoice: 'keep-local', retentionDays: 30 },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  // The failing provider did not short-circuit the loop: codex still ran.
  assert.deepEqual(ran, ['claude', 'codex'])
  assert.deepEqual(result.finale?.backfill, [
    { provider: 'claude', dryRun: false, ok: false, scanned: 0, rowsWritten: 0, skipped: 0 },
    { provider: 'codex', dryRun: false, ok: true, scanned: 1, rowsWritten: 1, skipped: 0 },
  ])
  assert.match(stderr.text(), /backfill claude failed: claude boom/)
})
