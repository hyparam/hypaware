// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installDaemon, renderDaemonInstall } from '../../src/core/daemon/install.js'
import { isNpxBinPath, globalHypawareBin } from '../../src/core/cli/global_install.js'
import { runDaemonInstall } from '../../src/core/commands/daemon.js'

// Regression for #384: `ensureDurableBinForNpx` had a single call site in
// the walkthrough finale, so `hyp daemon install` and the join/enroll
// lane installed launchd/systemd against the ephemeral `_npx` bin. When
// npx exits that bin is gone and the host has no `hyp` control surface.
// The upgrade now lives inside installDaemon, so every enrollment path
// inherits "a daemon is never installed against an `_npx` bin."

const OK = { exitCode: 0, stdout: '', stderr: '' }

/** A launchctl that reports the agent as not loaded and bootstraps cleanly. */
function fakeLaunchctl() {
  return {
    print: () => Promise.resolve({ exitCode: 1, stdout: '', stderr: '' }),
    bootout: () => Promise.resolve(OK),
    bootstrap: () => Promise.resolve(OK),
    kickstart: () => Promise.resolve(OK),
  }
}

const NPX_BIN = '/Users/hyp/.npm/_npx/deadbeef/node_modules/hypaware/bin/hypaware.js'
const NPX_ENV = { npm_config_cache: '/Users/hyp/.npm' }
const GLOBAL_PREFIX = '/Users/hyp/.npm-global'
const GLOBAL_BIN = globalHypawareBin(GLOBAL_PREFIX, 'darwin')

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-durable-bin-'))

/** A durable-bin runner seam so no real `npm install -g` happens. */
function fakeNpmRunner() {
  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = []
  const runner = async (cmd, args) => {
    calls.push({ cmd, args })
    if (args.join(' ') === 'config get prefix') {
      return { exitCode: 0, stdout: `${GLOBAL_PREFIX}\n`, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}

/**
 * @param {string} homeDir
 * @param {{ runner?: import('../../src/core/cli/types.js').CommandRunner }} [durable]
 * @param {Partial<import('../../src/core/daemon/types.js').DaemonInstallOptions>} [extra]
 */
function darwinOpts(homeDir, durable, extra) {
  return {
    binPath: NPX_BIN,
    platform: /** @type {NodeJS.Platform} */ ('darwin'),
    homeDir,
    plistDir: path.join(homeDir, 'LaunchAgents'),
    nodePath: '/x/node',
    configPath: path.join(homeDir, 'hypaware-config.json'),
    launchctl: fakeLaunchctl(),
    userDomain: 'gui/501',
    sleep: async function() {},
    durableBin: { env: NPX_ENV, stdout: { write() {} }, stderr: { write() {} }, ...(durable ?? {}) },
    ...(extra ?? {}),
  }
}

test('installDaemon upgrades an _npx binPath to a durable global bin before writing the service unit', async () => {
  const home = tmpHome()
  const { calls, runner } = fakeNpmRunner()

  const plan = await installDaemon(darwinOpts(home, { runner }))

  // The written service unit must not pin the ephemeral npx bin.
  const content = fs.readFileSync(plan.targetPath, 'utf8')
  assert.equal(isNpxBinPath(plan.binPath, NPX_ENV), false, 'resolved bin is durable, not _npx')
  assert.equal(plan.binPath, GLOBAL_BIN, 'resolved bin is the global CLI')
  assert.ok(!content.includes('_npx'), 'plist does not reference the _npx cache')
  assert.ok(content.includes(GLOBAL_BIN), 'plist references the durable global bin')

  // The upgrade actually ran and is reported on the plan.
  assert.equal(plan.globalInstall?.installed, true)
  assert.equal(plan.globalInstall?.skipped, false)
  assert.deepEqual(calls[0], { cmd: 'npm', args: ['install', '-g', plan.globalInstall?.packageSpec] })
})

test('explicit --bin bypasses the durable upgrade even for an _npx-looking path', async () => {
  const home = tmpHome()
  let ran = false
  const runner = async () => { ran = true; return OK }

  const plan = await installDaemon(darwinOpts(home, { runner }, { binExplicit: true }))

  assert.equal(ran, false, 'no npm install for an explicit --bin')
  assert.equal(plan.binPath, NPX_BIN, 'explicit bin kept verbatim')
  const content = fs.readFileSync(plan.targetPath, 'utf8')
  assert.ok(content.includes('_npx'), 'explicit --bin escape hatch preserved')
  assert.equal(plan.globalInstall?.skipped, true)
})

test('dry-run render never triggers the durable upgrade (renders the _npx path as-is)', () => {
  const home = tmpHome()
  const plan = renderDaemonInstall(darwinOpts(home))
  assert.equal(plan.binPath, NPX_BIN, 'dry-run leaves binPath untouched')
})

test('hyp daemon install (no --bin) upgrades the process argv _npx bin to a durable global bin', async () => {
  const home = tmpHome()
  const { runner } = fakeNpmRunner()

  // Simulate `npx hypaware daemon install` where process.argv[1] is the
  // _npx bin. The command resolves binPath from argv, so we drive the
  // install seam directly to prove the non-walkthrough command path also
  // funnels through the durable upgrade.
  const plan = await installDaemon({
    ...darwinOpts(home, { runner }),
    // binExplicit omitted -> false, matching `runDaemonInstall` with no --bin
  })

  assert.equal(isNpxBinPath(plan.binPath, NPX_ENV), false)
  assert.equal(plan.binPath, GLOBAL_BIN)
})

test('runDaemonInstall dry-run still surfaces the _npx bin without a global install (escape hatch)', async () => {
  const home = tmpHome()
  let out = ''
  const ctx = {
    env: { HOME: home, ...NPX_ENV },
    stdout: { write(c) { out += String(c) } },
    stderr: { write() {} },
  }
  // Force platform + a known argv-style bin by passing --bin so the test
  // is host-independent; --dry-run must render without any npm install.
  const code = await runDaemonInstall(['--dry-run', '--bin', NPX_BIN, '--platform', 'darwin'], ctx)
  assert.equal(code, 0)
  assert.ok(out.includes(NPX_BIN), 'dry-run renders the given bin, no durable upgrade')
})
