// @ts-check

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { AI_GATEWAY_MESSAGES_DATASET, projectedExchangeItem, resolveWindow } from '../../../../src/core/backfill/scan_util.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { isPlainObject, stringValue } from 'hypaware/core/util'
import { projectOpenCodeSnapshot } from './projector.js'

/** @import { BackfillContribution, BackfillEvent, BackfillItem, BackfillRunContext } from '../../../../hypaware-plugin-kernel-types.js' */

const execFileAsync = promisify(execFile)
const MAX_SESSION_LIST = 1000

/**
 * @param {{ localOnlyListPath?: string, runCommand?: (args: string[]) => Promise<string>, exactSessionIds?: string[], ignoredSessions?: Set<string> }} [opts]
 * @returns {BackfillContribution}
 */
export function createOpenCodeBackfillProvider(opts = {}) {
  const resolver = createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
  const runCommand = opts.runCommand ?? runOpenCode
  return {
    name: 'opencode',
    plugin: '@hypaware/opencode',
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import bounded OpenCode CLI and Desktop session exports',
    async *run(ctx) {
      yield* runBackfill({
        ctx,
        resolver,
        runCommand,
        exactSessionIds: opts.exactSessionIds,
        ignoredSessions: opts.ignoredSessions,
      })
    },
  }
}

/** @param {{ ctx: BackfillRunContext, resolver: ReturnType<typeof createUsagePolicyResolver>, runCommand: (args: string[]) => Promise<string>, exactSessionIds?: string[], ignoredSessions?: Set<string> }} deps */
async function* runBackfill(deps) {
  const window = resolveWindow(deps.ctx)
  /** @type {Array<{ id: string, updated?: number, created?: number, directory?: string }>} */
  let selected = []
  if (deps.exactSessionIds && deps.exactSessionIds.length > 0) {
    selected = deps.exactSessionIds.map((id) => ({ id }))
  } else {
    const rawList = await deps.runCommand(['session', 'list', '--format', 'json', '--max-count', String(MAX_SESSION_LIST)])
    const parsed = JSON.parse(rawList)
    if (!Array.isArray(parsed)) throw new Error('opencode session list did not return an array')
    selected = parsed
      .filter(isPlainObject)
      .map((item) => ({
        id: stringValue(item.id) ?? '',
        updated: numberValue(item.updated),
        created: numberValue(item.created),
        directory: stringValue(item.directory),
      }))
      .filter((item) => item.id && withinWindow(item.updated ?? item.created, window))
  }

  deps.ctx.log.info('opencode.backfill.selection', {
    component: 'plugin.opencode.backfill',
    operation: 'backfill.select',
    selected_sessions: selected.length,
    selection_cap: MAX_SESSION_LIST,
    exact_ids: deps.exactSessionIds?.length ?? 0,
    status: 'ok',
  })

  for (const item of selected) {
    if (deps.ctx.signal?.aborted) break
    if (deps.ignoredSessions?.has(item.id)) {
      yield /** @type {BackfillEvent} */ ({
        type: 'event',
        event: 'session_ignore_drop',
        attributes: { session_id: item.id },
      })
      continue
    }
    if (item.directory) {
      const policy = deps.resolver.resolve(item.directory)
      if (policy.class === 'ignore') {
        yield /** @type {BackfillEvent} */ ({
          type: 'event',
          event: 'usage_policy_drop',
          attributes: { session_id: item.id, class: 'ignore' },
        })
        continue
      }
    }
    // Export only the exact ID selected above. Never call bare `export`, which
    // would choose a latest session unrelated to the requested window.
    // @ref LLP 0306#recovery-lane [implements]: bounded metadata selection,
    //   then exact-session content export
    const rawExport = await deps.runCommand(['export', item.id])
    const exported = JSON.parse(rawExport)
    const session = isPlainObject(exported) && isPlainObject(exported.info) ? exported.info : undefined
    const cwd = stringValue(session?.directory)
    if (!cwd) {
      yield /** @type {BackfillEvent} */ ({
        type: 'event',
        event: 'missing_cwd',
        attributes: { session_id: item.id },
      })
      continue
    }
    // On the exact-id path `item.directory` is never populated, so this is the
    // only place the policy is consulted for those sessions. Report the drop
    // the same way the pre-export check does, or a `.hypignore` session is
    // silently absent from the run report rather than visibly withheld.
    const policy = deps.resolver.resolve(cwd)
    if (policy.class === 'ignore') {
      yield /** @type {BackfillEvent} */ ({
        type: 'event',
        event: 'usage_policy_drop',
        attributes: { session_id: item.id, class: 'ignore' },
      })
      continue
    }
    const projection = projectOpenCodeSnapshot(exported, {
      entrypoint: 'unknown',
      entrypointSource: 'historical-export',
    })
    if (!projection) continue
    yield projectedExchangeItem(projection, {
      client_name: 'opencode',
      source_path: `opencode export ${item.id}`,
      native_id: item.id,
    })
  }
}

/** @param {string[]} args */
async function runOpenCode(args) {
  const result = await execFileAsync('opencode', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return result.stdout
}

/** @param {number | undefined} timestamp @param {{ sinceMs?: number, untilMs?: number }} window */
function withinWindow(timestamp, window) {
  if (timestamp === undefined) return false
  if (window.sinceMs !== undefined && timestamp < window.sinceMs) return false
  if (window.untilMs !== undefined && timestamp > window.untilMs) return false
  return true
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
