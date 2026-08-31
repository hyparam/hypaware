// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPickerFinale, runPickerWalkthrough, WALKTHROUGH_CANCEL_EXIT_CODE } from '../../src/core/cli/walkthrough.js'
import { PromptCancelledError } from '../../src/core/cli/tui/runtime.js'

/** @import { BackfillFinaleResult } from '../../src/core/cli/types.js' */

/**
 * Fake picker backfill runner. Records every `run` call and returns a
 * configurable per-provider finale entry, so the tests can assert both
 * the inputs the finale passed and the summary it collected.
 *
 * @param {string[]} available
 * @param {Record<string, BackfillFinaleResult>} [entries]
 * @param {string[]} [sweeping]
 */
function makeBackfill(available, entries = {}, sweeping = []) {
  /** @type {Array<{ provider: string, dryRun: boolean, retentionDays: number, until: string }>} */
  const calls = []
  return {
    available,
    sweeping,
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
    backfillConsentPrompt: async () => false,
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.equal(backfill.calls.length, 0, 'declining must skip the backfill run')
  assert.deepEqual(result.finale?.backfill, [])
  assert.match(stdout.text(), /backfill: skipped \(declined\)/)
  // The other half of the dead-surface notice below: a decline was read
  // and answered on a surface that still works, so it says so where the
  // user is looking and leaves the surviving stream alone. Keying that
  // notice on `!consent` rather than on the dead surface itself would
  // warn every user who simply said no.
  assert.doesNotMatch(stderr.text(), /output closed/, 'a decline is not an output failure')
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
    backfillConsentPrompt: async () => {
      throw new PromptCancelledError()
    },
    backfill,
    finale: { dryRun: true },
  })

  assert.equal(result.exitCode, WALKTHROUGH_CANCEL_EXIT_CODE)
  assert.deepEqual(result.sourcesPicked, ['claude'])
  assert.deepEqual(result.clientsPicked, ['claude'])
  assert.equal(result.retentionDays, 90)
  assert.equal(backfill.calls.length, 0, 'cancelling consent must skip the backfill run')
  assert.equal(result.finale?.cancelled, true)
  assert.deepEqual(result.finale?.backfill, [])
  assert.deepEqual(result.finale?.daemonRestart, { skipped: false, dryRun: true, ok: true })
  assert.match(stderr.text(), /hyp setup: cancelled/)
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

// --- sweep-backed providers (LLP 0180): disclosure instead of a question ---
// A provider whose contribution declares a daemon sweep imports its history
// on schedule regardless of any consent answer (LLP 0170), so the finale
// never asks for it: the question covers only the non-sweep providers, and
// the sweep-backed one runs its first import with a disclosure line.
// @ref LLP 0180#decision [tests]: a sweep-backed provider is disclosed and
// imported rather than asked, and only a cancel takes it down with the rest
test('a sweep-backed provider is disclosed and runs even when consent is declined', async () => {
  const env = await tmpEnv('hypaware-bf-sweep-declined-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude', 'openclaw'], {}, ['openclaw'])
  /** @type {Array<{ providers: string[], retentionDays: number }>} */
  const consentCalls = []

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    prompt: async (q) => (q.pickType === 'sources' ? ['claude', 'openclaw'] : ['keep-local']),
    backfillConsentPrompt: async (args) => {
      consentCalls.push(args)
      return false
    },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.clientsPicked, ['claude', 'openclaw'])
  // The question named only the provider the answer can control.
  assert.equal(consentCalls.length, 1)
  assert.deepEqual(consentCalls[0].providers, ['claude'])
  // Declining skipped claude but not the sweep-backed openclaw.
  assert.deepEqual(backfill.calls.map((c) => c.provider), ['openclaw'])
  assert.match(stdout.text(), /backfill: skipped \(declined\)/)
  assert.match(stdout.text(), /backfill openclaw: the enabled periodic sweep imports its history on schedule/)
})

test('an openclaw-only pick asks no backfill question but still runs the first import', async () => {
  const env = await tmpEnv('hypaware-bf-sweep-only-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['openclaw'], {}, ['openclaw'])
  let consentAsked = 0

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    prompt: async (q) => (q.pickType === 'sources' ? ['openclaw'] : ['keep-local']),
    backfillConsentPrompt: async () => {
      consentAsked += 1
      return true
    },
    backfill,
    finale: { skipDaemon: true },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.clientsPicked, ['openclaw'])
  assert.equal(consentAsked, 0, 'nothing askable: every picked provider is sweep-backed')
  assert.deepEqual(backfill.calls.map((c) => c.provider), ['openclaw'])
  assert.match(stdout.text(), /backfill openclaw: the enabled periodic sweep imports its history on schedule/)
})

test('cancelling consent skips sweep-backed providers too', async () => {
  const env = await tmpEnv('hypaware-bf-sweep-cancel-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude', 'openclaw'], {}, ['openclaw'])

  const result = await runPickerWalkthrough({
    capabilities: noGateway,
    stdout,
    stderr,
    env,
    prompt: async (q) => (q.pickType === 'sources' ? ['claude', 'openclaw'] : ['keep-local']),
    backfillConsentPrompt: async () => {
      throw new PromptCancelledError()
    },
    backfill,
    finale: { skipDaemon: true },
  })

  // Cancel means "stop the wizard", not "skip the question": nothing runs,
  // sweep-backed or not.
  assert.equal(result.exitCode, WALKTHROUGH_CANCEL_EXIT_CODE)
  assert.equal(backfill.calls.length, 0)
  assert.match(stdout.text(), /backfill: skipped \(cancelled\)/)
})

// The backfill consent is the run's last consent question and the only
// one inside the finale, which is one *step* but several acts: the
// daemon install, the attach, and the asset copy all narrate before it
// opens. A caller's boundary check in front of the finale therefore
// cannot speak for a surface that dies inside it, and both default
// prompts answer an unreadable question with yes - the select's cursor
// starts on "Yes" (walkthrough.js `default: 'yes'`), and the `[Y/n]`
// line reads EOF as the bare enter it advertised. What that yes buys is
// an import of the user's local transcript history, so a surface nobody
// can read has to decline rather than take the default it never printed.
// @ref LLP 0341#dead-surface [tests]: the finale's own question takes the boundary, and a dead surface declines
test('a dead consent surface declines the backfill instead of taking its default', async () => {
  const env = await tmpEnv('hypaware-bf-dead-surface-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude'])
  let asked = false

  const summary = await runPickerFinale(/** @type {any} */ ({
    finale: { skipDaemon: true },
    clientsPicked: ['claude'],
    capabilities: noGateway,
    config: { version: 2, plugins: [] },
    configPath: path.join(String(env.HOME), 'config.json'),
    env,
    stdout,
    stderr,
    retentionDays: 30,
    interactive: true,
    backfill,
    // A prompt that would say yes, to prove the boundary runs *before* the
    // question rather than filtering its answer.
    backfillConsentPrompt: async () => { asked = true; return true },
    checkBoundary: async () => false,
  }))

  assert.equal(asked, false, 'no question opens on a surface nobody can read')
  assert.equal(backfill.calls.length, 0, 'a dead surface must not import local transcript history')
  assert.deepEqual(summary.backfill, [])
})

// The skip above is silent on the surface that can still be read. The
// `backfill: skipped (declined)` line it would otherwise print goes to
// stdout, which is exactly the stream that just died, so someone whose
// terminal went away mid-finale gets no signal at all that their local
// history was not imported. The post-commit cancel already narrates its
// unfinished install on stderr; the finale's own skip says the same kind
// of thing on the same surviving stream.
// The pick is mixed on purpose. A sweep-backed provider is never asked
// and runs its first import whatever the answer was (LLP 0180, pinned
// above), so a notice that claimed "the local history import" outright
// would name work that did happen - in the one message whose whole job
// is to say accurately what did not.
// @ref LLP 0341#dead-surface [tests]: the fact that outlives the run is attempted where a `2>log` invocation could still catch it, and says only what was skipped
test('a dead consent surface says on stderr which backfill was skipped', async () => {
  const env = await tmpEnv('hypaware-bf-dead-surface-notice-')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const backfill = makeBackfill(['claude', 'openclaw'], {}, ['openclaw'])

  await runPickerFinale(/** @type {any} */ ({
    finale: { skipDaemon: true },
    clientsPicked: ['claude', 'openclaw'],
    capabilities: noGateway,
    config: { version: 2, plugins: [] },
    configPath: path.join(String(env.HOME), 'config.json'),
    env,
    stdout,
    stderr,
    retentionDays: 30,
    interactive: true,
    backfill,
    backfillConsentPrompt: async () => true,
    checkBoundary: async () => false,
  }))

  assert.match(stderr.text(), /output closed/, 'the surviving stream names why the import did not run')
  assert.match(stderr.text(), /re-run 'hyp setup'/, 'and says how to complete it, like the post-commit cancel does')
  // Only the provider the dead question would have covered.
  assert.match(stderr.text(), /import for claude was skipped/)
  assert.doesNotMatch(stderr.text(), /openclaw/, 'the sweep-backed import below is not something to re-run for')
  assert.deepEqual(backfill.calls.map((c) => c.provider), ['openclaw'])
  // The decline line stays off stdout: nothing can read it, and "declined"
  // is not what happened.
  assert.doesNotMatch(stdout.text(), /backfill: skipped \(declined\)/)
})

// Whatever took stdout can have taken stderr with it (a closed terminal
// takes both), and this arm's contract is to warn and let the finale
// finish. The warning therefore may not become the thing that stops the
// sweep import and the daemon restart that follow it. The wizard hands
// down guard-wrapped sinks that swallow this already; the guard here is
// what makes the contract hold for a direct caller of the exported
// finale, which is typed to take any writable.
// @ref LLP 0341#warnings [tests]: a warning that cannot be written does not unmake the decision it qualifies
test('a stderr that throws does not cost the finale the work after the notice', async () => {
  const env = await tmpEnv('hypaware-bf-dead-stderr-')
  const backfill = makeBackfill(['claude', 'openclaw'], {}, ['openclaw'])
  const throwing = { write() { throw new Error('EPIPE: broken pipe') } }

  await runPickerFinale(/** @type {any} */ ({
    finale: { skipDaemon: true },
    clientsPicked: ['claude', 'openclaw'],
    capabilities: noGateway,
    config: { version: 2, plugins: [] },
    configPath: path.join(String(env.HOME), 'config.json'),
    env,
    stdout: makeBuf(),
    stderr: throwing,
    retentionDays: 30,
    interactive: true,
    backfill,
    backfillConsentPrompt: async () => true,
    checkBoundary: async () => false,
  }))

  assert.deepEqual(backfill.calls.map((c) => c.provider), ['openclaw'])
})

// The other side of the same seam: a live surface changes nothing, and a
// caller with no boundary check to give (the standalone picker
// walkthrough) still asks exactly as it did.
// @ref LLP 0341#dead-surface [tests]: the boundary only ever withholds the question, never adds one
test('a live surface, and a caller with no boundary check, both still ask', async () => {
  for (const checkBoundary of [async () => true, undefined]) {
    const env = await tmpEnv('hypaware-bf-live-surface-')
    const backfill = makeBackfill(['claude'])
    let asked = false
    await runPickerFinale(/** @type {any} */ ({
      finale: { skipDaemon: true },
      clientsPicked: ['claude'],
      capabilities: noGateway,
      config: { version: 2, plugins: [] },
      configPath: path.join(String(env.HOME), 'config.json'),
      env,
      stdout: makeBuf(),
      stderr: makeBuf(),
      retentionDays: 30,
      interactive: true,
      backfill,
      backfillConsentPrompt: async () => { asked = true; return true },
      ...(checkBoundary ? { checkBoundary } : {}),
    }))
    assert.equal(asked, true)
    assert.equal(backfill.calls.length, 1)
  }
})
