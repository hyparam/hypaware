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
import { readFolderAskMode, writeFolderAskMode } from '../../../../src/core/usage-policy/folder_ask.js'
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

const ROWS = ['Claude Code', 'Codex']

test('the accept row names the tools in its own summary; nothing rides the items chrome', async () => {
  const { env } = await makeHome()
  const { confirm, state } = capturingConfirm('defaults')

  const choice = await runWizardExpressGate(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, enrolled: true, rows: ROWS, confirm,
  }))

  assert.equal(choice, 'defaults')
  // The rows are self-explaining (LLP 0201 #gate): the tool names live in
  // the accept row's summary sentence, not in the items chrome above the
  // key-hint line, which goes unread.
  assert.equal(state.question.title, 'Set up recording')
  assert.equal(state.question.items, undefined)
  assert.deepEqual(state.question.options.map((/** @type {any} */ o) => o.label), [
    'Record and sync everything',
    'Customize',
  ])
  assert.deepEqual(state.question.options.map((/** @type {any} */ o) => o.value), ['defaults', 'choose'])
  assert.equal(state.question.default, 'defaults')
  // One sentence doing both jobs: the evidence (the tools that were
  // found) and the disclosure that accepting *configures* them. The
  // express accept never opens the pick menu, so this row is the only
  // place the happy path can read it (LLP 0190 #pick-gate).
  // @ref LLP 0190#pick-gate [tests]: the happy-path accept row still discloses that accepting configures the listed tools
  assert.equal(
    state.question.options[0].summary,
    'Configures Claude Code and Codex to record through HypAware.'
  )
  // The decline row glosses the questions it opens (LLP 0201 #decline):
  // the menus, linearly, not another round of gates.
  assert.equal(state.question.options[1].summary, 'Choose what to record and what syncs.')
  // No position line: the gate is what decides how many questions remain,
  // so it can no more state a total than the fork can (LLP 0135 #progress).
  assert.equal(state.question.progress, undefined)
})

test('the gate claims a server only when told it has one', async () => {
  const { env } = await makeHome()
  const { confirm, state } = capturingConfirm('defaults')

  await runWizardExpressGate(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, rows: ['Claude Code'], confirm,
  }))

  assert.equal(state.question.options[0].label, 'Record everything', 'nothing forwards from a solo machine')
  // The disclosure is unconditional: a solo machine's install configures
  // the tool just the same, so only the sync claim drops.
  assert.equal(
    state.question.options[0].summary,
    'Configures Claude Code to record through HypAware.'
  )
  assert.doesNotMatch(state.question.options[0].summary, /sync/i)
  assert.equal(state.question.options[1].summary, 'Choose what to record.')
})

test('the sync claim drops when the store already withholds one of the named rows', async () => {
  const { env } = await makeHome()
  const { confirm, state } = capturingConfirm('defaults')

  await runWizardExpressGate(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, enrolled: true, syncWithheld: true, rows: ROWS, confirm,
  }))

  // An express accept preserves standing opt-outs verbatim rather than
  // clearing them, so on that reconfigure "and sync everything" is a
  // promise the accept does not keep. The retired sync gate carried this
  // distinction itself ("Sync all" against "Keep this"); with that gate
  // gone this row is the only screen the user decides on.
  // @ref LLP 0201#gate [tests]: the accept row claims sync only when accepting would in fact sync everything it names
  assert.equal(state.question.options[0].label, 'Record everything')
  // Only the claim narrows. The disclosure is unconditional, and the
  // decline row still opens both menus.
  assert.equal(
    state.question.options[0].summary,
    'Configures Claude Code and Codex to record through HypAware.'
  )
  assert.equal(state.question.options[1].summary, 'Choose what to record and what syncs.')
})

test('declining opens the menus; back and cancel are their own answers', async () => {
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
  // No names threaded here, so the title takes the tool-free fallback.
  assert.match(stdout.text(), /When starting a session in a new project,/)
})

test('the new-folder lane auto-accepts the standing answer, not the constant', async () => {
  const { env, stateDir } = await makeHome()
  await writeFolderAskMode({ stateDir, mode: 'ask' })
  const stdout = makeBuf()

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    autoAccept: true,
    confirm: async () => { throw new Error('the express path must not prompt') },
  }))

  // The sibling of the sync lane's "a standing opt-out survives the fast
  // path" above: both lanes sit behind one keypress, and both must
  // round-trip their own store rather than reset it (LLP 0200 #wizard).
  // Hardcoding the default here overwrote a deliberate 'ask' with the
  // less protective 'sync' and then announced the new value as though the
  // user had answered it.
  // @ref LLP 0200#wizard [tests]: an express accept round-trips the standing preference instead of resetting it
  assert.deepEqual(result, { mode: 'ask' }, 'a standing preference survives the fast path')
  assert.equal(await readFolderAskMode({ stateDir }), 'ask')
  assert.match(stdout.text(), /you are asked the first time/)
  assert.doesNotMatch(stdout.text(), /it syncs automatically/)
})

test('narrateAcceptedGate prints the gate title and its items verbatim, led by a blank line', () => {
  const stdout = makeBuf()
  narrateAcceptedGate({ stdout, title: 'HypAware will record:', items: ['  Claude Code', '  Codex'] })
  // The blank line is load-bearing on the express path: these blocks
  // arrive back to back with no prompts between them.
  assert.equal(stdout.text(), '\nHypAware will record:\n  Claude Code\n  Codex\n')
})
