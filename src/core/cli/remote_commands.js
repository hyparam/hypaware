// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { parseCoreCommandArgv } from './command_args.js'
import { hasAppliedCentralConfig } from '../config/apply.js'
import { defaultConfigPath } from '../config/schema.js'
import { readObservabilityEnv } from '../observability/env.js'
import { BUILTIN_REMOTES, effectiveDefaultRemote } from '../remote/builtin_remotes.js'
import {
  attachWithRefresh,
  deriveIdentityBase,
  describeAuthRejection,
  isRefreshable,
  readCredentials,
  remoteTokenEnvVar,
  removeToken,
  resolveAccessJwt,
  writeSession,
  writeToken,
} from '../remote/credentials.js'
import { NO_FETCH_MESSAGE, describeRefreshError, expiryTimestamp } from '../remote/identity_client.js'
import { Attr, getLogger } from '../observability/index.js'
import { readCentralEnrollment, seedLoginGateway } from '../remote/gateway_seed.js'
import { enrollCentralSink } from '../commands/central.js'
import { DURABLE_HINT } from '../commands/local_only.js'
import { withSpinner } from './spinner.js'
import { formatFirstSyncDeadline, writeFirstSyncHoldMarker } from '../usage-policy/first_sync_hold.js'
import { originOf } from '../remote/gateway_seed.js'
import { readAllStdin } from './stdio.js'
import { isPlainObject } from '../util/json_util.js'
import { loginWithBrowser } from '../remote/oidc_login.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { loadClientDescriptors, probeAttachedClients, resolveLiveGatewayEndpointFromStatus } from '../daemon/status.js'
import { daemonIncompleteNote } from '../daemon/platform.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { LoginOutcome, OidcSession } from '../../../src/core/remote/types.js'
 */

/**
 * The default attach-wait budget. Named so the `runBrowserLogin` progress line
 * and the poll loop below quote the same number.
 */
export const ATTACH_WAIT_DEFAULT_MS = 30000

/**
 * Wait for the daemon's first reconcile to attach a client after enrollment,
 * so `hyp remote login` can report the real capture state instead of a guess.
 * The daemon pulls the org config and runs the LLP 0044 attach pass
 * asynchronously once installed; the marker it writes into each client's
 * settings file is readable cross-process, so we poll the on-disk attach markers
 * (a pure read, no runtime needed) until a client attaches or the budget runs
 * out.
 *
 * We probe *only* those markers (`probeAttachedClients`), not the full
 * `collectHypAwareStatus`: the descriptors are loaded once and each poll just
 * re-reads the client settings files, so a poll is cheap and, the point, never
 * walks the cache, whose fs errors the full collector's `walkForStats` re-throws
 * (EACCES/EMFILE/EIO). As belt-and-suspenders the poll is still guarded, so even
 * a probe that somehow throws is swallowed as "not attached this tick" and the
 * successful enrollment is never reported as a failure.
 *
 * Timing out is not an error: it just means no client has attached yet (an org
 * with no published config, or a slow first pull), and the caller falls back to
 * pointing at `hyp status`.
 *
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   homeDir?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   probe?: () => Promise<string[]>,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 * @returns {Promise<string[]>} attached client names (sorted), empty on timeout
 * @ref LLP 0063#login-config-pull [implements]: report attach ground truth by waiting on the reconcile the follow-up made auto, not printing a pre-pull guess
 */
export async function waitForClientAttach({ env, homeDir, timeoutMs = ATTACH_WAIT_DEFAULT_MS, intervalMs = 1000, probe, sleep = defaultSleep }) {
  const attachProbe = probe ?? (await buildDefaultAttachProbe(env, homeDir))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    /** @type {string[]} */
    let attached = []
    try {
      attached = await attachProbe()
    } catch {
      // A transient fs error mid-poll is not "attached": treat it as
      // not-attached this tick and keep polling to the timeout fallback, so a
      // login that actually enrolled is never reported as a failure.
      attached = []
    }
    if (attached.length > 0) return [...attached].sort()
    const remaining = deadline - Date.now()
    if (remaining <= 0) return []
    // Floor at 1ms so a non-positive intervalMs (exported seam only) cannot
    // busy-spin; cap at the remaining budget so we never oversleep it.
    await sleep(Math.max(1, Math.min(intervalMs, remaining)))
  }
}

/**
 * Build the production attach probe: discover the (poll-invariant) client
 * descriptors once, then hand back a closure that re-reads their on-disk attach
 * markers on each call. Keeps plugin discovery / catalog build out of the poll
 * loop while the per-poll read stays a marker-only, throw-proof probe.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [homeDir]
 * @returns {Promise<() => Promise<string[]>>}
 */
async function buildDefaultAttachProbe(env, homeDir) {
  const stateDir = readObservabilityEnv(env).stateDir
  const resolvedHome = homeDir ?? env.HOME ?? process.env.HOME ?? os.homedir()
  const descriptors = await loadClientDescriptors({ stateDir })
  return () => probeAttachedClients({ descriptors, homeDir: resolvedHome, env })
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The default gateway-bind wait budget. A restarted daemon has to re-read the
 * config, activate the newly-enabled adapter, and bind the gateway listener
 * before it publishes the port, so the budget matches the attach wait rather
 * than a single reconcile tick.
 */
export const GATEWAY_BIND_WAIT_DEFAULT_MS = 30000

/**
 * Wait for the daemon's gateway to publish a bound port after a restart, so
 * the enable-then-attach flow hands `client.attach()` a port something is
 * actually listening on instead of racing the reboot.
 *
 * The sibling of {@link waitForClientAttach}, and deliberately the same shape:
 * poll a cross-process disk fact on a bounded budget, swallow a throwing probe
 * as "not yet" (a status snapshot written mid-poll is not a failure), and
 * *return* on timeout rather than throwing. A timeout is not an error here for
 * the same reason it is not one there: the caller has a better answer than an
 * exception (attach's own endpoint-resolution ladder, which ends in the
 * `hyp daemon install` / `hyp daemon start` guidance the give-up message names).
 *
 * The probed fact is `resolveLiveGatewayEndpointFromStatus`, which is already
 * liveness-gated on the daemon pid, so a stale `status.json` left by the
 * pre-restart daemon can never satisfy the wait.
 *
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   homeDir?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   probe?: () => string | undefined,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 * @returns {Promise<{ bound: boolean, endpoint?: string }>}
 * @ref LLP 0174#prompt [implements]: step 2's "wait for the gateway to bind" after the enable restart
 */
export async function waitForGatewayBind({
  env,
  timeoutMs = GATEWAY_BIND_WAIT_DEFAULT_MS,
  intervalMs = 500,
  probe,
  sleep = defaultSleep,
}) {
  // `homeDir` is accepted (and ignored) for signature parity with the daemon
  // lifecycle calls this wait follows: status.json hangs off the state root,
  // which `readObservabilityEnv` already derives from HYP_HOME.
  const stateRoot = readObservabilityEnv(env).stateDir
  const bindProbe = probe ?? (() => resolveLiveGatewayEndpointFromStatus({ stateRoot }))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    /** @type {string | undefined} */
    let endpoint
    try {
      endpoint = bindProbe()
    } catch {
      endpoint = undefined
    }
    if (endpoint) return { bound: true, endpoint }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { bound: false }
    // Floor at 1ms so a non-positive intervalMs cannot busy-spin; cap at the
    // remaining budget so we never oversleep it. Same guard as the attach wait.
    await sleep(Math.max(1, Math.min(intervalMs, remaining)))
  }
}

/**
 * Wait for the daemon to converge on the org config after an enrolling
 * login, so the wizard's join phase can lock the org-owned picker rows
 * before it composes (LLP 0129). "Converged" means the apply engine has
 * committed a pulled config to an active slot - the on-disk fact the
 * locked-row computation reads right after this wait - NOT that a client
 * attached: an org config that names no client for this machine converges
 * without ever writing an attach marker, and polling the markers made this
 * wait burn its whole budget in exactly that steady state. The join seed is
 * deliberately not convergence either ({@link hasAppliedCentralConfig}).
 *
 * A timeout (the org has no published config - the no-config 404 steady
 * state, which lands nothing on disk to observe - or a slow first pull)
 * returns `{ ok: false }`, and the wizard shows an unlocked picker rather
 * than blocking. Timing out is not an error here for the same reason it is
 * not one for `waitForClientAttach`.
 *
 * @ref LLP 0129#join-before-picker [implements]: the bounded org-config wait before the picker composes; budget and timeout fallback per the decision
 * @ref LLP 0223 [implements]: convergence is the applied slot on disk, never the attach markers or the join seed
 * @param {{ env: NodeJS.ProcessEnv, probe?: () => boolean | Promise<boolean>, sleep?: (ms: number) => Promise<void> }} opts
 * @param {{ timeoutMs?: number, intervalMs?: number }} [waitOpts]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function waitForCentralConverge(
  { env, probe, sleep = defaultSleep },
  // The wizard passes its own budget (ORG_CONFIG_WAIT_MS); the fallback here
  // quotes the attach wait's own constant so a budget-less call stays bounded
  // and the two cannot drift apart.
  { timeoutMs = ATTACH_WAIT_DEFAULT_MS, intervalMs = 500 } = {}
) {
  const stateRoot = readObservabilityEnv(env).stateDir
  const applied = probe ?? (() => hasAppliedCentralConfig({ stateRoot }))
  const deadline = Date.now() + timeoutMs
  let loggedProbeError = false
  for (;;) {
    let ok = false
    try {
      ok = Boolean(await applied())
    } catch (err) {
      // A transient fs error mid-poll is "not converged this tick", never a
      // join failure: keep polling to the timeout fallback. But an fs error
      // that persists is indistinguishable at the wizard from the no-org-config
      // steady state (both end in "didn't hear back"), so leave a signal for
      // the run that has to be diagnosed. Once per wait, not once per poll: a
      // durable EACCES would otherwise log for the whole budget.
      //
      // This only sees anything because `hasAppliedCentralConfig` throws
      // rather than folding an unreadable pointer into `false`. A probe that
      // swallows its own fs errors makes this branch dead code.
      if (!loggedProbeError) {
        loggedProbeError = true
        getLogger('remote-login').warn('join.converge_probe_failed', {
          [Attr.COMPONENT]: 'cmd-remote-login',
          [Attr.OPERATION]: 'join.converge',
          [Attr.ERROR_KIND]: 'converge_probe_unreadable',
          error_message: err instanceof Error ? err.message : String(err),
        })
      }
      ok = false
    }
    if (ok) return { ok: true }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: false }
    // Floor at 1ms so a non-positive intervalMs cannot busy-spin; cap at the
    // remaining budget so we never oversleep it. Same guard as the attach wait.
    await sleep(Math.max(1, Math.min(intervalMs, remaining)))
  }
}

/**
 * Write the first-sync export hold marker (LLP 0101) without ever failing the
 * login: the hold is a refinement of the enrollment, so a marker that cannot
 * be written degrades to today's behavior (exports may tick before the
 * deadline) with a log, never an error. Returns the deadline that landed so
 * the caller can print it, or null when nothing was written.
 *
 * @param {string} stateDir
 * @returns {Promise<number | null>} the absolute deadline (epoch ms) written, or null on failure
 */
async function markFirstSyncHoldBestEffort(stateDir) {
  try {
    return await writeFirstSyncHoldMarker({ stateDir })
  } catch (err) {
    getLogger('remote-login').warn('local_only.first_sync_hold_mark_failed', {
      [Attr.COMPONENT]: 'cmd-remote-login',
      [Attr.OPERATION]: 'local_only.first_sync_hold_mark',
      [Attr.ERROR_KIND]: 'marker_write_failed',
      error_message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

const FIRST_SYNC_RULE = '─'.repeat(62)

/**
 * The first-sync deadline message: an absolute local time, a statement that
 * the first sync includes backfilled history, and the `hypaware-privacy`
 * skill invocation hint ([LLP 0100 §flow](../../../llp/0100-enrollment-privacy-review.spec.md#flow)
 * example copy), set off from the surrounding login chatter by rule lines so
 * the review hint is not buried mid-stream. Printed to stderr
 * unconditionally - the same wording on a TTY or a non-TTY login, since
 * neither case is a prompt (LLP 0063 D3 stands): this is a consent-surface
 * statement, pinned by tests like the other consent surfaces. Each pinned
 * phrase stays whole on its own line so the content assertions survive the
 * decoration.
 *
 * Names the destination by its configured target name, not its URL: terminals
 * autolink any printed `https://` run, and the server root is a service
 * endpoint that answers `{"error":"unknown_path"}` in a browser, so a URL here
 * reads as an invitation to a dead page - in the one message where trust
 * matters most (#391). R1 asks for the deadline, the backfill statement, and
 * the skill hint; R1a pins the spelling, and `<server>` is already how §flow
 * writes it.
 *
 * The name alone would be a dead end, so the block names the one command that
 * maps it back: `hyp remote list`. A bare `hyp remote login` resolves its
 * target from `effectiveDefaultRemote`, so the user can be shown a name they
 * never typed - and nothing else this login prints recovers the URL (`hyp
 * status` names no server, DURABLE_HINT points at `hyp policy set`). Withholding
 * the URL is a readability choice; withholding the *way to see it* would make a
 * consent surface unauditable. The pointer lives inside the rule lines because
 * this block is deliberately self-contained (stderr, while the forwarding line
 * is stdout - redirect either and the other must still stand on its own).
 *
 * The deadline is the latest the first sync can happen, not the earliest
 * (LLP 0101 #no-release, as amended), so it reads "no later than" and the
 * block names the verb that ends the window early. A deadline with no way to
 * act on it is a countdown, which is how this message read in the onboarding
 * session that prompted both changes.
 *
 * @ref LLP 0100#requirements [implements]: R1 - absolute deadline with its zone, backfill statement, skill hint, release verb, same on TTY and non-TTY
 * @ref LLP 0100#requirements [implements]: R1a - name the server, never its URL, and name the command that maps the name back
 * @param {number} deadlineMs
 * @param {string} serverName
 * @returns {string}
 */
export function firstSyncHoldMessage(deadlineMs, serverName) {
  return (
    '\n' +
    `${FIRST_SYNC_RULE}\n` +
    '  PRIVACY - review before first sync\n' +
    '\n' +
    `  first sync to the '${serverName}' server is no later than\n` +
    `  ${formatFirstSyncDeadline(deadlineMs)}\n` +
    '  and includes your backfilled history\n' +
    "  (run 'hyp remote list' to see that server's URL)\n" +
    '\n' +
    '  to review what ships before then,\n' +
    '  open Claude or Codex and run the hypaware-privacy skill\n' +
    '\n' +
    '  to send it sooner, run: hyp sync\n' +
    `${FIRST_SYNC_RULE}\n` +
    '\n'
  )
}

/**
 * Core `remote` commands manage named MCP targets + their query-scoped
 * tokens (LLP 0033 §commands). `hyp` is the MCP client on the human-CLI
 * path, so these are **core**, not a plugin. `remote add` is a local-layer
 * config writer (create-or-augment); `remote login` writes the `0600`
 * credential store. An admin who never ran HypAware gets queryable in two
 * commands: `remote add prod <url>` → `remote login prod`.
 */

/**
 * `hyp remote add <name> <url>`: register (or update) a target in the
 * local config's `query.remotes`. The URL is non-secret and committable.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0033#commands [implements]: `remote add` is a local-layer writer; URL in config, token never in config
 */
export async function runRemoteAdd(argv, ctx) {
  const parsed = parseCoreCommandArgv('remote add', argv, ctx)
  if (!parsed.ok) return parsed.code
  const name = String(parsed.params.name)
  const url = String(parsed.params.url)
  if (!/^https?:\/\//.test(url)) {
    ctx.stderr.write(`hyp remote add: url must be an http(s) URL (got ${url})\n`)
    return 2
  }
  const configPath = localConfigPath(ctx)
  try {
    await mutateLocalConfig(configPath, (config) => {
      const query = (config.query = isPlainObject(config.query) ? config.query : {})
      const remotes = (query.remotes = isPlainObject(query.remotes) ? query.remotes : {})
      remotes[name] = { url }
    })
  } catch (err) {
    ctx.stderr.write(`hyp remote add: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  ctx.stdout.write(`added remote '${name}' → ${url}\n`)
  ctx.stdout.write(`  next: hyp remote login ${name}\n`)
  return 0
}

/**
 * `hyp remote login <name>`: populate the target's query-scoped credential.
 *
 * Two modes, one store (LLP 0058 D1). A **static** token still comes from
 * `--token-file <path>` or piped stdin, unchanged (the headless escape hatch,
 * D8). Otherwise an interactive **browser** authorization-code flow runs
 * against the target's identity endpoint and stores an OIDC session. `--org`
 * selects an org; `--browser` forces the flow even with stdin piped;
 * `--no-browser` prints the URL instead of opening it; `--host` overrides
 * the advisory machine label sent with the token exchange (LLP 0061 D6).
 *
 * `--no-forward` declines fleet enrollment (LLP 0063 D3): sign in for queries
 * only, the login-minted gateway is discarded, no central sink is written.
 * `--no-daemon` provisions the sink but skips the service install (D5).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ login?: typeof loginWithBrowser, seed?: typeof seedLoginGateway, enroll?: typeof enrollCentralSink, waitForAttach?: typeof waitForClientAttach, compact?: boolean }} [deps] test seam for the browser flow, gateway seeding, central-sink enrollment, and the post-enroll attach wait; `compact` is the wizard's join lane asking for one line per event instead of the standalone command's paragraphs
 * @returns {Promise<number>}
 * @ref LLP 0058#d1 [implements]: browser mode of `hyp remote login`; one command, one store, one more way to populate it
 */
export async function runRemoteLogin(argv, ctx, deps = {}) {
  return (await remoteLogin(argv, ctx, deps)).exitCode
}

/**
 * The login lane proper: everything `hyp remote login` does, reported as an
 * outcome rather than an exit code. The command surface above collapses it to
 * a number, which is where a number belongs; the wizard's join phase branches
 * on `reason` instead of matching the D7 sentences out of captured stderr,
 * which is what it used to have to do.
 *
 * Output is unchanged and still happens here, interleaved with the work: the
 * consent notice has to precede the browser (LLP 0063 D3) and the first-sync
 * hold message has to follow its marker write (LLP 0101), so the printing is
 * ordered by the work, not appended to it.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ login?: typeof loginWithBrowser, seed?: typeof seedLoginGateway, enroll?: typeof enrollCentralSink, waitForAttach?: typeof waitForClientAttach, compact?: boolean }} [deps]
 * @returns {Promise<LoginOutcome>}
 * @ref LLP 0179#outcome [implements]: the login lane returns { exitCode, reason }; runRemoteLogin is the adapter that keeps the CLI contract a number
 */
export async function remoteLogin(argv, ctx, deps = {}) {
  const tokenFileArg = valueFlag(argv, '--token-file')
  const tokenFile = tokenFileArg.value
  if (tokenFileArg.present && !tokenFile) {
    ctx.stderr.write('hyp remote login: --token-file expects a path\n')
    return { exitCode: 2, reason: 'usage' }
  }
  const orgArg = valueFlag(argv, '--org')
  const org = orgArg.value
  if (orgArg.present && !org) {
    ctx.stderr.write('hyp remote login: --org expects an org name\n')
    return { exitCode: 2, reason: 'usage' }
  }
  const hostArg = valueFlag(argv, '--host')
  const host = hostArg.value
  if (hostArg.present && !host) {
    ctx.stderr.write('hyp remote login: --host expects a host label\n')
    return { exitCode: 2, reason: 'usage' }
  }
  // The strict gate runs after the three value-flag checks above so their
  // flag-specific wording ("--org expects an org name") survives; what it
  // adds is the refusal for everything neither they nor the readers below
  // name, which used to be dropped in silence.
  const gate = parseCoreCommandArgv('remote login', argv, ctx)
  // `code: 0` is the help path, which printed usage and signed nobody in, so
  // it gets its own reason: 'ok' would tell a LoginOutcome reader the sign-in
  // succeeded (LLP 0179#outcome), and the wizard branches on that.
  if (!gate.ok) {
    if (gate.code === 0) return { exitCode: 0, reason: 'help' }
    return { exitCode: gate.code, reason: 'usage' }
  }
  // Read the target and the mode flags out of what the gate parsed, never out
  // of argv. The codec also accepts the `--flag=true` form for a boolean, so
  // `argv.includes('--no-forward')` was false for `--no-forward=true`: a token
  // the gate had just blessed, dropped in silence, and the machine enrolled
  // for fleet forwarding against an explicit opt-out. Same class the `report`
  // group closed for `--json` and `--yes`.
  // A bare `hyp remote login` (no target) signs in to the default target: an
  // explicit query.default_remote, else the shipped built-in central server.
  // @ref LLP 0062#bare-remote [implements]: bare `remote login` resolves the default target, the companion of bare `--remote`
  const name = /** @type {string | undefined} */ (gate.params.name) ?? effectiveDefaultRemote(ctx.config)
  const forceBrowser = gate.params.browser === true
  const noBrowser = gate.params['no-browser'] === true
  // Enrollment opt-outs (LLP 0063): --no-forward signs in for queries only;
  // --no-daemon provisions the sink but leaves the service install by hand.
  const noForward = gate.params['no-forward'] === true
  const noDaemon = gate.params['no-daemon'] === true

  const stdin = /** @type {any} */ (ctx.stdin ?? process.stdin)
  const stdinPiped = !!stdin && !stdin.isTTY
  // Static path: an explicit token file, or a piped token unless a browser
  // mode flag forces the authorization-code flow.
  const useStatic = !!tokenFile || (stdinPiped && !forceBrowser && !noBrowser)

  if (useStatic) {
    // --org/--host only apply to the browser flow; say so rather than silently drop them.
    if (org) {
      ctx.stderr.write('note: --org is ignored with a static token (it applies to the browser login flow)\n')
    }
    if (host) {
      ctx.stderr.write('note: --host is ignored with a static token (it applies to the browser login flow)\n')
    }
    return runStaticLogin(name, tokenFile, stdin, ctx)
  }

  // Browser flow. `--no-browser` selects it explicitly ("print the URL instead
  // of opening one"), so the flag wins outright: with it set we never read stdin
  // as a static token. A piped token *without* a browser-mode flag already took
  // the static path above (`useStatic`), so nothing is swallowed silently there;
  // only an explicit `--no-browser` ignores a pipe, by design.
  return runBrowserLogin(name, { org, host, noBrowser, noForward, noDaemon, compact: deps.compact === true }, ctx, {
    login: deps.login ?? loginWithBrowser,
    seed: deps.seed ?? seedLoginGateway,
    enroll: deps.enroll ?? enrollCentralSink,
    waitForAttach: deps.waitForAttach ?? waitForClientAttach,
  })
}

/**
 * Return the positional arguments in order, skipping flags and the value slot
 * of any value-taking flag (so e.g. `--org acme` is not read as a positional).
 * The one parser every `remote` subcommand uses (and the `report` group,
 * which shares this file's flag conventions), so a value flag added to any
 * of them never misreads its value as a positional.
 *
 * @param {string[]} argv
 * @param {Set<string>} [valueFlags]
 * @returns {string[]}
 */
export function positionals(argv, valueFlags = new Set()) {
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++ // consume its value (`--flag value`; `--flag=value` carries its own)
      continue
    }
    out.push(a)
  }
  return out
}

/**
 * Read a value-taking flag in either `--flag value` or `--flag=value` form. The
 * `=` form is accepted because the rest of the CLI takes it (e.g. core_commands'
 * `--token-file=`), so `login prod --org=acme` must not silently drop the org and
 * fall through to a no-org browser flow. In the space form a following token that
 * is itself a flag (or absent) is not a value, so the caller can report "expects
 * a value"; in the `=` form the value is explicit (even `''`, which the caller
 * rejects).
 *
 * @param {string[]} argv
 * @param {string} flag e.g. `--org`
 * @returns {{ present: boolean, value: string | undefined }}
 */
export function valueFlag(argv, flag) {
  const eq = `${flag}=`
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === flag) {
      const next = argv[i + 1]
      return { present: true, value: next !== undefined && !next.startsWith('-') ? next : undefined }
    }
    if (a.startsWith(eq)) return { present: true, value: a.slice(eq.length) }
  }
  return { present: false, value: undefined }
}

/**
 * The static-token path (LLP 0033, unchanged behavior): read a token from
 * `--token-file` or piped stdin and store it as a `kind: 'static'` record.
 *
 * @param {string} name
 * @param {string | undefined} tokenFile
 * @param {any} stdin
 * @param {CommandRunContext} ctx
 * @returns {Promise<LoginOutcome>}
 * @ref LLP 0058#d8 [implements]: static token stays the documented headless fallback
 */
async function runStaticLogin(name, tokenFile, stdin, ctx) {
  /** @type {string} */
  let token
  try {
    token = tokenFile
      ? (await fs.readFile(tokenFile, 'utf8')).trim()
      : (await readAllStdin(stdin)).trim()
  } catch (err) {
    ctx.stderr.write(`hyp remote login: ${err instanceof Error ? err.message : String(err)}\n`)
    return { exitCode: 1, reason: 'login_failed' }
  }
  if (!token) {
    ctx.stderr.write('hyp remote login: empty token\n')
    // Non-TTY stdin without a browser-mode flag routes here even when no
    // token was piped; point at the browser flow it bypassed.
    if (!tokenFile) {
      ctx.stderr.write('  (to sign in with a browser instead, re-run with --browser)\n')
    }
    return { exitCode: 2, reason: 'usage' }
  }

  return persistStaticToken(name, token, ctx)
}

/**
 * Store an already-read static token to the 0600 store and print the
 * confirmation, with a nudge when the target isn't configured. Shared by the
 * `--token-file`/piped static path and the `--no-browser`-with-a-piped-token
 * peek.
 *
 * @param {string} name
 * @param {string} token a non-empty, trimmed token
 * @param {CommandRunContext} ctx
 * @returns {Promise<LoginOutcome>}
 */
async function persistStaticToken(name, token, ctx) {
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  try {
    await writeToken(stateDir, name, token)
  } catch (err) {
    // writeToken now contends for the cross-process credentials lock and can
    // throw a lock timeout; keep the friendly `hyp remote login:` contract.
    ctx.stderr.write(`hyp remote login: ${err instanceof Error ? err.message : String(err)}\n`)
    return { exitCode: 1, reason: 'store_failed' }
  }
  ctx.stdout.write(`stored query-scoped token for '${name}'\n`)

  // A friendly nudge if the target isn't configured: the token still
  // stores (an env override may use it), but a typo here is common.
  const remotes = await readConfiguredRemotes(ctx)
  if (!remotes[name]) {
    ctx.stderr.write(`note: '${name}' is not a configured target - add it with 'hyp remote add ${name} <url>'\n`)
  }
  return { exitCode: 0, reason: 'ok' }
}

/**
 * The browser authorization-code path (LLP 0058 D1/D6/D7). Derives the
 * identity base from the configured target URL's origin, runs the poll-based
 * browser flow (LLP 0342), and stores the resulting OIDC session. When the server also mints a
 * login gateway (LLP 0061), the returned credential is seeded into the
 * matching `central` forward sinks' persisted identity. On a fresh box with
 * no such sink, an enrolling login *provisions* one (LLP 0063) so logs forward
 * from one command, unless `--no-forward` declines it.
 *
 * @param {string} name
 * @param {{ org?: string, host?: string, noBrowser: boolean, noForward: boolean, noDaemon: boolean, compact?: boolean }} opts
 * @param {CommandRunContext} ctx
 * @param {{ login: typeof loginWithBrowser, seed: typeof seedLoginGateway, enroll: typeof enrollCentralSink, waitForAttach: typeof waitForClientAttach }} deps
 * @returns {Promise<LoginOutcome>}
 */
async function runBrowserLogin(name, { org, host, noBrowser, noForward, noDaemon, compact = false }, ctx, { login, seed, enroll, waitForAttach }) {
  const remotes = await readConfiguredRemotes(ctx)
  const entry = remotes[name]
  if (!entry) {
    ctx.stderr.write(`hyp remote login: '${name}' is not a configured target - add it first with 'hyp remote add ${name} <url>'\n`)
    ctx.stderr.write("  (or pass a static token with --token-file <path>)\n")
    return { exitCode: 2, reason: 'usage' }
  }
  const identityBase = deriveIdentityBase(entry.url)
  if (!identityBase) {
    ctx.stderr.write(`hyp remote login: target '${name}' has an invalid url (${entry.url})\n`)
    return { exitCode: 2, reason: 'usage' }
  }

  const stateDir = readObservabilityEnv(ctx.env).stateDir

  // One machine, one server (LLP 0063 D4). Already enrolled to *this* server
  // (a central sink targets its origin) means re-login just re-seeds below, and
  // the enrollment notice would be noise. Enrolled to a *different* server (and
  // not this one) means reject before the browser opens so no auth is wasted:
  // switching is 'hyp leave' then log in again, never one command.
  // @ref LLP 0063#d4 [implements]: pre-auth exclusivity gate, rejecting a login to a new server while enrolled elsewhere
  const targetOrigin = originOf(entry.url)
  const enrollment = await readCentralEnrollment({ stateDir, configPath: localConfigPath(ctx) })
  // Fail the gate CLOSED when it cannot read its own input (#623). A central
  // layer that is on disk but does not load, and one whose path this process
  // cannot even resolve (a pointer that is not a slot symlink, a control
  // directory it cannot list), are both enrollments by every other definition
  // the codebase uses: the layer file still names another org's server, and
  // repairing the pointer or the permissions brings it straight back. Reading
  // either one's zero origins as "not enrolled" would let a *second* org
  // enroll an already-enrolled machine - the one thing D4 exists to prevent.
  // Not enrolled is a control directory with no central layer left in it, and
  // that never reaches here.
  // Refuse instead, and name the state we could not read rather than claiming
  // the machine is not connected, which is precisely what we cannot establish.
  // Rejects a same-origin re-login too: with no readable layer there is no
  // origin to compare against, and 'hyp leave' tears down by path, so the
  // advice is actionable either way.
  if (enrollment.unreadable) {
    ctx.stderr.write(`hyp remote login: this machine's central config layer (${enrollment.unreadable.configPath}) cannot be read, so its enrollment cannot be verified\n`)
    ctx.stderr.write(`  ${enrollment.unreadable.message}\n`)
    ctx.stderr.write("  repair it, or disconnect this machine ('hyp leave'), then log in again\n")
    // The D4 gate refused, so it reports the D4 gate's reason (LLP 0179
    // #outcome names `connected_elsewhere` for this gate, not for one of its
    // two messages). The prose keeps the distinction that matters to a human -
    // we could not verify, rather than we verified another server - while the
    // code says only which gate closed, which is all a caller branches on.
    return { exitCode: 2, reason: 'connected_elsewhere' }
  }
  const connectedOrigins = enrollment.origins
  const alreadyEnrolled = targetOrigin !== null && connectedOrigins.includes(targetOrigin)
  if (!alreadyEnrolled && connectedOrigins.length > 0) {
    ctx.stderr.write(`hyp remote login: this machine is connected to ${connectedOrigins[0]}\n`)
    ctx.stderr.write("  disconnect first ('hyp leave'), then log in to the new server\n")
    return { exitCode: 2, reason: 'connected_elsewhere' }
  }

  // Consent is a pre-auth warning, not a prompt (LLP 0063 D3): completing the
  // sign-in is the accepting act. Phrased conditionally because the client
  // can't know pre-auth whether the server will mint a gateway credential.
  // @ref LLP 0063#d3 [implements]: default-on enrollment; the pre-auth notice is the consent surface, never a y/n prompt
  // Compact (the wizard's join lane, LLP 0135 #join) keeps the notice, its
  // placement, its conditional phrasing, and all three consequences D3
  // enumerates, and drops only the line breaks: one line, still before the
  // browser. The hedge is not shortenable - the client still cannot know
  // pre-auth whether a gateway will be minted, so a flat "signing in forwards
  // your logs" is false against a forwarding-off org. Neither is the org-config
  // clause: applying org config is what attaches clients and backfills the
  // history already on disk, and no reader infers that from "forwards captured
  // logs". This notice is the whole consent surface, so a consequence dropped
  // here is one the user is never told before they authenticate.
  // The '--no-forward' sentence is the one thing left out: the wizard's lane
  // runs a bare login (LLP 0134 #no-token-join) and cannot pass the flag, and
  // the fork already offered the no-forwarding pathway as a choice.
  if (!alreadyEnrolled && !noForward) {
    if (compact) {
      ctx.stderr.write('note: if your org has enabled forwarding, signing in enrolls this machine: it forwards captured logs to the server, applies org config (which can attach clients and backfill existing local history), and installs a background service (Ctrl-C to cancel)\n')
    } else {
      ctx.stderr.write('note: if your org has enabled forwarding, signing in will enroll this machine:\n')
      ctx.stderr.write('  it forwards captured logs to the server, applies org config (which can attach\n')
      ctx.stderr.write('  clients and backfill existing local history), and installs a background service.\n')
      ctx.stderr.write("  re-run with --no-forward to sign in for queries only, or Ctrl-C to cancel.\n")
    }
  }

  /** @type {OidcSession} */
  let session
  try {
    session = await login({
      identityBase,
      org,
      // The host label is advisory (server-side dedup + admin attribution,
      // LLP 0061 D6): the machine hostname unless overridden with --host.
      host: host ?? os.hostname(),
      noBrowser,
      compact,
      print: (line) => ctx.stderr.write(`${line}\n`),
      // Compact announces the sign-in wait with a spinner, so it needs a stream
      // and the env that vetoes animation, same as the attach wait below.
      stdout: ctx.stdout,
      env: ctx.env,
    })
  } catch (err) {
    const callbackError = /** @type {any} */ (err)?.callbackError
    ctx.stderr.write(`hyp remote login: ${explainLoginError(callbackError, err)}\n`)
    // A server-surfaced callback error (org selection, membership) is already
    // actionable. A local failure - most importantly a timeout, which is what a
    // headless box hits when the opener silently fails - is not, so point at the
    // headless escape hatches rather than leaving the user stuck (LLP 0058 D8).
    if (!callbackError) {
      ctx.stderr.write("  (on a machine with no browser, pass a static token with --token-file <path> or pipe it on stdin; --no-browser prints the URL to open elsewhere)\n")
    }
    // The server's own refusal code, carried out as the reason: this is the
    // fact the wizard used to reconstruct by matching explainLoginError's
    // English back out of stderr (LLP 0179#no-prose-control-flow).
    return { exitCode: 1, reason: loginFailureReason(callbackError) }
  }
  // The single-use code is already spent by here, so a write failure (most
  // likely a lock timeout under a concurrent hyp process) is not a login
  // failure: say the sign-in worked but the store did not, and do not print the
  // headless hint, which would wrongly imply the browser flow itself failed.
  try {
    await writeSession(stateDir, name, session)
  } catch (err) {
    ctx.stderr.write(`hyp remote login: signed in but could not store the session: ${err instanceof Error ? err.message : String(err)}\n`)
    ctx.stderr.write("  (re-run 'hyp remote login' once any other hyp process releases the credentials lock)\n")
    return { exitCode: 1, reason: 'store_failed' }
  }
  ctx.stdout.write(compact ? `✓ Signed in to '${name}' as org '${session.org}'\n` : `logged in to '${name}' as org '${session.org}'\n`)

  // No gateway credential (server didn't mint one, or --no-forward): query-only
  // login, nothing to forward. --no-forward with a minted gateway discards it
  // unseeded (LLP 0063 D3) - declining enrollment, not just forwarding.
  if (!session.gateway) return { exitCode: 0, reason: 'ok' }
  if (noForward) {
    // --no-forward declines *new* enrollment; it cannot un-enroll a machine
    // that already forwards (that is `hyp leave`). Tell the truth for each case
    // rather than always claiming "not enrolled".
    if (alreadyEnrolled) {
      ctx.stdout.write("note: --no-forward - signed in for queries only; this machine stays enrolled and keeps forwarding (run 'hyp leave' to stop)\n")
    } else {
      ctx.stdout.write('note: --no-forward - signed in for queries only; this machine is not enrolled and will not forward logs\n')
    }
    return { exitCode: 0, reason: 'ok' }
  }

  // One login, two credentials (LLP 0061 D1): the gateway credential seeds the
  // matching central forward sinks so the user forwards without a bootstrap
  // token. The query session above is already stored, so a seed failure is
  // reported as exactly that - not a login failure.
  // @ref LLP 0061#d1 [implements]: gateway credential routes to the forward store; the query record is untouched by it
  /** @type {Awaited<ReturnType<typeof seedLoginGateway>>} */
  let seeded
  try {
    seeded = await seed({ stateDir, configPath: localConfigPath(ctx), targetUrl: entry.url, gateway: session.gateway })
  } catch (err) {
    ctx.stderr.write(`hyp remote login: signed in, but could not seed the forwarding credential: ${err instanceof Error ? err.message : String(err)}\n`)
    return { exitCode: 1, reason: 'seed_failed' }
  }

  // The in-login local-only picker is retired (LLP 0102): enrollment-time
  // privacy refinement is now the first-sync review window plus the
  // hypaware-privacy skill, run afterwards against a settled cache. Login
  // finishes fast; each fork prints the durable-command hint so the CLI floor
  // (`hyp policy set [path] local-only`, `hyp policy set [path] ignore`) stays
  // discoverable.

  // No sink targets this server yet: provision one so login forwards from one
  // command (LLP 0063 D2/D5). enrollCentralSink writes join's sink block, seeds
  // this identity into it, and finishes with join's daemon install.
  // @ref LLP 0063#d2 [implements]: an enrolling login provisions the central sink the dead-end note used to only describe
  if (seeded.length === 0) {
    // The forward sink joins '/v1/ingest/...' onto its url, so it must be the
    // server origin, not the '<origin>/mcp' query target we logged in against.
    const centralUrl = targetOrigin ?? entry.url
    // Open the first-sync review window before provisioning: the daemon this
    // enroll installs attaches and backfills, and its first export ticks could
    // otherwise forward captured history the user has not yet reviewed - a
    // one-time, unretractable leak (LLP 0069 R6). The hold marker lands BEFORE
    // enrollCentralSink so no daemon tick can beat it onto disk, and it runs to
    // its absolute deadline with no early release (LLP 0101 #no-release): there
    // is no finally clear. The deadline is bounded (next local 11:59pm), so a
    // crashed or abandoned login can never stall exports past it. Best-effort:
    // a failed marker write degrades to today's behavior (no hold) rather than
    // failing the login. `hyp join` and re-logins write nothing (LLP 0101
    // #which) - only this attended enrolling fork holds.
    // @ref LLP 0101 [implements]: attended enrolling login writes the hold before enrollCentralSink, no clear-on-exit
    const holdDeadline = await markFirstSyncHoldBestEffort(stateDir)

    /** @type {Awaited<ReturnType<typeof enrollCentralSink>>} */
    let result
    try {
      result = await enroll({ ctx, url: centralUrl, gateway: session.gateway, noDaemon, compact })
    } catch (err) {
      ctx.stderr.write(`hyp remote login: signed in, but enrollment failed: ${err instanceof Error ? err.message : String(err)}\n`)
      return { exitCode: 1, reason: 'enroll_failed' }
    }
    if (result.connectedElsewhere) {
      ctx.stderr.write(`hyp remote login: this machine connected to ${result.connectedElsewhere} during sign-in - not enrolling\n`)
      return { exitCode: 1, reason: 'connected_elsewhere' }
    }
    // Name the server, don't print its URL: every modern terminal autolinks a
    // bare `https://` run (there is no escape that suppresses it), and this
    // origin is a service endpoint, so the click lands on `unknown_path`
    // (#391). Scope: this rule binds the *success* surfaces - this line and the
    // privacy block - not the error paths above and below, where the origin is
    // the fact you need to act on (which server to `hyp leave`) and a label
    // would not do. Those still print bare origins, and deliberately so.
    //
    // Pair the name with its lookup: `name` can come from
    // `effectiveDefaultRemote` on a bare login, so it is not always something
    // the user typed, and no other line in this login recovers the URL.
    // Revisit if the server root ever becomes a real landing page.
    // @ref LLP 0100#requirements [implements]: R1a - the forwarding line names the target and pairs it with its lookup
    if (compact) {
      ctx.stdout.write(`✓ Forwarding to the '${name}' server (run 'hyp remote list' to see its URL)\n`)
    } else {
      ctx.stdout.write(`forwarding logs to the '${name}' server\n`)
      ctx.stdout.write("  (run 'hyp remote list' to see its URL)\n")
    }
    // Print the deadline once, ahead of every exit branch below (--no-daemon,
    // a failed daemon install, or the normal attach-wait path): the hold and
    // its deadline are already committed to disk regardless of how the daemon
    // install itself goes, so the message stays true in all three. Absent only
    // when the best-effort marker write above failed (LLP 0100 R1's message
    // rides the hold, never invents one that was not actually written).
    // Compact prints the deadline alone. The wizard that asked for it states
    // the rest of R1 (the backfill statement, the skill hint, the release verb)
    // in its closing privacy narration, which every path through it reaches -
    // the ordinary close and `narrateEnrolledAbort` alike - so the full block
    // here would say everything twice on the same run.
    // The line states the deadline and the fact the hold guarantees, and
    // nothing about being prompted: the send-now offer (LLP 0203) runs only on
    // an attended, uncancelled, non-dry close, and at the deadline itself the
    // hold simply lapses (LLP 0101 #no-release). A promise of an ask here
    // would be false on exactly the paths where it would matter.
    // @ref LLP 0100#requirements [constrained-by]: R1 - compact carries the deadline; the wizard's own narration carries the backfill statement, the skill hint, and the release verb
    // @ref LLP 0387#adjacency [implements]: compact meets R1a as a pair - the forwarding line directly above carries the server name and the 'hyp remote list' lookup for both lines
    if (holdDeadline !== null && compact) {
      ctx.stderr.write(`✓ First sync no later than ${formatFirstSyncDeadline(holdDeadline)}; nothing has been uploaded yet\n`)
    } else if (holdDeadline !== null) {
      ctx.stderr.write(firstSyncHoldMessage(holdDeadline, name))
    }
    // Without the daemon there is nothing to wait on: it is what pulls the org
    // config and runs the attach reconcile. Say what is left to do and stop.
    if (noDaemon) {
      ctx.stdout.write("daemon install skipped (--no-daemon); run 'hyp daemon install' to finish enrolling\n")
      if (!compact) ctx.stderr.write(DURABLE_HINT)
      return { exitCode: 0, reason: 'ok' }
    }
    // The exit code stays the installer's, so a script still sees a failure,
    // and `daemon_incomplete` tells the wizard that the sign-in nonetheless
    // completed (LLP 0179#outcome, "the other exception the other way").
    if (result.daemonCode !== 0) {
      ctx.stderr.write(daemonIncompleteNote(process.platform, 'enrolled'))
      if (!compact) ctx.stderr.write(DURABLE_HINT)
      return { exitCode: result.daemonCode, reason: 'daemon_incomplete' }
    }
    // The daemon is installed; it now pulls the org config and auto-attaches any
    // clients it enables (LLP 0044). Wait for that first reconcile so we report
    // the real capture state instead of guessing - the follow-up (server LLP
    // 0043) made auto-attach the primary path, so the old unconditional
    // "nothing is captured yet" was stale on every login. Timing out just means
    // nothing attached (no org config, or a slow pull): fall back to `hyp
    // status`, never silent (LLP 0061 D4).
    // @ref LLP 0063#login-config-pull [implements]: report attach ground truth by waiting on the reconcile, replacing the interim pre-pull hint
    // Announce the wait: the reconcile is async and can take the full budget on a
    // no-config / slow-pull org, and blocking silently for up to 30s reads as a
    // hang. One line on stderr before we start polling, then the result below.
    // Compact: the same wait behind a spinner that clears itself, so the line
    // that announced the wait is not left behind once the answer is in.
    if (!compact) ctx.stderr.write(`waiting for the daemon to attach clients (up to ${Math.round(ATTACH_WAIT_DEFAULT_MS / 1000)}s)...\n`)
    const wait = () => waitForAttach({ env: ctx.env })
    const attached = compact
      ? await withSpinner({ stdout: ctx.stdout, env: ctx.env, label: 'Attaching clients...' }, wait)
      : await wait()
    if (attached.length > 0) {
      ctx.stdout.write(compact ? `✓ Capturing ${attached.join(', ')}\n` : `capturing ${attached.join(', ')}\n`)
    } else {
      ctx.stdout.write("no clients attached yet - check 'hyp status', or run 'hyp client attach <client>' to capture\n")
    }
    if (!compact) ctx.stderr.write(DURABLE_HINT)
    return { exitCode: 0, reason: 'ok' }
  }

  // A matching sink already existed: this was a re-seed (already enrolled).
  for (const s of seeded) {
    // Never silent about a displaced identity (LLP 0061 D4). A re-login over a
    // prior login seed for the same server is idempotent (the server dedups to
    // the same gateway), so only a different provenance is worth a note.
    if (s.replaced && !(s.replaced.origin === 'login' && s.replaced.central_url === s.centralUrl)) {
      const provenance = s.replaced.origin === 'login' ? 'login-minted' : 'bootstrap-minted'
      const from = s.replaced.central_url && s.replaced.central_url !== s.centralUrl
        ? ` for ${s.replaced.central_url}`
        : ''
      ctx.stderr.write(`note: this replaced a ${provenance} gateway identity${from} (was gateway ${s.replaced.gateway_id})\n`)
    }
  }

  // Already-enrolled machine (re-login / re-seed): a prior daemon has run and is
  // already forwarding, so there is no "first" sync to defer - this fork writes
  // no hold (LLP 0101 #which). The durable CLI floor stays discoverable, and
  // compact suppresses it on this exit as on the three above - otherwise a
  // wizard join onto an already-enrolled machine prints, mid-checklist, the
  // one tip the compact lane exists to keep off it.
  if (!compact) ctx.stderr.write(DURABLE_HINT)
  return { exitCode: 0, reason: 'ok' }
}

/**
 * The D7 messages that describe a *definitive* login rejection: retrying the
 * same bare login cannot fix any of them. For `no_membership` and
 * `org_not_permitted` an admin has to act; for `org_selection_required` (a
 * multi-org account with no selector) the user has to pick an org via
 * `hyp remote login --org <name>`, which the wizard's bare login cannot supply.
 *
 * Prose, and nothing else. These were exported so the wizard could recognize
 * a refusal by substring-matching them out of captured stderr, which made
 * English load-bearing; `loginFailureReason` reports the same distinctions as
 * codes now, so these can be reworded freely.
 * @ref LLP 0179#no-prose-control-flow [implements]: the messages stop being API
 */
const LOGIN_NO_MEMBERSHIP_MESSAGE = 'this account is not a member of any org on this server - ask an admin to invite you'
const LOGIN_ORG_NOT_PERMITTED_MESSAGE = 'the selected org is not permitted for this account - check the --org name'
const LOGIN_ORG_SELECTION_MESSAGE = 'this account has more than one org - re-run with --org <name> to choose one'

/**
 * The reason code behind a failed sign-in: the server-surfaced callback error
 * (LLP 0058 D7) when there was one, otherwise a local failure - a poll
 * timeout, a network error, an abandoned browser flow - which is retriable and
 * so is not one of the definitive refusals.
 *
 * The `default` covers a code we do not model (a new server refusal, or a raw
 * OAuth error): retriable is the safe reading, since the alternative tells a
 * user to stop trying over a code we do not understand.
 *
 * @param {string | undefined} callbackError
 * @returns {LoginOutcome['reason']}
 * @ref LLP 0179#outcome [implements]: the D7 code the terminal explains, reported rather than re-derived
 */
function loginFailureReason(callbackError) {
  switch (callbackError) {
    case 'no_membership':
      return 'no_membership'
    case 'org_not_permitted':
      return 'org_not_permitted'
    case 'org_selection_required':
      return 'org_selection_required'
    case 'access_denied':
      return 'denied'
    default:
      return 'login_failed'
  }
}

/**
 * Translate a server-surfaced callback `error` (D7) into a clear message. The
 * client never sees the user's org list, so `org_selection_required` instructs
 * a re-run with `--org` rather than enumerating.
 *
 * @param {string | undefined} callbackError
 * @param {unknown} err
 * @returns {string}
 * @ref LLP 0058#d7 [implements]: org selector errors explained; never enumerate the user's orgs
 */
function explainLoginError(callbackError, err) {
  switch (callbackError) {
    case 'access_denied':
      return 'login was denied at the provider'
    case 'no_membership':
      return LOGIN_NO_MEMBERSHIP_MESSAGE
    case 'org_selection_required':
      return LOGIN_ORG_SELECTION_MESSAGE
    case 'org_not_permitted':
      return LOGIN_ORG_NOT_PERMITTED_MESSAGE
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

/**
 * `hyp remote mint [name] [--label <label>] [--expires-days <n>]`: mint a
 * long-lived CI enrollment token against the target server and print it once.
 *
 * The token is the CI counterpart of an operator-distributed bootstrap token
 * (LLP 0063 D6): the server binds it to one gateway row created at mint time,
 * and every CI run that `hyp join`s with it exchanges it for its own
 * short-lived gateway JWT against that same shared gateway, so the secret in
 * CI never rotates. The caller authenticates with their logged-in OIDC
 * session; the request rides the shared one-shot refresh + retry policy
 * (LLP 0058 D5).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ fetchImpl?: typeof fetch }} [deps] test seam for the mint request
 * @returns {Promise<number>}
 * @ref LLP 0298#mint [implements]: user-minted CI token from the logged-in session; printed once, 365-day default expiry
 */
export async function runRemoteMint(argv, ctx, deps = {}) {
  const gate = parseCoreCommandArgv('remote mint', argv, ctx)
  if (!gate.ok) return gate.code
  // Bare `hyp remote mint` targets the default remote, like bare `remote login`.
  // @ref LLP 0062#bare-remote [implements]: bare `remote mint` resolves the default target
  const name = /** @type {string | undefined} */ (gate.params.name) ?? effectiveDefaultRemote(ctx.config)
  const label = /** @type {string | undefined} */ (gate.params.label)
  // Bounded and defaulted by the schema (LLP 0293), so no second check here.
  const expiresDays = /** @type {number} */ (gate.params['expires-days'])
  const remotes = await readConfiguredRemotes(ctx)
  const entry = remotes[name]
  if (!entry) {
    ctx.stderr.write(`hyp remote mint: unknown remote target '${name}' - add it with 'hyp remote add ${name} <url>'\n`)
    return 2
  }
  const identityBase = deriveIdentityBase(entry.url)
  if (!identityBase) {
    ctx.stderr.write(`hyp remote mint: cannot derive the identity endpoint from '${entry.url}'\n`)
    return 2
  }
  // The recipe must name the server BASE, not the registered target URL. A
  // target may legitimately be registered as `<base>/v1/mcp` (LLP 0084 D2, and
  // the shape docs/CLI_REFERENCE.md shows for `hyp remote add`), and `hyp join`
  // stores its url argument verbatim as the central sink url, which central's
  // IdentityClient then resolves `/v1/identity/bootstrap` against. Pasting the
  // registered URL through would 404 every CI run while minting here still
  // worked, since deriveIdentityBase already reduces to the origin.
  const joinTarget = new URL(entry.url).origin
  const doFetch = deps.fetchImpl ?? /** @type {typeof fetch | undefined} */ (globalThis.fetch)
  if (typeof doFetch !== 'function') {
    ctx.stderr.write(`hyp remote mint: ${NO_FETCH_MESSAGE}\n`)
    return 1
  }

  const stateDir = readObservabilityEnv(ctx.env).stateDir
  /** @type {Awaited<ReturnType<typeof resolveAccessJwt>>} */
  let resolved
  try {
    resolved = await resolveAccessJwt({ target: name, env: ctx.env, stateDir, identityBase, fetchImpl: deps.fetchImpl })
  } catch (err) {
    const { sessionExpired, message } = describeRefreshError(err, name)
    ctx.stderr.write(`hyp remote mint: ${message}\n`)
    return sessionExpired ? 2 : 1
  }
  if (!resolved.ok) {
    ctx.stderr.write(`hyp remote mint: ${resolved.error}\n`)
    return 2
  }

  /** @param {string} token @returns {Promise<{ authFailed: boolean, value: { ok: true, response: Response } | { ok: false, error: string } }>} */
  const op = async (token) => {
    /** @type {Response} */
    let response
    try {
      response = await doFetch(`${identityBase}/mint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ expires_days: expiresDays, ...(label !== undefined ? { label } : {}) }),
      })
    } catch (err) {
      return { authFailed: false, value: { ok: false, error: err instanceof Error ? err.message : String(err) } }
    }
    return { authFailed: response.status === 401, value: { ok: true, response } }
  }

  /** @type {{ ok: true, value: { ok: true, response: Response } | { ok: false, error: string }, authFailed: boolean } | { ok: false, error: string }} */
  let out
  try {
    out = await attachWithRefresh({
      resolved,
      refresh: () => resolveAccessJwt({ target: name, env: ctx.env, stateDir, identityBase, fetchImpl: deps.fetchImpl, forceRefresh: true }),
      op,
    })
  } catch (refreshErr) {
    const { sessionExpired, message } = describeRefreshError(refreshErr, name)
    ctx.stderr.write(`hyp remote mint: ${message}\n`)
    return sessionExpired ? 2 : 1
  }
  if (!out.ok) {
    ctx.stderr.write(`hyp remote mint: ${out.error}\n`)
    return 2
  }
  if (out.authFailed) {
    // A 401 that survives the retry is ambiguous here for the same reason it is
    // on the reports plane (LLP 0155 #write-401): this server answers 401, not
    // 403, to a live session that lacks a scope, so the 403 branch below never
    // fires for that case. Naming only expiry would send a user who cannot mint
    // round the re-login loop forever, so say both causes.
    if (isRefreshable(resolved)) {
      ctx.stderr.write(
        `hyp remote mint: '${name}' refused the credential (HTTP 401) - your session may have expired ` +
          `(re-run 'hyp remote login ${name}'), or your account may not be permitted to mint CI tokens; ` +
          `ask a server admin\n`,
      )
      return 1
    }
    const { message, exitCode } = describeAuthRejection({ target: name, status: 401, resolved })
    ctx.stderr.write(`hyp remote mint: ${message}\n`)
    return exitCode
  }
  if (!out.value.ok) {
    ctx.stderr.write(`hyp remote mint: ${out.value.error}\n`)
    return 1
  }

  const response = out.value.response
  if (response.status === 404) {
    ctx.stderr.write(`hyp remote mint: '${name}' does not support minting CI tokens (HTTP 404) - the server may predate this feature\n`)
    return 1
  }
  if (response.status === 403) {
    ctx.stderr.write(`hyp remote mint: '${name}' refused to mint (HTTP 403) - your account may not be permitted to mint CI tokens; ask a server admin\n`)
    return 1
  }
  /** @type {string} */
  let text = ''
  try {
    text = await response.text()
  } catch {
    // fall through to the shape checks below with an empty body
  }
  if (!response.ok) {
    ctx.stderr.write(`hyp remote mint: mint failed (HTTP ${response.status})${text ? ` - ${text.slice(0, 200)}` : ''}\n`)
    return 1
  }
  /** @type {any} */
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  const token = isPlainObject(json) && typeof json.token === 'string' && json.token.length > 0 ? json.token : undefined
  if (!token) {
    ctx.stderr.write(`hyp remote mint: the server's mint response carried no token\n`)
    return 1
  }
  const gatewayId = isPlainObject(json) && typeof json.gateway_id === 'string' ? json.gateway_id : undefined
  // The identity plane sends `expires_at` as a Unix epoch-second, not an ISO
  // string, and `/mint` is a sibling of `/token` (LLP 0298 D3), so reuse the
  // one normalization instead of pattern-matching a string here. Display only:
  // the token is shown once, so an unreadable expiry is dropped rather than
  // allowed to fail the print that carries the secret.
  const expiresAt = isPlainObject(json) ? readExpiry(json.expires_at) : undefined

  // The token goes to stdout alone; every advisory line goes to stderr, as the
  // first-sync consent block above already does. `hyp remote mint > ci.token`
  // and `TOKEN=$(hyp remote mint)` are the natural ways to move a printed
  // secret, and a banner captured into the secret store is not recoverable:
  // the token is never shown again, and re-minting creates a second gateway
  // row (LLP 0298 D2).
  const detail = [gatewayId ? `gateway ${gatewayId}` : '', expiresAt ? `expires ${expiresAt}` : ''].filter(Boolean).join(', ')
  ctx.stderr.write(`minted CI token for '${name}'${detail ? ` (${detail})` : ''}\n`)
  ctx.stdout.write(`${token}\n`)
  ctx.stderr.write('store it in your CI secrets now - it is not shown again\n')
  ctx.stderr.write('CI recipe:\n')
  // The token reaches `hyp join` on stdin, never as an argv positional: it is a
  // long-lived shared secret, and `hyp join`'s own help and CLI reference both
  // say a positional token lands in shell history and process listings - which
  // on a CI runner means `ps` and any `set -x` trace.
  ctx.stderr.write(`  setup:    printf '%s' "$HYP_CI_TOKEN" | hyp join ${joinTarget} --no-daemon\n`)
  ctx.stderr.write('            hyp daemon run --foreground &\n')
  ctx.stderr.write('  teardown: hyp sync --yes\n')
  return 0
}

/**
 * Render an identity `expires_at` for display, or `undefined` when the server
 * omitted it or sent something unreadable.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readExpiry(value) {
  if (value === undefined || value === null) return undefined
  try {
    return expiryTimestamp(value, 'expires_at')
  } catch {
    return undefined
  }
}

/**
 * `hyp remote list`: targets + token status (`stored` / `env` / `missing`),
 * never the token itself.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runRemoteList(argv, ctx) {
  const parsed = parseCoreCommandArgv('remote list', argv, ctx)
  if (!parsed.ok) return parsed.code
  const json = parsed.params.json === true
  const remotes = await readConfiguredRemotes(ctx)
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const stored = await readCredentials(stateDir)
  const names = Object.keys(remotes).sort()

  /** @param {string} name */
  const tokenStatus = (name) => {
    if (typeof ctx.env[remoteTokenEnvVar(name)] === 'string' && ctx.env[remoteTokenEnvVar(name)]) return 'env'
    return stored[name] ? 'stored' : 'missing'
  }

  if (json) {
    ctx.stdout.write(JSON.stringify(
      names.map((name) => ({ name, url: remotes[name].url, token: tokenStatus(name) })),
      null,
      2
    ) + '\n')
    return 0
  }
  if (names.length === 0) {
    ctx.stdout.write("no remote targets configured - add one with 'hyp remote add <name> <url>'\n")
    return 0
  }
  for (const name of names) {
    ctx.stdout.write(`  ${name}\t${remotes[name].url}\ttoken: ${tokenStatus(name)}\n`)
  }
  return 0
}

/**
 * `hyp remote remove <name>`: drop the target from config + its stored token.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runRemoteRemove(argv, ctx) {
  const parsed = parseCoreCommandArgv('remote remove', argv, ctx)
  if (!parsed.ok) return parsed.code
  const name = String(parsed.params.name)
  let removedConfig = false
  const configPath = localConfigPath(ctx)
  try {
    await mutateLocalConfig(configPath, (config) => {
      if (isPlainObject(config.query) && isPlainObject(config.query.remotes) && config.query.remotes[name] !== undefined) {
        delete config.query.remotes[name]
        removedConfig = true
        if (config.query.default_remote === name) delete config.query.default_remote
      }
    })
  } catch (err) {
    ctx.stderr.write(`hyp remote remove: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  let removedToken = false
  try {
    removedToken = await removeToken(stateDir, name)
  } catch (err) {
    // removeToken now contends for the cross-process credentials lock and can
    // throw a lock timeout. The config edit above already landed, so report the
    // partial state rather than letting a raw error escape.
    ctx.stderr.write(`hyp remote remove: ${err instanceof Error ? err.message : String(err)}\n`)
    if (removedConfig) {
      ctx.stderr.write(`  (removed '${name}' from config; its stored token could not be removed)\n`)
    }
    return 1
  }
  if (!removedConfig && !removedToken) {
    ctx.stderr.write(`hyp remote remove: no target or token named '${name}'\n`)
    return 1
  }
  ctx.stdout.write(`removed remote '${name}'${removedToken ? ' (config + token)' : ' (config)'}\n`)
  return 0
}

/* ---------- helpers ---------- */

/**
 * @param {CommandRunContext} ctx
 * @returns {string}
 */
function localConfigPath(ctx) {
  if (ctx.env.HYP_CONFIG) return path.resolve(ctx.env.HYP_CONFIG)
  return defaultConfigPath(readObservabilityEnv(ctx.env).hypHome)
}

/**
 * Read the configured `query.remotes` from the local config file (raw, so a
 * malformed-but-readable file still surfaces what targets exist).
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<Record<string, { url: string }>>}
 */
async function readConfiguredRemotes(ctx) {
  // Ship the built-in targets under any user-defined ones, so `remote login`
  // and `remote list` see the central server even before a `remote add`; a
  // user entry of the same name overrides it.
  /** @type {Record<string, { url: string }>} */
  const out = { ...BUILTIN_REMOTES }
  const config = await readLocalConfigRaw(localConfigPath(ctx))
  if (isPlainObject(config.query) && isPlainObject(config.query.remotes)) {
    for (const [name, entry] of Object.entries(config.query.remotes)) {
      if (isPlainObject(entry) && typeof entry.url === 'string') out[name] = { url: entry.url }
    }
  }
  return out
}

/**
 * Create-or-augment the local config file with `mutate`. Reads the raw JSON
 * (preserving the user's file), applies the mutation, and writes atomically.
 *
 * @param {string} configPath
 * @param {(config: any) => void} mutate
 * @returns {Promise<void>}
 */
async function mutateLocalConfig(configPath, mutate) {
  const config = await readLocalConfigRaw(configPath)
  if (config.version === undefined) config.version = 2
  mutate(config)
  await atomicWriteJson(configPath, config)
}

/**
 * @param {string} configPath
 * @returns {Promise<any>}
 */
async function readLocalConfigRaw(configPath) {
  let raw
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { version: 2 }
    throw err
  }
  try {
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : { version: 2 }
  } catch {
    throw new Error(`local config is not valid JSON: ${configPath}`)
  }
}

