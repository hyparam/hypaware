// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { FOLDER_ASK_OPTIONS, runWizardFolderAsk } from '../../../../src/core/cli/wizard/folder_ask.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { folderAskPath, readFolderAskMode, writeFolderAskMode } from '../../../../src/core/usage-policy/folder_ask.js'
import { PromptBackRequestedError, PromptCancelledError } from '../../../../src/core/cli/tui/runtime.js'

// The wizard's new-folder step (LLP 0200 #wizard): one question, its own
// step after the per-adapter sync lane, defaulting to sync (LLP 0200
// #default). The answer is recorded either way, because the user answered
// a question and `hyp status` / `hyp policy list` read it back.
// @ref LLP 0200#wizard [tests]:
// @ref LLP 0200#default [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-folder-ask-lane-'))
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

test('sync leads, is the bare-enter default, and both rows state their consequence', async () => {
  const { env, stateDir } = await makeHome()
  const { confirm, state } = capturingConfirm('sync')
  const stdout = makeBuf()

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    progress: 'Step 4 of 5 · Choose how new folders are handled',
    names: ['Claude Code', 'Codex'],
    confirm,
  }))

  // The title is a sentence lead-in the rows complete, naming the tools
  // with "or": any one of them opening triggers the moment.
  assert.equal(state.question.title, 'When opening Claude Code or Codex in a new project,')
  assert.equal(state.question.items, undefined, 'nothing rides the items chrome (LLP 0201 #gate)')
  assert.deepEqual(state.question.options.map((/** @type {any} */ o) => o.value), ['sync', 'ask'])
  assert.deepEqual(state.question.options.map((/** @type {any} */ o) => o.label), [
    'Sync it automatically',
    'Ask me the first time',
  ])
  assert.equal(state.question.default, 'sync', 'a bare enter is "sync them all" (LLP 0200 #default)')
  assert.equal(state.question.progress, 'Step 4 of 5 · Choose how new folders are handled')
  assert.ok(state.question.options.every((/** @type {any} */ o) => typeof o.summary === 'string' && o.summary.length > 0))
  assert.deepEqual(result, { mode: 'sync' })
  assert.equal(await readFolderAskMode({ stateDir }), 'sync')
  assert.match(stdout.text(), /New folders will sync without asking/)
  assert.match(stdout.text(), /hyp privacy folders ask/)
})

test('choosing the ask buys the per-folder question and says how to undo it', async () => {
  const { env, stateDir } = await makeHome()
  const { confirm } = capturingConfirm('ask')
  const stdout = makeBuf()

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env, confirm,
  }))

  assert.deepEqual(result, { mode: 'ask' })
  assert.equal(await readFolderAskMode({ stateDir }), 'ask')
  assert.match(stdout.text(), /asked once per new folder/)
  assert.match(stdout.text(), /hyp privacy folders sync/)
})

test('the answer is recorded even when it matches the default, so status can read it back', async () => {
  const { env, stateDir } = await makeHome()
  const { confirm } = capturingConfirm('sync')

  await runWizardFolderAsk(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, confirm,
  }))

  assert.deepEqual(
    JSON.parse(await fs.readFile(folderAskPath(stateDir), 'utf8')),
    { version: 1, mode: 'sync' }
  )
})

test('a re-run defaults to the standing answer instead of resetting it', async () => {
  const { env, stateDir } = await makeHome()
  await writeFolderAskMode({ stateDir, mode: 'ask' })
  const { confirm, state } = capturingConfirm('ask')

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout: makeBuf(), stderr: makeBuf(), env, confirm,
  }))

  assert.equal(state.question.default, 'ask', 're-entering the wizard round-trips the preference')
  assert.deepEqual(result, { mode: 'ask' })
})

test('cancel and back leave the standing answer untouched', async () => {
  for (const [err, expected] of /** @type {const} */ ([
    [new PromptCancelledError(), 'cancelled'],
    [new PromptBackRequestedError(), 'back'],
  ])) {
    const { env, stateDir } = await makeHome()
    await writeFolderAskMode({ stateDir, mode: 'ask' })

    const result = await runWizardFolderAsk(/** @type {any} */ ({
      stdout: makeBuf(), stderr: makeBuf(), env,
      confirm: async () => { throw err },
    }))

    assert.equal(result[expected], true)
    assert.equal(result.mode, 'ask', 'the pre-existing mode is reported back')
    assert.equal(await readFolderAskMode({ stateDir }), 'ask', 'nothing was rewritten')
  }
})

test('autoAccept states the question and records the default without prompting (LLP 0201)', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    names: ['Claude Code', 'Codex'],
    autoAccept: true,
    confirm: async () => { throw new Error('the express path must not prompt') },
  }))

  assert.deepEqual(result, { mode: 'sync' })
  assert.equal(await readFolderAskMode({ stateDir }), 'sync')
  // Never silent: the statement the question would have shown is printed,
  // with the answer as an indented line completing the title's sentence
  // rather than a second flush-left announcement repeating the subject.
  assert.match(stdout.text(), /When opening Claude Code or Codex in a new project,/)
  assert.match(stdout.text(), /^ {2}it syncs automatically; change later with hyp privacy folders ask$/m)
})

test('an unwritable preference warns and leaves the previous mode standing', async () => {
  const { env, stateDir } = await makeHome()
  // A directory where the file belongs makes the atomic write fail.
  await fs.mkdir(folderAskPath(stateDir), { recursive: true })
  const stderr = makeBuf()

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout: makeBuf(), stderr, env,
    confirm: async () => 'ask',
  }))

  assert.equal(result.skipped, true)
  // A path that exists but cannot be read is a preference someone set that
  // we cannot interpret, so the safe read reports `ask` (LLP 0200
  // #fail-safe) and that is the mode left standing.
  assert.equal(result.mode, 'ask', 'the mode already in force is what is reported')
  assert.match(stderr.text(), /could not record the new-folder answer/)
  assert.match(stderr.text(), /hyp privacy folders ask/)
})

test('the two options are exactly sync and ask', () => {
  assert.deepEqual(FOLDER_ASK_OPTIONS.map((o) => o.value), ['sync', 'ask'])
})
