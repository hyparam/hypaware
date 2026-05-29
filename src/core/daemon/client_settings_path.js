// @ts-check

import path from 'node:path'

/**
 * Resolve the absolute settings-file path for a client. The manifest
 * `settings_file` is relative to `$HOME` (e.g. `.codex/config.toml`).
 * Client-specific env overrides like `CODEX_HOME` replace the first
 * directory component (`.codex` → `$CODEX_HOME`).
 *
 * Pure (path-only) so both the daemon status attach-probe and the
 * first-run source detector can share it without pulling in either
 * module's heavier import graph.
 *
 * @param {string} clientName
 * @param {string} settingsFile
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {string} homeDir
 * @returns {string}
 */
export function resolveClientSettingsPath(clientName, settingsFile, env, homeDir) {
  const envKey = `${clientName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_HOME`
  const override = env?.[envKey]
  if (typeof override === 'string' && override.length > 0) {
    const parts = settingsFile.split('/')
    return path.join(override, ...parts.slice(1))
  }
  return path.join(homeDir, ...settingsFile.split('/'))
}
