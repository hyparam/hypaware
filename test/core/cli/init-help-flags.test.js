// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { INIT_FLAG_NAMES } from '../../../src/core/commands/init.js'

// `hyp init` states its interface in three places that drifted apart: the
// registry entry rendered by `--help`, the non-TTY/unknown-flag hint, and
// the parser's own usage on `hyp init --yes --help`. The registry entry is
// the one a user reads first, so it is the one pinned here.

function initCommand() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const cmd = registry.get('init')
  assert.ok(cmd, 'core registry should register `init`')
  return cmd
}

test('init help documents every flag that selects the non-interactive path', () => {
  const { help } = initCommand()
  const text = String(help ?? '')
  const missing = [...INIT_FLAG_NAMES].filter((flag) => !text.includes(flag))
  assert.deepEqual(missing, [], `init --help omits ${missing.join(', ')}`)
})

test('init usage does not imply --yes gates the other flags', () => {
  const { usage } = initCommand()
  // Any of INIT_FLAG_NAMES enters the non-interactive path on its own
  // (`hyp init --dry-run` needs no --yes), so a usage line that puts
  // --yes ahead of the others outside brackets states something false.
  assert.ok(!/--yes\s+\[/.test(String(usage ?? '')), `usage implies --yes is a required prefix: ${usage}`)
})
