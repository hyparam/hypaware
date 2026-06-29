// @ts-check

import {
  asObject,
  attrsToObject,
  bigIntLike,
  intLike,
  normalizeScope,
  numberValue,
  otlpTimestampToIso,
  stringValue,
} from './common.js'

/**
 * Flatten an `ExportMetricsServiceRequest` JSON envelope into one row per
 * data point. Row keys line up with `METRICS_COLUMNS` in `../datasets.js`.
 * Covers gauge, sum, histogram, exponential histogram, and summary metric
 * shapes: matching the donor's collector.js logic but written fresh
 * against the camelCase JSON wire form.
 *
 * @param {unknown} payload
 * @returns {Record<string, unknown>[]}
 */
export function flattenOtlpMetrics(payload) {
  const root = asObject(payload)
  const resourceMetrics = Array.isArray(root?.resourceMetrics) ? root.resourceMetrics : []
  /** @type {Record<string, unknown>[]} */
  const rows = []

  for (const resourceMetric of resourceMetrics) {
    const rmo = asObject(resourceMetric) ?? {}
    const resource = asObject(rmo.resource)
    const resourceAttrs = attrsToObject(resource?.attributes)
    const serviceName = pickServiceName(resourceAttrs)
    const scopeMetrics = Array.isArray(rmo.scopeMetrics) ? rmo.scopeMetrics : []

    for (const scopeMetric of scopeMetrics) {
      const smo = asObject(scopeMetric) ?? {}
      const scope = normalizeScope(smo.scope)
      const metrics = Array.isArray(smo.metrics) ? smo.metrics : []

      for (const metric of metrics) {
        const mo = asObject(metric) ?? {}
        const base = {
          serviceName,
          metricName: stringValue(mo.name),
          description: stringValue(mo.description),
          unit: stringValue(mo.unit),
          metadata: attrsToObject(mo.metadata),
          resource: resourceAttrs,
          scope_name: scope.scope_name,
          scope_version: scope.scope_version,
          scope_attributes: scope.scope_attributes,
        }
        appendNumberRows(rows, base, 'gauge', asObject(mo.gauge))
        appendNumberRows(rows, base, 'sum', asObject(mo.sum))
        appendHistogramRows(rows, base, asObject(mo.histogram))
        appendExpHistogramRows(rows, base, asObject(mo.exponentialHistogram))
        appendSummaryRows(rows, base, asObject(mo.summary))
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
 * @param {Record<string, unknown>[]} out
 * @param {Record<string, unknown>} base
 * @param {'gauge' | 'sum'} metricType
 * @param {Record<string, unknown> | null} container
 */
function appendNumberRows(out, base, metricType, container) {
  if (!container) return
  const dataPoints = Array.isArray(container.dataPoints) ? container.dataPoints : []
  for (const point of dataPoints) {
    const po = asObject(point) ?? {}
    const { value, valueInt, valueType } = pickNumberPointValue(po)
    out.push({
      ...base,
      metricType,
      aggregationTemporality: intLike(container.aggregationTemporality),
      isMonotonic: typeof container.isMonotonic === 'boolean' ? container.isMonotonic : null,
      startTimestamp: otlpTimestampToIso(po.startTimeUnixNano),
      timestamp: otlpTimestampToIso(po.timeUnixNano),
      flags: intLike(po.flags),
      value,
      valueInt,
      valueType,
      count: null,
      sum: null,
      min: null,
      max: null,
      bucketCounts: null,
      explicitBounds: null,
      scale: null,
      zeroCount: null,
      zeroThreshold: null,
      positive: null,
      negative: null,
      quantileValues: null,
      exemplars: normalizeExemplars(po.exemplars),
      attributes: attrsToObject(po.attributes),
    })
  }
}

/**
 * @param {Record<string, unknown>[]} out
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown> | null} histogram
 */
function appendHistogramRows(out, base, histogram) {
  if (!histogram) return
  const dataPoints = Array.isArray(histogram.dataPoints) ? histogram.dataPoints : []
  for (const point of dataPoints) {
    const po = asObject(point) ?? {}
    out.push({
      ...base,
      metricType: 'histogram',
      aggregationTemporality: intLike(histogram.aggregationTemporality),
      isMonotonic: null,
      startTimestamp: otlpTimestampToIso(po.startTimeUnixNano),
      timestamp: otlpTimestampToIso(po.timeUnixNano),
      flags: intLike(po.flags),
      value: null,
      valueInt: null,
      valueType: null,
      count: bigIntLike(po.count),
      sum: numberValue(po.sum),
      min: numberValue(po.min),
      max: numberValue(po.max),
      bucketCounts: Array.isArray(po.bucketCounts) ? po.bucketCounts : null,
      explicitBounds: Array.isArray(po.explicitBounds) ? po.explicitBounds : null,
      scale: null,
      zeroCount: null,
      zeroThreshold: null,
      positive: null,
      negative: null,
      quantileValues: null,
      exemplars: normalizeExemplars(po.exemplars),
      attributes: attrsToObject(po.attributes),
    })
  }
}

/**
 * @param {Record<string, unknown>[]} out
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown> | null} histogram
 */
function appendExpHistogramRows(out, base, histogram) {
  if (!histogram) return
  const dataPoints = Array.isArray(histogram.dataPoints) ? histogram.dataPoints : []
  for (const point of dataPoints) {
    const po = asObject(point) ?? {}
    out.push({
      ...base,
      metricType: 'exponentialHistogram',
      aggregationTemporality: intLike(histogram.aggregationTemporality),
      isMonotonic: null,
      startTimestamp: otlpTimestampToIso(po.startTimeUnixNano),
      timestamp: otlpTimestampToIso(po.timeUnixNano),
      flags: intLike(po.flags),
      value: null,
      valueInt: null,
      valueType: null,
      count: bigIntLike(po.count),
      sum: numberValue(po.sum),
      min: numberValue(po.min),
      max: numberValue(po.max),
      bucketCounts: null,
      explicitBounds: null,
      scale: intLike(po.scale),
      zeroCount: bigIntLike(po.zeroCount),
      zeroThreshold: numberValue(po.zeroThreshold),
      positive: normalizeExpBuckets(po.positive),
      negative: normalizeExpBuckets(po.negative),
      quantileValues: null,
      exemplars: normalizeExemplars(po.exemplars),
      attributes: attrsToObject(po.attributes),
    })
  }
}

/**
 * @param {Record<string, unknown>[]} out
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown> | null} summary
 */
function appendSummaryRows(out, base, summary) {
  if (!summary) return
  const dataPoints = Array.isArray(summary.dataPoints) ? summary.dataPoints : []
  for (const point of dataPoints) {
    const po = asObject(point) ?? {}
    out.push({
      ...base,
      metricType: 'summary',
      aggregationTemporality: null,
      isMonotonic: null,
      startTimestamp: otlpTimestampToIso(po.startTimeUnixNano),
      timestamp: otlpTimestampToIso(po.timeUnixNano),
      flags: intLike(po.flags),
      value: null,
      valueInt: null,
      valueType: null,
      count: bigIntLike(po.count),
      sum: numberValue(po.sum),
      min: null,
      max: null,
      bucketCounts: null,
      explicitBounds: null,
      scale: null,
      zeroCount: null,
      zeroThreshold: null,
      positive: null,
      negative: null,
      quantileValues: normalizeQuantileValues(po.quantileValues),
      exemplars: null,
      attributes: attrsToObject(po.attributes),
    })
  }
}

/**
 * @param {Record<string, unknown>} point
 * @returns {{ value: number | null, valueInt: bigint | null, valueType: 'double' | 'int' | null }}
 */
function pickNumberPointValue(point) {
  if ('asDouble' in point) {
    return { value: numberValue(point.asDouble), valueInt: null, valueType: 'double' }
  }
  if ('asInt' in point) {
    return { value: null, valueInt: bigIntLike(point.asInt), valueType: 'int' }
  }
  return { value: null, valueInt: null, valueType: null }
}

/**
 * @param {unknown} buckets
 */
function normalizeExpBuckets(buckets) {
  const obj = asObject(buckets)
  if (!obj) return null
  return {
    offset: intLike(obj.offset),
    bucketCounts: Array.isArray(obj.bucketCounts) ? obj.bucketCounts : null,
  }
}

/**
 * @param {unknown} quantileValues
 */
function normalizeQuantileValues(quantileValues) {
  if (!Array.isArray(quantileValues)) return null
  return quantileValues.map((q) => {
    const qo = asObject(q) ?? {}
    return {
      quantile: numberValue(qo.quantile),
      value: numberValue(qo.value),
    }
  })
}

/**
 * @param {unknown} exemplars
 */
function normalizeExemplars(exemplars) {
  if (!Array.isArray(exemplars)) return null
  return exemplars.map((exemplar) => {
    const eo = asObject(exemplar) ?? {}
    const valueType = 'asDouble' in eo ? 'double' : 'asInt' in eo ? 'int' : null
    const value =
      valueType === 'double'
        ? numberValue(eo.asDouble)
        : valueType === 'int'
          ? bigIntLike(eo.asInt)
          : null
    return {
      timestamp: otlpTimestampToIso(eo.timeUnixNano),
      value,
      valueType,
      traceId: stringValue(eo.traceId),
      spanId: stringValue(eo.spanId),
      filteredAttributes: attrsToObject(eo.filteredAttributes),
    }
  })
}
