// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MANAGED_PLIST_PATH,
  buildPlistWriteCommands,
  computeDesiredPlistContent,
  residueDirPath,
  runInstall,
} from '../../hypaware-core/plugins-workspace/claude-desktop/src/install.js'
import { resolveInputs } from '../../hypaware-core/plugins-workspace/claude-desktop/src/inputs.js'
import { renderManagedPreferencesPlist } from '../../hypaware-core/plugins-workspace/claude-desktop/src/profile.js'

/**
 * @import { AnthropicCredentialCapability } from '../../hypaware-core/plugins-workspace/claude-account/src/types.js'
 */

/** @returns {{ stdout: { write(s: string): boolean, text(): string }, stderr: { write(s: string): boolean, text(): string } }} */
function makeBufs() {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s) => { out += s; return true }, text: () => out },
    stderr: { write: (s) => { err += s; return true }, text: () => err },
  }
}

/**
 * @param {{ stateDir: string, mode?: 'org_key' | 'subscription', commandRuns?: Record<string, number>, stdin?: unknown, hypConfig?: any, sectionConfig?: Record<string, unknown> }} opts
 */
function fixture(opts) {
  const bufs = makeBufs()
  /** @type {Array<{ name: string, argv: string[] }>} */
  const commandCalls = []
  const mode = opts.mode ?? 'org_key'
  /** @type {AnthropicCredentialCapability} */
  const credential = { mode, helperCommandArgs: ['claude-account', 'credential'] }
  const cmdCtx = /** @type {any} */ ({
    ...bufs,
    env: { HOME: opts.stateDir },
    stdin: 'stdin' in opts ? opts.stdin : { isTTY: true },
    config: opts.hypConfig ?? { version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] },
    commands: {
      run: async (/** @type {string} */ name, /** @type {string[]} */ argv) => {
        commandCalls.push({ name, argv })
        const code = opts.commandRuns?.[name]
        return code === undefined ? 0 : code
      },
    },
  })
  return {
    cmdCtx,
    bufs,
    commandCalls,
    credential,
    sectionConfig: opts.sectionConfig ?? {},
    stateDir: opts.stateDir,
  }
}

/**
 * @param {string[]} calls
 * @returns {(cmd: string, args: string[]) => { status: number, signal: null, error: undefined, stdout: string, stderr: string, pid: number, output: unknown[] }}
 */
function spawnSyncSpy(calls) {
  return (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    calls.push([cmd, ...args].join(' '))
    return { status: 0, signal: null, error: undefined, stdout: '', stderr: '', pid: 0, output: [] }
  }
}

test('install: org_key mode skips the login step and never calls claude-account login', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, commandCalls, credential, sectionConfig } = fixture({ stateDir, mode: 'org_key' })
  /** @type {string[]} */
  const spawnCalls = []

  const code = await runInstall([], cmdCtx, {
    sectionConfig,
    credential,
    stateDir,
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0, bufs.stdout.text())
  assert.ok(!commandCalls.some((c) => c.name === 'claude-account login'))
  assert.ok(bufs.stdout.text().includes('org_key mode'))
  assert.ok(spawnCalls.some((c) => c.startsWith('sudo cp')))
  assert.ok(spawnCalls.some((c) => c.startsWith('killall cfprefsd')))
})

test('install: subscription mode already signed in skips login without calling it', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, commandCalls, credential, sectionConfig } = fixture({
    stateDir,
    mode: 'subscription',
    commandRuns: { 'claude-account status': 0 },
  })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0)
  assert.ok(commandCalls.some((c) => c.name === 'claude-account status'))
  assert.ok(!commandCalls.some((c) => c.name === 'claude-account login'))
})

test('install: subscription mode not signed in runs login, and a failed login drops the run', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, commandCalls, credential, sectionConfig } = fixture({
    stateDir,
    mode: 'subscription',
    commandRuns: { 'claude-account status': 1, 'claude-account login': 1 },
  })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 1)
  assert.ok(commandCalls.some((c) => c.name === 'claude-account login'))
  assert.ok(bufs.stdout.text().includes('incomplete'))
  // Later steps still ran: failure in step 1 does not strand the rest.
  assert.ok(spawnCalls.some((c) => c.startsWith('sudo cp')))
})

test('install: no stdin in subscription mode fails the login step without attempting login', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, commandCalls, credential, sectionConfig } = fixture({
    stateDir,
    mode: 'subscription',
    commandRuns: { 'claude-account status': 1 },
    stdin: undefined,
  })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 1)
  assert.ok(!commandCalls.some((c) => c.name === 'claude-account login'))
})

test('install: refuses up front on an ephemeral gateway listen, with no side effects', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, commandCalls, credential, sectionConfig } = fixture({
    stateDir,
    hypConfig: { version: 2, plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0' } }] },
  })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 1)
  assert.match(bufs.stderr.text(), /refused/)
  assert.match(bufs.stderr.text(), /ephemeral/)
  assert.equal(commandCalls.length, 0)
  assert.equal(spawnCalls.length, 0)
})

test('install: residue directory is backed up and cleared when present', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const residueDir = residueDirPath(cmdCtx.env)
  fs.mkdirSync(residueDir, { recursive: true })
  fs.writeFileSync(path.join(residueDir, 'config.json'), '{"stale":true}')
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0, bufs.stdout.text())
  assert.ok(!fs.existsSync(residueDir), 'residue directory removed')
  const backupsRoot = path.join(stateDir, 'claude-desktop-3p-residue-backups')
  const backups = fs.readdirSync(backupsRoot)
  assert.equal(backups.length, 1)
  const backedUpFile = path.join(backupsRoot, backups[0], 'config.json')
  assert.equal(fs.readFileSync(backedUpFile, 'utf8'), '{"stale":true}')
})

test('install: a re-run with no residue present is a plain skip, not a failure', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0)
  assert.match(bufs.stdout.text(), /no Claude-3p dialog residue found/)
})

test('install: an already up-to-date managed plist is skipped, no sudo invoked for it', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const desired = computeDesiredPlistContent(inputs)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, desired)
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, managedPlistPath,
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0, bufs.stdout.text())
  assert.match(bufs.stdout.text(), /already up to date/)
  assert.ok(!spawnCalls.some((c) => c.includes('sudo cp')))
})

test('install: a stale managed plist is rewritten via sudo cp with the freshly rendered content', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, credential, sectionConfig } = fixture({ stateDir })
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, 'stale content')
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, managedPlistPath,
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0)
  assert.ok(spawnCalls.some((c) => c.startsWith(`sudo cp`) && c.includes(managedPlistPath)))
})

test('install: a failed privileged write drops with a re-run hint, not a thrown error', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  const spawnCalls = /** @type {string[]} */ ([])
  const spawnImpl = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    spawnCalls.push([cmd, ...args].join(' '))
    if (args[0] === 'cp') return { status: 1, signal: null, error: undefined, stdout: '', stderr: '', pid: 0, output: [] }
    return { status: 0, signal: null, error: undefined, stdout: '', stderr: '', pid: 0, output: [] }
  }

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, managedPlistPath,
    spawnSyncImpl: /** @type {any} */ (spawnImpl),
  })

  assert.equal(code, 1)
  assert.match(bufs.stdout.text(), /re-run 'hyp claude-desktop install'/)
  // killall still runs: the plist failure doesn't strand the restart step.
  assert.ok(spawnCalls.some((c) => c.startsWith('killall')))
})

test('install: --print-commands prints the sudo and killall commands without invoking spawn', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall(['--print-commands'], cmdCtx, {
    sectionConfig, credential, stateDir, managedPlistPath,
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0, bufs.stdout.text())
  assert.equal(spawnCalls.length, 0, 'no privileged command actually invoked')
  assert.match(bufs.stdout.text(), /sudo mkdir -p/)
  assert.match(bufs.stdout.text(), /sudo cp/)
  assert.match(bufs.stdout.text(), /killall cfprefsd/)
})

test('buildPlistWriteCommands renders mkdir, cp, and chmod against the target path', () => {
  const commands = buildPlistWriteCommands('/tmp/src.plist', MANAGED_PLIST_PATH)
  assert.deepEqual(commands.map((c) => c.cmd), ['sudo', 'sudo', 'sudo'])
  assert.deepEqual(commands[1].args, ['cp', '/tmp/src.plist', MANAGED_PLIST_PATH])
})

test('computeDesiredPlistContent matches renderManagedPreferencesPlist(buildManagedProfile(...))', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, credential, sectionConfig } = fixture({ stateDir })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const { buildManagedProfile } = await import('../../hypaware-core/plugins-workspace/claude-desktop/src/profile.js')
  assert.equal(computeDesiredPlistContent(inputs), renderManagedPreferencesPlist(buildManagedProfile(inputs)))
})
