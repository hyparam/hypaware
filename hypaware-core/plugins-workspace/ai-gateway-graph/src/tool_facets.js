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
 * Every function here is a pure, deterministic function of a single row's data,
 * no cross-row state, no data-window thresholds, so projection stays
 * content-addressed and idempotent (LLP 0023 §content-addressed-ids), and every
 * derived value passes an explicit validity gate before it can key a node
 * (§boundedness-contract). Anything that fails a step returns `null` and mints
 * nothing: fall back rather than mis-key (the LLP 0032 discipline).
 */

/**
 * The `Program` validity gate: a lowercased basename bounded to look like an
 * installed binary. All-numeric tokens are rejected separately (a bare number is
 * never a program). @ref LLP 0073#boundedness-contract [constrained-by]: a
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
 * prefix-LIKE and this regex, deliberately without the `m` flag: `^` must
 * only match true string offset 0, never "start of any line", or a marker
 * embedded after a newline (assistant quoting, pasted transcripts) would
 * start minting nodes. The capture takes the rest of the line (not `\S+`): a
 * base directory containing a space (e.g. `/Users/John Smith/.claude/skills/
 * hypaware-query`) would otherwise truncate at the first space and mis-key
 * the node on `John` instead of the trailing skill-directory basename. `.`
 * already excludes line terminators (no `s` flag), so the capture naturally
 * stops at the first newline without needing a multiline-aware `$`.
 */
const SKILL_MARKER_RE = /^Base directory for this skill: (.+)/

/**
 * The slash-command tag, anchored at offset 0. The captured name may carry a
 * leading `/` (stripped by the optional group before the capture).
 */
const SLASH_COMMAND_RE = /^<command-name>\s*\/?([A-Za-z0-9:_-]+)\s*<\/command-name>/

/** Read programs admitted by the concrete operand grammar in shellReadPaths. */
const CODEX_READ_PROGRAMS = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'bat', 'rg', 'grep', 'nl'])

/** Command wrappers whose own args precede the real `argv[0]`. */
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'nice', 'time', 'command', 'stdbuf', 'timeout'])

/** Shells that run an inline command string after a `-c` flag cluster. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/** A leading `KEY=VAL` environment assignment (skipped ahead of the command). */
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A short single-dash flag cluster like `-lc` (not a `--long` option). */
const SHORT_FLAG_RE = /^-[A-Za-z]+$/

/** A bare numeric / duration token (`5`, `5s`, `1.5`, `10m`): a wrapper arg, not a program. */
const NUMERICISH_RE = /^\d+(\.\d+)?[A-Za-z]?$/

/**
 * Per-wrapper flags known to take a SEPARATE argument token (`-u root`, not
 * `-uroot`). @ref LLP 0073#program-derivation [constrained-by]: MAJOR 2 fix:
 * the wrapper skip previously treated every flag as no-arg, so an
 * option-with-arg's *value* (`root` in `sudo -u root git status`) was mis-read
 * as argv[0]. Enumerating each wrapper's common option-with-arg forms lets the
 * skip consume the flag *and* its value as a pair; an attached form
 * (`-uroot`, `--chdir=/tmp`) is already one token and is classified
 * separately (see `classifyWrapperFlag`).
 */
const WRAPPER_ARG_FLAGS = {
  sudo: new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-C', '--close-from', '-D', '--chdir']),
  env: new Set(['-C', '--chdir', '-u', '--unset', '-S', '--split-string']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  nice: new Set(['-n', '--adjustment']),
  time: new Set(['-o', '--output']),
  nohup: new Set(),
  command: new Set(),
}

/**
 * Per-wrapper flags known to take NO argument: safe to skip alone. A flag
 * that is neither here nor in `WRAPPER_ARG_FLAGS` (and not an attached form of
 * one) is an unrecognized shape for that wrapper: `classifyWrapperFlag` fails
 * closed rather than risk treating an unknown flag's value as argv[0].
 */
const WRAPPER_NOARG_FLAGS = {
  sudo: new Set(['-n', '--non-interactive', '-i', '--login', '-E', '--preserve-env', '-H', '--set-home', '-S', '--stdin', '-k', '--reset-timestamp', '-v', '--validate', '-l', '--list', '-b', '--background', '-A', '--askpass']),
  env: new Set(['-i', '--ignore-environment', '-0', '--null', '-v', '--verbose']),
  timeout: new Set(['-v', '--verbose', '--preserve-status', '-f', '--foreground']),
  stdbuf: new Set(),
  nice: new Set(),
  time: new Set(['-p', '--portability', '-v', '--verbose', '-q', '--quiet']),
  nohup: new Set(),
  command: new Set(['-p', '-v', '-V']),
}

/** Shared empty set for a wrapper name absent from one of the option maps. */
const NO_FLAGS = new Set()

/**
 * Classify a flag token seen while skipping a known wrapper's own args:
 * - `'pair'`, an option-with-arg in its separate-token form (`-u`, then the
 *   next token is its value): consume both.
 * - `'attached'`, either a no-arg flag, or an option-with-arg whose value is
 *   already attached to this token (`-uroot`, `--chdir=/tmp`): consume just
 *   this one token.
 * - `'unrecognized'`, not a known shape for this wrapper: fail closed
 *   (MAJOR 2) rather than risk misreading a flag's value as argv[0].
 *
 * @param {string} wrapperName
 * @param {string} tok
 * @returns {'pair' | 'attached' | 'unrecognized'}
 */
function classifyWrapperFlag(wrapperName, tok) {
  const argFlags = WRAPPER_ARG_FLAGS[wrapperName] ?? NO_FLAGS
  for (const flag of argFlags) {
    if (tok === flag) return 'pair'
    if (flag.startsWith('--')) {
      if (tok.startsWith(flag + '=')) return 'attached'
    } else if (flag.length === 2 && tok.startsWith(flag) && tok.length > flag.length) {
      return 'attached'
    }
  }
  const noArgFlags = WRAPPER_NOARG_FLAGS[wrapperName] ?? NO_FLAGS
  if (noArgFlags.has(tok)) return 'attached'
  return 'unrecognized'
}

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
  const dir = match[1].trim().replace(/\/+$/, '')
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
 * Infer a skill read only from a concrete operand in a recognized skill root.
 * This remains the weaker dispatch_shell_read signal, not proof of activation.
 * @param {unknown} command
 * @returns {string | null}
 * @ref LLP 0428#literal-actions [implements]: expand roots without treating quoted path mentions as reads.
 */
export function skillFromCodexRead(command) {
  if (typeof command !== 'string') return null
  return shellReadPaths(command).map(skillFromPath).find(Boolean) ?? null
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
 * Extract the `Program` node key: the validity-gated, lowercased
 * `basename(argv[0])` of the *first* command in a shell string. Deterministic
 * and fail-closed: any step that cannot cleanly resolve a bounded token returns
 * `null` (mint nothing rather than mis-key).
 *
 * @ref LLP 0073#program-derivation [implements]: first-segment argv[0]
 * extraction; the quote-blind connector split is safe because only the head of
 * the first segment is consumed, so a connector inside quotes can at worst
 * truncate the discarded tail, never corrupt argv[0].
 *
 * @param {unknown} command  the raw command string (or null from commandStringFrom)
 * @param {number} [depth]  recursion depth for `shell -c` unwrap, capped at 2
 * @returns {string | null}
 */
export function programFrom(command, depth = 0) {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_ACTION_CHARS) return null

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

    // 4. Unwrap a known wrapper: drop it, then skip its own flags (consuming
    //    a known option-with-arg's separate value too, e.g. `sudo -u root`:
    //    MAJOR 2 fix), further env assignments, and bare numeric/duration
    //    args (e.g. `timeout 5 …`). A flag shape this wrapper's map doesn't
    //    recognize fails closed (mints nothing) rather than risk misreading
    //    its value as argv[0].
    if (WRAPPERS.has(norm)) {
      i++
      while (i < tokens.length) {
        const wtok = tokens[i]
        if (ENV_RE.test(wtok) || NUMERICISH_RE.test(wtok)) {
          i++
          continue
        }
        // `--` ends option parsing: the next token is argv[0]. Without this,
        // the fail-closed classifier below treats `--` as an unrecognized flag
        // and drops `sudo -- git status` to nothing (round-2 regression fix).
        if (wtok === '--') {
          i++
          break
        }
        if (!isFlag(wtok)) break
        const kind = classifyWrapperFlag(norm, wtok)
        if (kind === 'pair') {
          i += 2
          continue
        }
        if (kind === 'attached') {
          i++
          continue
        }
        return null
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
 * out-of-domain tokens. @ref LLP 0073#boundedness-contract [constrained-by]:
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
  if (value.length > MAX_ACTION_CHARS) return null
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

// @ref LLP 0428#literal-actions [implements]: bounded, whole-input grammar, never eval.
export const MAX_ACTION_CHARS = 65_536
const MAX_ACTIONS = 32

/**
 * Recognize only complete sequences of direct awaited literal calls. This is
 * deliberately not a JavaScript interpreter: control flow, variables, comments
 * (except the exec pragma), templates and computed access all fail closed.
 * @param {unknown} source
 * @returns {{ tool_name: string, tool_args: unknown }[]}
 */
export function literalActions(source) {
  if (typeof source !== 'string' || source.length > MAX_ACTION_CHARS) return []
  const s = source.replace(/^\s*\/\/ @exec:[^\r\n]*\r?\n/, '')
  let i = 0
  const space = () => { while (/\s/.test(s[i] ?? '') && i < s.length) i++ }
  const take = (token) => {
    space()
    if (!s.startsWith(token, i)) throw new Error('syntax')
    i += token.length
  }
  const string = () => {
    space()
    const quote = s[i++]
    if (quote !== '"' && quote !== "'") throw new Error('literal')
    let value = ''
    while (i < s.length) {
      const ch = s[i++]
      if (ch === quote) return value
      if (ch === '\n' || ch === '\r') throw new Error('newline')
      if (ch !== '\\') {
        value += ch
        continue
      }
      const esc = s[i++]
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'", '/': '/' }
      if (esc === 'u') {
        const hex = s.slice(i, i + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('escape')
        value += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else if (Object.hasOwn(escapes, esc)) value += escapes[esc]
      else throw new Error('escape')
    }
    throw new Error('unterminated')
  }
  const scalar = () => {
    space()
    if (s[i] === '"' || s[i] === "'") return string()
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?)/.exec(s.slice(i))
    if (!m) throw new Error('scalar')
    i += m[0].length
    return JSON.parse(m[0])
  }
  const argument = () => {
    space()
    if (s[i] !== '{') return string()
    take('{')
    const obj = Object.create(null)
    let count = 0
    space()
    while (s[i] !== '}') {
      if (++count > 32) throw new Error('fields')
      space()
      let key
      if (s[i] === '"' || s[i] === "'") key = string()
      else {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
        if (!m) throw new Error('key')
        key = m[0]
        i += key.length
      }
      if (Object.hasOwn(obj, key) || key === '__proto__') throw new Error('duplicate')
      take(':')
      obj[key] = scalar()
      space()
      if (s[i] !== ',') break
      take(',')
      space()
    }
    take('}')
    return obj
  }
  try {
    const calls = []
    space()
    while (i < s.length) {
      if (calls.length >= MAX_ACTIONS) return []
      const wrapped = s.startsWith('text', i)
      if (wrapped) take('text(')
      take('await')
      if (!/\s/.test(s[i] ?? '')) return []
      space()
      take('tools.')
      const m = /^(exec_command|apply_patch)\b/.exec(s.slice(i))
      if (!m) return []
      i += m[0].length
      take('(')
      const args = argument()
      take(')')
      if (wrapped) take(')')
      calls.push({ tool_name: m[0], tool_args: args })
      const end = i
      space()
      if (s[i] === ';') {
        i++
        space()
      }
      else if (i < s.length && !/[\r\n]/.test(s.slice(end, i))) return []
    }
    return calls
  } catch { return [] }
}

/**
 * Concrete operands of a small read-command grammar. Shell expansion and
 * command lists are deliberately unsupported, including quoted examples of
 * those constructs. Paths are bounded before tokenization and fan-out.
 * @param {unknown} command
 * @returns {string[]}
 */
export function shellReadPaths(command) {
  if (typeof command !== 'string' || command.length > MAX_ACTION_CHARS || /[\0\n\r$`|;&<>()*?{}\\]/.test(command)) return []
  const words = []
  let end = 0
  for (const match of command.matchAll(/'[^']*'|"[^"]*"|[^\s'"]+/g)) {
    const gap = command.slice(end, match.index)
    if (gap.trim() || (words.length && !gap)) return []
    words.push(match[0])
    if (words.length > 128) return []
    end = match.index + match[0].length
  }
  if (command.slice(end).trim()) return []
  const tokens = words.map(w => /^['"]/.test(w) ? w.slice(1, -1) : w)
  const prog = path.basename(tokens.shift() ?? '')
  if (!CODEX_READ_PROGRAMS.has(prog)) return []
  if (prog === 'sed') {
    if (tokens.shift() !== '-n' || !/^\d+(?:,\d+)?p$/.test(tokens.shift() ?? '')) return []
  } else if (prog === 'rg' || prog === 'grep') {
    while (/^-[nilF]+$/.test(tokens[0] ?? '')) tokens.shift()
    if (!tokens.length || tokens[0].startsWith('-')) return []
    tokens.shift() // pattern, never a file operand
  } else {
    while (tokens[0]?.startsWith('-')) {
      const flag = tokens.shift()
      if (flag === '--') break
      if ((prog === 'head' || prog === 'tail') && (flag === '-n' || flag === '-c')) {
        if (!/^\d+$/.test(tokens.shift() ?? '')) return []
      } else if (!/^-[nbqv]+$/.test(flag ?? '')) return []
    }
  }
  if (tokens.length > MAX_ACTIONS || tokens.some(t => !t || t.startsWith('-') || t.length > 4096)) return []
  return tokens
}

/** @param {unknown} file @returns {string | null} */
export function skillFromPath(file) {
  if (typeof file !== 'string' || file.length > 4096) return null
  const m = /(?:^|\/)\.(?:codex|agents)\/skills\/(?:\.system\/)?([^/]+)\/SKILL\.md$/.exec(file)
    ?? /(?:^|\/)\.codex\/plugins\/cache\/[^/]+\/[^/]+\/[^/]+\/skills\/([^/]+)\/SKILL\.md$/.exec(file)
  return m ? gateSkill(m[1]) : null
}

/** @param {unknown} input @returns {string[]} */
export function patchPaths(input) {
  if (typeof input !== 'string' || input.length > MAX_ACTION_CHARS || !input.startsWith('*** Begin Patch\n') || !input.trimEnd().endsWith('*** End Patch')) return []
  const files = []
  for (const line of input.split('\n')) {
    const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
    if (m) files.push(m[1])
    if (files.length > MAX_ACTIONS) return []
  }
  return files.filter(f => f.length <= 4096 && !/[\0$`]/.test(f))
}
