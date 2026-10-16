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
 * Both arguments have to be strings, and this is the one place in the tree
 * that checks. It is not defensiveness: `<` and `>` are false in both
 * directions for `undefined`, so without the check a non-string comes back as
 * `0`, a stable tie that sorts a mis-shaped row into a plausible-looking but
 * arbitrary place and says nothing. That is the same failure this comparator
 * exists to remove - an order that reads like an order and is not - so it is
 * the one answer this body may not give. The rest of this barrel gets the
 * same refusal for free, out of what its bodies happen to do:
 * `escapeForDisplay(undefined)` and `sha256Hex(undefined)` both raise. A
 * comparison raises nothing, so the refusal is written out.
 *
 * The message names the types and never the values. What these comparators
 * sort includes blob keys, file paths and session ids, and an error is a
 * string that reaches a log.
 *
 * @ref LLP 0340#refuse [implements]: a `@param {string}` helper on the
 *   published barrel refuses a non-string rather than answering from it
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if `a` sorts first, positive if `b` does, 0 if neither
 * @throws {TypeError} when either argument is not a string
 */
export function compareStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new TypeError(`compareStrings needs two strings, got ${typeof a} and ${typeof b}`)
  }
  return a < b ? -1 : a > b ? 1 : 0
}
