// @ts-check

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import { createCodexBackfillProvider } from '../../hypaware-core/plugins-workspace/codex/src/backfill.js'
import { createOpenclawBackfillProvider } from '../../hypaware-core/plugins-workspace/openclaw/src/backfill.js'
import { buildPickerBackfillRunner } from '../../src/core/commands/init.js'
import { createBackfillRegistry } from '../../src/core/registry/backfills.js'

// `hyp init`'s only production wiring of the runner's `sweeping` field is the
// `p.sweep !== undefined` filter in `buildPickerBackfillRunner`. The finale
// tests prove the consumer against a hand-written fake runner; this one proves
// the producer against the real bundled provider contributions, so renaming
// `sweep` or breaking the filter fails here instead of shipping a wizard that
// silently asks OpenClaw a question it cannot honor.
// @ref LLP 0180#decision [tests]: `sweeping` derives from the real
// contributions' `sweep` field - Claude and OpenClaw declare one; Codex does not
test('buildPickerBackfillRunner: sweeping derives from the real provider contributions', () => {
  const home = path.join('/nonexistent', 'picker-runner-home')
  const backfills = createBackfillRegistry()
  backfills.register(createClaudeBackfillProvider({ homeDir: home, stateFile: path.join(home, 'state.json') }))
  backfills.register(createCodexBackfillProvider({ homeDir: home }))
  backfills.register(createOpenclawBackfillProvider({ homeDir: home, env: {} }))

  const runner = buildPickerBackfillRunner(/** @type {any} */ ({ backfills }))

  assert.deepEqual([...runner.available].sort(), ['claude', 'codex', 'openclaw'])
  assert.deepEqual(runner.sweeping, ['claude', 'openclaw'])
})
