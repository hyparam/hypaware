// @ts-check

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { CORE_COMMAND_ARGS } from '../../src/core/cli/command_args.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'

/**
 * One argument-validation contract for every visible core command: a token
 * the command does not know is a usage error (exit 2) that names the token,
 * never a silently different output mode.
 *
 * @ref LLP 0266#one-contract [tests]: every visible core command rejects an unknown flag with exit 2
 */

const UNKNOWN_FLAG = '--definitely-not-a-real-flag'
const HYP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-arg-validation-'))

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

function visibleCoreCommands() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  return registry
    .list()
    .filter((cmd) => !cmd.hidden)
    .map((cmd) => cmd.name)
    .sort()
}

/** @param {string[]} argv */
async function run(argv) {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(argv, {
    stdout,
    stderr,
    env: { ...process.env, HYP_HOME, NO_COLOR: '1' },
    registry,
    kernel,
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

const COMMANDS = visibleCoreCommands()

test('the core command surface is non-empty', () => {
  assert.ok(COMMANDS.length > 20, `expected the core command set, got ${COMMANDS.length}`)
})

for (const name of COMMANDS) {
  test(`hyp ${name} rejects an unknown flag with exit 2`, async () => {
    const { code, stderr, stdout } = await run([...name.split(' '), UNKNOWN_FLAG])
    assert.equal(code, 2, `hyp ${name} ${UNKNOWN_FLAG} exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`)
    assert.ok(
      stderr.includes(UNKNOWN_FLAG),
      `hyp ${name} exited 2 without naming ${UNKNOWN_FLAG}\nstderr: ${stderr}`
    )
    assert.equal(stdout, '', `hyp ${name} wrote to stdout while refusing: ${stdout}`)
  })
}

/**
 * The other half of the contract: a flag a command's usage line advertises
 * must be one its parser accepts, and vice versa. Both come from the same
 * `CORE_COMMAND_ARGS` entry, so this proves the entry is internally honest
 * rather than that two copies happen to agree today.
 *
 * @ref LLP 0266#usage-agreement [tests]: registered usage and parser schema name the same flags
 */

/** @param {string} usage */
function flagsInUsage(usage) {
  return new Set(usage.match(/--[a-z0-9][a-z0-9-]*/g) ?? [])
}

for (const [name, spec] of Object.entries(CORE_COMMAND_ARGS)) {
  test(`hyp ${name} usage and schema name the same flags`, () => {
    assert.ok(
      spec.usage === `hyp ${name}` || spec.usage.startsWith(`hyp ${name} `),
      `usage for '${name}' does not open with 'hyp ${name}': ${spec.usage}`
    )
    const positional = new Set(spec.schema.positional ?? [])
    const schemaFlags = new Set(
      Object.keys(spec.schema.properties ?? {})
        .filter((prop) => !positional.has(prop))
        .map((prop) => `--${prop.replace(/_/g, '-')}`)
    )
    assert.deepEqual(
      [...flagsInUsage(spec.usage)].sort(),
      [...schemaFlags].sort(),
      `usage/schema flag disagreement for '${name}'`
    )
    for (const prop of positional) {
      assert.ok(
        (spec.schema.properties ?? {})[prop] !== undefined,
        `positional '${prop}' of '${name}' has no schema property`
      )
    }
  })
}

test('every specced command registers its spec usage line', () => {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const byName = new Map(registry.list().map((cmd) => [cmd.name, cmd]))
  for (const [name, spec] of Object.entries(CORE_COMMAND_ARGS)) {
    const registered = byName.get(name)
    assert.ok(registered, `'${name}' has an argument spec but is not registered`)
    assert.equal(registered.usage, spec.usage, `'${name}' registers a usage line the spec does not own`)
  }
})
