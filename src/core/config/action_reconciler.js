// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { Attr, getLogger } from '../observability/index.js'
import { atomicWriteJsonSync } from '../util/fs_atomic.js'

/**
 * @import {
 *   ActionContext,
 *   ActionHandler,
 *   ActionMarker,
 *   ActionMarkerStore,
 *   ActionOutcome,
 *   ActionReconciler,
 *   ClientActionStatus,
 *   CreateActionReconcilerOptions,
 *   DesiredAction,
 *   ReconcileActionResult,
 *   ReconcileInput,
 *   ReconcileReport,
 * } from '../../../src/core/config/types.js'
 */

/**
 * The kernel state subdirectory the reconciler shares with the apply
 * engine. Must match `CONTROL_DIRNAME` in `apply.js`: the marker is kernel
 * surface and belongs beside `state.json`, not in a plugin state dir
 * (LLP 0041: "the action marker belongs here too, not in a plugin state
 * dir, the reconciler is kernel surface").
 */
const CONTROL_DIRNAME = 'config-control'

/**
 * The action-marker file. Namespaced per handler kind and keyed by request
 * key; written atomically (tmp+rename, mode 0600) exactly like `state.json`.
 * @ref LLP 0041#idempotency-and-completion-state [implements]: marker file config-control/client-actions.json, atomic tmp+rename, namespaced per handler kind
 */
const CLIENT_ACTIONS_BASENAME = 'client-actions.json'

/**
 * Build the generic, daemon-constructed action reconciler. It is the
 * run-once / reconcile-on-config machinery and knows nothing about Claude
 * vs Codex: only the {@link ActionHandler} interface. The daemon wires
 * its `reconcile()` to the config-confirmation edge and the
 * after-activation already-confirmed pass.
 *
 * @param {CreateActionReconcilerOptions} opts
 * @returns {ActionReconciler}
 * @ref LLP 0041#the-reconciler-component [implements]: createActionReconciler(opts) → { reconcile, readStatus }, constructed by the daemon like createConfigControl
 * @ref LLP 0036: central-config-driven client action seam (the decision this realizes)
 */
export function createActionReconciler(opts) {
  const { stateRoot, handlers } = opts
  const now = opts.now ?? Date.now
  const log = opts.log ?? getLogger('action-reconciler')
  const controlDir = path.join(stateRoot, CONTROL_DIRNAME)
  const markerPath = path.join(controlDir, CLIENT_ACTIONS_BASENAME)

  /** @returns {ActionMarkerStore} */
  function readStore() {
    return readMarkerStore(markerPath)
  }

  /** @param {ActionMarkerStore} store */
  function writeStore(store) {
    atomicWriteJsonSync(markerPath, store, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Level-triggered reconcile (LLP 0036): for each handler, diff `desired()`
   * against the persisted markers and act only on the gap. A `done` marker
   * short-circuits (and a `refused` one unconditionally, LLP 0186), so the pass
   * is safe to call repeatedly and a run missed while probation was outstanding
   * is recovered on the next call.
   *
   * @param {ReconcileInput} input
   * @returns {Promise<ReconcileReport>}
   * @ref LLP 0041#the-reconciler-component [implements]: reconcile() is level-triggered: diff desired() against the marker, act only on the gap; a done marker short-circuits
   */
  async function reconcile(input) {
    // Thread the daemon-resolved client seam (LLP 0045 §Part 1) onto the
    // context unchanged: the reconciler core stays ignorant of what they mean
    // ("knows nothing about Claude vs Codex"); only a client handler
    // (`action_attach`) reads `clientDescriptors`/`clients`/`endpoint`. Absent
    // on a plain CLI boot, so any client handler stays inert.
    // @ref LLP 0045#part-1-the-client-seam-in-the-reconcile-context [implements]: clientDescriptors/clients/endpoint live on the context, not a handler closure
    /** @type {ActionContext} */
    const ctx = {
      config: input.config,
      backfills: input.backfills,
      env: input.env,
      clientDescriptors: input.clientDescriptors,
      clients: input.clients,
      endpoint: input.endpoint,
      skills: input.skills,
      agents: input.agents,
      failedPlugins: input.failedPlugins,
      now,
      log,
    }
    const store = readStore()
    /** @type {ReconcileActionResult[]} */
    const results = []
    let mutated = false

    for (const handler of handlers) {
      const kind = handler.kind
      const markers = store[kind] ?? {}

      /** @type {DesiredAction[]} */
      let desired
      try {
        desired = handler.desired(ctx) ?? []
      } catch (err) {
        // A handler whose detect step throws must not wedge the others.
        log.error('client_action.desired_failed', {
          [Attr.COMPONENT]: 'action-reconciler',
          [Attr.OPERATION]: 'client_action.desired',
          kind,
          [Attr.STATUS]: 'failed',
          [Attr.ERROR_KIND]: 'handler_desired_threw',
          detail: err instanceof Error ? err.message : String(err),
        })
        continue
      }

      const desiredKeys = new Set(desired.map((d) => d.requestKey))

      // Forward gap: run-once / retry the desired units not yet `done`. A
      // `done` marker short-circuits, UNLESS the handler's optional freshness
      // predicate reports it stale, then the still-desired unit is a forward
      // gap and re-`perform()`s this pass. That is how an attach re-fires after
      // the gateway rebinds to a new ephemeral port: the marker is `done` but no
      // longer current (issue #277 / LLP 0086). Handlers without `isCurrent`
      // (backfill) keep the pure level-triggered short-circuit.
      // @ref LLP 0086#re-attach-on-drift [implements]: a done marker the handler reports stale is a forward gap, not a permanent skip
      for (const action of desired) {
        const existing = markers[action.requestKey]
        // A `refused` marker skips FIRST and unconditionally: it records a
        // precondition only the user can fix (a conflicting provider entry, a
        // JSONC settings file), so re-`perform()`ing it every pass is the
        // forever-retry LLP 0184 reports. `markerIsCurrent()` is deliberately
        // not consulted here - the freshness hook answers "did the input
        // drift?", which says nothing about whether the refusal was resolved.
        // Only an explicit `hyp attach` re-run (which clears the marker) re-arms
        // it in this pass; the `isCurrent`-style auto re-arm is a named
        // follow-up, not built.
        // @ref LLP 0186#how-the-reconciler-distinguishes-it-from-done [implements]: refused short-circuits unconditionally, done short-circuits through markerIsCurrent()
        if (existing && existing.status === 'refused') {
          results.push({ kind, requestKey: action.requestKey, outcome: 'skipped' })
          continue
        }
        if (existing && existing.status === 'done' && markerIsCurrent(handler, existing, action, ctx)) {
          results.push({ kind, requestKey: action.requestKey, outcome: 'skipped' })
          continue
        }

        const outcome = await runOutcome(() => handler.perform(action, ctx))
        const at = new Date(now()).toISOString()
        if (outcome.status === 'done') {
          /** @type {ActionMarker} */
          const marker = {
            status: 'done',
            request_key: action.requestKey,
            at,
            ...(typeof outcome.rows === 'number' ? { rows: outcome.rows } : {}),
            ...(outcome.detail ?? {}),
          }
          // Union the undo record across the rewrite, the same carry-forward
          // the `failed` path below makes. A re-`perform()` reports what *that*
          // pass applied, not everything the key has ever applied, and the two
          // differ the moment the desired set shrinks: an attach re-fired
          // because the org withdrew a plugin copies only what is left, while
          // the withdrawn plugin's files are still on disk. Taking the report
          // as the whole truth would drop them from the only record naming
          // them, and no later reversal could remove them. Re-recording a path
          // already gone is harmless: removal re-checks containment and rm is
          // forced.
          // @ref LLP 0138#marker-undo [implements]: the record of an applied
          //   effect outlives any rewrite of the marker carrying it
          const carried = readInstalledAssets(existing)
          if (carried.length > 0) {
            marker.installed_assets = [...new Set([...carried, ...readInstalledAssets(marker)])]
          }
          markers[action.requestKey] = marker
          results.push({
            kind,
            requestKey: action.requestKey,
            outcome: 'done',
            ...(typeof outcome.rows === 'number' ? { rows: outcome.rows } : {}),
          })
          log.info('client_action.done', {
            [Attr.COMPONENT]: 'action-reconciler',
            [Attr.OPERATION]: 'client_action.perform',
            kind,
            request_key: action.requestKey,
            [Attr.STATUS]: 'ok',
            ...(typeof outcome.rows === 'number' ? { rows: outcome.rows } : {}),
          })
        } else if (outcome.status === 'refused') {
          // A refusal is terminal, so the marker records no `attempts`: nothing
          // will ever increment one. `at` carries the terminal-state time the
          // way `done` uses it, `reason` the way `failed` uses it, and the
          // absence of a retry counter is itself part of the fix - a refused
          // marker that grew `attempts: 17` is exactly the field bug this
          // branch exists to stop (LLP 0184).
          // @ref LLP 0186#writing-it [implements]: third outcome branch, terminal refused marker (at + reason, no attempts), logged as loudly as a failure
          const reason = outcome.reason ?? 'unknown'
          /** @type {ActionMarker} */
          const marker = {
            status: 'refused',
            request_key: action.requestKey,
            reason,
            at,
            ...(outcome.detail ?? {}),
          }
          // Same carry-forward the `done` and `failed` branches make: a refusal
          // on a re-`perform()` does not un-install what an earlier successful
          // attach copied, and the marker is the only record naming those files
          // (LLP 0138 #marker-undo). Dropping it here would orphan them past
          // any later reversal.
          const carried = readInstalledAssets(existing)
          if (carried.length > 0) {
            marker.installed_assets = [...new Set([...carried, ...readInstalledAssets(marker)])]
          }
          // The other half of the same record. A settings-only attach copies no
          // files, so `installed_assets` says nothing about whether an effect
          // was applied; without this bit the rewrite would hand the reverse gap
          // a marker that looks exactly like a refusal that never touched the
          // disk, and the settings write would be dropped along with it. Set
          // after the detail spread so a handler's `detail` cannot erase
          // reconciler bookkeeping about an effect that is really on disk.
          // @ref LLP 0250#the-bit [implements]: a terminal rewrite records the
          //   effect it overwrites, not only the assets it copied
          if (markerRecordsPriorDone(existing)) marker.prior_done = true
          markers[action.requestKey] = marker
          results.push({ kind, requestKey: action.requestKey, outcome: 'refused', reason })
          log.error('client_action.refused', {
            [Attr.COMPONENT]: 'action-reconciler',
            [Attr.OPERATION]: 'client_action.perform',
            kind,
            request_key: action.requestKey,
            [Attr.STATUS]: 'failed',
            [Attr.ERROR_KIND]: 'action_refused',
            detail: reason,
          })
        } else {
          // Not advanced to `done` on failure (LLP 0041 §failure is
          // surfaced, not fatal): record `failed` + bump attempts so the
          // next pass retries. Loud (its own status line) but not an outage.
          const attempts = (typeof existing?.attempts === 'number' ? existing.attempts : 0) + 1
          const reason = outcome.reason ?? 'unknown'
          /** @type {ActionMarker} */
          const marker = {
            status: 'failed',
            request_key: action.requestKey,
            reason,
            last_attempt: at,
            attempts,
            // Carry the undo record across the rewrite. `failed` here does not
            // mean "nothing was ever applied": a `done` attach the handler
            // reported stale re-`perform()`s, and a copy already on disk stays
            // there when that retry fails. Dropping `installed_assets` would
            // leave those files with nothing naming them, so a later reversal
            // could not remove them (LLP 0138 #marker-undo). A handler that
            // reports the field itself still wins, via the detail spread.
            ...(existing?.installed_assets ? { installed_assets: existing.installed_assets } : {}),
            ...(outcome.detail ?? {}),
          }
          // The settings half of that same record, for a client whose attach
          // copies no files: see the `refused` branch above.
          // @ref LLP 0250#the-bit [implements]: a terminal rewrite records the
          //   effect it overwrites, not only the assets it copied
          if (markerRecordsPriorDone(existing)) marker.prior_done = true
          markers[action.requestKey] = marker
          results.push({ kind, requestKey: action.requestKey, outcome: 'failed', reason, attempts })
          log.error('client_action.failed', {
            [Attr.COMPONENT]: 'action-reconciler',
            [Attr.OPERATION]: 'client_action.perform',
            kind,
            request_key: action.requestKey,
            [Attr.STATUS]: 'failed',
            [Attr.ERROR_KIND]: 'action_perform_failed',
            attempts,
            detail: reason,
          })
        }
        mutated = true
      }

      // Reverse gap: only reversible handlers undo a previously-applied key
      // the config no longer names (leave/detach). Run-once handlers
      // (backfill) omit reverse(): imported data stays, the marker is kept,
      // and this loop is skipped (LLP 0041 §Undo on leave).
      const reverse = handler.reverse
      if (typeof reverse === 'function') {
        for (const requestKey of Object.keys(markers)) {
          if (desiredKeys.has(requestKey)) continue
          const marker = markers[requestKey]
          // A failed marker for a no-longer-desired key is dropped rather than
          // reversed: it never applied an effect, and reversing one whose
          // handler keeps failing would retain it forever. Unless it recorded
          // one. An attach that went `done`, re-`perform()`ed unsuccessfully,
          // and carried `installed_assets` into its `failed` rewrite has copies
          // on disk that nothing else names, so dropping it here would orphan
          // them; that marker takes the normal reverse path below.
          //
          // Which does re-open the retained-forever case, in one shape: an
          // `attach` reverse fails deterministically when the descriptor is
          // gone or declares no `attachProbe` (#212), so such a marker now
          // retries and error-logs on every pass instead of being dropped
          // once. That is the lesser harm on purpose. A retained `failed`
          // marker is visible in `hyp status` and does not block a later
          // re-attach (#217 turns on a `done` one), whereas dropping it
          // destroys the only record of files that are really on disk. Only
          // the asset-removal half degrades to naming-and-releasing
          // (#refusal-is-not-failure); the settings half cannot, because
          // nothing else on disk would own the settings it left written.
          //
          // A `refused` marker is treated exactly like a `failed` one here: the
          // refusal itself wrote nothing (attach refuses *before* touching the
          // client's settings), so an assetless one for a key the config stops
          // naming is dropped rather than handed to a `reverse()` that has
          // nothing to undo, while one carrying `installed_assets` from an
          // earlier successful attach takes the reverse path below.
          //
          // `installed_assets` is not the whole evidence, though, and reading it
          // as if it were is what made this gate unsound for a settings-only
          // client. An attach that reached `done`, wrote the client's settings
          // and copied no files, then re-`perform()`ed into `failed`/`refused`,
          // has an assetless terminal marker over a settings write that is still
          // there. `prior_done` is what tells the two apart, so the drop needs
          // both halves to be empty (LLP 0250).
          // @ref LLP 0138#marker-undo [implements]: a marker is never dropped
          //   over an effect it recorded, whichever status it carries
          // @ref LLP 0186#how-the-reconciler-distinguishes-it-from-done [implements]: the reverse gap treats refused the way it treats failed
          // @ref LLP 0250#the-drop-condition [implements]: the drop reads the
          //   settings half of the record too, not just the asset half
          if (
            !marker ||
            ((marker.status === 'failed' || marker.status === 'refused') &&
              readInstalledAssets(marker).length === 0 &&
              !markerRecordsPriorDone(marker))
          ) {
            delete markers[requestKey]
            mutated = true
            continue
          }
          // Hand the marker to `reverse()`: it is the self-describing undo
          // record `perform()` wrote, and an effect that cannot be re-derived
          // from disk alone (which files an org-driven attach copied) is only
          // reversible from what the marker recorded (LLP 0045 §Part 3).
          const outcome = await runOutcome(() => reverse(requestKey, ctx, marker))
          if (outcome.status === 'done') {
            delete markers[requestKey]
            results.push({ kind, requestKey, outcome: 'reversed' })
            mutated = true
            log.info('client_action.reversed', {
              [Attr.COMPONENT]: 'action-reconciler',
              [Attr.OPERATION]: 'client_action.reverse',
              kind,
              request_key: requestKey,
              [Attr.STATUS]: 'ok',
            })
          } else {
            // Reverse failed: keep the marker so the next pass retries the
            // undo; surface but do not escalate.
            //
            // `refused` lands here too, deliberately. `ActionOutcome` is one
            // type across both hooks, so widening it for `perform()` made the
            // status expressible on `reverse()` as well, but no handler returns
            // it there and this design does not settle what a terminal *undo*
            // refusal would mean: dropping the marker would destroy the only
            // record naming settings and files that are still on disk (the
            // orphaning #212 and LLP 0138#marker-undo both refuse to accept),
            // while keeping it is the retry-forever this document removes from
            // the forward gap. Retrying is the safe half of that pair, so an
            // unexpected `refused` reverse degrades to a visible retry rather
            // than a silent drop. A reverse that genuinely needs to refuse
            // needs its own branch, and its own decision about the marker,
            // first (LLP 0186 §Explicitly out of scope).
            results.push({ kind, requestKey, outcome: 'failed', reason: outcome.reason ?? 'unknown' })
            log.error('client_action.reverse_failed', {
              [Attr.COMPONENT]: 'action-reconciler',
              [Attr.OPERATION]: 'client_action.reverse',
              kind,
              request_key: requestKey,
              [Attr.STATUS]: 'failed',
              [Attr.ERROR_KIND]: 'action_reverse_failed',
              detail: outcome.reason ?? 'unknown',
            })
          }
        }
      }

      // Persist a non-empty kind bucket only when it actually has markers, so
      // a no-op handler never writes an empty namespace into the file.
      if (Object.keys(markers).length > 0) {
        store[kind] = markers
      } else {
        delete store[kind]
      }
    }

    if (mutated) writeStore(store)
    return { results }
  }

  /** @returns {ClientActionStatus} */
  function readStatus() {
    return { byKind: readStore() }
  }

  return { reconcile, readStatus }
}

/**
 * Decide whether a `done` marker still short-circuits its still-desired action,
 * by consulting the handler's optional `isCurrent` freshness predicate. A
 * handler without one (backfill) is always current: a `done` marker is
 * permanently done. A predicate that throws is treated as *current* (skip): an
 * unexpected error must never spuriously re-perform a `done` effect on a loop,
 * so it degrades to the pre-LLP-0086 level-triggered behavior.
 *
 * Only `done` markers reach here. A `refused` marker short-circuits before this
 * is consulted (LLP 0186): its gate is the user fixing the precondition and
 * re-running `hyp attach`, which no freshness predicate can observe.
 *
 * @param {ActionHandler} handler
 * @param {ActionMarker} marker
 * @param {DesiredAction} action
 * @param {ActionContext} ctx
 * @returns {boolean}
 */
function markerIsCurrent(handler, marker, action, ctx) {
  if (typeof handler.isCurrent !== 'function') return true
  try {
    return handler.isCurrent(marker, action, ctx) !== false
  } catch {
    return true
  }
}

/**
 * Invoke a handler hook and normalize a throw into a `failed` outcome, so a
 * handler that rejects is treated identically to one that returns
 * `{ status: 'failed' }`: the marker records the failure and the next pass
 * retries.
 *
 * `refused` is an accepted shape beside `done` and `failed`, but only when a
 * handler says so in its return value: a bare throw stays `failed`, because a
 * refusal is a claim about the user's preconditions that nothing can infer
 * from an exception alone (an adapter that means it marks the Error and its
 * handler translates it, `action_refusal.js`).
 *
 * @param {() => Promise<ActionOutcome>} fn
 * @returns {Promise<ActionOutcome>}
 * @ref LLP 0186#the-widened-handler-outcome-type-across-the-reconciler-seam [implements]: the accepted-shape check widens to refused; an unmigrated handler still defaults to failed
 */
async function runOutcome(fn) {
  try {
    const outcome = await fn()
    if (
      outcome &&
      (outcome.status === 'done' || outcome.status === 'failed' || outcome.status === 'refused')
    ) {
      return outcome
    }
    return { status: 'failed', reason: 'handler returned no outcome' }
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Read the persisted marker store. ENOENT (no action has ever run) is the
 * empty store; an unparseable or non-object document is treated as empty.
 * Mirrors `readControlState` in `apply.js`.
 *
 * Corruption tolerance is load-bearing: `reconcile()` reads the marker on
 * every pass, so a `JSON.parse` throw here would wedge *all* client actions
 * while `hyp status` (which already swallows the error in
 * `readClientActionStatus`) reports clean. An empty store means the next
 * pass simply re-derives the gap from `desired()` and rewrites a clean
 * marker: losing only the (recoverable) completion record, never running a
 * pass it should not.
 *
 * @param {string} markerPath
 * @returns {ActionMarkerStore}
 */
function readMarkerStore(markerPath) {
  let raw
  try {
    raw = fs.readFileSync(markerPath, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return {}
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  return parsed && typeof parsed === 'object' ? /** @type {ActionMarkerStore} */ (parsed) : {}
}

/**
 * The `installed_assets` undo record off a marker, defensively: the store is a
 * JSON file that a pre-LLP-0138 daemon (or a hand edit) may have written
 * without the field, or with something that is not a list of strings.
 *
 * Lives with the marker store rather than with the one handler that writes the
 * field, because everything that *drops* a marker has to read it first, and
 * those droppers (this reconciler, `hyp detach`, `hyp leave`) are not all
 * handlers. Two readers of one persisted field are two chances to disagree
 * about what it holds.
 *
 * @param {ActionMarker} [marker]
 * @returns {string[]}
 * @ref LLP 0138#marker-undo [implements]: the marker is the undo record, so
 *   every path that drops one reads its assets through this one accessor.
 */
export function readInstalledAssets(marker) {
  const raw = marker?.installed_assets
  if (!Array.isArray(raw)) return []
  return raw.filter((dest) => typeof dest === 'string' && dest.length > 0)
}

/**
 * Did an earlier pass at this request key reach `done`, i.e. apply an effect
 * that is still on disk?
 *
 * `installed_assets` answers this only for an attach that copied files. An
 * attach that writes the client's settings and copies nothing (openclaw, and
 * any settings-only client) leaves no such trace, so a `done` marker later
 * rewritten to `failed`/`refused` used to be byte-indistinguishable from one
 * whose attach never applied anything. `prior_done` is the missing half of the
 * evidence, read defensively because the store is persisted JSON that a
 * pre-LLP-0250 daemon (or a hand edit) wrote without the field.
 *
 * Read off the *existing* marker when writing a terminal rewrite, and off the
 * stored marker when deciding whether the reverse gap may drop it.
 *
 * @param {ActionMarker} [marker]
 * @returns {boolean}
 * @ref LLP 0250#the-bit [implements]: one accessor for "an earlier pass applied
 *   something here", beside the one that reads the asset half
 */
export function markerRecordsPriorDone(marker) {
  if (!marker) return false
  return marker.status === 'done' || marker.prior_done === true
}

/**
 * Read-only view of the client-action markers for `hyp status`: usable
 * from any process (the CLI is not the daemon), so it never constructs the
 * reconciler or takes its handlers. Mirrors `readConfigControlStatus`.
 *
 * @param {{ stateRoot: string }} args
 * @returns {ClientActionStatus}
 * @ref LLP 0041#idempotency-and-completion-state [implements]: read-only marker view for the status surface, no engine construction
 */
export function readClientActionStatus({ stateRoot }) {
  const markerPath = path.join(stateRoot, CONTROL_DIRNAME, CLIENT_ACTIONS_BASENAME)
  /** @type {ActionMarkerStore} */
  let store = {}
  try {
    store = readMarkerStore(markerPath)
  } catch {
    // unreadable markers surface as empty: status is best-effort
  }
  return { byKind: store }
}

/**
 * Retract a single client-action marker (`kind` + `requestKey`) from the store:
 * the write counterpart to {@link readClientActionStatus}, callable from any
 * process (the CLI is not the daemon, so it never constructs the reconciler).
 *
 * The manual `hyp detach` command calls it after a successful disk reversal so
 * the CLI undo and the marker store stay in sync, doing the same
 * `delete markers[requestKey]` the reconciler's `reverse()` does once its own
 * disk undo succeeds. Without it a manual detach reverses the on-disk settings
 * but leaves an orphaned `done` attach marker; the next join's forward gap then
 * short-circuits on that stale marker and never re-attaches the client (#217).
 * That is why detach-via-config-drop was rejoin-recoverable while detach-via-CLI
 * was not: this retraction is what makes the single core undo's two call sites
 * converge instead of drift.
 *
 * Atomic (tmp+rename, mode 0600), mirroring `writeStore`. A missing store, kind
 * bucket, or key is a no-op returning `false`; an emptied bucket is dropped so a
 * stale empty namespace never lingers, matching `reconcile()`'s own cleanup.
 *
 * @param {{ stateRoot: string, kind: string, requestKey: string, now?: () => number }} args
 * @returns {boolean} whether a marker was found and the store rewritten
 * @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements]: manual detach retracts its attach marker so the single core undo's two call sites (CLI + reconciler reverse) cannot drift; the marker never outlives its own effect being reversed (#217)
 */
export function clearClientActionMarker({ stateRoot, kind, requestKey, now = Date.now }) {
  const controlDir = path.join(stateRoot, CONTROL_DIRNAME)
  const markerPath = path.join(controlDir, CLIENT_ACTIONS_BASENAME)
  const store = readMarkerStore(markerPath)
  const markers = store[kind]
  if (!markers || !(requestKey in markers)) return false
  delete markers[requestKey]
  // Drop an emptied bucket so a no-op namespace never lingers (mirrors reconcile).
  if (Object.keys(markers).length > 0) {
    store[kind] = markers
  } else {
    delete store[kind]
  }
  atomicWriteJsonSync(markerPath, store, { mode: 0o600, dirMode: 0o700 })
  return true
}

/**
 * Re-arm a `refused` marker after an explicit `hyp attach` fixed the
 * precondition it refused on, without destroying anything the marker is the
 * only record of. Called by the manual attach command path; a no-op returning
 * `false` for a missing marker, or for one in any other state (a `done` marker
 * is a live undo record, and a `failed` one is not short-circuited by anything,
 * so neither needs or may get this).
 *
 * Two shapes, because "re-arm" and "retract" are only the same operation when
 * the marker records no effect:
 *
 *  - **No `installed_assets`.** Dropped outright. The next reconcile pass's
 *    `existing` lookup returns `undefined`, the request key is a fresh forward
 *    gap, and `perform()` writes a correct `done` marker itself.
 *
 *    What makes that safe is the *call site*, not the marker: this runs only
 *    after an explicit `hyp attach` that already succeeded and rewrote the
 *    client's settings, and a hand-attached client is undone by `hyp detach`
 *    reading the client's own file, with no marker needed. So do not read the
 *    drop as "this marker recorded nothing". Such a marker may carry
 *    `prior_done: true` (a settings-only attach that reached `done` and was
 *    later rewritten to `refused`), and that bit is exactly the evidence the
 *    reconciler's reverse gap must not drop over. Here it may be dropped, and
 *    the asset half below may not, because the settings name themselves on
 *    disk and org-installed asset paths are named by nothing but this marker.
 *    Only the *asset* half of the record outlives an explicit re-attach.
 *  - **With `installed_assets`.** Those name files an *earlier* successful
 *    org-driven attach copied, carried onto the marker across its rewrite to
 *    `refused`; the marker is the only thing on disk naming them, and
 *    `hyp detach` / `hyp leave` / `reverse()` all read exactly it to know what
 *    to remove (LLP 0138#marker-undo). Dropping it would strand them, which is
 *    the same harm the `refused` write branch's own carry-forward exists to
 *    prevent. So the marker is rewritten to `failed` with the undo record
 *    intact: `failed` is short-circuited by nothing, so it re-arms the forward
 *    gap exactly as a cleared marker does, and the next successful
 *    `perform()` unions the carried assets onto the fresh `done` marker.
 *
 * Atomic (tmp+rename, mode 0600), like {@link clearClientActionMarker}.
 *
 * @param {{ stateRoot: string, kind: string, requestKey: string, now?: () => number }} args
 * @returns {boolean} whether a `refused` marker was found and the store rewritten
 * @ref LLP 0186#re-arm-explicit-hyp-attach-re-run-only [implements]: an explicit hyp attach re-arms a refused marker, and only a refused one
 * @ref LLP 0138#marker-undo [implements]: the re-arm keeps the record of an applied effect, so a later reversal can still remove what an org-driven attach installed
 * @ref LLP 0250 [constrained-by]: the re-arm is deliberately left reading only the asset half, so an assetless marker carrying `prior_done` is still dropped here
 */
export function rearmRefusedActionMarker({ stateRoot, kind, requestKey, now = Date.now }) {
  const controlDir = path.join(stateRoot, CONTROL_DIRNAME)
  const markerPath = path.join(controlDir, CLIENT_ACTIONS_BASENAME)
  const store = readMarkerStore(markerPath)
  const markers = store[kind]
  const marker = markers?.[requestKey]
  if (!markers || !marker || marker.status !== 'refused') return false
  const installedAssets = readInstalledAssets(marker)
  if (installedAssets.length === 0) {
    delete markers[requestKey]
  } else {
    const previous = typeof marker.reason === 'string' && marker.reason.length > 0 ? marker.reason : 'unknown'
    markers[requestKey] = {
      ...marker,
      status: 'failed',
      installed_assets: installedAssets,
      reason: `re-armed by an explicit 'hyp client attach ${requestKey}', awaiting the next reconcile pass (previous refusal: ${previous})`,
      last_attempt: new Date(now()).toISOString(),
    }
  }
  // Drop an emptied bucket so a no-op namespace never lingers (mirrors reconcile).
  if (Object.keys(markers).length > 0) {
    store[kind] = markers
  } else {
    delete store[kind]
  }
  atomicWriteJsonSync(markerPath, store, { mode: 0o600, dirMode: 0o700 })
  return true
}
