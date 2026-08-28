// @ts-check

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The installed Claude Code release, and the floor `otel` attach needs.
 *
 * OTEL attach is the only mechanism the `claude` client has, so the floor is
 * enforced at attach rather than discovered later as an empty dataset: a
 * release below it emits none of the events the listener reads, and the user
 * would be left with a settings file that says "attached" and a capture that
 * never starts.
 *
 * @ref LLP 0258#version-floor [implements]: the floor the attach adapter checks
 *   before it is allowed to switch the client to `otel` mode
 */

/** First Claude Code release that emits the telemetry event set. */
export const CLAUDE_OTEL_MIN_VERSION = '2.1.193'

/**
 * First release that carries `tool_source` on tool-decision events. Above the
 * floor, so it never blocks an attach: a machine between the two captures
 * everything except which surface approved a tool call.
 */
export const CLAUDE_TOOL_SOURCE_MIN_VERSION = '2.1.214'

/** What the user runs to clear the floor. Kept as one string so every surface prints the same hint. */
export const CLAUDE_UPDATE_HINT = 'claude update'

/**
 * Pull a dotted release number out of whatever `claude --version` prints.
 * The current format is `2.1.233 (Claude Code)`, but only the leading numeric
 * triple is contractual enough to depend on, so everything after it is
 * ignored rather than matched.
 *
 * @param {unknown} text
 * @returns {string | undefined} the version, or `undefined` when none is readable
 */
export function parseClaudeVersion(text) {
  if (typeof text !== 'string') return undefined
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined
}

/**
 * Compare two dotted release numbers numerically, not lexically: `2.1.193`
 * sorts *below* `2.1.9` under a string compare, which would refuse exactly the
 * releases that clear the floor.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when `a` is older, 0 when equal, positive when newer
 */
export function compareClaudeVersions(a, b) {
  const left = a.split('.').map((part) => Number.parseInt(part, 10))
  const right = b.split('.').map((part) => Number.parseInt(part, 10))
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const l = Number.isInteger(left[i]) ? left[i] : 0
    const r = Number.isInteger(right[i]) ? right[i] : 0
    if (l !== r) return l - r
  }
  return 0
}

/**
 * Is this Claude Code demonstrably older than `floor`?
 *
 * **Unknown is not old.** An undetectable version (`claude` not on PATH, a
 * sandboxed attach, a fleet install that renamed the binary) answers `false`
 * and the attach proceeds. Refusing on "we could not tell" would turn a
 * best-effort probe into a hard dependency on the binary being where we
 * looked, and would block the machines most likely to be running a current
 * release. Only a version we read and understood can refuse.
 *
 * @ref LLP 0258#version-floor [constrained-by]: *older than* the floor refuses;
 *   nothing else does
 * @param {string | undefined} version
 * @param {string} [floor]
 * @returns {boolean}
 */
export function isBelowClaudeVersion(version, floor = CLAUDE_OTEL_MIN_VERSION) {
  const parsed = parseClaudeVersion(version)
  if (parsed === undefined) return false
  return compareClaudeVersions(parsed, floor) < 0
}

/**
 * Best-effort read of the installed Claude Code version by running
 * `claude --version`.
 *
 * Never throws and never blocks an attach for long: a missing binary, a
 * non-zero exit, or a hang all resolve to `undefined`, which
 * {@link isBelowClaudeVersion} treats as "not proven old".
 *
 * @param {{ exec?: typeof execFileAsync, bin?: string, timeoutMs?: number }} [opts]
 *   `exec` is the subprocess seam, injected in tests so the floor logic is
 *   testable without a Claude Code install.
 * @returns {Promise<string | undefined>}
 */
export async function detectClaudeCodeVersion(opts = {}) {
  const exec = opts.exec ?? execFileAsync
  const bin = opts.bin ?? 'claude'
  try {
    const result = await exec(bin, ['--version'], { timeout: opts.timeoutMs ?? 3000 })
    return parseClaudeVersion(result?.stdout)
  } catch {
    return undefined
  }
}

/**
 * The version the attach floor checks: the `HYP_CLAUDE_CODE_VERSION`
 * environment override when present, otherwise the binary probe.
 *
 * The override serves two callers with the same need. Hermetic smokes must not
 * inherit whatever `claude` the machine running them happens to carry (a stale
 * install would flip an unrelated attach smoke to a refusal), and a fleet
 * install whose launcher hides the real binary from PATH knows its version
 * better than the probe does. An unparseable override falls back to the probe
 * rather than silently reading as "unknown, proceed".
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ exec?: typeof execFileAsync, bin?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<string | undefined>}
 */
export async function resolveClaudeCodeVersion(env, opts) {
  const override = env.HYP_CLAUDE_CODE_VERSION
  if (typeof override === 'string' && override.trim() !== '') {
    const parsed = parseClaudeVersion(override)
    if (parsed !== undefined) return parsed
  }
  return detectClaudeCodeVersion(opts)
}
