// @ts-check

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { askableClients, framedQuestion, runAsk } from '../../../src/core/commands/ask.js'
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
  // The fallback is the real bundled-plugin launchable set (claude, codex,
  // opencode, and pi carry a `launch` block; claude-desktop and openclaw do not), so
  // this also pins that the fallback is non-empty and never invents a
  // client the catalog does not know about.
  assert.deepEqual([...clients].sort(), ['claude', 'codex', 'opencode', 'pi'])
})

/* ---------------------------- exit-code contract ---------------------------- */

async function freshHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-cmd-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

test('runAsk: no-launcher exits 1 on a fresh install with nothing attached', async () => {
  const hypHome = await freshHome()
  const { ctx, stdout } = makeCtx({ env: { HYP_HOME: hypHome, HYP_CONFIG: '', PATH: '' } })
  const code = await runAsk([], ctx)
  assert.equal(code, 1)
  // The no-launcher variant is the printed list, not a client launch.
  assert.match(stdout.text(), /Worth asking your AI client/)
})

test('runAsk: --list exits 0 regardless of launchability', async () => {
  const hypHome = await freshHome()
  const { ctx, stdout } = makeCtx({ env: { HYP_HOME: hypHome, HYP_CONFIG: '', PATH: '' } })
  const code = await runAsk(['--list'], ctx)
  assert.equal(code, 0)
  assert.match(stdout.text(), /Worth asking your AI client/)
})

// A hint that cannot be typed is not a repair. `hyp client attach <client>`
// reads as an input redirection from a file called `client` in every shell
// the CLI runs under, and answers `unknown client` when typed literally, so
// the line names one of the launchable clients outright. The names come from
// the descriptors, not a literal, so a new adapter that declares a `launch`
// block appears here without an edit.
// @ref LLP 0139#repair-must-be-runnable [tests]: the no-launcher hint prints a command that runs
test('runAsk "<question>": the no-launcher hint names real clients, not a placeholder', async () => {
  const hypHome = await freshHome()
  const { ctx, stderr } = makeCtx({ env: { HYP_HOME: hypHome, HYP_CONFIG: '', PATH: '' } })
  const code = await runAsk(['which sessions touched the auth module'], ctx)
  assert.equal(code, 1)
  const text = stderr.text()
  // The set it refuses on is `askableClients`, which keeps a client that is
  // attached *or* configured with no attach marker to write, so the line can
  // only say "recorded" without contradicting the offer.
  assert.match(text, /hyp ask: no recorded client can be started here\./)
  assert.match(text, /Attach one with `hyp client attach claude` \(or codex, opencode, pi\)/)
  assert.doesNotMatch(text, /<client>/)
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

/* --------------------------------- N7 -------------------------------------- */

// `hyp ask --list` used to pass `launchable: true` unconditionally, so a
// machine with nothing on `$PATH` printed "Run `hyp ask` to pick one of
// these and start your client on it" for a command that would exit 1.
// @ref LLP 0198#path-probe [tests]: --list's launchability claim matches whether anything can actually be started
test('runAsk: --list on a host with nothing launchable names the condition for a launch, not a launch promise', async () => {
  const hypHome = await freshHome()
  const { ctx, stdout } = makeCtx({ env: { HYP_HOME: hypHome, HYP_CONFIG: '', PATH: '' } })
  await runAsk(['--list'], ctx)
  const text = stdout.text()
  assert.match(text, /Once a recorded client can be started here \(see `hyp status`\), run `hyp ask` again/)
  assert.doesNotMatch(text, /attached client/)
  assert.doesNotMatch(text, /Run `hyp ask` to start your client on it/)
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
 * Two launchable, recorded clients on a throwaway `HOME`: codex in its
 * default transcript mode (configured, attach n/a) and an attached opencode.
 * Each stub records that it ran, so which one was started is a file check
 * rather than a stream the test runner also owns.
 */
async function twoLauncherFixture() {
  const hypHome = await freshHome()
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  const bin = path.join(home, 'bin')
  await fs.mkdir(bin, { recursive: true })
  const ran = path.join(home, 'ran.txt')
  for (const name of ['codex', 'opencode']) {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\nprintf '%s' '${name}' > '${ran}'\n`, { mode: 0o755 })
  }
  // opencode's attach marker, so the status probe reports it recorded.
  const plugins = path.join(home, '.config', 'opencode', 'plugins')
  await fs.mkdir(plugins, { recursive: true })
  await fs.writeFile(path.join(plugins, 'hypaware.js'), '// HYPWARE_OPENCODE_PLUGIN v1\n')
  await fs.writeFile(
    path.join(hypHome, 'hypaware-config.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/codex' }, { name: '@hypaware/opencode' }] })
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
  assert.match(stdout.text(), /Starting Codex\.\.\./)
  assert.equal(await fixture.started(), 'codex')
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
      return 'opencode'
    },
  })
  assert.equal(code, 0)
  assert.deepEqual(offered, ['codex', 'opencode'])
  assert.equal(await fixture.started(), 'opencode')
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
    select: async () => { asked = true; return 'opencode' },
  })
  assert.equal(code, 0)
  assert.equal(asked, false, 'a run off a terminal must not prompt')
  assert.equal(await fixture.started(), 'codex')
})
