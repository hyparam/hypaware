// @ts-check

// The kernel self-updater. This module is deliberately import-light:
// it must stay loadable even when the rest of a release is broken,
// because the pre-boot lane in `bin/hypaware.js` is what lets a
// crash-looping version jump forward to a fixed release.
// @ref LLP 0309#unstick-from-the-front [implements]: the check runs before the kernel boots, in a module that imports no kernel code

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { daemonRunDir, processIsAlive, readPidFile } from '../daemon/pid.js'
import { LAUNCH_LABEL } from '../daemon/platform.js'
import { atomicWriteJsonSync, readFileIfExistsSync } from '../util/fs_atomic.js'
import { isLoopbackHost } from '../util/loopback.js'

/**
 * @import { CommandRunner } from '../../../src/core/cli/types.js'
 * @import { SelfInstallProvenance, SelfUpdatePassResult, SelfUpdateState } from '../../../src/core/update/types.js'
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
// How long a run of failing probes stays out of the status line. A probe
// failure is usually a laptop off the network and clears itself, so the
// quiet is worth having; but it is quiet, not silence. Past this the
// updater is not offline, it is broken (a renamed package, a proxy that
// always refuses), and an install that will never update again has to
// say so where a human looks. A week clears any plausible trip.
export const PROBE_QUIET_MS = 7 * 24 * 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 5000
export const NPM_TIMEOUT_MS = 120_000
// How long a timed-out npm gets to honor SIGTERM before SIGKILL.
export const NPM_KILL_GRACE_MS = 5000
// An apply lock this old belonged to a process that died mid-install;
// honoring it forever would wedge updates permanently. The floor is the
// longest a live holder can legitimately hold it: `applySelfUpdate` runs
// two npm commands, each bounded by the timeout plus the kill grace. Two
// of those again is the margin - reclaiming a lock its owner still holds
// starts the second concurrent `npm install -g` this lock exists to
// prevent, so erring long costs a slower recovery and erring short costs
// the machine.
export const APPLY_LOCK_STALE_MS = 4 * (NPM_TIMEOUT_MS + NPM_KILL_GRACE_MS)
const DAILY_CHECK_MS = 24 * 60 * 60 * 1000
// One hour when the previous boot never reached healthy: a machine
// stuck on a broken release re-probes eagerly so it jumps to the fix
// soon after one is published.
const EAGER_CHECK_MS = 60 * 60 * 1000

/**
 * Must equal `DAEMON_RESTART_EXIT_CODE` in `src/core/daemon/runtime.js`.
 * Duplicated rather than imported so the pre-boot lane never loads the
 * daemon runtime; a test asserts the two stay in sync.
 */
export const SELF_UPDATE_RESTART_EXIT_CODE = 75

/**
 * Must equal `CONFIG_BASENAME` in `src/core/config/schema.js`.
 * Duplicated rather than imported for the same reason as the exit code
 * above; a test asserts the two stay in sync.
 */
const CONFIG_BASENAME = 'hypaware-config.json'

// How long the new install's entrypoint gets to print its version before
// the apply is judged broken and rolled back.
export const PREFLIGHT_TIMEOUT_MS = 30_000
// How many consecutive boots on a freshly installed version may fail to
// reach the kernel before the pre-boot lane reinstalls the version it
// replaced. One is not enough: the first relaunch after a power loss
// also finds `status.json` frozen at `starting`.
export const ROLLBACK_AFTER_BOOT_FAILURES = 2
// How much of npm's stderr is kept when an install fails. Enough for the
// `npm error code EACCES` block that names the cause; not the whole
// transcript.
const NPM_DETAIL_CHARS = 600

/**
 * Is a service manager going to relaunch this process when it exits?
 * A restart exit into nothing is a dead daemon, so the automatic lanes
 * only apply (and only exit) when the answer is yes.
 *
 * Presence of `XPC_SERVICE_NAME` is not the test: macOS sets it in every
 * process launchd spawned, including terminals (`0`) and GUI apps
 * (`application.<bundle>...`), so a hand-run `hyp daemon run --foreground`
 * carries one too. Only the daemon's own label counts. systemd sets
 * `INVOCATION_ID` for the services it runs and for nothing interactive.
 *
 * @ref LLP 0365#restart-needs-a-supervisor [implements]: the automatic lanes never exit for a relaunch nobody will perform
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function detectSupervisor(env) {
  const xpc = env.XPC_SERVICE_NAME
  if (typeof xpc === 'string' && (xpc === LAUNCH_LABEL || xpc.startsWith(LAUNCH_LABEL + '.'))) return true
  return typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID !== ''
}

/**
 * Which config file holds the off switch, by the same precedence
 * `resolveConfigPath` (`src/core/runtime/boot.js`) applies when the
 * kernel boots: an explicit `--config` first, then `HYP_CONFIG`, then
 * `<HYP_HOME>/hypaware-config.json` (the state root's parent). The
 * explicit rung is not optional: the installed service unit always
 * renders `--config <path>` on both platforms, so without it an
 * `auto_update: false` written in a non-default config would not bind
 * in the pre-boot lane at all.
 *
 * @param {{ stateRoot: string, env: NodeJS.ProcessEnv, configPath?: string }} opts
 * @returns {string}
 */
function resolveLocalConfigPath(opts) {
  if (opts.configPath) return path.resolve(opts.configPath)
  if (opts.env.HYP_CONFIG) return path.resolve(opts.env.HYP_CONFIG)
  return path.join(path.dirname(opts.stateRoot), CONFIG_BASENAME)
}

/**
 * The `auto_update` flag straight off the local config file, for a
 * machine where no daemon boot has cached the effective flag yet. A bare
 * JSON read, not the config loader: importing the schema machinery here
 * would let a release broken in config parsing take the unstick lane
 * down with it. Central-layer merging is out of scope by the same
 * argument; the daemon-cached effective flag wins whenever it exists.
 *
 * Every failure reads as "no answer here", the read included: a config
 * that is a directory, or one the daemon's user cannot open, raises
 * something other than ENOENT, and a throw escaping this far would
 * disable the entire pass on a machine this lane exists to repair.
 *
 * @ref LLP 0309#config-key [implements]: the off switch binds before the first successful boot
 * @param {{ stateRoot: string, env: NodeJS.ProcessEnv, configPath?: string }} opts
 * @returns {boolean | undefined}
 */
export function readLocalConfigAutoUpdate(opts) {
  try {
    const raw = readFileIfExistsSync(resolveLocalConfigPath(opts))
    if (!raw) return undefined
    const parsed = JSON.parse(raw)
    const flag = parsed && typeof parsed === 'object' ? parsed.auto_update : undefined
    return typeof flag === 'boolean' ? flag : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function selfUpdateStateRoot(env) {
  const hypHome = env.HYP_HOME || path.join(os.homedir(), '.hyp')
  return path.join(hypHome, 'hypaware')
}

/**
 * @param {string} stateRoot
 * @returns {string}
 */
export function selfUpdateStatePath(stateRoot) {
  return path.join(daemonRunDir(stateRoot), 'self-update.json')
}

/**
 * Total by construction: an empty state is the answer for a file that is
 * absent, corrupt, or unreadable alike. `describeSelfUpdate` runs inside
 * `hyp status` with no guard of its own, and a state file left behind
 * root-owned by a sudo install would otherwise take the whole report down.
 *
 * @param {string} stateRoot
 * @returns {SelfUpdateState}
 */
export function readSelfUpdateState(stateRoot) {
  try {
    const raw = readFileIfExistsSync(selfUpdateStatePath(stateRoot))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merge a patch into the persisted state. Read-modify-write keeps the
 * cached `auto_update` flag intact across probe updates and vice versa.
 *
 * @param {string} stateRoot
 * @param {Partial<SelfUpdateState>} patch
 * @returns {SelfUpdateState}
 */
export function writeSelfUpdateState(stateRoot, patch) {
  const next = { ...readSelfUpdateState(stateRoot), ...patch }
  fs.mkdirSync(daemonRunDir(stateRoot), { recursive: true })
  atomicWriteJsonSync(selfUpdateStatePath(stateRoot), next)
  return next
}

/**
 * Numeric semver comparison. Returns >0 when `a` is newer than `b`,
 * 0 when equal, <0 when older. A prerelease sorts below its release
 * (`1.2.0-rc.1 < 1.2.0`); unparseable input compares as not-newer.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  }
  if (pa.prerelease && !pb.prerelease) return -1
  if (!pa.prerelease && pb.prerelease) return 1
  return 0
}

/**
 * @param {string} value
 * @returns {{ nums: number[], prerelease: string } | null}
 */
function parseSemver(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value).trim())
  if (!m) return null
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ?? '',
  }
}

/**
 * Is this registry override safe to believe, and in what form? https
 * always is. Plain http is trusted only on this machine, where a local
 * Verdaccio is a normal dev and test setup and nothing sits on the wire.
 * Off-box http is not: the probe's answer decides whether this install
 * ever updates again, so a spoofable "you are already current" is a mute
 * button for anyone on the path.
 *
 * Returns the parsed URL rather than a boolean so the caller can build
 * the probe address from it. `new URL` accepts shapes the old
 * `/^https?:\/\//` guard rejected (`https:evil` parses, protocol and
 * all), and echoing those back verbatim builds a probe URL that can only
 * fail.
 *
 * "On this machine" is decided from the name alone: only the literal
 * `localhost` and the loopback IP literals count. A `*.localhost`
 * subdomain does not, even though RFC 6761 says resolvers must send it to
 * loopback: glibc without systemd-resolved does not, it asks DNS, so a
 * hostile search domain plus someone on the path turns an operator's
 * `http://npm.localhost` into an off-box registry that decides whether
 * this install ever updates again. Resolving the name here and requiring
 * the answer to be loopback would close that, at the cost of putting DNS
 * inside a trust check (a second lookup npm never has to agree with, in an
 * import-light module, on the pre-boot path). Refusing the suffix is the
 * smaller answer, and it fails closed: the override degrades to the public
 * registry with the `registry_untrusted` surface, and `http://localhost`
 * is right there.
 *
 * The rooted spelling `localhost.` does not count either, for the same
 * reason and not merely by omission. A trailing dot is what stops glibc
 * satisfying the name from `/etc/hosts` at all: `nss_files` compares the
 * name literally, misses, and `nss_dns` then queries the absolute name, so
 * `getent hosts localhost.` comes back empty on a box where
 * `getent hosts localhost` answers `::1`. Accepting it would hand back
 * exactly the DNS-decided plain-http trust the `*.localhost` refusal above
 * exists to remove, and buy nothing for it: on that same box the probe
 * cannot reach a rooted `localhost.` anyway (`ENOTFOUND`).
 *
 * @param {string} raw
 * @returns {URL | null}
 */
function trustedRegistryUrl(raw) {
  /** @type {URL} */
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // npm speaks http or https to a registry and nothing else. Letting a
  // third scheme through on a loopback host would not open a hole, but it
  // would trade a working default for a probe that can never succeed:
  // `fetch` refuses the URL, the pass records `probe_failed`, and after
  // the quieting below that failure no longer reaches the status line.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.protocol === 'https:') return url
  // `URL` has re-serialized an IPv4-mapped literal into hex by the time it
  // reaches `hostname` (`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`), so
  // refusing that form would turn away a mapped-loopback Verdaccio that is
  // plainly on this machine.
  return isLoopbackHost(url.hostname, { hexMappedIpv4: true }) ? url : null
}

/**
 * Reduce every URL in an error message to scheme and host.
 *
 * Probe errors are quoted verbatim into the state file, the `hyp status`
 * degraded line, and the daemon service log, and the message is not ours
 * to trust: Node's `fetch` refuses a credentialed URL with one that
 * embeds the whole URL, userinfo included, so an operator whose
 * `npm_config_registry` carries a token has it copied into three
 * durable places by the act of failing. Nothing downstream needs more
 * than the origin to say which registry went wrong.
 *
 * @param {string} message
 * @returns {string}
 */
function redactUrls(message) {
  // The URL body stops at whitespace and at the characters `URL`
  // percent-encodes out of a userinfo, so none of them can appear
  // between the scheme and the `@` that ends a credential: `"`, `<`,
  // `>`, `` ` `` and `\` (a backslash becomes `/` in a username and is
  // rejected outright in a password). Running to the next space instead
  // would swallow whatever the message glued on after a closing quote,
  // and this also redacts the outer catch's arbitrary errors: a
  // `{"registry":"<url>","attempt":2}` would lose its tail and stop
  // being the diagnostic it was written to be.
  //
  // `'` is deliberately not in that set even though it reads like one of
  // the quotes. `URL` leaves an apostrophe literal in a userinfo
  // (`new URL("https://u:tok'en@h/").href` keeps it), so stopping there
  // would cut the match mid-credential and print the remainder of the
  // token verbatim into all three sinks, which is the leak this function
  // exists to close. It is peeled as trailing punctuation below instead,
  // which still handles a `'...'`-quoted URL without ever splitting a
  // userinfo.
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"<>`\\]+/gi, (match) => {
    // Trailing sentence punctuation is not part of the URL; keep it so
    // the message still reads as a sentence. `]` has to be in that set
    // for a `(http://h/x])`-shaped tail, but it is also the last
    // character of a bracketed IPv6 origin, so peel one character less
    // until something parses rather than losing a bare `http://[::1]`
    // to `[url]]`. Whatever is handed back unpeeled is punctuation by
    // construction, and a userinfo is always followed by `@host`, so no
    // credential can hide in it.
    const trail = /[.,;:!?)\]}']+$/.exec(match)?.[0] ?? ''
    for (let cut = trail.length; cut >= 0; cut -= 1) {
      const body = cut ? match.slice(0, -cut) : match
      try {
        const url = new URL(body)
        return `${url.protocol}//${url.host}${match.slice(body.length)}`
      } catch { /* peel one character less and try again */ }
    }
    return `[url]${trail}`
  })
}

/**
 * The registry override as npm itself reads it. npm matches its config
 * environment variables case-insensitively (`@npmcli/config` tests
 * `/^npm_config_/i` and lowercases the key), so `NPM_CONFIG_REGISTRY`
 * steers `npm install -g` exactly as the lowercase spelling does.
 * Reading only the lowercase name would leave the probe looking at one
 * registry while the install pulled its tarball from another, which is
 * the split this whole guard exists to close.
 *
 * `keys` is every spelling actually carrying a value, so the caller can
 * clear all of them when it pins the child. Spellings that disagree have
 * no defined precedence (npm keeps whichever it enumerates last), so
 * they resolve to no usable override rather than a guess.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ keys: string[], raw: string | null }}
 */
function readRegistryOverride(env) {
  const keys = Object.keys(env).filter((key) =>
    /^npm_config_registry$/i.test(key) && typeof env[key] === 'string' && env[key] !== '')
  const values = new Set(keys.map((key) => String(env[key])))
  return { keys, raw: values.size === 1 ? String([...values][0]) : null }
}

/**
 * The npm registry to probe: the standard `npm_config_registry` env
 * override when set and trusted, the public registry otherwise.
 * Reading `.npmrc` is deliberately out of scope for this import-light
 * module, so a private registry configured only there already probes
 * the default; an untrusted override degrading to that same default is
 * a path the module already walks, not a new failure mode.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveRegistryUrl(env) {
  const raw = readRegistryOverride(env).raw
  const trusted = raw === null ? null : trustedRegistryUrl(raw)
  if (trusted) return trusted.href.replace(/\/+$/, '')
  return DEFAULT_REGISTRY
}

/**
 * Scheme and host of a registry URL, for logs. Deliberately drops the
 * path, the query and above all the userinfo: a registry URL is a normal
 * place for an operator to keep a token.
 *
 * @param {string} raw
 * @returns {string}
 */
function registryOrigin(raw) {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}`
  } catch {
    return 'unparseable'
  }
}

/**
 * Where is the running code installed from? Only a global npm install
 * may self-update: `npm install -g` from an npx cache or a dev
 * checkout would create a second, skewed install beside the one
 * actually running.
 *
 * @ref LLP 0309#global-install-only [implements]: provenance guard on the running package root
 * @param {{ packageRoot?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {SelfInstallProvenance}
 */
export function classifySelfProvenance(opts = {}) {
  const root = path.resolve(opts.packageRoot ?? PACKAGE_ROOT)
  const env = opts.env ?? process.env
  const segments = root.split(path.sep)
  if (segments.includes('_npx')) return 'npx'
  const cache = env.npm_config_cache ? path.resolve(env.npm_config_cache) : undefined
  if (cache && root.startsWith(path.join(cache, '_npx') + path.sep)) return 'npx'
  if (fs.existsSync(path.join(root, '.git'))) return 'checkout'
  if (!segments.includes('node_modules')) return 'checkout'
  return 'global-candidate'
}

/**
 * @returns {{ name: string, version: string }}
 */
export function readSelfPackageIdentity(packageRoot = PACKAGE_ROOT) {
  const raw = fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  const parsed = JSON.parse(raw)
  return { name: String(parsed.name), version: String(parsed.version) }
}

/**
 * Probe the registry for the `latest` dist-tag. Throws on any failure;
 * callers record the error and move on (the check is best-effort).
 *
 * @param {{
 *   name: string,
 *   registryUrl: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<string>}
 */
export async function fetchLatestVersion(opts) {
  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const url = `${opts.registryUrl}/${encodeURIComponent(opts.name)}/latest`
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`registry responded ${res.status}`)
    const body = /** @type {{ version?: unknown } | null} */ (await res.json())
    const version = body && typeof body === 'object' ? body.version : undefined
    if (typeof version !== 'string' || !parseSemver(version)) {
      throw new Error('registry response had no parseable version')
    }
    return version
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Is the last probe stale enough to re-check? Daily normally, hourly
 * when the previous boot never reached healthy. The jitter fraction
 * stretches the daily interval by up to 25% so a fleet installed in
 * one MDM push does not probe in lockstep forever.
 *
 * @param {{
 *   state: SelfUpdateState,
 *   nowMs: number,
 *   eager: boolean,
 *   jitter?: number,
 * }} opts
 * @returns {boolean}
 */
export function shouldCheckNow({ state, nowMs, eager, jitter }) {
  if (!state.checked_at) return true
  const parsed = Date.parse(state.checked_at)
  if (Number.isNaN(parsed)) return true
  const base = eager ? EAGER_CHECK_MS : DAILY_CHECK_MS
  const fraction = typeof jitter === 'number' ? jitter : Math.random()
  const ttl = eager ? base : base + Math.floor(base * 0.25 * Math.min(1, Math.max(0, fraction)))
  return nowMs - parsed >= ttl
}

/**
 * Did the previous daemon boot fail before reaching healthy? Two shapes
 * count, because a broken release produces both: a status file frozen at
 * `starting` (the process died mid-boot and never rewrote it), and one at
 * `degraded` carrying a `boot_failed:` warning (the runtime caught the
 * boot throw and recorded it before exiting). A `degraded` file without
 * that warning is a healthy kernel with a failed source, which no amount
 * of updating fixes and which must not buy an hourly probe.
 *
 * @param {string} stateRoot
 * @returns {boolean}
 */
export function previousBootLooksStuck(stateRoot) {
  try {
    const raw = readFileIfExistsSync(path.join(daemonRunDir(stateRoot), 'status.json'))
    if (!raw) return false
    const parsed = JSON.parse(raw)
    if (parsed?.state === 'starting') return true
    if (parsed?.state !== 'degraded') return false
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : []
    return warnings.some((w) => String(w).startsWith('boot_failed'))
  } catch {
    return false
  }
}

/**
 * The environment npm runs in, with the directory of the running node
 * binary prepended to PATH.
 *
 * The daemon does not inherit a login shell's PATH: the LaunchAgent and
 * the systemd unit both run it through an absolute `process.execPath`
 * and render no environment block at all, so PATH is whatever the
 * service manager supplies - on launchd, `/usr/bin:/bin:/usr/sbin:/sbin`.
 * Homebrew (`/opt/homebrew/bin`), the nodejs.org installer
 * (`/usr/local/bin`) and nvm are all outside that, so a bare
 * `spawn('npm')` fails ENOENT and the automatic lane records
 * `npm_prefix_failed` forever while a hand-typed `hyp update` (with the
 * user's PATH) works. Prepending is the fix rather than resolving npm to
 * an absolute path, because npm's own shim starts `#!/usr/bin/env node`
 * and so needs the same directory reachable anyway.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function withNodeBinOnPath(env) {
  const nodeBin = path.dirname(process.execPath)
  if (!nodeBin || nodeBin === '.') return env
  const parts = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  if (parts[0] === nodeBin) return env
  return { ...env, PATH: [nodeBin, ...parts.filter((p) => p !== nodeBin)].join(path.delimiter) }
}

/**
 * Verify the running package root IS the npm global install, then run
 * `npm install -g <name>@<version>`, then prove the installed entrypoint
 * runs before anyone restarts onto it. Returns rather than throws: every
 * caller treats failure as "record and degrade to a status notice".
 *
 * The filesystem is the verdict on the install, in both directions. An
 * npm that returned 0 without replacing the global root must not report
 * `applied` (that would be a restart loop on the same version), and an
 * npm that returned non-zero *after* replacing it must not report failure:
 * mise's `npm` wrapper runs the real npm and then `mise reshim`, which is
 * not on the daemon's PATH, so the whole thing exits 127 with the new
 * version already on disk. Trusting that exit code leaves the daemon on
 * old code with a "failed" notice, and the next probe, reading the new
 * version off disk, then calls the machine up to date forever.
 *
 * `previousVersion` is what the global root held before this call. When
 * the new entrypoint cannot even print its version, that version is
 * reinstalled on the spot, before the caller has restarted anything, so
 * the running daemon never hands over to code that cannot start.
 *
 * @ref LLP 0309#mechanism [implements]: npm install -g through the same lane setup uses; failure degrades, never loops
 * @ref LLP 0365#disk-is-the-verdict [implements]: the installed version decides applied, never npm's exit code
 * @ref LLP 0365#preflight-then-hand-over [implements]: the new entrypoint must run before the restart; a broken one is reinstalled over
 * @param {{
 *   name: string,
 *   version: string,
 *   previousVersion?: string,
 *   packageRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   runner?: CommandRunner,
 *   platform?: NodeJS.Platform,
 *   log?: (event: string, fields?: Record<string, unknown>) => void,
 * }} opts
 * @returns {Promise<{ applied: boolean, reason?: string, detail?: string, rolledBack?: boolean }>}
 */
export async function applySelfUpdate(opts) {
  const env = withNodeBinOnPath(opts.env ?? process.env)
  const run = opts.runner ?? runCommand
  const packageRoot = path.resolve(opts.packageRoot ?? PACKAGE_ROOT)
  const platform = opts.platform ?? process.platform
  const log = opts.log ?? (() => {})

  const prefixResult = await run('npm', ['config', 'get', 'prefix'], { env })
  if (prefixResult.exitCode !== 0) {
    return { applied: false, reason: 'npm_prefix_failed', detail: npmDetail(prefixResult) }
  }
  const prefix = prefixResult.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  if (!prefix) return { applied: false, reason: 'npm_prefix_failed' }
  const globalRoot = platform === 'win32'
    ? path.join(prefix, 'node_modules', opts.name)
    : path.join(prefix, 'lib', 'node_modules', opts.name)
  if (realpathOrSelf(globalRoot) !== realpathOrSelf(packageRoot)) {
    return { applied: false, reason: 'not_global_install' }
  }

  const install = await run('npm', ['install', '-g', `${opts.name}@${opts.version}`], { env })
  const onDisk = readVersionAt(globalRoot)
  if (onDisk !== opts.version) {
    return install.exitCode === 0
      ? { applied: false, reason: 'version_not_installed' }
      : { applied: false, reason: 'npm_install_failed', detail: npmDetail(install) }
  }
  if (install.exitCode !== 0) {
    // The install landed; whatever npm did afterwards is not this
    // update's problem, but an operator diagnosing a wrapper deserves
    // the line it printed.
    log('self_update.npm_exit_ignored', { exit_code: install.exitCode, detail: npmDetail(install) })
  }

  const preflight = await runPreflight({ globalRoot, version: opts.version, env, run })
  if (preflight.ok) return { applied: true }
  log('self_update.preflight_failed', { latest_version: opts.version, detail: preflight.detail })
  if (!opts.previousVersion || opts.previousVersion === opts.version) {
    return { applied: false, reason: 'preflight_failed', detail: preflight.detail }
  }
  const back = await run('npm', ['install', '-g', `${opts.name}@${opts.previousVersion}`], { env })
  const restored = readVersionAt(globalRoot) === opts.previousVersion
  log(restored ? 'self_update.rolled_back' : 'self_update.rollback_failed', {
    from: opts.version,
    to: opts.previousVersion,
    ...(restored ? {} : { detail: npmDetail(back) }),
  })
  return { applied: false, reason: 'preflight_failed', detail: preflight.detail, rolledBack: restored }
}

/**
 * Run the just-installed entrypoint and require it to name the version
 * it was installed as. Cheap (`--version` loads the CLI but activates no
 * plugin) and it catches the failure LLP 0309 accepted as residual: a
 * release whose entrypoint cannot run at all. Node is `process.execPath`
 * rather than whatever `node` PATH finds, because that is the binary the
 * service unit will relaunch with.
 *
 * @param {{ globalRoot: string, version: string, env: NodeJS.ProcessEnv, run: CommandRunner }} opts
 * @returns {Promise<{ ok: boolean, detail?: string }>}
 */
async function runPreflight({ globalRoot, version, env, run }) {
  const bin = path.join(globalRoot, 'bin', 'hypaware.js')
  const result = await run(process.execPath, [bin, '--version'], { env, timeoutMs: PREFLIGHT_TIMEOUT_MS })
  if (result.exitCode === 0 && result.stdout.includes(version)) return { ok: true }
  const detail = result.exitCode === 0
    ? `printed ${JSON.stringify(result.stdout.trim().slice(0, 80))} instead of ${version}`
    : `exit ${result.exitCode}: ${npmDetail(result)}`
  return { ok: false, detail }
}

/**
 * The tail of a failed command's stderr, one line, redacted, bounded.
 * Stderr rather than stdout because that is where npm puts `npm error`.
 *
 * @param {{ stdout: string, stderr: string }} result
 * @returns {string}
 */
function npmDetail(result) {
  const text = (result.stderr.trim() || result.stdout.trim())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ')
  const tail = text.length > NPM_DETAIL_CHARS ? '...' + text.slice(-NPM_DETAIL_CHARS) : text
  return redactUrls(tail)
}

/**
 * @param {string} root
 * @returns {string | null}
 */
function readVersionAt(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Best-effort cross-process mutex around `npm install -g`. The daemon's
 * periodic lane and a hand-typed `hyp update` can reach the install at the
 * same moment, and two npm global installs racing over one package
 * directory is the single failure that can leave a machine with no
 * runnable kernel at all. Returns a release function, or null when another
 * process holds the lock. Anything that is not lock contention (an
 * unwritable run directory, a read-only filesystem) throws instead of
 * returning null: it still fails closed, but reporting it as "another
 * update is already running" sends the operator looking for a process
 * that does not exist.
 *
 * @param {string} stateRoot
 * @returns {(() => void) | null}
 */
export function acquireApplyLock(stateRoot) {
  const runDir = daemonRunDir(stateRoot)
  const lockPath = path.join(runDir, 'self-update.lock')
  fs.mkdirSync(runDir, { recursive: true })
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }))
      } finally {
        fs.closeSync(fd)
      }
      return () => {
        // Only ever remove our own lock. A stale-reclaim by another
        // process replaces the file, and unlinking unconditionally would
        // hand a third process the lock while the second still holds it.
        try {
          const held = JSON.parse(readFileIfExistsSync(lockPath) ?? 'null')
          if (held?.token !== token) return
        } catch { return }
        try { fs.unlinkSync(lockPath) } catch { /* already gone */ }
      }
    } catch (err) {
      // Only EEXIST means somebody else holds it. EACCES, EROFS and the
      // rest are this machine's problem and belong in front of a human.
      if (errnoCode(err) !== 'EEXIST') throw err
      if (attempt > 0) return null
      /** @type {number | null} */
      let ageMs = null
      try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs } catch { ageMs = null }
      if (ageMs !== null && ageMs < APPLY_LOCK_STALE_MS) return null
      try { fs.unlinkSync(lockPath) } catch { /* raced; the retry decides */ }
    }
  }
  return null
}

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errnoCode(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * @param {string} p
 * @returns {string}
 */
function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * One self-update pass: decide, probe, record, and (when eligible and
 * enabled) apply. Shared by the pre-boot lane, the daemon's periodic
 * lane, and `hyp update` (which sets `force` to bypass the TTL).
 *
 * Never throws: every failure lands on the state file's `error` field
 * and in the returned reason.
 *
 * @param {{
 *   stateRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   configPath?: string,
 *   autoUpdate?: boolean,
 *   force?: boolean,
 *   runningVersion?: string,
 *   supervised?: boolean,
 *   packageRoot?: string,
 *   runner?: CommandRunner,
 *   fetchImpl?: typeof fetch,
 *   now?: () => Date,
 *   jitter?: number,
 *   log?: (event: string, fields?: Record<string, unknown>) => void,
 * }} [opts]
 * @returns {Promise<SelfUpdatePassResult>}
 */
export async function runSelfUpdatePass(opts = {}) {
  const env = opts.env ?? process.env
  const stateRoot = opts.stateRoot ?? selfUpdateStateRoot(env)
  const log = opts.log ?? (() => {})
  const nowMs = (opts.now ?? (() => new Date()))().getTime()

  try {
    const state = readSelfUpdateState(stateRoot)
    // The cached effective flag (central-aware, written at boot) wins;
    // until a boot has cached it, fall back to the local config file so
    // an `auto_update: false` written before first start still binds.
    const auto = opts.autoUpdate ?? state.auto_update ??
      readLocalConfigAutoUpdate({ stateRoot, env, configPath: opts.configPath }) ?? true
    if (!auto && !opts.force) {
      return { action: 'skipped', reason: 'auto_update_off' }
    }

    const provenance = classifySelfProvenance({ packageRoot: opts.packageRoot, env })
    if (provenance !== 'global-candidate' && !opts.force) {
      // Dev checkouts and npx runs never probe: hermetic smokes boot
      // the daemon from the repo checkout and must not touch the
      // network. `hyp update` still probes (force) but cannot apply.
      log('self_update.skipped', { reason: provenance })
      return { action: 'skipped', reason: provenance }
    }

    const supervised = opts.supervised ?? detectSupervisor(env)
    if (!opts.force) {
      const stuck = previousBootLooksStuck(stateRoot)
      // Before the TTL gate: a version this updater installed that cannot
      // boot is undone on the spot, not on tomorrow's schedule. Only under
      // a supervisor, for the same reason an apply is: the rollback
      // installs and then exits for a relaunch, and a hand-run
      // `hyp daemon run --foreground` has nothing to relaunch it, so the
      // operator would get a silent downgrade and no daemon.
      // @ref LLP 0365#restart-needs-a-supervisor [constrained-by]: the rollback installs and exits, so it is gated like any other apply
      const rollback = supervised
        ? await maybeRollBack({
          stateRoot, stuck, packageRoot: opts.packageRoot, env, runner: opts.runner, nowMs, log,
        })
        : null
      if (rollback) return rollback
      if (!shouldCheckNow({ state, nowMs, eager: stuck, jitter: opts.jitter })) {
        return { action: 'none' }
      }
    }

    const identity = readSelfPackageIdentity(opts.packageRoot)
    const registryUrl = resolveRegistryUrl(env)
    // Dropping an untrusted override is otherwise a silent decision: the
    // probe asks the public registry about a package that may only exist
    // on the private one, and that 404 lands as `probe_failed`, which no
    // longer reaches the status line.
    //
    // "Was it dropped" is the trust decision itself, not a comparison of
    // the raw string against the resolved one. `URL.href` normalizes
    // (an explicit `:443` disappears, a host lowercases, an IDN becomes
    // punycode), so a *trusted* override can differ from its own resolved
    // form - and reporting that as ignored both lies and, since the
    // resolved form of a trusted override is the operator's own URL,
    // prints their registry password. Every field here is an origin:
    // scheme and host, never a path, a query, or userinfo.
    const override = readRegistryOverride(env)
    const registryOverrideIgnored = override.keys.length > 0 &&
      (override.raw === null || trustedRegistryUrl(override.raw) === null)
    if (registryOverrideIgnored) {
      log('self_update.registry_override_ignored', {
        error_kind: override.raw === null ? 'registry_ambiguous' : 'registry_untrusted',
        ignored_origin: override.raw === null ? 'conflicting' : registryOrigin(override.raw),
        probing: registryOrigin(registryUrl),
      })
    }
    /** @type {string} */
    let latest
    try {
      latest = await fetchLatestVersion({
        name: identity.name,
        registryUrl,
        fetchImpl: opts.fetchImpl,
      })
    } catch (err) {
      // Redacted before it is used at all, not at each of the three
      // sinks: this message is persisted, rendered by `hyp status`, and
      // logged to the service log, and a credentialed override reaches
      // every one of them through the text `fetch` refuses it with.
      const message = redactUrls(err instanceof Error ? err.message : String(err))
      // `checked_at` moves on every failed probe, so it cannot say how
      // long this has been going on. `error_since` is the first failure
      // of the current unbroken run, and it is what bounds the quiet in
      // `describeSelfUpdate`; a successful probe clears it below.
      const since = typeof state.error_since === 'string' && state.error
        ? state.error_since
        : new Date(nowMs).toISOString()
      // A failure that is not a probe failure is sticky: a global prefix
      // this user cannot write, a refused registry. It was already
      // speaking in the status line, and it does not heal by itself.
      // Overwriting it with a transient probe failure would hand a
      // permanently broken updater the offline reprieve and silence it
      // for a week, which is the one case #cli-surface most wants heard.
      // The probe failure still reaches the log; the next successful
      // probe clears the sticky error and the apply is retried.
      const sticky = typeof state.error === 'string' && !state.error.startsWith('probe_failed')
      writeSelfUpdateState(stateRoot, {
        checked_at: new Date(nowMs).toISOString(),
        ...(sticky ? {} : { error: `probe_failed: ${message}`, error_since: since }),
      })
      log('self_update.probe_failed', { error_kind: 'probe_failed', detail: message })
      return { action: 'checked', reason: 'probe_failed' }
    }

    const available = compareSemver(latest, identity.version) > 0
    const held = available && state.held_version === latest
    writeSelfUpdateState(stateRoot, {
      checked_at: new Date(nowMs).toISOString(),
      latest_version: latest,
      available,
      error: undefined,
      error_since: undefined,
      // The hold covers one version. Something newer on the registry
      // retires it, so drop it here rather than leaving a version that
      // stopped mattering on `hyp status --json` for good.
      ...(typeof state.held_version === 'string' && compareSemver(latest, state.held_version) > 0
        ? { held_version: undefined }
        : {}),
    })
    log('self_update.checked', { latest_version: latest, available, ...(held ? { held: true } : {}) })
    // Two versions matter, not one. `identity.version` is what the global
    // root holds; `runningVersion` is what the daemon loaded at boot. They
    // drift apart whenever something replaces the root without a restart
    // (a hand-typed `npm install -g`, or an apply whose exit code lied),
    // and a pass that only compared the registry with the disk would call
    // that machine up to date and leave the daemon on old code for good.
    // @ref LLP 0365#running-version-is-tracked [implements]: a newer root than the running code is an update that still needs its restart
    const running = opts.runningVersion
    // Never hand over to a version that failed its preflight. When the
    // reinstall of the version it replaced also failed, the root is left
    // holding the broken one, and this is the lane that would otherwise
    // restart the daemon straight onto it: the registry and the disk
    // agree, so nothing reads as available, and the only difference left
    // is that the daemon is still (correctly) running older code.
    const heldOnDisk = state.held_version === identity.version
    const restartOnly = !available && !heldOnDisk && typeof running === 'string' &&
      compareSemver(identity.version, running) > 0
    if (!available && !restartOnly) return { action: 'checked', latest }
    if (provenance !== 'global-candidate') {
      return { action: 'checked', reason: provenance, latest }
    }
    if (held) {
      log('self_update.held', { latest_version: latest, running_version: identity.version })
      return { action: 'checked', reason: 'held', latest }
    }
    if (!supervised && !opts.force) {
      // Installing without restarting is the stale-daemon state above, and
      // restarting means exiting into nothing. Neither is an update.
      log('self_update.skipped', { reason: 'unsupervised', latest_version: latest })
      return { action: 'checked', reason: 'unsupervised', latest }
    }
    if (restartOnly) {
      log('self_update.restart_pending', { running_version: running, installed_version: identity.version })
      return { action: 'updated', reason: 'restart_only', latest: identity.version }
    }
    // A dropped override means this pass cannot say where the bytes
    // should come from, so it does not install at all.
    //
    // Pinning the child to the probed registry instead looks like the
    // conservative move and is the opposite of one. An org whose
    // `npm_config_registry` names an internal mirror over plain http
    // (an Artifactory on a VPN is the ordinary shape) publishes its own
    // build of this package there; probing the public registry then
    // finds a higher `latest` and the pinned install silently replaces
    // the internal build with a public one nobody chose. That is a
    // cross-registry package swap performed unattended - the supply-chain
    // direction this guard exists to prevent, not one it is licensed to
    // take. The version answer is safe to take from the public registry
    // because it only decides what status reports; where the bytes come
    // from is a different question, and the honest answer here is that
    // the updater does not know.
    if (registryOverrideIgnored) {
      writeSelfUpdateState(stateRoot, { error: 'registry_untrusted' })
      log('self_update.apply_refused', {
        error_kind: 'registry_untrusted',
        latest_version: latest,
      })
      return { action: 'checked', reason: 'registry_untrusted', latest }
    }

    // Single-flight across processes, not just within one: the daemon's
    // lane and a hand-typed `hyp update` can arrive together. A lock this
    // cannot take for a reason other than contention throws, landing on
    // the outer catch with its errno in the log rather than reporting a
    // rival process that does not exist.
    const releaseLock = acquireApplyLock(stateRoot)
    if (!releaseLock) {
      log('self_update.apply_locked', { latest_version: latest })
      return { action: 'checked', reason: 'apply_locked', latest }
    }
    /** @type {Awaited<ReturnType<typeof applySelfUpdate>>} */
    let applied
    try {
      applied = await applySelfUpdate({
        name: identity.name,
        version: latest,
        previousVersion: identity.version,
        packageRoot: opts.packageRoot,
        // Untouched: the only override that reaches here is one the probe
        // believed, so npm resolving the tarball through it is the same
        // answer this pass already used for the version. An untrusted one
        // never reaches here at all (the refusal above), and an env with
        // no override leaves an `.npmrc`-configured private registry
        // serving the install exactly as it always has.
        env,
        runner: opts.runner,
        log,
      })
    } finally {
      releaseLock()
    }
    writeSelfUpdateState(stateRoot, {
      last_apply: {
        at: new Date(nowMs).toISOString(),
        from: identity.version,
        to: latest,
        ok: applied.applied,
        ...(applied.reason ? { error: applied.reason } : {}),
        ...(applied.detail ? { detail: applied.detail } : {}),
        ...(applied.rolledBack ? { rolled_back: true } : {}),
      },
      // A version that was installed and could not run is not tried again
      // until the registry offers something newer. Held whether or not the
      // reinstall of the previous version succeeded: when it failed, the
      // root is still holding the broken version, and `restart_only` above
      // is what must not hand the daemon over to it.
      ...(applied.reason === 'preflight_failed' ? { held_version: latest } : {}),
      // A completed rollback is an outcome, not a degraded updater, so it
      // clears the error the same way the failed-boot lane does. Recording
      // `apply_failed` here instead would put "run 'npm install -g
      // <name>@latest'" on `hyp status` until the next probe, which is an
      // instruction to reinstall by hand the exact version that was just
      // rolled back for not starting. `held_version` and
      // `last_apply.detail` carry the diagnosis.
      ...(applied.applied ? { available: false } : applied.rolledBack
        ? { error: undefined, error_since: undefined }
        : { error: `apply_failed: ${applied.reason}` }),
    })
    if (!applied.applied) {
      log('self_update.apply_failed', {
        error_kind: applied.reason,
        latest_version: latest,
        ...(applied.detail ? { detail: applied.detail } : {}),
      })
      return { action: 'checked', reason: applied.reason, latest }
    }
    log('self_update.applied', { from: identity.version, to: latest })
    return { action: 'updated', latest }
  } catch (err) {
    // The updater must never take the daemon down with it.
    // Redacted for the same reason as the probe failure above: this
    // detail reaches the service log and, through `hyp update`, stderr.
    const message = redactUrls(err instanceof Error ? err.message : String(err))
    log('self_update.error', { error_kind: 'unexpected', detail: message })
    return { action: 'skipped', reason: 'unexpected_error' }
  }
}

/**
 * Undo an update that cannot boot. Runs in the pre-boot lane, where a
 * relaunch after a failed boot lands. The version this updater last
 * installed is judged by the boots that followed it: once
 * `ROLLBACK_AFTER_BOOT_FAILURES` consecutive boots on it never reached
 * the kernel, the version it replaced is reinstalled, the failed one is
 * held, and the lane exits for a relaunch onto the restored code. A
 * healthy boot resets the count (the daemon writes `boot_failures: 0`
 * once its kernel is up).
 *
 * Only an update this updater applied is undone: `last_apply.ok` with
 * the global root still holding `last_apply.to`. A hand-installed
 * version that will not boot is the operator's to fix, and a stuck boot
 * on any other version is not evidence about an update at all.
 *
 * @ref LLP 0365#rollback-after-failed-boots [implements]: the previous version is reinstalled after repeated failed boots on the installed one
 * @param {{
 *   stateRoot: string,
 *   stuck: boolean,
 *   packageRoot?: string,
 *   env: NodeJS.ProcessEnv,
 *   runner?: CommandRunner,
 *   nowMs: number,
 *   log: (event: string, fields?: Record<string, unknown>) => void,
 * }} opts
 * @returns {Promise<SelfUpdatePassResult | null>}
 */
async function maybeRollBack({ stateRoot, stuck, packageRoot, env, runner, nowMs, log }) {
  if (!stuck) return null
  const state = readSelfUpdateState(stateRoot)
  const last = state.last_apply
  if (!last || !last.ok || last.rolled_back || !last.from || last.from === last.to) return null
  const identity = readSelfPackageIdentity(packageRoot)
  if (identity.version !== last.to) return null
  // `last_apply` never expires, so without this the failed boots do not
  // have to be the update's fault: two in a row from a bad config edit
  // months later would downgrade a version that has been serving all
  // along, and then hold it. A daemon that reached its kernel on this
  // version wrote it as `running_version`, which is the evidence that the
  // update is not what is stopping the boot.
  if (state.running_version === last.to) return null
  const failures = (typeof state.boot_failures === 'number' ? state.boot_failures : 0) + 1
  if (failures < ROLLBACK_AFTER_BOOT_FAILURES) {
    writeSelfUpdateState(stateRoot, { boot_failures: failures })
    log('self_update.boot_failure_counted', { version: last.to, boot_failures: failures })
    return null
  }
  const releaseLock = acquireApplyLock(stateRoot)
  if (!releaseLock) return null
  /** @type {Awaited<ReturnType<typeof applySelfUpdate>>} */
  let back
  try {
    back = await applySelfUpdate({ name: identity.name, version: last.from, packageRoot, env, runner, log })
  } finally {
    releaseLock()
  }
  if (!back.applied) {
    writeSelfUpdateState(stateRoot, { boot_failures: failures, error: `rollback_failed: ${back.reason}` })
    log('self_update.rollback_failed', {
      error_kind: back.reason,
      from: last.to,
      to: last.from,
      ...(back.detail ? { detail: back.detail } : {}),
    })
    return null
  }
  writeSelfUpdateState(stateRoot, {
    boot_failures: 0,
    held_version: last.to,
    available: false,
    error: undefined,
    last_apply: { ...last, rolled_back: true, rolled_back_at: new Date(nowMs).toISOString() },
  })
  log('self_update.rolled_back', { from: last.to, to: last.from, after_boot_failures: failures })
  return { action: 'updated', reason: 'rolled_back', latest: last.from }
}

/**
 * Summarize self-update health for `hyp status`: pure local reads, no
 * network. `line` is null when there is nothing worth a human's eye
 * (healthy automatic updates with nothing pending); `json` always
 * carries the full picture for `--json`.
 *
 * @ref LLP 0309#cli-surface [implements]: an install that cannot self-update says so in status, never only in logs
 * @param {{ stateRoot: string, env: NodeJS.ProcessEnv, now?: () => Date }} opts
 * @returns {{ line: string | null, json: Record<string, unknown> }}
 */
export function describeSelfUpdate(opts) {
  const provenance = classifySelfProvenance({ env: opts.env })
  const state = readSelfUpdateState(opts.stateRoot)
  // `hyp status` must survive its own updater. An in-flight
  // `npm install -g` briefly leaves this package root without a
  // package.json, and a throw here would take the whole status report
  // down at exactly the moment an operator is asking what is going on.
  /** @type {{ name: string, version: string }} */
  let identity
  try {
    identity = readSelfPackageIdentity()
  } catch {
    identity = { name: 'hypaware', version: 'unknown' }
  }
  // The same precedence the updater itself applies, so status cannot
  // report the switch as on while the pass is already honoring an off
  // written in config but not yet cached by a boot.
  const autoUpdate = state.auto_update ?? readLocalConfigAutoUpdate(opts) ?? true
  // Re-derive availability from the version actually running rather than
  // trusting the flag the last probe wrote: a manual `npm install -g`
  // (or `hyp update` from another shell) satisfies a pending update
  // without clearing it, and status would advertise '1.27.0 available
  // (running 1.27.0)' until the next probe up to a day later.
  const available = state.available === undefined
    ? undefined
    : Boolean(state.available && state.latest_version &&
      compareSemver(state.latest_version, identity.version) > 0)
  // The daemon records what it loaded at boot; it only means something
  // while that daemon is alive, so a leftover from a stopped one is not
  // read as a stale daemon.
  const runningVersion = typeof state.running_version === 'string' && daemonIsAlive(opts.stateRoot)
    ? state.running_version
    : undefined
  const staleDaemon = runningVersion !== undefined && compareSemver(identity.version, runningVersion) > 0
  // The root holding the held version is the failed-rollback shape: the
  // new version could not start, and the reinstall of the one it replaced
  // did not land either, so the daemon is deliberately still on older
  // code. `runSelfUpdatePass` refuses to hand over to it (`restart_only`
  // is gated on this same test), and the status line must not tell an
  // operator to do by hand the restart the updater will not do.
  const heldOnDisk = typeof state.held_version === 'string' && state.held_version === identity.version
  const heldLatest = typeof state.held_version === 'string' && state.held_version === state.latest_version
    ? state.held_version
    : undefined
  /** @type {Record<string, unknown>} */
  const json = {
    version: identity.version,
    auto_update: autoUpdate,
    provenance,
    ...(runningVersion !== undefined ? { running_version: runningVersion } : {}),
    ...(state.held_version ? { held_version: state.held_version } : {}),
    ...(state.checked_at ? { checked_at: state.checked_at } : {}),
    ...(state.latest_version ? { latest_version: state.latest_version } : {}),
    ...(available !== undefined ? { available } : {}),
    ...(state.error ? { error: state.error } : {}),
    // The quiet below defers diagnosis to `--json`, and `error_since` is
    // what decides how much longer the quiet lasts. Reporting the error
    // without it leaves the one question a diagnosing operator has (why
    // is this not in the status line, and when will it be) unanswerable
    // from the surface that exists to answer it.
    ...(state.error_since ? { error_since: state.error_since } : {}),
  }
  // The text line derives only from the shared state file: the process
  // rendering status (an npx run, a checkout) is not necessarily the
  // install doing the updating, so its own provenance would mislead
  // here. JSON carries provenance for the curious.
  if (autoUpdate === false) {
    return { line: 'self-update: off (auto_update is false)', json }
  }
  // A probe failure is usually just a laptop off the network, and it
  // clears itself on the next successful check. Rendering it would put
  // a degraded line on every `hyp status` for the length of a flight.
  // It stays in `json` for anyone actually diagnosing the updater. The
  // reprieve is bounded: past `PROBE_QUIET_MS` this is not a trip, it is
  // an updater that will never run again, and #cli-surface says status
  // is where that has to show. A non-string `error` (the state file is
  // read total, never validated) is not a probe failure and must not
  // throw here: `hyp status` renders it rather than dying on it.
  const quietProbeFailure = typeof state.error === 'string' &&
    state.error.startsWith('probe_failed') &&
    !probeFailureIsEntrenched(state, (opts.now ?? (() => new Date()))().getTime())
  if (state.error && !quietProbeFailure) {
    // The generic advice is "do it by hand", which is right for a failed
    // install and wrong for exactly one error: a refused registry
    // override. `npm install -g` typed into the same environment reads
    // the same `npm_config_registry` and installs from the very host the
    // updater declined to fetch a tarball from, so the status line would
    // be handing the operator the supply-chain swap the refusal exists
    // to prevent. `hyp update` already says the right thing here; this
    // says it too, shorter.
    //
    // The wording has to cover both refusals that land on this one error
    // string: an override the updater will not fetch a tarball from, and
    // two spellings of the variable that disagree (`registry_ambiguous`
    // in the log, `registry_untrusted` in the state). "Set it to an https
    // URL" is unactionable for the second, whose two values are usually
    // https already; "a single https URL" is the instruction that repairs
    // either one.
    const advice = state.error === 'registry_untrusted'
      ? 'npm_config_registry does not name a registry this updater will install from; ' +
        "point it at a single https URL, or configure the registry in .npmrc, then run 'hyp update'"
      : `run 'hyp update' or 'npm install -g ${identity.name}@latest'`
    return { line: `self-update: degraded (${state.error}); ${advice}`, json }
  }
  // A root newer than the running daemon is the one state a probe can
  // never notice on its own, because the probe reads the root.
  if (staleDaemon && heldOnDisk) {
    return {
      line: `self-update: ${identity.version} was installed here and could not start, so the daemon is still ` +
        `running ${runningVersion}; it is held until a newer release publishes`,
      json,
    }
  }
  if (staleDaemon) {
    return {
      line: `self-update: ${identity.version} is installed but the daemon is still running ${runningVersion}; ` +
        "run 'hyp daemon restart'",
      json,
    }
  }
  if (heldLatest && available) {
    return {
      line: `self-update: ${heldLatest} was installed and could not start here, so it was rolled back to ` +
        `${identity.version} and is held until a newer release publishes`,
      json,
    }
  }
  if (available && state.latest_version) {
    return { line: `self-update: ${state.latest_version} available (running ${identity.version})`, json }
  }
  return { line: null, json }
}

/**
 * @param {string} stateRoot
 * @returns {boolean}
 */
function daemonIsAlive(stateRoot) {
  const entry = readPidFile(stateRoot)
  return entry !== null && processIsAlive(entry.pid)
}

/**
 * Has this run of probe failures outlived the reprieve? Unknown or
 * unparseable `error_since` reads as "just started": a state file written
 * by an older kernel has no such field, and nagging on the strength of a
 * missing timestamp is the failure mode this reprieve exists to avoid.
 *
 * @param {SelfUpdateState} state
 * @param {number} nowMs
 * @returns {boolean}
 */
function probeFailureIsEntrenched(state, nowMs) {
  if (typeof state.error_since !== 'string') return false
  const since = Date.parse(state.error_since)
  if (Number.isNaN(since)) return false
  return nowMs - since >= PROBE_QUIET_MS
}

/** @type {CommandRunner} */
function runCommand(cmd, args, opts) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : NPM_TIMEOUT_MS
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /** @type {Buffer[]} */
    const stdoutChunks = []
    /** @type {Buffer[]} */
    const stderrChunks = []
    let settled = false
    // Two-stage kill: an npm that ignores SIGTERM would otherwise leave
    // this promise pending forever, and the daemon's `selfUpdateInFlight`
    // guard pinned with it - no further check for the life of the process.
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      const hard = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(-1)
      }, NPM_KILL_GRACE_MS)
      hard.unref?.()
    }, timeoutMs)
    timer.unref?.()
    /** @param {number} exitCode */
    function finish(exitCode) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    }
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)))
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code ?? -1))
  })
}
