// @ts-check

import { buildAttrs } from './attrs.js'
import { getTracer } from './tracer.js'
import { context, ROOT_CONTEXT, SpanStatusCode } from './runtime.js'

/**
 * @import { Span } from './runtime.js'
 */

/**
 * Spans whose terminal status was declared during the run rather than at
 * creation. Keyed on the span itself, so a helper called deep inside the
 * body reaches the `withSpan` frame that owns the status code without
 * threading a handle through every caller.
 *
 * @type {WeakMap<Span, string>}
 */
const declaredStatuses = new WeakMap()

/**
 * Declare a span's terminal status from inside its body, for work that
 * finishes without throwing but did not finish cleanly.
 *
 * `withSpan` and `runRoot` otherwise read `status` from the attributes they
 * were given when the span opened, so a later `setAttribute('status', ...)`
 * lands as an attribute on a span that still ends `OK`. Both helpers honor
 * a declaration made here, because this takes a span rather than a frame
 * and a caller cannot tell which of the two opened the one it holds.
 *
 * Opt-in rather than a live re-read of the attribute on purpose: many spans
 * in this repo write `status` late with values like `skipped` or `partial`
 * whose status codes were never argued about, and reclassifying them as a
 * side effect of one caller's need is not this helper's decision to make.
 *
 * @ref LLP 0322#degrade-reaches-the-signals [implements]: an opt-in terminal status, so only the call site that asks is reclassified
 * @param {Span | null | undefined} span
 * @param {string} status
 */
export function markSpanStatus(span, status) {
  if (!span) return
  span.setAttribute('status', status)
  declaredStatuses.set(span, status)
}

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
      const status = declaredStatuses.get(span) ?? sanitized.status
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
        // Read the same declared status `withSpan` does. `markSpanStatus` is
        // exported from the package's public observability surface and takes
        // a span, not a frame, so a caller cannot tell which helper opened
        // the one it was handed; honoring it in only one of the two would
        // make it silently inert on every boot and top-level command span.
        const status = declaredStatuses.get(span) ?? sanitized.status
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
