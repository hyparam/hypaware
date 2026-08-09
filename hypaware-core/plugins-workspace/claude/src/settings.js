// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ConcurrentEditError, atomicWriteFile, errCode, isPlainObject } from 'hypaware/core/util'
import { markActionRefused } from '../../../../src/core/config/action_refusal.js'

/**
 * Claude Code settings.json attach writer, keyed on the `_hypaware`
 * managed marker.
 *
 * Writes are atomic (temp file + rename) and gated on mtime so a
 * concurrent edit is detected instead of silently overwritten. The
 * `_hypaware` marker is the self-describing undo record the single core
 * undo (`detachClientFromDisk`, LLP 0045 §Part 3) replays: there is no
 * adapter `detach()`; the reverse lives in core so it survives the
 * plugin being unloaded (legacy pre-record markers included).
 *
 * The marker is also a **self-describing undo record**: it records
 * `prev_base_url` (the restore target) and the managed
 * `env.ANTHROPIC_BASE_URL` / session-context hook entries it added, so
 * a format-aware but plugin-agnostic core routine can reverse the
 * attach from disk alone, with the plugin unloaded. See LLP 0045
 * Part 3.
 *
 * The same record carries `prev_malformed`: any `env` / `hooks` block
 * that was present on disk with the wrong JSON type and had to be
 * rebuilt before attach could write into it. Attach repairs rather than
 * refuses, and the marker is what makes the repair reversible and
 * reportable instead of destructive. See LLP 0163.
 */

/**
 * @import { ClaudeAttachOptions, ClaudeAttachResult } from './types.js'
 */

const MARKER_KEY = '_hypaware'
// Each managed event lists which hook command kinds attach installs on it.
// `session-context` (LLP 0085) captures cwd/git identity for the projector and
// rides every event. `classify-cwd` (LLP 0106) is the session-start
// classification prompt and rides only the events where a *fresh* working
// directory appears - the session opening (SessionStart) and a mid-session cwd
// change (CwdChanged) - so a new, still-unclassified folder is caught while it
// makes no sense to re-ask on every prompt or Bash tool call.
const MANAGED_HOOK_SPECS = [
  { event: 'SessionStart', kinds: ['session-context', 'classify-cwd'] },
  { event: 'CwdChanged', kinds: ['session-context', 'classify-cwd'] },
  { event: 'UserPromptSubmit', kinds: ['session-context'] },
  { event: 'PostToolUse', matcher: 'Bash', kinds: ['session-context'] },
]
const MANAGED_HOOK_PATTERN = /\bclaude-hook\s+(session-context|classify-cwd)\b/

// Env keys attach adds *beside* the base URL to undo the defaults Claude Code
// flips when it sees a non-first-party `ANTHROPIC_BASE_URL`. Each entry is only
// ever added when absent and is removed (never restored) on detach - see
// `manageEnvAdditions` for the ownership rule.
//
// - ENABLE_TOOL_SEARCH: keeps deferred (on-demand) tool loading on. Without it
//   Claude Code sends every tool schema up front, tens of thousands of tokens of
//   per-session context bloat.
// - _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: keeps the model's real context
//   window. Behind any other host Claude Code assumes 200k even for native-1M
//   models, so the same session reads as ~18% context instead of ~4% and
//   warnings/auto-compact fire far too early. The key is underscore-prefixed and
//   undocumented: re-verify it against the Claude Code release (last verified
//   2.1.215) if attached sessions start reporting an inflated context percent
//   again. It is one branch of Claude Code's single is-first-party predicate, so
//   it gates more than the window: outbound it adds the context-1m beta header,
//   traceparent propagation and an extended usage-limit header, and it re-enables
//   the first-party-only side channels (error reporting, org policy limits,
//   memory-sync eligibility) that call Anthropic directly rather than the
//   gateway. It does *not* gate credential choice, which follows the oauth
//   session or the configured API key. All of that is accurate here - the gateway
//   is a byte-transparent pass-through to api.anthropic.com. That last part is a
//   precondition, not an invariant: the gateway's anthropic upstream `base_url`
//   is config, so repointing it elsewhere makes the declaration false. See the
//   LLP section below for the full gated list and the blast radius.
const MANAGED_ENV_ADDITIONS = [
  { key: 'ENABLE_TOOL_SEARCH', value: 'true' },
  { key: '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL', value: '1' },
]

export class ClaudeSettingsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ClaudeSettingsError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * Default Claude Code settings.json location: `~/.claude/settings.json`.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultSettingsPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.claude', 'settings.json')
}

/**
 * Route Claude Code through the local AI gateway by writing the
 * `_hypaware` marker, `env.ANTHROPIC_BASE_URL`, and the managed
 * session-context hook entries into settings.json.
 *
 * @param {ClaudeAttachOptions} opts
 * @returns {Promise<ClaudeAttachResult>}
 */
export async function attach(opts) {
  const { port, version, stateFile, settingsPath = defaultSettingsPath(), binPath = 'hyp' } = opts
  validatePort(port)
  validateVersion(version)
  validateStateFile(stateFile)

  const { value, mtimeMs } = await readSettings(settingsPath)
  const priorMarker = isPlainObject(value[MARKER_KEY]) ? value[MARKER_KEY] : undefined

  // A backup an earlier run already recorded at some path. Read before anything
  // is displaced, because it decides what this run is allowed to claim: a prior
  // entry wins (see below), so a value displaced *this* run at an
  // already-recorded path is dropped rather than backed up, and the warning has
  // to say that instead of promising a restore that will not happen.
  // `Object.hasOwn`, not `in`: these keys come off disk.
  // @ref LLP 0163#prev_malformed-is-path-keyed-not-one-field-per-block [constrained-by]: the earliest backup wins, so a later displacement at the same path is discarded, not recorded
  /** @type {Record<string, unknown>} */
  const priorMalformed = priorMarker && isPlainObject(priorMarker.prev_malformed)
    ? priorMarker.prev_malformed
    : {}

  // The backup half of back-up-then-repair. Every block attach has to rebuild
  // because what was on disk was present but the wrong JSON type lands here,
  // keyed by its dotted path: the value goes into the marker (which is already
  // where everything else attach displaces is kept) and the path becomes a
  // warning the caller prints. Attach keeps succeeding; what it destroyed
  // silently before is now both reported and reversible.
  // @ref LLP 0163#back-up-then-repair-not-refuse [implements]: collect displaced malformed blocks for the marker and the caller
  /** @type {Record<string, unknown>} */
  const displaced = {}
  /** @type {string[]} */
  const warnings = []
  /** @type {(dottedPath: string, prior: unknown, expected: 'object' | 'array') => void} */
  const recordDisplaced = (dottedPath, prior, expected) => {
    if (Object.hasOwn(priorMalformed, dottedPath)) {
      // Nowhere to put it. The path already holds the earlier backup, and that
      // one is the user's content from before hypaware first repaired the
      // block, so it is the one worth keeping. This value is genuinely gone;
      // saying "backed up, detach restores it" here would be the same silent
      // destruction the record exists to end, just with a reassuring sentence
      // on top. The value itself is not echoed: a malformed `env` is exactly
      // where an API key ends up, and this string is printed and logged.
      warnings.push(
        `${dottedPath} was not a JSON ${expected}; ` +
        `${MARKER_KEY}.prev_malformed already holds an earlier backup for that path, ` +
        `so this value was discarded and hyp detach will not restore it`
      )
      return
    }
    displaced[dottedPath] = prior
    warnings.push(
      `${dottedPath} was not a JSON ${expected}; ` +
      `its previous value is backed up in ${MARKER_KEY}.prev_malformed and hyp detach restores it`
    )
  }

  const env = ensureObject(value, 'env', recordDisplaced)
  // Presence, not type - the same ownership rule `manageEnvAdditions` follows,
  // and the base URL needs it more, not less. The managed additions at least
  // fall through an ownership guard when they are not ours; this key has no
  // such `continue`, because attach always repoints it. The backup IS the
  // guard. So a type test here did not merely skip a notice: a hand-written
  // `"ANTHROPIC_BASE_URL": null` (a user switching an override back off) or a
  // stray number read as "nothing to back up", attach wrote no
  // `prev_base_url`, and the undo - finding a managed key with no prior to
  // restore - deleted the key outright. The user's value was gone, from a
  // detach that reported success. Back up whatever is on disk, whatever its
  // JSON type; coerce only for the human-readable `prevValue` report, exactly
  // as the core undo does for `removed`. No explicit presence test is needed to
  // read it: JSON cannot encode `undefined`, so `undefined` here already means
  // "absent", and the `prevBaseUrl !== undefined` checks below are the presence
  // test - which is precisely what the discarded type test was standing in for.
  const liveBaseUrl = env.ANTHROPIC_BASE_URL
  // Preserve the recorded original across a re-attach: once we own the
  // URL the live value is *our* gateway URL, so keep the marker's
  // recorded `prev_base_url` rather than backing up the gateway URL
  // over it. A first attach backs up whatever was live. Presence again:
  // attach only ever writes the field when there was something to record, so
  // the field being there is the fact, and `null` is a value we must give back.
  // @ref LLP 0044#conflict-back-up--override-restore-on-leave [constrained-by]: the marker IS the backup restored on leave
  const prevBaseUrl = priorMarker
    ? (Object.hasOwn(priorMarker, 'prev_base_url') ? priorMarker.prev_base_url : undefined)
    : liveBaseUrl

  const baseUrl = `http://127.0.0.1:${port}`
  const commands = managedHookCommands(binPath, stateFile)

  // Undo the defaults Claude Code flips because the gateway URL is not
  // api.anthropic.com: eager tool-schema loading, and a 200k assumed context
  // window that inflates the reported context percent. See
  // MANAGED_ENV_ADDITIONS for the per-key rationale.
  // @ref LLP 0045#enable_tool_search-keep-deferred-tool-loading-on-through-the-gateway [implements]: attach sets ENABLE_TOOL_SEARCH=true so the non-first-party base URL doesn't force eager tool-schema loading
  // @ref LLP 0045#_claude_code_assume_first_party_base_url-keep-the-models-real-context-window [implements]: attach declares the pass-through gateway first-party so the assumed window isn't cut to 200k
  const priorManagedEnv = priorMarker && isPlainObject(priorMarker.managed) && isPlainObject(priorMarker.managed.env)
    ? /** @type {Record<string, unknown>} */ (priorMarker.managed.env)
    : undefined
  const managedAdditions = manageEnvAdditions(env, priorManagedEnv)

  env.ANTHROPIC_BASE_URL = baseUrl
  installManagedHooks(value, commands, recordDisplaced)

  // Preserve a prior backup across a re-attach, for the same reason
  // `prev_base_url` is preserved: once attach has repaired the block the live
  // value is *ours*, so the second attach finds nothing malformed and must not
  // let the record of what the first one displaced fall off the marker. A prior
  // entry wins over anything found this run at the same path - the earliest
  // backup is the one holding the user's own content. `recordDisplaced` already
  // refuses to collect a colliding path, so the spread order is belt and braces.
  // @ref LLP 0044#conflict-back-up--override-restore-on-leave [constrained-by]: the marker IS the backup, so it must survive re-attach
  const prevMalformed = { ...displaced, ...priorMalformed }

  // Self-describing undo record: enough for the format-aware core undo
  // to restore-or-remove `env.ANTHROPIC_BASE_URL`, remove the managed env keys
  // we added, strip the managed hook entries, and delete the marker without
  // loading this plugin, leaving no orphaned `hyp claude-hook` entries.
  // @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements]: claude marker records prev_base_url + managed env/hook entries
  value[MARKER_KEY] = {
    attached_at: new Date().toISOString(),
    version,
    port,
    state_file: stateFile,
    managed: {
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ...managedAdditions,
      },
      hooks: managedHookEntries(commands),
    },
    ...(prevBaseUrl !== undefined ? { prev_base_url: prevBaseUrl } : {}),
    ...(Object.keys(prevMalformed).length > 0 ? { prev_malformed: prevMalformed } : {}),
  }

  await writeAtomic(settingsPath, value, mtimeMs)

  /** @type {ClaudeAttachResult} */
  const result = { changed: true }
  if (prevBaseUrl !== undefined) {
    result.prevValue = typeof prevBaseUrl === 'string' ? prevBaseUrl : String(prevBaseUrl)
  }
  // Only what *this* run displaced. A re-attach carries the prior backup on the
  // marker but has nothing new to tell the user about, so it warns about
  // nothing.
  if (warnings.length > 0) result.warnings = warnings
  return result
}

/**
 * Write each {@link MANAGED_ENV_ADDITIONS} entry that is ours to manage and
 * return exactly those keys for the marker's undo record.
 *
 * A key is ours when a prior marker recorded it as managed (so a re-attach
 * keeps owning the value it wrote) or when it is absent from settings. A value
 * the user set themselves is left untouched and stays out of the undo record,
 * so detach never clobbers it - the same never-clobber-a-user-value stance the
 * base URL takes, minus a backup: these keys are only ever *added*.
 *
 * Ownership turns on **presence, not JSON type**. Claude Code reads these keys
 * as env strings, but settings.json is hand-edited and a user can perfectly well
 * write `"ENABLE_TOOL_SEARCH": true` as a JSON boolean. Testing the type instead
 * of the key let a non-string value fall through the guard: attach coerced it,
 * recorded the key as managed, and detach then deleted the user's own setting.
 * Anything already at the key is the user's, whatever its type.
 *
 * @ref LLP 0045#enable_tool_search-keep-deferred-tool-loading-on-through-the-gateway [implements]: the "only manage the key when it is ours" rule that binds every managed env key
 * @param {Record<string, unknown>} env the live `env` block, mutated in place
 * @param {Record<string, unknown> | undefined} priorManagedEnv the prior marker's managed env, if any
 * @returns {Record<string, string>} the keys attach now manages
 */
function manageEnvAdditions(env, priorManagedEnv) {
  /** @type {Record<string, string>} */
  const managed = {}
  for (const { key, value } of MANAGED_ENV_ADDITIONS) {
    const weOwnIt = priorManagedEnv ? Object.hasOwn(priorManagedEnv, key) : false
    if (!weOwnIt && Object.hasOwn(env, key)) continue
    env[key] = value
    managed[key] = value
  }
  return managed
}

/**
 * @param {string} settingsPath
 * @returns {Promise<{ value: Record<string, unknown>, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readSettings(settingsPath) {
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { value: {}, existed: false, mtimeMs: undefined }
    }
    throw new ClaudeSettingsError(`failed to read ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  let stat
  try {
    stat = await fs.stat(settingsPath)
  } catch (err) {
    throw new ClaudeSettingsError(`failed to stat ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    if (looksLikeJsonc(raw)) {
      throw markActionRefused(
        new ClaudeSettingsError(
          `${settingsPath} appears to be JSONC; refuse to modify`,
          { code: 'JSONC', cause: err }
        )
      )
    }
    throw new ClaudeSettingsError(`malformed JSON in ${settingsPath}: ${errMsg(err)}`, {
      code: 'MALFORMED_JSON',
      cause: err,
    })
  }

  if (!isPlainObject(parsed)) {
    throw new ClaudeSettingsError(
      `${settingsPath} must contain a JSON object at the root`,
      { code: 'NOT_AN_OBJECT' }
    )
  }

  return { value: parsed, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @param {number | undefined} expectedMtimeMs
 * @returns {Promise<void>}
 */
async function writeAtomic(filePath, value, expectedMtimeMs) {
  const body = JSON.stringify(value, null, 2) + '\n'
  try {
    await atomicWriteFile(filePath, body, { mode: 0o600, fsync: true, expectedMtimeMs })
  } catch (err) {
    if (err instanceof ConcurrentEditError) {
      throw new ClaudeSettingsError(err.message, { code: 'CONCURRENT_EDIT', cause: err.cause ?? err })
    }
    throw err
  }
}

/**
 * Get-or-create `value[key]` as an object, handing whatever **present but
 * non-object** value it displaces to `record` first.
 *
 * A hand-edited `"env": "ANTHROPIC_API_KEY=sk-x"` is still something the user
 * wrote and meant. Replacing it with `{}` and returning success destroyed it
 * with nothing on disk to recover it from, and nothing told them. Attach still
 * repairs the block (it has to write into it, and refusing would turn a
 * one-key typo into a failed enrollment), but the displaced value goes into the
 * marker's `prev_malformed` backup, `hyp detach` puts it back, and the caller
 * gets a warning to print.
 *
 * Absent is not malformed: a key that was never there displaces nothing and
 * records nothing, which is the ordinary first-attach path.
 *
 * @ref LLP 0163#back-up-then-repair-not-refuse [implements]: the displaced value is recorded into the marker, not discarded
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @param {(dottedPath: string, prior: unknown, expected: 'object' | 'array') => void} [record]
 * @returns {Record<string, unknown>}
 */
function ensureObject(value, key, record) {
  const existing = value[key]
  if (isPlainObject(existing)) return existing
  // Presence, not type, separates "absent" from "malformed": JSON cannot encode
  // `undefined`, so `hasOwn` is the whole test, and a hand-written `null` is a
  // value the user put there rather than a missing key.
  if (record && Object.hasOwn(value, key)) record(key, existing, 'object')
  /** @type {Record<string, unknown>} */
  const fresh = {}
  value[key] = fresh
  return fresh
}

/**
 * Install every managed hook: for each event in {@link MANAGED_HOOK_SPECS},
 * strip any prior managed handlers, then push one group per command kind the
 * event carries (`session-context`, and on session-start events `classify-cwd`
 * too). A group is `{ matcher?, hooks: [{ type, command }] }`.
 *
 * A present-but-non-array `hooks.<event>` is the same case {@link ensureObject}
 * handles one level up, and takes the same answer: back the value up through
 * `record`, then rebuild the list. Rebuilding is unavoidable here (there is no
 * meaningful way to append a hook group to a string), so the only question is
 * whether the displaced value is recoverable afterwards.
 *
 * @param {Record<string, unknown>} value
 * @param {Record<string, string>} commands map from hook kind to its command string
 * @param {(dottedPath: string, prior: unknown, expected: 'object' | 'array') => void} [record]
 */
function installManagedHooks(value, commands, record) {
  const hooksRoot = ensureObject(value, 'hooks', record)
  for (const spec of MANAGED_HOOK_SPECS) {
    const { event } = spec
    const existing = hooksRoot[event]
    if (record && !Array.isArray(existing) && Object.hasOwn(hooksRoot, event)) {
      record(`hooks.${event}`, existing, 'array')
    }
    const groups = Array.isArray(existing)
      ? existing.filter((group) => !isManagedHookGroup(group)).map(removeManagedHandlers)
      : []
    for (const kind of spec.kinds) {
      groups.push({
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [{ type: 'command', command: commands[kind] }],
      })
    }
    hooksRoot[event] = groups
  }
}

/**
 * The managed hook entries this attach installs, one per (event, kind),
 * recorded into the marker's undo record so the core undo can strip exactly
 * what {@link installManagedHooks} added without re-deriving them from the
 * (possibly unloaded) plugin.
 *
 * @param {Record<string, string>} commands map from hook kind to its command string
 * @returns {{ event: string, matcher?: string, command: string }[]}
 */
function managedHookEntries(commands) {
  /** @type {{ event: string, matcher?: string, command: string }[]} */
  const entries = []
  for (const spec of MANAGED_HOOK_SPECS) {
    for (const kind of spec.kinds) {
      entries.push({
        event: spec.event,
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        command: commands[kind],
      })
    }
  }
  return entries
}

/** @param {unknown} group */
function removeManagedHandlers(group) {
  if (!isPlainObject(group)) return group
  const handlers = group.hooks
  if (!Array.isArray(handlers)) return group
  return {
    ...group,
    hooks: handlers.filter((handler) => !isManagedHookHandler(handler)),
  }
}

/** @param {unknown} group */
function isManagedHookGroup(group) {
  if (!isPlainObject(group)) return false
  const handlers = group.hooks
  return Array.isArray(handlers) &&
    handlers.length > 0 &&
    handlers.every(isManagedHookHandler)
}

/** @param {unknown} handler */
function isManagedHookHandler(handler) {
  if (!isPlainObject(handler)) return false
  return handler.type === 'command' &&
    typeof handler.command === 'string' &&
    MANAGED_HOOK_PATTERN.test(handler.command)
}

/**
 * The command string per managed hook kind. `session-context` needs the
 * absolute state-file path baked in (the projector reads the same file);
 * `classify-cwd` needs no arguments (it derives the machine-local list path and
 * the enrollment state from `HYP_HOME`/config at run time).
 *
 * @param {string} binPath
 * @param {string} stateFile
 * @returns {Record<'session-context' | 'classify-cwd', string>}
 */
function managedHookCommands(binPath, stateFile) {
  const bin = shellQuote(binPath)
  return {
    'session-context': `${bin} claude-hook session-context --state-file ${shellQuote(stateFile)}`,
    'classify-cwd': `${bin} claude-hook classify-cwd`,
  }
}

/** @param {string} value */
function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
  const quote = String.fromCharCode(39)
  return quote + value.split(quote).join(quote + '\\' + quote + quote) + quote
}

/** @param {string} content */
function looksLikeJsonc(content) {
  let inString = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (inString) {
      if (c === '\\' && i + 1 < content.length) {
        i++
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '/' && i + 1 < content.length) {
      const next = content[i + 1]
      if (next === '/' || next === '*') return true
    }
  }
  return false
}

/** @param {unknown} port */
function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ClaudeSettingsError(`invalid port: ${String(port)}`, { code: 'INVALID_PORT' })
  }
}

/** @param {unknown} version */
function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new ClaudeSettingsError('version must be a non-empty string', {
      code: 'INVALID_VERSION',
    })
  }
}

/** @param {unknown} stateFile */
function validateStateFile(stateFile) {
  if (typeof stateFile !== 'string' || stateFile.length === 0) {
    throw new ClaudeSettingsError('stateFile must be a non-empty path', {
      code: 'INVALID_STATE_FILE',
    })
  }
  if (!path.isAbsolute(stateFile)) {
    throw new ClaudeSettingsError(
      `stateFile must be an absolute path, got '${stateFile}'`,
      { code: 'INVALID_STATE_FILE' }
    )
  }
}

/** @param {unknown} err */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}
