// @ts-check

/**
 * The managed Claude hook must never be pinned to npm's `_npx` cache.
 *
 * `hyp client attach claude` bakes an absolute CLI path into
 * `~/.claude/settings.json`, and under `npx hypaware` the running entrypoint
 * lives in `~/.npm/_npx/<hash>/...`, which npm prunes on its own schedule.
 * The hook contract is exit-0-and-say-nothing, so a pruned cache stops `cwd`
 * and `git_branch` capture with no error anywhere - the same failure
 * `daemon/install.js` already refuses for the daemon binary.
 *
 * These drive the real adapter through `activate()`, the way an attach reaches
 * it in production, and read the command out of the file that was written.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { activate as activateClaude } from '../../hypaware-core/plugins-workspace/claude/src/index.js'
import { isNpxBinPath } from '../../src/core/cli/global_install.js'

const ENDPOINT = 'http://127.0.0.1:18533'

function makeBuf() {
  let value = ''
  return {
    write(/** @type {unknown} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/** @param {string} file */
async function writeExecutable(file) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, '#!/bin/sh\nexit 0\n')
  await fsp.chmod(file, 0o755)
}

/**
 * A temp home whose `$PATH` is entirely ours, running the adapter as if it had
 * been launched by `npx hypaware`: `process.argv[1]` points into an `_npx`
 * cache and that cache's shim directory sits at the FRONT of `$PATH`, exactly
 * where npx puts it. Anything durable therefore has to be found past it.
 *
 * @param {{ installedBin?: boolean }} [opts]
 */
async function rig(opts = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-hook-bin-'))
  const settingsPath = path.join(root, '.claude', 'settings.json')
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true })

  const npxBinDir = path.join(root, '.npm', '_npx', 'a1b2c3d4', 'node_modules', '.bin')
  const npxBin = path.join(npxBinDir, 'hypaware')
  await writeExecutable(npxBin)

  const globalBinDir = path.join(root, 'npm-global', 'bin')
  const globalBin = path.join(globalBinDir, 'hypaware')
  if (opts.installedBin === true) await writeExecutable(globalBin)
  else await fsp.mkdir(globalBinDir, { recursive: true })

  const env = {
    HOME: root,
    HYP_HOME: path.join(root, '.hyp'),
    HYP_CLAUDE_CODE_VERSION: '2.1.233',
    PATH: [npxBinDir, globalBinDir].join(path.delimiter),
  }

  /** @type {any} */
  const gateway = {
    registerUpstreamPreset() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
    /** @type {any} */
    client: undefined,
    registerClient(/** @type {any} */ client) { this.client = client },
  }
  const ctx = /** @type {any} */ ({
    env,
    paths: { stateDir: path.join(root, '.hyp', 'hypaware', 'plugins', 'claude') },
    plugin: { version: '0.0.0-test' },
    config: {},
    configRegistry: { registerSection() {} },
    requireCapability: () => gateway,
    backfills: { register() {} },
    commands: { register() {} },
    skills: { register() {} },
    agents: { register() {} },
    initPresets: { register() {} },
    sources: { register() {} },
    query: { registerDataset() {} },
  })
  await activateClaude(ctx)

  return {
    env,
    npxBin,
    globalBin,
    /**
     * Attach with `process.argv[1]` standing in for the npx entrypoint, and
     * return every managed hook command the attach wrote, plus what it printed.
     */
    async attach() {
      const buf = makeBuf()
      const priorArgv = process.argv[1]
      process.argv[1] = npxBin
      try {
        await gateway.client.attach({ endpoint: ENDPOINT, stdout: buf, stderr: buf })
      } finally {
        process.argv[1] = priorArgv
      }
      const value = JSON.parse(await fsp.readFile(settingsPath, 'utf8'))
      /** @type {string[]} */
      const commands = []
      for (const entries of Object.values(value.hooks ?? {})) {
        for (const entry of /** @type {any[]} */ (entries)) {
          for (const handler of entry.hooks ?? []) commands.push(handler.command)
        }
      }
      assert.ok(commands.length > 0, 'attach installed no managed hooks')
      return { commands, output: buf.text() }
    },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

test('an npx attach records the installed CLI, not the npx cache path', async (t) => {
  const r = await rig({ installedBin: true })
  t.after(() => r.cleanup())

  const { commands } = await r.attach()

  for (const command of commands) {
    assert.equal(
      isNpxBinPath(command.split(' ')[0], r.env),
      false,
      `managed hook was pinned to the npx cache: ${command}`
    )
    assert.ok(
      command.startsWith(`${r.globalBin} claude-hook `),
      `managed hook did not use the installed CLI: ${command}`
    )
  }
})

test('with no CLI installed the npx path is still written, but the attach says so', async (t) => {
  const r = await rig({ installedBin: false })
  t.after(() => r.cleanup())

  const { commands, output } = await r.attach()

  // Capture that works until npm prunes the cache beats no capture at all, so
  // the path is still recorded - what changes is that it is no longer silent.
  for (const command of commands) {
    assert.ok(command.startsWith(`${r.npxBin} claude-hook `), command)
  }
  assert.match(output, /npx cache/)
  assert.match(output, /npm install -g hypaware/)
})
