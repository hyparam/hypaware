// @ts-check
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { parseSessionArgv, runSessionIgnore, runSessionUnignore, runSessionStatus } from '../../ai-gateway/src/session_command.js'

/** @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js' */

// Recorders that read native history and host no control route.
const DATABASE_ONLY = new Map([['copilot', 'Copilot'], ['nanoclaw', 'NanoClaw']])

/** @param {'ignore' | 'unignore' | 'status'} operation */
export function copilotSessionCommand(operation) {
  return databaseOnlySessionCommand(operation, 'copilot')
}

/**
 * @param {'ignore' | 'unignore' | 'status'} operation
 * @param {string} client the registering client, named when no client list is available
 */
export function databaseOnlySessionCommand(operation, client) {
  /**
   * @param {string[]} argv @param {CommandRunContext} ctx
   * @ref LLP 0549#session-controls: a database-only recorder confirms durable membership without a socket
   */
  return async (argv, ctx) => {
    const clients = ctx.clients?.listClients().map(entry => entry.name) ?? [client]
    if (ctx.capabilities.has('hypaware.ai-gateway') || clients.some(name => !DATABASE_ONLY.has(name))) {
      return { ignore: runSessionIgnore, unignore: runSessionUnignore, status: runSessionStatus }[operation](argv, ctx)
    }
    const recorders = clients.length ? clients : [client]
    const label = recorders.map(name => DATABASE_ONLY.get(name)).join(' and ')
    const parsed = parseSessionArgv(argv)
    if (!parsed.ok || !parsed.id) {
      ctx.stderr.write(`${!parsed.ok ? parsed.error : `${label} session controls require an explicit native session ID.`}\nusage: hyp session ${operation} <session-id> [--json]\n`)
      return 2
    }
    try {
      const store = new SessionIgnoreSet(readObservabilityEnv(ctx.env).stateDir)
      store.refresh()
      if (operation === 'ignore') store.add(parsed.id)
      if (operation === 'unignore') store.delete(parsed.id)
      const ignored = store.has(parsed.id)
      const payload = { status: operation === 'status' ? ignored ? 'ignored' : 'not_ignored' : 'ok', session_id: parsed.id, ignored, guarantee: 'persisted_set_membership', earlier_rows: 'retained', recorder: recorders.join(',') }
      if (parsed.json) ctx.stdout.write(JSON.stringify(payload) + '\n')
      else ctx.stdout.write(`${parsed.id}: ${ignored ? 'excluded' : 'eligible'} for ${label} recording. This saved choice survives daemon restarts. Earlier recordings are retained; use hyp privacy purge to remove them.\n`)
      return operation === 'status' && !ignored ? 1 : 0
    } catch {
      ctx.stderr.write(`${label} session exclusions could not be read or saved; status is unknown.\n`)
      return 3
    }
  }
}
