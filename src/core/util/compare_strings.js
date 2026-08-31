// @ts-check

/**
 * Sort order for two strings, computed from the characters rather than asked
 * of the host.
 *
 * `String.prototype.localeCompare` with no arguments is the ordering twin of
 * the `toLocaleString` hazard `groupThousands` was written for: it consults
 * the host's default locale and the ICU data the runtime was built with, so
 * the same list prints in one order on an `en-US` box, another on a `de-DE`
 * one, and a third under `--without-intl`, where it collapses back to this
 * comparison anyway. Nineteen shipped comparators asked for it, several of
 * them ordering what `hyp status` and `hyp --help` print, which made the
 * order of a user-visible listing a property of the machine it was printed
 * on.
 *
 * The disagreements are not exotic. On a full-ICU box the root collation puts
 * `a` before `B` where the characters put `B` first, and it puts `_` before
 * `-` where the characters put `-` first, so a single list holding both
 * `ai-gateway` and `ai_gateway_messages` already sorts two ways. What saved
 * the migration to this comparator from reordering anything is that no
 * shipped registry mixes the two spellings inside one list; that is a
 * property of the current names, not a rule, so it is pinned in
 * `test/core/compare-strings.test.js` rather than assumed here.
 *
 * Ordering is by UTF-16 code unit, which is what a bare `[].sort()` gives and
 * what `<` means for strings. For everything these comparators sort (dataset
 * names, source and sink names, command names, contract names, blob keys,
 * file paths) that is the same as code point order, and code point order is
 * also the order S3 lists keys in, so the two blob stores that emulate
 * `listObjects` get closer to the service by using it. The one input that
 * would tell code unit and code point order apart is a string in
 * `U+E000..U+FFFF` compared against one outside the BMP, and none of these
 * callers can produce that.
 *
 * Both arguments have to be strings, and unlike the rest of this barrel that
 * is a contract rather than something the body checks. `<` and `>` are false
 * in both directions for `undefined`, so a non-string argument comes back as
 * `0`: a stable tie that sorts into a plausible-looking but arbitrary order
 * instead of raising. The `localeCompare` this replaced threw on the same
 * input, so the quiet answer is new, and it is the reason the type is not
 * `unknown`: `@ts-check` covers every caller in this repo, and the emitted
 * declaration carries the same requirement out to anything reaching this
 * through `hypaware/core/util`. A guard is deliberately not added here. It
 * would put a `typeof` pair in the inner loop of every sort in the tree, and
 * it would turn a mis-shaped row in a status listing back into a thrown error
 * during rendering, which is a change of behaviour this helper has no business
 * making on its callers' behalf. Coerce at the call site the way
 * `hypaware-core/plugins-workspace/s3/src/query-dataset.js` does if the value
 * may not be a string.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if `a` sorts first, positive if `b` does, 0 if neither
 */
export function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}
