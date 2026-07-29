// @ts-check

import path from 'node:path'

/**
 * A `settings_file` that violates the home-relative contract.
 *
 * Typed (`code`) rather than a bare `Error` so a caller that needs to
 * distinguish *which* rule was broken, or to tell a contract violation from
 * an fs failure, can branch on `instanceof` and `code` instead of matching
 * on message text. Callers that only need to make it observable (the attach
 * probe's `error` field, a nonzero command exit) forward the message.
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
 * A leading `/` is not the only way out of the base, and the harm does not
 * depend on the spelling: `../../../etc/passwd` lands on exactly the same
 * "a file the manifest never named" as `/etc/passwd` does, and this resolver
 * feeds the *write* side too, where `detachClientFromDisk` reads and rewrites
 * whatever it points at. So the resolved path is also required to stay under
 * the base it was resolved against, and the two branches are checked against
 * their own base - `$HOME` normally, `$<CLIENT>_HOME` when the override is
 * set, since the override is exactly a licence to leave `$HOME`.
 *
 * That containment check is **lexical**, not `realpath`-based: a config home
 * that is itself a symlink out of `$HOME` (`~/.codex -> /elsewhere`) still
 * passes. Deliberate, and the boundary of what this guard promises. The field
 * is resolved before the file has to exist (attach writes it, the picker only
 * stats its directory), so `realpath` would fail on exactly the paths that
 * matter most; and planting that symlink already requires write access to
 * `$HOME`, at which point the settings file is the attacker's anyway. What the
 * guard stops is a *manifest value* aiming core at a file outside the base -
 * which is the untrusted input, since `contributes.client` is unvalidated.
 *
 * Pure (path-only) so both the daemon status attach-probe and the
 * first-run source detector can share it without pulling in either
 * module's heavier import graph.
 *
 * @ref LLP 0045#settings_file-is-home-relative-and-a-violation-is-loud [implements]: reject an absolute settings_file rather than re-anchoring it under $HOME, and reject a relative one that climbs out of the base
 * @param {string} clientName
 * @param {string} settingsFile
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {string} homeDir
 * @returns {string}
 * @throws {ClientSettingsPathError} when `settingsFile` is absolute, or resolves outside its base
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
    return withinBase(clientName, settingsFile, override, path.join(override, ...parts.slice(1)))
  }
  return withinBase(clientName, settingsFile, homeDir, path.join(homeDir, ...settingsFile.split('/')))
}

/**
 * Assert that `joined` did not climb out of `base`, and return the resolved
 * form of it. Compared after `path.resolve` so a `..` that normalizes away
 * (`.codex/../config`) is fine while one that escapes is not.
 *
 * Two things this comparison is careful about:
 *
 * - The `root + path.sep` suffix is load-bearing. A bare
 *   `target.startsWith(root)` admits any sibling whose name merely *starts*
 *   with the base's (`$HOME` of `/home/u` would accept `/home/username/x`),
 *   which is the classic way a containment check is silently wrong.
 * - The **checked** string is the one **returned**. Returning the raw
 *   `path.join` output instead would hand back a value that was never the one
 *   validated whenever `base` is relative (`CODEX_HOME=..` yields the relative
 *   `../config.toml`, resolved against whatever `process.cwd()` happens to be
 *   at read time rather than at check time). This function's whole contract is
 *   an absolute path, so return the absolute one.
 *
 * `target === root` is left alone: an empty or fully-normalizing-away
 * `settings_file` points *at* the base, not out of it, which is the
 * pre-existing reading. It is not silent either - the callers then read a
 * directory and surface the `EISDIR`.
 *
 * @param {string} clientName
 * @param {string} settingsFile  the declared value, named in the error rather than the resolved path
 * @param {string} base
 * @param {string} joined
 * @returns {string}
 * @throws {ClientSettingsPathError} when `joined` falls outside `base`
 */
function withinBase(clientName, settingsFile, base, joined) {
  const root = path.resolve(base)
  const target = path.resolve(joined)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new ClientSettingsPathError(
      `client '${clientName}' declares a settings_file '${settingsFile}' that resolves outside ` +
        `'${root}'; settings_file must stay under the client's config home`,
      { code: 'settings_file_escapes_base' }
    )
  }
  return target
}
