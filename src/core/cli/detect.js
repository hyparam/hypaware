// @ts-check

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveClientSettingsPath } from '../daemon/client_settings_path.js'

/**
 * @import { PickerSource } from './types.d.ts'
 */

/**
 * The client sources the first-run picker can autodetect, paired with
 * the `settings_file` their plugin manifest declares for the attach
 * probe. Detection stats the *directory* that holds this file (the
 * client's config home) — the "tool is installed on this system"
 * signal — not the file itself, so HypAware writing the settings file
 * on attach never makes a source detect itself.
 *
 * This list is intentionally hardcoded rather than read from
 * `catalog.clientDescriptors[*].attach_probe`. At first `npx hypaware`
 * run only bundled plugins exist, so there is no third-party client
 * plugin to discover, and the picker's source list (`PICKER_SOURCES`)
 * is itself hardcoded. If the picker is ever made plugin-driven, move
 * detection to iterate the client descriptors and read each
 * `attach_probe.settings_file` (see `probeClientAttachFromDescriptor`
 * in daemon/status.js) in that same change — not before.
 *
 * @type {{ source: PickerSource, client: string, settingsFile: string }[]}
 */
const DETECTABLE_CLIENT_SOURCES = [
  { source: 'claude', client: 'claude', settingsFile: '.claude/settings.json' },
  { source: 'codex', client: 'codex', settingsFile: '.codex/config.toml' },
]

/**
 * Inspect the system for installed client tools and return the set of
 * picker sources that are present. A source is "present" when the
 * config-home directory of its client exists (`~/.claude`, and
 * `$CODEX_HOME` ?? `~/.codex`). Honors `$CLAUDE_HOME`/`$CODEX_HOME` via
 * the shared {@link resolveClientSettingsPath}.
 *
 * Best-effort: any stat outcome other than "directory exists" is
 * treated as not-present, so detection never blocks or throws the
 * walkthrough. The result only seeds the picker's initial checkbox
 * state; the user can still toggle every box.
 *
 * @param {{ env: NodeJS.ProcessEnv }} opts
 * @returns {Promise<Set<PickerSource>>}
 */
export async function detectClientSources(opts) {
  const env = opts.env
  const homeDir = env.HOME ?? os.homedir()
  /** @type {Set<PickerSource>} */
  const detected = new Set()
  await Promise.all(
    DETECTABLE_CLIENT_SOURCES.map(async ({ source, client, settingsFile }) => {
      const settingsPath = resolveClientSettingsPath(client, settingsFile, env, homeDir)
      const configHome = path.dirname(settingsPath)
      try {
        const stat = await fsp.stat(configHome)
        if (stat.isDirectory()) detected.add(source)
      } catch {
        // ENOENT (or any stat failure) → tool not present; leave unset.
      }
    })
  )
  return detected
}
