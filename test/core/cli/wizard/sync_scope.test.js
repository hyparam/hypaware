// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { commitWizardSyncScope, runWizardSyncScope } from '../../../../src/core/cli/wizard/sync_scope.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import {
  clientSyncListPath,
  readClientSyncEntries,
  writeClientSyncEntries,
} from '../../../../src/core/usage-policy/client_sync.js'

// The wizard's sync-scope step (LLP 0188 #never-silent, LLP 0396
// #combined-selection): it asks nothing. It states what syncs as one line
// and returns the picked sources whose standing opt-outs the wizard clears
// with `commitWizardSyncScope` once the config has committed.
// @ref LLP 0188#never-silent [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sync-scope-'))
  return { hypHome, env: { HYP_HOME: hypHome }, stateDir: readObservabilityEnv({ HYP_HOME: hypHome }).stateDir }
}

/** @param {string} id */
function descriptor(id) {
  return /** @type {any} */ ({ plugin: `@hypaware/${id}`, id, label: `capture ${id}`, summary: `${id} rows` })
}

test('zero candidates with org rows: states the team-set Syncing line, prompts nothing, writes nothing', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [descriptor('claude')],
  }))

  // `noQuestion` is the part the orchestrator reads: a lane that only
  // stated its outcome is not a screen, so the new-folder lane behind it
  // backs past it to the picker rather than re-running it (LLP 0191
  // #back-edges). Being a recap line and not a screen, it carries no
  // position line either.
  assert.deepEqual(result, { noQuestion: true })
  assert.equal(stdout.text(), "✓ Syncing it to your team's server (set by your team)\n")
  assert.equal(await readClientSyncEntries({ stateDir: stateDir }), null, 'no store write on the no-question path')
})

// The same no-question path with nothing for the fleet to own. Reachable on
// an enrolled machine whose only locked rows are hidden (LLP 0276
// #sync-gate) and that picked nothing visible: claiming the fleet manages
// what was picked would invent an owner for an empty list.
// @ref LLP 0276#sync-gate [tests]:
test('zero candidates and no org rows: says nothing syncs, never names the fleet', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
  }))

  assert.deepEqual(result, { noQuestion: true })
  assert.equal(stdout.text(), "✓ Nothing syncs to your team's server\n")
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'no store write on the no-question path')
})

// The third no-question fact: the enrolled machine of LLP 0276 §problem,
// whose only locked rows are the hidden `raw-*` pair. Nothing was picked,
// but the org's gateway rows are locked, always sync, and cannot be opted
// out (LLP 0188 #locked) - so the line must not claim nothing leaves the
// machine, while still never naming a row the picker withheld.
// @ref LLP 0276#no-candidates [tests]:
test('zero candidates with only hidden org rows: does not claim nothing syncs', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 2,
  }))

  assert.deepEqual(result, { noQuestion: true })
  assert.equal(stdout.text(), "✓ Capture your team manages still syncs to your team's server\n")
  assert.doesNotMatch(stdout.text(), /Nothing syncs/)
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld rows are still never named')
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'no store write on the no-question path')
})

// The candidate half of the same fact. A carried hidden row (LLP 0202
// #carry-through) that is not locked is composed into the local layer and
// syncs unless an opt-out entry says otherwise, and the display filter takes
// it off this screen - so the empty-candidate line must not claim nothing
// leaves the machine, and must not attribute the row to the fleet either.
// @ref LLP 0276#no-candidates [tests]:
test('zero visible candidates with a hidden picked row: does not claim nothing syncs, never names the fleet', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 0,
    candidatesHiddenIds: ['raw-anthropic'],
  }))

  assert.deepEqual(result, { noQuestion: true })
  assert.equal(stdout.text(), "✓ Capture already set up on this machine still syncs to your team's server\n")
  assert.doesNotMatch(stdout.text(), /Nothing syncs/)
  assert.doesNotMatch(stdout.text(), /set by your team|team manages/, 'the fleet owns no row here, so it is never named')
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld row is still never named')
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'no store write on the no-question path')
})

// The same branch, asked of the store instead of assumed. A hidden picked
// row is addressable by 'hyp policy client raw-anthropic local-only', and
// the export seam reads exactly that store (LLP 0188 #opt-out), so with a
// standing entry the row does not ship: nothing was picked and nothing
// syncs. The sentence that says otherwise is a false promise on a
// privacy-facing screen (LLP 0188 #never-silent).
// @ref LLP 0289#ask-the-store [tests]:
test('zero visible candidates with a hidden picked row already opted out: says nothing syncs', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 0,
    candidatesHiddenIds: ['raw-anthropic'],
  }))

  assert.deepEqual(result, { noQuestion: true })
  assert.equal(stdout.text(), "✓ Nothing syncs to your team's server\n")
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld row is never named, opted out or not')
  assert.deepEqual(
    await readClientSyncEntries({ stateDir }),
    [{ source: 'raw-anthropic', class: 'local-only' }],
    'the no-question path still writes nothing'
  )
})

// One hidden pick withheld and one standing is still capture leaving the
// machine, so the qualified line stands: the check is "any hidden pick
// ships", never "every one does".
// @ref LLP 0289#ask-the-store [tests]:
test('zero visible candidates with one hidden pick opted out and one standing: does not claim nothing syncs', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 0,
    candidatesHiddenIds: ['raw-anthropic', 'raw-openai'],
  }))

  assert.deepEqual(result, { noQuestion: true })
  assert.match(stdout.text(), /still syncs to your team's server/)
  assert.doesNotMatch(stdout.text(), /Nothing syncs/)
})

// A locked row's line needs no store question: the export seam drops
// opt-out entries for central-classified sources (an org row always syncs,
// LLP 0188 #locked), so a stale entry for one is inert and the fleet line
// stays unconditional.
// @ref LLP 0289#ask-the-store [tests]:
test('a stale opt-out for a hidden locked row does not soften the fleet line', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [],
    lockedHidden: 1,
    candidatesHiddenIds: [],
  }))

  assert.deepEqual(result, { noQuestion: true })
  assert.equal(stdout.text(), "✓ Capture your team manages still syncs to your team's server\n")
})

// The fifth no-question fact, and the residual LLP 0276 left open: a visible
// org row and a hidden carried pick standing at the same time. The fleet row
// is real, so its line still attributes it to the team - but the carried row
// composes into the *local* layer, so it gets its own line, stated as a fact
// and never as the team's.
// @ref LLP 0281#visible-org-row [tests]:
test('zero visible candidates with an org row and a hidden picked row: the fleet line covers only its own rows', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [descriptor('claude')],
    lockedHidden: 0,
    candidatesHiddenIds: ['raw-anthropic'],
  }))

  assert.deepEqual(result, { noQuestion: true })
  // The org row's line, then the hidden pick disclosed as a fact without
  // being named or handed to the fleet.
  assert.deepEqual(stdout.text().split('\n').filter(Boolean), [
    "✓ Syncing it to your team's server (set by your team)",
    "✓ Capture already set up on this machine also syncs to your team's server",
  ])
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld row is still never named')
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'no store write on the no-question path')
})

// The unchanged case, pinned beside it: with no hidden pick standing the
// org row's line is the whole picture.
// @ref LLP 0281#visible-org-row [tests]:
test('zero visible candidates with an org row and no hidden pick: states only the fleet line', async () => {
  const { env } = await makeHome()
  const stdout = makeBuf()

  await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [descriptor('claude')],
    lockedHidden: 0,
    candidatesHiddenIds: [],
  }))

  assert.equal(stdout.text(), "✓ Syncing it to your team's server (set by your team)\n")
})

// The two claims on this branch answer to different authorities. An opt-out
// entry settles whether the machine's own capture *ships*, so the second
// line goes; the fleet line still names only the rows the fleet owns (LLP
// 0281 #visible-org-row).
// @ref LLP 0289#ask-the-store [tests]:
test('zero visible candidates with an org row and a hidden pick already opted out: drops the also-syncs line, keeps the fleet line', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [],
    locked: [descriptor('claude')],
    lockedHidden: 0,
    candidatesHiddenIds: ['raw-anthropic'],
  }))

  assert.deepEqual(result, { noQuestion: true })
  // The store answered the shipping question, so the export promise goes.
  assert.equal(stdout.text(), "✓ Syncing it to your team's server (set by your team)\n")
  assert.doesNotMatch(stdout.text(), /raw-anthropic|Anthropic API/, 'the withheld row is never named, opted out or not')
})

test('a corrupt store skips the step with a warning and is never overwritten', async () => {
  const { env, stateDir } = await makeHome()
  const storePath = clientSyncListPath(stateDir)
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  await fs.writeFile(storePath, '{ nope')
  const stderr = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(), stderr, env,
    candidates: [descriptor('openclaw')],
  }))

  // Skipped and unasked: the lane after it must not try to back into it.
  assert.deepEqual(result, { skipped: true, noQuestion: true })
  assert.match(stderr.text(), /unreadable/)
  assert.equal(await fs.readFile(storePath, 'utf8'), '{ nope')
})

// The arm's documented contract is to warn and skip rather than fail the
// run, and the warning write was the one way it could still fail it: a
// stderr that throws (a stream closed under a run that is shutting down)
// took the run down from inside the arm that exists to keep it alive.
// Same shape the folder-ask lane's arms pin (PR #1149), now the corpus
// rule.
// @ref LLP 0341#warnings [tests]:
test('a corrupt store with a dead stderr still skips instead of throwing', async () => {
  const { env, stateDir } = await makeHome()
  const storePath = clientSyncListPath(stateDir)
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  await fs.writeFile(storePath, '{ nope')

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout: makeBuf(),
    stderr: { write() { throw new Error('EPIPE: broken pipe') } },
    env,
    candidates: [descriptor('openclaw')],
  }))

  // The skip still returns, flags intact: they are what the folder-ask
  // lane and the back edges read.
  assert.deepEqual(result, { skipped: true, noQuestion: true })
  assert.equal(await fs.readFile(storePath, 'utf8'), '{ nope')
})


// @ref LLP 0396#combined-selection [tests]: confirmation shares selected visible sources without another question
test('combined collection and sync clears only selected policies', async (t) => {
  const { hypHome, env, stateDir } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeClientSyncEntries({ stateDir, entries: [
    { source: 'claude', class: 'local-only' },
    { source: 'codex', class: 'local-only' },
    { source: 'raw-anthropic', class: 'local-only' },
  ] })
  const stdout = makeBuf()
  const result = await runWizardSyncScope({
    stdout, stderr: makeBuf(), env,
    candidates: [descriptor('claude')],
    locked: [descriptor('gateway')],
    candidatesHiddenIds: ['raw-anthropic'],
  })
  assert.deepEqual(result, { noQuestion: true, pendingSources: ['claude'] })
  // The lane only states; the store is untouched until the commit.
  assert.deepEqual((await readClientSyncEntries({ stateDir }))?.map((entry) => entry.source).sort(),
    ['claude', 'codex', 'raw-anthropic'])
  const cleared = await commitWizardSyncScope({ env, stdout, sources: result.pendingSources ?? [] })
  assert.equal(cleared, 1)
  assert.deepEqual((await readClientSyncEntries({ stateDir }))?.map((entry) => entry.source).sort(),
    ['codex', 'raw-anthropic'])
  // The revocation, which no row list can state: claude was local-only
  // until this confirm. codex and raw-anthropic are not named because
  // neither is a visible candidate, so neither was revoked.
  const revocation = "No longer local-only: claude. Future rows sync to your team's server; rows already recorded " +
    "are not sent. Change back with 'hyp privacy client <name> local-only'."
  // The org's row is attributed to the team on the Syncing line: unlabelled,
  // the line reads as though every row it counts were the user's to change
  // (LLP 0188 #locked).
  assert.deepEqual(stdout.text().split('\n').filter((l) => l !== ''), [
    "✓ Syncing both to your team's server (capture gateway is set by your team)",
    revocation,
  ], stdout.text())
})

test('combined selection preserves an unreadable policy store and warns', async (t) => {
  const { hypHome, env, stateDir } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const file = clientSyncListPath(stateDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'broken')
  const stderr = makeBuf()
  const result = await runWizardSyncScope({
    stdout: makeBuf(), stderr, env, candidates: [descriptor('claude')],
  })
  assert.equal(result.skipped, true)
  assert.equal(result.pendingSources, undefined)
  assert.match(stderr.text(), /unreadable/)
  assert.equal(await fs.readFile(file, 'utf8'), 'broken')
})

test('committing a combined selection materializes a fresh empty policy store', async (t) => {
  const { hypHome, env, stateDir } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const result = await runWizardSyncScope({
    stdout: makeBuf(), stderr: makeBuf(), env, candidates: [descriptor('claude')],
  })
  assert.equal(await readClientSyncEntries({ stateDir }), null, 'the lane itself never writes')
  await commitWizardSyncScope({ env, stdout: makeBuf(), sources: result.pendingSources ?? [] })
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [])
})

// Revoking a standing opt-out is a change to a privacy setting the user
// set on purpose, so the commit says which ones and how to undo it.
// `hyp privacy client <name> sync` prints the same two qualifiers for the
// identical store write. The Syncing line cannot carry this: a row reads
// the same there whether it was already syncing or was local-only until
// this confirm.
// @ref LLP 0188#never-silent [tests]: the combined commit names the opt-outs it revoked, with the future-only qualifier and the way back
test('committing a combined selection names the standing opt-outs it revokes, and the way back', async (t) => {
  const { hypHome, env, stateDir } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeClientSyncEntries({ stateDir, entries: [
    { source: 'claude', class: 'local-only' },
    { source: 'codex', class: 'local-only' },
  ] })
  const stdout = makeBuf()
  const result = await runWizardSyncScope({
    stdout, stderr: makeBuf(), env,
    candidates: [descriptor('codex'), descriptor('claude')],
  })
  await commitWizardSyncScope({ env, stdout, sources: result.pendingSources ?? [] })
  const line = stdout.text().split('\n').find((l) => l.startsWith('No longer local-only:'))
  assert.ok(line, `the revocation was never stated; the screen read:\n${stdout.text()}`)
  // Both revoked rows, in a stable order, so the line is not a sample.
  assert.match(line, /^No longer local-only: claude · codex\./)
  // The two qualifiers the standing CLI carries for this same write.
  assert.match(line, /rows already recorded are not sent/)
  assert.match(line, /hyp privacy client <name> local-only/)
})

// The other half: a commit that revokes nothing says nothing. The line is a
// report of a change, not a standing disclaimer, so a fresh join must not
// print it over an empty store.
test('committing a combined selection stays silent when it revokes nothing', async (t) => {
  const { hypHome, env, stateDir } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'raw-anthropic', class: 'local-only' }] })
  const stdout = makeBuf()
  const result = await runWizardSyncScope({
    stdout, stderr: makeBuf(), env,
    candidates: [descriptor('claude')],
    candidatesHiddenIds: ['raw-anthropic'],
  })
  await commitWizardSyncScope({ env, stdout, sources: result.pendingSources ?? [] })
  // The hidden row's opt-out is untouched, so nothing was revoked.
  assert.doesNotMatch(stdout.text(), /No longer local-only/)
  assert.deepEqual((await readClientSyncEntries({ stateDir }))?.map((e) => e.source), ['raw-anthropic'])
})
