// @ts-check

export const DAY_MS = 86_400_000
export const MAX_BATCH_BYTES = 32 * 1024
export const MAX_RECORDS = 100
export const HISTOGRAM_BOUNDS = Object.freeze([
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000
])
export const PRODUCT_DATASETS = Object.freeze([
  'product_events',
  'product_metrics'
])
export const RESERVED_DATASETS = new Set([
  ...PRODUCT_DATASETS,
  'product_installations',
  'product_daily'
])

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const VERSION =
  /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})(?:-(?:alpha|beta|rc)\.[0-9]{1,5})?$/
const OUTCOMES = ['success', 'failure', 'degraded', 'cancelled']
const ADAPTERS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'opencode',
  'openclaw',
  'hermes',
  'other'
]
export const COMMANDS = Object.freeze([
  'ask',
  'cache maintain',
  'cache refresh',
  'cache status',
  'claude-account credential',
  'claude-hook classify-cwd',
  'claude-hook session-context',
  'client',
  'client attach',
  'client claude-account login',
  'client claude-account logout',
  'client claude-account status',
  'client claude-desktop install',
  'client claude-desktop install-helper',
  'client claude-desktop profile',
  'client claude-desktop status',
  'client claude-desktop verify',
  'client detach',
  'client history import',
  'client history plan',
  'client history providers',
  'client skills',
  'client skills install',
  'client status',
  'codex-hook classify-cwd',
  'config',
  'config validate',
  'daemon',
  'daemon install',
  'daemon restart',
  'daemon run',
  'daemon start',
  'daemon status',
  'daemon stop',
  'daemon uninstall',
  'dev',
  'dev plugin doctor',
  'dev plugin new',
  'dev smoke',
  'enrichment',
  'enrichment backfill',
  'enrichment curate',
  'enrichment propose',
  'enrichment status',
  'gascity attach',
  'gascity detach',
  'gascity list',
  'github',
  'github backfill',
  'github sync',
  'graph compact',
  'graph project',
  'help',
  'join',
  'leave',
  'mcp serve',
  'other',
  'plugin',
  'plugin info',
  'plugin install',
  'plugin list',
  'plugin outdated',
  'plugin remove',
  'plugin update',
  'privacy',
  'privacy client',
  'privacy folders',
  'privacy ignore',
  'privacy list',
  'privacy purge',
  'privacy set',
  'privacy show',
  'privacy unignore',
  'privacy unset',
  'query',
  'query graph neighbors',
  'query grep',
  'query overview',
  'query schema',
  'query sql',
  'query vector',
  'query vector search',
  'remote',
  'remote add',
  'remote list',
  'remote login',
  'remote mint',
  'remote remove',
  'report',
  'report delete',
  'report get',
  'report list',
  'report publish',
  'report render',
  'session',
  'session ignore',
  'session status',
  'session unignore',
  'setup',
  'sink',
  'sink maintain',
  'status',
  'sync',
  'telemetry',
  'unknown',
  'update',
  'vector status',
  'version'
])
export const ERROR_CODES = Object.freeze([
  'other',
  'unavailable',
  'timeout',
  'unauthorized',
  'revoked',
  'invalid_config',
  'disk_full',
  'rate_limited',
  'capture_failed',
  'write_failed',
  'export_failed',
  'query_failed',
  'startup_failed'
])
const COMPONENTS = [
  'cli',
  'daemon',
  'capture',
  'cache',
  'export',
  'identity',
  'query',
  'server',
  'telemetry',
  'other'
]
const OPERATIONS = [
  'start',
  'stop',
  'read',
  'write',
  'capture',
  'export',
  'query',
  'enroll',
  'refresh',
  'send',
  'other'
]
const ROUTES = [
  'ingest',
  'config',
  'datasets',
  'query',
  'mcp',
  'search',
  'identity',
  'admin',
  'reports',
  'org',
  'other'
]

/** @type {Record<string, { type: string, unit: string, max: number }>} */
export const METRICS = Object.freeze({
  'pipeline.rows': { type: 'sum', unit: '{row}', max: 1e9 },
  'pipeline.bytes': { type: 'sum', unit: 'By', max: 1e12 },
  'pipeline.failures': { type: 'sum', unit: '{failure}', max: 1e6 },
  'pipeline.pending': { type: 'gauge', unit: 'By', max: 1e12 },
  'pipeline.oldest_age': { type: 'gauge', unit: 's', max: 90 * 86400 },
  'pipeline.freshness': { type: 'gauge', unit: 's', max: 90 * 86400 },
  'process.rss': { type: 'gauge', unit: 'By', max: 1e12 },
  'process.heap_used': { type: 'gauge', unit: 'By', max: 1e12 },
  'process.cpu': { type: 'gauge', unit: '{core}', max: 1024 },
  'process.uptime': { type: 'gauge', unit: 's', max: 365 * 86400 },
  'telemetry.dropped': { type: 'sum', unit: '{record}', max: 1e9 },
  'telemetry.failures': { type: 'sum', unit: '{failure}', max: 1e6 },
  'telemetry.queue': { type: 'gauge', unit: 'By', max: 5 * 1024 * 1024 },
  'telemetry.oldest_age': { type: 'gauge', unit: 's', max: 7 * 86400 },
  'server.request.duration': { type: 'histogram', unit: 'ms', max: 3_600_000 },
  'server.query.duration': { type: 'histogram', unit: 'ms', max: 3_600_000 }
})

/** @param {unknown} value @returns {value is Record<string, any>} */
export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/** @param {unknown} value @param {readonly string[]} required @param {readonly string[]} [optional] */
function keys(value, required, optional = []) {
  return (
    object(value) &&
    required.every((k) => Object.hasOwn(value, k)) &&
    Object.keys(value).every(
      (k) => required.includes(k) || optional.includes(k)
    )
  )
}
/** @param {unknown} value @param {number} max @param {number} [min] */
function number(value, max, min = 0) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  )
}
/** @param {unknown} value @param {number} max @param {number} [min] */
function integer(value, max, min = 0) {
  return number(value, max, min) && Number.isSafeInteger(value)
}
/** @param {unknown} value */
export function uuid(value) {
  return typeof value === 'string' && UUID.test(value)
}
/** @param {unknown} value */
function timestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

// @ref LLP 0393#contract [implements]: finite per-kind vocabularies, never arbitrary OTEL attributes
/** @param {unknown} body @param {number} now @param {boolean} [server] @returns {string | null} */
export function validateBatch(body, now, server = false) {
  if (!object(body) || body.schema_version !== 1) return 'unsupported_version'
  if (
    !keys(body, ['schema_version', 'batch_id', 'resource', 'records']) ||
    !uuid(body.batch_id)
  )
    return 'invalid_envelope'
  const r = body.resource
  if (
    !keys(
      r,
      [
        'service.name',
        'service.version',
        'service.role',
        'process.id',
        'os.type',
        'host.arch',
        'node.major',
        'deployment.environment',
        'hypaware.self'
      ],
      ['hypaware.version']
    )
  )
    return 'invalid_resource'
  if (
    r['hypaware.self'] !== true ||
    !uuid(r['process.id']) ||
    typeof r['service.version'] !== 'string' ||
    !VERSION.test(r['service.version'])
  )
    return 'invalid_resource'
  if (
    !['development', 'test', 'production'].includes(
      r['deployment.environment']
    ) ||
    !['darwin', 'linux', 'windows', 'other'].includes(r['os.type']) ||
    !['arm64', 'x64', 'other'].includes(r['host.arch']) ||
    !integer(r['node.major'], 99, 18)
  )
    return 'invalid_resource'
  if (server) {
    if (
      r['service.name'] !== 'hypaware-server' ||
      r['service.role'] !== 'server' ||
      typeof r['hypaware.version'] !== 'string' ||
      !VERSION.test(r['hypaware.version'])
    )
      return 'invalid_resource'
  } else if (
    r['service.name'] !== 'hypaware' ||
    !['cli', 'daemon'].includes(r['service.role']) ||
    r['hypaware.version'] !== undefined
  )
    return 'invalid_resource'
  if (
    !Array.isArray(body.records) ||
    body.records.length < 1 ||
    body.records.length > MAX_RECORDS
  )
    return 'record_limit'
  for (const record of body.records) {
    if (
      !object(record) ||
      !timestamp(record.timestamp) ||
      Date.parse(record.timestamp) < now - 7 * DAY_MS ||
      Date.parse(record.timestamp) > now + 60_000
    )
      return 'invalid_timestamp'
    if (record.kind === 'event') {
      if (
        !keys(record, ['kind', 'timestamp', 'name', 'attributes']) ||
        !event(record.name, record.attributes)
      )
        return 'invalid_event'
    } else if (record.kind === 'metric') {
      if (!metric(record, server)) return 'invalid_metric'
    } else return 'invalid_kind'
  }
  // A sender owns one interval per bounded series in a batch. Retry the exact
  // batch bytes; splitting/rebatching an accepted interval is not supported.
  const series = new Set()
  for (const record of body.records.filter((r) => r.kind === 'metric')) {
    const key = JSON.stringify([
      record.name,
      Object.entries(record.attributes).sort()
    ])
    if (series.has(key)) return 'duplicate_series'
    series.add(key)
  }
  return null
}

/** @param {string} name @param {Record<string, any>} a */
function event(name, a) {
  switch (name) {
    case 'cli.invocation':
      return (
        keys(a, [
          'command',
          'invocation_kind',
          'outcome',
          'exit_class',
          'duration_ms'
        ]) &&
        COMMANDS.includes(a.command) &&
        ['execution', 'help', 'version', 'unknown'].includes(
          a.invocation_kind
        ) &&
        OUTCOMES.includes(a.outcome) &&
        ['zero', 'nonzero', 'signal', 'cancelled'].includes(a.exit_class) &&
        number(a.duration_ms, DAY_MS)
      )
    case 'installation.inventory':
      return (
        keys(a, ['adapters']) &&
        Array.isArray(a.adapters) &&
        a.adapters.length <= ADAPTERS.length &&
        new Set(a.adapters).size === a.adapters.length &&
        a.adapters.every((v) => ADAPTERS.includes(v))
      )
    case 'setup.step':
      return (
        keys(a, ['step', 'outcome', 'error_code', 'duration_ms']) &&
        [
          'install',
          'configure',
          'attach',
          'enroll',
          'verify',
          'complete',
          'other'
        ].includes(a.step) &&
        OUTCOMES.includes(a.outcome) &&
        ERROR_CODES.includes(a.error_code) &&
        number(a.duration_ms, DAY_MS)
      )
    case 'client.attachment':
      return (
        keys(a, ['adapter', 'operation', 'outcome', 'error_code']) &&
        ADAPTERS.includes(a.adapter) &&
        ['attach', 'detach'].includes(a.operation) &&
        OUTCOMES.includes(a.outcome) &&
        ERROR_CODES.includes(a.error_code)
      )
    case 'enrollment':
      return (
        keys(a, ['operation', 'outcome']) &&
        ['join', 'leave'].includes(a.operation) &&
        OUTCOMES.includes(a.outcome)
      )
    case 'daemon.lifecycle':
      return (
        keys(a, ['transition', 'outcome', 'error_code']) &&
        ['start', 'ready', 'stop', 'update'].includes(a.transition) &&
        OUTCOMES.includes(a.outcome) &&
        ERROR_CODES.includes(a.error_code)
      )
    case 'installation.milestone':
      return (
        keys(a, ['milestone']) &&
        ['first_capture', 'first_query'].includes(a.milestone)
      )
    case 'heartbeat':
      return keys(a, ['uptime_s']) && number(a.uptime_s, 365 * 86400)
    case 'coded.failure':
      return (
        keys(a, ['component', 'operation', 'error_code', 'occurrence_count']) &&
        COMPONENTS.includes(a.component) &&
        OPERATIONS.includes(a.operation) &&
        ERROR_CODES.includes(a.error_code) &&
        integer(a.occurrence_count, 1000, 1)
      )
    default:
      return false
  }
}

/** @param {Record<string, any>} r @param {boolean} server */
function metric(r, server) {
  if (typeof r.name !== 'string') return false
  const m = Object.hasOwn(METRICS, r.name) ? METRICS[r.name] : undefined
  if (!m || (r.name.startsWith('server.') && !server)) return false
  const common = [
    'kind',
    'timestamp',
    'startTimestamp',
    'name',
    'unit',
    'type',
    'attributes'
  ]
  if (!timestamp(r.startTimestamp)) return false
  const duration = Date.parse(r.timestamp) - Date.parse(r.startTimestamp)
  if (duration <= 0 || duration > 600_000) return false
  if (r.type !== m.type || r.unit !== m.unit) return false
  if (r.name.startsWith('pipeline.')) {
    if (
      !keys(r.attributes, ['stage']) ||
      !['capture', 'write', 'export', 'archive', 'mover'].includes(
        r.attributes.stage
      )
    )
      return false
  } else if (r.name.startsWith('server.')) {
    if (
      !keys(r.attributes, ['route', 'status_class']) ||
      !ROUTES.includes(r.attributes.route) ||
      !['2xx', '3xx', '4xx', '5xx', 'aborted'].includes(
        r.attributes.status_class
      )
    )
      return false
  } else if (!keys(r.attributes, [])) return false
  if (r.type === 'sum')
    return (
      keys(r, [...common, 'aggregationTemporality', 'value']) &&
      r.aggregationTemporality === 'delta' &&
      integer(r.value, m.max)
    )
  if (r.type === 'gauge')
    return (
      keys(r, [
        ...common,
        'value',
        'average',
        'max',
        'sampleCount',
        'coverageMs'
      ]) &&
      number(r.value, m.max) &&
      number(r.average, m.max) &&
      number(r.max, m.max) &&
      r.max >= Math.max(r.average, r.value) &&
      integer(r.sampleCount, 11, 1) &&
      number(r.coverageMs, Math.min(duration, r.sampleCount * 30_000), 1)
    )
  if (
    !keys(r, [
      ...common,
      'aggregationTemporality',
      'count',
      'sum',
      'bucketCounts',
      'explicitBounds'
    ]) ||
    r.aggregationTemporality !== 'delta' ||
    !integer(r.count, 1e6, 1) ||
    !number(r.sum, m.max * r.count)
  )
    return false
  if (
    JSON.stringify(r.explicitBounds) !== JSON.stringify(HISTOGRAM_BOUNDS) ||
    !Array.isArray(r.bucketCounts) ||
    r.bucketCounts.length !== HISTOGRAM_BOUNDS.length + 1 ||
    !r.bucketCounts.every((v) => integer(v, 1e6))
  )
    return false
  const minimum = r.bucketCounts.reduce(
    (sum, count, i) => sum + count * (i === 0 ? 0 : HISTOGRAM_BOUNDS[i - 1]),
    0
  )
  const maximum = r.bucketCounts.reduce(
    (sum, count, i) => sum + count * (HISTOGRAM_BOUNDS[i] ?? m.max),
    0
  )
  return (
    r.bucketCounts.reduce((a, b) => a + b, 0) === r.count &&
    r.sum >= minimum &&
    r.sum <= maximum
  )
}
