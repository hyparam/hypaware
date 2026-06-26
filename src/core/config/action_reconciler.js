// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { Attr, getLogger } from '../observability/index.js'

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
 * } from './types.d.ts'
 */

/**
 * The kernel state subdirectory the reconciler shares with the apply
 * engine. Must match `CONTROL_DIRNAME` in `apply.js`: the marker is kernel
 * surface and belongs beside `state.json`, not in a plugin state dir
 * (LLP 0041 — "the action marker belongs here too, not in a plugin state
 * dir — the reconciler is kernel surface").
 */
const CONTROL_DIRNAME = 'config-control'

/**
 * The action-marker file. Namespaced per handler kind and keyed by request
 * key; written atomically (tmp+rename, mode 0600) exactly like `state.json`.
 * @ref LLP 0041#idempotency-and-completion-state [implements] — marker file config-control/client-actions.json, atomic tmp+rename, namespaced per handler kind
 */
const CLIENT_ACTIONS_BASENAME = 'client-actions.json'

/**
 * Build the generic, daemon-constructed action reconciler. It is the
 * run-once / reconcile-on-config machinery and knows nothing about Claude
 * vs Codex — only the {@link ActionHandler} interface. The daemon wires
 * its `reconcile()` to the config-confirmation edge and the
 * after-activation already-confirmed pass.
 *
 * @param {CreateActionReconcilerOptions} opts
 * @returns {ActionReconciler}
 * @ref LLP 0041#the-reconciler-component [implements] — createActionReconciler(opts) → { reconcile, readStatus }, constructed by the daemon like createConfigControl
 * @ref LLP 0036 — central-config-driven client action seam (the decision this realizes)
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
    fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 })
    const tmp = `${markerPath}.tmp.${process.pid}.${now()}`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, markerPath)
  }

  /**
   * Level-triggered reconcile (LLP 0036): for each handler, diff `desired()`
   * against the persisted markers and act only on the gap. A `done` marker
   * short-circuits, so the pass is safe to call repeatedly and a run missed
   * while probation was outstanding is recovered on the next call.
   *
   * @param {ReconcileInput} input
   * @returns {Promise<ReconcileReport>}
   * @ref LLP 0041#the-reconciler-component [implements] — reconcile() is level-triggered: diff desired() against the marker, act only on the gap; a done marker short-circuits
   */
  async function reconcile(input) {
    /** @type {ActionContext} */
    const ctx = { config: input.config, backfills: input.backfills, env: input.env, now, log }
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

      // Forward gap: run-once / retry the desired units not yet `done`.
      for (const action of desired) {
        const existing = markers[action.requestKey]
        if (existing && existing.status === 'done') {
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
            ...(outcome.detail ?? {}),
          }
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
      // (backfill) omit reverse() — imported data stays, the marker is kept,
      // and this loop is skipped (LLP 0041 §Undo on leave).
      const reverse = handler.reverse
      if (typeof reverse === 'function') {
        for (const requestKey of Object.keys(markers)) {
          if (desiredKeys.has(requestKey)) continue
          const marker = markers[requestKey]
          if (!marker || marker.status === 'failed') {
            // A failed marker for a no-longer-desired key never applied an
            // effect, so there is nothing to undo — just drop it.
            delete markers[requestKey]
            mutated = true
            continue
          }
          const outcome = await runOutcome(() => reverse(requestKey, ctx))
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
 * Invoke a handler hook and normalize a throw into a `failed` outcome, so a
 * handler that rejects is treated identically to one that returns
 * `{ status: 'failed' }` — the marker records the failure and the next pass
 * retries.
 *
 * @param {() => Promise<ActionOutcome>} fn
 * @returns {Promise<ActionOutcome>}
 */
async function runOutcome(fn) {
  try {
    const outcome = await fn()
    if (outcome && (outcome.status === 'done' || outcome.status === 'failed')) return outcome
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
 * marker — losing only the (recoverable) completion record, never running a
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
 * Read-only view of the client-action markers for `hyp status` — usable
 * from any process (the CLI is not the daemon), so it never constructs the
 * reconciler or takes its handlers. Mirrors `readConfigControlStatus`.
 *
 * @param {{ stateRoot: string }} args
 * @returns {ClientActionStatus}
 * @ref LLP 0041#idempotency-and-completion-state [implements] — read-only marker view for the status surface, no engine construction
 */
export function readClientActionStatus({ stateRoot }) {
  const markerPath = path.join(stateRoot, CONTROL_DIRNAME, CLIENT_ACTIONS_BASENAME)
  /** @type {ActionMarkerStore} */
  let store = {}
  try {
    store = readMarkerStore(markerPath)
  } catch {
    // unreadable markers surface as empty — status is best-effort
  }
  return { byKind: store }
}
