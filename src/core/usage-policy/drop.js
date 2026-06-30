// @ts-check

/**
 * @import { UsagePolicyDrop } from './types.js'
 */

/**
 * Terminal sentinel an adapter's exchange projector returns when an ancestor
 * `.hypignore` resolves the exchange's cwd to `ignore`: this exchange must
 * never be recorded.
 *
 * It is deliberately NOT a bare `undefined`. `undefined` is a projector's "I
 * decline, try the next matching projector" signal, so a drop expressed as
 * `undefined` would (a) fall through to any later overlapping projector, which
 * could then record the very exchange the user asked to suppress, and (b) be
 * logged by the gateway as a `no_projector_match` miss, mislabeling a
 * successful privacy drop as a projection failure. The gateway dispatcher
 * recognizes this sentinel, stops the projector walk on it, and logs it as an
 * intentional usage-policy drop.
 *
 * A frozen singleton, compared by reference identity via `isUsagePolicyDrop`.
 *
 * @ref LLP 0050 [implements]: the capture-seam drop is terminal and observable as a drop, not a projection miss.
 */
export const USAGE_POLICY_DROP = Object.freeze(
  /** @type {UsagePolicyDrop} */ ({ usagePolicyDrop: true })
)

/**
 * Narrow a projector return value to the terminal usage-policy drop sentinel.
 *
 * @param {unknown} value
 * @returns {value is UsagePolicyDrop}
 */
export function isUsagePolicyDrop(value) {
  return value === USAGE_POLICY_DROP
}
