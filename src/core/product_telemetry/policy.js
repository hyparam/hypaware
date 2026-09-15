// @ts-check

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { MAX_CONFIG_DOCUMENT_BYTES, resolveCentralLayerPath } from '../config/apply.js'
import { atomicWriteJsonSync } from '../util/fs_atomic.js'
import { readSmallJson } from './outbox.js'

/** @param {NodeJS.ProcessEnv} [env] */
export function productRoot(env = process.env) {
  return path.join(
    env.HYP_HOME || path.join(os.homedir(), '.hyp'),
    'hypaware',
    'product-telemetry'
  )
}
/** @param {unknown} value */
function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
/** @param {string} url */
export function safeDestination(url) {
  try {
    const u = new URL(url)
    if (u.username || u.password || u.search || u.hash) return null
    if (
      u.protocol !== 'https:' &&
      !(
        u.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
      )
    )
      return null
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/** @param {string} root */
export function effectivePolicy(root) {
  const policyPath = path.join(root, 'policy.json')
  const saved = readSmallJson(policyPath, 4096)
  // An unreadable or malformed preference must never become an automatic opt-in.
  let automatic = false
  try {
    fs.lstatSync(policyPath)
  } catch (error) {
    automatic = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
  }
  const policy = automatic ? enrolledPolicy(root) : saved
  if (
    !policy ||
    policy.version !== 1 ||
    !['local', 'organization'].includes(policy.mode) ||
    typeof policy.generation !== 'string'
  )
    return {
      mode: 'off',
      reason: 'disabled',
      binding: null,
      policy: null,
      identity: null
    }
  if (policy.mode === 'local')
    return {
      mode: 'local',
      reason: 'explicit_local',
      binding: hash([policy.mode, policy.generation]),
      policy,
      identity: null
    }
  const identity =
    typeof policy.identity_path === 'string'
      ? readSmallJson(policy.identity_path)
      : null
  if (
    !identity ||
    identity.central_url !== policy.url ||
    typeof identity.jwt !== 'string' ||
    typeof identity.gateway_id !== 'string'
  )
    return {
      mode: 'off',
      reason: 'enrollment_unavailable',
      binding: null,
      policy,
      identity: null
    }
  // Claims here are only a local binding guard, never trusted attribution.
  let claims
  try {
    claims = JSON.parse(
      Buffer.from(identity.jwt.split('.')[1], 'base64url').toString('utf8')
    )
  } catch {
    return {
      mode: 'off',
      reason: 'enrollment_unavailable',
      binding: null,
      policy,
      identity: null
    }
  }
  const enrollment = hash([
    identity.central_url,
    identity.gateway_id,
    claims.org
  ])
  if (enrollment !== policy.enrollment || !safeDestination(policy.url))
    return {
      mode: 'off',
      reason: 'enrollment_changed',
      binding: null,
      policy,
      identity: null
    }
  return {
    mode: 'organization',
    reason: automatic ? 'enrolled_organization' : 'explicit_organization',
    binding: hash([policy.mode, policy.generation, enrollment]),
    policy,
    identity
  }
}

/**
 * Derive the SaaS default from the central layer, including the join seed.
 * A leftover identity or a query-only remote is not an enrollment. Reads are
 * bounded and never boot the kernel, scan captured data or write preferences.
 * @ref LLP 0408#policy [implements]: enrollment enables reporting unless a local preference exists
 * @param {string} root
 */
function enrolledPolicy(root) {
  const stateRoot = path.dirname(root)
  const configPath = resolveCentralLayerPath({ stateRoot })
  const config = configPath ? readSmallJson(configPath, MAX_CONFIG_DOCUMENT_BYTES) : null
  if (config?.version !== 2 || !config.sinks || typeof config.sinks !== 'object') return null
  const sinks = Object.values(config.sinks).filter(
    (sink) => sink?.plugin === '@hypaware/central'
  )
  if (sinks.length !== 1) return null
  const sink = sinks[0].config
  const url = sink?.url
  if (typeof url !== 'string' || !safeDestination(url)) return null
  const identityPath = sink?.identity?.persisted_path ??
    path.join(stateRoot, 'plugins', '@hypaware/central', 'identity.json')
  if (typeof identityPath !== 'string') return null
  const identity = readSmallJson(identityPath)
  if (!identity || identity.central_url !== url ||
    typeof identity.gateway_id !== 'string' || !identity.gateway_id ||
    typeof identity.jwt !== 'string') return null
  let claims
  try {
    claims = JSON.parse(Buffer.from(identity.jwt.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof claims?.org !== 'string' || !claims.org) return null
  return {
    version: 1,
    mode: 'organization',
    generation: 'enrolled-organization-v1',
    url,
    identity_path: identityPath,
    enrollment: hash([url, identity.gateway_id, claims.org])
  }
}

/**
 * Consent is a fresh generation, even when returning to the same destination.
 * Local history therefore never becomes an uploadable copy after opt-in.
 * @ref LLP 0393#policy [implements]: consent and enrollment are both queue boundaries
 * @param {string} root @param {'off'|'local'|'organization'} mode
 * @param {{url?:string, identityPath?:string}} [options]
 */
export function writePolicy(root, mode, { url, identityPath } = {}) {
  const policy = {
    version: 1,
    mode,
    generation: randomUUID(),
    ...(mode === 'local' ? { installation_id: randomUUID() } : {})
  }
  if (mode === 'organization') {
    const identity = identityPath ? readSmallJson(identityPath) : null
    if (
      !url ||
      safeDestination(url) !== url.replace(/\/$/, '') ||
      !identity ||
      identity.central_url !== url ||
      typeof identity.jwt !== 'string'
    )
      throw new Error(
        'Organization reporting requires an existing enrolled HTTPS destination and gateway identity'
      )
    let claims
    try {
      claims = JSON.parse(
        Buffer.from(identity.jwt.split('.')[1], 'base64url').toString('utf8')
      )
    } catch {
      throw new Error('The enrolled gateway identity is invalid')
    }
    Object.assign(policy, {
      url,
      identity_path: identityPath,
      enrollment: hash([identity.central_url, identity.gateway_id, claims.org])
    })
  }
  atomicWriteJsonSync(path.join(root, 'policy.json'), policy, {
    mode: 0o600,
    dirMode: 0o700
  })
  return effectivePolicy(root)
}
