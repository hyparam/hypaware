// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { detachAllClientsFromDisk } from '../../src/core/commands/clients.js'
// Adapter helpers build realistic fixtures only; the sweep under test reverses
// them through the one core disk undo, not through plugin code.
import { attach as claudeAttach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { prepareAttach as codexPrepareAttach } from '../../hypaware-core/plugins-workspace/codex/src/toml-config.js'

/**
 * LLP 0206: `hyp daemon uninstall` removes the service and then detaches the
 * clients it was serving, because an attach that outlives the gateway port is
 * not a stale preference - it is a client that fails every request. These cover
 * the sweep the command runs.
 */

/** @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js' */

/** @returns {Promise<string>} */
async function stageHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-uninstall-detach-'))
}

/**
 * @param {string} home
 * @returns {{ ctx: CommandRunContext, out: () => string, err: () => string }}
 */
function stageCtx(home) {
  let out = ''
  let err = ''
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout: { write(/** @type {unknown} */ chunk) { out += String(chunk); return true } },
    stderr: { write(/** @type {unknown} */ chunk) { err += String(chunk); return true } },
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
  }))
  return { ctx, out: () => out, err: () => err }
}

test('the uninstall sweep reverses every attached client, claude and codex alike', async () => {
  const home = await stageHome()
  try {
    const claudePath = path.join(home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(claudePath), { recursive: true })
    await fs.writeFile(claudePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.example' } }) + '\n')
    await claudeAttach({ port: 4123, version: '0.2.0', stateFile: '/abs/session-context.jsonl', settingsPath: claudePath })

    const codexPath = path.join(home, '.codex', 'config.toml')
    await fs.mkdir(path.dirname(codexPath), { recursive: true })
    await fs.writeFile(codexPath, codexPrepareAttach('model_provider = "openai"\n', 4123, '0.2.0').content)

    const staged = stageCtx(home)
    const sweep = await detachAllClientsFromDisk(staged.ctx)

    assert.deepEqual(sweep.failed, [], staged.err())
    assert.deepEqual(sweep.detached.map((c) => c.name).sort(), ['claude', 'codex'])

    // The gateway routing each client was left with is gone, and what the user
    // had before it is back.
    const claudeSettings = JSON.parse(await fs.readFile(claudePath, 'utf8'))
    assert.equal(claudeSettings.env.ANTHROPIC_BASE_URL, 'https://mine.example')
    assert.equal('_hypaware' in claudeSettings, false)
    assert.equal(await fs.readFile(codexPath, 'utf8'), 'model_provider = "openai"\n')

    // Quiet: the summary is the caller's to render, so the sweep itself says
    // nothing on stdout.
    assert.equal(staged.out(), '')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('the uninstall sweep reports nothing on a machine with no client attached', async () => {
  // The common case for a daemon-only host: asking every client is an honest
  // no-op, so uninstall prints no detach lines and still exits 0.
  const home = await stageHome()
  try {
    const staged = stageCtx(home)
    const sweep = await detachAllClientsFromDisk(staged.ctx)

    assert.deepEqual(sweep.detached, [])
    assert.deepEqual(sweep.failed, [], staged.err())
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('one client attached is detached without the untouched one being reported', async () => {
  // Guards the "detached" list against becoming "every client we asked": a
  // report naming codex on a machine that never attached it teaches the user
  // the command edits files it did not.
  const home = await stageHome()
  try {
    const claudePath = path.join(home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(claudePath), { recursive: true })
    await fs.writeFile(claudePath, '{}\n')
    await claudeAttach({ port: 4123, version: '0.2.0', stateFile: '/abs/session-context.jsonl', settingsPath: claudePath })

    const staged = stageCtx(home)
    const sweep = await detachAllClientsFromDisk(staged.ctx)

    assert.deepEqual(sweep.detached.map((c) => c.name), ['claude'])
    assert.equal(sweep.detached[0]?.settingsPath, claudePath)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
