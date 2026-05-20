// @ts-check

import {
  anyValue,
  attrsToObject,
  intLike,
  normalizeScope,
  otlpTimestampToIso,
  stringValue,
  asObject,
} from './common.js'

/**
 * Flatten an `ExportLogsServiceRequest` JSON envelope into one row per
 * log record. Row keys line up with `LOGS_COLUMNS` in `../datasets.js`.
 *
 * @param {unknown} payload
 * @returns {Record<string, unknown>[]}
 */
export function flattenOtlpLogs(payload) {
  const root = asObject(payload)
  const resourceLogs = Array.isArray(root?.resourceLogs) ? root.resourceLogs : []
  /** @type {Record<string, unknown>[]} */
  const rows = []

  for (const resourceLog of resourceLogs) {
    const rlo = asObject(resourceLog) ?? {}
    const resource = asObject(rlo.resource)
    const resourceAttrs = attrsToObject(resource?.attributes)
    const serviceName = pickServiceName(resourceAttrs)
    const scopeLogs = Array.isArray(rlo.scopeLogs) ? rlo.scopeLogs : []

    for (const scopeLog of scopeLogs) {
      const slo = asObject(scopeLog) ?? {}
      const scope = normalizeScope(slo.scope)
      const logRecords = Array.isArray(slo.logRecords) ? slo.logRecords : []

      for (const record of logRecords) {
        const rec = asObject(record) ?? {}
        rows.push({
          serviceName,
          timestamp: otlpTimestampToIso(rec.timeUnixNano),
          observedTimestamp: otlpTimestampToIso(rec.observedTimeUnixNano),
          severityNumber: intLike(rec.severityNumber),
          severityText: stringValue(rec.severityText),
          body: anyValue(rec.body),
          traceId: stringValue(rec.traceId),
          spanId: stringValue(rec.spanId),
          flags: intLike(rec.flags),
          droppedAttributesCount: intLike(rec.droppedAttributesCount),
          resource: resourceAttrs,
          scope_name: scope.scope_name,
          scope_version: scope.scope_version,
          scope_attributes: scope.scope_attributes,
          attributes: attrsToObject(rec.attributes),
        })
      }
    }
  }

  return rows
}

/**
 * Resolve `service.name` from a resource attribute bag, falling back to
 * `_unknown` so the required `serviceName` column is always populated.
 *
 * @param {Record<string, unknown> | null} resourceAttrs
 */
function pickServiceName(resourceAttrs) {
  if (!resourceAttrs) return '_unknown'
  const raw = resourceAttrs['service.name']
  return typeof raw === 'string' && raw.length > 0 ? raw : '_unknown'
}
