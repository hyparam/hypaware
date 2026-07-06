// @ts-check

import path from 'node:path'

/**
 * Bounded facet extraction from a tool call's `tool_args`. This module is the
 * home for the host-only "what did the shell actually run" recipes that turn an
 * unbounded `tool_args` blob into a validity-gated graph node key. It is kept
 * distinct from `graph-keys.js`: that file is the bridge vocabulary held
 * byte-identical to the GitHub plugin (LLP 0032 §shared-key-vocabulary) and must
 * not accrete host-only recipes; these facets have no cross-repo twin.
 *
 * Every function here is a pure, deterministic function of a single row's data —
 * no cross-row state, no data-window thresholds — so projection stays
 * content-addressed and idempotent (LLP 0023 §content-addressed-ids), and every
 * derived value passes an explicit validity gate before it can key a node
 * (§boundedness-contract). Anything that fails a step returns `null` and mints
 * nothing: fall back rather than mis-key (the LLP 0032 discipline).
 */

/**
 * The `Program` validity gate: a lowercased basename bounded to look like an
 * installed binary. All-numeric tokens are rejected separately (a bare number is
 * never a program). @ref LLP 0073#boundedness-contract [constrained-by] — a
 * tool_args facet may key a node only if deterministically bounded; fail closed.
 */
export const PROGRAM_RE = /^[a-z0-9][a-z0-9._+-]{0,63}$/

/** Command wrappers whose own args precede the real `argv[0]`. */
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'nice', 'time', 'command', 'stdbuf', 'timeout'])

/** Shells that run an inline command string after a `-c` flag cluster. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/** A leading `KEY=VAL` environment assignment (skipped ahead of the command). */
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A short single-dash flag cluster like `-lc` (not a `--long` option). */
const SHORT_FLAG_RE = /^-[A-Za-z]+$/

/** A bare numeric / duration token (`5`, `5s`, `1.5`, `10m`) — a wrapper arg, not a program. */
const NUMERICISH_RE = /^\d+(\.\d+)?[A-Za-z]?$/

/**
 * Resolve the raw command string a shell tool ran. `Bash` names it `command`;
 * the Codex `exec_command` wire shape this repo's fixtures pin is `{"cmd": …}`
 * (see `test/plugins/codex-exchange-projector.test.js`), with `command` as a
 * fallback. `tool_args` is a JSON column that may arrive parsed or as a string,
 * like everywhere else in the contract. Returns `null` when the tool is not a
 * shell tool, the args are unusable, or the command is absent / non-string.
 *
 * @param {unknown} toolName
 * @param {unknown} toolArgs
 * @returns {string | null}
 */
export function commandStringFrom(toolName, toolArgs) {
  const name = asString(toolName)
  if (!name) return null
  const parsed = parseMaybeJson(toolArgs)
  if (!parsed || typeof parsed !== 'object') return null
  const obj = /** @type {Record<string, unknown>} */ (parsed)
  if (name === 'Bash') return asString(obj.command)
  if (name === 'exec_command') return asString(obj.cmd) ?? asString(obj.command)
  return null
}

/**
 * Extract the `Program` node key — the validity-gated, lowercased
 * `basename(argv[0])` of the *first* command in a shell string. Deterministic
 * and fail-closed: any step that cannot cleanly resolve a bounded token returns
 * `null` (mint nothing rather than mis-key).
 *
 * @ref LLP 0073#program-derivation [implements] — first-segment argv[0]
 * extraction; the quote-blind connector split is safe because only the head of
 * the first segment is consumed, so a connector inside quotes can at worst
 * truncate the discarded tail, never corrupt argv[0].
 *
 * @param {unknown} command  the raw command string (or null from commandStringFrom)
 * @param {number} [depth]  recursion depth for `shell -c` unwrap, capped at 2
 * @returns {string | null}
 */
export function programFrom(command, depth = 0) {
  if (typeof command !== 'string' || command.length === 0) return null

  // 1. First segment only: cut at the first pipeline/list connector. Quote-blind
  //    by design (only the segment head is consumed).
  const segment = firstSegment(command)

  // 2. Drop a leading subshell `(` and surrounding whitespace, then tokenize
  //    with quote awareness (so a `-c "…"` argument stays one token).
  const tokens = tokenize(segment.replace(/^[\s(]+/, ''))

  let i = 0
  // Bounded guard: tokens.length is finite; the guard only defends against a
  // logic slip, never the input size.
  for (let guard = 0; i < tokens.length && guard < 256; guard++) {
    const tok = tokens[i]

    // 3. Skip a leading `KEY=VAL` env assignment.
    if (ENV_RE.test(tok)) {
      i++
      continue
    }

    const norm = basenameLower(tok)

    // 4. Unwrap a known wrapper: drop it, then skip its own flags, further
    //    env assignments, and bare numeric/duration args (e.g. `timeout 5 …`).
    if (WRAPPERS.has(norm)) {
      i++
      while (i < tokens.length && (isFlag(tokens[i]) || ENV_RE.test(tokens[i]) || NUMERICISH_RE.test(tokens[i]))) {
        i++
      }
      continue
    }

    // 5. Unwrap `shell -c "<real command>"`: Codex wraps most calls in
    //    `bash -lc "…"`. Only when a short flag cluster carries `c` and an
    //    inline command token follows do we recurse into that command (the
    //    tokenizer has already stripped its quotes). Depth-capped at 2. A
    //    `bash script.sh` with no `-c` keeps `bash` as the program.
    if (SHELLS.has(norm) && depth < 2) {
      let j = i + 1
      let hasC = false
      while (j < tokens.length && isFlag(tokens[j])) {
        if (SHORT_FLAG_RE.test(tokens[j]) && tokens[j].includes('c')) hasC = true
        j++
      }
      if (hasC && j < tokens.length) {
        return programFrom(tokens[j], depth + 1)
      }
      // no `-c`: the shell itself is the program.
    }

    // 6 + 7. This token is argv[0]: basename + lowercase (done in `norm`), then
    //        gate into the bounded domain.
    return gateProgram(norm)
  }

  return null
}

/**
 * Apply the `Program` validity gate: reject empty, all-numeric, and
 * out-of-domain tokens. @ref LLP 0073#boundedness-contract [constrained-by] —
 * the gate (not a threshold) is the cardinality bound, so extraction stays a
 * pure per-row function.
 *
 * @param {string} prog  an already-lowercased basename
 * @returns {string | null}
 */
function gateProgram(prog) {
  if (!prog) return null
  if (/^\d+$/.test(prog)) return null
  if (!PROGRAM_RE.test(prog)) return null
  return prog
}

/**
 * Keep only the head up to the first pipeline/list connector (`|`, `&&`, `;`,
 * or a newline). `||` is covered by `|`; a single `&` (background) is not a cut.
 *
 * @param {string} s
 * @returns {string}
 */
function firstSegment(s) {
  let end = s.length
  for (const mark of ['|', '&&', ';', '\n', '\r']) {
    const idx = s.indexOf(mark)
    if (idx !== -1 && idx < end) end = idx
  }
  return s.slice(0, end)
}

/**
 * Split a command segment into tokens, respecting single and double quotes so a
 * `-c "git commit -m x"` argument stays one token. Quotes are stripped from the
 * emitted tokens; adjacent quoted and bare runs join into one token
 * (`a"b"c` → `abc`). Backslash escapes `\"` and `\\` inside double quotes.
 *
 * @param {string} s
 * @returns {string[]}
 */
function tokenize(s) {
  /** @type {string[]} */
  const tokens = []
  let cur = ''
  let started = false
  let inSingle = false
  let inDouble = false
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]
    if (inSingle) {
      if (ch === "'") inSingle = false
      else cur += ch
      started = true
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else if (ch === '\\' && (s[k + 1] === '"' || s[k + 1] === '\\')) {
        cur += s[k + 1]
        k++
      } else cur += ch
      started = true
      continue
    }
    if (ch === "'") {
      inSingle = true
      started = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += ch
    started = true
  }
  if (started) tokens.push(cur)
  return tokens
}

/**
 * `true` for a token that begins a flag (`-x`, `--long`, `--`).
 *
 * @param {string} tok
 * @returns {boolean}
 */
function isFlag(tok) {
  return tok.startsWith('-')
}

/**
 * Lowercased basename of a possibly-pathed token (`/opt/homebrew/bin/DuckDB` →
 * `duckdb`), so path-invoked and bare invocations converge.
 *
 * @param {string} tok
 * @returns {string}
 */
function basenameLower(tok) {
  return path.basename(tok).toLowerCase()
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * A command string must be a genuine non-empty string; unlike the contract's
 * `str`, a numeric `tool_args.command` is not coerced (it is not a command).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}
