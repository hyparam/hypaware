// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { bootKernel } from '../../src/core/runtime/boot.js'
import { buildConfigApplyDeps } from '../../src/core/config/apply_deps.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/**
 * Apply-time validation must dispatch to the per-plugin `config_sections`
 * validators the active plugins register at activation (LLP 0037). The wiring
 * is the live `configRegistry`, threaded from the booted runtime into
 * `buildConfigApplyDeps`. Without it the validators are dead in production: a
 * served central config with a malformed plugin `config` block (e.g. the
 * claude/codex `backfill` policy) would be accepted instead of rolled back.
 *
 * These tests boot the real kernel so the claude validator registers exactly
 * the way the daemon registers it — no hand-rolled registry.
 */

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

/** Boot ai-gateway + claude from a local config so the claude section registers. */
async function bootWithClaude() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-section-validators-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  const configPath = defaultConfigPath(hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 2,
      plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
    }) + '\n'
  )
  const boot = await bootKernel({ hypHome, configPath, env: env(hypHome), mode: 'cli' })
  return { hypHome, stateRoot, boot, cleanup: () => fs.rm(hypHome, { recursive: true, force: true }) }
}

test('apply validation rejects a malformed plugin backfill block via the live section validator', async () => {
  const fx = await bootWithClaude()
  try {
    // The claude plugin must have registered its `config_sections` validator
    // during activation — that is the registry the apply path now consults.
    // (`list()` is on the concrete registry; the runtime types it as the
    // narrower ConfigRegistry, so reach it through a local cast.)
    const registry = /** @type {{ list(): Array<{ plugin: string }> }} */ (
      /** @type {unknown} */ (fx.boot.runtime.configRegistry)
    )
    assert.ok(
      registry.list().some((s) => s.plugin === '@hypaware/claude'),
      'claude registered its config section at activation'
    )

    const deps = buildConfigApplyDeps({
      stateRoot: fx.stateRoot,
      configRegistry: fx.boot.runtime.configRegistry,
    })

    // `on_join: "false"` is the JSON typo the section validator rejects.
    const badDoc = {
      version: 2,
      plugins: [
        { name: '@hypaware/ai-gateway' },
        { name: '@hypaware/claude', config: { backfill: { on_join: 'false' } } },
      ],
    }
    const res = await deps.validateDocument(badDoc)
    assert.equal(res.ok, false, 'a malformed backfill block must fail apply validation')
    const kinds = /** @type {Array<{ errorKind?: string }>} */ (res.errors).map((e) => e.errorKind)
    assert.ok(
      kinds.includes('config_section_invalid'),
      `expected a config_section_invalid error, got ${JSON.stringify(kinds)}`
    )

    // A well-formed backfill block validates cleanly through the same path.
    const goodDoc = {
      version: 2,
      plugins: [
        { name: '@hypaware/ai-gateway' },
        { name: '@hypaware/claude', config: { backfill: { on_join: false, window_days: 30 } } },
      ],
    }
    const ok = await deps.validateDocument(goodDoc)
    assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  } finally {
    await fx.cleanup()
  }
})

test('without the live registry the per-plugin validator is dead (the bug this fixes)', async () => {
  const fx = await bootWithClaude()
  try {
    // Same malformed document, but apply deps built WITHOUT the registry —
    // exactly the pre-fix call shape. The cross-plugin checks pass and the
    // dead section validator never runs, so the bad block slips through.
    const depsNoRegistry = buildConfigApplyDeps({ stateRoot: fx.stateRoot })
    const badDoc = {
      version: 2,
      plugins: [
        { name: '@hypaware/ai-gateway' },
        { name: '@hypaware/claude', config: { backfill: { on_join: 'false' } } },
      ],
    }
    const res = await depsNoRegistry.validateDocument(badDoc)
    assert.equal(res.ok, true, 'pre-fix shape accepts the malformed backfill block')
  } finally {
    await fx.cleanup()
  }
})
