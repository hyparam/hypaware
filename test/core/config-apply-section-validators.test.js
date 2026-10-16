// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { bootKernel } from '../../src/core/runtime/boot.js'
import { buildConfigApplyDeps } from '../../src/core/config/apply_deps.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

/**
 * Apply-time validation must dispatch to the per-plugin `config_sections`
 * validators the active plugins register at activation (LLP 0037). The wiring
 * is the live `configRegistry`, threaded from the booted runtime into
 * `buildConfigApplyDeps`. Without it the validators are dead in production: a
 * served central config with a malformed plugin `config` block (e.g. the
 * claude/codex `backfill` policy) would be accepted instead of rolled back.
 *
 * These tests boot the real kernel so the claude validator registers exactly
 * the way the daemon registers it: no hand-rolled registry.
 */

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

/**
 * Boot a kernel from a local config with the given plugin list, returning the
 * booted runtime so apply deps can be built against the live registry.
 *
 * @param {string[]} pluginNames
 */
async function bootWith(pluginNames) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-section-validators-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  const configPath = defaultConfigPath(hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 2,
      plugins: pluginNames.map((name) => ({ name })),
    }) + '\n'
  )
  const boot = await bootKernel({ hypHome, configPath, env: env(hypHome), mode: 'cli' })
  return { hypHome, stateRoot, boot, cleanup: () => fs.rm(hypHome, { recursive: true, force: true }) }
}

/** Boot ai-gateway + claude from a local config so the claude section registers. */
function bootWithClaude() {
  return bootWith(['@hypaware/ai-gateway', '@hypaware/claude'])
}

test('apply validation rejects a malformed plugin backfill block via the live section validator', async () => {
  const fx = await bootWithClaude()
  try {
    // The claude plugin must have registered its `config_sections` validator
    // during activation: that is the registry the apply path now consults.
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

test('apply validates a backfill block for a plugin the document INTRODUCES but is not active yet', async () => {
  // Round-2 regression: the live registry only carries validators for
  // *already-active* plugins. A central config that first introduces a
  // backfill-capable plugin (the realistic join/fleet path) would skip its
  // `config.backfill` validation. The apply path now discovers the introduced
  // plugin's section validator from disk (side-effect-free, never activates
  // it), so the malformed block is rejected, not silently accepted.
  //
  // Boot WITHOUT claude/codex so neither section is in the live registry.
  const fx = await bootWith(['@hypaware/ai-gateway'])
  try {
    const registry = /** @type {{ list(): Array<{ plugin: string }> }} */ (
      /** @type {unknown} */ (fx.boot.runtime.configRegistry)
    )
    const live = registry.list().map((s) => s.plugin)
    assert.ok(
      !live.includes('@hypaware/claude') && !live.includes('@hypaware/codex'),
      `neither client section should be live-registered, got ${JSON.stringify(live)}`
    )

    const deps = buildConfigApplyDeps({
      stateRoot: fx.stateRoot,
      configRegistry: fx.boot.runtime.configRegistry,
    })

    // A doc that first introduces claude + codex, claude's backfill malformed.
    const badDoc = {
      version: 2,
      plugins: [
        { name: '@hypaware/ai-gateway' },
        { name: '@hypaware/claude', config: { backfill: { on_join: 'false', window_days: -3 } } },
        { name: '@hypaware/codex' },
      ],
    }
    const res = await deps.validateDocument(badDoc)
    assert.equal(res.ok, false, 'an introduced plugin with a malformed backfill block must be rejected')
    const kinds = /** @type {Array<{ errorKind?: string }>} */ (res.errors).map((e) => e.errorKind)
    assert.ok(
      kinds.includes('config_section_invalid'),
      `expected a config_section_invalid error, got ${JSON.stringify(kinds)}`
    )

    // The same introduce-claude/codex doc with well-formed blocks validates.
    const goodDoc = {
      version: 2,
      plugins: [
        { name: '@hypaware/ai-gateway' },
        { name: '@hypaware/claude', config: { backfill: { on_join: false, window_days: 30 } } },
        { name: '@hypaware/codex', config: { backfill: { on_join: true } } },
      ],
    }
    const ok = await deps.validateDocument(goodDoc)
    assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  } finally {
    await fx.cleanup()
  }
})

test('introduced-plugin discovery rejects a malformed block even without the live registry', async () => {
  // Even with NO live registry passed (a non-daemon caller), the apply path
  // discovers the introduced plugin's validator from disk and rejects the bad
  // block. (Before round-2 this exact shape silently accepted it: the
  // per-plugin validator was dead without the live registry.)
  const fx = await bootWith(['@hypaware/ai-gateway'])
  try {
    const depsNoRegistry = buildConfigApplyDeps({ stateRoot: fx.stateRoot })
    const badDoc = {
      version: 2,
      plugins: [
        { name: '@hypaware/ai-gateway' },
        { name: '@hypaware/claude', config: { backfill: { on_join: 'false' } } },
      ],
    }
    const res = await depsNoRegistry.validateDocument(badDoc)
    assert.equal(res.ok, false, 'disk discovery rejects the malformed block with no live registry')
    const kinds = /** @type {Array<{ errorKind?: string }>} */ (res.errors).map((e) => e.errorKind)
    assert.ok(kinds.includes('config_section_invalid'), JSON.stringify(kinds))
  } finally {
    await fx.cleanup()
  }
})

// An installed copy of a bundled name never activates (LLP 0380), so
// apply-time section discovery must not import its entrypoint either. Before
// this filter the discovery pass ran the stale module's top-level body inside
// the live daemon and then failed its duplicate registration into a spurious
// `config.section_discovery_failed` warning on every apply. The path is only
// reachable since the shadow stopped rejecting boot, so it is guarded here.
// The stub below both records its import and rejects every document, so a
// clean pass proves the shadow was neither loaded nor consulted.
// @ref LLP 0380#bundled-copy-wins [tests]: the shadowed copy is not imported by section discovery either
test('apply-time section discovery never imports an installed copy a bundled name shadows', async () => {
  const fx = await bootWith(['@hypaware/ai-gateway'])
  try {
    const installDir = path.join(fx.stateRoot, 'plugins', '@hypaware', 'github')
    await fs.mkdir(installDir, { recursive: true })
    const sentinel = path.join(fx.hypHome, 'installed-shadow-was-imported')
    await fs.writeFile(
      path.join(installDir, 'hypaware.plugin.json'),
      JSON.stringify({
        schema_version: 1,
        name: '@hypaware/github',
        version: '0.9.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
        contributes: { config_sections: [{ section: 'github' }] },
      })
    )
    // Importing this module is the failure the filter prevents: the body runs
    // at import time, before any registration can be refused.
    await fs.writeFile(
      path.join(installDir, 'index.js'),
      'import fs from \'node:fs\'\n' +
      `fs.writeFileSync(${JSON.stringify(sentinel)}, 'imported')\n` +
      'export const configSection = {\n' +
      '  section: \'github\',\n' +
      '  validate: () => ({ ok: false, errors: [{ pointer: \'/\', message: \'the shadow answered\' }] }),\n' +
      '}\n' +
      'export async function activate() {}\n'
    )
    await writeLock(fx.stateRoot, {
      schema_version: 1,
      plugins: {
        '@hypaware/github': {
          name: '@hypaware/github',
          version: '0.9.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: 'a'.repeat(64),
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-08-31T00:00:00.000Z',
        },
      },
    })

    const deps = buildConfigApplyDeps({
      stateRoot: fx.stateRoot,
      configRegistry: fx.boot.runtime.configRegistry,
    })
    const res = await deps.validateDocument({
      version: 2,
      plugins: [
        { name: '@hypaware/ai-gateway' },
        { name: '@hypaware/github', config: { inventory: 'all_visible' } },
      ],
    })

    assert.equal(
      await fs.access(sentinel).then(() => true, () => false),
      false,
      'the shadowed installed entrypoint must never be imported'
    )
    assert.equal(res.ok, true, `the shadow's validator must not answer: ${JSON.stringify(res.errors)}`)
  } finally {
    await fx.cleanup()
  }
})
