// @ts-check

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// `hyp attach all` used to silently expand only the live-registered subset,
// dropping every catalog-known client whose adapter never enabled with no
// explanation. It must instead name each one as a note, without prompting,
// erroring, or changing the exit code for the live subset it still attaches.
//
// The real bundled catalog (claude, codex, openclaw, claude-desktop) is used
// unmocked here, same as attach-enablement-state.test.js, so the fixture
// registers all-but-one live and leaves the remaining one - openclaw - as
// the "known but not enabled" case under test.
//
// @ref LLP 0174#detection [tests]: `hyp attach all` reports known-but-not-
// enabled clients as notes instead of dispatching only the live subset

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * @param {{ home: string, registered: string[] }} opts
 */
function makeCtx({ home, registered }) {
  const gateway = {
    localEndpoint() {
      return 'http://127.0.0.1:60680'
    },
    /** @param {string} name */
    getClient(name) {
      if (!registered.includes(name)) return undefined
      return { name, async attach() {} }
    },
    listClients() {
      return registered.map((name) => ({ name }))
    },
  }
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout,
    stderr,
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
    capabilities: {
      has: (/** @type {string} */ id) => id === 'hypaware.ai-gateway',
      require: () => gateway,
    },
  }))
  return { ctx, stdout, stderr }
}

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-all-notes-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('hyp attach all: a catalog-known client missing from the live registry gets a note, the live ones attach', async () => {
  await withTempHome(async (home) => {
    const { ctx, stdout, stderr } = makeCtx({
      home,
      registered: ['claude', 'codex', 'claude-desktop'],
    })
    const code = await runAttach(['all'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(stderr.text(), '')

    const lines = stdout.text().split('\n').filter((l) => l.startsWith('note:'))
    assert.deepEqual(lines, [
      "note: openclaw is a known client but its adapter is not enabled; run 'hyp attach openclaw' to enable it",
    ])
  })
})

test('hyp attach all: the note does not change the exit code, only real attach failures among the live set do', async () => {
  await withTempHome(async (home) => {
    // Only claude and claude-desktop are live; codex and openclaw are both
    // known-but-not-enabled. Two notes, zero live-attach failures, exit code
    // still 0.
    const { ctx, stdout, stderr } = makeCtx({ home, registered: ['claude', 'claude-desktop'] })
    const code = await runAttach(['all'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(stderr.text(), '')

    const notes = stdout.text().split('\n').filter((l) => l.startsWith('note:')).sort()
    assert.deepEqual(notes, [
      "note: codex is a known client but its adapter is not enabled; run 'hyp attach codex' to enable it",
      "note: openclaw is a known client but its adapter is not enabled; run 'hyp attach openclaw' to enable it",
    ])
  })
})
