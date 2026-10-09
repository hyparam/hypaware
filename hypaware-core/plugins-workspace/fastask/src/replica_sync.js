// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { canonicalOrigin } from '../../../../src/core/remote/builtin_remotes.js'
import { RETRY_BACKOFF_SECONDS, abortableSleep } from '../../../../src/core/util/backoff.js'
import { createWorkBudget } from '../../../../src/core/util/work_budget.js'
import { EDGE_COLUMNS, ID_RECIPE, NODE_COLUMNS, PROTOCOL, SCHEMA_VERSION, verifyManifest } from './contract.js'
import { IndexBuildError, MAX_INDEX_BYTES, assertManifestFits } from './index_builder.js'
import {
  REPLICA_FORMAT,
  createStaging,
  diskBytes,
  generationDirName,
  promoteStaging,
  pruneGenerations,
  pruneReplicas,
  readRecord,
  removeTree,
  replicaKey,
  replicaPaths,
  writeRecord,
} from './replica_store.js'
import { checkSnapshot, deriveSnapshotEndpoint, downloadFile } from './snapshot_client.js'

/**
 * @import { PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ReplicaPassResult, ReplicaRecord, ReplicaState, ReplicaStatus, ReplicaSyncHooks, ReplicaTarget, SnapshotAnswer } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

/** A manifest whose two files together exceed this is refused (`replica_too_large`). */
export const MAX_REPLICA_BYTES = 1024 ** 3
/** Deadline of one manifest check. */
export const CHECK_TIMEOUT_MS = 30_000
/** Deadline of one data file download (a 50 MB file at a slow 100 KB/s fits). */
export const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
/** Poll clamp, seconds (LLP 0480#sync step 1). */
export const MIN_POLL_SECONDS = 300
export const MAX_POLL_SECONDS = 6 * 3600
/** Cadence before any manifest has said otherwise: the server's own defaults. */
const DEFAULT_POLL = Object.freeze({ interval_seconds: 900, jitter_seconds: 300 })
const FILE_NAMES = /** @type {const} */ (['nodes', 'edges'])
const COMPONENT = 'fastask'
const PLUGIN = '@hypaware/fastask'

/**
 * The team graph replica sync loop (LLP 0480#sync). One instance owns every
 * replica write for this process. Each pass resolves the default remote's
 * login, checks the manifest conditionally, downloads and verifies a new
 * generation into staging, and activates it with renames and an atomic
 * record write, so the previous generation stays active through any failure.
 * The loop then sleeps for the manifest's poll interval with jitter, the
 * server's `retry-after`, or the backoff ladder.
 *
 * Registers nothing: the daemon wiring (LLP 0481 T8) constructs it inside the
 * replica source, fills the activation hooks with the index build and swap,
 * and starts and stops it.
 *
 * `hyp leave` is deliberately not observed: the replica belongs to the query
 * login, which leave keeps.
 *
 * @ref LLP 0480#sync [implements]: conditional check, interpretation table, streamed download, verify, atomic activation, lease and cadence
 * @ref LLP 0482#decision [implements]: nothing here reads central enrollment, so leave never touches the replica
 * @param {{
 *   stateDir: string,
 *   resolveTarget: () => Promise<ReplicaTarget | null>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   random?: () => number,
 *   log?: PluginLogger,
 *   hooks?: ReplicaSyncHooks,
 *   maxReplicaBytes?: number,
 *   maxIndexBytes?: number,
 *   budget?: { sliceMs?: number, sliceRows?: number, duty?: number },
 *   createWriteStream?: typeof fs.createWriteStream,
 * }} opts
 */
export function createReplicaSync(opts) {
  const {
    stateDir,
    resolveTarget,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    random = Math.random,
    log = SILENT,
    hooks = {},
    maxReplicaBytes = MAX_REPLICA_BYTES,
    maxIndexBytes = MAX_INDEX_BYTES,
    budget = {},
    createWriteStream,
  } = opts

  const stop = new AbortController()
  /** @type {Promise<ReplicaPassResult> | null} */
  let inFlight = null
  /** @type {ReplicaRecord | null} */
  let record = null
  /** @type {{ state: ReplicaState, reason: string | null }} */
  let outcome = { state: 'unavailable', reason: 'not_checked' }
  let failures = 0
  let bytesOnDisk = 0
  let loop = /** @type {Promise<void> | null} */ (null)
  /** @type {(() => void) | null} */
  let wake = null

  /**
   * One pass, coalesced: a call while a pass runs returns that pass.
   *
   * @returns {Promise<ReplicaPassResult>}
   */
  function syncOnce() {
    if (inFlight) return inFlight
    inFlight = runPass()
      .then(async (result) => {
        // Inside the coalesced pass, so a refresh resolves only once the
        // caller's follow-up (the index build) has seen the new state.
        await hooks.afterPass?.(result.status)
        return result
      })
      .finally(() => { inFlight = null })
    return inFlight
  }

  /**
   * A manual refresh (`graph replica refresh`, a reconnect): run a pass now,
   * or join the one already running, and restart the loop's wait from it.
   */
  function refresh() {
    const pass = syncOnce()
    wake?.()
    return pass
  }

  function start() {
    if (loop) return loop
    loop = (async () => {
      while (!stop.signal.aborted) {
        let delayMs
        try {
          delayMs = (await syncOnce()).delayMs
        } catch (err) {
          if (stop.signal.aborted) break
          // A pass that throws is a defect, not a server answer; keep the loop
          // alive on the ladder rather than dying silently.
          log.error('replica sync pass failed', { error: messageOf(err) })
          delayMs = ladderMs(++failures)
        }
        await sleepOrWake(delayMs).catch(() => {})
      }
    })()
    return loop
  }

  /** @param {number} ms */
  function sleepOrWake(ms) {
    const early = new AbortController()
    wake = () => early.abort()
    return abortableSleep(ms, AbortSignal.any([stop.signal, early.signal])).finally(() => { wake = null })
  }

  /** Stops the loop and any pass in flight; staging is removed by the pass's own cleanup. */
  async function close() {
    stop.abort(new Error('replica sync stopped'))
    await Promise.allSettled([inFlight, loop])
  }

  /** @returns {ReplicaStatus} */
  function status() {
    return describe(record, outcome, bytesOnDisk, inFlight !== null, now(), stateDir)
  }

  /** @returns {Promise<ReplicaPassResult>} */
  async function runPass() {
    stop.signal.throwIfAborted()
    const target = await resolveTarget()
    if (!target) {
      for (const key of await pruneReplicas(stateDir, null)) await deleted('target_removed', key)
      record = null
      outcome = { state: 'unavailable', reason: 'no_login' }
      bytesOnDisk = 0
      return finish(DEFAULT_POLL)
    }
    const origin = canonicalOrigin(target.url)
    if (origin === null) {
      record = null
      outcome = { state: 'unavailable', reason: 'bad_target_url' }
      return finish(DEFAULT_POLL)
    }

    // The key carries the login's org when the credential records one. A
    // static or env token keys on the origin alone, and an org change shows
    // up in the next manifest instead (handled below).
    const key = replicaKey(origin, target.org)
    for (const stale of await pruneReplicas(stateDir, key)) await deleted('key_changed', stale)
    const paths = replicaPaths(stateDir, key)
    await removeTree(paths.staging)

    record = await loadRecord(paths, target, origin, key)
    const endpoint = deriveSnapshotEndpoint(target.url)

    if (record.generation !== null && leaseExpired(record, now())) {
      await dropGenerations(paths, 'lease_expired')
      setOutcome('expired', 'lease_expired')
    }

    // Generation ids are unique only per org, so a token swapped to another
    // org could match If-None-Match and keep renewing the old org's replica.
    // The record keeps a fingerprint of the credential that last renewed the
    // lease; a different one gets one unconditional check, and its answer
    // decides.
    // @ref LLP 0483#credential-change [implements]: a changed credential (token, or OIDC session id) omits If-None-Match once; another org is a key change
    const credential = await credentialFingerprint(target)
    const credentialChanged = credential !== null && record.generation !== null && record.credential_fp !== credential
    const ctx = { target, endpoint, paths, credential, credentialChanged }

    const pass = await withSpan('replica.check', {
      [Attr.COMPONENT]: COMPONENT, [Attr.OPERATION]: 'replica.check', [Attr.PLUGIN]: PLUGIN,
    }, async (span) => {
      const conditional = credentialChanged ? null : record?.generation ?? null
      const answer = await checkSnapshot({ target, endpoint, generation: conditional, fetchImpl, signal: deadline(CHECK_TIMEOUT_MS) })
      span.setAttribute('answer', answerLabel(answer))
      const result = await interpret(answer, ctx)
      span.setAttribute('state', outcome.state)
      return result
    })
    return pass
  }

  /**
   * Applies one check answer (server LLP 0554#responses) to the replica.
   *
   * @param {SnapshotAnswer} answer
   * @param {{ target: ReplicaTarget, endpoint: string, paths: ReturnType<typeof replicaPaths>, credential: string | null, credentialChanged: boolean }} ctx
   * @returns {Promise<ReplicaPassResult>}
   */
  async function interpret(answer, ctx) {
    const rec = /** @type {ReplicaRecord} */ (record)
    const checkedAt = new Date(now()).toISOString()
    rec.last_check = checkedAt

    if (answer.kind === 'not_modified') {
      renewLease(rec, answer.leaseSeconds, null, ctx.credential)
      return succeeded('synced', null)
    }
    if (answer.kind === 'manifest') {
      return acceptManifest(answer.manifest, answer.leaseSeconds, ctx, 0)
    }
    if (answer.kind === 'credential') {
      return failed('credential', null, 'credential', undefined)
    }
    if (answer.kind === 'network') {
      return failed('outage', null, 'network', undefined)
    }

    const { status, code, retryAfterSeconds } = answer
    if (status === 401) return failed('credential', status, code ?? 'unauthorized', undefined)
    if (status === 403 && code === 'snapshot_access_withdrawn') {
      // @ref LLP 0480#replica [implements]: a withdrawal deletes the replica immediately
      await dropGenerations(ctx.paths, 'withdrawn')
      return settled('withdrawn', 'withdrawn', status, code, DEFAULT_POLL)
    }
    if (status === 400 && code === 'unsupported_protocol') return settled('unsupported', 'protocol', status, code, pollOf(rec))
    if (status === 404 && code === 'graph_snapshots_disabled') return settled('unavailable', 'disabled', status, code, pollOf(rec))
    if (status === 404) return settled('unsupported', 'server_too_old', status, code ?? 'unknown_path', pollOf(rec))
    if (status === 400) return settled('unsupported', code ?? 'bad_request', status, code, pollOf(rec))
    if (status === 503 && code === 'snapshot_pending') return failed('pending', status, code, retryAfterSeconds)
    // 403 without the withdrawal code, 429, 5xx and anything unexpected: an
    // answer that is not a withdrawal is never treated as one.
    return failed(status === 403 ? 'credential' : 'outage', status, code ?? `http_${status}`, retryAfterSeconds)
  }

  /**
   * A `200` manifest: renew the lease, then download and activate a new
   * generation. A `410` on a data file restarts from the manifest once per pass.
   *
   * @param {any} manifest
   * @param {number | null} leaseSeconds
   * @param {{ target: ReplicaTarget, endpoint: string, paths: ReturnType<typeof replicaPaths>, credential: string | null, credentialChanged: boolean }} ctx
   * @param {number} restarts
   * @returns {Promise<ReplicaPassResult>}
   */
  async function acceptManifest(manifest, leaseSeconds, ctx, restarts) {
    const rec = /** @type {ReplicaRecord} */ (record)
    // Only an answer that confirms what this client serves renews the lease:
    // a 304 or a 200 naming the active generation, or the activation of a new
    // one. A generation this client cannot activate leaves the old one
    // serving only until the lease of the last renewing answer ends, so rows
    // the server has since purged or withdrawn cannot linger for ever.
    // @ref LLP 0483#lease-renewal [implements]: unsupported, unverifiable, refused or too large generations never renew the lease
    const formatProblem = manifestProblem(manifest)
    if (formatProblem) {
      return settled('unsupported', 'format', 200, formatProblem, pollOf(rec))
    }
    const sameOrg = typeof manifest.org === 'string' && manifest.org === rec.org
    const keyChanged = (typeof manifest.org === 'string' && rec.org !== null && !sameOrg) ||
      (ctx.credentialChanged && !(sameOrg && manifest.generation === rec.generation))
    if (keyChanged && rec.generation !== null) {
      // A swapped static or env token now speaks for another org, or cannot
      // show that what is held is still its org's: treat it as a new key.
      await dropGenerations(ctx.paths, 'key_changed')
    }
    if (typeof manifest.org === 'string') rec.org = manifest.org
    rec.poll = pollFrom(manifest)

    if (manifest.generation === rec.generation) {
      renewLease(rec, leaseSeconds, manifest, ctx.credential)
      return succeeded('synced', null)
    }

    const total = Number(manifest.files.nodes.bytes) + Number(manifest.files.edges.bytes)
    if (!(total <= maxReplicaBytes) || !indexFits(manifest)) {
      return settled(rec.generation ? 'stale' : 'unavailable', 'replica_too_large', 200, 'replica_too_large', pollOf(rec))
    }

    const staged = await createStaging(ctx.paths.staging)
    try {
      for (const name of FILE_NAMES) {
        const outcome = await withSpan('replica.download', {
          [Attr.COMPONENT]: COMPONENT, [Attr.OPERATION]: 'replica.download', [Attr.PLUGIN]: PLUGIN,
          file: name, bytes: manifest.files[name].bytes,
        }, () => downloadFile({
          target: ctx.target,
          url: `${ctx.endpoint}/${manifest.files[name].path}`,
          dest: path.join(staged, `${name}.ndjson.gz`),
          expectedBytes: manifest.files[name].bytes,
          fetchImpl,
          signal: deadline(DOWNLOAD_TIMEOUT_MS),
          createWriteStream,
        }))
        if (outcome.ok) continue
        await removeTree(staged)
        if (outcome.status === 410 && restarts === 0) {
          const again = await checkSnapshot({ target: ctx.target, endpoint: ctx.endpoint, generation: null, fetchImpl, signal: deadline(CHECK_TIMEOUT_MS) })
          if (again.kind === 'manifest') return acceptManifest(again.manifest, again.leaseSeconds, ctx, restarts + 1)
          return interpret(again, ctx)
        }
        if (outcome.status === 401 || outcome.code === 'credential') return failed('credential', outcome.status, outcome.code, undefined)
        if (outcome.status === 403 && outcome.code === 'snapshot_access_withdrawn') return interpret({ kind: 'refused', status: 403, code: outcome.code, retryAfterSeconds: undefined }, ctx)
        return failed(outcome.code === 'disk_full' ? 'disk_full' : 'outage', outcome.status, outcome.code, outcome.retryAfterSeconds)
      }

      const verified = await withSpan('replica.verify', {
        [Attr.COMPONENT]: COMPONENT, [Attr.OPERATION]: 'replica.verify', [Attr.PLUGIN]: PLUGIN,
      }, () => verifyStaged(staged, manifest))
      if (!verified.ok) {
        log.warn('replica download failed verification', { generation: manifest.generation, problems: verified.problems.slice(0, 5) })
        await removeTree(staged)
        return failed('verify_failed', 200, 'verify_failed', undefined)
      }
      await fs.promises.writeFile(path.join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })

      await hooks.beforeActivate?.(staged, manifest)
      await activate(ctx.paths, staged, manifest, (next) => renewLease(next, leaseSeconds, manifest, ctx.credential))
      return succeeded('synced', null)
    } catch (err) {
      await removeTree(staged)
      if (stop.signal.aborted) throw err
      log.warn('replica activation failed', { generation: manifest.generation, error: messageOf(err) })
      return failed('activate_failed', null, 'activate_failed', undefined)
    }
  }

  /**
   * Whether the index of this generation fits, judged from the manifest's
   * row counts before anything is downloaded.
   *
   * @ref LLP 0484#build-memory [implements]: a graph whose index would not fit is refused before download
   * @param {any} manifest
   */
  function indexFits(manifest) {
    try {
      assertManifestFits(manifest, maxIndexBytes)
      return true
    } catch (err) {
      if (err instanceof IndexBuildError && err.code === 'replica_too_large') {
        log.info('replica refused before download: index would not fit', { generation: manifest.generation })
        return false
      }
      throw err
    }
  }

  /**
   * Moves the verified staging directory into place, records it as active,
   * lets the caller swap its index, then deletes the previous generation.
   *
   * @param {ReturnType<typeof replicaPaths>} paths
   * @param {string} staged
   * @param {any} manifest
   * @param {(next: ReplicaRecord) => void} renew applied to the record before its commit write: activation is a renewing answer
   */
  async function activate(paths, staged, manifest, renew) {
    const rec = /** @type {ReplicaRecord} */ (record)
    const dirName = generationDirName(manifest.generation)
    await withSpan('replica.activate', {
      [Attr.COMPONENT]: COMPONENT, [Attr.OPERATION]: 'replica.activate', [Attr.PLUGIN]: PLUGIN,
      rows_nodes: manifest.files.nodes.rows, rows_edges: manifest.files.edges.rows,
    }, async () => {
      await promoteStaging(staged, paths.generation(manifest.generation))
      /** @type {ReplicaRecord} */
      const next = {
        ...rec,
        generation: manifest.generation,
        watermark: manifest.projection?.watermark ?? null,
        watermark_kind: manifest.projection?.watermark_kind ?? null,
        published_at: manifest.published_at ?? null,
        rows: { nodes: manifest.files.nodes.rows, edges: manifest.files.edges.rows },
      }
      renew(next)
      // The record write is the commit point: before it the old generation is
      // active (the promoted directory is pruned as unreferenced next pass),
      // after it the new one is.
      await writeRecord(paths.record, next)
      Object.assign(rec, next)
      try {
        await hooks.afterActivate?.(paths.generation(manifest.generation), manifest)
      } catch (err) {
        log.warn('replica afterActivate hook failed', { generation: manifest.generation, error: messageOf(err) })
      }
      await pruneGenerations(paths.generations, dirName)
    })
  }

  /**
   * Verifies the staged files with the ported reference verifier, reading
   * from disk under the cooperative budget so a large generation shares the
   * process with capture and queries.
   *
   * @param {string} staged
   * @param {any} manifest
   */
  async function verifyStaged(staged, manifest) {
    const work = createWorkBudget({ ...budget, signal: stop.signal })
    /** @param {string} name */
    async function* budgeted(name) {
      for await (const chunk of fs.createReadStream(path.join(staged, `${name}.ndjson.gz`), { highWaterMark: 64 * 1024 })) {
        const wait = work.tick(1)
        if (wait) await wait
        yield /** @type {Buffer} */ (chunk)
      }
    }
    return verifyManifest({ manifest, nodes: budgeted('nodes'), edges: budgeted('edges') })
  }

  /**
   * Deletes the replica's generations and staging; the record stays, with no
   * active generation, so status can still name the state and how old the
   * last data was.
   *
   * @param {ReturnType<typeof replicaPaths>} paths
   * @param {string} reason
   */
  async function dropGenerations(paths, reason) {
    const rec = /** @type {ReplicaRecord} */ (record)
    await withSpan('replica.delete', {
      [Attr.COMPONENT]: COMPONENT, [Attr.OPERATION]: 'replica.delete', [Attr.PLUGIN]: PLUGIN, reason,
    }, async () => {
      rec.generation = null
      await writeRecord(paths.record, rec)
      await removeTree(paths.generations)
      await removeTree(paths.staging)
    })
    await hooks.onDelete?.(reason)
  }

  /** @param {string} reason @param {string} key */
  async function deleted(reason, key) {
    await withSpan('replica.delete', {
      [Attr.COMPONENT]: COMPONENT, [Attr.OPERATION]: 'replica.delete', [Attr.PLUGIN]: PLUGIN, reason,
    }, async () => { log.info('replica deleted', { reason, key }) })
    await hooks.onDelete?.(reason)
  }

  /**
   * An authorized answer that leaves nothing to retry soon.
   *
   * @param {ReplicaState} state
   * @param {string | null} reason
   */
  function succeeded(state, reason) {
    const rec = /** @type {ReplicaRecord} */ (record)
    failures = 0
    rec.last_success = rec.last_check
    rec.last_error = null
    setOutcome(state, reason)
    return finish(pollOf(rec))
  }

  /**
   * A settled refusal: not an outage, so the normal cadence applies.
   *
   * @param {ReplicaState} state
   * @param {string} reason
   * @param {number} status
   * @param {string | null} code
   * @param {{ interval_seconds: number, jitter_seconds: number }} poll
   */
  function settled(state, reason, status, code, poll) {
    const rec = /** @type {ReplicaRecord} */ (record)
    failures = 0
    rec.last_error = { code: code ?? reason, status, at: /** @type {string} */ (rec.last_check) }
    // Once the lease has run out and nothing is held, the replica is expired
    // whatever the server says next; the reason keeps what it said.
    const keepExpired = state !== 'withdrawn' && rec.generation === null && outcome.state === 'expired'
    setOutcome(keepExpired ? 'expired' : state, reason)
    return finish(poll)
  }

  /**
   * A failure the next pass may cure: keep what is held, back off.
   *
   * @param {string} reason
   * @param {number | null} status
   * @param {string | null} code
   * @param {number | undefined} retryAfterSeconds
   */
  function failed(reason, status, code, retryAfterSeconds) {
    const rec = /** @type {ReplicaRecord} */ (record)
    failures++
    rec.last_error = { code: code ?? reason, status, at: /** @type {string} */ (rec.last_check) }
    const held = rec.generation !== null
    /** @type {ReplicaState} */
    // Nothing held after an expiry or a withdrawal stays named as such until a
    // check succeeds; an outage does not turn it back into "not available yet".
    const state = held ? 'stale' : outcome.state === 'expired' || outcome.state === 'withdrawn' ? outcome.state : 'unavailable'
    setOutcome(state, reason)
    // @ref LLP 0480#sync [implements]: retry-after on 429/503 overrides the interval; otherwise the shared ladder
    const delayMs = retryAfterSeconds !== undefined && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds, MAX_POLL_SECONDS) * 1000
      : ladderMs(failures)
    return finish(null, delayMs)
  }

  /**
   * @param {ReplicaState} state
   * @param {string | null} reason
   */
  function setOutcome(state, reason) {
    outcome = { state, reason }
    if (record) {
      record.state = state
      record.reason = reason
    }
  }

  /**
   * Persists the record and computes the next wait.
   *
   * @param {{ interval_seconds: number, jitter_seconds: number } | null} poll
   * @param {number} [delayMs]
   * @returns {Promise<ReplicaPassResult>}
   */
  async function finish(poll, delayMs) {
    if (record) {
      const paths = replicaPaths(stateDir, record.key)
      await writeRecord(paths.record, record)
      bytesOnDisk = await diskBytes(paths.dir)
    }
    const wait = delayMs ?? pollDelayMs(/** @type {{ interval_seconds: number, jitter_seconds: number }} */ (poll), random)
    return { status: describe(record, outcome, bytesOnDisk, false, now(), stateDir), delayMs: wait }
  }

  /** @param {number} ms */
  function deadline(ms) {
    return AbortSignal.any([stop.signal, AbortSignal.timeout(ms)])
  }

  /**
   * The record for this key, with an active generation only when its files
   * are actually there. Generations the record does not name (a crash after
   * a rename, before the record write) are removed.
   *
   * @param {ReturnType<typeof replicaPaths>} paths
   * @param {ReplicaTarget} target
   * @param {string} origin
   * @param {string} key
   * @returns {Promise<ReplicaRecord>}
   */
  async function loadRecord(paths, target, origin, key) {
    const rec = (await readRecord(paths.record)) ?? emptyRecord(target, origin, key)
    rec.target = target.target
    if (rec.generation !== null && !hasFiles(paths.generation(rec.generation))) rec.generation = null
    await pruneGenerations(paths.generations, rec.generation === null ? null : generationDirName(rec.generation))
    if (rec.generation === null && rec.state !== 'withdrawn' && rec.state !== 'expired') rec.state = 'unavailable'
    outcome = { state: rec.state, reason: rec.reason }
    return rec
  }

  return { syncOnce, refresh, start, close, status }
}

/**
 * The first 16 hex of SHA-256 over the credential's identity: enough to
 * notice a swapped login, never the token itself. A login-session access JWT
 * is re-minted every hour, so its stable identity is the session (`sid`
 * claim, read without verification: it only names, never authorizes); any
 * other bearer is its own identity. Null when no bearer resolves (the check
 * then reports the credential problem).
 *
 * @param {ReplicaTarget} target
 * @returns {Promise<string | null>}
 */
export async function credentialFingerprint(target) {
  try {
    const resolved = await target.token(false)
    if (!resolved.ok) return null
    const sid = sessionId(resolved.token)
    return createHash('sha256').update(sid === null ? resolved.token : `sid\0${sid}`).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/**
 * The `sid` claim of a JWT-shaped bearer, or null.
 *
 * @param {string} token
 * @returns {string | null}
 */
function sessionId(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return claims && typeof claims.sid === 'string' && claims.sid ? claims.sid : null
  } catch {
    return null
  }
}

/**
 * @param {ReplicaTarget} target
 * @param {string} origin
 * @param {string} key
 * @returns {ReplicaRecord}
 */
function emptyRecord(target, origin, key) {
  return {
    format: REPLICA_FORMAT,
    key,
    target: target.target,
    origin,
    org: target.org,
    generation: null,
    state: 'unavailable',
    reason: 'not_checked',
    watermark: null,
    watermark_kind: null,
    published_at: null,
    rows: null,
    lease_seconds: null,
    lease_expires_at: null,
    poll: null,
    credential_fp: null,
    last_check: null,
    last_success: null,
    last_error: null,
  }
}

/**
 * Renews the lease from an authorized answer. The header wins; a `200`
 * falls back to the manifest; a `304` without the header keeps the length
 * the server last announced. With none of these the lease is not renewed:
 * the client never invents one.
 *
 * @ref LLP 0480#sync [implements]: lease from hyp-snapshot-lease on 200 and 304, the client never invents a lease
 * @param {ReplicaRecord} rec
 * @param {number | null} headerSeconds
 * @param {any} manifest
 * @param {string | null} credential fingerprint of the credential this answer came through
 */
function renewLease(rec, headerSeconds, manifest, credential) {
  const fromManifest = Number.isSafeInteger(manifest?.lease?.duration_seconds) ? manifest.lease.duration_seconds : null
  const seconds = headerSeconds ?? fromManifest ?? rec.lease_seconds
  if (credential !== null) rec.credential_fp = credential
  if (seconds === null) return
  rec.lease_seconds = seconds
  rec.lease_expires_at = new Date(Date.parse(/** @type {string} */ (rec.last_check)) + seconds * 1000).toISOString()
}

/**
 * @param {ReplicaRecord} rec
 * @param {number} at
 */
function leaseExpired(rec, at) {
  return rec.lease_expires_at !== null && at >= Date.parse(rec.lease_expires_at)
}

/**
 * Why a manifest cannot be activated by this client, or null. Checked before
 * any download (LLP 0480#sync step 4).
 *
 * @param {any} manifest
 * @returns {string | null}
 */
export function manifestProblem(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'manifest_not_object'
  if (manifest.protocol !== PROTOCOL) return 'protocol'
  if (manifest.schema?.schema_version !== SCHEMA_VERSION) return 'schema_version'
  if (manifest.schema?.id_recipe !== ID_RECIPE) return 'id_recipe'
  if (!sameList(manifest.schema?.node_columns, NODE_COLUMNS) || !sameList(manifest.schema?.edge_columns, EDGE_COLUMNS)) return 'columns'
  if (typeof manifest.generation !== 'string' || manifest.generation === '') return 'generation'
  for (const name of FILE_NAMES) {
    const file = manifest.files?.[name]
    if (!file || file.path !== `generations/${manifest.generation}/${name}.ndjson.gz` || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return `files.${name}`
  }
  return null
}

/**
 * @param {unknown} actual
 * @param {ReadonlyArray<string>} expected
 */
function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => v === expected[i])
}

/** @param {any} manifest */
function pollFrom(manifest) {
  const interval = manifest?.poll?.interval_seconds
  const jitter = manifest?.poll?.jitter_seconds
  return {
    interval_seconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL.interval_seconds,
    jitter_seconds: Number.isFinite(jitter) && jitter >= 0 ? jitter : DEFAULT_POLL.jitter_seconds,
  }
}

/** @param {ReplicaRecord} rec */
function pollOf(rec) {
  return rec.poll ?? DEFAULT_POLL
}

/**
 * The server's cadence plus uniform jitter, clamped to [5 min, 6 h].
 *
 * @param {{ interval_seconds: number, jitter_seconds: number }} poll
 * @param {() => number} random
 */
export function pollDelayMs(poll, random) {
  const seconds = poll.interval_seconds + random() * poll.jitter_seconds
  return Math.min(Math.max(seconds, MIN_POLL_SECONDS), MAX_POLL_SECONDS) * 1000
}

/** @param {number} failures consecutive failures, from 1 */
function ladderMs(failures) {
  return RETRY_BACKOFF_SECONDS[Math.min(failures, RETRY_BACKOFF_SECONDS.length) - 1] * 1000
}

/** @param {string} dir */
function hasFiles(dir) {
  return FILE_NAMES.every((name) => fs.existsSync(path.join(dir, `${name}.ndjson.gz`))) && fs.existsSync(path.join(dir, 'manifest.json'))
}

/**
 * @param {ReplicaRecord | null} rec
 * @param {{ state: ReplicaState, reason: string | null }} outcome
 * @param {number} bytesOnDisk
 * @param {boolean} running
 * @param {number} at
 * @param {string} stateDir
 * @returns {ReplicaStatus}
 */
function describe(rec, outcome, bytesOnDisk, running, at, stateDir) {
  const expired = rec !== null && rec.generation !== null && leaseExpired(rec, at)
  const state = expired ? 'expired' : outcome.state
  const servable = rec !== null && rec.generation !== null && !expired && state !== 'withdrawn'
  const watermarkMs = rec?.watermark ? Date.parse(rec.watermark) : NaN
  return {
    state,
    reason: expired ? 'lease_expired' : outcome.reason,
    servable,
    target: rec?.target ?? null,
    origin: rec?.origin ?? null,
    org: rec?.org ?? null,
    generation: rec?.generation ?? null,
    watermark: rec?.watermark ?? null,
    watermark_age_s: Number.isNaN(watermarkMs) ? null : Math.max(0, Math.round((at - watermarkMs) / 1000)),
    published_at: rec?.published_at ?? null,
    last_check: rec?.last_check ?? null,
    last_success: rec?.last_success ?? null,
    lease_expires_at: rec?.lease_expires_at ?? null,
    bytes_on_disk: bytesOnDisk,
    rows: rec?.rows ?? null,
    refresh_in_progress: running,
    credential_fp: rec?.credential_fp ?? null,
    generation_dir: servable && rec?.generation ? replicaPaths(stateDir, rec.key).generation(rec.generation) : null,
  }
}

/** @param {SnapshotAnswer} answer */
function answerLabel(answer) {
  if (answer.kind === 'refused') return `${answer.status}${answer.code ? ` ${answer.code}` : ''}`
  if (answer.kind === 'not_modified') return '304'
  if (answer.kind === 'manifest') return '200'
  return answer.kind
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}

/** @type {PluginLogger} */
const SILENT = { debug() {}, info() {}, warn() {}, error() {} }
