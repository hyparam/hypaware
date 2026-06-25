// @ts-check

// Programmatic embedding surface for host applications (e.g. a signed
// Electron app that bundles hypaware and drives it in-process instead of
// spawning the `hyp` binary). Every helper here boots the kernel through
// the same `dispatch()` the CLI uses, captures stdout/stderr into buffers,
// and returns a structured result — so callers get a typed object and real
// thrown errors instead of parsing JSON out of a child process's stdout.
//
// The long-running daemon is intentionally NOT exposed here: it must run as
// its own process (the launchd/systemd unit), not inside the host.

import { dispatch } from './dispatch.js'

/**
 * @import { IntegrationOptions, CommandResult, ClientResult } from './integration.d.ts'
 */

/**
 * Raised when an embedded command exits non-zero or reports a non-`ok`
 * status. Carries the exit code, captured streams, and any parsed JSON so
 * callers can branch on the details rather than scrape a message.
 */
export class HypAwareCommandError extends Error {
  /**
   * @param {string} message
   * @param {{ code: number, stdout: string, stderr: string, json: unknown }} detail
   */
  constructor(message, detail) {
    super(message)
    this.name = 'HypAwareCommandError'
    this.code = detail.code
    this.stdout = detail.stdout
    this.stderr = detail.stderr
    this.json = detail.json
  }
}

/** A string sink that accumulates everything written to it. */
function makeBuffer() {
  let value = ''
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * Parse the last non-empty line of `text` as JSON. Commands invoked with
 * `--json` emit a single JSON object per affected target on its own line;
 * the final line is the one callers care about for a single target.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parseLastJsonLine(text) {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Build the dispatch env, overlaying `HYP_HOME` when supplied so the call
 * targets a specific state dir regardless of the ambient environment.
 *
 * @param {IntegrationOptions} opts
 * @returns {NodeJS.ProcessEnv}
 */
function resolveEnv(opts) {
  const base = opts.env ?? process.env
  return opts.hypHome ? { ...base, HYP_HOME: opts.hypHome } : base
}

/**
 * Run a hypaware command in-process and return its structured result. This
 * is the low-level escape hatch; prefer {@link attach}/{@link detach}/
 * {@link join} for the common flows.
 *
 * @param {string[]} argv
 * @param {IntegrationOptions} [opts]
 * @returns {Promise<CommandResult>}
 */
export async function run(argv, opts = {}) {
  const stdout = makeBuffer()
  const stderr = makeBuffer()
  const code = await dispatch(argv, {
    stdout,
    stderr,
    env: resolveEnv(opts),
    cwd: opts.cwd,
    // Test/advanced flows may inject a pre-built registry/kernel (the same
    // escape hatch `dispatch` itself documents); forward when present.
    registry: /** @type {any} */ (opts).registry,
    kernel: /** @type {any} */ (opts).kernel,
  })
  const outText = stdout.text()
  return {
    code,
    json: parseLastJsonLine(outText),
    stdout: outText,
    stderr: stderr.text(),
  }
}

/**
 * Run `attach`/`detach` for a client with `--json`, returning the parsed
 * result. Throws {@link HypAwareCommandError} on a non-zero exit or a
 * non-`ok` status.
 *
 * @param {'attach'|'detach'} verb
 * @param {string} client
 * @param {IntegrationOptions} opts
 * @returns {Promise<ClientResult>}
 */
async function runClient(verb, client, opts) {
  const argv = [verb, client, '--json']
  if (opts.dryRun) argv.push('--dry-run')
  const result = await run(argv, opts)
  const json = /** @type {ClientResult | null} */ (result.json)
  if (result.code !== 0 || !json || json.status !== 'ok') {
    const reason =
      (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
        ? json.error
        : '') ||
      result.stderr.trim() ||
      `hyp ${verb} ${client} exited with code ${result.code}`
    throw new HypAwareCommandError(`hyp ${verb} ${client}: ${reason}`, {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      json: result.json,
    })
  }
  return json
}

/**
 * Attach a client (e.g. `'claude'` or `'codex'`) to the local gateway by
 * editing its settings file. Resolves the gateway port from the effective
 * config / live daemon; no port argument is needed.
 *
 * @param {string} [client]
 * @param {IntegrationOptions} [opts]
 * @returns {Promise<ClientResult>}
 */
export function attach(client = 'claude', opts = {}) {
  return runClient('attach', client, opts)
}

/**
 * Detach a previously attached client, restoring its prior settings.
 *
 * @param {string} [client]
 * @param {IntegrationOptions} [opts]
 * @returns {Promise<ClientResult>}
 */
export function detach(client = 'claude', opts = {}) {
  return runClient('detach', client, opts)
}

/**
 * Join a central hypaware server, writing the join seed under
 * `<HYP_HOME>/hypaware/config-control/`. With `noDaemon` (the default for
 * embedded hosts that own their own daemon) it performs no network call and
 * installs no launchd/systemd unit — the host's already-running daemon
 * picks up the seed and pulls its configuration.
 *
 * @param {string} url
 * @param {string} token
 * @param {IntegrationOptions & { noDaemon?: boolean }} [opts]
 * @returns {Promise<CommandResult>}
 */
export async function join(url, token, opts = {}) {
  const argv = ['join', url]
  if (token) argv.push(token)
  if (opts.noDaemon ?? true) argv.push('--no-daemon')
  const result = await run(argv, opts)
  if (result.code !== 0) {
    const reason = result.stderr.trim() || `hyp join exited with code ${result.code}`
    throw new HypAwareCommandError(`hyp join: ${reason}`, {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      json: result.json,
    })
  }
  return result
}
