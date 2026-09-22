// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { askableClients, runAsk } from '../../../src/core/commands/ask.js'
import { buildWalkthroughClientDescriptorMap } from '../../../src/core/cli/walkthrough.js'
import { resolveLaunchers } from '../../../src/core/cli/wizard/first_ask.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

// `hyp ask` may only start a client HypAware is actually recording
// (LLP 0198#path-probe). Both ways of not getting a "yes" are pinned here:
// a probe that succeeds reporting zero attached clients is evidence of
// detachment, and a probe that throws is no evidence at all. Neither is
// grounds to fall back to every launchable client on $PATH, so a launch is
// only ever made on a positive answer.
// @ref LLP 0198#path-probe [tests]: only an attached client is started, whichever way the probe answers

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
      { name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true },
      { name: 'codex', plugin: '@hypaware/codex', configured: true, attached: false },
    ],
  })
  const clients = await askableClients(ctx, { collectStatus: async () => report })
  assert.deepEqual(clients, ['claude'])
})

test('askableClients returns an empty list when the probe succeeds with nothing attached, rather than falling back', async () => {
  const { ctx } = makeCtx()
  const report = /** @type {any} */ ({
    clients: [
      { name: 'claude', plugin: '@hypaware/claude', configured: false, attached: false },
      { name: 'codex', plugin: '@hypaware/codex', configured: false, attached: false },
    ],
  })
  const clients = await askableClients(ctx, { collectStatus: async () => report })
  assert.deepEqual(clients, [], 'a successful zero-attached probe must not fall through to the unfiltered list')
})

test('askableClients starts nothing when the probe throws, rather than falling open to every launchable client', async () => {
  const { ctx, stderr } = makeCtx()
  const clients = await askableClients(ctx, {
    collectStatus: async () => { throw new Error('settings file unreadable') },
  })
  assert.deepEqual(clients, [], 'an unreadable probe is not evidence that any client is attached')
  // The caller's no-launcher line says "no attached client can be started
  // here", which this path has no evidence for, so the reason is printed
  // where it is known and names something to run.
  assert.match(stderr.text(), /could not read which clients are attached: settings file unreadable/)
  assert.match(stderr.text(), /hyp status/)
})

test('a thrown probe leaves no launcher, so both callers refuse instead of starting an unattached client', async () => {
  const { ctx } = makeCtx()
  const clients = await askableClients(ctx, {
    collectStatus: async () => { throw new Error('settings file unreadable') },
  })
  // Every launch binary resolves, so nothing but the empty client list can
  // hold a launcher back: the fall-through used to hand `resolveLaunchers`
  // the whole launchable set (claude, codex and opencode carry a `launch`
  // block; claude-desktop and openclaw do not) and a client started. This is
  // the seam `hyp ask` and `hyp report fix` both go through, so an empty
  // result is the refusal in both.
  const descriptors = await buildWalkthroughClientDescriptorMap()
  const launchers = await resolveLaunchers({
    clients,
    descriptors,
    env: {},
    resolve: async () => '/usr/local/bin/stub',
  })
  assert.deepEqual(launchers, [], 'nothing is launchable when nothing was shown to be attached')
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
  assert.match(text, /Attach one with `hyp client attach claude` \(or codex, opencode\)/)
  assert.doesNotMatch(text, /<client>/)
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
  assert.match(text, /Once an attached client can be started here \(see `hyp status`\), run `hyp ask` again/)
  assert.doesNotMatch(text, /Run `hyp ask` to start your client on it/)
})
