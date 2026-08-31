// @ts-check

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger } from '../observability/index.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { countGatewayFallbackRows } from './gateway_fallback.js'
import { appendRowsToTable, tableExists as icebergTableExists } from './iceberg/store.js'
import { cacheTablePath, datasetsRoot, isConfirmedSymlink } from './paths.js'

/**
 * @import { ColumnSpec, QueryScope } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration, CachePartitionMeta, PartitionCursor } from '../../../src/core/cache/types.js'
 * @import { Dirent } from 'node:fs'
 */

const CURSOR_FILE = 'cursor.json'
const SPOOL_DIR = '_hypaware_spool'
const RETIRED_DIR = '.retired'

/**
 * The one byte no directory entry on any supported filesystem can carry,
 * and the one that would make a path stat throw on its argument rather
 * than on the filesystem. Built rather than escaped, so this source file
 * carries no control character of its own.
 */
const NUL_BYTE = String.fromCharCode(0)

/** @type {Map<string, Promise<unknown>>} */
const partitionMutationLocks = new Map()

/**
 * Serialize cursor-coupled mutations of one logical cache partition inside
 * the process. Flush and maintenance run on independent daemon timers, but a
 * compaction cursor swap must not strand an append in the retired generation.
 *
 * @ref LLP 0301#requirements [implements]: keep the replacement-generation cursor swap atomic with respect to daemon flushes
 * @template T
 * @param {string} partitionDir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withPartitionMutationLock(partitionDir, fn) {
  const previous = partitionMutationLocks.get(partitionDir) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(fn)
  partitionMutationLocks.set(partitionDir, current)
  return current.finally(() => {
    if (partitionMutationLocks.get(partitionDir) === current) {
      partitionMutationLocks.delete(partitionDir)
    }
  })
}

/**
 * Read the cursor for a logical partition directory.  Returns the
 * default epoch-0 cursor when the file is missing or unparseable.
 *
 * @param {string} partitionDir
 * @returns {PartitionCursor}
 */
export function readCursorSync(partitionDir) {
  return tryReadCursorSync(partitionDir) ?? { epoch: 0, rowCount: 0, compaction: null }
}

/**
 * Like {@link readCursorSync}, but distinguishes "no cursor" / "cursor
 * unreadable" from a real cursor: returns `null` when the file is
 * missing OR cannot be read/parsed, instead of synthesizing a default
 * epoch-0 cursor. Callers that take destructive action based on the
 * cursor (e.g. the orphan-generation sweep) must use this so a corrupt
 * `cursor.json` is never mistaken for "the live generation is epoch 0".
 *
 * A `tableDir` that names anything outside its own partition makes the
 * whole cursor unreadable, and it is rejected here rather than at any call
 * site: see {@link generationDirIsContained}.
 *
 * @ref LLP 0323#one-gate [implements]: the containment check belongs to the reader every destructive path already shares.
 * @param {string} partitionDir
 * @returns {PartitionCursor | null}
 */
export function tryReadCursorSync(partitionDir) {
  /** @type {string} */
  let raw
  try {
    raw = fs.readFileSync(path.join(partitionDir, CURSOR_FILE), 'utf8')
  } catch (err) {
    noteEscapeCleared(partitionDir)
    // Only "there is no cursor here" retires the unreadable condition. Any
    // other read failure (an EACCES, an EIO, a directory where the file
    // was) is that condition rather than its end: the bytes on disk are
    // still whatever they were, so retracting on one would put the
    // partition back into the silence this refusal exists to remove. The
    // escape condition is genuinely unproven either way, which is why it
    // clears above (LLP 0334#recovery-is-announced).
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      noteUnreadableCleared(partitionDir)
    } else {
      reportUnreadableCursor(partitionDir, err)
    }
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    // `JSON.parse` answers with any JSON value, and only `null` makes the
    // field reads below throw: an array, a number, a string and a boolean
    // all answer `undefined` to `.epoch` and would synthesize an epoch-0
    // cursor. That is the exact value `walkForRetired` reads a null for
    // rather than trust, because a live `table/` generation under a
    // synthesized `epoch=0` matches no live name and goes to the orphan
    // sweep (LLP 0323#whole-cursor).
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const kind = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`
      throw new TypeError(`cursor.json holds ${kind}, not a cursor object`)
    }
    /** @type {PartitionCursor} */
    const cursor = {
      epoch: typeof parsed.epoch === 'number' ? parsed.epoch : 0,
      rowCount: typeof parsed.rowCount === 'number' ? parsed.rowCount : 0,
      compaction: parsed.compaction ?? null,
    }
    // Here, and not one line earlier: the guard above is what decides
    // whether the bytes read as a cursor at all, so this is the first point
    // at which they are known to. Clearing right after `JSON.parse` would
    // retract and re-arm the refusal on every read of a file that parses to
    // something that is not a cursor, which is the throttle spending itself
    // on a standing condition (LLP 0332#not-a-pass-object). Every refusal
    // below this line is an escape refusal, which carries its own report.
    noteUnreadableCleared(partitionDir)
    if (parsed.layout === 'source-table' || parsed.layout === 'epoch') {
      cursor.layout = parsed.layout
    }
    // Present but not a string is rejected too, not dropped. Dropping it
    // is exactly the field-level guard LLP 0323#whole-cursor refuses: the
    // cursor would still read as source-table, name the default `table`,
    // and cost a `table-<ms>` partition its live generation to the orphan
    // sweep. Absent stays legitimate - it is the pre-`tableDir` spelling
    // of `table`, and `liveGenerationDir` reads it as one.
    if (parsed.tableDir !== undefined) {
      if (typeof parsed.tableDir !== 'string' || !generationDirIsContained(partitionDir, parsed.tableDir)) {
        reportEscapingTableDir(partitionDir, parsed.tableDir)
        return null
      }
      cursor.tableDir = parsed.tableDir
    } else {
      // An absent `tableDir` still names a generation: every reader resolves
      // it to the layout default and joins THAT onto the partition path, so
      // the default is the name the sweep will walk and the name the gate has
      // to ask about. Absent stays legitimate (LLP 0323#whole-cursor) - what
      // is refused is the same planted symlink, wearing the name nobody had
      // to write down.
      const root = path.resolve(partitionDir)
      const planted = defaultGenerationDirs(cursor).find((name) => generationDirIsSymlink(root, name))
      if (planted !== undefined) {
        reportEscapingTableDir(partitionDir, planted)
        return null
      }
    }
    if (parsed.retention && typeof parsed.retention === 'object') {
      cursor.retention = parsed.retention
    }
    if (typeof parsed.pendingFallbacks === 'number') {
      cursor.pendingFallbacks = parsed.pendingFallbacks
    }
    noteEscapeCleared(partitionDir)
    return cursor
  } catch (err) {
    // Escape first: the bytes no longer prove an escape, and an unproven
    // condition may not throttle (LLP 0334#recovery-is-announced). What
    // that used to leave behind was silence - the retraction went out and
    // nothing said why the partition is still being skipped. It now arms
    // the refusal that is actually standing.
    noteEscapeCleared(partitionDir)
    reportUnreadableCursor(partitionDir, err)
    return null
  }
}

/**
 * Does `tableDir` name a generation directory inside `partitionDir`?
 *
 * Every writer in the tree mints a bare `table` or `table-<ms>` name
 * (`generationLayout`'s `nextDirName`, the context-graph rewrite, and the
 * first append below), so a value that resolves anywhere else did not come
 * from `hyp`. It came from a corrupt or edited `cursor.json`, and the
 * readers downstream are not all read-only: maintenance joins this name
 * onto the partition path and then sweeps, unlinks, and rewrites whatever
 * it finds there. One `..` segment therefore aims destructive cache
 * maintenance at a directory the cache does not own.
 *
 * One segment, because the consumers do not all resolve the value: the
 * orphan sweep compares it to a `readdir` entry name (`entry.name ===
 * liveDirName`), so `./table` and `table/` resolve to the live
 * generation while matching no entry, and the sweep reclaims the very
 * directory the cursor meant to protect. A spelling that resolves inside
 * the partition is therefore not enough; the string itself has to be the
 * name. That is also what every writer mints, so nothing legitimate is
 * spelled any other way.
 *
 * Resolution is still checked after that, because `.` and `..` are both
 * single segments: one names the partition, which holds the cursor rather
 * than a generation, and the other leaves it.
 *
 * All of which reads the string and none of which reads the disk, so a
 * bare-name SYMLINK is contained by spelling and elsewhere in fact. The
 * last check asks the filesystem: see {@link generationDirIsSymlink}. A NUL
 * is rejected on the way past it, because it is the one byte that would
 * make that stat throw on its argument rather than on the filesystem, and
 * no directory entry can carry one anyway.
 *
 * @ref LLP 0323#contained [implements]: a cursor may name a generation only inside its own partition, by its own name.
 * @ref LLP 0326#not-a-symlink [implements]: and the name has to be the directory, not a pointer to one.
 * @param {string} partitionDir
 * @param {string} tableDir
 * @returns {boolean}
 */
function generationDirIsContained(partitionDir, tableDir) {
  if (tableDir === '' || tableDir.includes(NUL_BYTE) || tableDir !== path.basename(tableDir)) return false
  const root = path.resolve(partitionDir)
  if (!path.resolve(root, tableDir).startsWith(root + path.sep)) return false
  return !generationDirIsSymlink(root, tableDir)
}

/**
 * Is the thing at `<root>/<tableDir>` a symlink rather than a generation?
 *
 * `lstat`, so the link itself is measured rather than what it points at,
 * and only the LAST component: every component above it is the partition's
 * own path, which the cache did not choose and which is legitimately
 * reached through a symlink (a `$HYP_HOME` on another volume, `/tmp` on
 * macOS). Resolving those would reject a working cache for the shape of the
 * path it lives at. `realpath` is the same check with that cost attached.
 *
 * Rejection needs positive evidence. A stat that cannot answer - the
 * generation is not created yet, it was removed under us, the directory
 * will not be traversed - says nothing about the name, and treating
 * silence as an escape would invent a fresh way to lose a live generation
 * to the orphan sweep, which is the trade LLP 0323#whole-cursor already
 * refused once.
 *
 * @ref LLP 0326#positive-evidence [implements]: only a symlink the filesystem confirms rejects the cursor.
 * @param {string} root  the resolved partition directory
 * @param {string} tableDir  a bare generation name: an explicit one the
 *   string rules above already passed, or a layout default
 * @returns {boolean}
 */
function generationDirIsSymlink(root, tableDir) {
  return isConfirmedSymlink(path.join(root, tableDir))
}

/**
 * The generation names a reader may resolve for a cursor that carries no
 * `tableDir`.
 *
 * Two of them, because the consumers do not agree and the gate has to cover
 * every name one of them could walk: `liveGenerationDir` reads the layout
 * and answers `epoch=<n>` for anything that is not source-table, while
 * `appendRowsToSourceTable` answers `table` regardless. Only one of the two
 * exists in any real partition, so the other costs a stat that finds
 * nothing.
 *
 * @ref LLP 0326#not-a-symlink [implements]: the default generation name is a generation name.
 * @param {PartitionCursor} cursor
 * @returns {string[]}
 */
function defaultGenerationDirs(cursor) {
  return ['table', `epoch=${cursor.epoch}`]
}

/**
 * How long an unchanged standing escape refusal stays quiet between
 * repeats. The same 10-minute floor as `REWARN_MS` in
 * `src/core/daemon/control.js`, chosen for the same reason: a standing
 * condition must not be mute for the daemon's whole lifetime, and must not
 * be a line per read either. Under the default 60-minute maintenance
 * interval this lands on one line per refusing tick.
 */
const ESCAPE_REWARN_MS = 10 * 60 * 1000

/**
 * How much of a cursor read failure's own text a refusal line carries. A
 * `SyntaxError` quotes the input it choked on, and a `cursor.json` is a file
 * that anything at all can end up inside, so the diagnostic is worth having
 * and is not worth an unbounded line.
 */
const READ_ERROR_MAX_CHARS = 200

/**
 * The escape refusals this process has already said out loud, keyed by
 * resolved partition directory: a type-qualified key for the rejected value
 * the line named, and when. One entry at most per partition that ever
 * refused; cleared by {@link noteEscapeCleared} the moment any read of that
 * partition stops refusing for escape, so a healed-then-repoisoned
 * partition warns afresh, and cleared again by {@link clearEscapeReport}
 * where retention removes the partition directory, so no entry outlives the
 * partition it is keyed on (LLP 0334#eviction-clears). Bounded by the
 * partitions this process saw refuse that still exist.
 *
 * @type {Map<string, { rejectedKey: string, warnedAtMs: number }>}
 */
const escapeReportedAt = new Map()

/**
 * The unreadable-cursor refusals this process has already said out loud,
 * keyed and windowed exactly like {@link escapeReportedAt}, whose entries
 * describe the other way a `cursor.json` stops the partition: present, not
 * escaping, and not readable as a cursor.
 *
 * A second map rather than a second kind of entry in the first one, because
 * the two conditions start and stop independently. A cursor that parses has
 * stopped being unreadable while its `tableDir` may still escape, and a
 * cursor that stops parsing has stopped being provably escaping while it is
 * now unreadable, so the two clearings would be retracting each other's
 * refusal. Each retraction says what it retracts (LLP 0334#recovery-is-announced),
 * and a line that named the wrong condition would be worse than the silence
 * it replaced.
 *
 * @type {Map<string, { rejectedKey: string, warnedAtMs: number }>}
 */
const unreadableReportedAt = new Map()

/**
 * Forget every standing cursor-read refusal recorded for a partition,
 * without saying anything: whatever the entries described is no longer what
 * this partition is, so the next refusal of either kind is a transition and
 * warns immediately.
 *
 * Exported for the callers outside this file. Retention removes whole
 * date partitions, and a partition evicted while poisoned never gets the
 * non-refusing read that would clear it, so its entry would otherwise
 * strand for the process lifetime. Retention already holds the path and is
 * already deleting the directory, so clearing there adds nothing to the hot
 * synchronous reader, which is the cost LLP 0332#transition-plus-rewarn
 * weighed when it accepted the strand. The rule is the site rather than the
 * condition: a directory that stops existing takes every entry keyed on its
 * path with it, so a new refusal kind never has to find the eviction sites
 * again.
 *
 * @ref LLP 0334#eviction-clears [implements]: the entry is dropped where the partition it is keyed on is removed.
 * @param {string} partitionDir
 * @returns {boolean} whether there was an entry to forget
 */
export function clearEscapeReport(partitionDir) {
  const key = path.resolve(partitionDir)
  const hadEscape = escapeReportedAt.delete(key)
  const hadUnreadable = unreadableReportedAt.delete(key)
  return hadEscape || hadUnreadable
}

/**
 * Say a standing refusal out loud, at most once per condition per
 * {@link ESCAPE_REWARN_MS}, and record that it was said.
 *
 * Shared by both refusal reports because the rate is one rule, not one per
 * condition: a refusal warns when it appears or when the rejected value
 * changes, then at most once per window while it stands.
 *
 * @ref LLP 0332#transition-plus-rewarn [implements]: the unit of the standing signal is the condition, not the read that noticed it.
 * @param {Map<string, { rejectedKey: string, warnedAtMs: number }>} reportedAt
 * @param {string} partitionDir
 * @param {string} rejectedKey  what the window compares, which is the value
 *   that was rejected and not the string the line renders it as
 * @param {() => void} emit
 */
function reportStandingRefusal(reportedAt, partitionDir, rejectedKey, emit) {
  const key = path.resolve(partitionDir)
  const now = Date.now()
  const prior = reportedAt.get(key)
  // A negative age means the wall clock stepped back under this entry
  // (`Date.now` is NTP-steppable, and a daemon that starts before the first
  // sync can read far into the past). The window is then not proven to hold,
  // so say it again: the only degradation this throttle may have is an extra
  // line, never silence (LLP 0332#transition-plus-rewarn).
  const sinceMs = prior ? now - prior.warnedAtMs : 0
  if (prior && prior.rejectedKey === rejectedKey && sinceMs >= 0 && sinceMs < ESCAPE_REWARN_MS) return
  try {
    emit()
    // Recorded only once the line is out. `getLogger`'s OTel emit runs
    // before the stderr mirror, so an installed provider that throws would
    // otherwise arm a whole rewarn window over a refusal nobody ever saw.
    reportedAt.set(key, { rejectedKey, warnedAtMs: now })
  } catch { /* a cursor read must not fail on a logger provider that is not installed */ }
}

/**
 * Forget a standing refusal and, if this process had said it out loud,
 * retract it once.
 *
 * The delete happens whether or not the line does. An entry kept alive by a
 * throwing log channel would throttle the next genuine refusal against a
 * condition that had already ended, and that is silence: the one
 * degradation LLP 0332#not-a-pass-object promises this throttle can never
 * have.
 *
 * @ref LLP 0334#recovery-is-announced [implements]: the read that clears an armed refusal says so, so silence after a refusal means the condition still stands.
 * @param {Map<string, { rejectedKey: string, warnedAtMs: number }>} reportedAt
 * @param {string} partitionDir
 * @param {() => void} emit
 */
function clearStandingRefusal(reportedAt, partitionDir, emit) {
  if (!reportedAt.delete(path.resolve(partitionDir))) return
  try {
    emit()
  } catch { /* a cursor read must not fail on a logger provider that is not installed */ }
}

/**
 * Note that a read of this partition did not refuse for escape (it
 * returned a cursor, found no file, or failed to parse), so the next
 * escape refusal is a transition and warns immediately, and say so once if
 * this process had warned about that partition.
 *
 * The line is what makes silence mean one thing again. Under the throttle a
 * quiet read is either "healed" or "still poisoned, the next line is not
 * due yet"; announcing the clearing collapses that to the second, the way
 * `daemon.control_scan_recovered` already does for the control channel
 * (`src/core/daemon/control.js`). It is bounded to one line per refusal
 * this process actually warned about, and a partition that never refused
 * still costs one `Map.delete` that misses, as before.
 *
 * INFO, not WARN: nothing is wrong. It mirrors to stderr anyway, because it
 * is only legible beside the refusal it answers, and that refusal is on
 * stderr by default-install necessity (LLP 0329#stderr-mirror).
 *
 * It reports that the refusal cleared, not that the partition is well: two
 * of the three exits are an absent or unparseable `cursor.json`, which
 * still reads as unreadable. The escape condition ending is exactly the
 * fact the warn armed, and all this line retracts. The wording carries
 * that: a read can fail for reasons that have nothing to do with the
 * cursor's contents (an EACCES on `cursor.json`, an `lstat` the symlink
 * check fails open on), and the identical poison can still be sitting on
 * disk under it. Saying the `tableDir` no longer escapes would be a claim
 * about the file this read never got to look at.
 *
 * @ref LLP 0334#recovery-is-announced [implements]: the read that clears an armed refusal says so, so silence after a refusal means the condition still stands.
 * @param {string} partitionDir
 */
function noteEscapeCleared(partitionDir) {
  clearStandingRefusal(escapeReportedAt, partitionDir, () => {
    getLogger('cache', { mirrorStderr: true }).info(
      'the cursor containment refusal for this partition has cleared; this read did not refuse for escape',
      {
        [Attr.OPERATION]: 'cache.cursor_read',
        [Attr.STATUS]: 'ok',
        recovery_kind: 'cursor_escape_recovered',
        partition_dir: partitionDir,
      }
    )
  })
}

/**
 * Note that a read of this partition got a cursor out of the bytes it
 * found, or found no bytes at all, so the next unreadable refusal is a
 * transition and warns immediately, and say so once if this process had
 * warned about that partition.
 *
 * The escape report's counterpart, for the same reason and on the same
 * terms: see {@link noteEscapeCleared}. It retracts the refusal rather than
 * certifying the partition. One of its two exits is a `cursor.json` this
 * read could not open at all (deleted, or an EACCES), where the identical
 * garbage may still be on disk underneath; the escape condition and the
 * unreadable condition are equally unproven then, and an unproven condition
 * may not throttle.
 *
 * @param {string} partitionDir
 */
function noteUnreadableCleared(partitionDir) {
  clearStandingRefusal(unreadableReportedAt, partitionDir, () => {
    getLogger('cache', { mirrorStderr: true }).info(
      'the unreadable-cursor refusal for this partition has cleared; this read did not refuse the cursor as unreadable',
      {
        [Attr.OPERATION]: 'cache.cursor_read',
        [Attr.STATUS]: 'ok',
        recovery_kind: 'cursor_unreadable_recovered',
        partition_dir: partitionDir,
      }
    )
  })
}

/**
 * Say that a `cursor.json` is present but does not read as a cursor, and
 * say it out loud.
 *
 * This is the other half of the refusal set LLP 0323#one-gate routes
 * through `tryReadCursorSync`, and it was the silent half. The escape
 * refusal knows its cause and says so; a torn or edited `cursor.json` that
 * does not parse produced the same permanent skip with nothing on any
 * channel, so a partition stopped compacting, stopped being swept, and read
 * as empty with no line anywhere saying why. The refusal is permanent by
 * design, and it is not purely a skip: every strict reader does skip, but
 * retention's `tick()` reads through the lenient `readCursorSync`, so an
 * unreadable cursor still routes to `evictLegacyPartition` and takes the
 * whole partition on directory mtime alone. A permanent refusal that can
 * end in a delete is defensible only while it is loud, and it was loud for
 * one of its two exits.
 *
 * Same shape as the escape refusal because it is the same signal: `warn`
 * rather than `error` (nothing failed and the tick carries on), mirrored to
 * stderr, and thrown away by the window unless it is a transition or the
 * failure itself changed. The parse error's own text is what the window
 * compares, so a file that fails differently is the new fact it is; it is
 * capped because a `SyntaxError` quotes the input it choked on and a
 * `cursor.json` is a file anything can be written into.
 *
 * @ref LLP 0323#say-it [implements]: the other corrupt-cursor exit through the shared gate, which knew its cause and did not say it.
 * @ref LLP 0329#stderr-mirror [implements]: the refusal leaves every counter at zero, so it opts into the mirror that exists without a provider.
 * @param {string} partitionDir
 * @param {unknown} err  whatever reading the bytes as a cursor threw
 */
function reportUnreadableCursor(partitionDir, err) {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown'
  const reason = text.length > READ_ERROR_MAX_CHARS ? `${text.slice(0, READ_ERROR_MAX_CHARS)}...` : text
  reportStandingRefusal(unreadableReportedAt, partitionDir, reason, () => {
    getLogger('cache', { mirrorStderr: true }).warn(
      'cursor.json does not read as a cursor; treating the cursor as unreadable',
      {
        [Attr.OPERATION]: 'cache.cursor_read',
        [Attr.ERROR_KIND]: 'cursor_unreadable',
        partition_dir: partitionDir,
        read_error: reason,
      }
    )
  })
}

/**
 * Say that a cursor was rejected for naming a generation outside its
 * partition, and say it out loud.
 *
 * The rejection is otherwise indistinguishable from every other unreadable
 * cursor: the partition stops compacting, stops sweeping, and reads as
 * empty until the next append rewrites the cursor. That is the safe
 * behaviour and the useless diagnostic - "my rows vanished" and "a file I
 * never wrote is in my cache" are two symptoms an operator would otherwise
 * have to reconcile against silence.
 *
 * `warn`, not `error`: nothing failed, and the tick carries on.
 *
 * Once per condition, not once per read: every destructive reader shares
 * `tryReadCursorSync` (LLP 0323#one-gate), so one poisoned cursor is read
 * by many callers that share no pass object, and repeating the identical
 * line for each of them tells the operator nothing the first did not.
 * A refusal warns when it appears or when the rejected value changes, then
 * at most once per {@link ESCAPE_REWARN_MS} while it stands; both channels
 * (the structured WARN and the stderr mirror) throttle together because
 * they are one signal.
 *
 * @ref LLP 0323#say-it [implements]: this is the one corrupt-cursor case that knows its cause, so it does not degrade silently.
 * @ref LLP 0329#stderr-mirror [implements]: the refusal leaves every counter at zero, so it opts into the mirror that exists without a provider.
 * @ref LLP 0332#transition-plus-rewarn [implements]: the unit of the standing signal is the condition, not the read that noticed it.
 * @ref LLP 0334#type-qualified-key [implements]: the window compares the rejected value, not the string the line renders it as.
 * @param {string} partitionDir
 * @param {unknown} tableDir  the rejected value, which need not be a string
 */
function reportEscapingTableDir(partitionDir, tableDir) {
  const rejected = typeof tableDir === 'string' ? tableDir : JSON.stringify(tableDir) ?? String(tableDir)
  // The line says what was rejected; the window compares what it was. Those
  // are not the same string: `JSON.stringify` renders the number 5 and the
  // string "5" identically, so a poison that changed only its JSON type
  // would look unchanged and wait out the window instead of warning as the
  // new fact it is (LLP 0332#transition-plus-rewarn: a poison that changes
  // shape is never absorbed into the old one's window). Qualifying the
  // comparison key by type separates them without touching the reported
  // `table_dir`, which is the rendered value either way.
  const rejectedKey = `${typeof tableDir}:${rejected}`
  reportStandingRefusal(escapeReportedAt, partitionDir, rejectedKey, () => {
    getLogger('cache', { mirrorStderr: true }).warn(
      'cursor.tableDir does not name a generation in its partition; treating the cursor as unreadable',
      {
        [Attr.OPERATION]: 'cache.cursor_read',
        [Attr.ERROR_KIND]: 'cursor_table_dir_escapes_partition',
        partition_dir: partitionDir,
        table_dir: rejected,
      }
    )
  })
}

/**
 * Atomically write cursor.json for a logical partition.
 *
 * @param {string} partitionDir
 * @param {PartitionCursor} cursor
 */
export async function writeCursor(partitionDir, cursor) {
  await atomicWriteJson(path.join(partitionDir, CURSOR_FILE), cursor)
}

/**
 * Append rows into the source-table layout for the resolved
 * partition.  Creates the partition directory, Iceberg table
 * subdirectory, and cursor on first write.
 *
 * The on-disk layout is:
 *   `<cacheRoot>/datasets/<dataset>/source=<source>/table/`
 * with a `cursor.json` at the `source=<source>/` level carrying
 * `layout: 'source-table'`.
 *
 * @param {string} cacheRoot
 * @param {string} dataset
 * @param {string[]} sourceSegments
 * @param {readonly ColumnSpec[]} columns
 * @param {Record<string, unknown>[]} rows
 * @param {{ declaration?: CachePartitioningDeclaration }} [options]
 * @returns {Promise<{ tableUrl: string, appended: boolean, bytesWritten: number }>}
 */
export async function appendRowsToSourceTable(cacheRoot, dataset, sourceSegments, columns, rows, options) {
  if (rows.length === 0) {
    return { tableUrl: '', appended: false, bytesWritten: 0 }
  }
  const partitionDir = cacheTablePath(cacheRoot, dataset, sourceSegments)
  // @ref LLP 0027#re-settle-sweep [implements]: the sweep's gate is this
  // count, so the write path is where it is maintained - maintenance reading
  // the cursor is only cheap because nothing here forgets to tally. Rows
  // arrive after the flush-time settle hook has run, so a marker still
  // present is a genuinely unsettled row.
  const fallbackAppended = countGatewayFallbackRows(rows)
  return withPartitionMutationLock(partitionDir, async () => {
    const cursorOnDisk = tryReadCursorSync(partitionDir)
    const cursor = cursorOnDisk ?? { epoch: 0, rowCount: 0, compaction: null }
    const tableDir = cursor.tableDir ?? 'table'
    const icebergDir = path.join(partitionDir, tableDir)
    // Asked BEFORE the append, which creates the table on first use: after
    // it every partition looks like one that already held rows.
    const mayHoldUncountedRows = partitionHasCommittedRows(partitionDir, icebergDir)
    const declaration = options?.declaration
    const result = await appendRowsToTable(icebergDir, columns, rows, declaration ? { declaration } : undefined)
    await writeCursor(partitionDir, {
      epoch: cursor.epoch,
      rowCount: cursor.rowCount + rows.length,
      compaction: cursor.compaction,
      layout: 'source-table',
      tableDir,
      retention: cursor.retention,
      ...pendingFallbacksAfterAppend(cursor, mayHoldUncountedRows, fallbackAppended),
    })
    return result
  })
}

/**
 * Append rows into the current epoch's Iceberg table for the resolved
 * partition.  Creates the partition directory and cursor on first
 * write.
 *
 * @param {string} cacheRoot
 * @param {string} dataset
 * @param {string[]} partitionSegments
 * @param {readonly ColumnSpec[]} columns
 * @param {Record<string, unknown>[]} rows
 * @returns {Promise<{ tableUrl: string, appended: boolean, bytesWritten: number }>}
 */
export async function appendRowsToPartition(cacheRoot, dataset, partitionSegments, columns, rows) {
  if (rows.length === 0) {
    return { tableUrl: '', appended: false, bytesWritten: 0 }
  }
  const partitionDir = cacheTablePath(cacheRoot, dataset, partitionSegments)
  // @ref LLP 0027#re-settle-sweep [implements]: as above - the legacy epoch
  // layout is not settle-eligible today, but a cursor field maintained on
  // only one of two write paths is a count that drifts the day it is.
  const fallbackAppended = countGatewayFallbackRows(rows)
  return withPartitionMutationLock(partitionDir, async () => {
    const cursorOnDisk = tryReadCursorSync(partitionDir)
    const cursor = cursorOnDisk ?? { epoch: 0, rowCount: 0, compaction: null }
    const epochDir = path.join(partitionDir, `epoch=${cursor.epoch}`)
    // As above: asked before the append creates the epoch's table.
    const mayHoldUncountedRows = partitionHasCommittedRows(partitionDir, epochDir)
    const result = await appendRowsToTable(epochDir, columns, rows)
    await writeCursor(partitionDir, {
      epoch: cursor.epoch,
      rowCount: cursor.rowCount + rows.length,
      compaction: cursor.compaction,
      ...pendingFallbacksAfterAppend(cursor, mayHoldUncountedRows, fallbackAppended),
    })
    return result
  })
}

/**
 * May this partition already hold committed rows that no cursor count
 * covers? Yes whenever a `cursor.json` is present - deliberately NOT "did
 * {@link tryReadCursorSync} return a cursor", which also answers null for a
 * file that exists but cannot be parsed, and a partition whose cursor is
 * unreadable is not a fresh one. Yes also when the cursor is gone but the
 * Iceberg table is not: that is what a crash between an append and its
 * cursor write leaves behind, and a source-table partition in that state is
 * invisible to {@link discoverCachePartitions} until an append restores its
 * cursor, so nothing else would ever re-derive the count for it.
 *
 * Only when NEITHER exists is the partition provably new, and only then may
 * an append claim a concrete zero.
 *
 * @param {string} partitionDir
 * @param {string} tableDir  the Iceberg table this append writes into
 * @returns {boolean}
 */
function partitionHasCommittedRows(partitionDir, tableDir) {
  return fs.existsSync(path.join(partitionDir, CURSOR_FILE)) || icebergTableExists(tableDir)
}

/**
 * The `pendingFallbacks` entry an append should write, as a spreadable
 * fragment. A first write to a provably new partition starts the count at
 * the appended tally, so tables born after the field existed always carry a
 * concrete number. Over anything that may already hold committed rows an
 * absent count means "unknown" (a cursor written before the field existed,
 * an unreadable one, or a table whose cursor was lost), and an append of
 * zero marker rows must preserve that: claiming zero would let maintenance
 * skip that table's one seeding scan and strand its split twins. Once a
 * marker row lands the count turns concrete regardless - an undercount only
 * until the next rewrite records the exact remainder, and any positive
 * value routes to that rewrite.
 *
 * @param {PartitionCursor} cursor
 * @param {boolean} mayHoldUncountedRows see {@link partitionHasCommittedRows}
 * @param {number} fallbackAppended
 * @returns {{ pendingFallbacks?: number }}
 */
function pendingFallbacksAfterAppend(cursor, mayHoldUncountedRows, fallbackAppended) {
  if (mayHoldUncountedRows && cursor.pendingFallbacks === undefined && fallbackAppended === 0) return {}
  return { pendingFallbacks: (cursor.pendingFallbacks ?? 0) + fallbackAppended }
}

/**
 * Walk the datasets tree to discover logical partitions that carry a
 * cursor.json.  Filters by the supplied scope (datasets, date range).
 *
 * @param {string} cacheRoot
 * @param {Partial<QueryScope>} [scope]
 * @returns {Promise<CachePartitionMeta[]>}
 */
export async function discoverCachePartitions(cacheRoot, scope = {}) {
  /** @type {CachePartitionMeta[]} */
  const results = []
  const root = datasetsRoot(cacheRoot)
  try {
    await fsPromises.access(root)
  } catch {
    return results
  }
  await walk(root)
  return results

  /** @param {string} dir */
  async function walk(dir) {
    /** @type {Dirent[]} */
    let entries
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const hasCursor = entries.some((e) => e.isFile() && e.name === CURSOR_FILE)
    const hasIceberg = !hasCursor && icebergTableExists(dir)
    if (hasCursor || hasIceberg) {
      const cursor = hasCursor ? readCursorSync(dir) : { epoch: 0, rowCount: 0, compaction: null }
      const rel = path.relative(root, dir)
      const parts = rel.split(path.sep)
      const dataset = parts[0]
      if (scope.datasets && scope.datasets.length > 0 && !scope.datasets.includes(dataset)) return
      /** @type {Record<string, string>} */
      const partition = {}
      for (let i = 1; i < parts.length; i++) {
        const eq = parts[i].indexOf('=')
        if (eq > 0) {
          partition[parts[i].slice(0, eq)] = parts[i].slice(eq + 1)
        }
      }
      if (partition.date) {
        if (scope.date && partition.date !== scope.date) return
        if (scope.dates && scope.dates.length > 0 && !scope.dates.includes(partition.date)) return
        if (scope.from && partition.date < scope.from) return
        if (scope.to && partition.date > scope.to) return
      }
      results.push({
        dataset,
        partition,
        path: dir,
        epoch: cursor.epoch,
        rowCount: cursor.rowCount,
        legacy: hasIceberg,
      })
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('epoch=')) continue
      if (entry.name.startsWith('table')) continue
      if (entry.name === SPOOL_DIR) continue
      if (entry.name === RETIRED_DIR) continue
      await walk(path.join(dir, entry.name))
    }
  }
}

/**
 * Resolve the source partition key from a row using the fallback
 * chain: client_name → conversation_source → provider → "unknown".
 * Used as the default source resolver for all datasets when no
 * `CachePartitioningDeclaration` is registered. Datasets without any
 * of these fields will be grouped under "unknown".
 *
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function resolveClientName(row) {
  return nonEmpty(row.client_name) ?? nonEmpty(row.conversation_source) ?? nonEmpty(row.provider) ?? 'unknown'
}

/**
 * Extract a `YYYY-MM-DD` date string from common timestamp fields.
 * Returns `undefined` when no recognizable timestamp is present.
 *
 * @param {Record<string, unknown>} row
 * @returns {string | undefined}
 */
export function resolvePartitionDate(row) {
  const ts = row.timestamp ?? row.created_at ?? row.recorded_at ?? row.date
  if (typeof ts === 'string') {
    const match = ts.match(/^(\d{4}-\d{2}-\d{2})/)
    if (match) return match[1]
    const d = new Date(ts)
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  if (ts instanceof Date) return ts.toISOString().slice(0, 10)
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString().slice(0, 10)
  return undefined
}

/**
 * Derive the partition segments for a row by inspecting its data for
 * client and date fields.  Falls back to `['all']` when neither
 * dimension is resolvable, preserving backwards compatibility with
 * datasets that carry no partition-relevant columns.
 *
 * @param {Record<string, unknown>} row
 * @returns {string[]}
 */
export function resolvePartitionSegments(row) {
  const client = resolveClientName(row)
  const date = resolvePartitionDate(row)
  if (client === 'unknown' && !date) return ['all']
  /** @type {string[]} */
  const segments = []
  segments.push(`client=${client}`)
  if (date) segments.push(`date=${date}`)
  return segments
}

/**
 * Sanitize a value for use as a filesystem path segment.
 * Replaces path separators, control characters, and reserved names with
 * safe alternatives.
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizePathSegment(value) {
  let safe = value.replace(/[\x00-\x1f/\\:*?"<>|]/g, '_')
  if (safe === '.' || safe === '..') safe = `_${safe}_`
  if (safe.length === 0) safe = '_empty_'
  return safe
}

/**
 * Resolve path segments for the source table using the dataset's
 * declared source columns. Falls back through the column list in
 * order, then to the declaration's fallback value.
 *
 * @param {Record<string, unknown>} row
 * @param {CachePartitioningDeclaration} declaration
 * @returns {string[]}
 */
export function resolveSourceSegments(row, declaration) {
  let source = declaration.source.fallback ?? 'unknown'
  for (const col of declaration.source.columns) {
    const val = nonEmpty(row[col])
    if (val) {
      source = val
      break
    }
  }
  return [`source=${sanitizePathSegment(source)}`]
}

/**
 * Validate that required Iceberg partition fields are present and
 * non-empty in a row.
 *
 * @param {Record<string, unknown>} row
 * @param {CachePartitioningDeclaration} declaration
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateIcebergPartitionFields(row, declaration) {
  /** @type {string[]} */
  const missing = []
  for (const field of declaration.iceberg.fields) {
    if (field.required && nonEmpty(row[field.column]) === undefined) {
      missing.push(field.column)
    }
  }
  return { valid: missing.length === 0, missing }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  if (value == null) return undefined
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  return String(value)
}
