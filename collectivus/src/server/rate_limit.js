/**
 * Sliding-window rate limiter keyed by an arbitrary string (IP, gatewayId,
 * etc). On each `check` call the limiter drops timestamps older than
 * `windowMs`, decides whether the new event is allowed, and (on allow)
 * records it. There is no LRU/eviction beyond the per-key window; for the
 * workloads this serves (bootstrap = rare, refresh = once/min/gateway), the
 * in-memory footprint stays bounded.
 */
export class SlidingWindowRateLimiter {
  /**
   * @param {{ windowMs: number, max: number, now?: () => number }} opts
   */
  constructor(opts) {
    if (!Number.isInteger(opts?.windowMs) || opts.windowMs <= 0) {
      throw new Error('SlidingWindowRateLimiter: windowMs must be a positive integer')
    }
    if (!Number.isInteger(opts.max) || opts.max <= 0) {
      throw new Error('SlidingWindowRateLimiter: max must be a positive integer')
    }
    /** @type {number} */
    this.windowMs = opts.windowMs
    /** @type {number} */
    this.max = opts.max
    /** @type {() => number} */
    this.now = opts.now ?? Date.now
    /** @type {Map<string, number[]>} */
    this.events = new Map()
  }

  /**
   * Decide whether `key` may proceed. On allow, records the event.
   *
   * @param {string} key
   * @returns {{ allowed: boolean, retryAfterMs: number }}
   */
  check(key) {
    const nowMs = this.now()
    const cutoff = nowMs - this.windowMs
    const stamps = this.events.get(key) ?? []
    const fresh = stamps.filter((t) => t > cutoff)
    if (fresh.length >= this.max) {
      const oldest = fresh[0]
      const retryAfterMs = Math.max(0, oldest + this.windowMs - nowMs)
      this.events.set(key, fresh)
      return { allowed: false, retryAfterMs }
    }
    fresh.push(nowMs)
    this.events.set(key, fresh)
    return { allowed: true, retryAfterMs: 0 }
  }
}

/**
 * Token bucket used to enforce per-process throughput ceilings. The standard
 * "capacity = burst allowance, refill at a configured rate" shape allows
 * callers to decide how much burst tolerance and sustained throughput they
 * want.
 *
 * Tokens are refilled lazily on each `tryConsume` so we don't burn an interval
 * timer per bucket instance.
 */
export class TokenBucket {
  /**
   * @param {{ capacity: number, refillPerSecond: number, now: () => number }} opts
   */
  constructor(opts) {
    /** @type {number} */
    this.capacity = opts.capacity
    /** @type {number} */
    this.refillPerSecond = opts.refillPerSecond
    /** @type {() => number} */
    this.now = opts.now
    /** @type {number} */
    this.tokens = opts.capacity
    /** @type {number} */
    this.lastRefillMs = opts.now()
  }

  /**
   * Add tokens accrued since the previous refill. Idempotent and cheap —
   * safe to call before every consume / inspection.
   *
   * @returns {void}
   */
  refill() {
    const nowMs = this.now()
    const elapsedMs = nowMs - this.lastRefillMs
    if (elapsedMs <= 0) return
    const accrued = elapsedMs * this.refillPerSecond / 1000
    this.tokens = Math.min(this.capacity, this.tokens + accrued)
    this.lastRefillMs = nowMs
  }

  /**
   * Attempt to debit `cost` tokens. Returns true on success and consumes the
   * tokens; returns false (and leaves the bucket untouched) when there's not
   * enough slack. A `cost` larger than `capacity` always fails — the bucket
   * can never grow past its ceiling.
   *
   * @param {number} cost
   * @returns {boolean}
   */
  tryConsume(cost) {
    this.refill()
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }

  /**
   * Tokens currently available, after a fresh refill. Exposed for tests and
   * future observability hooks.
   *
   * @returns {number}
   */
  available() {
    this.refill()
    return this.tokens
  }
}
