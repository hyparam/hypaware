// @ts-check

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { askableClients, framedQuestion, runAsk } from '../../../src/core/commands/ask.js'
import { RECOMMEND_COLD_PROMPT } from '../../../src/core/query/first_ask_evidence.js'
import { chooseLauncher } from '../../../src/core/cli/wizard/first_ask.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

// `hyp ask` may only start a client HypAware is actually recording
// (LLP 0198#path-probe). The bug this file pins: a status probe that
// *succeeds* and reports zero attached clients is evidence of detachment,
// not grounds to fall back to every launchable client on $PATH - only a
// thrown probe (one that could not read a settings file) is unknown rather
// than a "no". Before the fix, `askableClients` conflated the two by testing
// `attached.length > 0` instead of branching on the try/catch itself.
// @ref LLP 0198#path-probe [tests]: a successful zero-attached probe is a "no", not a fall-through

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {string} chunk */
    write(chunk) { chunks.push(String(chunk)); return true },
    text() { return chunks.join('') },
  }
}

/**
 * A minimal `CommandRunContext` stub. Only the fields `askableClients` and
 * `runAsk` touch are provided; `stdout`/`stdin` are plain objects so
 * `isTty` reads them as non-interactive, matching a piped or scripted run.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
function makeCtx(options = {}) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: options.env ?? {},
    stdout,
    stderr,
  }))
  return { ctx, stdout, stderr }
}

/* ------------------------------ askableClients ----------------------------- */

test('askableClients returns only attached clients when the probe succeeds', async () => {
  const { ctx } = makeCtx()
  const report = /** @type {any} */ ({
    clients: [
      { name: 'claude', plugin: '@hypaware/claude', configured: true, attachable: true, attached: true },
      { name: 'codex', plugin: '@hypaware/codex', configured: true, attachable: true, attached: false },
    ],
  })
  const clients = await askableClients(ctx, { collectStatus: async () => report })
  assert.deepEqual(clients, ['claude'])
})

test('askableClients returns an empty list when the probe succeeds with nothing attached, rather than falling back', async () => {
  const { ctx } = makeCtx()
  const report = /** @type {any} */ ({
    clients: [
      { name: 'claude', plugin: '@hypaware/claude', configured: false, attachable: true, attached: false },
      { name: 'codex', plugin: '@hypaware/codex', configured: false, attachable: false, attached: false },
    ],
  })
  const clients = await askableClients(ctx, { collectStatus: async () => report })
  assert.deepEqual(clients, [], 'a successful zero-attached probe must not fall through to the unfiltered list')
})

test('askableClients includes a configured client whose attach is n/a (codex in transcript mode)', async () => {
  const { ctx } = makeCtx()
  // Codex in transcript mode writes no marker, so status reports it
  // `configured, attach n/a`: it is recorded, just not through a settings file.
  const report = /** @type {any} */ ({
    clients: [
      { name: 'claude', plugin: '@hypaware/claude', configured: false, attachable: true, attached: false },
      { name: 'codex', plugin: '@hypaware/codex', configured: true, attachable: false, attached: false },
      { name: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: true, attachable: false, attached: false },
      // `attachable` is a required boolean every real row carries
      // (`status.js` derives it from the descriptor), so a row without one
      // is not a state to honour: it is a report shape nothing here
      // produces. The predicate therefore tests `=== false` rather than
      // falsiness, which would read a missing field as "attach n/a" and
      // offer every configured client on the machine.
      { name: 'ghost', plugin: '@hypaware/ghost', configured: true, attached: false },
    ],
  })
  const clients = await askableClients(ctx, { collectStatus: async () => report })
  assert.deepEqual(clients, ['codex', 'claude-desktop'])
})

test('framedQuestion tells the client to answer from HypAware history and keeps the question verbatim', () => {
  const prompt = framedQuestion('which sessions touched the auth module')
  assert.match(prompt, /HypAware history/)
  assert.match(prompt, /hyp query/)
  assert.ok(prompt.endsWith('Question: which sessions touched the auth module'))
})

test('chooseLauncher asks which client when more than one can answer, and skips the screen for one', async () => {
  const claude = { client: 'claude', label: 'Claude Code', bin: 'claude', binPath: '/bin/claude', args: ['{prompt}'] }
  const codex = { client: 'codex', label: 'Codex', bin: 'codex', binPath: '/bin/codex', args: ['{prompt}'] }
  /** @type {string[][]} */
  const shown = []
  /** @param {any} spec */
  const select = async (spec) => { shown.push(spec.options.map((/** @type {any} */ o) => o.value)); return 'codex' }
  assert.equal(await chooseLauncher({ launchers: [claude, codex], title: 't', env: {}, select }), codex)
  assert.deepEqual(shown, [['claude', 'codex']])
  assert.equal(await chooseLauncher({ launchers: [claude], title: 't', env: {}, select }), claude)
  assert.equal(shown.length, 1, 'a single launcher must not prompt')
  const cancel = async () => { const e = new Error('cancelled'); e.name = 'PromptCancelledError'; throw e }
  assert.equal(await chooseLauncher({ launchers: [claude, codex], title: 't', env: {}, select: cancel }), undefined)
})

test('askableClients falls back to launchable clients only when the probe throws', async () => {
  const { ctx } = makeCtx()
  const clients = await askableClients(ctx, {
    collectStatus: async () => { throw new Error('settings file unreadable') },
  })
  // The fallback is the real bundled-plugin launchable set (claude and codex
  // carry a `launch` block; claude-desktop, openclaw, opencode, and pi do
  // not), so this also pins that the fallback is non-empty and never invents
  // a client the catalog does not know about. OpenCode and Pi are recorded
  // but not launchable: neither is shipped the HypAware skills the prompts
  // lean on, so starting one would open a session that cannot follow them.
  assert.deepEqual([...clients].sort(), ['claude', 'codex'])
})

/* ---------------------------- exit-code contract ---------------------------- */

async function freshHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-cmd-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/**
 * An env for a machine with nothing on PATH and nothing recorded. `HOME` is
 * a temp directory because the status probe reads attach markers under it:
 * without one, a developer's own `~/.claude/settings.json` decides whether
 * a client counts as recorded, and the test passes or fails by machine.
 */
async function bareEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  return { HOME: home, HYP_HOME: await freshHome(), HYP_CONFIG: '', PATH: '' }
}

test('runAsk: no-launcher exits 1 on a fresh install with nothing attached', async () => {
  const { ctx, stdout, stderr } = makeCtx({ env: await bareEnv() })
  const code = await runAsk([], ctx)
  assert.equal(code, 1)
  // Not the question it cannot ask: the refusal and its repair.
  assert.equal(stdout.text(), '')
  assert.match(stderr.text(), /hyp ask: no client CLI found on your PATH/)
})

// @ref LLP 0198#path-probe [tests]: with or without a question, nothing launchable is the same refusal
test('runAsk: with nothing launchable, the bare ask and a named question say the same thing', async () => {
  const env = await bareEnv()
  const bare = makeCtx({ env })
  const named = makeCtx({ env })
  assert.equal(await runAsk([], bare.ctx), 1)
  assert.equal(await runAsk(['which sessions touched the auth module'], named.ctx), 1)
  assert.equal(bare.stderr.text(), named.stderr.text())
  assert.equal(bare.stdout.text(), named.stdout.text())
  assert.match(bare.stderr.text(), /hyp ask: no client CLI found on your PATH/)
})

// Launchability is two facts, and the repair differs by which one is missing.
// Attaching Codex on a machine with only Codex Desktop succeeds and still
// leaves nothing to start, so a missing CLI must never be answered with an
// attach command.
// @ref LLP 0139#repair-must-be-runnable [tests]: an attach is named only where an attach is the repair
test('runAsk: with no client CLI on PATH, the refusal names the binaries and never an attach', async () => {
  const { ctx, stdout, stderr } = makeCtx({ env: await bareEnv() })
  assert.equal(await runAsk([], ctx), 1)
  const text = stderr.text()
  // The names come from the descriptors, so a new adapter that declares a
  // `launch` block appears here without an edit.
  assert.match(text, /hyp ask: no client CLI found on your PATH \(looked for claude, codex\)\./)
  assert.match(text, /You can install one, then run `hyp ask` again\. If one is already installed, add its folder to your PATH\./)
  assert.doesNotMatch(text, /hyp client attach/)
  // Nothing is recorded here, so there is no desktop app worth pasting into.
  assert.doesNotMatch(text, /desktop app/)
  assert.equal(stdout.text(), '')
})

// The third case: a client is recorded and has no CLI, which is someone on a
// desktop app. Nothing can start the app, but it can be asked by hand, so the
// prompt is handed over: the explanation on stderr, the prompt alone on
// stdout, where a pipe to the clipboard takes exactly what to paste.
// @ref LLP 0198#path-probe [tests]: a recorded client with no CLI gets the prompt to paste, not a dead end
test('runAsk: a recorded client with no CLI is handed the prompt to paste into its desktop app', async () => {
  const env = await bareEnv()
  // Codex enabled in its default transcript mode: recorded, and no `codex`
  // on PATH. This is a machine with Codex Desktop and no Codex CLI.
  await fs.writeFile(
    path.join(env.HYP_HOME, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/codex' }] })
  )
  // The skill both prompts name, where the Codex app reads it.
  const skill = path.join(env.HOME, '.codex', 'skills', 'hypaware-query')
  await fs.mkdir(skill, { recursive: true })
  await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: hypaware-query\n---\n')
  const question = 'which sessions touched the auth module'
  const bare = makeCtx({ env })
  const named = makeCtx({ env })
  assert.equal(await runAsk([], bare.ctx), 1)
  assert.equal(await runAsk([question], named.ctx), 1)
  // The same explanation either way; only the prompt differs.
  assert.equal(bare.stderr.text(), named.stderr.text())
  assert.match(bare.stderr.text(), /hyp ask: no client CLI found on your PATH/)
  assert.match(bare.stderr.text(), /Using a desktop app instead\? You can paste this in:/)
  assert.doesNotMatch(bare.stderr.text(), /hyp client attach/)
  assert.equal(bare.stdout.text(), `${RECOMMEND_COLD_PROMPT}\n`)
  assert.equal(named.stdout.text(), `${framedQuestion(question)}\n`)
})

// Both prompts tell the app to use the hypaware-query skill. OpenCode and Pi
// are recorded but never shipped it, and a recorded Codex whose skills were
// not installed cannot read it either, so neither is handed a prompt that
// points at instructions the app does not have.
test('runAsk: a recorded client without the hypaware-query skill is not handed a prompt to paste', async () => {
  const question = 'which sessions touched the auth module'
  // An attached OpenCode: recorded, with no skill tree of ours.
  const opencode = await bareEnv()
  const plugins = path.join(opencode.HOME, '.config', 'opencode', 'plugins')
  await fs.mkdir(plugins, { recursive: true })
  await fs.writeFile(path.join(plugins, 'hypaware.js'), '// HYPWARE_OPENCODE_PLUGIN v1\n')
  // A recorded Codex whose skills were never installed.
  const codex = await bareEnv()
  await fs.writeFile(
    path.join(codex.HYP_HOME, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/codex' }] })
  )
  for (const env of [opencode, codex]) {
    for (const argv of [[], [question]]) {
      const { ctx, stdout, stderr } = makeCtx({ env })
      assert.equal(await runAsk(argv, ctx), 1)
      assert.match(stderr.text(), /hyp ask: no client CLI found on your PATH/)
      assert.doesNotMatch(stderr.text(), /desktop app/)
      assert.equal(stdout.text(), '')
    }
  }
})

// The launch prompt points at a folder only the gather creates. Pasted into
// an app that was never started there, it fails in exactly the way the gather
// exists to prevent, so the pasted form must stand on its own.
// @ref LLP 0398#one-question [tests]: the pasted form names no evidence folder
test('the cold recommendation prompt stands alone: no evidence folder, and it says how to look', () => {
  assert.doesNotMatch(RECOMMEND_COLD_PROMPT, /ASK\.md|this folder|already gathered/)
  assert.match(RECOMMEND_COLD_PROMPT, /^From my HypAware history/)
  assert.match(RECOMMEND_COLD_PROMPT, /`hyp query`/)
  assert.doesNotMatch(RECOMMEND_COLD_PROMPT, /\n/)
})

test('runAsk: a CLI on PATH that is not recorded is answered with the attach that repairs it', async () => {
  const hypHome = await freshHome()
  // A temp HOME, so the probe reads no attach marker from the real one.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  const bin = path.join(home, 'bin')
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const env = { HOME: home, HYP_HOME: hypHome, HYP_CONFIG: '', PATH: bin }
  const bare = makeCtx({ env })
  const named = makeCtx({ env })
  assert.equal(await runAsk([], bare.ctx), 1)
  assert.equal(await runAsk(['which sessions touched the auth module'], named.ctx), 1)
  assert.equal(bare.stderr.text(), named.stderr.text())
  const text = bare.stderr.text()
  assert.match(text, /hyp ask: Claude Code is installed, but HypAware is not recording it\./)
  // A command that can be typed: a real client name, never a placeholder.
  assert.match(text, /Run `hyp client attach claude`, then run `hyp ask` again\./)
  assert.doesNotMatch(text, /<client>/)
  assert.doesNotMatch(text, /codex|opencode|\bpi\b/)
})

// `--list` printed the question list back when there were several to choose
// among. With one question there is nothing to list, so the flag is gone and
// is refused like any other unknown flag rather than silently ignored.
test('runAsk: --list is no longer a flag', async () => {
  const hypHome = await freshHome()
  const { ctx, stdout, stderr } = makeCtx({ env: { HYP_HOME: hypHome, HYP_CONFIG: '', PATH: '' } })
  const code = await runAsk(['--list'], ctx)
  assert.notEqual(code, 0)
  assert.doesNotMatch(stdout.text(), /Worth asking your AI client/)
  assert.match(stderr.text(), /--list/)
})

// The three helpers above are each pinned on their own, but nothing reached
// the call site in `runAsk` that wires them together, so which client answers
// and what it is started on were both unpinned: a predicate that stopped
// offering transcript-mode Codex, or a frame that stopped carrying the typed
// question, would have regressed with every test still green. This drives the
// real command against a temp `HYP_HOME`, a temp `HOME`, and a stub `codex`
// alone on `PATH`, so the offer, the non-interactive pick, and the prompt
// handed to the client are one assertion each.
// @ref LLP 0429#status [tests]: a codex whose capture mode writes no marker is still a client `hyp ask` may start
test('runAsk "<question>": starts the transcript-mode codex it offers, on the framed question', async () => {
  const hypHome = await freshHome()
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  const bin = path.join(home, 'bin')
  await fs.mkdir(bin, { recursive: true })
  const promptFile = path.join(home, 'prompt.txt')
  // `launchClient` spawns with `stdio: 'inherit'`, so the stub records its
  // argument to a file rather than to a stream the test runner also owns.
  await fs.writeFile(path.join(bin, 'codex'), `#!/bin/sh\nprintf '%s' "$1" > '${promptFile}'\n`, { mode: 0o755 })
  // Codex enabled and in its default transcript mode: configured, attach n/a,
  // no marker anywhere under this `HOME`.
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/codex' }] })
  )
  const question = 'which sessions touched the auth module'
  const { ctx, stdout } = makeCtx({ env: { HOME: home, HYP_HOME: hypHome, PATH: bin } })
  const code = await runAsk([question], ctx)
  assert.equal(code, 0)
  assert.match(stdout.text(), /Starting Codex\.\.\./)
  assert.equal(await fs.readFile(promptFile, 'utf8'), framedQuestion(question))
})

/* ------------------------- the client picker's deadline --------------------- */

// A TTY says a terminal is attached, never that a person is reading it. Under
// a pty with nothing typed into it - `docker run -t`, a tty-allocating CI
// runner, expect - `isTTY` reads exactly as a human's terminal does, so
// `hyp ask "<question>"` drew the picker and waited for a keypress that never
// came: the named question was never asked and the run only ended when
// something killed it (#2373). These drive the whole multi-client branch of
// `runAsk`, which nothing reached before: the TTY gate, the picker, and the
// fallback a run nobody answers takes.

/**
 * Two launchable, recorded clients on a throwaway `HOME`: an attached claude
 * and codex in its default transcript mode (configured, attach n/a).
 * Each stub records that it ran, so which one was started is a file check
 * rather than a stream the test runner also owns.
 */
async function twoLauncherFixture() {
  const hypHome = await freshHome()
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  const bin = path.join(home, 'bin')
  await fs.mkdir(bin, { recursive: true })
  const ran = path.join(home, 'ran.txt')
  for (const name of ['claude', 'codex']) {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\nprintf '%s' '${name}' > '${ran}'\n`, { mode: 0o755 })
  }
  // claude's attach marker, so the status probe reports it recorded.
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ _hypaware: { version: 1 } }))
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/claude' }, { name: '@hypaware/codex' }] })
  )
  return {
    env: { HOME: home, HYP_HOME: hypHome, PATH: bin },
    async started() { return fs.readFile(ran, 'utf8').catch(() => '') },
  }
}

/** A stdout that claims a terminal, as a pty's does. */
function makeTtyOut() {
  const buf = makeBuf()
  return Object.assign(buf, { isTTY: true, columns: 80, rows: 24 })
}

/** A stdin that claims a terminal and delivers nothing, as an unattended pty's does. */
function makeSilentTtyIn() {
  const stdin = new EventEmitter()
  return Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    /** @param {boolean} v */
    setRawMode(v) { this.isRaw = v; return this },
    resume() { return this },
    pause() { return this },
    isPaused() { return false },
  })
}

test('runAsk "<question>": an allocated tty nobody answers starts a client instead of waiting for a keypress', { timeout: 5000 }, async () => {
  const fixture = await twoLauncherFixture()
  const stdout = makeTtyOut()
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: fixture.env, stdout, stderr: makeBuf(), stdin: makeSilentTtyIn(),
  }))
  // The real prompt, drawn on the real runtime: what is stubbed is the
  // deadline's length, not the branch under test.
  const code = await runAsk(['which sessions touched the auth module'], ctx, { pickDeadlineMs: 50 })
  assert.equal(code, 0)
  assert.match(stdout.text(), /No answer at the client prompt - starting the first one\./)
  assert.match(stdout.text(), /Starting Claude Code\.\.\./)
  assert.equal(await fixture.started(), 'claude')
})

test('runAsk "<question>": a terminal someone answers still starts the client they picked', { timeout: 5000 }, async () => {
  const fixture = await twoLauncherFixture()
  const stdout = makeTtyOut()
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: fixture.env, stdout, stderr: makeBuf(), stdin: makeSilentTtyIn(),
  }))
  /** @type {Array<string | number>} */
  let offered = []
  const code = await runAsk(['which sessions touched the auth module'], ctx, {
    /** @param {any} spec */
    select: async (spec) => {
      offered = spec.options.map((/** @type {any} */ o) => o.value)
      return 'codex'
    },
  })
  assert.equal(code, 0)
  assert.deepEqual(offered, ['claude', 'codex'])
  assert.equal(await fixture.started(), 'codex')
  assert.doesNotMatch(stdout.text(), /No answer at the client prompt/)
})

test('runAsk "<question>": escaping the picker is "not now", not the deadline fallback', { timeout: 5000 }, async () => {
  const fixture = await twoLauncherFixture()
  const stdout = makeTtyOut()
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: fixture.env, stdout, stderr: makeBuf(), stdin: makeSilentTtyIn(),
  }))
  const code = await runAsk(['which sessions touched the auth module'], ctx, {
    select: async () => { const e = new Error('cancelled'); e.name = 'PromptCancelledError'; throw e },
  })
  assert.equal(code, 0)
  assert.match(stdout.text(), /Nothing started\./)
  assert.equal(await fixture.started(), '', 'an escape must start nothing')
})

test('runAsk "<question>": a piped run never reaches the picker at all', async () => {
  const fixture = await twoLauncherFixture()
  const { ctx } = makeCtx({ env: fixture.env })
  let asked = false
  const code = await runAsk(['which sessions touched the auth module'], ctx, {
    select: async () => { asked = true; return 'codex' },
  })
  assert.equal(code, 0)
  assert.equal(asked, false, 'a run off a terminal must not prompt')
  assert.equal(await fixture.started(), 'claude')
})

/* --------- the deadline, and the byte that is not a keypress (#2392) -------- */

// A pty whose input has reached EOF (`script ... < /dev/null`) is sent a NUL
// byte, and readline decodes it into a keypress like any other. The deadline
// lifted on it, so the one unattended pty shape that speaks before falling
// silent kept the picker on screen forever: measured under a real `script`
// pty at EOF, a run with a 300ms deadline was still unsettled when it was
// killed 20s later, and after the fix it settled at 320ms.
//
// These cases emit the keypress that pty delivered rather than opening one:
// the delivery is simulated, the shape is measured. Under
// `script -qec 'node ...' /dev/null < /dev/null` on node 22 exactly one event
// arrives, `str` = `\0` with
// `key = { sequence: '\0', name: '`', ctrl: true, meta: false, shift: false }`.
// It carries a `name`, which is why the guard reads the sequence.

/** The keypress a pty at EOF delivers, as measured. `\0`, never the raw byte. */
const NON_KEY_BYTE_PRESS = {
  str: '\0',
  key: { sequence: '\0', name: '`', ctrl: true, meta: false, shift: false },
}

/**
 * A stdin that claims a terminal and delivers `events` once the prompt is
 * listening. `resume()` is the hook: the TUI runtime calls it directly after
 * it attaches its `keypress` listener, so a delivery scheduled there cannot
 * race the listener it is meant for.
 *
 * @param {Array<{ after?: number, str?: string, key?: object }>} events
 */
function makeKeyedTtyIn(events) {
  const stdin = new EventEmitter()
  let delivered = false
  return Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    /** @param {boolean} v */
    setRawMode(v) { this.isRaw = v; return this },
    resume() {
      if (delivered) return this
      delivered = true
      for (const { after = 0, str, key } of events) {
        setTimeout(() => stdin.emit('keypress', str, key), after)
      }
      return this
    },
    pause() { return this },
    isPaused() { return false },
  })
}

test('runAsk "<question>": a NUL byte off a pty at EOF does not lift the deadline', { timeout: 5000 }, async () => {
  const fixture = await twoLauncherFixture()
  const stdout = makeTtyOut()
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: fixture.env,
    stdout,
    stderr: makeBuf(),
    stdin: makeKeyedTtyIn([NON_KEY_BYTE_PRESS]),
  }))
  const code = await runAsk(['which sessions touched the auth module'], ctx, { pickDeadlineMs: 50 })
  assert.equal(code, 0)
  assert.match(stdout.text(), /No answer at the client prompt - starting the first one\./)
  assert.equal(await fixture.started(), 'claude')
})

test('runAsk "<question>": a real keypress still lifts the deadline, stray byte or not', { timeout: 5000 }, async () => {
  const fixture = await twoLauncherFixture()
  const stdout = makeTtyOut()
  // The NUL, then down, then enter well past a 50ms deadline: a reader who
  // takes their time must not be cut off mid-decision (#2391), and the pick
  // that lands has to be theirs rather than the fallback's first client. The
  // byte comes first because the lift listens with `on`, not `once`: a `once`
  // listener is spent by the byte it declines to act on, and the keystroke
  // behind it would then find nothing left to lift.
  const ctx = /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: fixture.env,
    stdout,
    stderr: makeBuf(),
    stdin: makeKeyedTtyIn([
      NON_KEY_BYTE_PRESS,
      { key: { sequence: '\x1b[B', name: 'down' } },
      { after: 400, str: '\r', key: { sequence: '\r', name: 'return' } },
    ]),
  }))
  const code = await runAsk(['which sessions touched the auth module'], ctx, { pickDeadlineMs: 50 })
  assert.equal(code, 0)
  assert.doesNotMatch(stdout.text(), /No answer at the client prompt/)
  assert.equal(await fixture.started(), 'codex')
})
