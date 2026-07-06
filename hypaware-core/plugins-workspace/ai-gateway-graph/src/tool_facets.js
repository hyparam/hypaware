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

/**
 * The `Skill` validity gate: the bare skill name, preserved verbatim (no
 * lowercasing: skill directory names are the identity and are conventionally
 * already lowercase; plugin-namespaced `plugin:skill` names keep the
 * namespace). @ref LLP 0073#boundedness-contract [constrained-by]: skill names
 * are bounded by installed skill directories; anything else mints nothing.
 */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/

/**
 * Claude Code built-in slash commands that must not mint `Skill` nodes.
 * @ref LLP 0074#builtin-exclusion [constrained-by]: `<command-name>` conflates
 * built-ins with skills; a live catalog of installed skills would break the
 * pure-function-of-the-row rule, so the gate is this static, trivially
 * editable list. Drift is an accepted residual until the capture-side
 * `skill_activated` signal (LLP 0076): a new built-in mints a spurious Skill
 * until the list is updated, but every real skill slash invocation also
 * injects the surface-2 marker, so no real skill is ever missed.
 */
export const CLAUDE_BUILTIN_COMMANDS = new Set([
  'model', 'compact', 'clear', 'help', 'config', 'cost', 'doctor', 'init',
  'login', 'logout', 'memory', 'status', 'review', 'resume', 'agents', 'bug',
  'mcp', 'permissions', 'hooks', 'ide', 'vim', 'terminal-setup', 'add-dir',
  'bashes', 'context', 'export', 'exit', 'quit', 'rewind', 'statusline',
  'todos', 'upgrade', 'output-style', 'plugins', 'privacy-settings',
  'release-notes', 'pr-comments', 'install-github-app', 'migrate-installer',
])

/**
 * The SKILL.md injection marker, anchored at offset 0. The leading anchor is
 * the entire false-positive defense (LLP 0074 §strict-filters: loose matching
 * pulls ~23% false positives), so it is enforced twice: the rule's SQL
 * prefix-LIKE and this regex.
 */
const SKILL_MARKER_RE = /^Base directory for this skill: (\S+)/

/**
 * The slash-command tag, anchored at offset 0. The captured name may carry a
 * leading `/` (stripped by the optional group before the capture).
 */
const SLASH_COMMAND_RE = /^<command-name>\s*\/?([A-Za-z0-9:_-]+)\s*<\/command-name>/

/**
 * The Codex skill-activation path pattern (LLP 0075 surface 4,
 * `dispatch_shell_read`): an `exec_command` shell read of
 * `.codex/skills/<name>/SKILL.md`. Unanchored (the path may sit anywhere in
 * the command string, e.g. after `sed -n '1,240p'`); the `.codex/skills/`
 * literal plus the `SKILL.md` suffix is the whole false-positive defense, so
 * a Codex session reading some other repo's `.claude/skills/...` tree (no
 * shared signal, LLP 0075 §no-shared-rule) or a bare `.codex/skills/` listing
 * (no `SKILL.md`) matches nothing.
 */
const CODEX_SKILL_READ_RE = /[/~]\.codex\/skills\/([^/\s'"]+)\/SKILL\.md/

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
 * Extract the `Skill` node key from a Claude `Skill` tool call's `tool_args`
 * (LLP 0074 surface 1, model-chosen activation). The name lives in
 * `tool_args.skill` (the issue-confirmed identifier); `tool_args` may arrive
 * parsed or as a JSON string, like everywhere else in the contract.
 *
 * @param {unknown} toolArgs
 * @returns {string | null}
 */
export function skillFromToolArgs(toolArgs) {
  const parsed = parseMaybeJson(toolArgs)
  if (!parsed || typeof parsed !== 'object') return null
  const obj = /** @type {Record<string, unknown>} */ (parsed)
  return gateSkill(asString(obj.skill))
}

/**
 * Extract the `Skill` node key from the SKILL.md injection marker (LLP 0074
 * surface 2). The marker must sit at offset 0 of the user text: a marker that
 * appears mid-message (assistant quoting, query output echoes, pasted
 * transcripts) mints nothing. The name is the basename of the captured base
 * directory after trimming a trailing slash; when the basename is `SKILL.md`
 * (a file rather than a base directory), the parent directory names the skill.
 *
 * @param {unknown} contentText
 * @returns {string | null}
 */
export function skillFromMarker(contentText) {
  if (typeof contentText !== 'string') return null
  const match = SKILL_MARKER_RE.exec(contentText)
  if (!match) return null
  const dir = match[1].replace(/\/+$/, '')
  let name = path.basename(dir)
  if (name === 'SKILL.md') name = path.basename(path.dirname(dir))
  return gateSkill(name)
}

/**
 * Extract the `Skill` node key from a `<command-name>` slash-command tag
 * (LLP 0074 surface 3, user-typed activation), offset-0 anchored. Strips an
 * optional leading `/` and drops Claude Code built-ins
 * (`CLAUDE_BUILTIN_COMMANDS`): a built-in slash is not a skill run.
 *
 * @param {unknown} contentText
 * @returns {string | null}
 */
export function skillFromSlash(contentText) {
  if (typeof contentText !== 'string') return null
  const match = SLASH_COMMAND_RE.exec(contentText)
  if (!match) return null
  const name = match[1]
  if (CLAUDE_BUILTIN_COMMANDS.has(name)) return null
  return gateSkill(name)
}

/**
 * Extract the `Skill` node key from a Codex `exec_command` shell read of
 * `.codex/skills/<name>/SKILL.md` (LLP 0075 surface 4, Codex's only
 * activation trace: no marker, no `Skill` tool, no `<command-name>` tag).
 * Takes the already-resolved command string (`commandStringFrom('exec_command',
 * tool_args)` — the wire shape this repo's Codex fixtures pin is
 * `{"cmd": …}`, `command` as fallback), not raw `tool_args`, so the caller
 * shares the one command-string recipe with `programFrom`.
 *
 * @ref LLP 0075#decision [implements] — path-pattern match on the
 * `exec_command` SKILL.md read; read ≡ activation is an accepted ambiguity
 * (LLP 0075 §read-is-activation), which is why the caller stamps the
 * distinct `dispatch_shell_read` flag rather than one of Claude's richer
 * dispatch flags.
 *
 * @param {unknown} command
 * @returns {string | null}
 */
export function skillFromCodexRead(command) {
  if (typeof command !== 'string') return null
  const match = CODEX_SKILL_READ_RE.exec(command)
  if (!match) return null
  return gateSkill(match[1])
}

/**
 * Apply the `Skill` validity gate. @ref LLP 0073#skill-key [constrained-by]:
 * the key is the verbatim bare name so the node converges across clients
 * (`~/.claude/skills/` and `~/.codex/skills/` land on one node); names
 * outside `SKILL_NAME_RE` mint nothing (fail closed).
 *
 * @param {string | null} name
 * @returns {string | null}
 */
function gateSkill(name) {
  if (!name) return null
  if (!SKILL_NAME_RE.test(name)) return null
  return name
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
