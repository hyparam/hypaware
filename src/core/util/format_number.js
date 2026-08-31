// @ts-check

/**
 * Thousands separators for a number a person reads, computed from the digits
 * rather than asked of the host.
 *
 * Every locale-aware route to grouping (`toLocaleString()`,
 * `new Intl.NumberFormat().format()`) reads the machine unless it is handed a
 * locale, and a dropped locale argument is invisible on the box that drops it:
 * one backlog then renders `1,234` on a US machine and `1.234` on a German
 * one, and the test that was supposed to notice is green on both (#1117).
 * Naming a locale fixes the output but keeps the hazard one deletion away, so
 * the grouping here consults nothing: `\B` before each group of three trailing
 * digits, which is the same string on every machine and under every ICU build.
 *
 * Rounds to an integer, because the two callers count things - rows,
 * destinations, directories, tokens - and a count with a fraction in it is
 * already wrong before it is rendered. Non-finite input is the caller's to
 * screen; this is the digit transform, not the empty-value policy.
 *
 * @param {number} n
 * @returns {string}
 */
export function groupThousands(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
