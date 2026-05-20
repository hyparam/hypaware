// @ts-check

import {
  asObject,
  attrsToObject,
  intLike,
  normalizeScope,
  otlpDurationMs,
  otlpTimestampToIso,
  stringValue,
} from './common.js'

/**
 * Flatten an `ExportTraceServiceRequest` JSON envelope into one row per
 * span. Row keys line up with `TRACES_COLUMNS` in `../datasets.js`.
 *
 * @param {unknown} payload
 * @returns {Record<string, unknown>[]}
 */
export function flattenOtlpTraces(payload) {
  const root = asObject(payload)
  const resourceSpans = Array.isArray(root?.resourceSpans) ? root.resourceSpans : []
  /** @type {Record<string, unknown>[]} */
  const rows = []

  for (const resourceSpan of resourceSpans) {
    const rso = asObject(resourceSpan) ?? {}
    const resource = asObject(rso.resource)
    const resourceAttrs = attrsToObject(resource?.attributes)
    const serviceName = pickServiceName(resourceAttrs)
    const scopeSpans = Array.isArray(rso.scopeSpans) ? rso.scopeSpans : []

    for (const scopeSpan of scopeSpans) {
      const sso = asObject(scopeSpan) ?? {}
      const scope = normalizeScope(sso.scope)
      const spans = Array.isArray(sso.spans) ? sso.spans : []

      for (const span of spans) {
        const so = asObject(span) ?? {}
        rows.push({
          serviceName,
          traceId: stringValue(so.traceId),
          spanId: stringValue(so.spanId),
          parentSpanId: stringValue(so.parentSpanId),
          name: stringValue(so.name),
          kind: intLike(so.kind),
          traceState: stringValue(so.traceState),
          startTimestamp: otlpTimestampToIso(so.startTimeUnixNano),
          endTimestamp: otlpTimestampToIso(so.endTimeUnixNano),
          durationMs: otlpDurationMs(so.startTimeUnixNano, so.endTimeUnixNano),
          flags: intLike(so.flags),
          droppedAttributesCount: intLike(so.droppedAttributesCount),
          droppedEventsCount: intLike(so.droppedEventsCount),
          droppedLinksCount: intLike(so.droppedLinksCount),
          status: normalizeStatus(so.status),
          resource: resourceAttrs,
          scope_name: scope.scope_name,
          scope_version: scope.scope_version,
          scope_attributes: scope.scope_attributes,
          attributes: attrsToObject(so.attributes),
          events: normalizeEvents(so.events),
          links: normalizeLinks(so.links),
        })
      }
    }
  }

  return rows
}

/**
 * @param {Record<string, unknown> | null} resourceAttrs
 */
function pickServiceName(resourceAttrs) {
  if (!resourceAttrs) return '_unknown'
  const raw = resourceAttrs['service.name']
  return typeof raw === 'string' && raw.length > 0 ? raw : '_unknown'
}

/**
 * @param {unknown} status
 */
function normalizeStatus(status) {
  const obj = asObject(status)
  if (!obj) return null
  return {
    code: intLike(obj.code),
    message: stringValue(obj.message),
  }
}

/**
 * @param {unknown} events
 */
function normalizeEvents(events) {
  if (!Array.isArray(events)) return null
  return events.map((event) => {
    const eo = asObject(event) ?? {}
    return {
      timestamp: otlpTimestampToIso(eo.timeUnixNano),
      name: stringValue(eo.name),
      droppedAttributesCount: intLike(eo.droppedAttributesCount),
      attributes: attrsToObject(eo.attributes),
    }
  })
}

/**
 * @param {unknown} links
 */
function normalizeLinks(links) {
  if (!Array.isArray(links)) return null
  return links.map((link) => {
    const lo = asObject(link) ?? {}
    return {
      traceId: stringValue(lo.traceId),
      spanId: stringValue(lo.spanId),
      traceState: stringValue(lo.traceState),
      flags: intLike(lo.flags),
      droppedAttributesCount: intLike(lo.droppedAttributesCount),
      attributes: attrsToObject(lo.attributes),
    }
  })
}
