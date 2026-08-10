// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { detachAllClientsFromDisk } from '../../src/core/commands/clients.js'
import { runDaemonUninstall } from '../../src/core/commands/daemon.js'
// Adapter helpers build realistic fixtures only; the sweep under test reverses
// them through the one core disk undo, not through plugin code.
import { attach as claudeAttach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { prepareAttach as codexPrepareAttach } from '../../hypaware-core/plugins-workspace/codex/src/toml-config.js'

/**
 * LLP 0206: `hyp daemon uninstall` removes the service and then detaches the
 * clients it was serving, because an attach that outlives the gateway port is
 * not a stale preference - it is a client that fails every request. These cover
 * the sweep the command runs, and the command itself through its teardown seam:
 * the teardown-first gate, the pre-teardown base URL capture the json_path undo
 * needs, per-client failure collection, and the warning re-render.
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

const GATEWAY_ORIGIN = 'http://127.0.0.1:4123'

/**
 * The entries the openclaw adapter's attach writes: gateway origin, the
 * marker header naming the key, the empty models array its schema requires.
 * @param {string} home
 */
async function stageOpenclawAttached(home) {
  const openclawPath = path.join(home, '.openclaw', 'openclaw.json')
  await fs.mkdir(path.dirname(openclawPath), { recursive: true })
  await fs.writeFile(openclawPath, JSON.stringify({
    models: {
      providers: {
        anthropic: { baseUrl: GATEWAY_ORIGIN, headers: { 'x-hypaware-upstream': 'anthropic' }, models: [] },
        openai: { baseUrl: `${GATEWAY_ORIGIN}/v1`, headers: { 'x-hypaware-upstream': 'openai' }, models: [] },
      },
    },
  }) + '\n')
  return openclawPath
}

/**
 * A daemon the status rung of the base URL resolution can see: a pid file
 * naming a living process (this one) and a status file recording the gateway
 * source's bound port.
 * @param {string} home
 */
async function stageLiveDaemonStatus(home) {
  const runDir = path.join(home, '.hyp', 'hypaware', 'run')
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(path.join(runDir, 'hypaware.pid'), JSON.stringify({ pid: process.pid }) + '\n')
  await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify({
    sources: [{ plugin: '@hypaware/ai-gateway', name: 'ai-gateway', details: { host: '127.0.0.1', port: 4123 } }],
  }) + '\n')
  return runDir
}

test('the sweep detaches openclaw when handed the gateway origin the caller resolved', async () => {
  const home = await stageHome()
  try {
    const openclawPath = await stageOpenclawAttached(home)

    const staged = stageCtx(home)
    const sweep = await detachAllClientsFromDisk(staged.ctx, GATEWAY_ORIGIN)

    assert.deepEqual(sweep.failed, [], staged.err())
    assert.deepEqual(sweep.detached.map((c) => c.name), ['openclaw'])
    const config = JSON.parse(await fs.readFile(openclawPath, 'utf8'))
    assert.deepEqual(config.models.providers, {})
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a never-attached openclaw config with its own providers is a no-op, not a failure, even with the origin unknown', async () => {
  // The false-failure case: the user set up their own anthropic provider and
  // never ran hyp attach. No entry carries the HypAware marker header, so
  // there is nothing to reverse, and an unresolvable gateway origin must not
  // turn that into a failed uninstall.
  const home = await stageHome()
  try {
    const openclawPath = path.join(home, '.openclaw', 'openclaw.json')
    await fs.mkdir(path.dirname(openclawPath), { recursive: true })
    const userConfig = JSON.stringify({
      models: { providers: { anthropic: { baseUrl: 'https://api.anthropic.com', models: ['claude-fable-5'] } } },
    }) + '\n'
    await fs.writeFile(openclawPath, userConfig)

    const staged = stageCtx(home)
    const sweep = await detachAllClientsFromDisk(staged.ctx, undefined)

    assert.deepEqual(sweep.failed, [], staged.err())
    assert.deepEqual(sweep.detached, [])
    assert.equal(await fs.readFile(openclawPath, 'utf8'), userConfig)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('an attached openclaw with the origin unknown is a collected failure, not a silent skip', async () => {
  // The entries are ours by signature, but without the origin the undo cannot
  // confirm it; both guesses are destructive, so the sweep must say so rather
  // than report the machine clean.
  const home = await stageHome()
  try {
    const openclawPath = await stageOpenclawAttached(home)

    const staged = stageCtx(home)
    const sweep = await detachAllClientsFromDisk(staged.ctx, undefined)

    assert.deepEqual(sweep.detached, [])
    assert.deepEqual(sweep.failed.map((f) => f.name), ['openclaw'])
    assert.match(sweep.failed[0]?.message ?? '', /base URL is unknown/)
    const config = JSON.parse(await fs.readFile(openclawPath, 'utf8'))
    assert.equal(config.models.providers.anthropic.baseUrl, GATEWAY_ORIGIN)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('runDaemonUninstall resolves the gateway origin before teardown kills the status rung', async () => {
  // The ordering gate for the fact that dies with the daemon: the fake
  // teardown deletes the pid file, exactly what a real teardown does to the
  // live-status rung of the base URL resolution. Openclaw still detaches only
  // if the command captured the origin first.
  const home = await stageHome()
  try {
    const openclawPath = await stageOpenclawAttached(home)
    const runDir = await stageLiveDaemonStatus(home)

    const staged = stageCtx(home)
    const code = await runDaemonUninstall([], staged.ctx, {
      uninstallDaemon: async () => {
        await fs.rm(path.join(runDir, 'hypaware.pid'))
      },
    })

    assert.equal(code, 0, staged.err())
    assert.match(staged.out(), /Detached openclaw/)
    const config = JSON.parse(await fs.readFile(openclawPath, 'utf8'))
    assert.deepEqual(config.models.providers, {})
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a failed teardown detaches nothing: the gateway still answers, so the attaches stay', async () => {
  const home = await stageHome()
  try {
    const claudePath = path.join(home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(claudePath), { recursive: true })
    await fs.writeFile(claudePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.example' } }) + '\n')
    await claudeAttach({ port: 4123, version: '0.2.0', stateFile: '/abs/session-context.jsonl', settingsPath: claudePath })
    const attachedBytes = await fs.readFile(claudePath, 'utf8')

    const staged = stageCtx(home)
    const code = await runDaemonUninstall([], staged.ctx, {
      uninstallDaemon: async () => { throw new Error('bootout refused') },
    })

    assert.equal(code, 1)
    assert.match(staged.err(), /bootout refused/)
    assert.doesNotMatch(staged.out(), /Detached/)
    assert.equal(await fs.readFile(claudePath, 'utf8'), attachedBytes)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('one wedged client is a collected failure with a remedy; the rest still detach', async () => {
  const home = await stageHome()
  try {
    const claudePath = path.join(home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(claudePath), { recursive: true })
    await fs.writeFile(claudePath, '{}\n')
    await claudeAttach({ port: 4123, version: '0.2.0', stateFile: '/abs/session-context.jsonl', settingsPath: claudePath })
    // A settings path that is a directory wedges the codex undo on read.
    await fs.mkdir(path.join(home, '.codex', 'config.toml'), { recursive: true })

    const staged = stageCtx(home)
    const code = await runDaemonUninstall([], staged.ctx, { uninstallDaemon: async () => {} })

    assert.equal(code, 1)
    assert.match(staged.out(), /Detached claude/)
    assert.match(staged.err(), /detach 'codex' failed/)
    assert.match(staged.err(), /run 'hyp detach codex'/)
    assert.match(staged.err(), /the service itself was removed/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('the undo warnings the quiet sweep collects reach the uninstall output', async () => {
  // A user who re-pointed ANTHROPIC_BASE_URL after attaching: the undo leaves
  // the override in place and says so, and that notice must survive the quiet
  // sweep - "Detached claude" with silence here is the silent half-detach this
  // command exists to prevent.
  const home = await stageHome()
  try {
    const claudePath = path.join(home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(claudePath), { recursive: true })
    await fs.writeFile(claudePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.example' } }) + '\n')
    await claudeAttach({ port: 4123, version: '0.2.0', stateFile: '/abs/session-context.jsonl', settingsPath: claudePath })
    const settings = JSON.parse(await fs.readFile(claudePath, 'utf8'))
    settings.env.ANTHROPIC_BASE_URL = 'https://overridden-by-hand.example'
    await fs.writeFile(claudePath, JSON.stringify(settings) + '\n')

    const staged = stageCtx(home)
    const code = await runDaemonUninstall([], staged.ctx, { uninstallDaemon: async () => {} })

    assert.equal(code, 0, staged.err())
    assert.match(staged.out(), /Detached claude/)
    assert.match(staged.out(), /warning:/)
    const after = JSON.parse(await fs.readFile(claudePath, 'utf8'))
    assert.equal(after.env.ANTHROPIC_BASE_URL, 'https://overridden-by-hand.example')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
