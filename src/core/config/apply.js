// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { atomicWriteJsonSync } from '../util/fs_atomic.js'
import { parseConfigShape } from './schema.js'

/**
 * @import { ConfigApplyErrorKind, ConfigControlFacade, ConfigStageResult, HypAwareV2Config, PluginConfigInstance } from '../../../hypaware-plugin-kernel-types.js'
 * @import {
 *   ConfigApplyDeps,
 *   ConfigControl,
 *   ConfigControlState,
 *   ConfigControlStatus,
 *   ConfigRollbackReason,
 *   ConfigSlot,
 *   CreateConfigControlOptions,
 *   ProbationMarker,
 * } from '../../../src/core/config/types.js'
 */

/**
 * Maximum accepted config document size in bytes. A pulled 200 body is
 * parsed and persisted wholesale, so a stated cap bounds memory and
 * disk regardless of what an authenticated server sends. 1 MiB is
 * orders of magnitude above any real config.
 * @ref LLP 0025#config-pull-loop [implements]: max accepted config document size, settled at 1 MiB
 */
export const MAX_CONFIG_DOCUMENT_BYTES = 1024 * 1024

/**
 * Default config pull cadence (seconds) when the staged document's
 * central sink does not set `poll_interval_seconds`. Mirrors the
 * central plugin's own default: the kernel needs the value to size
 * the probation window without asking the plugin.
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 300

/**
 * Probation window floor (seconds). The window is
 * `max(3 × poll_interval_seconds, floor)` so a fast poll cadence still
 * leaves room for daemon relaunch + identity refresh + one retry.
 * @ref LLP 0025#post-apply-probation [implements]: window formula with the floor settled at 120s
 */
export const PROBATION_FLOOR_SECONDS = 120

const CONTROL_DIRNAME = 'config-control'
const STATE_BASENAME = 'state.json'

/**
 * The active-slot pointer. A relative symlink under `config-control/`
 * pointing at the live `config.{a,b}.json` slot. Relocated here (off the
 * user-facing `hypaware-config.json` path) so the local layer can be a
 * plain user file: the atomic symlink-flip crash-safety is preserved.
 * @ref LLP 0031#physical-layout [constrained-by]: active-slot pointer relocated into config-control/
 */
const ACTIVE_BASENAME = 'active'

/**
 * The join seed: the initial central layer, written by `hyp join` (mode
 * 0600: it holds the policy token). Read once on the first apply to
 * preserve it as the rollback target, then retired.
 * @ref LLP 0031#physical-layout [implements]: dedicated central-seed file, not hypaware-config.json
 */
const SEED_BASENAME = 'seed.json'

/**
 * Path to the join seed (the initial central layer) under a host's
 * state root. `hyp join` writes here; the apply engine retires it after
 * the first successful apply.
 *
 * @param {string} stateRoot
 * @returns {string}
 */
export function centralSeedPath(stateRoot) {
  return path.join(stateRoot, CONTROL_DIRNAME, SEED_BASENAME)
}

/**
 * Resolve the central layer's source file for boot, read-only: the
 * active applied slot if the pointer is set, **else** the join seed,
 * **else** null (a host that never joined). Reading is safe in any boot
 * (CLI or daemon): only the daemon's apply engine ever *writes* here.
 *
 * @param {{ stateRoot: string }} args
 * @returns {string | null}
 * @ref LLP 0031#physical-layout [implements]: central = active slot else seed else none
 */
export function resolveCentralLayerPath({ stateRoot }) {
  const controlDir = path.join(stateRoot, CONTROL_DIRNAME)
  const slot = readActiveSlot(controlDir)
  if (slot) return path.join(controlDir, `config.${slot}.json`)
  const seed = path.join(controlDir, SEED_BASENAME)
  if (fs.existsSync(seed)) return seed
  return null
}

/**
 * Reset the central layer to **seed-config mode**: remove the active-slot
 * pointer, both A/B slot files and their etag sidecars, and the
 * apply-engine state (probation / bad-etag / last-rollback). Best-effort
 * and ENOENT-tolerant, so on a never-joined or first-join host (no
 * pointer, no slots) it is a no-op.
 *
 * `hyp join` calls this right after writing a fresh seed. A re-enrollment
 * - the operator re-runs `join` because identity broke - writes a new
 * bootstrap token into the seed, but a prior enrollment may have left a
 * stale active slot whose `identity` carries no token. Boot resolution
 * prefers the active slot over the seed ({@link resolveCentralLayerPath}),
 * so without this reset the fresh token is silently shadowed and identity
 * bootstrap keeps failing (#139). Clearing the slot returns the host to
 * genuine seed-config mode, so a re-join behaves exactly like a first
 * join: boot reads the seed, bootstraps identity from its token, pulls the
 * central config, and the apply engine recreates the slots (`commit`'s
 * `activeSlot() === null` first-apply path) and retires the seed.
 *
 * @param {string} stateRoot
 * @returns {{ supersededActiveSlot: boolean }} whether a stale active slot was cleared
 * @ref LLP 0031#physical-layout [implements]: re-join resets to seed mode so a stale active slot never shadows the fresh seed token
 */
export function resetCentralLayerToSeed(stateRoot) {
  const controlDir = path.join(stateRoot, CONTROL_DIRNAME)
  const supersededActiveSlot = readActiveSlot(controlDir) !== null
  for (const name of [
    ACTIVE_BASENAME,
    STATE_BASENAME,
    'config.a.json',
    'config.b.json',
    'config.a.etag',
    'config.b.etag',
  ]) {
    fs.rmSync(path.join(controlDir, name), { force: true })
  }
  return { supersededActiveSlot }
}

/**
 * Build the kernel config apply engine: shape-check → install pinned
 * plugins → validate against the post-install catalog → persist to an
 * A/B slot → flip the operative pointer → staged restart, plus
 * probation and last-known-good rollback.
 *
 * Persistence idiom: each applied config is written to its own slot
 * file under `<stateRoot>/config-control/`, with the served ETag in a
 * per-slot sidecar written *before* the flip. The operative config
 * path becomes a symlink to the active slot, replaced atomically via
 * tmp+rename: so the config document and its etag transition together
 * in both directions (apply and rollback), and last-known-good is
 * crash-safe by construction (the previous slot is never modified).
 *
 * @param {CreateConfigControlOptions} opts
 * @returns {ConfigControl}
 * @ref LLP 0025#apply-engine-is-kernel-surface [implements]: the engine is kernel-owned; plugins only see the narrow facade
 */
export function createConfigControl(opts) {
  const { stateRoot, requestRestart, onConfirmed } = opts
  const now = opts.now ?? Date.now
  const log = getLogger('config-control')
  const controlDir = path.join(stateRoot, CONTROL_DIRNAME)
  const statePath = path.join(controlDir, STATE_BASENAME)
  const activePath = path.join(controlDir, ACTIVE_BASENAME)
  const seedPath = path.join(controlDir, SEED_BASENAME)

  /** @type {ConfigApplyDeps | null} */
  let applyDeps = null
  /** @type {NodeJS.Timeout | null} */
  let watchdog = null
  let restartPending = false

  /** @returns {ConfigControlState} */
  function readState() {
    return readControlState(statePath)
  }

  /** @param {ConfigControlState} state */
  function writeState(state) {
    atomicWriteJsonSync(statePath, state, { mode: 0o600, dirMode: 0o700 })
  }

  /** @param {ConfigSlot} slot */
  function slotPath(slot) {
    return path.join(controlDir, `config.${slot}.json`)
  }

  /** @param {ConfigSlot} slot */
  function slotEtagPath(slot) {
    return path.join(controlDir, `config.${slot}.etag`)
  }

  /** @returns {ConfigSlot | null} */
  function activeSlot() {
    return readActiveSlot(controlDir)
  }

  /**
   * Atomically point the active-slot pointer at `slot`. A relative
   * symlink is created at a tmp path and renamed over the pointer, so a
   * crash leaves either the old or the new pointer: never neither. The
   * pointer lives inside `config-control/` (not at the user-facing
   * config path), so the local layer is never a symlink.
   *
   * @param {ConfigSlot} slot
   * @ref LLP 0031#physical-layout [constrained-by]: pointer relocated into config-control/, atomic flip preserved
   */
  function flipPointer(slot) {
    const tmp = `${activePath}.tmp.${process.pid}.${now()}`
    fs.symlinkSync(`config.${slot}.json`, tmp)
    fs.renameSync(tmp, activePath)
  }

  /** @returns {string | undefined} */
  function runningEtag() {
    return readRunningEtag(controlDir)
  }

  /**
   * Revert to the previous operative config: flip the pointer back
   * (the per-slot etag sidecar reverts with it), clear probation,
   * remember the bad etag, and record the structured rollback reason.
   *
   * A rollback needs a **distinct** slot to land on. With no distinct
   * `previous_slot` the only "rollback" available is a no-op flip that
   * leaves the failed config operative, and recording its etag as
   * `bad_etag` while it stays active wedges central: the bad-etag backoff
   * then refuses to re-apply the very revision that is running, probation
   * bookkeeping never clears, and a boot does not recover (#141). Refuse
   * to manufacture that contradiction: clear probation, surface a clear
   * error, and leave recovery to boot's consistency guard / the next
   * pull. Returns whether the pointer was actually flipped, so callers
   * don't request a staged restart onto the unchanged config (an
   * infinite restart loop).
   *
   * @param {ProbationMarker} marker
   * @param {ConfigRollbackReason} reason
   * @param {string} [detail]
   * @returns {boolean} whether the pointer was flipped to a distinct slot
   * @ref LLP 0025#last-known-good-rollback [implements]: flip back + remembered bad etag + structured reason; a bad_etag is never recorded for the still-active slot (#141)
   */
  function rollback(marker, reason, detail) {
    const at = new Date(now()).toISOString()
    if (!marker.previous_slot || marker.previous_slot === marker.slot) {
      const state = readState()
      delete state.probation
      writeState(state)
      log.error('config.rollback_no_target', {
        [Attr.COMPONENT]: 'config-control',
        [Attr.OPERATION]: 'config.rollback',
        [Attr.ERROR_KIND]: reason,
        config_etag: marker.etag,
        status: 'failed',
        hyp_reason: 'no_distinct_previous_slot',
        ...(detail ? { detail } : {}),
      })
      return false
    }
    flipPointer(marker.previous_slot)
    const state = readState()
    delete state.probation
    state.bad_etag = { etag: marker.etag, reason, recorded_at: at }
    state.last_rollback = {
      etag: marker.etag,
      reason,
      at,
      ...(detail ? { detail } : {}),
    }
    writeState(state)
    log.warn('config.rollback', {
      [Attr.COMPONENT]: 'config-control',
      [Attr.OPERATION]: 'config.rollback',
      [Attr.ERROR_KIND]: reason,
      config_etag: marker.etag,
      rolled_back_to_slot: marker.previous_slot,
      ...(detail ? { detail } : {}),
      status: 'ok',
    })
    return true
  }

  /**
   * Boot consistency guard (#141). The active slot's etag must never
   * equal a remembered `bad_etag`: that contradiction: a config marked
   * bad yet still operative: wedges central, because the bad-etag
   * backoff then refuses to re-apply the running revision and no boot
   * recovers. It is produced by a no-op rollback that had no distinct
   * slot to flip to (the rollback guard above now prevents new ones, but
   * existing wedged hosts and hand-edited state must still recover).
   * Recover by falling back to the join seed if one survives, else
   * dropping the contradictory `bad_etag` so the next poll can re-pull -
   * the operative config keeps running either way.
   *
   * @param {ConfigControlState} state
   * @returns {{ action: 'recovered_bad_active', recovery: 'seed' | 'repull' } | null}
   * @ref LLP 0025#last-known-good-rollback [constrained-by]: the active slot may never carry a bad_etag; recover instead of persisting the contradiction (#141)
   */
  function recoverBadActiveEtag(state) {
    if (!state.bad_etag) return null
    const activeEtag = runningEtag()
    if (!activeEtag || activeEtag !== state.bad_etag.etag) return null

    let seedRaw = null
    try {
      seedRaw = fs.readFileSync(seedPath, 'utf8')
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
    }

    delete state.bad_etag
    delete state.probation

    if (seedRaw !== null) {
      // Drop the active pointer so boot resolves the central layer from
      // the surviving seed (a legitimate polling steady state).
      fs.rmSync(activePath, { force: true })
      writeState(state)
      log.error('config.bad_etag_active_recovered', {
        [Attr.COMPONENT]: 'config-control',
        [Attr.OPERATION]: 'config.bad_etag_active_recovered',
        config_etag: activeEtag,
        status: 'ok',
        hyp_reason: 'fell_back_to_seed',
      })
      return { action: /** @type {const} */ ('recovered_bad_active'), recovery: /** @type {const} */ ('seed') }
    }

    // No seed to fall back to: the operative config is all the gateway
    // has, so keep it running but drop the contradictory backoff so the
    // next pull can re-validate / converge instead of staying wedged.
    writeState(state)
    log.error('config.bad_etag_active_recovered', {
      [Attr.COMPONENT]: 'config-control',
      [Attr.OPERATION]: 'config.bad_etag_active_recovered',
      config_etag: activeEtag,
      status: 'ok',
      hyp_reason: 'cleared_for_repull',
    })
    return { action: /** @type {const} */ ('recovered_bad_active'), recovery: /** @type {const} */ ('repull') }
  }

  function disarmProbationWatchdog() {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
  }

  /**
   * Arm the in-process probation timer for the active marker, if any.
   * Expiry rolls back and requests a staged restart onto
   * last-known-good. The kernel owns this timer: a wedged central
   * sink is exactly the failure probation must catch.
   * @ref LLP 0025#post-apply-probation [implements]: kernel-owned watchdog, independent of the central plugin functioning
   */
  function armProbationWatchdog() {
    disarmProbationWatchdog()
    const state = readState()
    const marker = state.probation
    if (!marker) return
    const remainingMs = Math.max(0, Date.parse(marker.until) - now())
    watchdog = setTimeout(() => {
      watchdog = null
      const current = readState().probation
      if (!current || current.etag !== marker.etag) return
      log.error('config.probation_expired', {
        [Attr.COMPONENT]: 'config-control',
        [Attr.OPERATION]: 'config.probation_expired',
        config_etag: marker.etag,
        status: 'failed',
      })
      // Only restart when there was somewhere distinct to roll back to;
      // a no-op rollback leaves the same config active, so restarting
      // onto it would just re-probate and re-fail forever (#141).
      const rolledBack = rollback(current, 'probation_expired')
      if (rolledBack) {
        restartPending = true
        requestRestart('probation_expired')
      }
    }, remainingMs)
    if (typeof watchdog.unref === 'function') watchdog.unref()
  }

  /**
   * Boot-time probation evaluation, run before plugin activation: a
   * kernel-killing-but-valid config can crashloop under the service
   * manager faster than any in-process timer fires, so each relaunch
   * checks the marker first.
   * @ref LLP 0025#post-apply-probation [implements]: probation expiry is evaluated at boot, before plugin activation
   */
  async function evaluateAtBoot() {
    const state = readState()

    // Consistency guard first (#141): recover before anything else if the
    // active slot's etag is already marked bad. This case can carry no
    // live probation marker (the wedge clears probation), so it must run
    // independently of the marker handling below.
    const recovered = recoverBadActiveEtag(state)
    if (recovered) return recovered

    const marker = state.probation
    if (!marker) return { action: /** @type {const} */ ('none') }

    // A marker whose slot is not the operative pointer means the apply
    // crashed between persisting the marker and flipping: the new
    // config never took effect, so there is nothing to probe.
    if (activeSlot() !== marker.slot) {
      delete state.probation
      writeState(state)
      log.warn('config.probation_orphaned', {
        [Attr.COMPONENT]: 'config-control',
        [Attr.OPERATION]: 'config.probation_orphaned',
        config_etag: marker.etag,
        status: 'ok',
      })
      return { action: /** @type {const} */ ('cleared_orphan') }
    }

    if (Date.parse(marker.until) <= now()) {
      const rolledBack = rollback(marker, 'probation_expired')
      return rolledBack
        ? { action: /** @type {const} */ ('rolled_back') }
        : { action: /** @type {const} */ ('rollback_no_target') }
    }
    return { action: /** @type {const} */ ('none') }
  }

  // Confirmation edge: clear the post-apply probation marker on the first
  // authenticated poll, then fire `onConfirmed` *only* when a marker was
  // actually cleared: the active→cleared transition, not every poll. The
  // early `!state.probation` return makes this exactly the edge, so the
  // daemon can schedule one reconcile pass per confirmation without polling
  // status each tick. apply.js stays ignorant of the reconciler.
  // @ref LLP 0041#when-the-reconciler-runs-lifecycle-integration [implements]: onConfirmed fires once on the probation active→cleared edge so the daemon schedules a reconcile pass without per-tick status polling
  function confirmPoll() {
    const state = readState()
    if (!state.probation) return
    const etag = state.probation.etag
    delete state.probation
    writeState(state)
    disarmProbationWatchdog()
    log.info('config.probation_cleared', {
      [Attr.COMPONENT]: 'config-control',
      [Attr.OPERATION]: 'config.probation_cleared',
      config_etag: etag,
      status: 'ok',
    })
    if (onConfirmed) onConfirmed(etag)
  }

  /**
   * @param {unknown} document
   * @param {string} etag
   * @returns {Promise<ConfigStageResult>}
   */
  async function stage(document, etag) {
    return withSpan(
      'config.apply',
      {
        [Attr.COMPONENT]: 'config-control',
        [Attr.OPERATION]: 'config.apply',
        config_etag: etag,
        status: 'ok',
      },
      async (span) => {
        /** @param {ConfigApplyErrorKind} errorKind @param {string} message */
        function fail(errorKind, message) {
          span.setAttribute('status', 'failed')
          span.setAttribute('error_kind', errorKind)
          log.error('config.apply_failed', {
            [Attr.COMPONENT]: 'config-control',
            [Attr.ERROR_KIND]: errorKind,
            config_etag: etag,
            message,
          })
          return /** @type {ConfigStageResult} */ ({ ok: false, errorKind, message })
        }

        if (restartPending) {
          return fail('restart_pending', 'a staged restart is already pending')
        }
        if (!applyDeps) {
          return fail('apply_engine_not_ready', 'apply engine has no validator/installer attached')
        }
        if (typeof etag !== 'string' || etag.length === 0) {
          return fail('config_invalid', 'stage() requires the served etag')
        }
        if (etag === runningEtag()) {
          span.setAttribute('apply_action', 'noop_same_etag')
          return { ok: true, action: 'noop_same_etag' }
        }

        const state = readState()
        // Re-apply backoff: one remembered bad etag, skipped until the
        // server serves a different revision. Re-polling is fine; an
        // apply-crash loop is not.
        if (state.bad_etag && state.bad_etag.etag === etag) {
          span.setAttribute('apply_action', 'skipped_bad_etag')
          log.warn('config.apply_skipped', {
            [Attr.COMPONENT]: 'config-control',
            config_etag: etag,
            hyp_reason: 'bad_etag_backoff',
          })
          return { ok: true, action: 'skipped_bad_etag' }
        }

        const serialized = JSON.stringify(document, null, 2) + '\n'
        if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_DOCUMENT_BYTES) {
          return fail('document_too_large', `config document exceeds ${MAX_CONFIG_DOCUMENT_BYTES} bytes`)
        }

        // Shape-gate, then install, then full validation. Catalog-backed
        // validation can only know a plugin once it is installed, so a
        // served config naming a not-yet-installed plugin must install
        // first: but install must not act on an arbitrary document, so
        // the shape (including the pin fields' types) is checked before
        // anything is fetched, and the hash pin bounds what an install
        // can bring in.
        // @ref LLP 0025#install-on-config-hash-pinned [implements]: shape-gate → install pinned plugins → validate against the post-install catalog
        const shape = parseConfigShape(document)
        if (!shape.ok) {
          const first = shape.errors[0]
          rememberBadEtag(etag, 'validation_failed')
          return fail(
            'config_invalid',
            first ? `${first.pointer || '<root>'}: ${first.message}` : 'config shape invalid'
          )
        }
        const config = shape.config

        const install = await applyDeps.installPinnedPlugins(config.plugins ?? [])
        if (!install.ok) {
          rememberBadEtag(
            etag,
            install.errorKind === 'artifact_hash_mismatch'
              ? 'artifact_hash_mismatch'
              : install.errorKind === 'bundled_version_mismatch'
                ? 'bundled_version_mismatch'
                : 'plugin_install_failed'
          )
          return fail(install.errorKind, install.message)
        }

        const validation = await applyDeps.validateDocument(document)
        if (!validation.ok) {
          const first = validation.errors[0]
          rememberBadEtag(etag, 'validation_failed')
          return fail(
            'config_invalid',
            first ? `${first.pointer || '<root>'}: ${first.message}` : 'config validation failed'
          )
        }

        try {
          commit(config, serialized, etag)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return fail('apply_io_error', message)
        }

        span.setAttribute('apply_action', 'applied')
        log.info('config.applied', {
          [Attr.COMPONENT]: 'config-control',
          [Attr.OPERATION]: 'config.apply',
          config_etag: etag,
          status: 'ok',
        })
        restartPending = true
        requestRestart('config_applied')
        return /** @type {ConfigStageResult} */ ({ ok: true, action: 'applied' })
      },
      { component: 'config-control' }
    )
  }

  /**
   * Remember a rejected revision so re-polls don't become an
   * apply-fail loop. Pre-flip failures (validation, install) record
   * only the bad etag + reason; `last_rollback` is reserved for actual
   * reverts of an applied config.
   *
   * @param {string} etag
   * @param {ConfigRollbackReason} reason
   */
  function rememberBadEtag(etag, reason) {
    const state = readState()
    state.bad_etag = { etag, reason, recorded_at: new Date(now()).toISOString() }
    writeState(state)
  }

  /**
   * Persist `serialized` to the inactive slot, write its etag sidecar
   * and the probation marker, then flip the pointer as the last step.
   * Ordering is the crash-safety argument: everything before the flip
   * is invisible to boot; the flip itself is atomic; the marker's
   * `slot` field lets `evaluateAtBoot` discard a marker whose flip
   * never happened.
   *
   * @param {HypAwareV2Config} config
   * @param {string} serialized
   * @param {string} etag
   * @ref LLP 0025#apply-semantics-staged-restart [implements]: A/B slots with an atomic pointer; never live-mutate; restart does the activation
   */
  function commit(config, serialized, etag) {
    fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 })
    const current = activeSlot()

    /** @type {ConfigSlot | null} */
    let previousSlot = current
    let firstApplyOverSeed = false
    if (current === null) {
      // First apply with no active slot yet: preserve the join seed's
      // bytes in slot 'a' so rollback lands back on it. Seed-config mode
      // is a legitimate steady state, so this is a safe rollback target
      // by construction.
      let seedRaw = null
      try {
        seedRaw = fs.readFileSync(seedPath, 'utf8')
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
      }
      if (seedRaw !== null) {
        fs.writeFileSync(slotPath('a'), seedRaw, { mode: 0o600 })
        fs.rmSync(slotEtagPath('a'), { force: true })
        previousSlot = 'a'
        firstApplyOverSeed = true
      }
    }

    /** @type {ConfigSlot} */
    const target = previousSlot === 'b' ? 'a' : 'b'
    fs.writeFileSync(slotPath(target), serialized, { mode: 0o600 })
    fs.writeFileSync(slotEtagPath(target), etag + '\n', { mode: 0o600 })

    const pollSeconds = pollIntervalFromConfig(config)
    const windowSeconds = Math.max(3 * pollSeconds, PROBATION_FLOOR_SECONDS)
    const state = readState()
    state.probation = {
      etag,
      applied_at: new Date(now()).toISOString(),
      until: new Date(now() + windowSeconds * 1000).toISOString(),
      slot: target,
      previous_slot: previousSlot,
    }
    writeState(state)

    flipPointer(target)

    // First successful apply retires the seed file: its bytes survive
    // in slot 'a' as the rollback target, and the policy token it
    // carried no longer needs to sit on disk (identity.json carries the
    // JWT from here on).
    // @ref LLP 0031#physical-layout [implements]: seed retired after first successful apply
    if (firstApplyOverSeed) {
      fs.rmSync(seedPath, { force: true })
    }
  }

  /** @returns {Promise<ConfigControlStatus>} */
  async function status() {
    return readConfigControlStatus({ stateRoot })
  }

  return {
    stage,
    confirmPoll,
    runningEtag,
    evaluateAtBoot,
    attachApplyDeps(deps) { applyDeps = deps },
    armProbationWatchdog,
    disarmProbationWatchdog,
    status,
  }
}

/* ---------- shared read-only helpers ---------- */

/**
 * @param {string} statePath
 * @returns {ConfigControlState}
 */
function readControlState(statePath) {
  let raw
  try {
    raw = fs.readFileSync(statePath, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return {}
    throw err
  }
  const parsed = JSON.parse(raw)
  return parsed && typeof parsed === 'object' ? parsed : {}
}

/**
 * Which slot the active-slot pointer (`config-control/active`) points
 * at, or null when no apply has flipped it yet (seed-config mode) or it
 * is missing.
 *
 * @param {string} controlDir
 * @returns {ConfigSlot | null}
 */
function readActiveSlot(controlDir) {
  const activePath = path.join(controlDir, ACTIVE_BASENAME)
  let target
  try {
    target = fs.readlinkSync(activePath)
  } catch {
    return null
  }
  const resolved = path.resolve(controlDir, target)
  if (resolved === path.join(controlDir, 'config.a.json')) return 'a'
  if (resolved === path.join(controlDir, 'config.b.json')) return 'b'
  return null
}

/**
 * @param {string} controlDir
 * @returns {string | undefined}
 */
function readRunningEtag(controlDir) {
  const slot = readActiveSlot(controlDir)
  if (!slot) return undefined
  try {
    const etag = fs.readFileSync(path.join(controlDir, `config.${slot}.etag`), 'utf8').trim()
    return etag.length > 0 ? etag : undefined
  } catch {
    return undefined
  }
}

/**
 * Read-only view of the apply engine's state for `hypaware status`:
 * usable from any process (the CLI is not the daemon), so it never
 * constructs the engine or takes its hooks.
 *
 * @param {{ stateRoot: string }} args
 * @returns {ConfigControlStatus}
 * @ref LLP 0025#last-known-good-rollback [implements]: operator-visible probation/rollback/bad-etag state without log spelunking
 */
export function readConfigControlStatus({ stateRoot }) {
  const controlDir = path.join(stateRoot, CONTROL_DIRNAME)
  /** @type {ConfigControlState} */
  let state = {}
  try {
    state = readControlState(path.join(controlDir, STATE_BASENAME))
  } catch {
    // unreadable state surfaces as empty: status is best-effort
  }
  return {
    probation: state.probation ?? null,
    lastRollback: state.last_rollback ?? null,
    badEtag: state.bad_etag ?? null,
    runningEtag: readRunningEtag(controlDir) ?? null,
  }
}

/**
 * Extract the config pull cadence from the staged document's central
 * sink block to size the probation window. The window must track the
 * *new* config's cadence: that is the sink that will (or won't)
 * confirm the poll. Knowing the first-party plugin name here mirrors
 * the client-descriptor precedent in `plugin_catalog.js`.
 *
 * @param {HypAwareV2Config} config
 * @returns {number}
 */
function pollIntervalFromConfig(config) {
  let min = Infinity
  for (const sink of Object.values(config.sinks ?? {})) {
    if (!('plugin' in sink) || sink.plugin !== '@hypaware/central') continue
    const v = sink.config?.poll_interval_seconds
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      min = Math.min(min, v)
    } else {
      min = Math.min(min, DEFAULT_POLL_INTERVAL_SECONDS)
    }
  }
  return Number.isFinite(min) ? min : DEFAULT_POLL_INTERVAL_SECONDS
}
