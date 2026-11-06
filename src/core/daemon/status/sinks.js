// @ts-check

/**
 * Sink diagnostics read from disk: datasets a destination holds back, a
 * stopped central service token, and the identities central sinks hold.
 *
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { HypAwareStatusReport, StatusDiagnostic } from '../../../../src/core/daemon/types.js'
 * @import { KeptServiceToken } from '../../../../src/core/remote/types.js'
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { readKeptServiceToken, serviceTokenPath } from '../../remote/service_token.js'
import { canonicalOrigin } from '../../remote/builtin_remotes.js'
import { readHeldDatasets } from '../../sinks/held_datasets.js'
import { instanceWatermarkStateDir } from '../../sinks/incremental.js'
import { pluginStateDir } from '../../runtime/paths.js'
import { errCode, isPlainObject, sanitizeLabel, sha256Hex } from '../../util/json_util.js'

const HELD_DATASET_NAMES_SHOWN = 5

/**
 * One warning per configured request sink whose destination refused to
 * register a dataset it would otherwise forward (LLP 0537). Read from the
 * snapshot the sink keeps on disk, so a fresh `hyp status` sees it with no
 * daemon to ask. A snapshot that cannot be read warns too: answering nothing
 * would certify forwarding nobody checked.
 *
 * @param {string} stateRoot
 * @param {HypAwareV2Config} config
 * @returns {Promise<StatusDiagnostic[]>}
 */
export async function heldDatasetDiagnostics(stateRoot, config) {
  const disabled = new Set((config.plugins ?? []).filter((p) => p.enabled === false).map((p) => p.name))
  /** @type {StatusDiagnostic[]} */
  const out = []
  for (const [instance, raw] of Object.entries(config.sinks ?? {})) {
    const plugin = 'plugin' in raw && typeof raw.plugin === 'string' ? raw.plugin : undefined
    const url = raw.config?.url
    if (!plugin || disabled.has(plugin) || typeof url !== 'string' || url.length === 0) continue
    const read = await readHeldDatasets(instanceWatermarkStateDir(pluginStateDir(stateRoot, plugin), instance), url)
    const label = sanitizeLabel(instance) ?? 'unknown'
    if ('unreadable' in read) {
      out.push({
        severity: 'warning',
        kind: 'sink_dataset_unsupported',
        message: `${label}: held-dataset state is unreadable (${sanitizeLabel(read.unreadable) ?? 'unknown'}), so it is unknown whether every dataset forwards`,
        repair: ['it is rewritten once every forwarded dataset with local rows has registered or been held again'],
      })
      continue
    }
    if (read.datasets.length === 0) continue
    const shown = read.datasets.slice(0, HELD_DATASET_NAMES_SHOWN).map((name) => sanitizeLabel(name) ?? 'unknown')
    const more = read.datasets.length - shown.length
    const names = more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
    const count = read.datasets.length
    out.push({
      severity: 'warning',
      kind: 'sink_dataset_unsupported',
      message: `${label}: the server cannot accept ${count} dataset${count === 1 ? '' : 's'} (${names}); their rows stay local`,
      repair: ['upgrade the server; held rows forward once it accepts the dataset'],
    })
  }
  return out
}

/**
 * A central sink whose kept service token records a permanent stop, or cannot
 * be read, sends nothing until a new `hyp join`. Only the record on disk is
 * read, so a stop the sink could not persist is not shown here, and the
 * record's contents never are. A stop is shown only when the record names
 * the credential the sink would activate with ({@link keptStopApplies}).
 *
 * @ref LLP 0547#rebootstrap [implements]: status names the stop and its remedy
 * @param {string} stateRoot
 * @param {HypAwareV2Config} config
 * @returns {Promise<StatusDiagnostic[]>}
 */
export async function serviceTokenDiagnostics(stateRoot, config) {
  const plugin = '@hypaware/central'
  if ((config.plugins ?? []).some((p) => p.name === plugin && p.enabled === false)) return []
  /** @type {StatusDiagnostic[]} */
  const out = []
  for (const [instance, raw] of Object.entries(config.sinks ?? {})) {
    if (!('plugin' in raw) || raw.plugin !== plugin) continue
    const identityPath = centralIdentityPath(stateRoot, raw.config)
    const recordPath = serviceTokenPath(identityPath)
    const read = await readKeptServiceToken(recordPath)
    const label = sanitizeLabel(instance) ?? 'unknown'
    if (read.state === 'unreadable') {
      out.push({
        severity: 'error',
        kind: 'central_service_token_stopped',
        message: `${label}: stopped: service token file unreadable (${sanitizeLabel(recordPath, 512) ?? 'unknown'})`,
        repair: ['run `hyp join` again'],
      })
    } else if (read.state === 'ok' && read.record.stopped_code && await keptStopApplies(read.record, raw.config, identityPath)) {
      const what = read.record.stopped_code === 'service_account_disabled' ? 'service account disabled' : 'service token revoked'
      out.push({
        severity: 'error',
        kind: 'central_service_token_stopped',
        message: `${label}: stopped: ${what}`,
        repair: ['create a new token in HypAware and run `hyp join` again'],
      })
    }
  }
  return out
}

/**
 * Where a central sink keeps its persisted identity: its own
 * `identity.persisted_path`, else the per-plugin state default, the same
 * resolution the sink and `hyp remote login` use.
 *
 * @param {string} stateRoot
 * @param {unknown} sinkConfig
 * @returns {string}
 */
function centralIdentityPath(stateRoot, sinkConfig) {
  const identity = isPlainObject(sinkConfig) ? sinkConfig.identity : undefined
  const configured = isPlainObject(identity) ? identity.persisted_path : undefined
  return typeof configured === 'string' ? configured : path.join(pluginStateDir(stateRoot, '@hypaware/central'), 'identity.json')
}

/**
 * The gateway id each configured central sink forwards under, read from the
 * identity the server minted at `hyp join` or `hyp remote login`. Only
 * `gateway_id` leaves this function; the JWT beside it is never read out.
 * `pending` is a configured sink with no identity for its server yet (the
 * sink mints on first activation, and an identity naming another server is
 * one a configured join token replaces); `other_server` is an identity
 * another server minted with no join token to replace it, which the sink
 * refuses; `unreadable` is a file that is not one.
 *
 * @param {string} stateRoot
 * @param {HypAwareV2Config | null} config
 * @returns {Promise<HypAwareStatusReport['gateways']>}
 */
export async function collectGateways(stateRoot, config) {
  const plugin = '@hypaware/central'
  if (!config || (config.plugins ?? []).some((p) => p.name === plugin && p.enabled === false)) return []
  /** @type {HypAwareStatusReport['gateways']} */
  const out = []
  for (const [sink, raw] of Object.entries(config.sinks ?? {})) {
    if (!('plugin' in raw) || raw.plugin !== plugin) continue
    const sinkUrl = isPlainObject(raw.config) && typeof raw.config.url === 'string' ? raw.config.url : undefined
    let persisted
    try {
      persisted = JSON.parse(await fsp.readFile(centralIdentityPath(stateRoot, raw.config), 'utf8'))
    } catch (err) {
      out.push({ sink, gatewayId: null, state: errCode(err) === 'ENOENT' ? 'pending' : 'unreadable' })
      continue
    }
    const gatewayId = isPlainObject(persisted) && typeof persisted.gateway_id === 'string' && persisted.gateway_id.length > 0
      ? persisted.gateway_id
      : null
    if (gatewayId === null) {
      out.push({ sink, gatewayId: null, state: 'unreadable' })
    } else if (sinkUrl !== undefined && typeof persisted.central_url === 'string' && !sameCentralUrl(persisted.central_url, sinkUrl)) {
      // With no join token to re-mint from, the sink refuses an identity
      // another server minted rather than waiting for one, so this is not
      // pending: nothing is issued until `hyp join` or `hyp remote login`.
      const identity = isPlainObject(raw.config) ? raw.config.identity : undefined
      const token = isPlainObject(identity) ? identity.bootstrap_token : undefined
      out.push({ sink, gatewayId: null, state: typeof token === 'string' && token.length > 0 ? 'pending' : 'other_server' })
    } else {
      out.push({ sink, gatewayId, state: 'issued' })
    }
  }
  return out
}

/**
 * Whether a stored stop names the credential this sink would activate with,
 * by the rule the central sink's activation applies: the seed's bootstrap
 * token when one is set, otherwise the persisted identity it minted (never a
 * login identity), otherwise the record's own destination. A stop on a record
 * the sink would not use is not this sink's stop. An identity that cannot be
 * read keeps the stop shown.
 *
 * @param {KeptServiceToken} record
 * @param {unknown} sinkConfig
 * @param {string} identityPath
 * @returns {Promise<boolean>}
 */
async function keptStopApplies(record, sinkConfig, identityPath) {
  const config = isPlainObject(sinkConfig) ? sinkConfig : {}
  const sinkUrl = typeof config.url === 'string' ? config.url : undefined
  const identity = isPlainObject(config.identity) ? config.identity : {}
  /**
   * @param {unknown} fingerprint
   * @param {unknown} url
   * @param {unknown} [origin]
   */
  const names = (fingerprint, url, origin) => origin !== 'login' && fingerprint === record.fingerprint &&
    typeof url === 'string' && sameCentralUrl(record.central_url, url)
  const token = identity.bootstrap_token
  if (typeof token === 'string' && token.length > 0) return names(sha256Hex(token), sinkUrl)
  let persisted
  try {
    persisted = JSON.parse(await fsp.readFile(identityPath, 'utf8'))
  } catch (err) {
    if (errCode(err) !== 'ENOENT') return true
    return sinkUrl !== undefined && sameCentralUrl(record.central_url, sinkUrl)
  }
  if (!isPlainObject(persisted)) return true
  return names(persisted.bootstrap_token_fp, persisted.central_url, persisted.origin)
}

/**
 * The central sink's destination comparison: the same origin through the
 * built-in alias table, and the same path, ignoring trailing slashes.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameCentralUrl(a, b) {
  if (a === b) return true
  const origin = canonicalOrigin(a)
  if (origin === null || origin !== canonicalOrigin(b)) return false
  /** @param {string} url */
  const rest = (url) => {
    const { pathname, search } = new URL(url)
    return `${pathname.replace(/\/+$/, '')}${search}`
  }
  return rest(a) === rest(b)
}
