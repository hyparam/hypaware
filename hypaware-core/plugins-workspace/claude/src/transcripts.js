// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { canonicalJson, isPlainObject, sha256Hex, stringValue, stripVolatileBlockFields } from 'hypaware/core/util'

/**
 * Claude Code JSONL transcript reader. The Claude CLI writes one
 * JSONL file per session under `<homeDir>/.claude/projects/<repo>/<session-id>.jsonl`
 * (and optionally the hook tells us the exact path through
 * `transcript_path` on the session-context channel). Subagent
 * (sidechain) entries are NOT in the session file: the CLI splits them
 * into `<repo>/<session-id>/subagents/agent-*.jsonl`, one file per
 * agent, with each entry still carrying the parent `sessionId`. A
 * session's transcript is therefore the session file PLUS everything
 * under its session-named directory. Every line is a record like:
 *
 * ```jsonl
 * {"sessionId":"...","uuid":"u-1","parentUuid":null,"type":"user","message":{...},"timestamp":"..."}
 * {"sessionId":"...","uuid":"u-2","parentUuid":"u-1","type":"assistant","message":{...},"timestamp":"..."}
 * ```
 *
 * The projector loads a transcript per exchange, through the
 * incremental loader in `transcript-cache.js`, which injects its own
 * per-file reader into `loadTranscript` and leaves file resolution
 * here. Backfill and flush-time settlement call `loadTranscript`
 * directly. The reader is best-effort either way: a missing directory,
 * a missing file, or a truncated line never throws: projection falls
 * back to gateway-computed identity in that case.
 */

/**
 * @import { JsonObject, PluginName } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { Desktop3pDirsEntry, TranscriptEntry } from './types.js'
 */

/**
 * @param {string} homeDir
 */
export function defaultClaudeProjectsDir(homeDir) {
  return path.join(homeDir, '.claude', 'projects')
}

/**
 * Claude Desktop sandbox session roots, most recent layout first. Desktop
 * runs Cowork conversations in per-session sandbox homes under
 * `local-agent-mode-sessions/<...>/local_<id>/`, so their transcripts land
 * in nested `.claude/projects` trees tagged `entrypoint: "local-agent"`.
 * App 1.40609.1 writes these directly under the first-party `Claude`
 * container. Older managed third-party-inference builds used a sibling
 * `Claude-3p` container (app 1.13576.0 / CLI 2.1.177) or nested it inside
 * `Claude/` (LLP 0133). All observed layouts are scanned, and a missing
 * directory is a cheap no-op.
 *
 * @ref LLP 0133#attribution [implements]: attached-Desktop transcripts live in the 3p container's sandbox homes, not ~/.claude/projects; these are the roots the claude adapter scans to keep Desktop rows enriched and attributable
 * @ref LLP 0140#container-root-owns [implements]: hardcoded Desktop sandbox roots are attributed to Desktop regardless of their local-agent entrypoint
 * @param {string} homeDir
 * @returns {string[]}
 */
export function claudeDesktop3pSessionRoots(homeDir) {
  return [
    path.join(homeDir, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
    path.join(homeDir, 'Library', 'Application Support', 'Claude-3p', 'local-agent-mode-sessions'),
    path.join(homeDir, 'Library', 'Application Support', 'Claude', 'Claude-3p', 'local-agent-mode-sessions'),
  ]
}

/**
 * The client whose sandbox roots {@link claudeDesktop3pSessionRoots} names.
 * Sessions found under those roots belong to Claude Desktop whatever
 * entrypoint value they carry: the value has already drifted between
 * Desktop builds, so admission keys on this owner, not on the tag
 * (`classifyContainerSession`). Lives beside the root list because the
 * two facts are one piece of knowledge: where Desktop's container is,
 * and that it is Desktop's.
 *
 * @ref LLP 0140#container-root-owns [implements]: the Desktop sandbox owner is fixed at the site that hardcodes its paths
 */
export const DESKTOP_3P_CONTAINER_OWNER = Object.freeze({
  client: 'claude-desktop',
  plugin: /** @type {PluginName} */ ('@hypaware/claude-desktop'),
})

/**
 * Sandbox homes nest a few levels below the session root
 * (`<root>/<bucket>/<seq>/local_<id>/.claude/projects`); the cap only
 * bounds a runaway walk if the layout drifts again.
 */
const DESKTOP_3P_SCAN_DEPTH = 6

/**
 * Find every `.claude/projects` directory nested under the known Desktop
 * session roots. Best-effort and bounded: a missing root yields
 * nothing, recursion stops at `.claude` (the projects tree is walked by
 * the caller) and at {@link DESKTOP_3P_SCAN_DEPTH}.
 *
 * @param {string} homeDir
 * @returns {string[]}
 */
export function findDesktop3pProjectsDirs(homeDir) {
  /** @type {string[]} */
  const found = []
  for (const root of claudeDesktop3pSessionRoots(homeDir)) {
    collectNestedProjectsDirs(root, 0, found)
  }
  return found
}

/**
 * How long a discovered container-root list stays fresh in
 * {@link createDesktop3pDirsCache}. Long enough that an attached Desktop
 * streaming exchanges does not sweep the container per exchange, short
 * enough that a new sandbox home is picked up between conversations even
 * without the refresh-on-miss path.
 */
const DESKTOP_3P_DIRS_TTL_MS = 30_000

/**
 * How many session ids one home remembers having spent a forced re-sweep
 * on. The memo is dropped whenever the container changes, but a daemon that
 * keeps running sees an unbounded stream of sessions that will never match
 * (SDK and headless traffic with no transcript, harness aux exchanges,
 * wire-only reminders), so it is capped rather than left to grow with
 * uptime.
 */
export const DESKTOP_3P_SWEPT_SESSIONS_MAX = 1024

/**
 * TTL cache over {@link findDesktop3pProjectsDirs}, keyed by home dir.
 *
 * The live projector resolves the 3p roots on every primary-tree miss,
 * and for an attached Desktop every exchange is a primary miss by
 * construction, so the uncached sweep re-walked a container whose
 * per-session sandbox homes grow monotonically with conversations. The
 * cache bounds that to one sweep per TTL; a caller whose session was in
 * none of the cached dirs forces one more through {@link
 * createDesktop3pDirsCache}'s `refreshFor`, so a sandbox home created
 * after the last sweep is still found (see `loadTranscript`).
 *
 * `ttlMs` and `now` are injectable for tests only.
 *
 * @param {{ ttlMs?: number, now?: () => number }} [opts]
 */
export function createDesktop3pDirsCache(opts) {
  const ttlMs = opts?.ttlMs ?? DESKTOP_3P_DIRS_TTL_MS
  const now = opts?.now ?? Date.now
  /** @type {Map<string, Desktop3pDirsEntry>} */
  const byHome = new Map()

  /**
   * @param {string} homeDir
   * @param {Desktop3pDirsEntry} [hit]
   * @returns {{ entry: Desktop3pDirsEntry, unchanged: boolean }}
   */
  function sweep(homeDir, hit) {
    const dirs = findDesktop3pProjectsDirs(homeDir)
    // A container that changed re-arms every session remembered against the
    // list it replaced, which is what keeps a new sandbox home findable.
    const unchanged = !!hit && sameDirs(hit.dirs, dirs)
    // `moved` carries that verdict to a caller who missed inside a list it
    // did not ask to have swept (a `get()` past the TTL walks on its own),
    // so that miss settles on the same rule a forced walk uses. A first
    // sweep replaced no list, so it has nothing to have moved from.
    const entry = { atMs: now(), dirs, moved: !!hit && !unchanged, swept: unchanged ? hit.swept : new Set() }
    byHome.set(homeDir, entry)
    return { entry, unchanged }
  }

  /**
   * Memoise this session's spent walk against the list `entry` names.
   * Oldest out first, so a daemon streaming one-off sessions that never
   * match cannot grow the memo with uptime. An evicted session costs one
   * more sweep, never a wrong answer.
   *
   * The `!cached` arm reaches here without the memo check the forced walk
   * makes, and a TTL rollover re-settles every session the memo still
   * holds, so a session already remembered against this list must cost no
   * other one its place.
   *
   * @param {Desktop3pDirsEntry} entry
   * @param {string} sessionId
   */
  function remember(entry, sessionId) {
    if (entry.swept.has(sessionId)) return
    if (entry.swept.size >= DESKTOP_3P_SWEPT_SESSIONS_MAX) {
      entry.swept.delete(/** @type {string} */ (entry.swept.values().next().value))
    }
    entry.swept.add(sessionId)
  }

  return {
    /**
     * @param {string} homeDir
     * @returns {{ dirs: string[], cached: boolean }}
     */
    get(homeDir) {
      const atMs = now()
      const hit = byHome.get(homeDir)
      if (hit && atMs - hit.atMs < ttlMs) return { dirs: hit.dirs, cached: true }
      return { dirs: sweep(homeDir, hit).entry.dirs, cached: false }
    },
    /**
     * Settle one session's miss inside the dirs a `get()` just named, given
     * that `get()`'s own `cached` back: a list `get()` had to sweep for
     * already holds everything a walk here would find, so the miss is
     * remembered rather than walked again, and only a miss inside a cached
     * list buys the re-sweep.
     *
     * Both loaders take this leg per settle pass, and with the caller
     * gating on `cached` alone a sweeping `get()` settled no miss, so the
     * second loader walked the identical container again (issue #1795).
     *
     * The walk is spent at most once per session per container list either
     * way: a second walk of a list this session already missed reads the
     * same directories to the same answer.
     *
     * A sandbox home usually appears before the session it belongs to has
     * ever missed, so that session is not memoised yet and still gets the
     * walk that finds it, and that walk re-arms every session remembered
     * against the older list. A walk that found the container still moving
     * settles no miss at all, whichever of the two made it.
     *
     * A home that lands after its own session already missed is the case
     * this does not find at once: the first exchange of a new conversation
     * can miss before the CLI inside the sandbox has written anything, and
     * that spends the session's sweep. It waits for the first sweep another
     * session forces, or for the TTL, whichever comes first, so the bound
     * is one TTL. Transcript identity re-settles later and is unharmed, and
     * so does `loadAgentMeta`'s `spawned_by_tool_use_id`: settlement calls
     * this loader too (issue #1794), so a sidechain exchange inside that
     * window recovers its provenance on the same pass that recovers its
     * identity.
     *
     * @param {string} homeDir
     * @param {string} sessionId
     * @param {boolean} cached  the `cached` of the `get()` whose dirs this
     *   session missed inside
     * @returns {string[] | null} freshly swept dirs, or null when no walk
     *   was owed: this session's is spent, or the list it missed inside was
     *   swept by the `get()` that served it
     */
    refreshFor(homeDir, sessionId, cached) {
      const hit = byHome.get(homeDir)
      if (!cached) {
        if (hit && !hit.moved) remember(hit, sessionId)
        return null
      }
      if (hit?.swept.has(sessionId)) return null
      const { entry, unchanged } = sweep(homeDir, hit)
      if (unchanged) remember(entry, sessionId)
      return entry.dirs
    },
  }
}

/**
 * Whether two sweeps of the same container named the same dirs. The walk
 * visits the roots in a fixed order, so element-wise is enough; a reordered
 * listing reads as a change, which only costs a sweep.
 *
 * @param {string[]} a
 * @param {string[]} b
 */
function sameDirs(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Shared instance for the live path; keyed by home dir, so one is enough. */
const desktop3pDirsCache = createDesktop3pDirsCache()

/**
 * @param {string} dir
 * @param {number} depth
 * @param {string[]} out
 */
function collectNestedProjectsDirs(dir, depth, out) {
  if (depth > DESKTOP_3P_SCAN_DEPTH) return
  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = path.join(dir, entry.name)
    if (entry.name === '.claude') {
      const projects = path.join(child, 'projects')
      if (fs.existsSync(projects)) out.push(projects)
      continue
    }
    collectNestedProjectsDirs(child, depth + 1, out)
  }
}

/**
 * Load the transcript entries for one session.
 *
 * Lookup order:
 *  - When `transcriptPath` is provided (e.g. straight off the
 *    session-context state file), read THAT file plus the subagent
 *    files under its sibling session directory. Cheap and direct,
 *    no projects-wide walk.
 *  - With no `transcriptPath`, or when reading it yielded nothing (a
 *    stale or dead path), scan `<projectsDir>/**\/<sessionId>.jsonl`
 *    (which also descends into `<sessionId>/` directories for subagent
 *    files) and concatenate matching files.
 *  - When that scan finds nothing and `homeDir` is provided, scan the
 *    Desktop 3p sandbox trees ({@link findDesktop3pProjectsDirs}):
 *    an attached Desktop writes its transcripts there, not under
 *    `~/.claude/projects`, and without this fallback every Desktop
 *    exchange lost transcript identity and its `entrypoint` column.
 *
 * @param {{
 *   projectsDir: string,
 *   sessionId: string,
 *   transcriptPath?: string,
 *   homeDir?: string,
 * }} opts
 * @param {typeof readTranscriptFile} [readFile]  per-file reader; the
 *   incremental loader (`createTranscriptLoader`) injects one that
 *   serves cached entries and parses only appended bytes, reusing this
 *   function's file resolution unchanged
 * @returns {Promise<TranscriptEntry[]>}
 */
export async function loadTranscript(opts, readFile = readTranscriptFile) {
  /** @type {TranscriptEntry[]} */
  const entries = []
  if (opts.transcriptPath) {
    await readFile(opts.transcriptPath, entries)
    // Subagent transcripts live next to the session file in a directory
    // named for the session, not inside it: without this walk every
    // sidechain message misses transcript identity and lands as a
    // gateway-fallback row that later duplicates against the backfill.
    const sessionDir = path.join(
      path.dirname(opts.transcriptPath),
      path.basename(opts.transcriptPath, '.jsonl')
    )
    for (const filePath of walkJsonlFiles(sessionDir, undefined)) {
      await readFile(filePath, entries)
    }
  }
  // A hook-written `transcript_path` can be stale or dead (the file is gone,
  // or was never written where it said), and a read of nothing must not end
  // the lookup: the session would hold gateway-fallback identity for good. A
  // direct read that yielded entries never reaches here, so the fast path
  // stays one file read.
  if (entries.length === 0) {
    for (const filePath of walkJsonlFiles(opts.projectsDir, opts.sessionId)) {
      await readFile(filePath, entries)
    }
    // The 3p roots are only scanned on a primary miss: a session lives in
    // exactly one tree, and the common CLI case must not pay the extra
    // container walk. Root discovery is TTL-cached: for an attached Desktop
    // every exchange is a primary miss, and the uncached sweep re-walked
    // the whole container per exchange.
    if (entries.length === 0 && opts.homeDir) {
      const { dirs, cached } = desktop3pDirsCache.get(opts.homeDir)
      await readSessionFromDirs(dirs, opts.sessionId, entries, readFile)
      // A new sandbox home appears exactly when a session starts, so a
      // cached list cannot contain the newest session's root: the session
      // it appeared for gets one forced re-sweep to find it, spent once per
      // session per container list. Whether the dirs just missed inside were
      // cached is `refreshFor`'s to weigh rather than a gate here: a list it
      // saw swept costs no second walk.
      if (entries.length === 0) {
        const refreshed = desktop3pDirsCache.refreshFor(opts.homeDir, opts.sessionId, cached)
        if (refreshed) await readSessionFromDirs(refreshed, opts.sessionId, entries, readFile)
      }
    }
  }
  entries.sort(byTimestampAsc)
  return entries
}

/**
 * Read `<sessionId>` transcript files under each projects dir into
 * `entries`, stopping at the first dir that matches (a session lives in
 * exactly one sandbox home).
 *
 * @param {string[]} projectsDirs
 * @param {string} sessionId
 * @param {TranscriptEntry[]} entries
 * @param {typeof readTranscriptFile} readFile
 */
async function readSessionFromDirs(projectsDirs, sessionId, entries, readFile) {
  for (const projectsDir of projectsDirs) {
    for (const filePath of walkJsonlFiles(projectsDir, sessionId)) {
      await readFile(filePath, entries)
    }
    if (entries.length > 0) return
  }
}

/**
 * Walk every Claude JSONL transcript under the given roots in order
 * (the shared projects dir plus any Desktop 3p sandbox trees), yielding
 * absolute file paths. `loadTranscript()` targets one live session; the
 * backfill provider needs the full local history, so this exposes the
 * same recursive scan without a session-id filter. A missing root
 * yields nothing, so callers can pass the 3p dirs unconditionally.
 *
 * @param {string[]} roots
 * @returns {Generator<string>}
 */
export function* walkTranscriptRoots(roots) {
  for (const root of roots) {
    yield* walkJsonlFiles(root, undefined)
  }
}

/**
 * Read the subagent metadata sidecars Claude Code writes beside each
 * subagent transcript: `<sessionDir>/subagents/agent-<agentId>.meta.json`.
 * The sidecar's `toolUseId` is the parent-thread `Agent`/`Task` tool call
 * that spawned the subagent: provenance that lives in neither the
 * subagent's own `.jsonl` (its first line has null parent/source uuids)
 * nor the wire exchange. Returns a map keyed by the agent id parsed from
 * each filename.
 *
 * A `transcriptPath` roots the walk at just that session's directory
 * (cheap: the live path). When that directory is not there at all the
 * path is stale, and the same two fallbacks `loadTranscript` uses recover
 * the session's real directory: a `sessionId` scan of `projectsDir`, then
 * a sweep of the Desktop 3p sandbox roots under `homeDir`, where an
 * attached Desktop's sessions live instead of under `~/.claude/projects`.
 * A row whose transcript identity either fallback recovered therefore also
 * carries its `spawned_by_tool_use_id`. A named directory that does exist
 * ends the lookup even when it holds no sidecar: that is a session whose
 * sidecar is simply not written, and neither fallback can find one for it
 * either, so it must not pay a projects-wide walk per exchange. With no
 * `transcriptPath` at all, `projectsDir` is scanned recursively for every
 * session's sidecars (the backfill path). Best-effort: a missing
 * directory or an unparseable sidecar is skipped, never thrown.
 *
 * @param {{ transcriptPath?: string, projectsDir?: string, sessionId?: string, homeDir?: string }} opts
 * @returns {Map<string, { tool_use_id: string }>}
 */
export function loadAgentMeta(opts) {
  /** @type {Map<string, { tool_use_id: string }>} */
  const meta = new Map()
  const rootDir = opts.transcriptPath
    ? path.join(path.dirname(opts.transcriptPath), path.basename(opts.transcriptPath, '.jsonl'))
    : opts.projectsDir
  if (rootDir) collectAgentMeta(rootDir, meta)
  // Only a `transcriptPath` whose session directory is not there at all is
  // stale: fall through to the session-id scans `loadTranscript` uses, whose
  // session directory is where the sidecars are. An empty map alone is not
  // the signal. A live session that has simply written no sidecar yet is the
  // common sidechain case, and gating on the map would make every one of its
  // exchanges walk the whole projects tree, a cost that grows with the user's
  // history.
  if (
    meta.size === 0 && opts.transcriptPath && opts.sessionId &&
    rootDir && !fs.existsSync(rootDir)
  ) {
    /** @type {Set<string>} */
    const seen = new Set()
    let located = opts.projectsDir
      ? collectSessionAgentMeta([opts.projectsDir], opts.sessionId, meta, seen)
      : false
    // An attached Desktop runs each conversation in a sandbox home inside its
    // own container, so a session the scan above cannot find is not missing,
    // just somewhere `projectsDir` does not reach. It is the session being
    // unfound that says so, not the map being empty: a session the scan
    // located owns its sidecars whether or not it has written any yet, so
    // gating on the map would sweep the container on every spawn under such a
    // session, at a cost that grows with the conversations the container
    // holds, and would let the container answer for a session the projects
    // tree already found. Ordered and guarded like `loadTranscript`'s
    // matching leg, sharing its TTL-cached root discovery and its one forced
    // re-sweep.
    if (meta.size === 0 && !located && opts.homeDir) {
      const { dirs, cached } = desktop3pDirsCache.get(opts.homeDir)
      if (collectSessionAgentMeta(dirs, opts.sessionId, meta, seen)) located = true
      // A sandbox home appears exactly when its session starts, so a cached
      // list can be one short: ask for one more sweep when the session was in
      // none of the dirs scanned, which `refreshFor` spends only on a list it
      // did not just sweep itself. It is the session being nowhere, not the
      // map being empty, that says the list may be stale. An empty map is the
      // standing state of a located session whose sidecar is simply not
      // written, and an attached Desktop's hook-written path never resolves on
      // the host, so re-sweeping on the map would put a whole-container walk
      // on every one of that conversation's exchanges.
      if (meta.size === 0 && !located) {
        const refreshed = desktop3pDirsCache.refreshFor(opts.homeDir, opts.sessionId, cached)
        if (refreshed) collectSessionAgentMeta(refreshed, opts.sessionId, meta, seen)
      }
    }
  }
  return meta
}

/**
 * Parse the sidecars of `<sessionId>`'s session directory under each projects
 * dir into `meta`, stopping at the first dir that yields one (a session lives
 * in exactly one directory). The sidecar mirror of {@link readSessionFromDirs}:
 * the same session-id scan, resolved to directories rather than read as
 * transcripts. `seen` carries across calls so a directory two legs both reach
 * is walked once.
 *
 * @param {string[]} projectsDirs
 * @param {string} sessionId
 * @param {Map<string, { tool_use_id: string }>} meta
 * @param {Set<string>} seen
 * @returns {boolean} whether the session was found at all, sidecar or not:
 *   what tells a caller its dir list was complete, the way a non-empty
 *   `entries` tells `loadTranscript`'s
 */
function collectSessionAgentMeta(projectsDirs, sessionId, meta, seen) {
  let located = false
  for (const projectsDir of projectsDirs) {
    for (const filePath of walkJsonlFiles(projectsDir, sessionId)) {
      located = true
      // Sidecars live in the session file's sibling `<sessionId>/` directory,
      // and beside a subagent transcript already inside it (all the scan
      // yields when the session file itself is gone). The scan yields one
      // file per subagent, so those resolve to the same directory: walk and
      // parse each one once.
      const dir = path.basename(filePath, '.jsonl') === sessionId
        ? path.join(path.dirname(filePath), sessionId)
        : path.dirname(filePath)
      if (seen.has(dir)) continue
      seen.add(dir)
      collectAgentMeta(dir, meta)
      if (meta.size > 0) return true
    }
    // A session lives in exactly one dir, so the dir that held it answers for
    // it even with no sidecar in it: walking on would both cost the rest of
    // the container and let another dir under the same session id answer
    // instead. The same stop `readSessionFromDirs` makes on its first match.
    if (located) return true
  }
  return located
}

/**
 * Parse every agent-meta sidecar under `rootDir` into `meta`, keyed by
 * agent id. Best-effort: an unreadable or unparseable sidecar is skipped.
 *
 * @param {string} rootDir
 * @param {Map<string, { tool_use_id: string }>} meta
 */
function collectAgentMeta(rootDir, meta) {
  for (const { agentId, filePath } of walkAgentMetaFiles(rootDir)) {
    let parsed
    try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { continue }
    if (!isPlainObject(parsed)) continue
    const toolUseId = stringValue(parsed.toolUseId)
    if (toolUseId) meta.set(agentId, { tool_use_id: toolUseId })
  }
}

/**
 * Yield `{ agentId, filePath }` for every `agent-<id>.meta.json` sidecar
 * under `dir`, recursing into subdirectories (the sidecars live in
 * `<sessionDir>/subagents/`). The agent id is parsed from the filename.
 *
 * @param {string} dir
 * @returns {Generator<{ agentId: string, filePath: string }>}
 */
function* walkAgentMetaFiles(dir) {
  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkAgentMetaFiles(filePath)
    } else if (entry.isFile()) {
      const match = /^agent-(.+)\.meta\.json$/.exec(entry.name)
      if (match) yield { agentId: match[1], filePath }
    }
  }
}

/**
 * Load and timestamp-sort the entries in a single transcript file.
 * Best-effort like `loadTranscript`: a missing or truncated file
 * yields whatever parsed cleanly. The backfill provider walks files
 * directly (one file per session) rather than resolving a session id.
 *
 * @param {string} filePath
 * @returns {Promise<TranscriptEntry[]>}
 */
export async function loadTranscriptFile(filePath) {
  /** @type {TranscriptEntry[]} */
  const entries = []
  await readTranscriptFile(filePath, entries)
  entries.sort(byTimestampAsc)
  return entries
}

/**
 * @param {TranscriptEntry} a
 * @param {TranscriptEntry} b
 */
function byTimestampAsc(a, b) {
  return (a.timestampMs ?? Number.POSITIVE_INFINITY) - (b.timestampMs ?? Number.POSITIVE_INFINITY)
}

/**
 * Index transcript entries for the projector's wire→line matching.
 *
 * // @ref LLP 0026#decision: one line per native DAG node: an API
 * // message spans SEVERAL lines (one per assistant block), so the
 * // message-id index must keep the ordered list, not last-wins.
 *
 *  - `byUuid`        : native uuid → entry.
 *  - `byMessageId`   : API `message.id` → ordered entry list (block
 *                      order; assistant turns split one line per block
 *                      all sharing the API id).
 *  - `byToolUseId`   : `tool_use_id` of a user tool_result line →
 *                      entry. Each tool_result is its own line, so
 *                      this is a unique join key.
 *  - `byToolCallId`  : assistant tool_use id → entry, independent of
 *                      whether the result has arrived yet.
 *  - `byContentKey`  : canonicalized role+content key → entry.
 *  - `previousUuid`  : uuid → the uuid of the line before it in the SAME
 *                      agent thread, built on first call because only a
 *                      settlement that re-scoped a row's `agent_id` reads it.
 *
 * @param {TranscriptEntry[]} entries
 */
export function indexTranscriptEntries(entries) {
  /** @type {Map<string, TranscriptEntry>} */
  const byUuid = new Map()
  /** @type {Map<string, TranscriptEntry>} */
  const byContentKey = new Map()
  /** @type {Map<string, TranscriptEntry[]>} */
  const byMessageId = new Map()
  /** @type {Map<string, TranscriptEntry>} */
  const byToolUseId = new Map()
  /** @type {Map<string, TranscriptEntry>} */
  const byToolCallId = new Map()
  for (const entry of entries) {
    if (entry.provider_uuid) byUuid.set(entry.provider_uuid, entry)
    if (entry.messageId) {
      const list = byMessageId.get(entry.messageId)
      if (list) list.push(entry)
      else byMessageId.set(entry.messageId, [entry])
    }
    if (entry.contentKey) byContentKey.set(agentScopedKey(entry.agent_id, entry.contentKey), entry)
    const toolUseId = entryToolUseId(entry)
    if (toolUseId) byToolUseId.set(toolUseId, entry)
    if (entry.role === 'assistant' && Array.isArray(entry.content)) {
      for (const block of entry.content) {
        if (!isPlainObject(block) || (block.type !== 'tool_use' && block.type !== 'server_tool_use')) continue
        const id = stringValue(block.id)
        if (id) byToolCallId.set(id, entry)
      }
    }
  }
  /** @type {Map<string, string> | undefined} */
  let previousByUuid
  return {
    byUuid,
    byContentKey,
    byMessageId,
    byToolUseId,
    byToolCallId,
    ordered: entries,
    /** @param {string} uuid @returns {string | undefined} */
    // @ref LLP 0439#lazy-predecessor-index [implements]: a settle pass that
    // re-scopes no row never pays for the map; one that does builds it once
    // per session.
    previousUuid(uuid) {
      previousByUuid ??= buildPreviousByUuid(entries)
      return previousByUuid.get(uuid)
    },
  }
}

/**
 * Map each uuid-bearing line to the uuid of the line before it in the SAME
 * agent thread, which is the predecessor the transcript backfill's own
 * expansion chains it to (the gateway keys its `previous_message_id` state by
 * `(thread, agent_id)`). `entries` is already timestamp-sorted, so one pass
 * carrying the last uuid per agent is enough. Roots are simply absent.
 *
 * @param {TranscriptEntry[]} entries
 * @returns {Map<string, string>}
 */
function buildPreviousByUuid(entries) {
  /** @type {Map<string, string>} */
  const previousByUuid = new Map()
  /** @type {Map<string, string>} */
  const lastByAgent = new Map()
  for (const entry of entries) {
    if (!entry.provider_uuid) continue
    const scope = entry.agent_id ?? ''
    const previous = lastByAgent.get(scope)
    if (previous !== undefined) previousByUuid.set(entry.provider_uuid, previous)
    lastByAgent.set(scope, entry.provider_uuid)
  }
  return previousByUuid
}

/**
 * Namespace a content key by agent so the main loop and each subagent
 * occupy separate key-spaces. A session's transcript holds the main
 * loop AND every subagent, and content can repeat across them; without
 * this a subagent block could match a main-session (or other-agent)
 * entry and inherit the wrong uuid / `is_sidechain`. `byMessageId` and
 * `byToolUseId` need no scoping: those ids are globally unique.
 * `agent_id` empty/undefined is the main loop; ids and content keys are
 * hex, so `:` is an unambiguous separator.
 *
 * // @ref LLP 0026#decision: match within a thread, not across the session.
 *
 * @param {string | undefined} agentId
 * @param {string} contentKey
 */
export function agentScopedKey(agentId, contentKey) {
  return `${agentId ?? ''}:${contentKey}`
}

/**
 * The `tool_use_id` answered by a user tool_result line, when the
 * entry is one. Claude Code writes one line per tool_result, so a
 * single id per entry is the invariant (the first one wins if a
 * legacy multi-result line ever shows up).
 *
 * @param {TranscriptEntry} entry
 */
function entryToolUseId(entry) {
  if (entry.role !== 'user') return undefined
  const content = entry.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (isPlainObject(block) && block.type === 'tool_result') {
      const id = stringValue(block.tool_use_id)
      if (id) return id
    }
  }
  return undefined
}

/**
 * Find the transcript entry that matches one projected message by
 * canonical role+content key, with an optional `message.id` shortcut
 * that only applies when the id maps to exactly one line (an API
 * message split across several lines is ambiguous at message
 * granularity: the splitter aligns those per block instead).
 *
 * The content-key lookup is scoped to `candidate.agentId` (the
 * exchange's `x-claude-code-agent-id`, empty for the main loop) so a
 * block only matches entries from its own thread. The `message.id`
 * shortcut needs no scoping (API ids are globally unique).
 *
 * @param {ReturnType<typeof indexTranscriptEntries>} index
 * @param {{ role: string, content: unknown, messageId?: string, agentId?: string }} candidate
 */
export function findTranscriptMatch(index, candidate) {
  if (candidate.messageId) {
    const byId = index.byMessageId.get(candidate.messageId)
    if (byId && byId.length === 1) return byId[0]
  }
  return index.byContentKey.get(agentScopedKey(candidate.agentId, matchKey(candidate.role, candidate.content)))
}

/**
 * The canonical role+content lookup key for matching a wire message to
 * its transcript line. Exported so the projector can stamp it on a
 * fallback row at projection time (when wire content is in hand) and
 * flush-time settlement can re-match by pure lookup once the transcript
 * line lands: without reconstructing the lost content array.
 *
 * // @ref LLP 0027#decision: match-key at projection enables flush-time settlement.
 *
 * @param {string} role
 * @param {unknown} content
 */
export function matchKey(role, content) {
  return contentKey(role, normalizeContent(content))
}

/**
 * Copy a transcript line's native identity and provenance onto a target
 * object keyed by the canonical `ai_gateway_messages` field names. The
 * single source of truth shared by the live projector
 * (`applyTranscriptMatch`, target = projected message) and flush-time
 * settlement (target = a stored row). Sets `message_id`/`provider_uuid`
 * only when the entry has a native uuid; `previous_message_id` is left
 * to the gateway (full prior-message chain) so enriched and fallback
 * rows stay one shape.
 *
 * // @ref LLP 0027#decision: one identity-copy core for projection and settlement.
 *
 * @param {Record<string, unknown>} target
 * @param {TranscriptEntry} match
 */
export function assignTranscriptIdentity(target, match) {
  if (match.provider_uuid) {
    target.message_id = match.provider_uuid
    target.provider_uuid = match.provider_uuid
  }
  if (match.parent_uuid) target.parent_uuid = match.parent_uuid
  if (match.logical_parent_uuid) target.logical_parent_uuid = match.logical_parent_uuid
  if (match.source_tool_assistant_uuid) target.source_tool_assistant_uuid = match.source_tool_assistant_uuid
  if (match.request_id) target.request_id = match.request_id
  if (match.prompt_id) target.prompt_id = match.prompt_id
  if (match.provider_type) target.provider_type = match.provider_type
  if (match.provider_subtype) target.provider_subtype = match.provider_subtype
  if (match.entrypoint) target.entrypoint = match.entrypoint
  if (match.user_type) target.user_type = match.user_type
  if (match.permission_mode) target.permission_mode = match.permission_mode
  if (match.is_sidechain !== undefined) target.is_sidechain = match.is_sidechain
  if (match.agent_id) target.agent_id = match.agent_id
  if (match.attachment_type) target.attachment_type = match.attachment_type
  if (match.hook_event) target.hook_event = match.hook_event
  if (match.is_compact_summary !== undefined) target.is_compact_summary = match.is_compact_summary
  if (match.compact_metadata !== undefined) target.compact_metadata = match.compact_metadata
  const rawFrame = minimizedRawFrame(match)
  if (rawFrame) target.raw_frame = rawFrame
}

/**
 * Minimized native frame: enough to trace a row back to its Claude
 * transcript line (native uuids, type/subtype, timestamp) without
 * copying the full transcript or any prompt / response content. Per the
 * bead contract: store a minimized, redacted native frame, never the
 * raw line. Applied by {@link assignTranscriptIdentity}, so live
 * capture, flush-time settlement, and backfill all store the same
 * minimized shape.
 *
 * @param {TranscriptEntry} entry
 * @returns {JsonObject | undefined}
 */
export function minimizedRawFrame(entry) {
  /** @type {JsonObject} */
  const frame = {}
  if (entry.provider_uuid) frame.uuid = entry.provider_uuid
  if (entry.parent_uuid) frame.parent_uuid = entry.parent_uuid
  if (entry.logical_parent_uuid) frame.logical_parent_uuid = entry.logical_parent_uuid
  if (entry.provider_type) frame.type = entry.provider_type
  if (entry.provider_subtype) frame.subtype = entry.provider_subtype
  if (entry.messageId) frame.message_id = entry.messageId
  if (entry.timestampMs !== undefined) frame.timestamp = new Date(entry.timestampMs).toISOString()
  return Object.keys(frame).length > 0 ? frame : undefined
}

/**
 * Merge the transcript line's structured tool result into
 * `attributes.claude.tool_use_result`. Claude Code writes
 * `toolUseResult` only to the transcript (never the wire), and
 * transcripts are pruned after `cleanupPeriodDays`, so promoting it
 * onto the row is what preserves structured tool metadata
 * (structuredPatch, filePath, interrupted, subagent descriptors) past
 * pruning. Stored verbatim: a per-tool trim list would be one more
 * hand-maintained drift list, and the text that duplicates the block's
 * own tool_result content compresses away in Parquet.
 *
 * @param {unknown} attributes  existing message/row attributes (plain object or undefined)
 * @param {TranscriptEntry} entry
 * @returns {unknown} the attributes with the tool result merged in;
 *   the input untouched when the entry carries none
 */
export function withToolUseResult(attributes, entry) {
  if (entry.tool_use_result === undefined) return attributes
  const base = isPlainObject(attributes) ? attributes : {}
  const claude = isPlainObject(base.claude) ? base.claude : {}
  return { ...base, claude: { ...claude, tool_use_result: entry.tool_use_result } }
}

/**
 * The block type a single transcript line holds: used by the
 * splitter's order-alignment sanity check. String content is a text
 * line; array content reports the first block's type (lines are
 * single-block in current transcripts).
 *
 * @param {TranscriptEntry} entry
 */
export function entryBlockType(entry) {
  const content = entry.content
  if (typeof content === 'string') return 'text'
  if (Array.isArray(content) && isPlainObject(content[0])) {
    return stringValue(content[0].type) ?? 'text'
  }
  return undefined
}

/**
 * @param {string} dir
 * @param {string | undefined} sessionId  match `<sessionId>.jsonl`; when
 *   undefined, match every `.jsonl` file (full backfill scan)
 * @returns {Generator<string>}
 */
function* walkJsonlFiles(dir, sessionId) {
  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // A directory named for the session holds per-session files the
      // CLI splits out of the main transcript (subagents/agent-*.jsonl).
      // Everything under it belongs to the session, so drop the filter.
      yield* walkJsonlFiles(filePath, entry.name === sessionId ? undefined : sessionId)
    } else if (entry.isFile() && matchesTranscriptName(entry.name, sessionId)) {
      yield filePath
    }
  }
}

/**
 * @param {string} name
 * @param {string | undefined} sessionId
 */
function matchesTranscriptName(name, sessionId) {
  if (sessionId === undefined) return name.endsWith('.jsonl')
  return name === `${sessionId}.jsonl`
}

/**
 * @param {string} filePath
 * @param {TranscriptEntry[]} entries
 * @returns {Promise<void>}
 */
async function readTranscriptFile(filePath, entries) {
  /** @type {fs.ReadStream} */
  let stream
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  } catch {
    return
  }
  stream.on('error', () => {})
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const entry = transcriptEntryFromRow(row)
      if (entry) entries.push(entry)
    }
  } catch { /* truncated/rotated file → best-effort */ }
}

/**
 * Parse one transcript line's already-JSON-parsed row into an entry.
 * Exported for the incremental loader, which does its own line
 * splitting (byte offsets) but must produce identical entries.
 *
 * @param {unknown} row
 * @returns {TranscriptEntry | undefined}
 */
export function transcriptEntryFromRow(row) {
  if (!isPlainObject(row)) return undefined
  const sessionId = stringValue(row.sessionId)
  if (!sessionId) return undefined
  const message = isPlainObject(row.message) ? row.message : undefined
  const role = stringValue(readKey(message, 'role')) ??
    (row.type === 'user' || row.type === 'assistant' ? /** @type {string} */ (row.type) : undefined)
  const content = readKey(message, 'content')
  const attachment = isPlainObject(row.attachment) ? row.attachment : undefined
  /** @type {TranscriptEntry} */
  const entry = {
    sessionId,
    role,
    content,
    cwd: stringValue(row.cwd),
    timestampMs: timestampMs(row.timestamp),
    messageId: stringValue(readKey(message, 'id')) ?? stringValue(row.messageId),
    contentKey: role ? contentKey(role, normalizeContent(content)) : undefined,
    provider_uuid: stringValue(row.uuid),
    parent_uuid: stringValue(row.parentUuid) ?? stringValue(row.parent_uuid),
    logical_parent_uuid: stringValue(row.logicalParentUuid) ?? stringValue(row.logical_parent_uuid),
    source_tool_assistant_uuid: stringValue(row.sourceToolAssistantUUID) ?? stringValue(row.source_tool_assistant_uuid),
    request_id: stringValue(row.requestId) ?? stringValue(row.request_id),
    prompt_id: stringValue(row.promptId) ?? stringValue(row.prompt_id),
    provider_type: stringValue(row.type),
    provider_subtype: stringValue(row.subtype),
    model: transcriptModel(message),
    entrypoint: stringValue(row.entrypoint),
    client_version: stringValue(row.version) ?? stringValue(row.claude_version),
    user_type: stringValue(row.userType) ?? stringValue(row.user_type),
    permission_mode: stringValue(row.permissionMode) ?? stringValue(row.permission_mode),
    is_sidechain: typeof row.isSidechain === 'boolean' ? row.isSidechain : undefined,
    agent_id: stringValue(row.agentId) ?? stringValue(row.agent_id),
    attachment_type: stringValue(readKey(attachment, 'type')),
    hook_event: stringValue(readKey(attachment, 'hookEvent')) ?? stringValue(row.hookEvent),
    is_compact_summary: typeof row.isCompactSummary === 'boolean' ? row.isCompactSummary : undefined,
    compact_metadata: readKey(row, 'compactMetadata') ?? readKey(row, 'compact_metadata'),
    // Claude Code writes the API `usage` block onto assistant transcript lines;
    // backfill surfaces it as attributes.usage to match live capture.
    usage: readKey(message, 'usage'),
    tool_use_result: readKey(row, 'toolUseResult'),
  }
  if (!entry.messageId && !entry.contentKey && !entry.provider_uuid) return undefined
  return entry
}

/**
 * Role+content lookup key for matching a wire message to its
 * transcript entry. The two representations of the same block are not
 * byte-identical: the wire side carries `cache_control` (prompt-cache
 * breakpoints, absent from transcripts and moving between exchanges)
 * and the transcript side annotates tool_use blocks with `caller`
 * (absent on the wire). The canonical strip list
 * (`VOLATILE_BLOCK_FIELDS` in core util) is shared with the
 * ai-gateway's fallback message id, so the key compares what the block
 * says, not which channel it came from.
 *
 * @param {string} role
 * @param {unknown} content
 */
function contentKey(role, content) {
  return sha256Hex(`${role}:${canonicalJson(stripVolatileBlockFields(content))}`)
}

/** @param {unknown} content */
function normalizeContent(content) {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) return content
  return []
}

/** @param {unknown} obj @param {string} key */
function readKey(obj, key) {
  if (!isPlainObject(obj)) return undefined
  return /** @type {Record<string, unknown>} */ (obj)[key]
}

/**
 * The model id from an assistant transcript line's `message.model`.
 *
 * @ref LLP 0026#decision [implements]: native per-line granularity: each
 * assistant line carries its own model, so backfill surfaces it per message
 * rather than collapsing a session to one model. Only assistant lines record
 * `message.model`; user-prompt and tool_result lines have none. Claude Code
 * stamps `<synthetic>` on assistant lines it generates locally (interrupt
 * notices, injected errors) that never hit a model: that is a sentinel, not a
 * model id, so it is dropped to undefined.
 * @param {unknown} message
 */
function transcriptModel(message) {
  const model = stringValue(readKey(message, 'model'))
  return model === '<synthetic>' ? undefined : model
}

/** @param {unknown} value */
function timestampMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}
