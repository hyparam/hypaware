// @ts-check

/**
 * Help metadata is a contract, not decoration: what `--help` claims has to be
 * what the handler does. These assertions read the semantic claims (does the
 * walkthrough ask for retention? is the target name required?), not just the
 * presence of a flag token, because presence is what let the four
 * registrations below drift away from their handlers in the first place.
 *
 * @ref LLP 0265#registration-is-the-contract [tests]: each claim is checked against the behaviour its handler implements
 * @ref LLP 0265#help-verb [tests]: `hyp help <command>` renders that command's help
 * @ref LLP 0265#global-options [tests]: top-level help names the global options and the command aliases
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

function coreKernelAndRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { kernel, registry }
}

/** @param {string} name */
function coreCommand(name) {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const cmd = registry.get(name)
  assert.ok(cmd, `core registry should register \`${name}\``)
  return cmd
}

// --- stale claims -----------------------------------------------------------

test('init help does not claim the walkthrough asks for a retention window', () => {
  const text = String(coreCommand('init').help ?? '')
  // LLP 0137 removed the retention question; the pathway picks the default.
  assert.equal(
    /(asks?|pick|choose|and)[^.]{0,80}retention window/i.test(text),
    false,
    'init help still advertises a retention question the walkthrough does not ask'
  )
  assert.match(text, /90/, 'init help should name the team-pathway retention default')
  assert.match(text, /120/, 'init help should name the local-pathway retention default')
})

test('remote login usage makes the target name optional and lists every accepted flag', () => {
  const { usage } = coreCommand('remote login')
  const text = String(usage ?? '')
  assert.equal(/login\s+<name>/.test(text), false, `usage still requires a target name: ${text}`)
  assert.match(text, /login\s+\[name\]/)
  for (const flag of ['--org', '--host', '--browser', '--no-browser', '--token-file', '--no-forward', '--no-daemon']) {
    assert.ok(text.includes(flag), `remote login usage omits ${flag}: ${text}`)
  }
})

test('daemon restart summary describes restarting the installed service', () => {
  const cmd = coreCommand('daemon restart')
  assert.match(cmd.summary, /[Rr]estart/)
  assert.equal(
    /relaunch|Stop the daemon/.test(cmd.summary),
    false,
    `daemon restart summary still describes a stop-only command: ${cmd.summary}`
  )
  // The relaunch instruction is the no-installed-service fallback, so it
  // belongs in the long help, qualified.
  assert.match(String(cmd.help ?? ''), /no installed service/i)
})

test('skills install usage states the client default the parser applies', () => {
  const text = String(coreCommand('skills install').usage ?? '')
  assert.match(text, /--client <name>\|all/, `skills install usage omits the \`all\` form: ${text}`)
})

test('daemon install usage documents the accepted --platform override', () => {
  const cmd = coreCommand('daemon install')
  assert.match(String(cmd.usage ?? ''), /--platform darwin\|linux/)
  assert.match(String(cmd.help ?? ''), /--dry-run/)
})

test('daemon install rejects --platform outside a dry run', async () => {
  const { runDaemonInstall } = await import('../../../src/core/commands/daemon.js')
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await runDaemonInstall(
    ['--platform', 'linux', '--bin', '/usr/local/bin/hyp'],
    /** @type {any} */ ({ stdout, stderr, env: { HOME: '/tmp/hyp-help-metadata' } })
  )
  assert.equal(code, 2)
  assert.match(stderr.text(), /--platform requires --dry-run/)
})

// --- `hyp help <command>` ---------------------------------------------------

test('hyp help <group> renders that group help, not the top-level table', async () => {
  const { kernel, registry } = coreKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['help', 'query'], { stdout, stderr, registry, kernel })

  assert.equal(code, 0)
  const out = stdout.text()
  assert.match(out, /^hyp query - Query the local cache/)
  assert.match(out, /^ {2}sql\s+Run a SQL query/m)
  assert.equal(out.includes('usage: hyp <command> [args...]'), false)
})

test('hyp help <group> <subcommand> renders the leaf command help', async () => {
  const { kernel, registry } = coreKernelAndRegistry()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['help', 'daemon', 'install'], { stdout, stderr, registry, kernel })

  assert.equal(code, 0)
  assert.match(stdout.text(), /^hyp daemon install - /)
})

test('bare hyp help still renders the top-level table', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['help'], { stdout, stderr })

  assert.equal(code, 0)
  assert.match(stdout.text(), /usage: hyp <command> \[args\.\.\.\]/)
})

// --- global options and aliases --------------------------------------------

test('top-level help names the global options that work but list no command row', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], { stdout, stderr })

  assert.equal(code, 0)
  const out = stdout.text()
  assert.match(out, /^Global options:$/m)
  assert.match(out, /^ {2}--help, -h\s+\S/m)
  assert.match(out, /^ {2}--version, -V\s+\S/m)
  assert.match(out, /hyp help <command>/)
})

test('top-level help names command aliases the command rows hide', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], { stdout, stderr })

  assert.equal(code, 0)
  const out = stdout.text()
  assert.match(out, /^Aliases:$/m)
  assert.match(out, /^ {2}unattach\s+detach$/m)
})
