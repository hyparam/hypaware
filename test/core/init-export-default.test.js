// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveInitExportChoice } from '../../src/core/cli/core_commands.js'

/** @import { InitFlags } from '../../src/core/cli/types.d.ts' */

/**
 * Build a complete {@link InitFlags} with conservative defaults; tests
 * override only the fields they care about.
 *
 * @param {Partial<InitFlags>} [overrides]
 * @returns {InitFlags}
 */
function flags(overrides = {}) {
  return {
    yes: false,
    noDaemon: false,
    dryRun: false,
    clients: [],
    sources: [],
    exportChoice: undefined,
    retentionDays: 30,
    force: false,
    ...overrides,
  }
}

test('omitting --export defaults to local-parquet (origin=default)', () => {
  // The contract this PR establishes: flag-driven init matches the
  // interactive wizard's local-parquet default instead of diverging to
  // keep-local for the same source selection.
  assert.deepEqual(resolveInitExportChoice(flags({ sources: ['claude'] })), {
    exportChoice: 'local-parquet',
    origin: 'default',
  })
})

test('--yes no longer changes the omitted-export default', () => {
  // Pre-unification, the default was keep-local without --yes and
  // local-parquet with it. Now --yes is irrelevant to the export default.
  assert.deepEqual(resolveInitExportChoice(flags({ yes: true, sources: ['claude', 'otel'] })), {
    exportChoice: 'local-parquet',
    origin: 'default',
  })
})

test('explicit --export keep-local is honored (origin=user)', () => {
  assert.deepEqual(resolveInitExportChoice(flags({ exportChoice: 'keep-local' })), {
    exportChoice: 'keep-local',
    origin: 'user',
  })
})

test('explicit --export configure-later is honored (origin=user)', () => {
  assert.deepEqual(resolveInitExportChoice(flags({ exportChoice: 'configure-later' })), {
    exportChoice: 'configure-later',
    origin: 'user',
  })
})

test('explicit --export local-parquet still reports origin=user', () => {
  // Even when the explicit value equals the default, origin must be `user`
  // so telemetry can tell a deliberate pick from a system default.
  assert.deepEqual(resolveInitExportChoice(flags({ exportChoice: 'local-parquet' })), {
    exportChoice: 'local-parquet',
    origin: 'user',
  })
})
