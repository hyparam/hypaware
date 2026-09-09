// @ts-check

import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
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
  const policy = readSmallJson(path.join(root, 'policy.json'), 4096)
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
    reason: 'explicit_organization',
    binding: hash([policy.mode, policy.generation, enrollment]),
    policy,
    identity
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
