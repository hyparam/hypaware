// @ts-check

import fsp from 'node:fs/promises'

import {
  assignTranscriptIdentity,
  defaultClaudeProjectsDir,
  DESKTOP_3P_CONTAINER_OWNER,
  findDesktop3pProjectsDirs,
  loadAgentMeta,
  loadTranscriptFile,
  walkTranscriptRoots,
  withToolUseResult,
} from './transcripts.js'
import { createSessionContextReader, pickLatestMatching } from './session_context.js'
import { deriveRepoFromCwd } from './git_repo.js'
import { anthropicMessageAttributes } from './anthropic.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import {
  AI_GATEWAY_MESSAGES_DATASET,
  errMessage,
  filterByWindow,
  projectedExchangeItem,
  resolveWindow,
} from '../../../../src/core/backfill/scan_util.js'
import {
  classifyContainerSession,
  classifyTranscriptEntrypoint,
  sessionEntrypoint,
} from '../../../../src/core/backfill/entrypoint_owner.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillContribution, BackfillItem, BackfillRunContext, JsonObject } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { SessionContextRecord, TranscriptEntry } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * `@hypaware/claude` backfill provider.
 *
 * Imports local Claude Code history into `ai_gateway_messages` by
 * reading the on-disk JSONL transcripts the CLI writes under
 * `<homeDir>/.claude/projects/**\/<session-id>.jsonl`, joining the
 * session-context channel (`<stateDir>/session-context.jsonl`) for
 * `cwd` / `git_branch`, and projecting each session into an
 * `AiGatewayProjectedExchange`. The `@hypaware/ai-gateway`
 * `ai_gateway.projected_exchange` materializer expands those into the
 * same canonical rows live capture produces, so backfilled and live
 * rows are identical for the same conversation.
 *
 * Native DAG identity is preserved verbatim (the gateway never
 * recomputes ids when the projector supplies them):
 *   - `uuid`       -> `message_id` / `provider_uuid`
 *   - `parentUuid` -> `parent_uuid`
 * `previous_message_id` is NOT supplied here; the gateway expansion
 * always fills it with the full prior-message-id chain, the same
 * shape live capture rows get.
 * Reruns are deterministic: ids, parents, and timestamps come straight
 * from the immutable transcript, and the materializer is pure.
 */

const DEFAULT_CLIENT_NAME = 'claude'
const DEFAULT_PLUGIN_NAME = '@hypaware/claude'
export const DEFAULT_SWEEP_CRON = '*/5 * * * *'

/**
 * Build the Claude backfill provider. Registered at plugin activation
 * via `ctx.backfills.register(...)`. The provider closes over the
 * resolved transcript root and session-context state file so `run()`
 * needs only the kernel-supplied `BackfillRunContext`.
 *
 * @param {{
 *   homeDir: string,
 *   stateFile: string,
 *   projectsDir?: string,
 *   clientName?: string,
 *   pluginName?: string,
 *   deriveRepo?: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   config?: JsonObject,
 * }} opts
 * @returns {BackfillContribution}
 */
export function createClaudeBackfillProvider(opts) {
  const clientName = opts.clientName ?? DEFAULT_CLIENT_NAME
  const pluginName = opts.pluginName ?? DEFAULT_PLUGIN_NAME
  const projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir(opts.homeDir)
  const stateFile = opts.stateFile
  const config = opts.config
  /** @type {Map<string, { ino: number, size: number, mtimeMs: number }>} */
  const sweepFingerprints = new Map()
  // @ref LLP 0032#capture: pre-0032 Claude sessions carry no captured remote;
  // recover it by running git in the session's cwd at backfill time. Injectable
  // so tests stub the git lookup and stay hermetic.
  const deriveRepo = opts.deriveRepo ?? deriveRepoFromCwd
  // One resolver per backfill run (LLP 0050): the per-cwd cache reflects disk at
  // run time and is shared across the whole scan. Injectable for hermetic tests.
  // @ref LLP 0050 [implements]: skip ignored sessions at the capture seam.
  // @ref LLP 0103 [implements]: the machine-local list is the resolver's second
  // source, so `hyp backfill` skips `--private` (`ignore`) dirs, never re-importing
  // sessions a live capture already dropped.
  const resolver = opts.resolver ?? createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })

  return {
    name: clientName,
    plugin: pluginName,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local Claude Code and Claude Desktop transcripts into ai_gateway_messages',
    // @ref LLP 0358#scheduled-sweep [implements]: the existing Claude
    // transcript provider opts into the daemon sweep, with a plugin-owned
    // cadence and no second parser or capture lane
    // @ref LLP 0041#consent-gating [constrained-by]: `backfill.on_join: false` is
    // the operator's suppression of automatic history import, and the sweep is
    // automatic history import. Contributing no `sweep` field is what the sweep
    // driver reads as 'never tick this provider', so the opt-out keeps meaning
    // what it meant before there was a schedule.
    ...(sweepEnabled(config) ? { sweep: { cron: resolveSweepCron(config) } } : {}),
    async *run(ctx) {
      // Resolved per run, not at activation: attached-Desktop sessions
      // accumulate new sandbox homes under the 3p container between runs
      // (see findDesktop3pProjectsDirs), and each holds its own nested
      // `.claude/projects` tree outside the primary projectsDir.
      const desktop3pDirs = findDesktop3pProjectsDirs(opts.homeDir)
      yield* runClaudeBackfill({
        ctx,
        projectsDir,
        extraProjectsDirs: desktop3pDirs,
        stateFile,
        clientName,
        deriveRepo,
        resolver,
        sweepFingerprints,
      })
    },
  }
}

/**
 * Whether this plugin entry wants the daemon to rerun its import on a
 * schedule. Reuses the kernel's single reader of the `backfill` policy block
 * rather than re-parsing `on_join` here, so the scheduled lane and the
 * join-time reconciler can never disagree about what an opt-out means.
 *
 * @param {JsonObject | undefined} config
 * @returns {boolean}
 */
function sweepEnabled(config) {
  return readBackfillPolicy({ name: DEFAULT_PLUGIN_NAME, config }).onJoin !== false
}

/**
 * @param {JsonObject | undefined} config
 * @returns {string}
 */
function resolveSweepCron(config) {
  const backfill = config?.backfill
  if (!backfill || typeof backfill !== 'object' || Array.isArray(backfill)) {
    return DEFAULT_SWEEP_CRON
  }
  const cron = backfill.sweep_cron
  return typeof cron === 'string' ? cron : DEFAULT_SWEEP_CRON
}

/**
 * Walk the transcript root, project each session, and yield one
 * `ai_gateway.projected_exchange` item per session. One item per
 * session keeps the materializer's per-call dedup state whole, so a
 * conversation's `previous_message_id` chain is never split across
 * items.
 *
 * @param {{
 *   ctx: BackfillRunContext,
 *   projectsDir: string,
 *   extraProjectsDirs?: string[],
 *   stateFile: string,
 *   clientName: string,
 *   deriveRepo: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   resolver: UsagePolicyResolver,
 *   sweepFingerprints: Map<string, { ino: number, size: number, mtimeMs: number }>,
 * }} args
 * @returns {AsyncGenerator<BackfillItem>}
 */
async function* runClaudeBackfill(args) {
  const { ctx, projectsDir, extraProjectsDirs, stateFile, clientName, deriveRepo, resolver, sweepFingerprints } = args
  const log = ctx.log
  const window = resolveWindow(ctx)
  // Many sessions share a cwd (the same repo, often the same checkout), and
  // each derivation shells git; memoize per cwd so a backfill over thousands of
  // sessions runs one git probe per distinct directory, not per session.
  /** @type {Map<string, Promise<{ git_remote?: string, repo_root?: string }>>} */
  const repoByCwd = new Map()
  /** @param {string | undefined} cwd */
  const deriveRepoCached = (cwd) => {
    if (!cwd) return Promise.resolve({})
    let pending = repoByCwd.get(cwd)
    if (!pending) {
      pending = deriveRepo(cwd)
      repoByCwd.set(cwd, pending)
    }
    return pending
  }

  log.info('claude.backfill.scan_started', {
    component: 'plugin.claude.backfill',
    operation: 'backfill.scan',
    projects_dir: projectsDir,
    desktop_3p_dirs: extraProjectsDirs?.length ?? 0,
    sweep: ctx.sweep === true,
    ...(window.sinceMs !== undefined ? { since: new Date(window.sinceMs).toISOString() } : {}),
    ...(window.untilMs !== undefined ? { until: new Date(window.untilMs).toISOString() } : {}),
    status: 'ok',
  })

  let filesSeen = 0
  let filesRead = 0
  let filesUnchanged = 0
  let filesFailed = 0
  /** @type {Array<{ filePath: string, inContainer: boolean, fingerprint?: { ino: number, size: number, mtimeMs: number } }>} */
  const candidates = []
  const presentPaths = new Set()
  for (const found of walkRootsWithOrigin(projectsDir, extraProjectsDirs)) {
    if (presentPaths.has(found.filePath)) continue
    presentPaths.add(found.filePath)
    filesSeen += 1
    if (!ctx.sweep) {
      candidates.push(found)
      continue
    }
    let fingerprint
    try {
      fingerprint = await transcriptFingerprint(found.filePath)
    } catch {
      filesFailed += 1
      continue
    }
    if (sameFingerprint(sweepFingerprints.get(found.filePath), fingerprint)) {
      filesUnchanged += 1
      continue
    }
    candidates.push({ ...found, fingerprint })
  }
  if (ctx.sweep) {
    for (const filePath of sweepFingerprints.keys()) {
      if (!presentPaths.has(filePath)) sweepFingerprints.delete(filePath)
    }
  }

  // Degrades to [] on error so a missing or unreadable channel never
  // aborts the backfill: the join is best-effort and `cwd` /
  // `git_branch` are nullable columns.
  const sessionRecords = candidates.length === 0 ? [] : await createSessionContextReader(stateFile, (err) => {
    log.warn('claude.backfill.session_context_read_failed', {
      component: 'plugin.claude.backfill',
      operation: 'backfill.scan',
      state_file: stateFile,
      status: 'error',
      error_kind: 'session_context_read_failed',
      error: errMessage(err),
    })
  })()
  // Subagent → spawning tool call: one scan per transcript root builds
  // the agent-id → toolUseId map from the `agent-<id>.meta.json` sidecars,
  // so backfilled subagent rows carry the same `spawned_by_tool_use_id`
  // provenance live capture stamps. The Desktop 3p sandbox trees are
  // scanned too: their sidecars live beside their transcripts, and a
  // container session's subagent rows deserve the same provenance as any
  // other backfilled session. Agent ids are unique, so a plain merge is
  // safe; the primary tree wins a collision.
  const agentMeta = new Map()
  if (candidates.length > 0) {
    for (const [agentId, meta] of loadAgentMeta({ projectsDir })) agentMeta.set(agentId, meta)
    for (const extraDir of extraProjectsDirs ?? []) {
      for (const [agentId, meta] of loadAgentMeta({ projectsDir: extraDir })) {
        if (!agentMeta.has(agentId)) agentMeta.set(agentId, meta)
      }
    }
  }

  let sessionsProjected = 0
  let messagesProjected = 0
  let sessionsGated = 0
  /** @type {Map<string, number>} */
  const unclaimedEntrypoints = new Map()

  for (const { filePath, inContainer, fingerprint } of candidates) {
    if (ctx.signal?.aborted) break
    filesRead += 1
    // Read before this file yields anything, so the stamp below can tell a
    // written session from a consumed and dropped one.
    const failedBefore = ctx.itemsFailed ?? 0
    /** @type {TranscriptEntry[]} */
    let entries
    try {
      entries = await loadTranscriptFile(filePath)
    } catch (err) {
      log.warn('claude.backfill.transcript_read_failed', {
        component: 'plugin.claude.backfill',
        operation: 'backfill.scan',
        source_path: filePath,
        status: 'error',
        error_kind: 'transcript_read_failed',
        error: errMessage(err),
      })
      filesFailed += 1
      continue
    }

    for (const [sessionId, sessionEntries] of groupBySession(entries)) {
      const windowed = filterByWindow(sessionEntries, window)
      const record = pickLatestMatching(sessionRecords, { sessionId, transcriptPath: filePath })

      // @ref LLP 0050 [implements]: capture-seam drop for backfill. Skip an
      // ignored session BEFORE projecting/writing it, else `hyp backfill` would
      // silently re-import the exact sessions ignored live (LLP 0049#requirements
      // R1). The cwd precedence mirrors projectedExchangeFromEntries (the
      // hook-written record wins, else the first transcript line's cwd), so the
      // session is tested on the same cwd the row would have carried.
      const sessionCwd = record?.cwd ?? windowed.find((entry) => entry.cwd)?.cwd
      const sessionPolicy = sessionCwd ? resolver.resolve(sessionCwd) : null
      if (sessionPolicy?.class === 'ignore') {
        // A fail-safe clamp (declared token unimplemented) escalates to warn
        // so an operator can tell it from an intended ignore (R3 SHOULD).
        log[sessionPolicy.warn ? 'warn' : 'info']('claude.backfill.usage_policy_drop', {
          component: 'plugin.claude.backfill',
          operation: 'usage_policy_drop',
          session_id: sessionId,
          declared: sessionPolicy.declared,
          governed_by: sessionPolicy.governedBy,
          status: 'ok',
          ...(sessionPolicy.warn ? { warn: sessionPolicy.warn } : {}),
        })
        continue
      }

      // Claude Desktop writes its sessions into THIS transcript tree, tagged
      // `entrypoint: "claude-desktop"`. Importing them because they happen to
      // live under `~/.claude/projects` captures a client the user may never
      // have opted into, and files it under the wrong client. Read the
      // entrypoint from the whole session, not `windowed`: the field rides
      // most lines but the window could clip the ones that carry it.
      // A session from the 3p container is Desktop's by ROOT, whatever its
      // tag says: the value classifier fails open on an absent or drifted
      // value, which over a foreign container is the wrong direction.
      // Container admission takes the runner's plugin-list predicate, not
      // the owners map, so it works whether or not Desktop declares any
      // entrypoint value.
      // @ref LLP 0140#gate-before-projection [implements]: a session owned by an unconfigured client is skipped before projection, like the usage-policy drop above
      const entrypoint = sessionEntrypoint(sessionEntries)
      const owners = ctx.entrypointOwners ?? new Map()
      const owned = inContainer
        ? classifyContainerSession(DESKTOP_3P_CONTAINER_OWNER, ctx.isPluginConfigured)
        : classifyTranscriptEntrypoint(entrypoint, owners, clientName)
      if (!owned.import) {
        sessionsGated += 1
        log.info('claude.backfill.entrypoint_not_configured', {
          component: 'plugin.claude.backfill',
          operation: 'entrypoint_gate',
          session_id: sessionId,
          entrypoint,
          owner_client: owned.owner?.client,
          owner_plugin: owned.owner?.plugin,
          status: 'ok',
        })
        continue
      }
      // Unknown entrypoints fail open (see `classifyTranscriptEntrypoint`).
      // Collected per distinct value and reported once at scan_complete rather
      // than per session: a value no plugin claims is a property of the install,
      // not of each conversation, and per-session logging buried the two real
      // gate decisions under one line per transcript.
      if (entrypoint && !owned.owner) {
        unclaimedEntrypoints.set(entrypoint, (unclaimedEntrypoints.get(entrypoint) ?? 0) + 1)
      }

      const exchange = await projectedExchangeFromEntries({
        sessionId,
        entries: windowed,
        clientName: owned.clientName,
        record,
        agentMeta,
        deriveRepo: deriveRepoCached,
      })
      if (!exchange) continue

      sessionsProjected += 1
      messagesProjected += exchange.messages.length
      log.info('claude.backfill.session_projected', {
        component: 'plugin.claude.backfill',
        operation: 'backfill.project',
        session_id: sessionId,
        message_count: exchange.messages.length,
        status: 'ok',
      })

      yield projectedExchangeItem(exchange, {
        client_name: owned.clientName,
        source_path: filePath,
        native_id: sessionId,
      })
    }
    // The generator resumes here only after the runner has consumed every
    // session yielded from this file. A file that changed while it was read
    // retains the pre-read size/mtime and is therefore eligible next tick.
    //
    // Consumed is not written: the runner's non-throwing failure paths skip
    // the append and resume us anyway. They are misconfigurations an operator
    // repairs without restarting the daemon, and this map lives for the
    // process, so a stamp there would hide the file until a restart.
    // @ref LLP 0359#file-fingerprints [constrained-by]: the map is deliberately
    // not durable, so stamping a file nothing wrote hides it until a restart
    if (ctx.sweep && fingerprint && (ctx.itemsFailed ?? 0) === failedBefore) {
      sweepFingerprints.set(filePath, fingerprint)
    }
  }

  log.info('claude.backfill.scan_complete', {
    component: 'plugin.claude.backfill',
    operation: 'backfill.scan',
    files_seen: filesSeen,
    files_read: filesRead,
    files_unchanged: filesUnchanged,
    files_failed: filesFailed,
    sessions_projected: sessionsProjected,
    messages_projected: messagesProjected,
    // How many sessions the entrypoint gate held back, so a run that imports
    // less than expected says why in its own summary line rather than
    // requiring a log trawl.
    sessions_gated: sessionsGated,
    ...(unclaimedEntrypoints.size > 0
      ? {
        unclaimed_entrypoints: [...unclaimedEntrypoints]
          .map(([value, count]) => `${value}=${count}`)
          .join(','),
      }
      : {}),
    status: 'ok',
  })
}

/** @param {string} filePath */
async function transcriptFingerprint(filePath) {
  const stat = await fsp.stat(filePath)
  return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}

/**
 * @param {{ ino: number, size: number, mtimeMs: number } | undefined} a
 * @param {{ ino: number, size: number, mtimeMs: number }} b
 */
function sameFingerprint(a, b) {
  return !!a && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

/**
 * Walk the shared projects tree, then the Desktop 3p sandbox trees, tagging
 * each file with which kind of root it came from. The tag is what lets the
 * gate key admission on the root for container sessions
 * (`classifyContainerSession`) instead of on the entrypoint value inside
 * them, which fails open when absent or drifted.
 *
 * @param {string} projectsDir
 * @param {string[] | undefined} extraProjectsDirs
 * @returns {Generator<{ filePath: string, inContainer: boolean }>}
 */
function* walkRootsWithOrigin(projectsDir, extraProjectsDirs) {
  for (const filePath of walkTranscriptRoots([projectsDir])) yield { filePath, inContainer: false }
  for (const filePath of walkTranscriptRoots(extraProjectsDirs ?? [])) yield { filePath, inContainer: true }
}

/**
 * Group entries by native session id. A transcript file is named for
 * its session, but grouping on the entry stays correct even if a file
 * ever interleaves sessions. Insertion order follows the
 * timestamp-sorted entries.
 *
 * @param {TranscriptEntry[]} entries
 * @returns {Map<string, TranscriptEntry[]>}
 */
function groupBySession(entries) {
  /** @type {Map<string, TranscriptEntry[]>} */
  const bySession = new Map()
  for (const entry of entries) {
    const list = bySession.get(entry.sessionId)
    if (list) list.push(entry)
    else bySession.set(entry.sessionId, [entry])
  }
  return bySession
}

/**
 * Project one session's entries into an `AiGatewayProjectedExchange`.
 * Returns `undefined` when no entry carries a usable message (so the
 * provider skips empty sessions instead of yielding a no-row item).
 *
 * @param {{
 *   sessionId: string,
 *   entries: TranscriptEntry[],
 *   clientName: string,
 *   record: SessionContextRecord | undefined,
 *   agentMeta: Map<string, { tool_use_id: string }>,
 *   deriveRepo: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 * }} args
 * @returns {Promise<AiGatewayProjectedExchange | undefined>}
 */
async function projectedExchangeFromEntries(args) {
  const { sessionId, entries, clientName, record, agentMeta, deriveRepo } = args
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = []
  /** @type {string | undefined} */
  let clientVersion
  /** @type {number | undefined} */
  let startedAtMs
  /** @type {string | undefined} */
  let transcriptCwd
  // Usage is a response-level (per API message) figure that Claude Code
  // duplicates onto every block line of an assistant turn. Record the last
  // block line per API message id so usage is stamped on only that one block:
  // matching the live projector, so each response contributes usage to exactly
  // one row and live/backfill dedupe onto the same row. @ref LLP 0035#one-carrier
  /** @type {Map<string, number>} */
  const lastBlockIndexByMessageId = new Map()
  entries.forEach((entry, index) => {
    if (entry.messageId) lastBlockIndexByMessageId.set(entry.messageId, index)
  })
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    // Capture before the message filter: cwd rides every transcript line, not
    // only the ones that project to a message, and it's the only repo signal a
    // pre-0032 session carries.
    if (!transcriptCwd && entry.cwd) transcriptCwd = entry.cwd
    // A line with no API message id is its own single-block message → keep its
    // usage; otherwise only the last block of the message carries it.
    const stampUsage = !entry.messageId || lastBlockIndexByMessageId.get(entry.messageId) === index
    const message = projectedMessageFromEntry(entry, agentMeta, stampUsage)
    if (!message) continue
    messages.push(message)
    if (!clientVersion && entry.client_version) clientVersion = entry.client_version
    if (entry.timestampMs !== undefined && (startedAtMs === undefined || entry.timestampMs < startedAtMs)) {
      startedAtMs = entry.timestampMs
    }
  }
  if (messages.length === 0) return undefined

  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: 'anthropic',
    // @ref LLP 0030#decision: the Claude session id is the session_id
    // partition key; conversation_id is null (no per-thread id). Matches
    // live capture so backfilled and live rows still converge.
    session_id: sessionId,
    // Bead 2 contract: backfilled Claude history is tagged
    // conversation_source = client_name = 'claude'. Live capture derives
    // 'claude_code' / 'api' from the request User-Agent; backfill has no
    // request, and the materializer stamps attributes.gateway.source =
    // 'backfill', which already records the import origin.
    conversation_source: clientName,
    client_name: clientName,
    messages,
  }
  if (startedAtMs !== undefined) exchange.conversation_started_at = new Date(startedAtMs).toISOString()
  if (clientVersion) exchange.client_version = clientVersion
  // The hook-written record wins (it captured cwd in the live session); the
  // transcript line's cwd is the fallback for sessions whose record predates
  // cwd capture, so backfilled rows carry a cwd the join can key on.
  const cwd = record?.cwd ?? transcriptCwd
  if (cwd) exchange.cwd = cwd
  if (record?.git_branch) exchange.git_branch = record.git_branch
  // @ref LLP 0032#capture: repo identity rides the same hook-written
  // session-context record as cwd/git_branch; the live projector stamps these
  // too (projector.js), so backfilled and live Claude rows converge identically.
  // Unlike Codex, the Claude hook captures `git rev-parse --show-toplevel`, so
  // repo_root is a verified toplevel and File keys bridge safely.
  if (record?.git_remote) exchange.git_remote = record.git_remote
  if (record?.head_sha) exchange.head_sha = record.head_sha
  if (record?.repo_root) exchange.repo_root = record.repo_root
  // @ref LLP 0032#capture: sessions recorded before the hook captured git
  // identity have a record with no remote; recover it by running git in the
  // recovered cwd. Only when the record didn't already supply a remote, and
  // never head_sha: current HEAD ≠ the session's HEAD (git_repo.js).
  if (cwd && !exchange.git_remote) {
    const derived = await deriveRepo(cwd)
    if (derived.git_remote) exchange.git_remote = derived.git_remote
    if (derived.repo_root && !exchange.repo_root) exchange.repo_root = derived.repo_root
  }
  return exchange
}

/**
 * Project one transcript entry into an `AiGatewayProjectedMessage`.
 * Identity and provenance come from `assignTranscriptIdentity`: the
 * same single-source field copy the live projector applies on a
 * transcript match, so the two paths cannot drift. `role` / `content`
 * come straight from the transcript frame, and this path additionally
 * stamps the per-line model, agent-spawn provenance, usage, and
 * timestamp the live wire capture recovers elsewhere.
 *
 * @param {TranscriptEntry} entry
 * @param {Map<string, { tool_use_id: string }>} agentMeta
 * @param {boolean} stampUsage  fold attributes.usage onto this block (true only
 *   for the last block of an API message, so usage lands once per response)
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function projectedMessageFromEntry(entry, agentMeta, stampUsage) {
  const role = entry.role
  if (!role) return undefined

  /** @type {AiGatewayProjectedMessage} */
  const message = {
    role,
    content: /** @type {any} */ (entry.content),
  }
  // Native id only: like the live projector, `previous_message_id` is
  // left to the gateway expansion, which fills the full prior-message
  // chain; the native DAG parent rides `parent_uuid`.
  assignTranscriptIdentity(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (message)), entry)
  // Per-message model: live capture sets one model per exchange, but a
  // backfilled session can switch models mid-stream, so stamp it per assistant
  // line and let the gateway prefer it over the exchange model.
  if (entry.model) message.model = entry.model
  if (entry.agent_id) {
    // Mirror live capture: a subagent row carries the parent-thread tool
    // call that spawned it, read from the agent's `.meta.json` sidecar.
    const spawnedByToolUseId = agentMeta.get(entry.agent_id)?.tool_use_id
    if (spawnedByToolUseId) {
      message.attributes = { claude: { spawned_by_tool_use_id: spawnedByToolUseId } }
    }
  }
  // Mirror live capture: fold the assistant turn's token usage into
  // attributes.usage (anthropic.js owns the cache_*_input_tokens →
  // cache_{read,write}_tokens normalization), but only on the last block of the
  // API message so usage lands once per response. Merged, not assigned, so a
  // subagent's `claude.spawned_by_tool_use_id` above survives. @ref LLP 0035#one-carrier
  const usageAttrs = stampUsage ? anthropicMessageAttributes(entry) : undefined
  if (usageAttrs) message.attributes = { ...(message.attributes ?? {}), ...usageAttrs }
  message.attributes = /** @type {any} */ (withToolUseResult(message.attributes, entry))
  if (entry.timestampMs !== undefined) message.message_created_at = new Date(entry.timestampMs).toISOString()
  return message
}
