// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { askableClients, runAsk } from '../../../src/core/commands/ask.js'

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

test('askableClients falls back to launchable clients only when the probe throws', async () => {
  const { ctx } = makeCtx()
  const clients = await askableClients(ctx, {
    collectStatus: async () => { throw new Error('settings file unreadable') },
  })
  // The fallback is the real bundled-plugin launchable set (claude, codex,
  // and opencode carry a `launch` block; claude-desktop and openclaw do not), so
  // this also pins that the fallback is non-empty and never invents a
  // client the catalog does not know about.
  assert.deepEqual([...clients].sort(), ['claude', 'codex', 'opencode'])
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
  assert.match(stdout.text(), /Questions worth asking/)
})

test('runAsk: --list exits 0 regardless of launchability', async () => {
  const hypHome = await freshHome()
  const { ctx, stdout } = makeCtx({ env: { HYP_HOME: hypHome, HYP_CONFIG: '', PATH: '' } })
  const code = await runAsk(['--list'], ctx)
  assert.equal(code, 0)
  assert.match(stdout.text(), /Questions worth asking/)
})

/* --------------------------------- N7 -------------------------------------- */

// `hyp ask --list` used to pass `launchable: true` unconditionally, so a
// machine with nothing on `$PATH` printed "Run `hyp ask` to pick one of
// these and start your client on it" for a command that would exit 1.
// @ref LLP 0198#path-probe [tests]: --list's launchability claim matches whether anything can actually be started
test('runAsk: --list on a host with nothing launchable prints the manual fallback, not a launch promise', async () => {
  const hypHome = await freshHome()
  const { ctx, stdout } = makeCtx({ env: { HYP_HOME: hypHome, HYP_CONFIG: '', PATH: '' } })
  await runAsk(['--list'], ctx)
  const text = stdout.text()
  assert.match(text, /Paste one into a Claude Code or Codex session/)
  assert.doesNotMatch(text, /Run `hyp ask` to pick one of these/)
})
