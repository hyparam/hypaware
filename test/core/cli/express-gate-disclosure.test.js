// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { render } from '../../../src/core/cli/tui/render.js'
import { defaultConfirmSelectPromptFactory } from '../../../src/core/cli/walkthrough.js'
import { runWizardExpressGate } from '../../../src/core/cli/wizard/express.js'

// The express gate's accept row carries the only side-effect disclosure on
// the wizard's happy path ("Configures ... to record ... through
// HypAware."): the express accept never opens the pick menu, whose per-row
// summaries carry the specifics. The wizard test layer pins the wording on
// the question object; these tests pin it on the *screen*, on both prompt
// paths, because a summary that no renderer forwards is a disclosure the
// user never reads. The spec layer alone stayed green the first time the
// copy went missing, and pinning only the tool names let it go missing a
// second time - hence the shape assertion in `acceptSummary` below.
// @ref LLP 0201#gate [tests]: the disclosure is asserted in the rendered
// bytes, not just on the question spec, so dropping the forwarding fails here
// @ref LLP 0190#pick-gate [tests]: the happy-path accept row still says that accepting configures the listed tools

/**
 * Build a pair of PassThrough streams the TUI runtime accepts as a
 * terminal, collecting everything written so a test can assert on the
 * frames that reached the screen.
 */
function makeTty() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.defineProperty(stdin, 'isTTY', { value: true })
  Object.defineProperty(stdout, 'isTTY', { value: true })
  Object.defineProperty(stdin, 'isRaw', { value: false, writable: true })
  // @ts-expect-error: PassThrough does not declare setRawMode but the runtime probes for it.
  stdin.setRawMode = (enabled) => {
    /** @type {any} */ (stdin).isRaw = enabled
  }
  /** @type {string[]} */
  const writes = []
  stdout.on('data', (chunk) => writes.push(String(chunk)))
  return { stdin, stdout, output: () => writes.join('') }
}

/**
 * The real gate question, captured off `runWizardExpressGate` rather than
 * hand-written here: the tests then replay the shipped copy through the
 * shipped renderers, so neither end can drift without the other noticing.
 *
 * @type {Promise<any> | null}
 */
let gateQuestionPromise = null

/** @returns {Promise<any>} */
function gateQuestion() {
  gateQuestionPromise ??= captureGateQuestion()
  return gateQuestionPromise
}

/** @returns {Promise<any>} */
async function captureGateQuestion() {
  /** @type {{ question: any }} */
  const state = { question: null }
  const sink = { write() { return true } }
  const choice = await runWizardExpressGate(/** @type {any} */ ({
    stdout: sink,
    stderr: sink,
    env: {},
    rows: ['Claude Code', 'Codex'],
    enrolled: true,
    confirm: async (/** @type {any} */ question) => {
      state.question = question
      return 'defaults'
    },
  }))
  assert.equal(choice, 'defaults')
  assert.ok(state.question, 'the wizard asked the express gate')
  return state.question
}

/**
 * The disclosure the gate's accept option must show. Read off the live
 * question so a copy edit in `express.js` travels here for free; the
 * wording itself is pinned at the spec layer by `express.test.js`.
 *
 * @returns {Promise<string>}
 */
async function acceptSummary() {
  const question = await gateQuestion()
  const accept = question.options.find((/** @type {any} */ o) => o.value === 'defaults')
  assert.ok(accept?.summary, 'the gate spec still carries the accept disclosure')
  // Not just "some summary": the summary has to be the side-effect
  // disclosure. A copy edit that keeps a sentence here but drops the
  // configuring verb leaves the happy path stating nothing about what
  // accepting does to the machine (LLP 0190 #pick-gate).
  assert.match(accept.summary, /configures/i, 'the accept row discloses that accepting configures the tools')
  return accept.summary
}

/**
 * Write the given chunks to stdin one tick apart so the keypress parser
 * flushes between them.
 *
 * @param {PassThrough} stdin
 * @param {string[]} chunks
 */
async function feed(stdin, chunks) {
  for (const c of chunks) {
    stdin.write(c)
    await new Promise((r) => setImmediate(r))
  }
}

// --- the renderer itself (TTY path, bottom layer) ---

test('renderSelect: an option summary lands on its own indented line under its row', () => {
  /** @type {any} */
  const state = {
    kind: 'select',
    title: 'Set up recording',
    options: [
      { value: 'defaults', label: 'Record and sync everything', summary: 'Configures Claude Code to record through HypAware.' },
      { value: 'choose', label: 'Customize', summary: 'Choose what to record, what syncs, and how new folders are handled.' },
    ],
    cursor: 0,
    status: 'active',
  }
  const lines = render(state, { color: false }).split('\n')

  const cursorRow = lines.findIndex((l) => l.trim() === '> Record and sync everything')
  assert.notEqual(cursorRow, -1, 'the cursor row rendered')
  assert.equal(lines[cursorRow + 1], '    Configures Claude Code to record through HypAware.')

  // Rows the cursor is not on disclose too: the summary is documentation of
  // the row, not a property of the selection.
  const otherRow = lines.findIndex((l) => l.trim() === 'Customize')
  assert.notEqual(otherRow, -1, 'the non-cursor row rendered')
  assert.equal(lines[otherRow + 1], '    Choose what to record, what syncs, and how new folders are handled.')
})

test('renderSelect: the summary line is dim, not the row colour', () => {
  /** @type {any} */
  const state = {
    kind: 'select',
    title: 'Set up recording',
    options: [{ value: 'defaults', label: 'Record and sync everything', summary: 'Configures Claude Code to record through HypAware.' }],
    cursor: 0,
    status: 'active',
  }
  const summaryLine = render(state, { color: true })
    .split('\n')
    .find((l) => l.includes('Configures Claude Code to record through HypAware.'))
  assert.ok(summaryLine, 'the summary reached the coloured frame too')
  assert.match(summaryLine, /\x1b\[2m/, 'summaries render dim (LLP 0189 palette)')
})

// --- the whole TTY path: question spec -> select() -> SelectState -> frame ---

test('TTY gate: the accept disclosure reaches the screen through the real select prompt', async () => {
  const summary = await acceptSummary()
  const question = await gateQuestion()
  const io = makeTty()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (io.stdin),
    stdout: /** @type {any} */ (io.stdout),
    // No HYP_NO_TUI, so the router picks the TUI; NO_COLOR keeps the frame
    // plain so the assertion reads the text and not the escapes.
    env: { NO_COLOR: '1' },
  })
  const answered = ask(question)
  await feed(io.stdin, ['\r'])
  assert.equal(await answered, 'defaults')

  const screen = io.output()
  assert.ok(
    screen.includes(summary),
    `the TUI gate must print the accept disclosure; frame was:\n${screen}`
  )
  // Under its own row, not floating somewhere else in the frame.
  const lines = screen.split('\n')
  const row = lines.findIndex((l) => l.includes('Record and sync everything'))
  assert.notEqual(row, -1, 'the accept row rendered')
  assert.ok(lines[row + 1].includes(summary), 'the disclosure sits directly under the accept row')
})

test('TTY gate: the decline row names every question declining opens, on screen', async () => {
  const question = await gateQuestion()
  const decline = question.options.find((/** @type {any} */ o) => o.value === 'choose')
  assert.ok(decline?.summary, 'the gate spec still carries the decline gloss')
  const io = makeTty()
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (io.stdin),
    stdout: /** @type {any} */ (io.stdout),
    env: { NO_COLOR: '1' },
  })
  const answered = ask(question)
  await feed(io.stdin, ['\r'])
  assert.equal(await answered, 'defaults')

  const lines = io.output().split('\n')
  const row = lines.findIndex((l) => /^\s*Customize$/.test(l.replace(/\s+$/, '')))
  assert.notEqual(row, -1, 'the decline row rendered')
  const gloss = lines[row + 1]
  assert.ok(gloss.includes(decline.summary), 'the gloss sits directly under the decline row')
  // The three questions an enrolled decline opens, on the screen the user
  // decides on. The spec layer pins the exact sentence; this pins that the
  // renderer forwards all of it, because a gloss the frame truncates or
  // drops is a disclosure the user never reads.
  // @ref LLP 0201#decline [tests]: all three lanes are named in the rendered frame, not just on the spec
  for (const clause of ['what to record', 'what syncs', 'how new folders are handled']) {
    assert.ok(gloss.includes(clause), `the decline gloss must name "${clause}"; it read: ${gloss}`)
  }
})

// --- the non-TTY numbered fallback ---

test('non-TTY gate: the numbered fallback prints the accept disclosure under its row', async () => {
  const summary = await acceptSummary()
  const question = await gateQuestion()
  const input = new PassThrough()
  let screen = ''
  const stdout = {
    /** @param {string} chunk */
    write(chunk) {
      screen += String(chunk)
      // Answer as soon as the fallback asks, so the readline settles.
      if (String(chunk).startsWith('select')) {
        input.write('1\n')
        input.end()
      }
      return true
    },
  }
  // Plain PassThrough streams are not TTYs, so the router takes the legacy
  // path without needing HYP_NO_TUI.
  const ask = defaultConfirmSelectPromptFactory({
    stdin: /** @type {any} */ (input),
    stdout: /** @type {any} */ (stdout),
    env: {},
  })
  assert.equal(await ask(question), 'defaults')

  assert.ok(
    screen.includes(summary),
    `the legacy gate must print the accept disclosure; output was:\n${screen}`
  )
  const lines = screen.split('\n')
  const row = lines.findIndex((l) => /^\s*1\) Record and sync everything$/.test(l))
  assert.notEqual(row, -1, 'the numbered accept row rendered')
  assert.ok(lines[row + 1].includes(summary), 'the disclosure sits directly under the numbered row')
})
