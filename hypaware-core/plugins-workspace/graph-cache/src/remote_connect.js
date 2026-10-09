// @ts-check

import { createHttpMcpClient } from '../../../../src/core/mcp/client.js'
import { attachWithRefresh, deriveIdentityBase, deriveMcpEndpoint, describeAuthRejection, resolveAccessJwt } from '../../../../src/core/remote/credentials.js'
import { effectiveRemotes } from '../../../../src/core/remote/builtin_remotes.js'

/**
 * A cold MCP connection from the command to a team server: the target's URL
 * and bearer resolved the way `--remote` verbs resolve them, one forced
 * refresh after a 401, then `initialize` and `tools/list` (the handshake that
 * the `connect` phase of `timings_ms` reports). The client is bound to the
 * command's abort signal.
 *
 * @param {{ config: any, env: NodeJS.ProcessEnv, stateDir: string, target: string, org?: string | null, signal?: AbortSignal, fetchImpl?: typeof fetch }} args
 *   `stateDir` is HypAware's state directory (credentials), not the plugin's
 * @returns {Promise<{ ok: true, client: ReturnType<typeof createHttpMcpClient>, tools: any, url: string } | { ok: false, code: 'unknown_remote' | 'no_login' | 'auth' | 'transport', message: string }>}
 */
export async function connectRemote({ config, env, stateDir, target, org = null, signal, fetchImpl }) {
  const remotes = effectiveRemotes(config)
  const entry = Object.hasOwn(remotes, target) ? remotes[target] : undefined
  if (!entry || typeof entry.url !== 'string') return { ok: false, code: 'unknown_remote', message: `unknown remote '${target}'` }
  const identityBase = deriveIdentityBase(entry.url) ?? undefined
  const resolved = await resolveAccessJwt({ target, env, stateDir, identityBase })
  if (!resolved.ok) return { ok: false, code: 'no_login', message: resolved.error }
  const url = deriveMcpEndpoint(entry.url, org ?? undefined)
  let lastStatus = 401
  try {
    const out = await attachWithRefresh({
      resolved,
      refresh: () => resolveAccessJwt({ target, env, stateDir, identityBase, forceRefresh: true }),
      async op(token) {
        const client = createHttpMcpClient({ url, token, ...(signal ? { signal } : {}), ...(fetchImpl ? { fetchImpl } : {}) })
        try {
          await client.initialize()
          const tools = await client.listTools()
          return { authFailed: false, value: { client, tools } }
        } catch (err) {
          const e = /** @type {any} */ (err)
          if (e?.authError === true) {
            lastStatus = e.status ?? 401
            return { authFailed: true, value: null }
          }
          throw err
        }
      },
    })
    if (!out.ok) return { ok: false, code: 'auth', message: out.error }
    if (out.authFailed || !out.value) return { ok: false, code: 'auth', message: describeAuthRejection({ target, status: lastStatus, resolved }).message }
    return { ok: true, client: out.value.client, tools: out.value.tools, url }
  } catch (err) {
    return { ok: false, code: 'transport', message: err instanceof Error ? err.message : String(err) }
  }
}
