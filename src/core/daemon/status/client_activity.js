// @ts-check

/**
 * Whether a client has been used: bounded walks over the files a client
 * writes, and the tail reads that confirm a conversation in them.
 *
 * @import { Dirent } from 'node:fs'
 * @import { FileHandle } from 'node:fs/promises'
 * @import { ClientDescriptor } from '../../../../src/core/types.js'
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { isPlainObject } from '../../util/json_util.js'
import { resolveClientSettingsPath } from '../client_settings_path.js'
import { parseIsoMs } from './values.js'

/**
 * Ceiling on how deep the activity-probe walk descends below the declared
 * directory. Claude transcripts sit two levels down
 * (`projects/<slug>/<session>.jsonl`) and subagent transcripts four
 * (`projects/<slug>/<session>/subagents/agent-*.jsonl`); the cap exists so a
 * manifest pointing at a pathological tree bounds the probe instead of the
 * probe walking it to the bottom.
 */
const MAX_ACTIVITY_PROBE_DEPTH = 5

/**
 * When this client last left a file behind: the newest matching mtime under
 * the descriptor's `activity_probe.dir`, as an ISO timestamp.
 *
 * This is the transcript half of the capture-health comparison, probed fresh
 * on every `hyp status` run rather than read from `status.json`, because the
 * moment it matters most is a daemon that has been down while the user
 * worked - exactly when nothing was alive to record it. It stats file
 * metadata only, never opens a file, and is best-effort like every probe in
 * this collector: any failure reads as `undefined` (no claim), never as a
 * fabricated timestamp.
 *
 * @ref LLP 0257#status-and-health [implements]: the last-transcript-activity side of the capture-health line
 * @param {{ descriptor: ClientDescriptor, homeDir: string, env?: NodeJS.ProcessEnv }} args
 * @returns {Promise<string | undefined>}
 */
export async function probeClientActivityFromDescriptor({ descriptor, homeDir, env }) {
  const probe = descriptor.activityProbe
  if (!probe || !homeDir) return undefined
  /** @type {string} */
  let dirPath
  try {
    dirPath = resolveClientSettingsPath(descriptor.name, probe.dir, env, homeDir, {
      field: 'activity_probe.dir',
    })
  } catch {
    return undefined
  }
  /** @type {number | undefined} */
  let newest
  await eachActivityFile(dirPath, probe.file_suffix, MAX_ACTIVITY_PROBE_DEPTH, (_full, mtimeMs) => {
    if (newest === undefined || mtimeMs > newest) newest = mtimeMs
  })
  return newest === undefined ? undefined : new Date(newest).toISOString()
}

/**
 * Walk the activity tree, handing every matching regular file's path and
 * mtime to `visit`. Symlinks are not followed and every fs error skips the
 * entry: a probe that cannot read a corner of the tree still answers from
 * the rest of it.
 *
 * Returns whether the whole tree was actually walked. Everything skipped is
 * still skipped, but the confirmation read may not call a tree it could not
 * see healthy, so a skip that could have hidden a record has to be reported
 * rather than swallowed: a directory that would not list, a file that would
 * not stat, a symlink left unfollowed, a level past `depth`, an entry whose
 * kind readdir did not report. Only two skips are not gaps in the walk, and
 * both are named rather than left to fall through. A missing entry holds no
 * records at all, and neither does a fifo, a socket, or a device node that
 * happens to match the suffix. Missing is a steady-state answer, though, not
 * one that survives the gap between this walk and the confirmation's: a file
 * rotated away in between reads as covered.
 *
 * @param {string} dir
 * @param {string | undefined} suffix
 * @param {number} depth
 * @param {(full: string, mtimeMs: number) => void} visit
 * @returns {Promise<boolean>}
 */
async function eachActivityFile(dir, suffix, depth, visit) {
  /** @type {Dirent[]} */
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    return isMissingEntryError(err)
  }
  let complete = true
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth <= 1) {
        complete = false
        continue
      }
      if (!(await eachActivityFile(full, suffix, depth - 1, visit))) complete = false
    } else if (entry.isFile()) {
      if (suffix !== undefined && !entry.name.endsWith(suffix)) continue
      try {
        const stat = await fsp.stat(full)
        visit(full, stat.mtimeMs)
      } catch (err) {
        // Raced deletion or unreadable file: skip, but say so.
        if (!isMissingEntryError(err)) complete = false
      }
    } else if (!holdsNoRecords(entry)) {
      // Everything this walk did not classify and handle above. A symlink is
      // deliberately not followed, but it can point at a whole tree of
      // records, so an unfollowed one is a corner this did not look at, the
      // same as a directory it could not list. So is an entry whose kind
      // readdir never reported: `UV_DIRENT_UNKNOWN`, which libuv yields
      // wherever the filesystem omits `d_type` (NFS in many configurations,
      // XFS made with `ftype=0`, several FUSE filesystems). There every
      // predicate above answers false, and a real transcript sitting in that
      // subtree is invisible to this walk. The condition is written as the
      // negative of the kinds that are genuinely covered, not as a list of
      // the kinds that are not, so an entry nobody anticipated - a dirent
      // kind added after this was written included - reports the tree
      // unwalked instead of silently reading as fully covered.
      complete = false
    }
  }
  return complete
}

/**
 * Is this entry one the walk can skip without leaving a corner unlooked-at?
 * A named pipe, a socket, or a device node holds no transcript records
 * however it is named, so passing one over costs the walk nothing. Every
 * other kind has to be either handled or reported.
 *
 * @param {Dirent} entry
 * @returns {boolean}
 */
function holdsNoRecords(entry) {
  return entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice()
}

/**
 * Did this fs error mean the entry simply is not there? A missing file or
 * directory holds no records, which is an answer; anything else (a directory
 * that cannot be listed, a file that cannot be stat'd) is the walk failing to
 * look, which is not.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissingEntryError(err) {
  return isPlainObject(err) && err.code === 'ENOENT'
}

/**
 * How many transcript files the confirmation read may open, newest mtime
 * first, and how many bytes it may read from the end of each. The product is
 * the whole budget: two megabytes read and parsed at the very worst, once,
 * and only on the path that would otherwise print a capture gap.
 *
 * Sixteen files covers a sitting's worth of concurrently-written sessions (a
 * main transcript plus its subagents). 128 KiB per tail is sized off real
 * transcripts: over 320 of them the newest conversation record sits within
 * 17 KiB of the end in 99 cases out of 100 and within 40 KiB in the worst
 * one, and all but a thousandth of records are under 53 KiB. The window
 * clears both by better than 3x, and a tail that still defeats it answers
 * `unknown` rather than guessing.
 */
const MAX_CONFIRM_FILES = 16

const MAX_CONFIRM_TAIL_BYTES = 128 * 1024

/**
 * Confirm a suspected capture gap against transcript content: the newest
 * *conversation* record in the tails of the files whose mtime is newer than
 * the capture baseline.
 *
 * The mtime probe above nominates; this decides. A transcript file is
 * rewritten for plenty of reasons that produce no conversation and so owe no
 * telemetry, and every one of them moves the mtime: a metadata record, a
 * local slash command, an informational notice, a plain touch. Only a `user`
 * or `assistant` record that is not injected metadata (`isMeta`) establishes
 * a turn that should have produced telemetry.
 *
 * Bounded twice over, because `hyp status` is run often: at most
 * `MAX_CONFIRM_FILES` files are opened, newest mtime first, and at most
 * `MAX_CONFIRM_TAIL_BYTES` are read from the end of each. Files older than
 * the baseline are never opened at all (a record cannot postdate its file's
 * mtime), and the walk stops early once no remaining candidate's mtime could
 * beat the activity already found.
 *
 * The answer is deliberately three-valued. `certain: false` means the budget
 * ran out before the question was settled - a tail that never reached back
 * past the baseline, an unreadable file, more candidates than the file cap -
 * and the caller must turn that into neither a gap nor a clean bill of
 * health.
 *
 * The record shape read here is Claude Code's, so only the built-in claude
 * descriptor is confirmed this way. Any other descriptor that declares an
 * `activity_probe` answers `certain: false` before the filesystem is touched:
 * its transcripts would never match, and "no conversation found" would read
 * as a clean bill of health and hide a real gap.
 *
 * @ref LLP 0257#status-and-health [implements]: "last transcript activity" is a conversation record, not a filesystem timestamp
 * @ref LLP 0536#certainty-obligation [implements]: certain only when nothing that could hold a newer turn went unread; a no-turn answer needs full post-baseline coverage
 * @param {{ descriptor: ClientDescriptor, homeDir: string, env?: NodeJS.ProcessEnv, sinceMs: number }} args
 * @returns {Promise<{ activityAt?: string, certain: boolean }>}
 */
export async function confirmClientActivityFromDescriptor({ descriptor, homeDir, env, sinceMs }) {
  const probe = descriptor.activityProbe
  if (!probe || !homeDir) return { certain: false }
  if (descriptor.plugin !== '@hypaware/claude' || descriptor.name !== 'claude') return { certain: false }
  /** @type {string} */
  let dirPath
  try {
    dirPath = resolveClientSettingsPath(descriptor.name, probe.dir, env, homeDir, {
      field: 'activity_probe.dir',
    })
  } catch {
    return { certain: false }
  }
  /** @type {{ full: string, mtimeMs: number }[]} */
  const candidates = []
  let dropped = false
  const walked = await eachActivityFile(dirPath, probe.file_suffix, MAX_ACTIVITY_PROBE_DEPTH, (full, mtimeMs) => {
    if (mtimeMs <= sinceMs) return
    if (candidates.length < MAX_CONFIRM_FILES) {
      candidates.push({ full, mtimeMs })
    } else {
      // Bounded insertion rather than collect-then-sort: the candidate set is
      // whatever the tree holds, and a status probe must not size a list by
      // it. Newest wins, and anything evicted marks the answer uncertain.
      dropped = true
      let weakest = 0
      for (let i = 1; i < candidates.length; i++) {
        if (candidates[i].mtimeMs < candidates[weakest].mtimeMs) weakest = i
      }
      if (mtimeMs > candidates[weakest].mtimeMs) candidates[weakest] = { full, mtimeMs }
    }
  })
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  /** @type {number | undefined} */
  let activityMs
  // A corner of the tree that could not be listed or stat'd may hold the
  // very turn this is looking for, so a walk that skipped one cannot end in a
  // clean bill of health any more than an unreadable file can.
  let certain = !dropped && walked
  for (const candidate of candidates) {
    if (activityMs !== undefined && candidate.mtimeMs <= activityMs) break
    const found = await confirmActivityInFile(candidate.full, sinceMs)
    if (!found.certain) certain = false
    if (found.activityMs !== undefined && (activityMs === undefined || found.activityMs > activityMs)) {
      activityMs = found.activityMs
    }
  }
  return activityMs === undefined
    ? { certain }
    : { activityAt: new Date(activityMs).toISOString(), certain }
}

/**
 * Newest conversation record in one transcript file's bounded tail.
 *
 * Scanned backwards, so the first conversation record found is the newest and
 * the read stops there. `certain` is false only when the tail could still be
 * hiding one: the read was truncated and never reached back past `sinceMs`,
 * the file could not be opened at all, it gave back fewer bytes than its own
 * size promised, or a line above the newest turn would not parse. A truncated
 * tail whose oldest timestamp already predates the baseline has seen
 * everything that could matter, and a fully-read tail from byte zero has seen
 * the whole file.
 *
 * @param {string} file
 * @param {number} sinceMs
 * @returns {Promise<{ activityMs?: number, certain: boolean }>}
 */
async function confirmActivityInFile(file, sinceMs) {
  /** @type {FileHandle | undefined} */
  let handle
  try {
    handle = await fsp.open(file, 'r')
    const size = (await handle.stat()).size
    // One byte earlier than the tail, as `readFileTail` does: a boundary that
    // happens to land on a record edge is otherwise indistinguishable from a
    // mid-record cut, and the discard below would eat a whole valid line.
    const offset = size > MAX_CONFIRM_TAIL_BYTES ? size - MAX_CONFIRM_TAIL_BYTES : 0
    const start = offset > 0 ? offset - 1 : 0
    const length = size - start
    if (length <= 0) return { certain: true }
    const buf = Buffer.allocUnsafe(length)
    // Filled to the end, not to whatever one read returned: a short read
    // drops the *newest* records, which is the half that decides this.
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buf, filled, length - filled, start + filled)
      if (bytesRead <= 0) break
      filled += bytesRead
    }
    if (filled < length) return { certain: false }
    const lines = buf.toString('utf8').split('\n')
    // The first line of a truncated read starts mid-record (mid-codepoint,
    // even), so it is never parsed rather than parsed and misread.
    if (start > 0) lines.shift()
    /** @type {number | undefined} */
    let oldestSeenMs
    // A line that will not parse, or a turn that will not date, is content
    // this did not read - and the newest record of a live transcript is the
    // one most likely to be half-written when status runs. Skipping it is
    // right; counting the skip as "no turn here" is not.
    let unread = false
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line) continue
      /** @type {unknown} */
      let row
      try { row = JSON.parse(line) } catch { unread = true; continue }
      if (!isPlainObject(row)) { unread = true; continue }
      const ms = parseIsoMs(row.timestamp)
      if (ms === undefined) {
        if (isConversationRecord(row)) unread = true
        continue
      }
      oldestSeenMs = ms
      if (isConversationRecord(row)) return { activityMs: ms, certain: !unread }
    }
    if (unread) return { certain: false }
    if (start === 0) return { certain: true }
    return { certain: oldestSeenMs !== undefined && oldestSeenMs <= sinceMs }
  } catch {
    return { certain: false }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Does this transcript record establish a turn that should have produced
 * telemetry?
 *
 * Only the two conversational types do. Claude Code writes plenty else into
 * the same file - `system` (a local slash command's output arrives as
 * `subtype: 'local_command'`), `attachment`, `file-history-snapshot`,
 * `queue-operation`, mode and title records - and none of it is a turn.
 * `isMeta` is the same story one level in: an expanded command or skill body
 * injected into the context, not something the user said.
 *
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
function isConversationRecord(row) {
  if (row.isMeta === true) return false
  return row.type === 'user' || row.type === 'assistant'
}
