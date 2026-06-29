// @ts-check

import { Attr } from '../observability/index.js'
import { selectProviders } from '../commands/backfill.js'
import { readBackfillPolicy } from './backfill_policy.js'

/**
 * @import {
 *   ActionContext,
 *   ActionHandler,
 *   ActionOutcome,
 *   BackfillSpawn,
 *   BackfillSpawnResult,
 *   CreateBackfillHandlerOptions,
 *   DesiredAction,
 * } from '../../../src/core/config/types.js'
 */

const MS_PER_DAY = 86_400_000

/**
 * The backfill action handler: the v1 instance of the generic client-action
 * reconciler (LLP 0036 / LLP 0037). It is the run-once "import this client's
 * local history once the central config that enabled it is confirmed" effect,
 * realized as a subprocess `hyp backfill` launch so a months-deep import can
 * never wedge the daemon tick loop or grow its heap (LLP 0041 §Execution
 * isolation; see the parquet-in-daemon hazard).
 *
 * `desired()` is pure (it reads the effective config + the kernel backfill
 * registry); `perform()` spawns the child off the tick loop. The spawn is
 * injectable so tests assert the argv and the marker writes without a real
 * child.
 *
 * @param {CreateBackfillHandlerOptions} [opts]
 * @returns {ActionHandler}
 * @ref LLP 0041#run-once-flow-backfill-handler [implements]: backfillHandler.desired() over selectProviders + per-plugin config.backfill; perform() resolves window_days->--since and spawns `hyp backfill <provider> --json`
 * @ref LLP 0037: backfill on join (the instance this realizes)
 */
export function createBackfillHandler(opts = {}) {
  const spawn = opts.spawn ?? defaultBackfillSpawn

  return {
    kind: 'backfill',

    /**
     * Enumerate the (provider) units to import. Reuses the exact
     * "enabled-in-config" predicate `hyp backfill` uses (`selectProviders`
     * with no explicit names), then drops any provider whose owning plugin
     * set `backfill.on_join: false` (the operator opt-out, which rides the
     * locked `plugins[]` entry - there is no local override). Pure: no
     * effects, no spawn.
     *
     * @param {ActionContext} ctx
     * @returns {DesiredAction[]}
     * @ref LLP 0041#consent-gating [constrained-by]: default-on; suppression is `backfill.on_join:false` in the locked central plugin entry, not a local override
     */
    desired(ctx) {
      const activePlugins = ctx.config.plugins ?? []
      const { providers } = selectProviders({
        requested: [],
        available: ctx.backfills.list(),
        activePlugins,
      })
      const byPluginName = new Map(
        activePlugins
          .filter((p) => p && typeof p.name === 'string')
          .map((p) => [p.name, p])
      )

      /** @type {DesiredAction[]} */
      const desired = []
      for (const provider of providers) {
        const policy = readBackfillPolicy(byPluginName.get(provider.plugin))
        // Default-on: only an explicit `on_join: false` opts out.
        if (policy.onJoin === false) continue
        desired.push({
          // The marker key is the owning plugin name: a per-(machine,
          // provider) boolean (LLP 0041 §request-key). The CLI positional,
          // however, is the *provider* name (`hyp backfill claude`, not
          // `@hypaware/claude`), carried separately in params.
          requestKey: provider.plugin,
          params: {
            provider: provider.name,
            plugin: provider.plugin,
            ...(policy.windowDays !== undefined ? { windowDays: policy.windowDays } : {}),
          },
        })
      }
      return desired
    },

    /**
     * Run one import as a subprocess. Resolves `window_days` → `--since`
     * (now − windowDays·days); when absent, omits `--since` so `hyp backfill`
     * falls back to the configured retention window (LLP 0041 §Run-once flow,
     * step 1). On exit 0 the `--json` payload's `providers[].rows_written` is
     * summed into a `done` marker; a non-zero exit or spawn error yields a
     * `failed` outcome the reconciler records and retries next pass.
     *
     * @param {DesiredAction} action
     * @param {ActionContext} ctx
     * @returns {Promise<ActionOutcome>}
     * @ref LLP 0041#run-once-flow-backfill-handler [implements]: spawn `hyp backfill <provider> [--since <iso>] --json` (runSmoke spawn pattern), parse providers[].rows_written, never advance to done on non-zero exit
     */
    async perform(action, ctx) {
      const params = action.params ?? {}
      const provider = typeof params.provider === 'string' ? params.provider : ''
      if (provider.length === 0) {
        return { status: 'failed', reason: 'backfill action missing provider name' }
      }
      const windowDays =
        typeof params.windowDays === 'number' && Number.isFinite(params.windowDays)
          ? params.windowDays
          : undefined
      const since =
        windowDays !== undefined
          ? new Date(ctx.now() - windowDays * MS_PER_DAY).toISOString()
          : undefined

      const args = ['backfill', provider, ...(since ? ['--since', since] : []), '--json']

      ctx.log.info('client_action.backfill_spawn', {
        [Attr.COMPONENT]: 'action-backfill',
        [Attr.OPERATION]: 'client_action.perform',
        [Attr.PLUGIN]: typeof params.plugin === 'string' ? params.plugin : provider,
        provider,
        ...(since ? { since } : {}),
        [Attr.STATUS]: 'ok',
      })

      /** @type {BackfillSpawnResult} */
      let result
      try {
        // Spawn with the daemon's resolved env (HYP_HOME forced to the
        // daemon's hypHome upstream in the reconcile input): NOT
        // `process.env`, which can name a different HYP_HOME on the
        // direct-`runDaemon`/hermetic-smoke path and import into the wrong
        // cache. @ref LLP 0041#run-once-flow-backfill-handler [constrained-by]:
        result = await spawn({ args, env: ctx.env })
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
      }

      if (result.error) {
        return { status: 'failed', reason: `hyp backfill spawn failed: ${result.error.message}` }
      }
      if (result.status !== 0) {
        return { status: 'failed', reason: `hyp backfill exited with code ${result.status}` }
      }

      const rows = parseRowsWritten(result.stdout)
      // Exit 0 is authoritative: the import committed. A row count is
      // best-effort: an unparseable payload still records `done` (rows
      // omitted) rather than re-running a successful import.
      return rows !== undefined ? { status: 'done', rows } : { status: 'done' }
    },
  }
}

/**
 * The default `[backfillHandler]` the daemon constructs the reconciler with
 * (T4 wiring). It uses the real async `hyp backfill` spawn; tests build their
 * own via {@link createBackfillHandler} with an injected spawn.
 *
 * @type {ActionHandler}
 */
export const backfillHandler = createBackfillHandler()

/* ------------------------------- Internals ------------------------------- */

/**
 * Sum `providers[].rows_written` out of a `hyp backfill --json` payload.
 * Returns `undefined` when the payload is unparseable or shapeless so the
 * caller can record a `done` marker without a row count.
 *
 * @param {string} stdout
 * @returns {number | undefined}
 */
function parseRowsWritten(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const providers = parsed && Array.isArray(parsed.providers) ? parsed.providers : undefined
  if (!providers) return undefined
  let rows = 0
  for (const p of providers) {
    if (p && typeof p.rows_written === 'number' && Number.isFinite(p.rows_written)) {
      rows += p.rows_written
    }
  }
  return rows
}

/**
 * The real subprocess seam: spawn `process.execPath bin/hypaware.js <args>`
 * resolved off `import.meta.url` (the `runSmoke` spawn pattern) and capture
 * stdout. Async (not `spawnSync`) on purpose: a multi-minute import must not
 * block the daemon's event loop (LLP 0041 §Execution isolation). Inherits the
 * daemon's `env` so the child writes the same cache (`HYP_HOME`).
 *
 * @type {BackfillSpawn}
 */
async function defaultBackfillSpawn({ args, env }) {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const binPath = fileURLToPath(new URL('../../../bin/hypaware.js', import.meta.url))
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    let stdout = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    // stderr is drained so the pipe buffer can't fill and stall the child;
    // its content is not needed (the exit code drives the outcome).
    child.stderr?.on('data', () => {})
    child.on('error', (error) => resolve({ status: null, stdout, error }))
    child.on('close', (status) => resolve({ status, stdout }))
  })
}
