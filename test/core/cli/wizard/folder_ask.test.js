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

test('an express accept round-trips the standing answer instead of resetting it', async () => {
  const { env, stateDir } = await makeHome()
  const stdout = makeBuf()
  await writeFolderAskMode({ stateDir, mode: 'ask' })

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout, stderr: makeBuf(), env,
    names: ['Claude Code'],
    autoAccept: true,
    confirm: async () => { throw new Error('the express path must not prompt') },
  }))

  // The prompted arm round-trips through `default: before` (the test
  // above). The auto-accepted arm has to reach the same answer: LLP 0200
  // #wizard binds the round-trip to the re-run, not to the prompt shape,
  // and flipping a deliberate 'ask' to 'sync' silently weakens a
  // preference the user set with `hyp privacy folders ask`.
  // @ref LLP 0200#wizard [tests]: the auto-accepted arm round-trips the preference too
  assert.deepEqual(result, { mode: 'ask' })
  assert.equal(await readFolderAskMode({ stateDir }), 'ask', 'the standing answer was not overwritten')
  // And the screen reports what is now true, not the constant.
  assert.match(stdout.text(), /^ {2}you are asked the first time; change later with hyp privacy folders sync$/m)
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

test(`a failed write still finishes the narrated title's sentence on stdout`, async () => {
  const { env, stateDir } = await makeHome()
  // A directory where the file belongs makes the atomic write fail, and
  // makes the safe read answer 'ask' (LLP 0200 #fail-safe), so 'ask' is
  // the mode standing when the write does not land.
  await fs.mkdir(folderAskPath(stateDir), { recursive: true })
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout, stderr, env,
    names: ['Claude Code'],
    autoAccept: true,
    confirm: async () => { throw new Error('the express path must not prompt') },
  }))

  assert.equal(result.skipped, true)
  assert.equal(result.mode, 'ask', 'the mode already in force is what stands')
  // On the narrated path the title is a sentence lead-in ending in a
  // comma, completed by the indented clause under it. A failed write used
  // to return before writing that clause, leaving a half-written question
  // on screen with the next phase's output under it while the whole
  // explanation went to stderr.
  // @ref LLP 0201#narrate [tests]: the narrated question is finished on stdout even when the write behind it fails
  const out = stdout.text()
  assert.match(out, /^When opening Claude Code in a new project,$/m)
  assert.match(out, /^ {2}you are asked the first time$/m)
  // Still one sentence, not two answers: the recorded-answer form (with
  // its "change later with" tail) is not what an unrecorded answer says.
  assert.doesNotMatch(out, /change later with/)
  // And the failure itself is still reported, in full, on stderr.
  assert.match(stderr.text(), /could not record the new-folder answer/)
  assert.match(stderr.text(), /it stays 'ask'/)
})

test('a failed write keeps the narrated sentence contiguous on the screen', async () => {
  const { env, stateDir } = await makeHome()
  await fs.mkdir(folderAskPath(stateDir), { recursive: true })
  // One sink for both streams: on the attended run this narration exists
  // for, stdout and stderr are the same terminal, and the order the user
  // reads is the order the writes happen in. Asserting each stream on its
  // own cannot see that - it is how a warning came to sit between the
  // title's lead-in and the clause completing it, which is the same
  // half-written question the completing clause was added to close.
  // @ref LLP 0201#narrate [tests]: the completed sentence is contiguous on a terminal, with the warning under it rather than inside it
  const screen = makeBuf()

  await runWizardFolderAsk(/** @type {any} */ ({
    stdout: screen, stderr: screen, env,
    names: ['Claude Code'],
    autoAccept: true,
    confirm: async () => { throw new Error('the express path must not prompt') },
  }))

  const lines = screen.text().split('\n').filter((l) => l !== '')
  assert.deepEqual(
    [lines[0], lines[1], lines[2]?.slice(0, 7)],
    ['When opening Claude Code in a new project,', '  you are asked the first time', 'warning'],
    `the sentence must finish before the warning; the screen read:\n${screen.text()}`
  )
})

// The failed-write arm is documented as one that warns and leaves the
// previous mode standing "rather than failing the run" (LLP 0200 #wizard).
// Its own two writes were the one way it could still fail it: a stream
// that throws between the write that opened the sentence and the writes
// that close it took the whole run down from inside the arm that exists
// to keep the run alive. Each write is now guarded on its own, so neither
// half can take the other, or the run, with it.
// @ref LLP 0200#wizard [tests]: the failed-write arm cannot fail the run, including through its own writes

/**
 * A stream that writes normally until the nth write, which throws. The
 * realistic shape: a pipe closes between two writes of the same block,
 * not before the first one.
 *
 * @param {number} failOn 1-based index of the write that throws
 */
function throwingBuf(failOn) {
  let value = ''
  let writes = 0
  return {
    /** @param {string} chunk */
    write(chunk) {
      writes += 1
      if (writes === failOn) throw new Error('EPIPE: broken pipe')
      value += String(chunk)
      return true
    },
    text() { return value },
  }
}

test('a failed write survives a stdout that dies mid-sentence, and still warns', async () => {
  const { env, stateDir } = await makeHome()
  await fs.mkdir(folderAskPath(stateDir), { recursive: true })
  // Write 1 is the narrated title; write 2 is the clause completing it.
  const stdout = throwingBuf(2)
  const stderr = makeBuf()

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout, stderr, env,
    names: ['Claude Code'],
    autoAccept: true,
    confirm: async () => { throw new Error('the express path must not prompt') },
  }))

  assert.equal(result.skipped, true)
  assert.equal(result.mode, 'ask', 'the mode already in force is what stands')
  // The half that could still be written was written: a stdout that gave
  // up must not swallow the explanation of why nothing was recorded.
  assert.match(stderr.text(), /could not record the new-folder answer/)
  assert.match(stderr.text(), /it stays 'ask'/)
})

test('a failed write survives a stderr that cannot take the warning', async () => {
  const { env, stateDir } = await makeHome()
  await fs.mkdir(folderAskPath(stateDir), { recursive: true })
  const stdout = makeBuf()
  const stderr = throwingBuf(1)

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout, stderr, env,
    names: ['Claude Code'],
    autoAccept: true,
    confirm: async () => { throw new Error('the express path must not prompt') },
  }))

  assert.equal(result.skipped, true)
  assert.equal(result.mode, 'ask', 'the mode already in force is what stands')
  // stdout was healthy, so the narrated sentence is still finished on it.
  assert.match(stdout.text(), /^When opening Claude Code in a new project,$/m)
  assert.match(stdout.text(), /^ {2}you are asked the first time$/m)
})

test('the asked path survives a stderr that cannot take the warning', async () => {
  const { env, stateDir } = await makeHome()
  await fs.mkdir(folderAskPath(stateDir), { recursive: true })

  const result = await runWizardFolderAsk(/** @type {any} */ ({
    stdout: makeBuf(), stderr: throwingBuf(1), env,
    confirm: async () => 'ask',
  }))

  assert.equal(result.skipped, true)
  assert.equal(result.mode, 'ask')
})

test('the two options are exactly sync and ask', () => {
  assert.deepEqual(FOLDER_ASK_OPTIONS.map((o) => o.value), ['sync', 'ask'])
})
