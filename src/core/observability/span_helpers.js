// @ts-check

import { buildAttrs } from './attrs.js'
import { getTracer } from './tracer.js'
import { context, ROOT_CONTEXT, SpanStatusCode } from './runtime.js'

/**
 * @import { Span } from './runtime.js'
 */

/**
 * Run `fn` inside a span. Records the result on the span (status + any
 * thrown error) and propagates the original return value.
 *
 * `withSpan` reads its parent from the active OTel context. Callers
 * who need a root span (independent of any in-flight context) should
 * use `runRoot` instead.
 *
 * @template T
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @param {(span: Span) => T|Promise<T>} fn
 * @param {{ component?: string }} [opts]
 * @returns {Promise<T>}
 * @ref LLP 0021#span-helpers [implements]: inherits active context as parent; records status + error_kind
 */
export async function withSpan(name, attrs, fn, opts = {}) {
  const tracer = getTracer(opts.component ?? 'kernel')
  const sanitized = buildAttrs(attrs)
  return tracer.startActiveSpan(name, { attributes: sanitized }, async (span) => {
    try {
      const result = await fn(span)
      const status = sanitized.status
      if (typeof status !== 'string' || status === 'ok') {
        span.setStatus({ code: SpanStatusCode.OK })
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(status) })
      }
      return result
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      span.recordException(err)
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
      span.setAttribute('error_kind', sanitized.error_kind ?? 'unhandled_exception')
      throw err
    } finally {
      span.end()
    }
  })
}

/**
 * Run `fn` inside a fresh root span (no parent context, no propagated
 * trace). Used for unit-of-work that is logically a kernel boot or a
 * top-level command invocation.
 *
 * @template T
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 * @param {(span: Span) => T|Promise<T>} fn
 * @param {{ component?: string }} [opts]
 * @returns {Promise<T>}
 * @ref LLP 0021#span-helpers [implements]: fresh root span (no parent) for boots / top-level commands
 */
export async function runRoot(name, attrs, fn, opts = {}) {
  const tracer = getTracer(opts.component ?? 'kernel')
  const sanitized = buildAttrs(attrs)
  return context.with(ROOT_CONTEXT, () => (
    tracer.startActiveSpan(name, { attributes: sanitized, root: true }, async (span) => {
      try {
        const result = await fn(span)
        const status = sanitized.status
        if (typeof status !== 'string' || status === 'ok') {
          span.setStatus({ code: SpanStatusCode.OK })
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(status) })
        }
        return result
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        span.recordException(err)
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
        span.setAttribute('error_kind', sanitized.error_kind ?? 'unhandled_exception')
        throw err
      } finally {
        span.end()
      }
    })
  ))
}
