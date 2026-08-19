// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { narrateAcceptedGate, runWizardExpressGate } from '../../../../src/core/cli/wizard/express.js'
import { runWizardSyncScope } from '../../../../src/core/cli/wizard/sync_scope.js'
import { runWizardFolderAsk } from '../../../../src/core/cli/wizard/folder_ask.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { readFolderAskMode } from '../../../../src/core/usage-policy/folder_ask.js'
import { readClientSyncEntries, writeClientSyncEntries } from '../../../../src/core/usage-policy/client_sync.js'
import { PromptBackRequestedError, PromptCancelledError } from '../../../../src/core/cli/tui/runtime.js'

// The express gate (LLP 0201): one question before the lanes that accepts
// every lane's stated default, and the narration that keeps the fast path
// from being a silent one.
// @ref LLP 0201#gate [tests]:
// @ref LLP 0201#narrate [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-express-'))
  return { env: { HYP_HOME: hypHome }, stateDir: readObservabilityEnv({ HYP_HOME: hypHome }).stateDir }
}

/** @param {string} answer */
function capturingConfirm(answer) {
  /** @type {{ question?: any }} */
  const state = {}
  const confirm = async (/** @type {any} */ question) => {
    state.question = question
    return answer
  }
  return { confirm, state }
}

/** @param {string} id */
function descriptor(id) {
  return /** @type {any} */ ({ plugin: `@hypaware/${id}`, id, label: `capture ${id}`, summary: `${id} rows` })
}

const ROWS = ['  Claude Code · managed by your fleet', '  Codex · detected']

test('the gate lists the rows it will record, and the accept row names the act on them', async () => {
  const { env } = await makeHome()
  const { confirm, state } = capturingConfirm('defaults')

  const choice = await runWizardExpressGate(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, enrolled: true, rows: ROWS, confirm,
  }))

  assert.equal(choice, 'defaults')
  // The list is the explanation: the rows themselves, verbatim, not a
  // paraphrase of what "defaults" means.
  assert.equal(state.question.title, 'HypAware found these on this machine:')
  assert.deepEqual(state.question.items, ROWS)
  assert.deepEqual(state.question.options.map((/** @type {any} */ o) => o.label), [
    'Record and sync all of these',
    'Let me choose',
  ])
  assert.deepEqual(state.question.options.map((/** @type {any} */ o) => o.value), ['defaults', 'choose'])
  assert.equal(state.question.default, 'defaults')
  // One line of consequence on the accept row: what it does to the machine
  // (LLP 0190 #pick-gate) plus the folder policy that rides with it.
  const accept = state.question.options[0]
  assert.match(accept.summary, /Configures each to record through HypAware/)
  assert.match(accept.summary, /new folders sync too/)
  // The decline row prices the longer path (LLP 0201): it names the
  // screens choosing walks through.
  assert.match(state.question.options[1].summary, /what to record, what syncs, and new-folder behavior/)
  // No position line: the gate is what decides how many questions remain,
  // so it can no more state a total than the fork can (LLP 0135 #progress).
  assert.equal(state.question.progress, undefined)
})

// `opts.enrolled` is only ever `true` at the sole production call site
// (LLP 0201 #one-lane-no-gate: the orchestrator now guards the gate itself
// with `enrolled()`), so this pins the component's contract - what the gate
// would render if ever called with `enrolled` unset or false - not a screen
// any run reaches.
test('the gate claims a server only when told it has one', async () => {
  const { env } = await makeHome()
  const { confirm, state } = capturingConfirm('defaults')

  await runWizardExpressGate(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, rows: ROWS, confirm,
  }))

  assert.equal(state.question.options[0].label, 'Record all of these', 'nothing forwards from a solo machine')
  assert.doesNotMatch(state.question.options[0].summary, /sync/)
})

test('declining runs the lanes as they are; back and cancel are their own answers', async () => {
  const { env } = await makeHome()
  const io = { stdout: makeBuf(), stderr: makeBuf(), env }

  assert.equal(
    await runWizardExpressGate(/** @type {any} */ ({ ...io, rows: ROWS, confirm: async () => 'choose' })),
    'choose'
  )
  assert.equal(
    await runWizardExpressGate(/** @type {any} */ ({ ...io, rows: ROWS, confirm: async () => { throw new PromptBackRequestedError() } })),
    'back'
  )
  assert.equal(
    await runWizardExpressGate(/** @type {any} */ ({ ...io, rows: ROWS, confirm: async () => { throw new PromptCancelledError() } })),
    'cancelled'
  )
})

// The lanes' half of the bargain: auto-accepting skips the prompt, never
// the statement (LLP 0201 #narrate).

test('the sync lane auto-accepts by narrating the same split and writing the same store', async () => {
  const { env, stateDir } = await makeHome()
  await writeClientSyncEntries({ stateDir, entries: [{ source: 'openclaw', class: 'local-only' }] })
  const stdout = makeBuf()

  const result = await runWizardSyncScope(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    candidates: [descriptor('openclaw'), descriptor('hermes')],
    locked: [descriptor('claude')],
    autoAccept: true,
    confirm: async () => { throw new Error('the express path must not prompt') },
    prompt: async () => { throw new Error('the express path must not prompt') },
  }))

  assert.deepEqual(result, { optedOut: ['openclaw'] }, 'a standing opt-out survives the fast path')
  const out = stdout.text()
  assert.match(out, /These will sync to your server:/)
  assert.match(out, /capture claude · managed by your fleet/)
  assert.match(out, /capture hermes/)
  assert.match(out, /Staying local-only:/)
  assert.deepEqual(await readClientSyncEntries({ stateDir }), [
    { source: 'openclaw', class: 'local-only' },
  ])
})

test('the new-folder lane auto-accepts to the default and records it', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    autoAccept: true,
    confirm: async () => { throw new Error('the express path must not prompt') },
  }))

  assert.deepEqual(result, { mode: 'sync' })
  assert.equal(await readFolderAskMode({ stateDir }), 'sync')
  assert.match(stdout.text(), /When you start a session in a new folder:/)
})

test('narrateAcceptedGate prints the gate title and its items verbatim, led by a blank line', () => {
  const stdout = makeBuf()
  narrateAcceptedGate({ stdout, title: 'HypAware will record:', items: ['  Claude Code', '  Codex'] })
  // The blank line is load-bearing on the express path: these blocks
  // arrive back to back with no prompts between them.
  assert.equal(stdout.text(), '\nHypAware will record:\n  Claude Code\n  Codex\n')
})

// Accepting takes each lane's stated default, and the new-folder lane's
// default on a re-run is the answer already in force (LLP 0268
// #standing-answer). The one line the fast path is guaranteed to read has
// to name that, not the shipped default it is not about to apply.
// @ref LLP 0268#standing-answer [tests]:
test('the accept row names the standing new-folder answer, not the shipped default', async () => {
  const { env } = await makeHome()
  const { confirm, state } = capturingConfirm('defaults')

  await runWizardExpressGate(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, enrolled: true, rows: ROWS, folderAsk: 'ask', confirm,
  }))

  assert.match(state.question.options[0].summary, /new folders keep asking/)
  assert.doesNotMatch(state.question.options[0].summary, /new folders sync too/)
})
