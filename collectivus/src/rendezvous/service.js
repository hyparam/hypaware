import crypto from 'node:crypto'
import http from 'node:http'
import { readPackageVersion } from '../cli/common.js'
import { readJsonBody, writeJson } from '../server/http.js'
import {
  RendezvousStoreError,
  cleanupExpiredInvites,
  createRendezvousStore,
  registerInvite,
  resolveInvite,
} from './store.js'

/**
 * @import { Server, IncomingMessage, ServerResponse } from 'node:http'
 * @import { RendezvousStore } from './types.d.ts'
 */

const MAX_BODY_BYTES = 8 * 1024
export const DEFAULT_RENDEZVOUS_CLEANUP_INTERVAL_MS = 60 * 1000

/**
 * Hosted Discovery Only rendezvous listener. It maps sha256(join_code) to a
 * Central server connect_url and never persists plaintext join codes, configs,
 * telemetry, JWTs, or issuer secrets.
 */
export class RendezvousService {
  /**
   * @param {{ listen: string, dataDir: string, registrationToken: string, cleanupIntervalMs?: number }} config
   * @param {{ store?: RendezvousStore, now?: () => number, setIntervalFn?: typeof setInterval, clearIntervalFn?: typeof clearInterval }} [opts]
   */
  constructor(config, opts = {}) {
    if (!config || typeof config.listen !== 'string' || config.listen.length === 0) {
      throw new Error('RendezvousService: listen is required')
    }
    if (typeof config.dataDir !== 'string' || config.dataDir.length === 0) {
      throw new Error('RendezvousService: dataDir is required')
    }
    if (typeof config.registrationToken !== 'string' || config.registrationToken.length === 0) {
      throw new Error('RendezvousService: registrationToken is required')
    }
    const { host, port } = parseListen(config.listen)
    /** @type {string} */
    this.host = host
    /** @type {number} */
    this.port = port
    /** @type {string} */
    this.dataDir = config.dataDir
    /** @type {string} */
    this.registrationToken = config.registrationToken
    /** @type {RendezvousStore} */
    this.store = opts.store ?? createRendezvousStore({
      dataDir: config.dataDir,
      now: opts.now,
    })
    /** @type {number} */
    this.cleanupIntervalMs = config.cleanupIntervalMs ?? DEFAULT_RENDEZVOUS_CLEANUP_INTERVAL_MS
    /** @type {typeof setInterval} */
    this.setIntervalFn = opts.setIntervalFn ?? setInterval
    /** @type {typeof clearInterval} */
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval
    /** @type {Server | undefined} */
    this.server = undefined
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.cleanupTimer = undefined
  }

  /**
   * @returns {Promise<void>}
   */
  start() {
    cleanupExpiredInvites(this.store)
    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = this.setIntervalFn(() => {
        cleanupExpiredInvites(this.store)
      }, this.cleanupIntervalMs)
      if (typeof this.cleanupTimer === 'object' && this.cleanupTimer !== null
          && 'unref' in this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
        this.cleanupTimer.unref()
      }
    }

    const server = http.createServer((req, res) => this.handleRequest(req, res))
    this.server = server
    return new Promise((resolve, reject) => {
      /** @param {Error} err */
      function onError(err) {
        server.off('listening', onListening)
        reject(err)
      }
      function onListening() {
        server.off('error', onError)
        resolve(undefined)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.port, this.host)
    })
  }

  /**
   * @returns {Promise<void>}
   */
  stop() {
    if (this.cleanupTimer !== undefined) {
      this.clearIntervalFn(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
    return new Promise((resolve, reject) => {
      const { server } = this
      if (!server) {
        resolve(undefined)
        return
      }
      server.close((err) => {
        if (err) reject(err)
        else {
          this.server = undefined
          resolve(undefined)
        }
      })
    })
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {void}
   */
  handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    const method = req.method ?? ''

    if (url.pathname === '/health') {
      if (method !== 'GET') return writeNoStoreError(res, 405, 'method not allowed')
      writeNoStoreJson(res, 200, { status: 'ok', version: readPackageVersion() })
      return
    }

    if (url.pathname === '/v1/rendezvous/invites') {
      if (method !== 'POST') return writeNoStoreError(res, 405, 'method not allowed')
      if (!this.authorizeRegistration(req, res)) return
      this.handleRegisterInvite(req, res)
      return
    }

    if (url.pathname === '/v1/rendezvous/resolve') {
      if (method !== 'POST') return writeNoStoreError(res, 405, 'method not allowed')
      this.handleResolve(req, res)
      return
    }

    writeNoStoreError(res, 404, 'not found')
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {boolean}
   */
  authorizeRegistration(req, res) {
    const header = firstHeaderValue(req.headers.authorization)
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      writeNoStoreJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
      return false
    }
    const token = header.slice('bearer '.length).trim()
    if (!timingSafeEqualString(token, this.registrationToken)) {
      writeNoStoreJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
      return false
    }
    return true
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {void}
   */
  handleRegisterInvite(req, res) {
    readJsonBody(req, MAX_BODY_BYTES).then((body) => {
      if (body.error) return writeNoStoreError(res, body.status, body.error)
      if (!isPlainObject(body.value)) return writeNoStoreError(res, 400, 'request body must be an object')
      if (body.value.kind !== undefined && body.value.kind !== 'one_time_gateway' && body.value.kind !== 'enterprise_enrollment') {
        return writeNoStoreError(res, 400, 'kind must be one_time_gateway or enterprise_enrollment')
      }
      if (typeof body.value.join_code_hash !== 'string') return writeNoStoreError(res, 400, 'join_code_hash is required')
      if (typeof body.value.connect_url !== 'string') return writeNoStoreError(res, 400, 'connect_url is required')
      if (typeof body.value.gateway_id !== 'string') return writeNoStoreError(res, 400, 'gateway_id is required')
      if (typeof body.value.expires_at !== 'string') return writeNoStoreError(res, 400, 'expires_at is required')
      if (
        body.value.max_uses !== undefined &&
        (typeof body.value.max_uses !== 'number' || !Number.isInteger(body.value.max_uses) || body.value.max_uses <= 0)
      ) {
        return writeNoStoreError(res, 400, 'max_uses must be a positive integer when provided')
      }
      if (body.value.display_name !== undefined && typeof body.value.display_name !== 'string') {
        return writeNoStoreError(res, 400, 'display_name must be a string when provided')
      }
      try {
        /** @type {import('./types.d.ts').RegisterInviteInput} */
        const input = {
          kind: body.value.kind === 'enterprise_enrollment' ? 'enterprise_enrollment' : 'one_time_gateway',
          join_code_hash: body.value.join_code_hash,
          connect_url: body.value.connect_url,
          gateway_id: body.value.gateway_id,
          expires_at: body.value.expires_at,
        }
        if (typeof body.value.max_uses === 'number') input.max_uses = body.value.max_uses
        if (typeof body.value.display_name === 'string') input.display_name = body.value.display_name
        const record = registerInvite(this.store, input)
        writeNoStoreJson(res, 200, { ok: true, expires_at: record.expires_at })
      } catch (err) {
        writeStoreError(res, err)
      }
    }).catch((err) => {
      writeNoStoreError(res, 500, `invite registration failed: ${formatError(err)}`)
    })
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {void}
   */
  handleResolve(req, res) {
    readJsonBody(req, MAX_BODY_BYTES).then((body) => {
      if (body.error) return writeNoStoreError(res, body.status, body.error)
      if (!isPlainObject(body.value) || typeof body.value.join_code !== 'string' || body.value.join_code.length === 0) {
        return writeNoStoreError(res, 400, 'join_code is required')
      }
      try {
        const record = resolveInvite(this.store, body.value.join_code)
        /** @type {Record<string, string | number>} */
        const payload = {
          kind: record.kind,
          connect_url: record.connect_url,
          gateway_id: record.gateway_id,
          expires_at: record.expires_at,
        }
        if (record.display_name !== undefined) payload.display_name = record.display_name
        if (record.max_uses !== undefined) payload.max_uses = record.max_uses
        writeNoStoreJson(res, 200, payload)
      } catch (err) {
        writeStoreError(res, err)
      }
    }).catch((err) => {
      writeNoStoreError(res, 500, `resolve failed: ${formatError(err)}`)
    })
  }
}

/**
 * @param {ServerResponse} res
 * @param {unknown} err
 * @returns {void}
 */
function writeStoreError(res, err) {
  if (!(err instanceof RendezvousStoreError)) {
    writeNoStoreError(res, 500, formatError(err))
    return
  }
  if (err.code === 'duplicate_active') return writeNoStoreError(res, 409, err.message)
  if (err.code === 'unknown_join_code') return writeNoStoreError(res, 404, err.message)
  if (err.code === 'expired') return writeNoStoreError(res, 410, err.message)
  if (err.code === 'invalid_record') return writeNoStoreError(res, 500, err.message)
  writeNoStoreError(res, 400, err.message)
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {import('node:http').OutgoingHttpHeaders} [headers]
 * @returns {void}
 */
function writeNoStoreJson(res, status, body, headers = {}) {
  writeJson(res, status, body, { 'cache-control': 'no-store', ...headers })
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @returns {void}
 */
function writeNoStoreError(res, status, message) {
  writeNoStoreJson(res, status, { error: message })
}

/**
 * @param {string} value
 * @returns {{ host: string, port: number }}
 */
function parseListen(value) {
  let host = ''
  let portStr = ''
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(1, close)
    if (value[close + 1] !== ':') throw new Error(`invalid listen address: ${value}`)
    portStr = value.slice(close + 2)
  } else {
    const colon = value.lastIndexOf(':')
    if (colon <= 0) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(0, colon)
    portStr = value.slice(colon + 1)
  }
  const port = Number.parseInt(portStr, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== portStr) {
    throw new Error(`invalid port in listen address: ${value}`)
  }
  return { host, port }
}

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualString(a, b) {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
