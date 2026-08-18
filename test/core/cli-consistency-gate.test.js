// @ts-check

/**
 * Repository-wide CLI consistency gate.
 *
 * The focused CLI suites each prove one mechanism. This file is the
 * structural sweep over the whole surface: it enumerates every visible core
 * command registration and asserts the properties that must hold for all of
 * them at once, so a new command (or a rename of an old one) cannot land with
 * a stale usage line, an orphaned group, an unrenderable help page, or a
 * subcommand table that disagrees with the registry.
 *
 * Everything runs against an isolated `HYP_HOME` and an injected kernel, so
 * no boot happens, no listener is bound, no real user state is read or
 * written. `--help` is intercepted by dispatch before `run`, so no command
 * body executes except the bare group commands the unknown-subcommand sweep
 * exercises on purpose, whose whole body is a registry read and an error.
 *
 * Assertions stay structural (names, usage tokens, option spellings, child
 * sets, exit codes) rather than one prose snapshot, so a wording change to a
 * single summary does not fail the whole gate. The two exceptions are the
 * destructive commands, whose warnings are pinned exactly.
 *
 * @ref LLP 0009#layered-help [tests]: one row per top-level token, subcommand summaries only in group help, both read the one registry so they cannot drift
 * @ref LLP 0009#central-help-interception [tests]: dispatch renders help for every registration instead of running it, so no command body prints its own
 * @ref LLP 0181#the-rule [constrained-by]: the sweep dispatches only help and unknown-subcommand argv, so no command body reaches a service manager
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CORE_VERBS } from '../../src/core/cli/core_verbs.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { listGroupChildren } from '../../src/core/cli/group_help.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { usageForVerb } from '../../src/core/cli/verb_codec.js'
import { verbToCommand } from '../../src/core/cli/verb_command.js'

/** A long option (`--dry-run`) or a single-letter short option (`-y`). */
const LONG_OPTION = /^--[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHORT_OPTION = /^-[a-zA-Z]$/

/**
 * Sweeps dispatch help for every registration. Bounded so that a regression
 * in the central `--help` interception (which would send each argv into the
 * real command body) fails the gate instead of hanging on one that waits for
 * input.
 */
const SWEEP_TIMEOUT_MS = 60_000

/**
 * A bare group command built by `makeGroupCommand` is recognizable by the
 * usage line that factory writes. Those, and only those, exist purely for
 * help, so only those owe an unknown-subcommand error: `backfill` also has
 * children but its own argv is a provider list.
 *
 * @param {{ name: string, usage: string }} command
 */
function isHelpOnlyGroup(command) {
  return command.usage === `hyp ${command.name} <subcommand> [args...]`
}

/** @returns {{ write(chunk: string): boolean, text(): string }} */
function buffer() {
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

/** The core registry exactly as `bin/hypaware.js` assembles it before boot. */
function coreRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  return registry
}

/**
 * An isolated CLI harness: a fresh `HYP_HOME` and an empty workspace so no
 * bundled plugin manifest is discovered, plus a pre-built kernel so dispatch
 * skips `bootKernel` entirely.
 *
 * @param {ReturnType<typeof coreRegistry>} [registry]
 */
async function harness(registry = coreRegistry()) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cli-gate-home-'))
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-cli-gate-ws-'))
  // Without an explicit `cacheRoot` the kernel falls back to
  // `process.env.HYP_HOME`, i.e. the developer's real `~/.hyp`, which the
  // `readdir(hypHome)` guard below could never see.
  const kernel = createKernelRuntime({
    commandRegistry: registry,
    cacheRoot: path.join(hypHome, 'hypaware', 'cache'),
  })
  /**
   * @param {string[]} argv
   * @returns {Promise<{ code: number, out: string, err: string }>}
   */
  async function run(argv) {
    const stdout = buffer()
    const stderr = buffer()
    const code = await dispatch(argv, {
      stdout,
      stderr,
      // `resolveConfigPath` honours `HYP_CONFIG` ahead of `HYP_HOME`, so an
      // exported one would aim the help path at the developer's real config.
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      registry,
      kernel,
      workspaceDir,
    })
    return { code, out: stdout.text(), err: stderr.text() }
  }
  return { registry, hypHome, workspaceDir, run }
}

/** Every registration a user can reach from help. */
function visibleCommands() {
  return coreRegistry().list().filter((c) => !c.hidden)
}

// --- registration inventory -------------------------------------------------

test('every core registration carries a one-line summary, a usage line, and a run()', () => {
  for (const command of coreRegistry().list()) {
    assert.ok(command.summary.trim().length > 0, `${command.name}: empty summary`)
    assert.doesNotMatch(command.summary, /\n/, `${command.name}: summary must be one line`)
    assert.doesNotMatch(command.usage, /\n/, `${command.name}: usage must be one line`)
    assert.equal(typeof command.run, 'function', `${command.name}: missing run()`)
  }
})

// A rename that leaves the old spelling in `usage` prints a command the
// binary no longer answers to, which is the same failure class as an
// unrunnable repair line.
test('every usage line invokes the command it documents', () => {
  for (const command of coreRegistry().list()) {
    assert.ok(
      command.usage === `hyp ${command.name}` || command.usage.startsWith(`hyp ${command.name} `),
      `${command.name}: usage '${command.usage}' does not start with 'hyp ${command.name}'`
    )
  }
})

test('every usage line has balanced <required> and [optional] groups', () => {
  /** @param {string} text @param {string} ch */
  const count = (text, ch) => [...text].filter((c) => c === ch).length
  for (const command of coreRegistry().list()) {
    assert.equal(count(command.usage, '<'), count(command.usage, '>'), `${command.name}: unbalanced <>`)
    assert.equal(count(command.usage, '['), count(command.usage, ']'), `${command.name}: unbalanced []`)
  }
})

// Catches `--dry_run`, `--dryRun`, and `-dry` before they reach a release:
// the parsers accept none of those spellings.
test('every option named in a usage line is spelled as an option the parsers accept', () => {
  for (const command of coreRegistry().list()) {
    const tail = command.usage.slice(`hyp ${command.name}`.length)
    // `=` splits too: `--format=<fmt>` is a spelling `verb_codec` parses, so
    // the check is on the option name rather than on the whole token.
    for (const token of tail.split(/[\s[\]<>|=]+/)) {
      if (!token.startsWith('-')) continue
      assert.ok(
        LONG_OPTION.test(token) || SHORT_OPTION.test(token),
        `${command.name}: '${token}' is not a valid option spelling`
      )
    }
  }
})

// Without this a leaf like `foo bar` can register under a group nothing
// describes, and `hyp foo` falls through to the generic unknown-command
// error instead of a subcommand table.
test('every subcommand hangs off a registered bare command or a registered group', () => {
  const registry = coreRegistry()
  for (const command of registry.list()) {
    const tokens = command.name.split(' ')
    for (let i = 1; i < tokens.length; i += 1) {
      const prefix = tokens.slice(0, i).join(' ')
      assert.ok(
        registry.get(prefix) !== undefined || registry.getGroup(prefix) !== undefined,
        `${command.name}: group '${prefix}' is neither a registered command nor a registered group`
      )
    }
  }
})

test('every alias resolves to its owning command and shadows nothing', () => {
  const registry = coreRegistry()
  const names = new Set(registry.list().map((c) => c.name))
  for (const command of registry.list()) {
    for (const alias of command.aliases ?? []) {
      assert.equal(registry.get(alias)?.name, command.name, `alias '${alias}' does not resolve to ${command.name}`)
      assert.equal(names.has(alias), false, `alias '${alias}' shadows a registered command`)
    }
  }
})

// A verb declares one `inputSchema` from which the kernel projects both the
// CLI usage and the MCP tool. A hand-written usage on the projection is the
// drift that contract exists to prevent.
// @ref LLP 0034#verbs [tests]: the projected CLI usage stays derived from the verb schema
test('every core verb projects the usage its schema generates', () => {
  const registry = coreRegistry()
  for (const verb of CORE_VERBS) {
    const command = registry.get(verb.name)
    assert.ok(command, `core verb '${verb.name}' is not registered as a command`)
    assert.equal(command.usage, usageForVerb(verb.name, verb.inputSchema), `${verb.name}: usage drifted from its schema`)
  }
})

// The interception is what lets every command body stay help-free. Proving
// it needs a body that would be loud if it ran.
test('--help never reaches the command body', async () => {
  const registry = coreRegistry()
  registry.register({
    name: 'gate-probe',
    summary: 'Fixture that must never run',
    usage: 'hyp gate-probe [--flag]',
    help: 'Long help for the fixture.',
    run: () => {
      throw new Error('command body ran under --help')
    },
  })
  const { run } = await harness(registry)
  const { code, out } = await run(['gate-probe', '--help'])
  assert.equal(code, 0)
  assert.ok(out.startsWith('hyp gate-probe - Fixture that must never run\n'))
  assert.ok(out.includes('usage: hyp gate-probe [--flag]\n'))
  assert.ok(out.includes('Long help for the fixture.\n'))
})

// --- top-level help ---------------------------------------------------------

test('hyp --help lists exactly the visible top-level tokens and nothing deeper', async () => {
  const { run } = await harness()
  const { code, out, err } = await run(['--help'])
  assert.equal(code, 0)
  assert.equal(err, '')

  const body = out.split('Commands:\n')[1] ?? ''
  const listed = new Set(
    body
      .split('\n')
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().split(/\s{2,}/)[0])
  )
  const expected = new Set(visibleCommands().map((c) => c.name.split(' ')[0]))
  assert.deepEqual([...listed].sort(), [...expected].sort())

  // Subcommands live one level down, never as their own top-level row.
  for (const command of visibleCommands()) {
    if (!command.name.includes(' ')) continue
    assert.equal(listed.has(command.name), false, `${command.name} leaked into top-level help`)
  }
})

test('hyp --help renders sorted rows and no undefined summary', async () => {
  const { run } = await harness()
  const { out } = await run(['--help'])
  const body = out.split('Commands:\n')[1] ?? ''
  const names = body
    .split('\n')
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(/\s{2,}/)[0])
  assert.deepEqual(names, [...names].sort())
  assert.doesNotMatch(out, /undefined/)
})

test('-h renders the same top-level help as --help', async () => {
  const { run } = await harness()
  const long = await run(['--help'])
  const short = await run(['-h'])
  assert.equal(short.code, 0)
  assert.equal(short.out, long.out)
})

test('hidden commands stay out of help but stay dispatchable', { timeout: SWEEP_TIMEOUT_MS }, async () => {
  const registry = coreRegistry()
  const hidden = registry.list().filter((c) => c.hidden)
  assert.ok(hidden.length > 0, 'expected at least one hidden command to guard')
  const { run } = await harness(registry)
  const { out } = await run(['--help'])
  const body = out.split('Commands:\n')[1] ?? ''
  for (const command of hidden) {
    assert.doesNotMatch(body, new RegExp(`^ {2}${command.name}\\s`, 'm'), `${command.name} leaked into help`)
    // Through `dispatch`, not `registry.match`: a visibility guard added
    // around the lookup would leave a registry-only assertion green while
    // `hyp smoke <flow>` stopped resolving.
    const reached = await run([...command.name.split(' '), '--help'])
    assert.equal(reached.code, 0, `${command.name} --help exited ${reached.code}`)
    assert.ok(
      reached.out.startsWith(`hyp ${command.name} - `) || reached.out.includes(`usage: ${command.usage}`),
      `${command.name}: dispatch did not reach the hidden registration`
    )
  }
})

// Help must not read or seed the user's install. That help renders *before
// boot* is pinned by test/core/command-dispatch.test.js; this harness injects
// a kernel, so `bootKernel` is never reached and cannot be the thing under
// test. What is under test is the consequence: no help page on any
// registration seeds state.
// @ref LLP 0009#top-level-help-lists-plugin-commands-without-booting [tests]: no registration's help page seeds the install it renders from
test('rendering help writes nothing under HYP_HOME', { timeout: SWEEP_TIMEOUT_MS }, async () => {
  const { run, hypHome } = await harness()
  await run(['--help'])
  for (const command of visibleCommands()) {
    await run([...command.name.split(' '), '--help'])
  }
  assert.deepEqual(await fs.readdir(hypHome), [])
})

// --- per-command help -------------------------------------------------------

test('every visible group renders its registry-backed subcommand table', { timeout: SWEEP_TIMEOUT_MS }, async () => {
  const registry = coreRegistry()
  const { run } = await harness(registry)
  let checked = 0
  for (const command of registry.list()) {
    if (command.hidden) continue
    const children = listGroupChildren(registry, command.name)
    if (children.length === 0) continue
    checked += 1
    const { code, out, err } = await run([...command.name.split(' '), '--help'])
    assert.equal(code, 0, `${command.name} --help exited ${code}`)
    assert.equal(err, '', `${command.name} --help wrote to stderr`)
    assert.doesNotMatch(out, /undefined/, `${command.name} --help rendered 'undefined'`)
    assert.ok(out.includes(`usage: ${command.usage}\n`), `${command.name} --help omits its usage line`)
    for (const child of children) {
      assert.match(out, new RegExp(`^ {2}${child.name}\\s`, 'm'), `${command.name} --help omits child '${child.name}'`)
    }
  }
  assert.ok(checked > 0, 'expected at least one visible group')
})

test('every visible leaf renders its own summary, usage, and nothing on stderr', { timeout: SWEEP_TIMEOUT_MS }, async () => {
  const registry = coreRegistry()
  const { run } = await harness(registry)
  let checked = 0
  for (const command of registry.list()) {
    if (command.hidden) continue
    if (listGroupChildren(registry, command.name).length > 0) continue
    checked += 1
    const { code, out, err } = await run([...command.name.split(' '), '--help'])
    assert.equal(code, 0, `${command.name} --help exited ${code}`)
    assert.equal(err, '', `${command.name} --help wrote to stderr`)
    assert.ok(out.startsWith(`hyp ${command.name} - ${command.summary}\n`), `${command.name} --help header drifted`)
    assert.ok(out.includes(`usage: ${command.usage}\n`), `${command.name} --help omits its usage line`)
  }
  assert.ok(checked > 0, 'expected at least one visible leaf')
})

test('every help-only group rejects an unknown subcommand with exit 2 and names the real ones', { timeout: SWEEP_TIMEOUT_MS }, async () => {
  const registry = coreRegistry()
  const { run } = await harness(registry)
  let checked = 0
  for (const command of registry.list()) {
    if (command.hidden || !isHelpOnlyGroup(command)) continue
    checked += 1
    const { code, err } = await run([...command.name.split(' '), 'zzz-not-a-subcommand'])
    assert.equal(code, 2, `${command.name}: unknown subcommand exited ${code}`)
    assert.match(err, /unknown subcommand 'zzz-not-a-subcommand'/, `${command.name}: message drifted`)
    for (const child of listGroupChildren(registry, command.name)) {
      assert.ok(err.includes(child.name), `${command.name}: error omits child '${child.name}'`)
    }
  }
  assert.ok(checked > 0, 'expected at least one help-only group')
})

test('an unknown top-level command exits 2 and points at help', async () => {
  const { run } = await harness()
  const { code, err } = await run(['zzz-not-a-command'])
  assert.equal(code, 2)
  assert.match(err, /unknown command 'zzz-not-a-command'/)
  assert.match(err, /hyp --help/)
})

test('a public alias dispatches to its owner, help included', async () => {
  const registry = coreRegistry()
  const aliased = registry.list().find((c) => (c.aliases ?? []).length > 0)
  assert.ok(aliased, 'expected at least one public alias to guard')
  const alias = (aliased.aliases ?? [])[0]
  const { run } = await harness(registry)
  const { code, out } = await run([alias, '--help'])
  assert.equal(code, 0)
  assert.ok(out.startsWith(`hyp ${aliased.name} - ${aliased.summary}\n`))
})

// --- active-plugin fixture --------------------------------------------------

/**
 * Compare a plugin's manifest `contributes.commands` with what it actually
 * registered, in both directions. This is the shape a plugin author owes:
 * pre-boot help reads the manifest and dispatch reads the registrations, so
 * a name or summary present in one and not the other is a command help
 * advertises and dispatch cannot serve, or the reverse.
 *
 * @param {{ name: string, summary: string }[]} manifestCommands
 * @param {{ name: string, summary: string, hidden?: boolean }[]} runtimeCommands
 * @returns {string[]}
 */
function manifestRuntimeDrift(manifestCommands, runtimeCommands) {
  /** @type {string[]} */
  const findings = []
  const runtime = new Map(runtimeCommands.filter((c) => !c.hidden).map((c) => [c.name, c.summary]))
  const manifest = new Map(manifestCommands.map((c) => [c.name, c.summary]))
  for (const [name, summary] of manifest) {
    if (!runtime.has(name)) {
      findings.push(`manifest-only command '${name}'`)
    } else if (runtime.get(name) !== summary) {
      findings.push(`summary drift on '${name}'`)
    }
  }
  for (const name of runtime.keys()) {
    if (!manifest.has(name)) findings.push(`runtime-only public command '${name}'`)
  }
  return findings.sort()
}

const FIXTURE_MANIFEST_COMMANDS = [
  { name: 'gate-fixture render', summary: 'Render the fixture' },
  { name: 'gate-fixture lookup', summary: 'Look a fixture row up' },
]

/**
 * Register the fixture plugin's contributions exactly as its `activate`
 * would: a group description with no bare command, one imperative leaf, one
 * verb projected to a command, and one internal command kept out of the
 * manifest.
 *
 * @param {ReturnType<typeof coreRegistry>} registry
 */
function activateFixturePlugin(registry) {
  registry.registerGroup({
    name: 'gate-fixture',
    summary: 'Fixture plugin surface',
    help: 'Registered by the fixture plugin, not by core.',
  })
  registry.register({
    name: 'gate-fixture render',
    plugin: '@hypaware/gate-fixture',
    summary: 'Render the fixture',
    usage: 'hyp gate-fixture render [--json]',
    run: async () => 0,
  })
  registry.register(
    verbToCommand(
      /** @type {any} */ ({
        name: 'gate-fixture lookup',
        plugin: '@hypaware/gate-fixture',
        tool: 'gate_fixture_lookup',
        summary: 'Look a fixture row up',
        inputSchema: {
          type: 'object',
          properties: { row: { type: 'string' } },
          required: ['row'],
          positional: ['row'],
        },
        operation: async () => ({ ok: true }),
        render: () => ({ stdout: '' }),
      })
    )
  )
  registry.register({
    name: 'gate-fixture internal-step',
    plugin: '@hypaware/gate-fixture',
    summary: 'Internal step invoked by render',
    usage: 'hyp gate-fixture internal-step',
    hidden: true,
    run: async () => 0,
  })
}

test('an active plugin renders group, leaf, and verb-projected help through the same dispatch', async () => {
  const registry = coreRegistry()
  activateFixturePlugin(registry)
  const { run } = await harness(registry)

  const group = await run(['gate-fixture', '--help'])
  assert.equal(group.code, 0)
  assert.equal(group.err, '')
  assert.match(group.out, /^hyp gate-fixture - Fixture plugin surface\n/)
  assert.match(group.out, /Registered by the fixture plugin, not by core\./)
  assert.match(group.out, /^ {2}lookup\s/m)
  assert.match(group.out, /^ {2}render\s/m)
  assert.doesNotMatch(group.out, /internal-step/)

  const leaf = await run(['gate-fixture', 'render', '--help'])
  assert.equal(leaf.code, 0)
  assert.ok(leaf.out.startsWith('hyp gate-fixture render - Render the fixture\n'))
  assert.ok(leaf.out.includes('usage: hyp gate-fixture render [--json]\n'))

  const projected = await run(['gate-fixture', 'lookup', '--help'])
  assert.equal(projected.code, 0)
  assert.ok(projected.out.includes(`usage: ${usageForVerb('gate-fixture lookup', /** @type {any} */ ({
    type: 'object',
    properties: { row: { type: 'string' } },
    required: ['row'],
    positional: ['row'],
  }))}\n`))

  // A namespace with no bare command earns one synthesized top-level row.
  const top = await run(['--help'])
  assert.match(top.out, /^ {2}gate-fixture\s+Subcommands: lookup, render$/m)
  assert.doesNotMatch(top.out, /internal-step/)
})

test('manifest and runtime registrations agree for a consistent plugin', () => {
  const registry = coreRegistry()
  activateFixturePlugin(registry)
  const runtime = registry.list().filter((c) => c.plugin === '@hypaware/gate-fixture')
  assert.deepEqual(manifestRuntimeDrift(FIXTURE_MANIFEST_COMMANDS, runtime), [])
})

// The comparison is only worth running if it fails on real drift, so pin
// each direction against a deliberately inconsistent fixture.
test('the manifest/runtime comparison reports each direction of drift', () => {
  const registry = coreRegistry()
  activateFixturePlugin(registry)
  const runtime = registry.list().filter((c) => c.plugin === '@hypaware/gate-fixture')

  assert.deepEqual(
    manifestRuntimeDrift([...FIXTURE_MANIFEST_COMMANDS, { name: 'gate-fixture ghost', summary: 'Advertised only' }], runtime),
    ["manifest-only command 'gate-fixture ghost'"]
  )
  assert.deepEqual(
    manifestRuntimeDrift(
      [{ name: 'gate-fixture render', summary: 'Render the fixture (subcommands: none)' }, FIXTURE_MANIFEST_COMMANDS[1]],
      runtime
    ),
    ["summary drift on 'gate-fixture render'"]
  )
  assert.deepEqual(
    manifestRuntimeDrift([FIXTURE_MANIFEST_COMMANDS[0]], runtime),
    ["runtime-only public command 'gate-fixture lookup'"]
  )
})

// --- safety-critical prose --------------------------------------------------

// Destructive commands are the one place a paraphrase is a defect: the help
// is the only warning a user gets before the rows are gone. Pinned exactly,
// and deliberately few.
test('destructive commands keep their exact warnings', async () => {
  const { run } = await harness()

  const purge = await run(['purge', '--help'])
  assert.equal(purge.code, 0)
  assert.ok(purge.out.includes("Permanently deletes recorded rows from THIS machine's local cache."))
  assert.ok(purge.out.includes('Prompts on a TTY; pass --yes to delete non-interactively.'))

  const reportDelete = await run(['report', 'delete', '--help'])
  assert.equal(reportDelete.code, 0)
  assert.ok(reportDelete.out.includes('Org-wide and permanent: the report disappears for every member.'))
  assert.ok(reportDelete.out.includes('Prompts on a TTY; pass --yes to delete non-interactively.'))
})
