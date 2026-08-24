// @ts-check

/**
 * A verb operation refusing its own arguments, as opposed to failing at the
 * work it was asked to do.
 *
 * The codec in `verb_codec.js` validates argv against the declared
 * `inputSchema`, and the CLI wrapper turns every refusal it makes into exit 2,
 * the usage code. But a schema of independent properties cannot express every
 * argument rule: a cross-field one (`--from` must not be after `--to`) and a
 * value shape the schema vocabulary has no word for both have to be checked
 * inside `operation`, where the only signal back to the wrapper is a thrown
 * error. Without a way to tell those apart, a mistyped day exits 1, the code
 * for "the search itself failed", and a script cannot distinguish a typo from
 * an unreadable cache.
 *
 * So an operation throws this for a caller's argument mistake and a plain
 * `Error` for everything else; `runVerbCommand` maps this one to exit 2 and
 * prints the usage line beside it, exactly as it does for a codec refusal. On
 * the MCP surface the distinction costs nothing: both are the tool's error
 * text.
 *
 * @ref LLP 0302#usage-exit [implements]: an argument rule the schema cannot express still refuses with the usage code
 * @ref LLP 0293#one-contract [constrained-by]: a caller's argument mistake is exit 2, never exit 1 through a failure downstream of it
 */
export class VerbUsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'VerbUsageError'
  }
}
