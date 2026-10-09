// @ts-check

import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { isMisdirectedHost, listenAndResolve, requestUrlOf } from '../../../../src/core/otlp/server.js'
import { resolveConfigPath, resolveLayeredConfigFromDisk } from '../../../../src/core/runtime/boot.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'
import { drainRequestBody } from '../../../../src/core/util/reject_body.js'
import { discover } from './discovery.js'
import { createEvidenceForwarder } from './evidence_forwarder.js'
import { buildIndexFromSnapshot } from './index_builder.js'
import { createReplicaSync } from './replica_sync.js'
import { createDefaultTargetResolver } from './replica_target.js'
import { summaryLine } from './summary_line.js'

/**
 * @import { PluginActivationContext, SourceStatus, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { GraphIndex, ReplicaStatus, ReplicaTarget } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

export const SOURCE_NAME = 'team-graph-replica'
const PLUGIN = '@hypaware/fastask'
/** Control routes under the reserved `/_hypaware/` prefix, advertised in status details. */
export const DISCOVER_ROUTE = 'fastask/discover'
export const EVIDENCE_ROUTE = 'fastask/evidence'
/** `graph replica refresh`: start a check now, coalesced with any in flight. */
export const REFRESH_ROUTE = 'fastask/refresh'
/** The per-boot bearer, mode 0600, in the plugin state directory (the trust boundary). */
export const TOKEN_FILE = 'control-token'
/** A discover request is a question and a few paths. */
const DISCOVER_BODY_CAP = 64 * 1024
/** An evidence request carries at most 16 entries of at most 16 KiB (server LLP 0557). */
const EVIDENCE_BODY_CAP = 512 * 1024

/**
 * The `team-graph-replica` source. In the daemon's processing child it runs
 * the replica sync loop, builds the warm index from each verified generation
 * before that generation is activated (so a build that fails or is refused
 * leaves the old one active), swaps the index in, and releases the old one
 * before the old generation's files are deleted. A generation already active
 * at start, or one the index lost, is rebuilt after the next pass; one that
 * stops being servable (expired, withdrawn, removed) drops its index.
 *
 * It answers the command's warm path on a `127.0.0.1` listener: `discover`
 * from the in-memory index, and `evidence` forwarded over one kept-alive MCP
 * session per remote. Every request needs the per-boot bearer from a 0600
 * file in the state directory; misdirected `Host` headers and oversized
 * bodies are refused before any work. The bound port and route names are
 * advertised in status details, which is how a command finds them.
 *
 * `deps` lets tests supply the target, clock and network.
 *
 * @ref LLP 0480#index [implements]: the daemon builds, swaps and serves the warm index on a guarded loopback route with a per-boot token
 * @param {{
 *   resolveTarget?: (ctx: PluginActivationContext, seen: { config_path: string | null }) => Promise<ReplicaTarget | null>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   timeZone?: string,
 *   duty?: number,
 *   maxIndexBytes?: number,
 *   syncOpts?: Record<string, unknown>,
 * }} [deps]
 */
export function createReplicaSource(deps = {}) {
  /**
   * @param {PluginActivationContext} ctx
   * @returns {Promise<StartedSource>}
   */
  return async function startReplicaSource(ctx) {
    const now = deps.now ?? Date.now
    const stateDir = ctx.paths.stateDir
    const stop = new AbortController()
    // Where the default remote was last read from, shown in status so a
    // daemon reading another config than the user edits is visible.
    /** @type {{ config_path: string | null }} */
    const seen = { config_path: null }
    const resolveTarget = () => (deps.resolveTarget ?? resolveTargetFromDisk)(ctx, seen)
    const forwarder = createEvidenceForwarder({ fetchImpl: deps.fetchImpl })

    /** @type {{ generation: string, index: GraphIndex, buildMs: number } | null} */
    let active = null
    /** @type {{ generation: string, index: GraphIndex, buildMs: number } | null} */
    let staged = null
    /** @type {string | null} */
    let indexError = null

    /**
     * @param {string} dir a verified generation (or staging) directory
     * @param {any} manifest
     */
    async function build(dir, manifest) {
      return withSpan('replica.index', {
        [Attr.COMPONENT]: 'fastask', [Attr.OPERATION]: 'replica.index', [Attr.PLUGIN]: PLUGIN,
        rows: (manifest?.files?.nodes?.rows ?? 0) + (manifest?.files?.edges?.rows ?? 0),
      }, async (span) => {
        const started = performance.now()
        const index = await buildIndexFromSnapshot({
          manifest,
          nodes: fs.createReadStream(path.join(dir, 'nodes.ndjson.gz')),
          edges: fs.createReadStream(path.join(dir, 'edges.ndjson.gz')),
          signal: stop.signal,
          ...(deps.duty !== undefined ? { duty: deps.duty } : {}),
          ...(deps.maxIndexBytes !== undefined ? { maxBytes: deps.maxIndexBytes } : {}),
        })
        const buildMs = Math.round(performance.now() - started)
        span.setAttribute('ms', buildMs)
        span.setAttribute('bytes', index.bytes)
        return { generation: manifest.generation, index, buildMs }
      }, { component: 'fastask' })
    }

    const sync = createReplicaSync({
      stateDir,
      resolveTarget,
      log: ctx.log,
      now,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.maxIndexBytes !== undefined ? { maxIndexBytes: deps.maxIndexBytes } : {}),
      ...deps.syncOpts,
      hooks: {
        // LLP 0480#sync step 6: the index is built before activation, so a
        // failed or refused build keeps the old generation active.
        async beforeActivate(dir, manifest) {
          staged = await build(dir, manifest)
        },
        async afterActivate(dir, manifest) {
          if (staged?.generation === manifest.generation) {
            // Swap, and drop the old index before the old files go.
            active = staged
            staged = null
            indexError = null
          }
        },
        onDelete() {
          active = null
          staged = null
        },
        async afterPass(status) {
          await alignIndex(status)
        },
      },
    })

    /**
     * Keeps the in-memory index on the generation that is servable now: built
     * at start for a generation already on disk, dropped when it stops being
     * servable.
     *
     * @param {ReplicaStatus} status
     */
    async function alignIndex(status) {
      if (!status.servable || !status.generation_dir) {
        active = null
        return
      }
      if (active?.generation === status.generation) return
      try {
        const manifest = JSON.parse(await fs.promises.readFile(path.join(status.generation_dir, 'manifest.json'), 'utf8'))
        active = await build(status.generation_dir, manifest)
        indexError = null
      } catch (err) {
        if (stop.signal.aborted) return
        active = null
        indexError = messageOf(err)
        ctx.log.warn('fastask.index_failed', { generation: status.generation, error: indexError })
      }
    }

    /** The index for the generation that may be served right now, or null. */
    function servable() {
      const status = sync.status()
      if (!status.servable || !active || active.generation !== status.generation) return null
      return { status, index: active.index }
    }

    // A fresh bearer per boot, readable only by this user.
    await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o700 })
    const token = randomBytes(32).toString('hex')
    const tokenPath = path.join(stateDir, TOKEN_FILE)
    await atomicWriteFile(tokenPath, token, { mode: 0o600, fsync: true })
    const expected = Buffer.from(`Bearer ${token}`)

    /** @type {Set<Promise<void>>} */
    const inFlight = new Set()
    const server = http.createServer((req, res) => {
      const work = handle(req, res).catch((err) => {
        ctx.log.warn('fastask.control_failed', { error: messageOf(err) })
        send(res, 500, { error: 'internal' })
      })
      inFlight.add(work)
      void work.finally(() => inFlight.delete(work))
    })

    /**
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     */
    async function handle(req, res) {
      if (isMisdirectedHost(req, { name: PLUGIN, log: ctx.log })) return reject(req, res, 421, 'misdirected_request')
      const url = requestUrlOf(req)
      if (!url) return reject(req, res, 400, 'invalid_request')
      const route = url.pathname === `/_hypaware/${DISCOVER_ROUTE}` ? DISCOVER_ROUTE
        : url.pathname === `/_hypaware/${EVIDENCE_ROUTE}` ? EVIDENCE_ROUTE
          : url.pathname === `/_hypaware/${REFRESH_ROUTE}` ? REFRESH_ROUTE : null
      if (!route) return reject(req, res, 404, 'not_found')
      if (!authorized(req.headers.authorization)) return reject(req, res, 401, 'unauthorized')
      if (req.method !== 'POST') return reject(req, res, 405, 'method_not_allowed')
      if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return reject(req, res, 415, 'content_type')
      }
      const body = await readJson(req, res, route === DISCOVER_ROUTE ? DISCOVER_BODY_CAP : EVIDENCE_BODY_CAP)
      if (body === undefined) return
      if (route === DISCOVER_ROUTE) return answerDiscover(res, body)
      if (route === REFRESH_ROUTE) {
        // @ref LLP 0480#sync [implements]: graph replica refresh starts a pass now, coalesced with any check in flight; the command does not wait for it
        void sync.refresh().catch(() => {})
        return send(res, 202, { accepted: true, replica: replicaView(sync.status()) })
      }
      return answerEvidence(res, body)
    }

    /**
     * @param {http.ServerResponse} res
     * @param {any} body
     */
    function answerDiscover(res, body) {
      if (typeof body?.question !== 'string') return send(res, 400, { error: 'invalid_request', message: 'question must be a string' })
      if (!validScope(body.scope)) return send(res, 400, { error: 'invalid_request', message: 'scope (target, origin, org, credential_fp) is required' })
      const ready = servable()
      if (!ready) return send(res, 503, { error: 'replica_unavailable', replica: replicaView(sync.status()) })
      const mismatch = scopeMismatch(body.scope, ready.status)
      if (mismatch) return send(res, 409, { error: 'scope_mismatch', reason: mismatch })
      const result = discover(ready.index, {
        question: body.question,
        repo: typeof body.repo === 'string' ? body.repo : null,
        repoRoot: typeof body.repoRoot === 'string' ? body.repoRoot : null,
        files: Array.isArray(body.files) ? body.files.filter((/** @type {unknown} */ f) => typeof f === 'string') : [],
        ...(Number.isInteger(body.leads) ? { leads: body.leads } : {}),
      })
      send(res, 200, { source: 'team_replica', replica: replicaView(ready.status), result })
    }

    /**
     * @param {http.ServerResponse} res
     * @param {any} body
     */
    async function answerEvidence(res, body) {
      if (!body || typeof body.arguments !== 'object' || body.arguments === null || Array.isArray(body.arguments)) {
        return send(res, 400, { error: 'invalid_request', message: 'arguments must be an object' })
      }
      if (!validScope(body.scope)) return send(res, 400, { error: 'invalid_request', message: 'scope (target, origin, org, credential_fp) is required' })
      const target = await resolveTarget()
      if (!target) return send(res, 409, { error: 'no_remote' })
      // The evidence goes to the daemon's current target, so the caller's
      // scope must match both that target and the replica it was confirmed for.
      const mismatch = body.scope.target !== target.target ? 'remote' : scopeMismatch(body.scope, sync.status())
      if (mismatch) return send(res, 409, { error: 'scope_mismatch', reason: mismatch })
      // The command's abort travels here as a closed connection; it aborts
      // the upstream request, and the server sees the disconnect.
      const caller = new AbortController()
      res.on('close', () => { if (!res.writableFinished) caller.abort(new Error('caller went away')) })
      try {
        const out = await forwarder.forward({ target, args: body.arguments, signal: AbortSignal.any([caller.signal, stop.signal]) })
        send(res, 200, out)
      } catch (err) {
        if (caller.signal.aborted || stop.signal.aborted) {
          res.destroy()
          return
        }
        throw err
      }
    }

    /** @param {string | undefined} header */
    function authorized(header) {
      if (typeof header !== 'string') return false
      const presented = Buffer.from(header)
      return presented.length === expected.length && timingSafeEqual(presented, expected)
    }

    const bound = await listenAndResolve(server, '127.0.0.1', 0, 'hypaware/fastask')
    void sync.start()
    ctx.log.info('fastask.source_started', { listen_port: bound.port })

    return {
      async status() {
        const r = sync.status()
        const line = summaryLine(r, { now: now(), ...(deps.timeZone ? { timeZone: deps.timeZone } : {}) })
        const troubled = r.state === 'stale' || r.state === 'expired' || r.state === 'withdrawn' || r.state === 'unsupported'
        /** @type {SourceStatus} */
        const status = {
          state: troubled || indexError ? 'degraded' : 'ready',
          message: line,
          ...(indexError ? { lastError: `team graph index failed: ${indexError}` } : {}),
          details: /** @type {any} */ ({
            ...replicaView(r),
            index_generation: active?.generation ?? null,
            index_bytes: active?.index.bytes ?? 0,
            index_build_ms: active?.buildMs ?? null,
            index_error: indexError,
            config_path: seen.config_path,
            summary_line: line,
            listen_host: bound.host,
            listen_port: bound.port,
            control_routes: [DISCOVER_ROUTE, EVIDENCE_ROUTE, REFRESH_ROUTE],
            evidence: forwarder.status(),
          }),
        }
        return status
      },
      async reload() {
        // The default remote or login may have changed: resolve it again now.
        // A pass already running may have read the old config before this
        // reload, so it is followed by one more.
        // @ref LLP 0480#replica [implements]: every reload re-resolves the default remote without a daemon restart (designer, 2026-10-09)
        const running = sync.status().refresh_in_progress
        void sync.refresh()
          .then(() => (running ? sync.refresh() : undefined))
          .catch(() => {})
      },
      async stop() {
        stop.abort(new Error('team graph replica source stopping'))
        await new Promise((resolve) => {
          server.close(() => resolve(undefined))
          server.closeAllConnections()
        })
        await Promise.allSettled([...inFlight])
        await sync.close()
        active = null
        staged = null
        await fs.promises.rm(tokenPath, { force: true })
      },
    }
  }
}

/**
 * The default remote, read from the same config files `hyp status` reads
 * (`HYP_CONFIG`, else the default path, plus the central layer), through
 * the daemon's own exported path and layer resolution rather than a copy of
 * it. A config that exists but cannot be read throws, so the sync backs off
 * instead of treating it as "no login" and deleting the replica.
 *
 * @param {PluginActivationContext} ctx
 * @param {{ config_path: string | null }} seen records the path read, for status
 * @returns {Promise<ReplicaTarget | null>}
 */
async function resolveTargetFromDisk(ctx, seen) {
  const obs = readObservabilityEnv(ctx.env)
  const configPath = resolveConfigPath({ explicit: undefined, env: ctx.env, hypHome: obs.hypHome })
  seen.config_path = configPath
  const layered = await resolveLayeredConfigFromDisk({ stateRoot: obs.stateDir, configPath })
  const local = layered.localLoaded
  if (local && !local.ok && local.errorKind !== 'config_missing') throw new Error(`config unreadable: ${local.message}`)
  return createDefaultTargetResolver({ config: layered.effective ?? undefined, env: ctx.env, hypStateDir: obs.stateDir })()
}

/**
 * The replica status a client may see: everything but local paths.
 *
 * @param {ReplicaStatus} r
 */
function replicaView(r) {
  const { generation_dir: _dir, credential_fp: _fp, ...rest } = r
  return rest
}

/**
 * Why a caller's scope does not match the replica the daemon holds, or null
 * when it does. The scope is what the command resolved for this call: the
 * remote target, its canonical origin, the login's org and the credential
 * fingerprint (`credentialFingerprint`). It is compared with the replica's
 * record, not a fresh login read, so a new login the sync loop has not yet
 * re-confirmed is refused, as on the cold path. Org compares exactly (null
 * for static and environment tokens on both sides); a missing fingerprint on
 * either side fails closed.
 *
 * @ref LLP 0483#credential-change [implements]: the warm path answers only for the remote, org and login the replica was confirmed for
 * @param {any} scope
 * @param {ReplicaStatus} status
 * @returns {'remote' | 'org' | 'login' | null}
 */
export function scopeMismatch(scope, status) {
  if (scope.target !== status.target || scope.origin !== status.origin) return 'remote'
  if ((scope.org ?? null) !== (status.org ?? null)) return 'org'
  if (typeof scope.credential_fp !== 'string' || typeof status.credential_fp !== 'string' || scope.credential_fp !== status.credential_fp) return 'login'
  return null
}

/** @param {any} scope */
function validScope(scope) {
  return scope !== null && typeof scope === 'object' && typeof scope.target === 'string' && typeof scope.origin === 'string' &&
    (scope.org === null || typeof scope.org === 'string') && (scope.credential_fp === null || typeof scope.credential_fp === 'string')
}

/**
 * Reads a JSON body up to `cap` bytes. Answers and returns undefined when
 * it is too large or not JSON.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {number} cap
 * @returns {Promise<any>}
 */
async function readJson(req, res, cap) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > cap) {
    reject(req, res, 413, 'body_limit')
    return undefined
  }
  /** @type {Buffer[]} */
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > cap) {
      reject(req, res, 413, 'body_limit')
      return undefined
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    reject(req, res, 400, 'invalid_json')
    return undefined
  }
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} error
 */
function reject(req, res, status, error) {
  drainRequestBody(req, res)
  send(res, status, { error })
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res, status, body) {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}
