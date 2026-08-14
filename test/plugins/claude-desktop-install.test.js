// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  MANAGED_PLIST_PATH,
  buildPlistWriteCommands,
  computeDesiredPlistContent,
  residueDirPath,
  runInstall,
} from '../../hypaware-core/plugins-workspace/claude-desktop/src/install.js'
import { activate } from '../../hypaware-core/plugins-workspace/claude-desktop/src/index.js'
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

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig,
    credential,
    stateDir,
    platform: 'darwin',
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

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
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

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
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

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
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

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 1)
  assert.match(bufs.stderr.text(), /refused/)
  assert.match(bufs.stderr.text(), /ephemeral/)
  assert.equal(commandCalls.length, 0)
  assert.equal(spawnCalls.length, 0)
})

test('install: refuses up front on a non-macOS platform, with no side effects', async () => {
  // On Linux the privileged sequence would half-succeed: `sudo mkdir -p
  // '/Library/Managed Preferences'` creates root-owned junk while
  // configuring nothing. Off-platform the contract is `hyp daemon
  // install`'s loud refusal, before consent, login, or any write.
  // @ref LLP 0139#macos-only [tests]: nothing runs off darwin, and the refusal names the platform
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, commandCalls, credential, sectionConfig } = fixture({ stateDir })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'linux',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 1)
  assert.match(bufs.stderr.text(), /unsupported platform 'linux'/)
  assert.equal(commandCalls.length, 0, 'no login, no helper write')
  assert.equal(spawnCalls.length, 0, 'no sudo, no killall')
  assert.ok(!fs.existsSync(path.join(stateDir, 'managed.plist')), 'no plist written')
})

test('install: --print-commands passes the platform gate, because it applies nothing', async () => {
  // The wizard seam test dispatches the real command with --print-commands
  // on Linux CI, and inspecting the would-be commands from a non-Mac admin
  // box is legitimate (LLP 0133#one-surface).
  // @ref LLP 0139#macos-only [tests]: the refusal gates the applying path only
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall(['--print-commands'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'linux',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0, bufs.stdout.text())
  assert.equal(spawnCalls.length, 0)
  assert.match(bufs.stdout.text(), /sudo cp/)
})

test('install: residue directory is backed up and cleared when present', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const residueDir = residueDirPath(cmdCtx.env)
  fs.mkdirSync(residueDir, { recursive: true })
  fs.writeFileSync(path.join(residueDir, 'config.json'), '{"stale":true}')
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
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

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
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

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', managedPlistPath,
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

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', managedPlistPath,
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

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', managedPlistPath,
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
    sectionConfig, credential, stateDir, platform: 'darwin', managedPlistPath,
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0, bufs.stdout.text())
  assert.equal(spawnCalls.length, 0, 'no privileged command actually invoked')
  assert.match(bufs.stdout.text(), /sudo mkdir -p/)
  assert.match(bufs.stdout.text(), /sudo cp/)
  assert.match(bufs.stdout.text(), /killall cfprefsd/)
})

test('install: --print-commands applies nothing at all, including the non-privileged steps', async () => {
  // The flag used to run steps 1 and 2 for real, so on a machine that was
  // not signed in the escape hatch dropped into an interactive OAuth flow
  // and hung. Nothing may have a side effect under the flag.
  // @ref LLP 0139#print-commands-applies-nothing [tests]: the login and helper steps are printed, never executed
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, commandCalls, credential, sectionConfig } = fixture({
    stateDir,
    mode: 'subscription',
    commandRuns: { 'claude-account status': 1 },
  })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall(['--print-commands'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0, bufs.stdout.text())
  assert.deepEqual(commandCalls, [], 'no sub-command invoked, not even claude-account status')
  assert.equal(spawnCalls.length, 0)
  assert.match(bufs.stdout.text(), /hyp claude-account login/)
  assert.match(bufs.stdout.text(), /hyp claude-desktop install-helper/)
})

test('install: --print-commands never asks for consent, because it changes nothing', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })

  const code = await runInstall(['--print-commands'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy([])),
  })

  assert.equal(code, 0)
  assert.doesNotMatch(bufs.stdout.text(), /Claude Desktop needs extra setup/)
  assert.doesNotMatch(bufs.stdout.text(), /Set up Claude Desktop now\?/)
})

// --- the disclosure and its question (LLP 0139 #informed-consent, as amended) ---

test('install: a bare enter proceeds - disclosure, question, then the steps', async () => {
  // The question defaults to yes: the user opted in by ticking a
  // never-pre-checked row or typing the command. It exists to name what
  // enter does next, because on a signed-out machine step 1 launches the
  // Claude sign-in in a browser.
  // @ref LLP 0139#informed-consent [tests]: disclosure, then the question naming the sign-in launch, then the steps
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({
    stateDir, mode: 'subscription', stdin: Readable.from(['\n']),
    commandRuns: { 'claude-account status': 1 },
  })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0, bufs.stdout.text())
  const text = bufs.stdout.text()
  assert.match(text, /Claude Desktop needs extra setup/)
  assert.match(text, /Set up Claude Desktop now\? The first step opens the Claude sign-in in your browser\./)
  assert.ok(text.indexOf('needs extra setup') < text.indexOf('Set up Claude Desktop now?'), 'the disclosure precedes the question')
  assert.ok(spawnCalls.some((c) => c.startsWith('sudo cp')))
})

test('install: an explicit no declines - nothing changed, nonzero exit', async () => {
  // Nonzero on decline is load-bearing: it routes the wizard's configure
  // phase onto its drop-on-failure path (LLP 0131), which prints the
  // catch-up command instead of pretending Desktop was attached.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, commandCalls, credential, sectionConfig } = fixture({
    stateDir, mode: 'subscription', stdin: Readable.from(['n\n']),
  })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 1)
  // Only the read-only status probe ran (it feeds the question's wording);
  // no sign-in, no helper write.
  assert.deepEqual(commandCalls.map((c) => c.name), ['claude-account status'])
  assert.equal(spawnCalls.length, 0, 'no sudo, no killall')
  assert.match(bufs.stdout.text(), /nothing changed/)
})

test('install: org_key mode asks without claiming a browser sign-in', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({
    stateDir, mode: 'org_key', stdin: Readable.from(['n\n']),
  })

  await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy([])),
  })

  assert.match(bufs.stdout.text(), /Set up Claude Desktop now\? \[Y\/n\]: /)
  assert.doesNotMatch(bufs.stdout.text(), /opens the Claude sign-in/)
})

test('install: --yes skips the question and runs the steps', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await runInstall(['--yes'], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
  })

  assert.equal(code, 0, bufs.stdout.text())
  assert.match(bufs.stdout.text(), /Claude Desktop needs extra setup/, 'the disclosure still prints')
  assert.doesNotMatch(bufs.stdout.text(), /Set up Claude Desktop now\?/)
  assert.ok(spawnCalls.some((c) => c.startsWith('sudo cp')))
})

test('install: a stdin that ends without an answer declines instead of hanging', async () => {
  // @ref LLP 0139#default-no [tests]: a non-answer is never a yes - EOF declines, with the hint, rather than hanging or proceeding
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({
    stateDir, mode: 'subscription', stdin: Readable.from([]),
  })
  const spawnCalls = /** @type {string[]} */ ([])

  const code = await Promise.race([
    runInstall([], cmdCtx, {
      sectionConfig, credential, stateDir, platform: 'darwin',
      managedPlistPath: path.join(stateDir, 'managed.plist'),
      spawnSyncImpl: /** @type {any} */ (spawnSyncSpy(spawnCalls)),
    }),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
  ])

  assert.equal(code, 1, 'declines with a defined exit code rather than hanging')
  assert.equal(spawnCalls.length, 0, 'no sudo')
  assert.match(bufs.stderr.text(), /--yes/)
  assert.match(bufs.stderr.text(), /--print-commands/)
  assert.ok(!fs.existsSync(path.join(stateDir, 'managed.plist')), 'no plist written')
})

test('install: the disclosure names the credential posture and every file it will touch', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({
    stateDir, mode: 'subscription', stdin: Readable.from(['n\n']),
  })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)

  await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', managedPlistPath,
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy([])),
  })

  const text = bufs.stdout.text()
  // The distinction that justifies the gate: unlike claude/codex, this
  // machine ends up holding the credential.
  assert.match(text, /Claude Code and Codex/)
  assert.match(text, /hold an Anthropic credential/)
  // Every durable side effect is named by path.
  assert.ok(text.includes(inputs.baseUrl), 'names the gateway endpoint')
  assert.ok(text.includes(inputs.helperPath), 'names the helper path')
  assert.ok(text.includes(managedPlistPath), 'names the managed plist path')
  assert.match(text, /sudo/)
  assert.match(text, /logout/, 'says how to undo it')
})

test('install: org_key mode disclosure promises no sign-in', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({
    stateDir, mode: 'org_key', stdin: Readable.from(['n\n']),
  })

  await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy([])),
  })

  assert.match(bufs.stdout.text(), /org API key from your fleet config/)
  assert.doesNotMatch(bufs.stdout.text(), /sign you in to your Claude account/)
})

test('install: consent names the residue clear only when residue is actually present', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const withoutResidue = fixture({ stateDir, stdin: Readable.from(['n\n']) })
  await runInstall([], withoutResidue.cmdCtx, {
    sectionConfig: withoutResidue.sectionConfig,
    credential: withoutResidue.credential,
    stateDir,
    platform: 'darwin',
    managedPlistPath: path.join(stateDir, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy([])),
  })
  assert.doesNotMatch(withoutResidue.bufs.stdout.text(), /back up and clear/)

  const residueState = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const withResidue = fixture({ stateDir: residueState, stdin: Readable.from(['n\n']) })
  fs.mkdirSync(residueDirPath(withResidue.cmdCtx.env), { recursive: true })
  await runInstall([], withResidue.cmdCtx, {
    sectionConfig: withResidue.sectionConfig,
    credential: withResidue.credential,
    stateDir: residueState,
    platform: 'darwin',
    managedPlistPath: path.join(residueState, 'managed.plist'),
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy([])),
  })
  assert.match(withResidue.bufs.stdout.text(), /back up and clear/)
})

test('install: an already-configured machine is not re-prompted', async () => {
  // LLP 0131 makes the re-run the documented repair step, so it has to stay
  // cheap. Consent is asked once, not on every converged re-run.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const { cmdCtx, bufs, credential, sectionConfig } = fixture({ stateDir, stdin: undefined })
  const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
  const managedPlistPath = path.join(stateDir, 'managed.plist')
  fs.writeFileSync(managedPlistPath, computeDesiredPlistContent(inputs))
  fs.mkdirSync(path.dirname(inputs.helperPath), { recursive: true })
  fs.writeFileSync(inputs.helperPath, '#!/bin/sh\n')

  const code = await runInstall([], cmdCtx, {
    sectionConfig, credential, stateDir, platform: 'darwin', managedPlistPath,
    spawnSyncImpl: /** @type {any} */ (spawnSyncSpy([])),
  })

  // No disclosure, no refusal: an already-configured machine has read it.
  assert.equal(code, 0, bufs.stdout.text())
  assert.doesNotMatch(bufs.stdout.text(), /Claude Desktop needs extra setup/)
  assert.match(bufs.stdout.text(), /already up to date/)
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

// The registered summary is what `hyp --help` prints once the plugin is
// active; the manifest summary is what it prints before boot. They drifted
// the moment the consent step was added to one and not the other, with
// nothing to catch it.
test('every registered claude-desktop command summary matches its manifest entry', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-install-'))
  const manifest = JSON.parse(fs.readFileSync(
    new URL('../../hypaware-core/plugins-workspace/claude-desktop/hypaware.plugin.json', import.meta.url),
    'utf8'
  ))
  /** @type {Map<string, any>} */
  const registered = new Map()
  await activate(/** @type {any} */ ({
    config: {},
    paths: { stateDir },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    configRegistry: { registerSection() {} },
    commands: { register: (/** @type {any} */ cmd) => { registered.set(cmd.name, cmd) } },
    requireCapability: (/** @type {string} */ name) => (
      name === 'hypaware.anthropic-credential'
        ? { mode: 'org_key', helperCommandArgs: ['claude-account', 'credential'] }
        : {}
    ),
  }))

  for (const declared of manifest.contributes.commands) {
    const cmd = registered.get(declared.name)
    assert.ok(cmd, `manifest declares '${declared.name}' but activation registers no such command`)
    assert.equal(
      cmd.summary,
      declared.summary,
      `'${declared.name}': the registered summary and the manifest summary have drifted`
    )
  }
  assert.equal(registered.size, manifest.contributes.commands.length, 'no undeclared commands registered')
})
