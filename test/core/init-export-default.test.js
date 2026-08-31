// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveInitExportChoice, resolveInitSources } from '../../src/core/commands/init.js'

/** @import { InitFlags } from '../../src/core/cli/types.js' */

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

/* ------------------------------ source picks ------------------------------ */

// The `--yes` default is for the run that named nothing. A `--client` is a
// pick, and folding it in only *after* the default had already been injected
// meant `hyp setup --yes --client opencode` composed Claude capture and
// rewrote the operator's real `~/.claude/settings.json` for a client they
// never named - a capture surface opened without anyone asking for it.
// @ref LLP 0011#autodetect-vs-default [tests]: a default fills a silence, it never overrides a pick
test('--yes alone still captures the Claude + OTEL default', () => {
  assert.deepEqual(resolveInitSources(flags({ yes: true })), ['claude', 'otel'])
})

test('a named client suppresses the --yes default instead of being added to it', () => {
  assert.deepEqual(resolveInitSources(flags({ yes: true, clients: ['opencode'] })), ['opencode'])
})

test('a named source suppresses the --yes default, as it always did', () => {
  assert.deepEqual(resolveInitSources(flags({ yes: true, sources: ['otel'] })), ['otel'])
})

test('--client folds into the sources so a matching --source is not required', () => {
  assert.deepEqual(
    resolveInitSources(flags({ yes: true, sources: ['otel'], clients: ['opencode'] })),
    ['otel', 'opencode'],
  )
})

test('a client already named as a source is not duplicated', () => {
  assert.deepEqual(
    resolveInitSources(flags({ yes: true, sources: ['opencode'], clients: ['opencode'] })),
    ['opencode'],
  )
})

test('naming nothing without --yes resolves to nothing, which is the usage error', () => {
  assert.deepEqual(resolveInitSources(flags()), [])
})

test('a client named without --yes is still a pick, not a usage error', () => {
  assert.deepEqual(resolveInitSources(flags({ clients: ['claude'] })), ['claude'])
})
