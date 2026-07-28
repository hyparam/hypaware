// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createCodexBackfillProvider } from '../../hypaware-core/plugins-workspace/codex/src/backfill.js'

/**
 * Codex Desktop is covered by the ordinary `@hypaware/codex` adapter: it
 * shares `~/.codex/config.toml` (what `hyp attach codex` writes) and
 * `~/.codex/sessions/**` (what the backfill provider reads) with the Codex
 * CLI. These tests pin the two places that previously implied otherwise -
 * the picker copy, and the `unsupported_location` event for the opaque
 * `Application Support/Codex` app container.
 *
 * @ref LLP 0141#one-adapter [tests]: the product surface has to say Desktop is covered, or the separate Claude Desktop setup teaches users it is not
 *
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

const MANIFEST_PATH = new URL(
  '../../hypaware-core/plugins-workspace/codex/hypaware.plugin.json',
  import.meta.url
)

/** @returns {Promise<any>} */
async function readCodexManifest() {
  return JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
}

/**
 * @param {AsyncIterable<BackfillItem | BackfillEvent>} iterable
 * @returns {Promise<BackfillEvent[]>}
 */
async function collectEvents(iterable) {
  /** @type {BackfillEvent[]} */
  const events = []
  for await (const yielded of iterable) {
    if (yielded.type === 'event') events.push(/** @type {BackfillEvent} */ (yielded))
  }
  return events
}

/** @returns {{ ctx: BackfillRunContext, entries: Array<{ level: string, message: string, fields?: Record<string, unknown> }> }} */
function runContext() {
  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const entries = []
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ message, /** @type {Record<string, unknown>=} */ fields) => {
    entries.push({ level, message, fields })
  }
  /** @type {any} */
  const log = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
  /** @type {BackfillRunContext} */
  const ctx = {
    env: {},
    cacheRoot: path.join(os.tmpdir(), 'codex-desktop-coverage-cache-unused'),
    dryRun: false,
    log,
    storage: /** @type {any} */ ({}),
  }
  return { ctx, entries }
}

test('the codex picker names Codex Desktop, not just "Codex conversations"', async () => {
  const manifest = await readCodexManifest()
  const picker = manifest.contributes.picker.find((/** @type {any} */ p) => p.name === 'codex')
  assert.ok(picker, 'codex picker entry exists')

  const copy = `${picker.label}\n${picker.summary}`
  assert.match(copy, /Desktop/, 'picker copy names Desktop')
  assert.match(copy, /CLI/, 'picker copy names the CLI, so "Desktop" is not read as Desktop-only')
})

test('the codex plugin description names both Codex surfaces', async () => {
  const manifest = await readCodexManifest()
  assert.match(manifest.description, /Desktop/, 'plugin description names Desktop')
})

test('the Codex app-container unsupported_location says what IS still captured', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-desktop-coverage-'))
  try {
    // Path-faithful opaque Codex Desktop app container.
    const appDir = path.join(homeDir, 'Library', 'Application Support', 'Codex')
    await fs.mkdir(appDir, { recursive: true })
    await fs.writeFile(path.join(appDir, 'state.bin'), 'opaque', 'utf8')

    const provider = createCodexBackfillProvider({ homeDir })
    const { ctx, entries: logs } = runContext()
    const events = await collectEvents(provider.run(ctx))

    const desktop = events.find(
      (e) => e.event === 'unsupported_location' && e.attributes?.location_kind === 'codex_desktop_app'
    )
    assert.ok(desktop, 'the Codex app container is flagged')

    // Short key-shaped tokens, not prose: the attribute has to stay
    // queryable, and the explanation lives in LLP 0141 and the README.
    assert.equal(
      desktop?.attributes?.covered_by,
      'gateway_live,codex_sessions_rollout',
      'the event names which Codex Desktop capture routes DO work, so "unsupported" is not read as "Codex Desktop is unsupported"'
    )

    // The structured log carries the same statement; both halves are pinned.
    const logged = logs.find(
      (e) => e.message === 'codex.backfill.unsupported_location'
        && e.fields?.location_kind === 'codex_desktop_app'
    )
    assert.ok(logged, 'the Codex app container is logged as well as evented')
    assert.equal(logged?.fields?.covered_by, 'gateway_live,codex_sessions_rollout')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})
