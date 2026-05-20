import crypto from 'node:crypto'
import { isValidGatewayId } from '../gateway_id.js'
import {
  deleteEnrollment,
  generateEnrollmentCode,
  registerEnrollment,
} from './enrollment.js'
import { readJsonBody, writeJson } from './http.js'
import { registerRendezvousInvite } from './rendezvous_client.js'
import { resolveSecret } from './secret_resolver.js'
import { shellSingleQuote, stripTrailingSlashes } from './util.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { ServerConfig } from '../types.js'
 * @import { EnrollmentStore } from './enrollment.d.ts'
 */

/**
 * Hard cap on admin-invite request bodies. The shape is small (four fields,
 * none of them free-form text) so 1 KiB leaves comfortable headroom for
 * pretty-printed JSON without giving an attacker a memory amplifier on the
 * admin endpoint.
 */
const MAX_BODY_BYTES = 1024
const DEFAULT_MAX_USES = 1
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Build a request handler for `POST /v1/admin/invites`.
 *
 * The handler mints a fresh join code, registers the enrollment locally,
 * and registers the same code with the shared rendezvous service. If the
 * rendezvous registration fails we roll back the local enrollment so a
 * leaked join code can never resolve back to this server with no rendezvous
 * mapping behind it.
 *
 * The factory does NOT enforce admin-token auth — callers must apply
 * `createAdminAuth` from `./admin_auth.js` before reaching this handler.
 * Auth lives at the route mount so a single admin middleware can guard the
 * whole `/v1/admin/*` namespace.
 *
 * @param {{
 *   config: ServerConfig,
 *   enrollmentStore: EnrollmentStore,
 *   fetchFn?: typeof fetch,
 *   generateCode?: () => string,
 *   now?: () => number,
 *   logger?: (line: string) => void,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<void>}
 */
export function createAdminInvitesHandler(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('createAdminInvitesHandler: opts is required')
  }
  if (!opts.config) {
    throw new Error('createAdminInvitesHandler: config is required')
  }
  if (!opts.enrollmentStore) {
    throw new Error('createAdminInvitesHandler: enrollmentStore is required')
  }
  const config = opts.config
  const enrollmentStore = opts.enrollmentStore
  const fetchFn = opts.fetchFn ?? fetch
  const generateCode = opts.generateCode ?? generateEnrollmentCode
  const env = opts.env ?? process.env
  const logger = opts.logger ?? defaultLogger

  return async function handler(req, res) {
    /** @type {unknown} */
    let body
    try {
      const parsed = await readJsonBody(req, MAX_BODY_BYTES)
      if (parsed.error) {
        // An empty body is legal — every field is optional. Anything else
        // (malformed JSON, oversize) propagates as the original 4xx.
        if (parsed.status === 400 && parsed.error === 'empty request body') {
          body = {}
        } else {
          return writeNoStoreJson(res, parsed.status, { error: parsed.error })
        }
      } else {
        body = parsed.value
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return writeNoStoreJson(res, 500, { error: `failed to read request body: ${msg}` })
    }

    if (!isPlainObject(body)) {
      return writeNoStoreJson(res, 400, { error: 'request body must be a JSON object' })
    }

    /** @type {number} */
    let maxUses
    if (body.maxUses === undefined) {
      maxUses = DEFAULT_MAX_USES
    } else if (!isPositiveInteger(body.maxUses)) {
      return writeNoStoreJson(res, 400, { error: 'maxUses must be a positive integer' })
    } else {
      maxUses = body.maxUses
    }

    /** @type {number} */
    let ttlSeconds
    if (body.ttlSeconds === undefined) {
      ttlSeconds = DEFAULT_TTL_SECONDS
    } else if (!isPositiveInteger(body.ttlSeconds)) {
      return writeNoStoreJson(res, 400, { error: 'ttlSeconds must be a positive integer' })
    } else {
      ttlSeconds = body.ttlSeconds
    }

    /** @type {string | undefined} */
    let displayName
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string' || body.displayName.length === 0) {
        return writeNoStoreJson(res, 400, { error: 'displayName must be a non-empty string when provided' })
      }
      displayName = body.displayName
    }

    /** @type {string | undefined} */
    let bodyPrefix
    if (body.gatewayPrefix !== undefined) {
      if (typeof body.gatewayPrefix !== 'string' || !isValidGatewayId(body.gatewayPrefix)) {
        return writeNoStoreJson(res, 400, { error: 'gatewayPrefix is not a valid gateway id' })
      }
      bodyPrefix = body.gatewayPrefix
    }

    const configuredPrefix = config.enrollment?.gateway_prefix
    const gatewayPrefix = bodyPrefix ?? configuredPrefix
    if (!gatewayPrefix) {
      return writeNoStoreJson(res, 400, {
        error: 'gateway prefix required: configure server.enrollment.gateway_prefix or pass gatewayPrefix in the request',
      })
    }

    if (!config.public_url) {
      // Defense in depth — config validation already requires public_url
      // when admin is configured, so reaching here means the server was
      // started with a config that bypassed validation.
      return writeNoStoreJson(res, 500, { error: 'server.public_url is not configured' })
    }

    /** @type {{ url: string, registrationToken: string }} */
    let rendezvous
    try {
      rendezvous = resolveRendezvous(config, env)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return writeNoStoreJson(res, 500, { error: `rendezvous not configured: ${msg}` })
    }

    const joinCode = generateCode()
    const joinCodeHash = sha256Hex(joinCode)

    /** @type {ReturnType<typeof registerEnrollment>} */
    let record
    try {
      record = registerEnrollment(enrollmentStore, {
        joinCodeHash,
        gatewayId: gatewayPrefix,
        maxUses,
        ttlSeconds,
        ...displayName !== undefined ? { displayName } : {},
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return writeNoStoreJson(res, 400, { error: `failed to register enrollment: ${msg}` })
    }

    const expiresAtIso = new Date(record.expiresAt * 1000).toISOString()

    try {
      await registerRendezvousInvite({
        fetchFn,
        rendezvousUrl: rendezvous.url,
        registrationToken: rendezvous.registrationToken,
        joinCodeHash,
        connectUrl: config.public_url,
        gatewayId: gatewayPrefix,
        expiresAt: expiresAtIso,
        maxUses,
        ...displayName !== undefined ? { displayName } : {},
      })
    } catch (err) {
      // Best-effort rollback — if the local store delete also fails the
      // operator gets a follow-up 500 rather than a misleading 502, but
      // the rendezvous error is the primary failure to surface.
      try {
        deleteEnrollment(enrollmentStore, joinCodeHash)
      } catch {
        // swallow rollback failure; the upstream 502 carries the meaningful signal
      }
      const msg = err instanceof Error ? err.message : String(err)
      return writeNoStoreJson(res, 502, { error: `rendezvous registration failed: ${msg}` })
    }

    const trimmedRendezvousUrl = stripTrailingSlashes(rendezvous.url)
    const command = `npx collectivus join ${shellSingleQuote(joinCode)} --rendezvous ${shellSingleQuote(trimmedRendezvousUrl)}`

    logger(`admin invite created gateway=${gatewayPrefix} max_uses=${maxUses} ttl_seconds=${ttlSeconds}`)

    return writeNoStoreJson(res, 200, {
      joinCode,
      expiresAt: expiresAtIso,
      maxUses,
      gatewayPrefix,
      rendezvousUrl: trimmedRendezvousUrl,
      command,
    })
  }
}

/**
 * Resolve the rendezvous URL and registration token from `config.rendezvous`,
 * honoring the inline-or-env-var contract enforced by `validateRendezvous` in
 * `src/config.js`. Throws on missing config or unset env-var so the handler
 * can map to a 500.
 *
 * @param {ServerConfig} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ url: string, registrationToken: string }}
 */
function resolveRendezvous(config, env) {
  const r = config.rendezvous
  if (!r) {
    throw new Error('server.rendezvous is required for admin invites')
  }
  const url = resolveSecret({
    direct: r.url,
    envVar: r.url_env,
    env,
    minBytes: 1,
    pointer: '/server/rendezvous/url',
    envVarPointer: '/server/rendezvous/url_env',
  })
  const registrationToken = resolveSecret({
    direct: r.registration_token,
    envVar: r.registration_token_env,
    env,
    minBytes: 1,
    pointer: '/server/rendezvous/registration_token',
    envVarPointer: '/server/rendezvous/registration_token_env',
  })
  return { url, registrationToken }
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function writeNoStoreJson(res, status, body) {
  writeJson(res, status, body, { 'cache-control': 'no-store' })
}

/**
 * @param {string} line
 */
function defaultLogger(line) {
  process.stdout.write(`${line}\n`)
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}
