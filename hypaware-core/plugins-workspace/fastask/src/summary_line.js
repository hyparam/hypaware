// @ts-check

/**
 * @import { ReplicaStatus } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

/**
 * The one plain line `hyp status` prints for the team graph replica, in
 * every state, healthy included: how old the team's data is matters even
 * when nothing is wrong. Wording follows the UX guardian's lines in
 * LLP 0480#status-line; the leave line is not used (LLP 0482).
 *
 *   team graph: synced, data as of 14 h ago (acme), 52 MB
 *   team graph: stale, server unreachable since 09:12 PDT, data as of 2 d ago, usable until Oct 12 09:00 PDT
 *   team graph: stale, sign in again (hyp remote login), data as of 2 d ago, usable until Oct 12 09:00 PDT
 *   team graph: expired, not used; reconnect to refresh
 *   team graph: removed, access to acme was withdrawn
 *   team graph: unsupported, upgrade hypaware (or the server is older than this feature)
 *   team graph: unsupported, upgrade hypaware; still using data as of 2 d ago until Oct 12 09:00 PDT
 *
 * Clock times are the reader's local time with the zone named, as the
 * first-sync deadline does (LLP 0100): "09:00" alone does not say whose.
 *   team graph: not available yet (server has not published one)
 *
 * @ref LLP 0480#status-line [implements]: one line in every state, always with the data's age where data is held
 * @param {ReplicaStatus} status
 * @param {{ now?: number, timeZone?: string }} [opts] `timeZone` for tests; the host's zone otherwise
 * @returns {string}
 */
export function summaryLine(status, opts = {}) {
  const now = opts.now ?? Date.now()
  const clock = (/** @type {string | null} */ iso) => formatLocalTime(iso, { day: false, timeZone: opts.timeZone })
  const until = (/** @type {string | null} */ iso) => formatLocalTime(iso, { day: true, timeZone: opts.timeZone })
  const age = `data as of ${formatAge(status.watermark, now)}`
  const held = status.generation !== null

  switch (status.state) {
    case 'synced':
      return `team graph: synced, ${age}${status.org ? ` (${status.org})` : ''}, ${formatSize(status.bytes_on_disk)}`
    case 'stale': {
      const why = staleReason(status.reason, clock(status.last_success ?? status.last_check))
      return `team graph: stale, ${why}, ${age}, usable until ${until(status.lease_expires_at)}`
    }
    case 'expired':
      return 'team graph: expired, not used; reconnect to refresh'
    case 'withdrawn':
      return `team graph: removed, access to ${status.org ?? 'this org'} was withdrawn`
    case 'unsupported':
      return held && status.servable
        ? `team graph: unsupported, upgrade hypaware; still using ${age} until ${until(status.lease_expires_at)}`
        : 'team graph: unsupported, upgrade hypaware (or the server is older than this feature)'
    case 'unavailable':
    default:
      return `team graph: ${unavailableReason(status.reason)}`
  }
}

/**
 * @param {string | null} reason
 * @param {string} since
 */
function staleReason(reason, since) {
  switch (reason) {
    case 'credential': return 'sign in again (hyp remote login)'
    case 'pending': return 'the server is republishing'
    case 'verify_failed': return 'the last download failed its check'
    case 'activate_failed': return 'the last update could not be loaded'
    case 'disk_full': return 'the disk is full'
    case 'replica_too_large': return 'the team graph outgrew this machine\'s limit'
    case 'disabled': return 'the server turned team graph snapshots off'
    case 'outage':
    default: return `server unreachable since ${since}`
  }
}

/** @param {string | null} reason */
function unavailableReason(reason) {
  switch (reason) {
    case 'no_login': return 'not available (no login to the default remote: hyp remote login)'
    case 'bad_target_url': return 'not available (the default remote has no usable URL)'
    case 'disabled': return 'not available (the server has not turned team graph snapshots on)'
    case 'credential': return 'not available yet (sign in again: hyp remote login)'
    case 'replica_too_large': return 'not available (the team graph is larger than this machine\'s limit)'
    case 'outage': return 'not available yet (server unreachable)'
    case 'pending':
    case 'not_checked':
    default: return 'not available yet (server has not published one)'
  }
}

/**
 * @param {string | null} iso
 * @param {number} now
 */
export function formatAge(iso, now) {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return 'an unknown time'
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** @param {number} bytes */
function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} B`
}

/**
 * A clock time in the reader's zone, with the zone named: `09:12 PDT`, or
 * with `day`, `Oct 12 09:00 PDT`. The one place this module asks the host
 * how to present; month names are English like the rest of the line.
 *
 * @param {string | null} iso
 * @param {{ day: boolean, timeZone: string | undefined }} opts `timeZone` for tests; the host's zone otherwise
 */
export function formatLocalTime(iso, { day, timeZone }) {
  const at = iso ? new Date(iso) : null
  if (!at || Number.isNaN(at.getTime())) return 'an unknown time'
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(day ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short', timeZone,
  }).formatToParts(at)
  /** @param {string} type */
  const part = (type) => parts.find((p) => p.type === type)?.value ?? ''
  const zone = part('timeZoneName')
  const time = `${part('hour')}:${part('minute')}${zone ? ` ${zone}` : ''}`
  return day ? `${part('month')} ${part('day')} ${time}` : time
}
