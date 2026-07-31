// @ts-check

import fsp from 'node:fs/promises'
import os from 'node:os'

import { resolveClientSettingsPath } from '../daemon/client_settings_path.js'
import { ConcurrentEditError, atomicWriteFile } from '../util/fs_atomic.js'
import { errCode, getAtDottedPath, isPlainObject } from '../util/json_util.js'

/**
 * @import { ClientDescriptor } from '../../../src/core/types.js'
 * @import { DetachFromDiskResult } from './types.d.ts'
 */

/**
 * The single core undo — the disk-driven, plugin-agnostic reverse of a
 * client's attach. It is the *one* detach implementation: both the reconciler's
 * `reverse()` (a fleet-config drop, fired only after the staged restart has
 * already unloaded the adapter) and the manual `hyp detach` command route
 * through it, so there is no second implementation to drift from.
 *
 * Reverse runs from **disk state alone** — the descriptor's `attachProbe`
 * locates the settings file, and the client's own settings-file marker is a
 * **self-describing undo record** that `attach()` wrote (LLP 0045 §Part 3). The
 * routine is **format-aware but plugin-agnostic**: it understands `json`
 * (marker-key), `toml` (managed-block), and `json_path` (nested marker
 * object): the same dispatch
 * `probeClientAttached` uses on the *read* side — and how to replay an undo
 * record, never "Claude" vs "Codex". It imports no plugin code (which would not
 * survive the plugin being unloaded), subsuming what the adapters' old
 * `detach()` did — including the Codex `# BEGIN/END hypaware …` marked-block
 * strip and prior-`model_provider` restore. The managed-block convention is
 * therefore a **core-understood format contract**, not a codex-private detail.
 *
 * @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements]: one core/disk-driven undo, format-aware (json marker-key / toml managed-block), plugin-agnostic, reusing resolveClientSettingsPath + the probeClientAttached format dispatch
 * @ref LLP 0044#conflict--back-up--override-restore-on-leave [constrained-by]: the marker is the backup; reverse restores it (or removes the managed value) on leave
 */

// Dotted-path segments the three path writers in this file refuse to walk.
// Every dotted path here comes off disk: `prev_malformed` keys and the
// `managed.set` / `managed.added` / `managed.created_parents` entries of a
// nested-marker record are all named by a settings file a hand-edit can reach.
// The writers walk with plain `parent[segment]`, so a `__proto__` segment
// leaves the document and lands on `Object.prototype` - either assigning there
// (the restore helper creates the parents it walks) or *deleting* from it
// (`deleteAtDottedPath` on a `managed.added` path removes `Object.prototype`
// members outright, breaking every object in the process). No attach records
// such a path, so refusing costs nothing real.
const UNWRITABLE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Whether a dotted path names a segment {@link UNWRITABLE_PATH_SEGMENTS}
 * refuses. Split from the writers so a caller can tell a *policy* refusal apart
 * from a path it merely could not reach, and report the right reason.
 *
 * @ref LLP 0163#detach-restores-the-backup [implements]: one predicate for all three path writers, so a policy refusal is a reason the caller can name
 * @param {string} dottedPath
 * @returns {boolean}
 */
function hasUnwritableSegment(dottedPath) {
  return dottedPath.split('.').some((segment) => UNWRITABLE_PATH_SEGMENTS.has(segment))
}

const TOML_MANAGED_BEGIN = '# BEGIN hypaware'
const TOML_MANAGED_END = '# END hypaware'
const TOML_PREVIOUS_KEY = 'previous_model_provider'
const TOML_ROOT_RESTORE_KEY = 'model_provider'
const TOML_MANAGED_BASE_URL_KEY = 'base_url'

const TOML_BASIC_MULTILINE_DELIMITER = '"""'
const TOML_LITERAL_MULTILINE_DELIMITER = '\'\'\''
const TOML_KEY_PART = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)`
const TOML_DOTTED_KEY = String.raw`${TOML_KEY_PART}(?:\s*\.\s*${TOML_KEY_PART})*`
const TOML_TABLE_HEADER_RE = new RegExp(String.raw`^\s*\[\s*${TOML_DOTTED_KEY}\s*\]\s*(?:#.*)?$`)
const TOML_TABLE_ARRAY_HEADER_RE = new RegExp(String.raw`^\s*\[\[\s*${TOML_DOTTED_KEY}\s*\]\]\s*(?:#.*)?$`)
const TOML_ROOT_MODEL_PROVIDER_RE = new RegExp(
  String.raw`^\s*(?:${TOML_ROOT_RESTORE_KEY}|"${TOML_ROOT_RESTORE_KEY}"|'${TOML_ROOT_RESTORE_KEY}')\s*=`
)

export class ClientDetachError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ClientDetachError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * Reverse a client's attach from disk, driven by the descriptor's
 * `attachProbe` and the settings-file marker. No-op (`{ changed: false }`) when
 * the descriptor has no probe, the file is absent, or it carries no marker.
 *
 * @param {{
 *   descriptor: ClientDescriptor,
 *   homeDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   fs?: typeof fsp,
 * }} args
 * @returns {Promise<DetachFromDiskResult>}
 */
export async function detachClientFromDisk({ descriptor, homeDir = os.homedir(), env, fs = fsp }) {
  const probe = descriptor.attachProbe
  if (!probe) return { changed: false }

  const settingsPath = resolveClientSettingsPath(descriptor.name, probe.settings_file, env, homeDir)

  if (probe.format === 'json' && probe.marker_key) {
    return await detachJsonMarker({ settingsPath, markerKey: probe.marker_key, fs })
  }
  if (probe.format === 'toml') {
    return await detachTomlManagedBlock({ settingsPath, fs })
  }
  if (probe.format === 'json_path' && probe.marker_path) {
    return await detachJsonPathMarker({
      settingsPath,
      markerPath: probe.marker_path,
      recordPath: probe.marker_record,
      fs,
    })
  }
  // Unknown/incomplete probe: nothing this core routine knows how to reverse.
  return { changed: false, settingsPath }
}

/* ------------------------------- JSON format ------------------------------ */

/**
 * Reverse a `json` marker-key attach (e.g. Claude's `_hypaware`). Replays the
 * self-describing undo record: restore-or-remove each managed `env` key,
 * strip the recorded managed hook entries (leaving no orphaned `hyp …` hooks),
 * and delete the marker.
 *
 * @param {{ settingsPath: string, markerKey: string, fs: typeof fsp }} args
 * @returns {Promise<DetachFromDiskResult>}
 */
async function detachJsonMarker({ settingsPath, markerKey, fs }) {
  const read = await readJson(settingsPath, fs)
  if (!read.existed) return { changed: false, settingsPath }

  const value = read.value
  const marker = value[markerKey]
  if (!isPlainObject(marker)) return { changed: false, settingsPath }

  // Pre-upgrade markers have the legacy shape {attached_at,version,port,
  // state_file} with no self-describing `managed` undo record. There is no
  // record to replay, so reverse them by the original (now-retired) convention
  // instead of just deleting the marker — otherwise env.ANTHROPIC_BASE_URL and
  // the `hyp claude-hook session-context` entries it wrote would orphan, and the
  // detach is non-retryable once the marker is gone.
  // @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [constrained-by]: legacy markers predate the undo record; fall back to the convention attach used before it
  if (!isPlainObject(marker.managed)) {
    return await detachLegacyJsonMarker({
      settingsPath,
      markerKey,
      value,
      marker,
      mtimeMs: read.mtimeMs,
      fs,
    })
  }

  const managed = isPlainObject(marker.managed) ? marker.managed : {}
  const managedEnv = isPlainObject(managed.env) ? managed.env : {}
  const hookEntries = Array.isArray(managed.hooks) ? managed.hooks : []
  // Presence, not type: the restore half of the attach-side backup. Attach only
  // ever writes this field when there was a prior value to record, so the field
  // being there IS the "restore me" fact and its JSON type says nothing. A type
  // test threw away a backup the marker was holding and fell through to the
  // delete branch below - the one outcome the backup exists to prevent.
  const prevBaseUrl = Object.hasOwn(marker, 'prev_base_url') ? marker.prev_base_url : undefined

  delete value[markerKey]
  stripManagedHooks(value, hookEntries)

  /** @type {string | undefined} */
  let removed
  /** @type {string | undefined} */
  let restoredValue
  // One notice per externally-overridden key: a single reassigned string would
  // report only the last one, hiding the earlier keys we left in place.
  // @ref LLP 0045#never-clobber-a-user-edit-report-every-override-not-just-the-last [implements]: accumulate the per-key notices, join them into the one `warning` field
  /** @type {string[]} */
  const warnings = []

  if (isPlainObject(value.env)) {
    const envObj = /** @type {Record<string, unknown>} */ (value.env)
    for (const [key, ourVal] of Object.entries(managedEnv)) {
      const current = envObj[key]
      if (current === ourVal) {
        // The value we wrote is still live. `prev_base_url` is the restore
        // target for ANTHROPIC_BASE_URL only - it is the one managed key that
        // backs up a pre-existing value. Every other managed key (e.g.
        // ENABLE_TOOL_SEARCH) is one attach only ever added when it was absent,
        // so it is removed, never restored. Applying prev_base_url to every key
        // would wrongly stamp the base URL onto them.
        if (key === 'ANTHROPIC_BASE_URL' && prevBaseUrl !== undefined) {
          envObj[key] = prevBaseUrl
          restoredValue = typeof prevBaseUrl === 'string' ? prevBaseUrl : String(prevBaseUrl)
        } else {
          if (key === 'ANTHROPIC_BASE_URL') removed = typeof current === 'string' ? current : String(current)
          delete envObj[key]
        }
      } else if (Object.hasOwn(envObj, key)) {
        // Overridden externally after we attached - never clobber a user edit.
        //
        // Presence, not type, decides that a key was left in place: the same
        // rule the attach-side ownership guard follows. A user who hand-edited
        // our `ENABLE_TOOL_SEARCH` to a JSON boolean still has a key sitting on
        // disk after a detach that reports success, which is exactly the case
        // this notice exists to tell them about; a type test would swallow it.
        // A key they deleted outright is absent, so nothing was left in place
        // and nothing is reported - which is why this is a presence test and
        // not a bare `else`.
        //
        // `Object.hasOwn`, not `key in`: this loop's keys come off disk, from
        // whatever `managed.env` a plugin's attach recorded, so an inherited
        // `Object.prototype` name (`toString`, `constructor`) would satisfy
        // `in` and report a key that is not on disk at all - the exact false
        // report the presence test exists to prevent. The attach-side guard
        // can use `in` because its keys are in-tree literals.
        warnings.push(`${key} was overridden externally; leaving in place`)
      }
    }
    if (Object.keys(envObj).length === 0) delete value.env
  }

  const restoredPaths = replayPrevMalformed(value, marker.prev_malformed, warnings)

  await writeJsonAtomic(settingsPath, value, read.mtimeMs, fs)

  const warning = joinWarnings(warnings)

  /** @type {DetachFromDiskResult} */
  const result = { changed: true, settingsPath }
  if (removed !== undefined) result.removed = removed
  if (restoredValue !== undefined) result.restoredValue = restoredValue
  if (restoredPaths.length > 0) result.restoredPaths = restoredPaths
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Put back the blocks attach had to rebuild because what was on disk was
 * present with the wrong JSON type. `prev_malformed` is path-keyed
 * (`env`, `hooks`, `hooks.<event>`), so the replay is the same format-generic
 * shape as the rest of the record: core never learns that `hooks.SessionStart`
 * means anything to Claude.
 *
 * Same never-clobber rule the managed env keys follow, expressed as a presence
 * test: the backup only goes back into a slot that is now *empty*, which is
 * exactly the case where everything attach put there has just been stripped.
 * Anything still sitting at the path arrived after we attached, so it is left
 * alone and reported instead.
 *
 * Every failure notice says the backup is *discarded*, not merely skipped. The
 * marker is deleted by the caller in the same write and it held the only copy,
 * so a detach that cannot restore is the moment the value stops existing.
 * "Leaving it in place" on its own reads as though the record survives to be
 * retried, and it does not; the user who reads this line is the last person who
 * can act on it.
 *
 * Shared by both `json` branches. The record-driven undo is not the only way to
 * reach a marker carrying this field: a marker whose `managed` record has been
 * damaged routes to {@link detachLegacyJsonMarker}, which used to drop the
 * whole backup without a word (#500 finding 1). One replay means one set of
 * words for both.
 *
 * Returns the paths whose backup actually went back, so the caller can *report*
 * a restore that succeeded. Paths only, never values: a malformed `env` is
 * exactly where an API key ends up, and this list is printed to the terminal
 * and echoed into `--json` (LLP 0163).
 *
 * @ref LLP 0163#detach-restores-the-backup [implements]: replay prev_malformed shallowest-first, restoring only into a slot the strip emptied, and report both halves by path
 * @param {Record<string, unknown>} value
 * @param {unknown} recorded the marker's `prev_malformed` field, whatever type it is on disk
 * @param {string[]} warnings accumulator for the per-path failure notices
 * @returns {string[]}
 */
function replayPrevMalformed(value, recorded, warnings) {
  /** @type {Record<string, unknown>} */
  const prevMalformed = isPlainObject(recorded) ? recorded : {}
  /** @type {string[]} */
  const restoredPaths = []
  // Shallowest first, so a `hooks` backup is considered before any
  // `hooks.<event>` backup nested inside it. Not because the parent has to exist
  // first - `restoreAtDottedPath` recreates a missing parent either way - but
  // because when both are recorded they cannot both go back, and the order is
  // what picks the winner.
  //
  // Which one it *should* pick is a question depth cannot answer: the shallower
  // entry is the older one in one recording sequence and the newer one in the
  // other, so neither direction implements "the earliest backup holds the user's
  // content". The record carries no age, so the sort is an arbitrary but stable
  // tiebreak and the loser is reported. See LLP 0163.
  for (const dotted of Object.keys(prevMalformed).sort((a, b) => pathDepth(a) - pathDepth(b))) {
    // Reported before the in-use test, so a path this undo refuses on principle
    // is never explained as somebody else's key sitting in the way.
    if (hasUnwritableSegment(dotted)) {
      warnings.push(
        `${dotted} could not be restored; ` +
        'its path is not one this undo may write, so the backed-up value is discarded with the marker'
      )
      continue
    }
    if (getAtDottedPath(value, dotted) !== undefined) {
      warnings.push(
        `${dotted} is in use again; leaving it in place, and the backed-up value is discarded with the marker`
      )
      continue
    }
    // The remaining failure is a parent that is present as a non-object, which
    // is the one this branch actually hits in practice: a `hooks` backup that
    // went back first is a string, and the `hooks.<event>` backup nested inside
    // it now has nowhere to go. Naming that cause matters - the earlier wording
    // reported it as a path the undo may not write, which is both false and
    // unactionable for the one person who can still act on it.
    if (restoreAtDottedPath(value, dotted, prevMalformed[dotted])) {
      restoredPaths.push(dotted)
    } else {
      warnings.push(
        `${dotted} could not be restored; ` +
        'a parent on its path is no longer a JSON object, ' +
        'so the backed-up value is discarded with the marker'
      )
    }
  }
  return restoredPaths
}

/**
 * Fold the per-key never-clobber notices into the single
 * `DetachFromDiskResult.warning` string, `undefined` when there are none.
 *
 * The field stays one human-readable string - it is displayed, never parsed
 * (`action_attach.js` logs it as a span `detail`; `hyp detach` prints it and
 * echoes it into the `--json` payload) - but it now carries every key the undo
 * left in place, not just whichever one the loop happened to visit last.
 *
 * The separator is ` | `, NOT `; `: every notice already contains a `; ` of its
 * own ("... overridden externally; leaving in place"), so joining on `; ` would
 * make the notice boundaries indistinguishable from the punctuation inside a
 * notice. No in-tree attach records a managed env key or a dotted set path
 * containing `|`, so ` | ` reads unambiguously for the notices joined here.
 *
 * That is a READABILITY choice, not a parseable framing. The field is shared
 * with `detachTomlManagedBlock`, whose single notice interpolates the user's
 * live `model_provider` value and can therefore contain ` | ` itself. Callers
 * display `warning`; they must not split it. See `DetachFromDiskResult`.
 *
 * @param {string[]} warnings
 * @returns {string | undefined}
 */
function joinWarnings(warnings) {
  return warnings.length === 0 ? undefined : warnings.join(' | ')
}

/**
 * Strip the managed hook entries the marker recorded — matching each by its
 * `event` / `matcher` / exact `command`, so only the handlers this attach
 * installed are removed and no orphaned `hyp …` hooks survive. Empty groups
 * and empty event arrays are pruned; an emptied `hooks` root is deleted.
 *
 * @param {Record<string, unknown>} value
 * @param {unknown[]} hookEntries
 */
function stripManagedHooks(value, hookEntries) {
  const hooksRoot = value.hooks
  if (!isPlainObject(hooksRoot)) return

  for (const entry of hookEntries) {
    if (!isPlainObject(entry)) continue
    const event = typeof entry.event === 'string' ? entry.event : undefined
    const command = typeof entry.command === 'string' ? entry.command : undefined
    if (event === undefined || command === undefined) continue
    const matcher = typeof entry.matcher === 'string' ? entry.matcher : undefined

    const groups = hooksRoot[event]
    if (!Array.isArray(groups)) continue

    /** @type {unknown[]} */
    const nextGroups = []
    for (const group of groups) {
      if (!isPlainObject(group) || !groupMatcherEquals(group, matcher) || !Array.isArray(group.hooks)) {
        nextGroups.push(group)
        continue
      }
      const handlers = group.hooks
      const keptHandlers = handlers.filter((h) => !isManagedHandler(h, command))
      if (keptHandlers.length === handlers.length) {
        nextGroups.push(group) // nothing matched — leave the group untouched
      } else if (keptHandlers.length > 0) {
        nextGroups.push({ ...group, hooks: keptHandlers })
      }
      // else: the group held only the managed handler — drop it entirely.
    }

    if (nextGroups.length > 0) {
      hooksRoot[event] = nextGroups
    } else {
      delete hooksRoot[event]
    }
  }

  if (Object.keys(hooksRoot).length === 0) delete value.hooks
}

/**
 * @param {Record<string, unknown>} group
 * @param {string | undefined} matcher
 */
function groupMatcherEquals(group, matcher) {
  const groupMatcher = typeof group.matcher === 'string' ? group.matcher : undefined
  return groupMatcher === matcher
}

/**
 * @param {unknown} handler
 * @param {string} command
 */
function isManagedHandler(handler, command) {
  return isPlainObject(handler) && handler.type === 'command' && handler.command === command
}

/* ----------------------------- legacy JSON marker ---------------------------- */

// Both `hyp claude-hook` sub-commands attach has ever installed. `classify-cwd`
// (LLP 0106) postdates the `managed` undo record, so a *genuine* pre-record
// marker never had one to orphan - but this branch is also where a marker whose
// record has been damaged lands, and there the entries are on disk and the
// record naming them is unreadable. Matching the command is proof of ownership
// (nothing but hypaware writes `hyp claude-hook …`), so widening the pattern
// cannot clobber a user's own hook. Kept in step with the adapter's
// `MANAGED_HOOK_PATTERN`.
// @ref LLP 0163#the-legacy-branch-replays-every-backup-the-marker-carries [implements]: match on the command, which is proof of ownership, so a damaged-record detach leaves no classify-cwd hook orphaned
const LEGACY_CLAUDE_HOOK_PATTERN = /\bclaude-hook\s+(?:session-context|classify-cwd)\b/

// Marker fields no pre-record marker ever carried. Any of them present means
// this is a *current*-shape marker whose `managed` record has been damaged (a
// hand edit, or anything else with write access to the settings file), not the
// pre-upgrade shape this branch was written for. The reversal below is then
// knowingly partial - the record that named the managed keys is unreadable - so
// it says so instead of reporting a clean detach.
const POST_LEGACY_MARKER_FIELDS = ['managed', 'prev_base_url', 'prev_malformed']

/**
 * Reverse a pre-upgrade legacy `json` marker — the old Claude marker shape
 * `{attached_at,version,port,state_file}` that predates the self-describing
 * `managed` undo record. We can't replay a record the marker never wrote, so we
 * fall back to the convention `attach()` used before the record existed:
 * remove `env.ANTHROPIC_BASE_URL` only when it still equals the recorded
 * `http://127.0.0.1:${port}` gateway URL (never clobbering a later user edit),
 * and strip the session-context hooks by the `claude-hook session-context`
 * command pattern. Legacy JSON markers were only ever written by Claude, so the
 * key/pattern are safe to assume here. Moved from the retired claude-adapter
 * `detach()` so the one core undo owns this reversal too.
 *
 * It is also where a **current**-shape marker lands once its `managed` record
 * has been damaged - only reachable by hand-editing (or otherwise corrupting)
 * the record out of a marker, never through attach/re-attach/detach. That case
 * is not the one this branch was written for, and the difference is visible:
 * such a marker still carries its `prev_base_url` / `prev_malformed` backups.
 * Those are replayed here exactly as the record-driven branch replays them -
 * the marker is deleted in the same write and holds the only copy, so dropping
 * them is destruction, not a deferral (#500 finding 1). What cannot be replayed
 * (the managed keys the unreadable record named) is reported instead of quietly
 * left behind.
 *
 * @param {{
 *   settingsPath: string,
 *   markerKey: string,
 *   value: Record<string, unknown>,
 *   marker: Record<string, unknown>,
 *   mtimeMs: number | undefined,
 *   fs: typeof fsp,
 * }} args
 * @returns {Promise<DetachFromDiskResult>}
 */
async function detachLegacyJsonMarker({ settingsPath, markerKey, value, marker, mtimeMs, fs }) {
  const markerPort = typeof marker.port === 'number' ? marker.port : undefined

  // Read every backup the marker carries BEFORE it is deleted. A genuine
  // pre-record marker has none of these and nothing changes for it. A marker
  // that got here with them is a damaged current-shape one, and dropping a
  // backup it is holding is the single worst thing this undo can do: the marker
  // is the only copy, so "no record to replay" was silently destroying the
  // user's value while reporting a successful detach (#500 finding 1).
  // Presence, not type, for the same reason the record-driven branch uses it:
  // attach only writes these when there was something to record.
  // @ref LLP 0044#conflict--back-up--override-restore-on-leave [constrained-by]: the marker IS the backup, on every branch that deletes it
  const prevBaseUrl = Object.hasOwn(marker, 'prev_base_url') ? marker.prev_base_url : undefined
  const recordDamaged = POST_LEGACY_MARKER_FIELDS.some((field) => Object.hasOwn(marker, field))

  delete value[markerKey]
  stripLegacyClaudeHooks(value)

  /** @type {string | undefined} */
  let removed
  /** @type {string | undefined} */
  let restoredValue
  /** @type {string[]} */
  const warnings = []
  if (recordDamaged) {
    // The one thing this branch cannot do is name the keys a post-record attach
    // added beside the base URL (`ENABLE_TOOL_SEARCH`,
    // `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, …): the record that listed
    // them is exactly what is unreadable, and nothing on disk distinguishes a
    // value we wrote from one the user did. Deleting on a guess would clobber a
    // user edit, which this undo never does - so they stay, and the user is told
    // the reversal was partial rather than left to discover the leftovers.
    warnings.push(
      `${markerKey} carried no readable undo record; ` +
      'reversed by the pre-record convention, so any managed value a newer attach ' +
      'added beside the gateway base URL is left in place'
    )
  }
  if (isPlainObject(value.env)) {
    const envObj = /** @type {Record<string, unknown>} */ (value.env)
    const current = envObj.ANTHROPIC_BASE_URL
    if (markerPort !== undefined && current === `http://127.0.0.1:${markerPort}`) {
      // Still our gateway URL. A recorded prior goes back; with none recorded
      // the key is removed, which is all a genuine legacy marker ever supports.
      if (prevBaseUrl !== undefined) {
        envObj.ANTHROPIC_BASE_URL = prevBaseUrl
        restoredValue = typeof prevBaseUrl === 'string' ? prevBaseUrl : String(prevBaseUrl)
      } else {
        removed = typeof current === 'string' ? current : String(current)
        delete envObj.ANTHROPIC_BASE_URL
      }
    } else if (Object.hasOwn(envObj, 'ANTHROPIC_BASE_URL')) {
      // Presence, not type - the same rule the record-driven undo above
      // follows. A legacy marker meets settings this tree never wrote, so the
      // value at the key is whatever a hand edit left there: `null` or `false`
      // is a user deliberately switching the base URL off, and it survives the
      // detach (correctly) but used to survive it silently, because a `typeof
      // current === 'string'` gate swallowed the notice for exactly the values
      // most likely to be deliberate. The key absent is still silent - nothing
      // was left in place to report.
      warnings.push('ANTHROPIC_BASE_URL was overridden externally; leaving in place')
    }
    if (Object.keys(envObj).length === 0) delete value.env
  }

  // Same replay, same words, as the record-driven branch. It runs after the
  // strip above for the same reason it does there: the strip is what empties
  // the slot a backup can go back into.
  const restoredPaths = replayPrevMalformed(value, marker.prev_malformed, warnings)

  await writeJsonAtomic(settingsPath, value, mtimeMs, fs)

  const warning = joinWarnings(warnings)

  /** @type {DetachFromDiskResult} */
  const result = { changed: true, settingsPath }
  if (removed !== undefined) result.removed = removed
  if (restoredValue !== undefined) result.restoredValue = restoredValue
  if (restoredPaths.length > 0) result.restoredPaths = restoredPaths
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Strip the legacy Claude session-context hooks — matched by the
 * `claude-hook session-context` command pattern rather than the marker's undo
 * record (a legacy marker recorded no hook entries). Empty groups, emptied
 * event arrays, and an emptied `hooks` root are pruned, so no orphaned `hyp …`
 * hooks survive. Preserves a user's own non-managed handlers for the same event.
 *
 * @param {Record<string, unknown>} value
 */
function stripLegacyClaudeHooks(value) {
  const hooksRoot = value.hooks
  if (!isPlainObject(hooksRoot)) return

  for (const event of Object.keys(hooksRoot)) {
    const groups = hooksRoot[event]
    if (!Array.isArray(groups)) continue

    /** @type {unknown[]} */
    const nextGroups = []
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        nextGroups.push(group)
        continue
      }
      const keptHandlers = group.hooks.filter((h) => !isLegacyClaudeHandler(h))
      if (keptHandlers.length === group.hooks.length) {
        nextGroups.push(group) // nothing matched — leave untouched
      } else if (keptHandlers.length > 0) {
        nextGroups.push({ ...group, hooks: keptHandlers })
      }
      // else: the group held only legacy managed handlers — drop it entirely.
    }

    if (nextGroups.length > 0) {
      hooksRoot[event] = nextGroups
    } else {
      delete hooksRoot[event]
    }
  }

  if (Object.keys(hooksRoot).length === 0) delete value.hooks
}

/** @param {unknown} handler */
function isLegacyClaudeHandler(handler) {
  return isPlainObject(handler) &&
    handler.type === 'command' &&
    typeof handler.command === 'string' &&
    LEGACY_CLAUDE_HOOK_PATTERN.test(handler.command)
}

/* ----------------------------- json_path format ---------------------------- */

/**
 * Reverse a `json_path` nested-marker attach (e.g. OpenClaw's
 * `models.providers.hypaware` provider entry). The marker is a managed object
 * at a dotted path rather than a top-level key (which a client's strict root
 * schema would reject), and the self-describing undo record is a JSON-encoded
 * string nested inside it. Replays the record's `managed` operations: restore
 * each `set` path to its recorded prior (never clobbering an external
 * override), remove each `appended` value from its array, delete the `added`
 * subtrees, and prune the recorded `created_parents` only when they emptied.
 *
 * Dotted-path segments are plain literals split on `.` with no escaping: a
 * segment may contain dashes (e.g. `x-hypaware-marker`) but never a dot, so a
 * key that itself contains a dot cannot be addressed. Attach only records
 * paths it wrote under this constraint.
 *
 * @ref LLP 0109#probe-and-detach-core-owned [implements]: core undo for the nested-marker format; the record replay is format-generic, core knows json_path semantics, never "OpenClaw"
 * @param {{ settingsPath: string, markerPath: string, recordPath: string | undefined, fs: typeof fsp }} args
 * @returns {Promise<DetachFromDiskResult>}
 */
async function detachJsonPathMarker({ settingsPath, markerPath, recordPath, fs }) {
  const read = await readJson(settingsPath, fs)
  if (!read.existed) return { changed: false, settingsPath }

  const value = read.value
  const marker = getAtDottedPath(value, markerPath)
  if (!isPlainObject(marker)) return { changed: false, settingsPath }

  // A marker without a readable undo record cannot be honestly reversed:
  // unlike the legacy `json` marker there is no pre-record convention to fall
  // back to, and deleting the marker alone would orphan the repointed
  // settings (and make the detach non-retryable once the marker is gone).
  // Fail non-destructively instead, leaving the file untouched.
  // @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [constrained-by]: the marker IS the backup; with no replayable record and no legacy convention, refusing beats a half-reversal
  const record = recordPath !== undefined
    ? parseRecordString(getAtDottedPath(marker, recordPath))
    : undefined
  const managed = record !== undefined && isPlainObject(record.managed) ? record.managed : undefined
  if (managed === undefined) {
    throw new ClientDetachError(
      `hypaware marker at ${markerPath} in ${settingsPath} has no readable undo record; leaving the file untouched`,
      { code: 'MALFORMED_MARKER' }
    )
  }

  const setEntries = Array.isArray(managed.set) ? managed.set : []
  const appendedEntries = Array.isArray(managed.appended) ? managed.appended : []
  const addedPaths = stringEntries(managed.added)
  const createdParents = stringEntries(managed.created_parents)

  /** @type {string | undefined} */
  let removed
  /** @type {string | undefined} */
  let restoredValue
  // Same per-key accumulation the json branch does: a record with two `set`
  // entries that were both overridden must name both, not just the last.
  // @ref LLP 0045#never-clobber-a-user-edit-report-every-override-not-just-the-last [implements]: accumulate the per-entry notices, join them into the one `warning` field
  /** @type {string[]} */
  const warnings = []

  // Managed values are JSON primitives (model-id strings), so strict
  // equality is the "still ours" check, exactly like the json branch's
  // env-value comparison.
  for (const entry of setEntries) {
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || !('value' in entry)) continue
    const current = getAtDottedPath(value, entry.path)
    if (current === entry.value) {
      if (entry.prev !== undefined) {
        setAtDottedPath(value, entry.path, entry.prev)
        if (typeof entry.prev === 'string') restoredValue = entry.prev
      } else {
        // No prior to restore: attach set a key that did not exist.
        if (removed === undefined && typeof current === 'string') removed = current
        deleteAtDottedPath(value, entry.path)
      }
    } else if (current !== undefined) {
      // Overridden externally after we attached - never clobber a user edit.
      warnings.push(`${entry.path} was overridden externally; leaving in place`)
    }
    // An externally-deleted leaf (current undefined) needs no reversal.
  }

  for (const entry of appendedEntries) {
    if (!isPlainObject(entry) || typeof entry.path !== 'string') continue
    const arr = getAtDottedPath(value, entry.path)
    if (!Array.isArray(arr)) continue
    const index = arr.findIndex((el) => el === entry.value)
    if (index !== -1) arr.splice(index, 1)
    // Value already gone (user removed it): nothing left to undo.
  }

  for (const added of addedPaths) deleteAtDottedPath(value, added)
  // The marker must not survive detach even when the record forgot to list
  // its own subtree in `added`; a surviving marker would probe as attached
  // forever and make the detach unretractable.
  deleteAtDottedPath(value, markerPath)

  // Prune the parents attach created, deepest first, and only when emptied.
  // A parent that gained user keys since attach stays - the same rule the
  // json branch applies when it prunes an emptied `env`.
  for (const parent of [...createdParents].sort((a, b) => pathDepth(b) - pathDepth(a))) {
    const obj = getAtDottedPath(value, parent)
    if (isPlainObject(obj) && Object.keys(obj).length === 0) deleteAtDottedPath(value, parent)
  }

  await writeJsonAtomic(settingsPath, value, read.mtimeMs, fs)

  const warning = joinWarnings(warnings)

  /** @type {DetachFromDiskResult} */
  const result = { changed: true, settingsPath }
  if (removed !== undefined) result.removed = removed
  if (restoredValue !== undefined) result.restoredValue = restoredValue
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Parse a JSON-encoded record string into a plain object; `undefined` for
 * non-strings, parse failures, and non-object payloads.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function parseRecordString(value) {
  if (typeof value !== 'string') return undefined
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  return isPlainObject(parsed) ? parsed : undefined
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringEntries(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
}

/** @param {string} dottedPath */
function pathDepth(dottedPath) {
  return dottedPath.split('.').length
}

/**
 * Set the leaf of a dotted path (plain literal segments, no escaping) when
 * its parent chain exists as plain objects; silently a no-op otherwise (a
 * broken chain means there is nothing meaningful to restore into), and for any
 * path {@link UNWRITABLE_PATH_SEGMENTS} refuses.
 *
 * The refusal is defence in depth rather than a live hole closed: the caller
 * only writes here when the live value still equals the one attach recorded,
 * and a prototype path reads back as `undefined` while a recorded `value` comes
 * from JSON and never is, so the equality gate already blocks it. The guard is
 * on the helper so a future caller without that gate cannot reopen it.
 *
 * @param {Record<string, unknown>} root
 * @param {string} dottedPath
 * @param {unknown} newValue
 */
function setAtDottedPath(root, dottedPath, newValue) {
  if (hasUnwritableSegment(dottedPath)) return
  const segments = dottedPath.split('.')
  const leaf = segments.pop()
  if (leaf === undefined) return
  const parent = segments.length === 0 ? root : getAtDottedPath(root, segments.join('.'))
  if (isPlainObject(parent)) parent[leaf] = newValue
}

/**
 * Write a backed-up value at a dotted path, creating any **missing** object
 * parent on the way. Unlike {@link setAtDottedPath} this cannot assume the
 * chain survives: the undo has just deleted the containers it emptied, so
 * restoring a `hooks.<event>` backup routinely has to recreate the `hooks`
 * root the strip removed a few lines earlier.
 *
 * Returns false when a parent is present as a **non**-object, which is the one
 * case with nowhere honest to put the value: something else now owns that path
 * and overwriting it would repeat the destruction the backup exists to undo.
 * The caller reports it rather than forcing the write.
 *
 * It also returns false for a path {@link UNWRITABLE_PATH_SEGMENTS} refuses.
 * `prev_malformed` keys come from a marker sitting in a settings file a
 * hand-edit (or anything else with write access to the user's home) can reach,
 * and this helper *creates* the parents it walks, so `__proto__.x` would leave
 * the settings object entirely and assign onto `Object.prototype` for the rest
 * of the process. Attach never records such a path, so refusing costs nothing
 * real. The caller tests the same predicate first so it can report *that* as
 * the reason, rather than folding it into the non-object-parent case below.
 *
 * @ref LLP 0163#detach-restores-the-backup [implements]: recreate emptied parents, refuse to overwrite a parent someone else owns
 * @param {Record<string, unknown>} root
 * @param {string} dottedPath
 * @param {unknown} newValue
 * @returns {boolean}
 */
function restoreAtDottedPath(root, dottedPath, newValue) {
  if (hasUnwritableSegment(dottedPath)) return false
  const segments = dottedPath.split('.')
  const leaf = segments.pop()
  if (leaf === undefined) return false
  /** @type {Record<string, unknown>} */
  let parent = root
  for (const segment of segments) {
    const next = parent[segment]
    if (next === undefined) {
      /** @type {Record<string, unknown>} */
      const fresh = {}
      parent[segment] = fresh
      parent = fresh
      continue
    }
    if (!isPlainObject(next)) return false
    parent = next
  }
  parent[leaf] = newValue
  return true
}

/**
 * Delete the leaf of a dotted path (plain literal segments, no escaping)
 * when its parent chain exists as plain objects; no-op otherwise, and for any
 * path {@link UNWRITABLE_PATH_SEGMENTS} refuses.
 *
 * Unlike its two siblings this one had a *reachable* hole: the nested-marker
 * record's `managed.added` and `managed.created_parents` lists are replayed
 * with no equality gate at all, so an `added` entry of `__proto__.toString`
 * deleted `Object.prototype.toString` for the rest of the process. A settings
 * file the user (or anything with write access to their home) can edit is not
 * a place to take dotted paths on trust.
 *
 * @param {Record<string, unknown>} root
 * @param {string} dottedPath
 */
function deleteAtDottedPath(root, dottedPath) {
  if (hasUnwritableSegment(dottedPath)) return
  const segments = dottedPath.split('.')
  const leaf = segments.pop()
  if (leaf === undefined) return
  const parent = segments.length === 0 ? root : getAtDottedPath(root, segments.join('.'))
  if (isPlainObject(parent)) delete parent[leaf]
}

/* ------------------------------- TOML format ------------------------------ */

/**
 * Reverse a `toml` managed-block attach (e.g. Codex's `# BEGIN/END hypaware …`
 * blocks). The blocks are self-delimiting and record the prior `model_provider`
 * as `# previous_model_provider`, so core strips the blocks and restores the
 * recorded root pointer — without importing the codex plugin.
 *
 * @param {{ settingsPath: string, fs: typeof fsp }} args
 * @returns {Promise<DetachFromDiskResult>}
 */
async function detachTomlManagedBlock({ settingsPath, fs }) {
  const read = await readText(settingsPath, fs)
  if (!read.existed) return { changed: false, settingsPath }

  const lines = splitLines(read.content)
  const blockValues = readManagedBlockValues(lines)
  if (!blockValues.found) return { changed: false, settingsPath }

  let next = removeManagedBlocks(lines)

  /** @type {string | undefined} */
  let restoredValue
  /** @type {string | undefined} */
  let warning
  if (blockValues.previous !== undefined) {
    const current = readRootModelProvider(next)
    if (current === undefined) {
      next = insertRootLines(next, [`${TOML_ROOT_RESTORE_KEY} = ${tomlString(blockValues.previous)}`])
      restoredValue = blockValues.previous
    } else if (current !== blockValues.previous) {
      warning = `${TOML_ROOT_RESTORE_KEY} was changed externally; leaving ${current} in place`
    }
  }

  await writeTextAtomic(settingsPath, formatLines(next), read.mtimeMs, fs)

  /** @type {DetachFromDiskResult} */
  const result = { changed: true, settingsPath }
  if (blockValues.removed !== undefined) result.removed = blockValues.removed
  if (restoredValue !== undefined) result.restoredValue = restoredValue
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Single pass over the managed blocks: detect their presence and read the prior
 * `model_provider` (the restore target, recorded as a `# previous_model_provider`
 * comment) and the managed `base_url` (reported as `removed`).
 *
 * @param {string[]} lines
 * @returns {{ found: boolean, previous?: string, removed?: string }}
 */
function readManagedBlockValues(lines) {
  const prevRe = new RegExp(String.raw`^#\s*${TOML_PREVIOUS_KEY}\s*=\s*(.+)$`)
  const baseRe = new RegExp(String.raw`^\s*${TOML_MANAGED_BASE_URL_KEY}\s*=\s*(.+)$`)
  let inside = false
  let found = false
  /** @type {string | undefined} */
  let previous
  /** @type {string | undefined} */
  let removed
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inside) {
      if (trimmed.startsWith(TOML_MANAGED_BEGIN)) {
        inside = true
        found = true
      }
      continue
    }
    if (trimmed.startsWith(TOML_MANAGED_END)) {
      inside = false
      continue
    }
    if (previous === undefined) {
      const m = line.match(prevRe)
      if (m) previous = parseTomlString(m[1])
    }
    if (removed === undefined) {
      const m = line.match(baseRe)
      if (m) removed = parseTomlString(m[1])
    }
  }
  /** @type {{ found: boolean, previous?: string, removed?: string }} */
  const result = { found }
  if (previous !== undefined) result.previous = previous
  if (removed !== undefined) result.removed = removed
  return result
}

/**
 * Strip every `# BEGIN hypaware …` … `# END hypaware …` block (inclusive). The
 * convention is self-delimiting, so this removes exactly what attach inserted.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function removeManagedBlocks(lines) {
  /** @type {string[]} */
  const next = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith(TOML_MANAGED_BEGIN)) {
      next.push(lines[i])
      continue
    }
    let foundEnd = false
    for (i++; i < lines.length; i++) {
      if (lines[i].trim().startsWith(TOML_MANAGED_END)) {
        foundEnd = true
        break
      }
    }
    if (!foundEnd) {
      throw new ClientDetachError('unterminated hypaware-managed config block', {
        code: 'MALFORMED_MARKER',
      })
    }
  }
  return next
}

/**
 * Read the root `model_provider` (before the first table header), honoring
 * multiline strings so a `"""…"""` value can't be misread as an assignment.
 *
 * @param {string[]} lines
 * @returns {string | undefined}
 */
function readRootModelProvider(lines) {
  const firstTable = findFirstTableIndex(lines)
  /** @type {string | undefined} */
  let multilineDelimiter
  for (let i = 0; i < firstTable; i++) {
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(lines[i], multilineDelimiter)
      continue
    }
    if (TOML_ROOT_MODEL_PROVIDER_RE.test(lines[i])) return parseAssignmentString(lines[i])
    multilineDelimiter = openMultilineString(lines[i])
  }
  return undefined
}

/**
 * Insert lines at the root (before the first table header / trailing blanks).
 *
 * @param {string[]} lines
 * @param {string[]} insert
 * @returns {string[]}
 */
function insertRootLines(lines, insert) {
  const next = lines.slice()
  let index = findFirstTableIndex(next)
  if (index === next.length) {
    while (index > 0 && next[index - 1] === '') index--
  }
  next.splice(index, 0, ...insert)
  return next
}

/** @param {string[]} lines */
function findFirstTableIndex(lines) {
  /** @type {string | undefined} */
  let multilineDelimiter
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(line, multilineDelimiter)
      continue
    }
    if (isTableHeader(line)) return i
    multilineDelimiter = openMultilineString(line)
  }
  return lines.length
}

/** @param {string} line */
function isTableHeader(line) {
  return TOML_TABLE_HEADER_RE.test(line) || TOML_TABLE_ARRAY_HEADER_RE.test(line)
}

/** @param {string} line */
function openMultilineString(line) {
  const value = assignmentValue(line) ?? line.trimStart()
  if (value.startsWith(TOML_BASIC_MULTILINE_DELIMITER)) {
    return hasClosingMultilineString(value.slice(3), TOML_BASIC_MULTILINE_DELIMITER)
      ? undefined
      : TOML_BASIC_MULTILINE_DELIMITER
  }
  if (value.startsWith(TOML_LITERAL_MULTILINE_DELIMITER)) {
    return hasClosingMultilineString(value.slice(3), TOML_LITERAL_MULTILINE_DELIMITER)
      ? undefined
      : TOML_LITERAL_MULTILINE_DELIMITER
  }
  return undefined
}

/**
 * @param {string} line
 * @param {string} delimiter
 */
function closeMultilineString(line, delimiter) {
  return hasClosingMultilineString(line, delimiter) ? undefined : delimiter
}

/** @param {string} line */
function assignmentValue(line) {
  if (/^\s*#/.test(line)) return undefined
  const index = line.indexOf('=')
  return index === -1 ? undefined : line.slice(index + 1).trimStart()
}

/**
 * @param {string} value
 * @param {string} delimiter
 */
function hasClosingMultilineString(value, delimiter) {
  if (delimiter === TOML_LITERAL_MULTILINE_DELIMITER) return value.includes(delimiter)
  for (let index = value.indexOf(delimiter); index !== -1; index = value.indexOf(delimiter, index + 1)) {
    if (!isEscaped(value, index)) return true
  }
  return false
}

/**
 * @param {string} value
 * @param {number} index
 */
function isEscaped(value, index) {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 1
}

/** @param {string} line */
function parseAssignmentString(line) {
  const index = line.indexOf('=')
  if (index === -1) return undefined
  return parseTomlString(line.slice(index + 1))
}

/** @param {string} value */
function parseTomlString(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^"(?:\\.|[^"\\])*"/)
    if (!match) return undefined
    try { return JSON.parse(match[0]) } catch { return undefined }
  }
  if (trimmed.startsWith('\'')) {
    const match = trimmed.match(/^'([^']*)'/)
    return match ? match[1] : undefined
  }
  return undefined
}

/** @param {string} value */
function tomlString(value) {
  return JSON.stringify(value)
}

/**
 * @param {string} content
 * @returns {string[]}
 */
function splitLines(content) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
function formatLines(lines) {
  let start = 0
  let end = lines.length
  while (start < end && lines[start] === '') start++
  while (end > start && lines[end - 1] === '') end--
  const out = lines.slice(start, end)
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

/* --------------------------------- I/O ------------------------------------ */

/**
 * @param {string} settingsPath
 * @param {typeof fsp} fs
 * @returns {Promise<{ value: Record<string, unknown>, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readJson(settingsPath, fs) {
  const read = await readText(settingsPath, fs)
  if (!read.existed) return { value: {}, existed: false, mtimeMs: undefined }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(read.content)
  } catch (err) {
    throw new ClientDetachError(`malformed JSON in ${settingsPath}: ${errMsg(err)}`, {
      code: 'MALFORMED_JSON',
      cause: err,
    })
  }
  if (!isPlainObject(parsed)) {
    throw new ClientDetachError(`${settingsPath} must contain a JSON object at the root`, {
      code: 'NOT_AN_OBJECT',
    })
  }
  return { value: parsed, existed: true, mtimeMs: read.mtimeMs }
}

/**
 * @param {string} settingsPath
 * @param {typeof fsp} fs
 * @returns {Promise<{ content: string, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readText(settingsPath, fs) {
  // Stat BEFORE reading the content so the captured mtime never post-dates the
  // bytes we return. If we stat'd after the read, a concurrent edit landing in
  // the read→stat window would leave us holding stale content paired with the
  // *new* mtime — and the write-time guard would then pass and silently clobber
  // that edit. Stat-first instead makes the guard err toward CONCURRENT_EDIT.
  let stat
  try {
    stat = await fs.stat(settingsPath)
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { content: '', existed: false, mtimeMs: undefined }
    throw new ClientDetachError(`failed to stat ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { content: '', existed: false, mtimeMs: undefined }
    throw new ClientDetachError(`failed to read ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }
  return { content: raw, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * @param {string} settingsPath
 * @param {unknown} value
 * @param {number | undefined} expectedMtimeMs
 * @param {typeof fsp} fs
 */
async function writeJsonAtomic(settingsPath, value, expectedMtimeMs, fs) {
  await writeTextAtomic(settingsPath, JSON.stringify(value, null, 2) + '\n', expectedMtimeMs, fs)
}

/**
 * Atomic temp-file + rename write, gated on the file's mtime so a concurrent
 * edit between read and write is detected (CONCURRENT_EDIT) rather than
 * silently clobbered — the same guarantee the adapters' writers gave.
 *
 * @param {string} filePath
 * @param {string} body
 * @param {number | undefined} expectedMtimeMs
 * @param {typeof fsp} fs
 */
async function writeTextAtomic(filePath, body, expectedMtimeMs, fs) {
  try {
    await atomicWriteFile(filePath, body, { mode: 0o600, fsync: true, expectedMtimeMs, fs })
  } catch (err) {
    if (err instanceof ConcurrentEditError) {
      throw new ClientDetachError(err.message, { code: 'CONCURRENT_EDIT', cause: err.cause ?? err })
    }
    throw err
  }
}

/* ------------------------------- Utilities -------------------------------- */

/** @param {unknown} err */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}
