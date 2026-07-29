// @ts-check

import path from 'node:path'

/**
 * A `settings_file` that violates the home-relative contract.
 *
 * Typed (`code`) rather than a bare `Error` so a caller can turn it into
 * whatever "observable" means on its own surface - the attach probe's
 * `error` field, a nonzero command exit - without matching on message text.
 *
 * @ref LLP 0045#settings_file-is-home-relative-and-a-violation-is-loud [implements]: a contract-violating settings_file must be observable, never silently re-anchored
 */
export class ClientSettingsPathError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string }} opts
   */
  constructor(message, opts) {
    super(message)
    this.name = 'ClientSettingsPathError'
    /** @type {string} */
    this.code = opts.code
  }
}

/**
 * Resolve the absolute settings-file path for a client. The manifest
 * `settings_file` is relative to `$HOME` (e.g. `.codex/config.toml`).
 * Client-specific env overrides like `CODEX_HOME` replace the first
 * directory component (`.codex` -> `$CODEX_HOME`).
 *
 * An **absolute** `settings_file` violates that contract and throws
 * {@link ClientSettingsPathError}. Both branches below assume a
 * home-relative input - the join would re-anchor `/Library/x` under
 * `$HOME`, and the override branch would drop the leading `/` and graft
 * the rest onto `$<CLIENT>_HOME` - so an absolute path silently probes a
 * file the manifest never named. There is no coherent reading of the
 * env override for an absolute path either: it exists to relocate a
 * client's config *home*, which an absolute path does not have. Fail
 * loudly instead of answering the wrong question.
 *
 * Pure (path-only) so both the daemon status attach-probe and the
 * first-run source detector can share it without pulling in either
 * module's heavier import graph.
 *
 * @ref LLP 0045#settings_file-is-home-relative-and-a-violation-is-loud [implements]: reject an absolute settings_file rather than re-anchoring it under $HOME
 * @param {string} clientName
 * @param {string} settingsFile
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {string} homeDir
 * @returns {string}
 * @throws {ClientSettingsPathError} when `settingsFile` is absolute
 */
export function resolveClientSettingsPath(clientName, settingsFile, env, homeDir) {
  if (path.isAbsolute(settingsFile)) {
    throw new ClientSettingsPathError(
      `client '${clientName}' declares an absolute settings_file '${settingsFile}'; ` +
        "settings_file must be relative to $HOME (e.g. '.codex/config.toml')",
      { code: 'settings_file_absolute' }
    )
  }
  const envKey = `${clientName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_HOME`
  const override = env?.[envKey]
  if (typeof override === 'string' && override.length > 0) {
    const parts = settingsFile.split('/')
    return path.join(override, ...parts.slice(1))
  }
  return path.join(homeDir, ...settingsFile.split('/'))
}
