// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { defaultConfigPath } from '../config/schema.js'
import { readObservabilityEnv } from '../observability/env.js'
import { BUILTIN_REMOTES, effectiveDefaultRemote } from '../remote/builtin_remotes.js'
import {
  deriveIdentityBase,
  readCredentials,
  remoteTokenEnvVar,
  removeToken,
  writeSession,
  writeToken,
} from '../remote/credentials.js'
import { readCentralSinkOrigins, seedLoginGateway } from '../remote/gateway_seed.js'
import { enrollCentralSink } from '../commands/central.js'
import { originOf } from '../remote/gateway_seed.js'
import { readAllStdin } from './stdio.js'
import { isPlainObject } from '../util/json_util.js'
import { loginWithBrowser } from '../remote/oidc_login.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { loadClientDescriptors, probeAttachedClients } from '../daemon/status.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { OidcSession } from '../../../src/core/remote/types.js'
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
 * re-reads the client settings files, so a poll is cheap and — the point — never
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
  const resolvedHome = homeDir ?? env.HOME ?? process.env.HOME ?? ''
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
 * Core `remote` commands manage named MCP targets + their query-scoped
 * tokens (LLP 0033 §commands). `hyp` is the MCP client on the human-CLI
 * path, so these are **core**, not a plugin. `remote add` is a local-layer
 * config writer (create-or-augment); `remote login` writes the `0600`
 * credential store. An admin who never ran HypAware gets queryable in two
 * commands: `remote add prod <url>` → `remote login prod`.
 */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runRemoteHelp(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp remote <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: add, login, list, remove\n')
    ctx.stdout.write('  login: browser sign-in by default; --token-file/stdin for a static token,\n')
    ctx.stdout.write('         --org <name> to select an org, --no-browser to print the URL,\n')
    ctx.stdout.write('         --host <label> to override the forwarding host label (default: hostname),\n')
    ctx.stdout.write('         --no-forward to sign in for queries only (no fleet enrollment),\n')
    ctx.stdout.write('         --no-daemon to provision the sink without installing the service\n')
    return 0
  }
  ctx.stderr.write(`hyp remote: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: add, login, list, remove\n')
  return 2
}

/**
 * `hyp remote add <name> <url>`: register (or update) a target in the
 * local config's `query.remotes`. The URL is non-secret and committable.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0033#commands [implements]: `remote add` is a local-layer writer; URL in config, token never in config
 */
export async function runRemoteAdd(argv, ctx) {
  const [name, url] = positionals(argv)
  if (!name || !url) {
    ctx.stderr.write('usage: hyp remote add <name> <url>\n')
    return 2
  }
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
 * only — the login-minted gateway is discarded, no central sink is written.
 * `--no-daemon` provisions the sink but skips the service install (D5).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ login?: typeof loginWithBrowser, seed?: typeof seedLoginGateway, enroll?: typeof enrollCentralSink, waitForAttach?: typeof waitForClientAttach }} [deps] test seam for the browser flow, gateway seeding, central-sink enrollment, and the post-enroll attach wait
 * @ref LLP 0058#d1 [implements]: browser mode of `hyp remote login`; one command, one store, one more way to populate it
 */
export async function runRemoteLogin(argv, ctx, deps = {}) {
  const tokenFileArg = valueFlag(argv, '--token-file')
  const tokenFile = tokenFileArg.value
  if (tokenFileArg.present && !tokenFile) {
    ctx.stderr.write('hyp remote login: --token-file expects a path\n')
    return 2
  }
  const orgArg = valueFlag(argv, '--org')
  const org = orgArg.value
  if (orgArg.present && !org) {
    ctx.stderr.write('hyp remote login: --org expects an org name\n')
    return 2
  }
  const hostArg = valueFlag(argv, '--host')
  const host = hostArg.value
  if (hostArg.present && !host) {
    ctx.stderr.write('hyp remote login: --host expects a host label\n')
    return 2
  }
  // The target name is the first positional. Skip the VALUE slot of a
  // value-taking flag so e.g. `login --org acme` (name omitted) is not misread
  // as the target 'acme'.
  // A bare `hyp remote login` (no target) signs in to the default target: an
  // explicit query.default_remote, else the shipped built-in central server.
  // @ref LLP 0062#bare-remote [implements]: bare `remote login` resolves the default target, the companion of bare `--remote`
  const name = positionals(argv, new Set(['--token-file', '--org', '--host']))[0] ?? effectiveDefaultRemote(ctx.config)
  const forceBrowser = argv.includes('--browser')
  const noBrowser = argv.includes('--no-browser')
  // Enrollment opt-outs (LLP 0063): --no-forward signs in for queries only;
  // --no-daemon provisions the sink but leaves the service install by hand.
  const noForward = argv.includes('--no-forward')
  const noDaemon = argv.includes('--no-daemon')

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
  return runBrowserLogin(name, { org, host, noBrowser, noForward, noDaemon }, ctx, {
    login: deps.login ?? loginWithBrowser,
    seed: deps.seed ?? seedLoginGateway,
    enroll: deps.enroll ?? enrollCentralSink,
    waitForAttach: deps.waitForAttach ?? waitForClientAttach,
  })
}

/**
 * Return the positional arguments in order, skipping flags and the value slot
 * of any value-taking flag (so e.g. `--org acme` is not read as a positional).
 * The one parser every `remote` subcommand uses, so a value flag added to any
 * of them never misreads its value as a positional.
 *
 * @param {string[]} argv
 * @param {Set<string>} [valueFlags]
 * @returns {string[]}
 */
function positionals(argv, valueFlags = new Set()) {
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
function valueFlag(argv, flag) {
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
 * @returns {Promise<number>}
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
    return 1
  }
  if (!token) {
    ctx.stderr.write('hyp remote login: empty token\n')
    // Non-TTY stdin without a browser-mode flag routes here even when no
    // token was piped; point at the browser flow it bypassed.
    if (!tokenFile) {
      ctx.stderr.write('  (to sign in with a browser instead, re-run with --browser)\n')
    }
    return 2
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
 * @returns {Promise<number>}
 */
async function persistStaticToken(name, token, ctx) {
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  try {
    await writeToken(stateDir, name, token)
  } catch (err) {
    // writeToken now contends for the cross-process credentials lock and can
    // throw a lock timeout; keep the friendly `hyp remote login:` contract.
    ctx.stderr.write(`hyp remote login: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  ctx.stdout.write(`stored query-scoped token for '${name}'\n`)

  // A friendly nudge if the target isn't configured: the token still
  // stores (an env override may use it), but a typo here is common.
  const remotes = await readConfiguredRemotes(ctx)
  if (!remotes[name]) {
    ctx.stderr.write(`note: '${name}' is not a configured target - add it with 'hyp remote add ${name} <url>'\n`)
  }
  return 0
}

/**
 * The browser authorization-code path (LLP 0058 D1/D6/D7). Derives the
 * identity base from the configured target URL's origin, runs the loopback
 * flow, and stores the resulting OIDC session. When the server also mints a
 * login gateway (LLP 0061), the returned credential is seeded into the
 * matching `central` forward sinks' persisted identity. On a fresh box with
 * no such sink, an enrolling login *provisions* one (LLP 0063) so logs forward
 * from one command — unless `--no-forward` declines it.
 *
 * @param {string} name
 * @param {{ org?: string, host?: string, noBrowser: boolean, noForward: boolean, noDaemon: boolean }} opts
 * @param {CommandRunContext} ctx
 * @param {{ login: typeof loginWithBrowser, seed: typeof seedLoginGateway, enroll: typeof enrollCentralSink, waitForAttach: typeof waitForClientAttach }} deps
 * @returns {Promise<number>}
 */
async function runBrowserLogin(name, { org, host, noBrowser, noForward, noDaemon }, ctx, { login, seed, enroll, waitForAttach }) {
  const remotes = await readConfiguredRemotes(ctx)
  const entry = remotes[name]
  if (!entry) {
    ctx.stderr.write(`hyp remote login: '${name}' is not a configured target - add it first with 'hyp remote add ${name} <url>'\n`)
    ctx.stderr.write("  (or pass a static token with --token-file <path>)\n")
    return 2
  }
  const identityBase = deriveIdentityBase(entry.url)
  if (!identityBase) {
    ctx.stderr.write(`hyp remote login: target '${name}' has an invalid url (${entry.url})\n`)
    return 2
  }

  const stateDir = readObservabilityEnv(ctx.env).stateDir

  // One machine, one server (LLP 0063 D4). Already enrolled to *this* server
  // (a central sink targets its origin) means re-login just re-seeds below, and
  // the enrollment notice would be noise. Enrolled to a *different* server (and
  // not this one) means reject before the browser opens so no auth is wasted:
  // switching is 'hyp leave' then log in again, never one command.
  // @ref LLP 0063#d4 [implements]: pre-auth exclusivity gate — reject a login to a new server while enrolled elsewhere
  const targetOrigin = originOf(entry.url)
  const connectedOrigins = await readCentralSinkOrigins({ stateDir, configPath: localConfigPath(ctx) })
  const alreadyEnrolled = targetOrigin !== null && connectedOrigins.includes(targetOrigin)
  if (!alreadyEnrolled && connectedOrigins.length > 0) {
    ctx.stderr.write(`hyp remote login: this machine is connected to ${connectedOrigins[0]}\n`)
    ctx.stderr.write("  disconnect first ('hyp leave'), then log in to the new server\n")
    return 2
  }

  // Consent is a pre-auth warning, not a prompt (LLP 0063 D3): completing the
  // sign-in is the accepting act. Phrased conditionally because the client
  // can't know pre-auth whether the server will mint a gateway credential.
  // @ref LLP 0063#d3 [implements]: default-on enrollment; the pre-auth notice is the consent surface, never a y/n prompt
  if (!alreadyEnrolled && !noForward) {
    ctx.stderr.write('note: if your org has enabled forwarding, signing in will enroll this machine:\n')
    ctx.stderr.write('  it forwards captured logs to the server, applies org config (which can attach\n')
    ctx.stderr.write('  clients and backfill existing local history), and installs a background service.\n')
    ctx.stderr.write("  re-run with --no-forward to sign in for queries only, or Ctrl-C to cancel.\n")
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
      print: (line) => ctx.stderr.write(`${line}\n`),
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
    return 1
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
    return 1
  }
  ctx.stdout.write(`logged in to '${name}' as org '${session.org}'\n`)

  // No gateway credential (server didn't mint one, or --no-forward): query-only
  // login, nothing to forward. --no-forward with a minted gateway discards it
  // unseeded (LLP 0063 D3) - declining enrollment, not just forwarding.
  if (!session.gateway) return 0
  if (noForward) {
    // --no-forward declines *new* enrollment; it cannot un-enroll a machine
    // that already forwards (that is `hyp leave`). Tell the truth for each case
    // rather than always claiming "not enrolled".
    if (alreadyEnrolled) {
      ctx.stdout.write("note: --no-forward - signed in for queries only; this machine stays enrolled and keeps forwarding (run 'hyp leave' to stop)\n")
    } else {
      ctx.stdout.write('note: --no-forward - signed in for queries only; this machine is not enrolled and will not forward logs\n')
    }
    return 0
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
    return 1
  }

  // No sink targets this server yet: provision one so login forwards from one
  // command (LLP 0063 D2/D5). enrollCentralSink writes join's sink block, seeds
  // this identity into it, and finishes with join's daemon install.
  // @ref LLP 0063#d2 [implements]: an enrolling login provisions the central sink the dead-end note used to only describe
  if (seeded.length === 0) {
    // The forward sink joins '/v1/ingest/...' onto its url, so it must be the
    // server origin, not the '<origin>/mcp' query target we logged in against.
    const centralUrl = targetOrigin ?? entry.url
    /** @type {Awaited<ReturnType<typeof enrollCentralSink>>} */
    let result
    try {
      result = await enroll({ ctx, url: centralUrl, gateway: session.gateway, noDaemon })
    } catch (err) {
      ctx.stderr.write(`hyp remote login: signed in, but enrollment failed: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    if (result.connectedElsewhere) {
      ctx.stderr.write(`hyp remote login: this machine connected to ${result.connectedElsewhere} during sign-in - not enrolling\n`)
      return 1
    }
    ctx.stdout.write(`forwarding logs to ${centralUrl}\n`)
    // Without the daemon there is nothing to wait on: it is what pulls the org
    // config and runs the attach reconcile. Say what is left to do and stop.
    if (noDaemon) {
      ctx.stdout.write("daemon install skipped (--no-daemon); run 'hyp daemon install' to finish enrolling\n")
      return 0
    }
    if (result.daemonCode !== 0) {
      ctx.stderr.write("note: enrolled, but the daemon install did not finish - run 'hyp daemon install'\n")
      return result.daemonCode
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
    ctx.stderr.write(`waiting for the daemon to attach clients (up to ${Math.round(ATTACH_WAIT_DEFAULT_MS / 1000)}s)...\n`)
    const attached = await waitForAttach({ env: ctx.env })
    if (attached.length > 0) {
      ctx.stdout.write(`capturing ${attached.join(', ')}\n`)
    } else {
      ctx.stdout.write("no clients attached yet - check 'hyp status', or run 'hyp attach <client>' to capture\n")
    }
    return 0
  }

  // A matching sink already existed: this was a re-seed (already enrolled).
  for (const s of seeded) {
    ctx.stdout.write(`seeded forwarding identity for sink '${s.sink}' (gateway ${session.gateway.gatewayId})\n`)
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
  return 0
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
      return 'this account is not a member of any org on this server - ask an admin to invite you'
    case 'org_selection_required':
      return 'this account has more than one org - re-run with --org <name> to choose one'
    case 'org_not_permitted':
      return 'the selected org is not permitted for this account - check the --org name'
    default:
      return err instanceof Error ? err.message : String(err)
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
  const json = argv.includes('--json')
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
  const name = positionals(argv)[0]
  if (!name) {
    ctx.stderr.write('usage: hyp remote remove <name>\n')
    return 2
  }
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


