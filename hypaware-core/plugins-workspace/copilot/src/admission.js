// @ts-check
import path from 'node:path'
import fs from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createUsagePolicyResolver, CLASS_RANK, isEqualOrDescendant } from '../../../../src/core/usage-policy/index.js'
import { markerName, refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { createClientRecordingPolicyReader } from '../../../../src/core/config/client_recording.js'
import { readSettings } from '../../../../src/core/config/jsonc_settings.js'
import { receiptPath } from './attach.js'

/** @import { AiGatewayProjectedExchange } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { CopilotOptions } from '../../../../hypaware-core/plugins-workspace/copilot/src/types.js' */

/** @param {CopilotOptions} opts */
export function createAdmission(opts) {
  const env = opts.env ?? process.env
  const recording = createClientRecordingPolicyReader({ env, plugin: '@hypaware/copilot' })
  // Short serial batches permit fresh policy at every asynchronous boundary.
  const policy = () => createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath, ttlMs: 0, existsSync: present })
  const directory = /** @type {{ directory?: string } | undefined} */ (opts.ignoredSessions)?.directory
  let exclusionsSignature
  let loadedAt = 0
  function refresh(force = false) {
    let signature = 'missing'
    let changedAt = 0
    if (directory) {
      try {
        const stat = fs.statSync(directory)
        signature = [stat.ino, stat.mtimeMs, stat.ctimeMs].join(':')
        changedAt = Math.max(stat.mtimeMs, stat.ctimeMs)
      }
      catch (err) { if (err?.code !== 'ENOENT') throw err }
    }
    // A change landing within timestamp granularity of the last load leaves the
    // signature equal, so a directory changed that recently is reloaded again.
    if (force || signature !== exclusionsSignature || changedAt >= loadedAt - RACY_MS) {
      loadedAt = Date.now()
      refreshSessionIgnores(opts.ignoredSessions)
      exclusionsSignature = signature
    }
  }
  return {
    refresh,
    /** @param {string} id @param {string} cwd */
    async allowed(id, cwd) {
      const resolver = policy()
      refresh()
      if (!recording().recording || sessionIgnoreLoadError(opts.ignoredSessions)) return false
      // The directory signature can miss rapid marker writes, so this session's
      // own marker decides membership in both directions.
      if (directory ? present(path.join(directory, markerName(id))) : opts.ignoredSessions?.has(id)) return false
      if (resolver.resolve(cwd).class === 'ignore') return false
      const receipt = await readSettings(receiptPath(env))
      return receipt.value._hypaware?.mode === 'database'
    },
    /** @param {AiGatewayProjectedExchange} exchange */
    async filter(exchange) {
      const resolver = policy()
      if (!exchange.cwd || !await this.allowed(exchange.session_id, exchange.cwd)) return undefined
      const rank = CLASS_RANK[resolver.resolve(exchange.cwd).class]
      const root = await realpath(exchange.cwd)
      const messages = []
      for (const message of exchange.messages) {
        let allowed = true
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!['tool_use', 'tool_result'].includes(String(block.type))) continue
          const name = String(block.name ?? '').toLowerCase()
          if (!/^(read|read_file|readfile|view)$/.test(name)) continue
          const input = block.input
          const file = input && typeof input === 'object' && !Array.isArray(input) ? input.path ?? input.filePath ?? input.file_path : undefined
          if (typeof file !== 'string') {
            allowed = false
            break
          }
          const lexical = path.resolve(exchange.cwd, file)
          try {
            const target = await realpath(lexical)
            if (!isEqualOrDescendant(target, root) || [path.dirname(lexical), path.dirname(target)].some(dir => CLASS_RANK[resolver.resolve(dir).class] > rank)) allowed = false
          } catch { allowed = block.is_error === true && isEqualOrDescendant(lexical, exchange.cwd) && CLASS_RANK[resolver.resolve(path.dirname(lexical)).class] <= rank }
          if (!allowed) break
        }
        if (allowed) messages.push(message)
      }
      if (!await this.allowed(exchange.session_id, exchange.cwd)) return undefined
      return { ...exchange, messages }
    },
  }
}

// Covers coarse filesystem timestamps and kernel clock lag behind Date.now().
const RACY_MS = 2000

/**
 * A path that cannot be probed counts as present, so an unreadable .hypignore
 * or exclusion resolves through the fail-closed read paths instead of as absent.
 *
 * @param {string} file
 */
function present(file) {
  try {
    fs.statSync(file)
    return true
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}
