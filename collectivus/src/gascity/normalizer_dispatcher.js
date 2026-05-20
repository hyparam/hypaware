import { passthroughNormalize } from './passthrough.js'

/**
 * @import { NormalizerFn, SessionContext } from './types.d.ts'
 * @import { NormalizedRow } from './normalizers/types.d.ts'
 * @import { ParquetWriter } from './parquet_writer.js'
 */

/**
 * Pluggable provider → normalizer registry. Bead 1 shipped stubs for `claude`,
 * `codex`, and an unknown-provider passthrough so the rest of the source could
 * be exercised end-to-end. Bead 2 swaps in the real `claude` normalizer (via
 * `registerProductionNormalizers`); bead 3 replaces the passthrough stub with
 * `passthroughNormalize` (one `raw_frame` row per frame) and wires the
 * dispatcher to a `ParquetWriter` — normalizers return rows and the dispatcher
 * hands them off to the writer. Bead 4 will do the same for `codex`.
 *
 * The dispatcher is intentionally small: lookup-by-provider, call the
 * registered fn (or fall through to passthrough), hand any returned rows to
 * the writer, and never throw. A normalizer raising on a single frame is
 * logged and `dispatch` returns an empty array — one malformed payload must
 * not stop the stream.
 */
export class NormalizerDispatcher {
  /**
   * @param {{
   *   stderr?: { write: (s: string) => void },
   *   writer?: ParquetWriter,
   * }} [opts]
   */
  constructor(opts = {}) {
    /** @type {Map<string, NormalizerFn>} */
    this.registry = new Map()
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr ?? process.stderr
    /** @type {ParquetWriter | undefined} */
    this.writer = opts.writer
    /** @type {NormalizerFn} */
    this.passthrough = passthroughNormalize
    /** @type {Set<Promise<void>>} */
    this.pendingAppends = new Set()
    this.register('claude', claudeStub)
    this.register('codex', codexStub)
  }

  /**
   * Register or replace a normalizer for `provider`. The registered function
   * is invoked with the raw frame plus a per-session context object and may
   * return zero or more `NormalizedRow`s for the writer.
   *
   * @param {string} provider
   * @param {NormalizerFn} fn
   * @returns {void}
   */
  register(provider, fn) {
    this.registry.set(provider, fn)
  }

  /**
   * Attach (or replace) the writer the dispatcher hands rows to. Useful when
   * tests construct a dispatcher first and a writer second, or when the
   * daemon swaps in a stub writer for a soak test.
   *
   * @param {ParquetWriter | undefined} writer
   * @returns {void}
   */
  setWriter(writer) {
    this.writer = writer
  }

  /**
   * Wait for every writer append that dispatch has handed off so far. Live
   * streaming can let appends run in the background, but short-lived paths
   * like `ctvs gascity backfill` must drain them before stopping the writer.
   *
   * @returns {Promise<void>}
   */
  async drain() {
    while (this.pendingAppends.size > 0) {
      await Promise.allSettled(Array.from(this.pendingAppends))
    }
  }

  /**
   * Resolve `provider` from the frame envelope and dispatch. The supervisor's
   * `format=raw` envelope wraps each provider frame in `{ provider, frame }`
   * (or similar); we look at common positions and fall through to passthrough
   * when the provider can't be determined. Any normalizer error is caught and
   * logged, and an empty row array is returned so a single bad frame never
   * derails the worker loop.
   *
   * Returns the rows the normalizer emitted (already forwarded to the writer
   * if one is attached). Tests use the return value to assert normalizer
   * output without instantiating a writer.
   *
   * @param {unknown} envelope The full frame envelope as parsed from the SSE `data:` field.
   * @param {SessionContext} ctx
   * @returns {NormalizedRow[]}
   */
  dispatch(envelope, ctx) {
    /** @type {NormalizedRow[]} */
    const allRows = []
    for (const unit of expandDispatchUnits(envelope)) {
      const provider = unit.provider ?? resolveProvider(unit.frame) ?? 'unknown'
      const registered = this.registry.get(provider)
      const fn = registered ?? this.passthrough
      const input = registered !== undefined ? unit.frame : unit.passthroughEnvelope ?? unit.frame
      /** @type {NormalizedRow[] | undefined | void} */
      let rows
      try {
        rows = fn(input, ctx)
      } catch (err) {
        this.stderr.write(
          `[gascity] normalizer error provider=${provider} session=${ctx.sessionId} err=${formatError(err)}\n`
        )
        continue
      }
      const out = Array.isArray(rows) ? rows : []
      if (out.length === 0) continue
      allRows.push(...out)
      if (this.writer) {
        // Writer.append is async but we don't block dispatch — appending only
        // buffers and any triggered flush failures land on the writer's own
        // error path. We surface a top-level "writer rejected" only if append
        // itself throws synchronously (defensive — current ParquetWriter
        // returns a promise unconditionally).
        const pending = this.writer.append(ctx, out).catch((err) => {
          this.stderr.write(
            `[gascity] writer_append_failed provider=${provider} session=${ctx.sessionId} err=${formatError(err)}\n`
          )
        })
        this.pendingAppends.add(pending)
        pending.finally(() => this.pendingAppends.delete(pending))
      }
    }
    return allRows
  }
}

/**
 * Pull the provider tag off a frame envelope. The supervisor's `format=raw`
 * stream nests the actual provider frame; we look at the most common
 * positions before giving up. Returns `undefined` so the caller can fall
 * through to passthrough.
 *
 * @param {unknown} envelope
 * @returns {string | undefined}
 */
export function resolveProvider(envelope) {
  if (envelope === null || typeof envelope !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (envelope)
  if (typeof obj.provider === 'string') return obj.provider
  if (obj.response && typeof obj.response === 'object') {
    const resp = /** @type {Record<string, unknown>} */ (obj.response)
    if (typeof resp.provider === 'string') return resp.provider
  }
  if (obj.frame && typeof obj.frame === 'object') {
    const frame = /** @type {Record<string, unknown>} */ (obj.frame)
    if (typeof frame.provider === 'string') return frame.provider
  }
  return undefined
}

/**
 * @typedef {{
 *   frame: unknown,
 *   provider?: string,
 *   passthroughEnvelope?: unknown,
 * }} DispatchUnit
 */

/**
 * The supervisor can send a provider frame directly, wrap a frame as
 * `{ provider, frame }`, or return transcript snapshots as
 * `{ provider, messages: [...] }`. Provider normalizers want the inner frame;
 * passthrough wants a provider-bearing envelope when one exists.
 *
 * @param {unknown} envelope
 * @returns {DispatchUnit[]}
 */
function expandDispatchUnits(envelope) {
  if (envelope === null || typeof envelope !== 'object') return [{ frame: envelope }]
  const obj = /** @type {Record<string, unknown>} */ (envelope)
  const provider = typeof obj.provider === 'string' ? obj.provider : undefined
  for (const key of ['messages', 'frames', 'transcript']) {
    const nested = obj[key]
    if (Array.isArray(nested)) {
      return nested.map((frame) => dispatchUnit(frame, provider))
    }
  }
  if (obj.frame !== null && typeof obj.frame === 'object' && !Array.isArray(obj.frame)) {
    /** @type {DispatchUnit} */
    const unit = {
      frame: obj.frame,
      passthroughEnvelope: envelope,
    }
    if (provider !== undefined) unit.provider = provider
    return [unit]
  }
  /** @type {DispatchUnit} */
  const unit = { frame: envelope }
  if (provider !== undefined) unit.provider = provider
  return [unit]
}

/**
 * @param {unknown} frame
 * @param {string | undefined} provider
 * @returns {DispatchUnit}
 */
function dispatchUnit(frame, provider) {
  /** @type {DispatchUnit} */
  const unit = { frame }
  if (provider !== undefined) {
    unit.provider = provider
    unit.passthroughEnvelope = { provider, frame }
  }
  return unit
}

/**
 * Bead-1 stub for the `claude` slot. Bead 2 replaces it via
 * `registerProductionNormalizers` in `./normalizers/index.js`; until that
 * runs we emit no rows so callers can still exercise the dispatch path
 * end-to-end. The stub signature matches `NormalizerFn` so swapping the
 * production normalizer in doesn't change call sites.
 *
 * @type {NormalizerFn}
 */
function claudeStub() {
  return []
}

/**
 * Bead-4 stub. See `claudeStub`.
 *
 * @type {NormalizerFn}
 */
function codexStub() {
  return []
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
