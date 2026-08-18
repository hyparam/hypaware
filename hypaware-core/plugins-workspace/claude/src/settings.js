// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ConcurrentEditError,
  atomicWriteFile,
  errCode,
  isPlainObject,
  redactUrlUserinfo,
} from 'hypaware/core/util'
import { markActionRefused } from '../../../../src/core/config/action_refusal.js'
import { CLAUDE_OTEL_MIN_VERSION, CLAUDE_UPDATE_HINT, isBelowClaudeVersion } from './claude_version.js'

/**
 * Claude Code settings.json attach writer, keyed on the `_hypaware`
 * managed marker.
 *
 * Writes are atomic (temp file + rename) and gated on mtime so a
 * concurrent edit is detected instead of silently overwritten. The
 * `_hypaware` marker is the self-describing undo record the single core
 * undo (`detachClientFromDisk`, LLP 0045 §Part 3) replays: there is no
 * adapter `detach()`; the reverse lives in core so it survives the
 * plugin being unloaded (legacy pre-record markers included).
 *
 * The marker is also a **self-describing undo record**: it records
 * `prev_base_url` (the restore target) and the managed
 * `env.ANTHROPIC_BASE_URL` / session-context hook entries it added, so
 * a format-aware but plugin-agnostic core routine can reverse the
 * attach from disk alone, with the plugin unloaded. See LLP 0045
 * Part 3.
 *
 * The same record carries `prev_malformed`: any `env` / `hooks` block
 * that was present on disk with the wrong JSON type and had to be
 * rebuilt before attach could write into it. Attach repairs rather than
 * refuses, and the marker is what makes the repair reversible and
 * reportable instead of destructive. See LLP 0163.
 *
 * Three modes share all of that machinery unchanged. `base_url` repoints
 * `ANTHROPIC_BASE_URL` at the gateway, `proxy` sets `HTTPS_PROXY` plus a
 * CA, and `otel` turns on Claude Code's own telemetry export and routes
 * no traffic at all. Switching between them is the same key release in
 * every direction (see `releaseUnmanagedKeys`), so the marker stays the
 * whole undo record whichever mode wrote it.
 */

/**
 * @import { ClaudeAttachOptions, ClaudeAttachResult } from './types.js'
 */

const MARKER_KEY = '_hypaware'
// Each managed event lists which hook command kinds attach installs on it.
// `session-context` (LLP 0085) captures cwd/git identity for the projector and
// rides every event. `classify-cwd` (LLP 0106) is the session-start
// classification prompt and rides only the events where a *fresh* working
// directory appears - the session opening (SessionStart) and a mid-session cwd
// change (CwdChanged) - so a new, still-unclassified folder is caught while it
// makes no sense to re-ask on every prompt or Bash tool call.
const MANAGED_HOOK_SPECS = [
  { event: 'SessionStart', kinds: ['session-context', 'classify-cwd'] },
  { event: 'CwdChanged', kinds: ['session-context', 'classify-cwd'] },
  { event: 'UserPromptSubmit', kinds: ['session-context'] },
  { event: 'PostToolUse', matcher: 'Bash', kinds: ['session-context'] },
]
const MANAGED_HOOK_PATTERN = /\bclaude-hook\s+(session-context|classify-cwd)\b/

// Env keys attach adds *beside* the base URL to undo the defaults Claude Code
// flips when it sees a non-first-party `ANTHROPIC_BASE_URL`. Each entry is only
// ever added when absent and is removed (never restored) on detach - see
// `manageEnvAdditions` for the ownership rule.
//
// - ENABLE_TOOL_SEARCH: keeps deferred (on-demand) tool loading on. Without it
//   Claude Code sends every tool schema up front, tens of thousands of tokens of
//   per-session context bloat.
// - _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: keeps the model's real context
//   window. Behind any other host Claude Code assumes 200k even for native-1M
//   models, so the same session reads as ~18% context instead of ~4% and
//   warnings/auto-compact fire far too early. The key is underscore-prefixed and
//   undocumented: re-verify it against the Claude Code release (last verified
//   2.1.215) if attached sessions start reporting an inflated context percent
//   again. It is one branch of Claude Code's single is-first-party predicate, so
//   it gates more than the window: outbound it adds the context-1m beta header,
//   traceparent propagation and an extended usage-limit header, and it re-enables
//   the first-party-only side channels (error reporting, org policy limits,
//   memory-sync eligibility) that call Anthropic directly rather than the
//   gateway. It does *not* gate credential choice, which follows the oauth
//   session or the configured API key. All of that is accurate here - the gateway
//   is a byte-transparent pass-through to api.anthropic.com. That last part is a
//   precondition, not an invariant: the gateway's anthropic upstream `base_url`
//   is config, so repointing it elsewhere makes the declaration false. See the
//   LLP section below for the full gated list and the blast radius.
const MANAGED_ENV_ADDITIONS = [
  { key: 'ENABLE_TOOL_SEARCH', value: 'true' },
  { key: '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL', value: '1' },
]

/**
 * The env keys proxy-mode attach takes over.
 *
 * `HTTPS_PROXY` alone, deliberately: `HTTP_PROXY` would hand us plain-HTTP
 * requests in absolute-form, which the gateway does not serve, and no traffic
 * we want is unencrypted. `NO_PROXY` is left entirely alone - it is the user's
 * escape list and ours to honour, not to write.
 *
 * Unlike the base-URL keys these are not add-only: a value already present is
 * more likely to be a corporate proxy than a stale setting, so attach backs it
 * up (`prev_env`) before overriding, and detach puts it back.
 *
 * @ref LLP 0232#attach-writes-https_proxy-not-a-base-url [implements]
 */
const PROXY_MODE_ENV_KEYS = ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']

/** @type {'proxy'} */
export const MODE_PROXY = 'proxy'
/** @type {'base_url'} */
export const MODE_BASE_URL = 'base_url'
/** @type {'otel'} */
export const MODE_OTEL = 'otel'

/**
 * The env block `otel` mode writes, in order.
 *
 * The list *is* the decision, which is why it is spelled out here rather than
 * assembled from flags: it is the exported contract between attach, the
 * listener that receives what these flags turn on, and the spool sweep. Note
 * what is absent - no `ANTHROPIC_BASE_URL`, no `HTTPS_PROXY`, no
 * `NODE_EXTRA_CA_CERTS` - which is what leaves the endpoint first-party and
 * Remote Control working with no override keys at all.
 *
 * Unlike the base-URL mode's additions these are take-over keys, handled like
 * the proxy keys: a user who already points Claude Code at their own collector
 * has that value backed up into `prev_env` and restored on detach, rather than
 * being skipped (which would leave attach reporting success while the events
 * went somewhere else).
 *
 * @ref LLP 0258#env-keys [implements]: exactly these keys, and only these
 * @param {{ telemetryPort: number, spoolDir: string }} args
 * @returns {{ key: string, value: string }[]}
 */
export function otelModeEnv({ telemetryPort, spoolDir }) {
  return [
    { key: 'CLAUDE_CODE_ENABLE_TELEMETRY', value: '1' },
    { key: 'OTEL_LOGS_EXPORTER', value: 'otlp' },
    { key: 'OTEL_METRICS_EXPORTER', value: 'otlp' },
    { key: 'OTEL_EXPORTER_OTLP_PROTOCOL', value: 'http/json' },
    { key: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: `http://127.0.0.1:${telemetryPort}` },
    { key: 'OTEL_LOG_USER_PROMPTS', value: '1' },
    { key: 'OTEL_LOG_ASSISTANT_RESPONSES', value: '1' },
    { key: 'OTEL_LOG_TOOL_DETAILS', value: '1' },
    { key: 'OTEL_LOG_RAW_API_BODIES', value: `file:${spoolDir}` },
  ]
}

/**
 * The OTLP env keys that OUTRANK the ones {@link otelModeEnv} writes.
 *
 * In the OTLP environment-variable contract a per-signal key beats the generic
 * one, so `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` decides where log records go no
 * matter what `OTEL_EXPORTER_OTLP_ENDPOINT` says. Attach deliberately does not
 * manage these (LLP 0258 #env-keys is "exactly these keys, and only these"),
 * which leaves one shape that has to be said out loud rather than discovered:
 * a user already exporting to their own collector through a per-signal key
 * gets `OTEL_LOG_USER_PROMPTS` and `OTEL_LOG_ASSISTANT_RESPONSES` turned on by
 * this attach, and their prompts and assistant responses start flowing THERE,
 * while HypAware reports `attached (otel)` and captures nothing.
 *
 * `OTEL_EXPORTER_OTLP_HEADERS` is in the list for the same reason from the
 * other side: it is the key that carries a collector's credentials, and it
 * would now ride requests aimed at our listener.
 */
const OTEL_PER_SIGNAL_OVERRIDE_KEYS = [
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_HEADERS',
]

/**
 * Warn for each per-signal OTLP key left standing in the settings `env` block
 * after an `otel` attach.
 *
 * A warning, not a refusal: attach has no way to see a key exported from the
 * user's shell, so refusing on the half it CAN see would buy a false sense of
 * completeness. The values are never echoed - an endpoint or a headers value
 * is exactly where a collector token lives, and this string is printed, logged
 * and serialised into `--json`.
 *
 * @param {Record<string, unknown>} env the live `env` block, after the write
 * @returns {string[]}
 */
function perSignalOverrideWarnings(env) {
  /** @type {string[]} */
  const out = []
  for (const key of OTEL_PER_SIGNAL_OVERRIDE_KEYS) {
    const value = env[key]
    if (value === undefined || value === null || value === '') continue
    out.push(
      `env.${key} is set and outranks the endpoint hypaware just wrote; ` +
      'Claude Code will export there instead, including the prompt and response ' +
      'text this attach turns on. Remove it, or point it at the same local ' +
      'listener, then re-run hyp attach claude'
    )
  }
  return out
}

export class ClaudeSettingsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ClaudeSettingsError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * Default Claude Code settings.json location: `~/.claude/settings.json`.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultSettingsPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.claude', 'settings.json')
}

/**
 * Route Claude Code through the local AI gateway by writing the
 * `_hypaware` marker, `env.ANTHROPIC_BASE_URL`, and the managed
 * session-context hook entries into settings.json.
 *
 * @param {ClaudeAttachOptions} opts
 * @returns {Promise<ClaudeAttachResult>}
 */
export async function attach(opts) {
  const {
    port,
    version,
    stateFile,
    settingsPath = defaultSettingsPath(),
    binPath = 'hyp',
    mode = MODE_BASE_URL,
    caCertPath,
    telemetryPort,
    spoolDir,
    claudeVersion,
  } = opts
  validatePort(port)
  validateVersion(version)
  validateStateFile(stateFile)
  if (mode !== MODE_PROXY && mode !== MODE_BASE_URL && mode !== MODE_OTEL) {
    throw new ClaudeSettingsError(`unknown attach mode: ${String(mode)}`, { code: 'INVALID_MODE' })
  }
  if (mode === MODE_OTEL) {
    // Refused *before the settings file is even read*, which is the whole
    // content of "leaves any existing attach untouched": a machine on the old
    // client keeps whatever attach it already had, rather than being moved to
    // a mode that captures nothing. There is deliberately no fallback to proxy
    // or base-URL mode here - one attach mode per client - so the refusal is
    // an error the caller reports, not a quiet downgrade.
    // @ref LLP 0258#version-floor [implements]: below the floor attach refuses the switch and prints the upgrade hint
    if (isBelowClaudeVersion(claudeVersion, CLAUDE_OTEL_MIN_VERSION)) {
      throw markActionRefused(new ClaudeSettingsError(
        `Claude Code ${String(claudeVersion)} is older than ${CLAUDE_OTEL_MIN_VERSION}, ` +
        'which is the first release that exports the telemetry HypAware captures; ' +
        `run '${CLAUDE_UPDATE_HINT}' and attach again`,
        { code: 'VERSION_FLOOR' }
      ))
    }
    validateTelemetryPort(telemetryPort)
    validateSpoolDir(spoolDir)
  }
  // Proxy mode routes *all* of Claude Code's HTTPS through the gateway, so an
  // attach that lands without a working local CA does not degrade to
  // unrecorded-but-working: it breaks authentication, updates and model calls
  // alike. The CA file is written by the gateway only after proxy mode boots
  // successfully, which makes its presence the one preflight worth having.
  // @ref LLP 0232#proxy-attach-preflight [implements]: refuse rather than write a setting that breaks all egress
  if (mode === MODE_PROXY) {
    if (typeof caCertPath !== 'string' || caCertPath.length === 0) {
      throw new ClaudeSettingsError(
        'proxy-mode attach requires the local CA certificate path',
        { code: 'CA_REQUIRED' }
      )
    }
    if (!path.isAbsolute(caCertPath)) {
      throw new ClaudeSettingsError(
        `caCertPath must be an absolute path, got '${caCertPath}'`,
        { code: 'CA_REQUIRED' }
      )
    }
    try {
      await fs.access(caCertPath)
    } catch (err) {
      throw markActionRefused(new ClaudeSettingsError(
        `no local CA at ${caCertPath}; start the daemon with proxy mode enabled before attaching`,
        { code: 'CA_MISSING', cause: err }
      ))
    }
  }

  const { value, mtimeMs } = await readSettings(settingsPath)
  const priorMarker = isPlainObject(value[MARKER_KEY]) ? value[MARKER_KEY] : undefined

  // What the marker said before this run rewrites it. A proxy attach leaves
  // residue no settings write reaches (the launchd environment, the keychain
  // trust), and by the time the caller could re-read the marker this write has
  // already replaced it, so the prior mode is reported on the result. Only the
  // three known modes are reported: a legacy marker without one predates modes
  // entirely and has no residue to unwind.
  // @ref LLP 0262#migration [implements]: the prior mode is what tells the adapter a proxy attach is being migrated
  /** @type {'proxy' | 'base_url' | 'otel' | undefined} */
  let priorMode
  if (
    priorMarker &&
    (priorMarker.mode === MODE_PROXY || priorMarker.mode === MODE_BASE_URL || priorMarker.mode === MODE_OTEL)
  ) {
    priorMode = priorMarker.mode
  }

  // A backup an earlier run already recorded at some path. Read before anything
  // is displaced, because it decides what this run is allowed to claim: a prior
  // entry wins (see below), so a value displaced *this* run at an
  // already-recorded path is dropped rather than backed up, and the warning has
  // to say that instead of promising a restore that will not happen.
  // `Object.hasOwn`, not `in`: these keys come off disk.
  // @ref LLP 0163#prev_malformed-is-path-keyed-not-one-field-per-block [constrained-by]: the earliest backup wins, so a later displacement at the same path is discarded, not recorded
  /** @type {Record<string, unknown>} */
  const priorMalformed = priorMarker && isPlainObject(priorMarker.prev_malformed)
    ? priorMarker.prev_malformed
    : {}

  // The backup half of back-up-then-repair. Every block attach has to rebuild
  // because what was on disk was present but the wrong JSON type lands here,
  // keyed by its dotted path: the value goes into the marker (which is already
  // where everything else attach displaces is kept) and the path becomes a
  // warning the caller prints. Attach keeps succeeding; what it destroyed
  // silently before is now both reported and reversible.
  // @ref LLP 0163#back-up-then-repair-not-refuse [implements]: collect displaced malformed blocks for the marker and the caller
  /** @type {Record<string, unknown>} */
  const displaced = {}
  /** @type {string[]} */
  const warnings = []
  /** @type {(dottedPath: string, prior: unknown, expected: 'object' | 'array') => void} */
  const recordDisplaced = (dottedPath, prior, expected) => {
    if (Object.hasOwn(priorMalformed, dottedPath)) {
      // Nowhere to put it. The path already holds the earlier backup, and that
      // one is the user's content from before hypaware first repaired the
      // block, so it is the one worth keeping. This value is genuinely gone;
      // saying "backed up, detach restores it" here would be the same silent
      // destruction the record exists to end, just with a reassuring sentence
      // on top. The value itself is not echoed: a malformed `env` is exactly
      // where an API key ends up, and this string is printed and logged.
      warnings.push(
        `${dottedPath} was not a JSON ${expected}; ` +
        `${MARKER_KEY}.prev_malformed already holds an earlier backup for that path, ` +
        `so this value was discarded and hyp detach will not restore it`
      )
      return
    }
    displaced[dottedPath] = prior
    warnings.push(
      `${dottedPath} was not a JSON ${expected}; ` +
      `its previous value is backed up in ${MARKER_KEY}.prev_malformed and hyp detach restores it`
    )
  }

  const env = ensureObject(value, 'env', recordDisplaced)
  // Presence, not type - the same ownership rule `manageEnvAdditions` follows,
  // and the base URL needs it more, not less. The managed additions at least
  // fall through an ownership guard when they are not ours; this key has no
  // such `continue`, because attach always repoints it. The backup IS the
  // guard. So a type test here did not merely skip a notice: a hand-written
  // `"ANTHROPIC_BASE_URL": null` (a user switching an override back off) or a
  // stray number read as "nothing to back up", attach wrote no
  // `prev_base_url`, and the undo - finding a managed key with no prior to
  // restore - deleted the key outright. The user's value was gone, from a
  // detach that reported success. Back up whatever is on disk, whatever its
  // JSON type; coerce only for the human-readable `prevValue` report, exactly
  // as the core undo does for `removed`. No explicit presence test is needed to
  // read it: JSON cannot encode `undefined`, so `undefined` here already means
  // "absent", and the `prevBaseUrl !== undefined` checks below are the presence
  // test - which is precisely what the discarded type test was standing in for.
  const baseUrl = `http://127.0.0.1:${port}`
  const commands = managedHookCommands(binPath, stateFile)

  const priorManagedEnv = priorMarker && isPlainObject(priorMarker.managed) && isPlainObject(priorMarker.managed.env)
    ? /** @type {Record<string, unknown>} */ (priorMarker.managed.env)
    : undefined
  const priorPrevEnv = priorMarker && isPlainObject(priorMarker.prev_env)
    ? /** @type {Record<string, unknown>} */ (priorMarker.prev_env)
    : undefined

  /**
   * What a key held before attach first took it over.
   *
   * Three cases, and the middle one is the one a naive version gets wrong. A
   * backup already on the marker is carried forward untouched (the live value
   * is ours by now). A key the *prior* marker managed has no user value left to
   * record. Otherwise this run is the first to claim the key, so whatever is on
   * disk is the user's and gets backed up - which is also what makes switching
   * modes safe, because the keys the new mode claims were not managed by the
   * old one.
   *
   * Presence, not type, throughout: a hand-written `null` is a value to give
   * back, not an absence.
   *
   * @ref LLP 0044#conflict-back-up--override-restore-on-leave [constrained-by]: the marker IS the backup restored on leave
   * @param {string} key
   * @returns {{ value: unknown, carriedForward: boolean }}
   */
  function priorValueFor(key) {
    if (priorPrevEnv && Object.hasOwn(priorPrevEnv, key)) {
      return { value: priorPrevEnv[key], carriedForward: true }
    }
    // Only "ours" if the live value is still the one we wrote. Treating a prior
    // marker's claim on the key as proof of ownership let a hand-edit in
    // between two attaches be swallowed and then deleted by detach: the user
    // pointed the key at their own proxy, the re-attach overwrote it with no
    // backup, and the detach reported success while removing it. Detach and
    // `releaseUnmanagedKeys` both compare; this has to agree with them.
    if (priorManagedEnv && Object.hasOwn(priorManagedEnv, key) && env[key] === priorManagedEnv[key]) {
      return { value: undefined, carriedForward: true }
    }
    return {
      value: Object.hasOwn(env, key) ? env[key] : undefined,
      carriedForward: false,
    }
  }

  /** @type {Record<string, string>} */
  const managedEnv = {}
  /** @type {Record<string, unknown>} */
  const prevEnv = {}

  // What `env.ANTHROPIC_BASE_URL` held before attach first took it over.
  //
  // A recorded `prev_base_url` wins: once we own the URL the live value is
  // *our* gateway URL, so a re-attach must keep the marker's record rather than
  // backing up the gateway URL over it. Otherwise fall through to the same
  // ownership rule every other key uses, which is what makes a prior *proxy*
  // marker (which never claimed this key) back up the user's own base URL
  // instead of silently discarding it.
  // @ref LLP 0044#conflict-back-up--override-restore-on-leave [constrained-by]: the marker IS the backup restored on leave
  const prevBaseUrl = priorMarker && Object.hasOwn(priorMarker, 'prev_base_url')
    ? priorMarker.prev_base_url
    : priorValueFor('ANTHROPIC_BASE_URL').value

  if (mode === MODE_PROXY) {
    // The base URL stays `api.anthropic.com`, so Claude Code keeps treating the
    // endpoint as first party. That is the whole point: Remote Control refuses
    // to run against any other host, and the two env keys the base-URL mode has
    // to set to undo first-party-only defaults become unnecessary rather than
    // merely unset.
    // @ref LLP 0232#attach-writes-https_proxy-not-a-base-url [implements]
    /** Backups this run took, as opposed to ones carried forward from the marker. */
    let displacedProxy
    for (const key of PROXY_MODE_ENV_KEYS) {
      const prior = priorValueFor(key)
      if (prior.value !== undefined) prevEnv[key] = prior.value
      if (prior.carriedForward || prior.value === undefined) continue
      if (key === 'HTTPS_PROXY') {
        displacedProxy = prior.value
        continue
      }
      // Node reads only one file from NODE_EXTRA_CA_CERTS, so taking it over
      // silently drops whatever trust bundle was there - typically a corporate
      // root, whose absence shows up as unrelated TLS failures. Backed up and
      // restored on detach either way, but the user has to be told.
      warnings.push(
        `env.${key} was already set to ${String(prior.value)}; ` +
        'hypaware now manages it and hyp detach restores it'
      )
    }
    // An existing proxy is far more likely to be a corporate egress proxy than
    // a leftover. Overriding it silently would cut the user's outbound path,
    // and the failure would look like the gateway breaking their network.
    //
    // Warned about only on the run that displaced it: a re-attach carries the
    // backup forward on the marker and has nothing new to tell the user, so
    // repeating the notice every time would train them to ignore it.
    //
    // Redacted, and only here: the value is written to the marker verbatim
    // (that copy is the backup detach restores from) but this one is printed to
    // a terminal, echoed into `--json`, and logged as `client.attach.
    // malformed_block`, which an operator's own sink may ship off the machine.
    // A corporate proxy URL is exactly the field that carries `user:pass@`, and
    // recording credentials is not something any of those three surfaces is
    // allowed to do. Host and port survive, so the user can still recognise
    // which proxy was displaced.
    if (typeof displacedProxy === 'string' && displacedProxy.length > 0) {
      warnings.push(
        `env.HTTPS_PROXY was already set to ${redactUrlUserinfo(displacedProxy)}; ` +
        `hypaware now handles it and hyp detach restores it. ` +
        `If that is a required outbound proxy, set upstream_proxy on the ` +
        `ai-gateway config to the same value so traffic still chains through it`
      )
    }
    managedEnv.HTTPS_PROXY = `http://127.0.0.1:${port}`
    managedEnv.NODE_EXTRA_CA_CERTS = /** @type {string} */ (caCertPath)
    for (const [key, next] of Object.entries(managedEnv)) env[key] = next
  } else if (mode === MODE_OTEL) {
    // Claude Code talks to Anthropic directly and exports its own telemetry to
    // us, so nothing here routes traffic: the endpoint stays first party and
    // the Remote Control predicate holds without a single override key.
    // @ref LLP 0258#env-keys [implements]
    // @ref LLP 0258#settings-env [implements]: the settings `env` block is the only surface attach writes
    const additions = otelModeEnv({
      telemetryPort: /** @type {number} */ (telemetryPort),
      spoolDir: /** @type {string} */ (spoolDir),
    })
    for (const { key } of additions) {
      const prior = priorValueFor(key)
      if (prior.value !== undefined) prevEnv[key] = prior.value
      if (prior.carriedForward || prior.value === undefined) continue
      // A pre-existing OTEL key is almost always a user's own collector, and
      // taking it over silently would send their telemetry here instead. The
      // value is backed up and restored on detach either way, but only the run
      // that displaced it has anything new to say. The value itself is not
      // echoed: an endpoint or a headers value is exactly where a collector
      // token ends up, and this string is printed and logged.
      warnings.push(
        `env.${key} was already set; hypaware now manages it and hyp detach restores it`
      )
    }
    for (const { key, value } of additions) {
      managedEnv[key] = value
      env[key] = value
    }
    warnings.push(...perSignalOverrideWarnings(env))
  } else {
    // Undo the defaults Claude Code flips because the gateway URL is not
    // api.anthropic.com: eager tool-schema loading, and a 200k assumed context
    // window that inflates the reported context percent. See
    // MANAGED_ENV_ADDITIONS for the per-key rationale.
    // @ref LLP 0045#enable_tool_search-keep-deferred-tool-loading-on-through-the-gateway [implements]: attach sets ENABLE_TOOL_SEARCH=true so the non-first-party base URL doesn't force eager tool-schema loading
    // @ref LLP 0045#_claude_code_assume_first_party_base_url-keep-the-models-real-context-window [implements]: attach declares the pass-through gateway first-party so the assumed window isn't cut to 200k
    const managedAdditions = manageEnvAdditions(env, priorManagedEnv)
    env.ANTHROPIC_BASE_URL = baseUrl
    managedEnv.ANTHROPIC_BASE_URL = baseUrl
    Object.assign(managedEnv, managedAdditions)
  }

  // Switching modes drops keys the previous mode owned. Leaving them behind
  // would strand a live `ANTHROPIC_BASE_URL` pointing at the gateway - which
  // is exactly the non-first-party host proxy mode exists to stop sending, so
  // the attach would silently fail to deliver what it promised. Reverse them
  // here, by the same rule detach uses.
  // @ref LLP 0232#mode-migration [implements]: attach releases keys the new mode does not manage
  releaseUnmanagedKeys({ env, priorManagedEnv, managedEnv, priorPrevEnv, priorMarker, warnings })

  installManagedHooks(value, commands, recordDisplaced)

  // Preserve a prior backup across a re-attach, for the same reason
  // `prev_base_url` is preserved: once attach has repaired the block the live
  // value is *ours*, so the second attach finds nothing malformed and must not
  // let the record of what the first one displaced fall off the marker. A prior
  // entry wins over anything found this run at the same path - the earliest
  // backup is the one holding the user's own content. `recordDisplaced` already
  // refuses to collect a colliding path, so the spread order is belt and braces.
  // @ref LLP 0044#conflict-back-up--override-restore-on-leave [constrained-by]: the marker IS the backup, so it must survive re-attach
  const prevMalformed = { ...displaced, ...priorMalformed }

  // Self-describing undo record: enough for the format-aware core undo to
  // restore-or-remove every managed env key, strip the managed hook entries,
  // and delete the marker without loading this plugin, leaving no orphaned
  // `hyp claude-hook` entries.
  //
  // `mode` is recorded because the undo is no longer the same for both: a
  // proxy-mode marker also means a machine-local CA has to be removed, and
  // nothing else on disk says so.
  // @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements]: claude marker records the managed env/hook entries and what they displaced
  // @ref LLP 0235#detach-removes-the-ca [implements]: the marker's mode is what tells the plugin-agnostic undo a CA exists
  value[MARKER_KEY] = {
    attached_at: new Date().toISOString(),
    version,
    port,
    state_file: stateFile,
    mode,
    managed: {
      env: managedEnv,
      hooks: managedHookEntries(commands),
    },
    // `prev_base_url` stays its own field rather than folding into `prev_env`:
    // markers written by earlier versions carry it, and the core undo still
    // reads it, so moving it would strand every settings file already on disk.
    ...(mode === MODE_BASE_URL && prevBaseUrl !== undefined
      ? { prev_base_url: prevBaseUrl }
      : {}),
    // The one thing about an `otel` attach that is not derivable from the
    // managed keys: detach and `hyp purge` have to empty a directory neither
    // of them computed, and the env value that names it is gone by the time
    // they run.
    // @ref LLP 0258#marker-and-spool [implements]: the marker records the spool directory
    ...(mode === MODE_OTEL ? { spool_dir: spoolDir } : {}),
    ...(Object.keys(prevEnv).length > 0 ? { prev_env: prevEnv } : {}),
    ...(Object.keys(prevMalformed).length > 0 ? { prev_malformed: prevMalformed } : {}),
  }

  await writeAtomic(settingsPath, value, mtimeMs)

  /** @type {ClaudeAttachResult} */
  const result = { changed: true }
  if (priorMode !== undefined) result.priorMode = priorMode
  // Each mode reports the key it actually took over. Reporting a displaced
  // base URL from a mode that never touched `ANTHROPIC_BASE_URL` would be the
  // first thing a user checked when their own value turned out to still be
  // there.
  const reportedPrev = mode === MODE_PROXY
    ? prevEnv.HTTPS_PROXY
    : mode === MODE_OTEL
      ? prevEnv.OTEL_EXPORTER_OTLP_ENDPOINT
      : prevBaseUrl
  if (reportedPrev !== undefined) {
    const shown = typeof reportedPrev === 'string' ? reportedPrev : String(reportedPrev)
    // A display field, not the backup: the marker above already holds the true
    // value, and this one is printed and serialised into `prev_value`. In proxy
    // mode it is a `HTTPS_PROXY` that routinely carries `user:pass@`, and in
    // `otel` mode a collector endpoint that can carry the same, so the userinfo
    // comes off the copy the user and any `--json` consumer see. Base URLs go
    // through unchanged: `ANTHROPIC_BASE_URL` carries no userinfo, and the
    // value is the whole point of the notice.
    result.prevValue = mode === MODE_BASE_URL ? shown : redactUrlUserinfo(shown)
  }
  // Only what *this* run displaced. A re-attach carries the prior backup on the
  // marker but has nothing new to tell the user about, so it warns about
  // nothing.
  if (warnings.length > 0) result.warnings = warnings
  return result
}

/**
 * Reverse every env key a previous attach managed that this one does not.
 *
 * This is the detach rule applied mid-attach: a key whose live value is still
 * the one we wrote is ours to give back (to its recorded prior) or remove; a
 * key the user has since changed is theirs, and is left alone with a notice.
 * Without it, switching from base-URL to proxy mode leaves
 * `ANTHROPIC_BASE_URL` and the two first-party override keys behind, still
 * pointing Claude Code at the gateway.
 *
 * @param {object} args
 * @param {Record<string, unknown>} args.env the live `env` block, mutated in place
 * @param {Record<string, unknown> | undefined} args.priorManagedEnv
 * @param {Record<string, string>} args.managedEnv keys the current mode manages
 * @param {Record<string, unknown> | undefined} args.priorPrevEnv
 * @param {Record<string, unknown> | undefined} args.priorMarker
 * @param {string[]} args.warnings
 */
function releaseUnmanagedKeys({ env, priorManagedEnv, managedEnv, priorPrevEnv, priorMarker, warnings }) {
  if (!priorManagedEnv) return
  for (const [key, ourValue] of Object.entries(priorManagedEnv)) {
    if (Object.hasOwn(managedEnv, key)) continue
    if (!Object.hasOwn(env, key)) continue
    if (env[key] !== ourValue) {
      warnings.push(`env.${key} was changed externally; leaving it in place`)
      continue
    }
    /** @type {unknown} */
    let restore
    if (priorPrevEnv && Object.hasOwn(priorPrevEnv, key)) {
      restore = priorPrevEnv[key]
    } else if (key === 'ANTHROPIC_BASE_URL' && priorMarker && Object.hasOwn(priorMarker, 'prev_base_url')) {
      restore = priorMarker.prev_base_url
    }
    if (restore !== undefined) env[key] = restore
    else delete env[key]
  }
}

/**
 * Write each {@link MANAGED_ENV_ADDITIONS} entry that is ours to manage and
 * return exactly those keys for the marker's undo record.
 *
 * A key is ours when a prior marker recorded it as managed (so a re-attach
 * keeps owning the value it wrote) or when it is absent from settings. A value
 * the user set themselves is left untouched and stays out of the undo record,
 * so detach never clobbers it - the same never-clobber-a-user-value stance the
 * base URL takes, minus a backup: these keys are only ever *added*.
 *
 * Ownership turns on **presence, not JSON type**. Claude Code reads these keys
 * as env strings, but settings.json is hand-edited and a user can perfectly well
 * write `"ENABLE_TOOL_SEARCH": true` as a JSON boolean. Testing the type instead
 * of the key let a non-string value fall through the guard: attach coerced it,
 * recorded the key as managed, and detach then deleted the user's own setting.
 * Anything already at the key is the user's, whatever its type.
 *
 * @ref LLP 0045#enable_tool_search-keep-deferred-tool-loading-on-through-the-gateway [implements]: the "only manage the key when it is ours" rule that binds every managed env key
 * @param {Record<string, unknown>} env the live `env` block, mutated in place
 * @param {Record<string, unknown> | undefined} priorManagedEnv the prior marker's managed env, if any
 * @returns {Record<string, string>} the keys attach now manages
 */
function manageEnvAdditions(env, priorManagedEnv) {
  /** @type {Record<string, string>} */
  const managed = {}
  for (const { key, value } of MANAGED_ENV_ADDITIONS) {
    const weOwnIt = priorManagedEnv ? Object.hasOwn(priorManagedEnv, key) : false
    if (!weOwnIt && Object.hasOwn(env, key)) continue
    env[key] = value
    managed[key] = value
  }
  return managed
}

/**
 * @param {string} settingsPath
 * @returns {Promise<{ value: Record<string, unknown>, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readSettings(settingsPath) {
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { value: {}, existed: false, mtimeMs: undefined }
    }
    throw new ClaudeSettingsError(`failed to read ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  let stat
  try {
    stat = await fs.stat(settingsPath)
  } catch (err) {
    throw new ClaudeSettingsError(`failed to stat ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    if (looksLikeJsonc(raw)) {
      throw markActionRefused(
        new ClaudeSettingsError(
          `${settingsPath} appears to be JSONC; refuse to modify`,
          { code: 'JSONC', cause: err }
        )
      )
    }
    throw new ClaudeSettingsError(`malformed JSON in ${settingsPath}: ${errMsg(err)}`, {
      code: 'MALFORMED_JSON',
      cause: err,
    })
  }

  if (!isPlainObject(parsed)) {
    throw new ClaudeSettingsError(
      `${settingsPath} must contain a JSON object at the root`,
      { code: 'NOT_AN_OBJECT' }
    )
  }

  return { value: parsed, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @param {number | undefined} expectedMtimeMs
 * @returns {Promise<void>}
 */
async function writeAtomic(filePath, value, expectedMtimeMs) {
  const body = JSON.stringify(value, null, 2) + '\n'
  try {
    await atomicWriteFile(filePath, body, { mode: 0o600, fsync: true, expectedMtimeMs })
  } catch (err) {
    if (err instanceof ConcurrentEditError) {
      throw new ClaudeSettingsError(err.message, { code: 'CONCURRENT_EDIT', cause: err.cause ?? err })
    }
    throw err
  }
}

/**
 * Get-or-create `value[key]` as an object, handing whatever **present but
 * non-object** value it displaces to `record` first.
 *
 * A hand-edited `"env": "ANTHROPIC_API_KEY=sk-x"` is still something the user
 * wrote and meant. Replacing it with `{}` and returning success destroyed it
 * with nothing on disk to recover it from, and nothing told them. Attach still
 * repairs the block (it has to write into it, and refusing would turn a
 * one-key typo into a failed enrollment), but the displaced value goes into the
 * marker's `prev_malformed` backup, `hyp detach` puts it back, and the caller
 * gets a warning to print.
 *
 * Absent is not malformed: a key that was never there displaces nothing and
 * records nothing, which is the ordinary first-attach path.
 *
 * @ref LLP 0163#back-up-then-repair-not-refuse [implements]: the displaced value is recorded into the marker, not discarded
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @param {(dottedPath: string, prior: unknown, expected: 'object' | 'array') => void} [record]
 * @returns {Record<string, unknown>}
 */
function ensureObject(value, key, record) {
  const existing = value[key]
  if (isPlainObject(existing)) return existing
  // Presence, not type, separates "absent" from "malformed": JSON cannot encode
  // `undefined`, so `hasOwn` is the whole test, and a hand-written `null` is a
  // value the user put there rather than a missing key.
  if (record && Object.hasOwn(value, key)) record(key, existing, 'object')
  /** @type {Record<string, unknown>} */
  const fresh = {}
  value[key] = fresh
  return fresh
}

/**
 * Install every managed hook: for each event in {@link MANAGED_HOOK_SPECS},
 * strip any prior managed handlers, then push one group per command kind the
 * event carries (`session-context`, and on session-start events `classify-cwd`
 * too). A group is `{ matcher?, hooks: [{ type, command }] }`.
 *
 * A present-but-non-array `hooks.<event>` is the same case {@link ensureObject}
 * handles one level up, and takes the same answer: back the value up through
 * `record`, then rebuild the list. Rebuilding is unavoidable here (there is no
 * meaningful way to append a hook group to a string), so the only question is
 * whether the displaced value is recoverable afterwards.
 *
 * @param {Record<string, unknown>} value
 * @param {Record<string, string>} commands map from hook kind to its command string
 * @param {(dottedPath: string, prior: unknown, expected: 'object' | 'array') => void} [record]
 */
function installManagedHooks(value, commands, record) {
  const hooksRoot = ensureObject(value, 'hooks', record)
  for (const spec of MANAGED_HOOK_SPECS) {
    const { event } = spec
    const existing = hooksRoot[event]
    if (record && !Array.isArray(existing) && Object.hasOwn(hooksRoot, event)) {
      record(`hooks.${event}`, existing, 'array')
    }
    const groups = Array.isArray(existing)
      ? existing.filter((group) => !isManagedHookGroup(group)).map(removeManagedHandlers)
      : []
    for (const kind of spec.kinds) {
      groups.push({
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [{ type: 'command', command: commands[kind] }],
      })
    }
    hooksRoot[event] = groups
  }
}

/**
 * The managed hook entries this attach installs, one per (event, kind),
 * recorded into the marker's undo record so the core undo can strip exactly
 * what {@link installManagedHooks} added without re-deriving them from the
 * (possibly unloaded) plugin.
 *
 * @param {Record<string, string>} commands map from hook kind to its command string
 * @returns {{ event: string, matcher?: string, command: string }[]}
 */
function managedHookEntries(commands) {
  /** @type {{ event: string, matcher?: string, command: string }[]} */
  const entries = []
  for (const spec of MANAGED_HOOK_SPECS) {
    for (const kind of spec.kinds) {
      entries.push({
        event: spec.event,
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        command: commands[kind],
      })
    }
  }
  return entries
}

/** @param {unknown} group */
function removeManagedHandlers(group) {
  if (!isPlainObject(group)) return group
  const handlers = group.hooks
  if (!Array.isArray(handlers)) return group
  return {
    ...group,
    hooks: handlers.filter((handler) => !isManagedHookHandler(handler)),
  }
}

/** @param {unknown} group */
function isManagedHookGroup(group) {
  if (!isPlainObject(group)) return false
  const handlers = group.hooks
  return Array.isArray(handlers) &&
    handlers.length > 0 &&
    handlers.every(isManagedHookHandler)
}

/** @param {unknown} handler */
function isManagedHookHandler(handler) {
  if (!isPlainObject(handler)) return false
  return handler.type === 'command' &&
    typeof handler.command === 'string' &&
    MANAGED_HOOK_PATTERN.test(handler.command)
}

/**
 * The command string per managed hook kind. `session-context` needs the
 * absolute state-file path baked in (the projector reads the same file);
 * `classify-cwd` needs no arguments (it derives the machine-local list path and
 * the enrollment state from `HYP_HOME`/config at run time).
 *
 * @param {string} binPath
 * @param {string} stateFile
 * @returns {Record<'session-context' | 'classify-cwd', string>}
 */
function managedHookCommands(binPath, stateFile) {
  const bin = shellQuote(binPath)
  return {
    'session-context': `${bin} claude-hook session-context --state-file ${shellQuote(stateFile)}`,
    'classify-cwd': `${bin} claude-hook classify-cwd`,
  }
}

/** @param {string} value */
function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
  const quote = String.fromCharCode(39)
  return quote + value.split(quote).join(quote + '\\' + quote + quote) + quote
}

/** @param {string} content */
function looksLikeJsonc(content) {
  let inString = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (inString) {
      if (c === '\\' && i + 1 < content.length) {
        i++
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '/' && i + 1 < content.length) {
      const next = content[i + 1]
      if (next === '/' || next === '*') return true
    }
  }
  return false
}

/** @param {unknown} port */
function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ClaudeSettingsError(`invalid port: ${String(port)}`, { code: 'INVALID_PORT' })
  }
}

/** @param {unknown} version */
function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new ClaudeSettingsError('version must be a non-empty string', {
      code: 'INVALID_VERSION',
    })
  }
}

/**
 * The listener port `otel` mode points Claude Code at. A separate validator
 * from {@link validatePort} so the error names the option the caller passed:
 * two ports reach `attach()` in this mode, and "invalid port" would not say
 * which one.
 *
 * @param {unknown} telemetryPort
 */
function validateTelemetryPort(telemetryPort) {
  if (
    typeof telemetryPort !== 'number' ||
    !Number.isInteger(telemetryPort) ||
    telemetryPort < 1 ||
    telemetryPort > 65535
  ) {
    throw new ClaudeSettingsError(
      `otel-mode attach requires the telemetry listener port, got '${String(telemetryPort)}'`,
      { code: 'INVALID_TELEMETRY_PORT' }
    )
  }
}

/**
 * Absolute, because the value goes into `OTEL_LOG_RAW_API_BODIES` and Claude
 * Code resolves it against *its own* working directory. A relative path there
 * would scatter raw request bodies through every repo the user works in,
 * outside the HypAware home that `hyp purge` and detach sweep.
 *
 * @ref LLP 0253#spool-location [constrained-by]: the spool lives under the HypAware home
 * @param {unknown} spoolDir
 */
function validateSpoolDir(spoolDir) {
  if (typeof spoolDir !== 'string' || spoolDir.length === 0) {
    throw new ClaudeSettingsError('otel-mode attach requires the body spool directory', {
      code: 'INVALID_SPOOL_DIR',
    })
  }
  if (!path.isAbsolute(spoolDir)) {
    throw new ClaudeSettingsError(
      `spoolDir must be an absolute path, got '${spoolDir}'`,
      { code: 'INVALID_SPOOL_DIR' }
    )
  }
}

/** @param {unknown} stateFile */
function validateStateFile(stateFile) {
  if (typeof stateFile !== 'string' || stateFile.length === 0) {
    throw new ClaudeSettingsError('stateFile must be a non-empty path', {
      code: 'INVALID_STATE_FILE',
    })
  }
  if (!path.isAbsolute(stateFile)) {
    throw new ClaudeSettingsError(
      `stateFile must be an absolute path, got '${stateFile}'`,
      { code: 'INVALID_STATE_FILE' }
    )
  }
}

/** @param {unknown} err */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}
