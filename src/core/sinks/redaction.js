// @ts-check

import { Worker } from 'node:worker_threads'
import { isPlainObject } from '../util/json_util.js'

/** @import { ExportRedactionConfig, ValidationError } from '../../../hypaware-plugin-kernel-types.js' */

const MASK = '[REDACTED]'
const MAX_PATTERNS = 32
const MAX_PATTERN_LENGTH = 2048
const MAX_NODES = 100000
const MAX_BYTES = 16 * 1024 * 1024
const MAX_TOOL_PATHS = 4096
const PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'filename', 'file'])
const READ_TOOLS = /^(?:read|read_file|readfile)$/i
const CREDENTIAL_KEYS = /^(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|authorization)$/i
const STRUCTURAL = new Set([
  'org', 'cwd', 'date', 'timestamp', 'time', 'ts', 'role', 'part_type', 'part_index',
  'message_index', 'client_name', 'conversation_source', 'entrypoint', 'model',
  'provider', 'tool_name', 'provider_type', 'provider_subtype',
])

// Small, maintained patterns with recognizable credential syntax. Avoid a
// thousands-of-regex pass over every string in a growing transcript.
const BUILTIN_PATTERNS = [
  /\bsk-(?:ant-[A-Za-z0-9_-]{16,}|proj-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{32,})\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@]+:[^\s/@]+@[^\s"'<>]+/gi,
]
const ASSIGNMENT = /\b((?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key)\s*[=:]\s*["']?)[^\s"'<>;,}{]{4,}/gi

/** @param {string} text */
function privateKeys(text) {
  if (!text.includes('-----BEGIN ')) return text
  const begin = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----/g
  const parts = []
  let offset = 0
  let match
  while ((match = begin.exec(text))) {
    parts.push(text.slice(offset, match.index), MASK)
    const end = `-----END ${match[1]}-----`
    const at = text.indexOf(end, begin.lastIndex)
    if (at < 0) return parts.join('')
    offset = at + end.length
    begin.lastIndex = offset
  }
  return parts.length ? parts.join('') + text.slice(offset) : text
}

/** @param {unknown} value @param {ValidationError[]} errors @returns {ExportRedactionConfig | undefined} */
export function parseRedactionConfig(value, errors) {
  if (value === undefined) return undefined
  const pointer = '/redaction'
  if (!isPlainObject(value)) {
    errors.push({ pointer, message: 'redaction must be an object' })
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (key !== 'custom_patterns') errors.push({ pointer: `${pointer}/${key}`, message: 'unrecognized redaction option' })
  }
  if (value.custom_patterns === undefined) return {}
  if (!Array.isArray(value.custom_patterns) || value.custom_patterns.length > MAX_PATTERNS) {
    errors.push({ pointer: `${pointer}/custom_patterns`, message: `custom_patterns must be an array of at most ${MAX_PATTERNS} expressions` })
    return undefined
  }
  const custom_patterns = []
  for (const [index, item] of value.custom_patterns.entries()) {
    const at = `${pointer}/custom_patterns/${index}`
    if (!isPlainObject(item) || typeof item.pattern !== 'string' || item.pattern.length === 0 || item.pattern.length > MAX_PATTERN_LENGTH) {
      errors.push({ pointer: at, message: `expression must have a nonempty pattern of at most ${MAX_PATTERN_LENGTH} characters` })
      continue
    }
    if (Object.keys(item).some(key => key !== 'pattern' && key !== 'flags') ||
        (item.flags !== undefined && (typeof item.flags !== 'string' || !/^[gimsu]*$/.test(item.flags)))) {
      errors.push({ pointer: at, message: 'expression accepts only pattern and optional g, i, m, s, u flags' })
      continue
    }
    try {
      new RegExp(item.pattern, item.flags)
      custom_patterns.push({ pattern: item.pattern, ...(item.flags === undefined ? {} : { flags: item.flags }) })
    } catch {
      // RegExp errors echo the expression. Config may itself contain a secret.
      errors.push({ pointer: at, message: 'invalid regular expression or duplicate flags' })
    }
  }
  return { custom_patterns }
}

/** @param {string} key */
export function isExportIdentityColumn(key) {
  return STRUCTURAL.has(key) || key === 'id' || /(?:^|_)(?:id|uuid|hash|sha)$/.test(key)
}

/** @param {string} file */
function sensitiveFile(file) {
  const normalized = file.replace(/\\/g, '/').toLowerCase()
  const name = normalized.split('/').at(-1) ?? ''
  if (/^\.env(?:\.|$)/.test(name) && !/\.(?:example|sample|template)$/.test(name)) return true
  return /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|\.npmrc|\.netrc|\.git-credentials|\.zshrc|\.bashrc|\.bash_profile|\.profile|\.zsh_history|\.bash_history|secrets\.ya?ml|master\.key|service[-_]account\.json)$/.test(name) ||
    /\.(?:pem|key)$/.test(name) || /(?:^|\/)(?:\.aws\/(?:credentials|config)|\.docker\/config\.json|\.kube\/config)$/.test(normalized)
}

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function objectValue(value) {
  if (isPlainObject(value)) return value
  if (typeof value === 'string' && value.trimStart().startsWith('{')) {
    try { const parsed = JSON.parse(value); if (isPlainObject(parsed)) return parsed } catch {}
  }
  return undefined
}

/**
 * Copy on change. The state is bounded to one export iterator and records only
 * whether a file tool targets a sensitive path, never its contents or path.
 * @param {ExportRedactionConfig} [config]
 * @param {boolean} [customOnly] Internal worker mode: built-ins already ran before IPC.
 */
export function createRowRedactor(config = {}, customOnly = false) {
  const custom = (config.custom_patterns ?? []).map(({ pattern, flags = '' }) => new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'))
  const toolPaths = new Map()

  /** @template {Record<string, unknown>} T @param {T} row @returns {T} */
  return function redactRow(row) {
    let nodes = 0
    let bytes = 0
    const args = objectValue(row.tool_args)
    const path = args && [...PATH_KEYS].map(key => args[key]).find(value => typeof value === 'string')
    const tool = typeof row.tool_name === 'string' ? row.tool_name.split('.').at(-1) ?? '' : ''
    const call = row.tool_call_id ?? row.tool_result_for
    const session = row.session_id ?? row.conversation_id
    const key = typeof session === 'string' && session && typeof call === 'string' && call
      ? JSON.stringify([session, call]) : undefined
    let mask = !customOnly && typeof path === 'string' && sensitiveFile(path)
    if (!customOnly && row.part_type === 'tool_call' && key && typeof path === 'string') {
      if (toolPaths.size >= MAX_TOOL_PATHS) toolPaths.delete(toolPaths.keys().next().value)
      toolPaths.set(key, mask)
    }
    if (!customOnly && row.part_type === 'tool_result') {
      if (typeof path !== 'string' && toolPaths.has(key)) mask = toolPaths.get(key)
      // A read without a known path cannot be proven safe, including when its
      // call was exported on an earlier tick. Mask the output conservatively.
      else if (typeof path !== 'string' && READ_TOOLS.test(tool)) mask = true
      toolPaths.delete(key)
    }

    // `mode` narrows what a hidden file's content may keep: a top-level
    // identity column is kept verbatim, and only the row's own tool_args may
    // keep its path keys. The same names nested in masked content are content.
    /** @param {unknown} value @param {boolean} hide @param {number} depth @param {'preserve' | 'args' | 'path'} [mode] @returns {any} */
    function visit(value, hide, depth, mode) {
      if (++nodes > MAX_NODES || depth > 64) throw new Error('export redaction row exceeds traversal budget')
      if (typeof value === 'string') {
        bytes += value.length * 2
        if (bytes > MAX_BYTES) throw new Error('export redaction row exceeds text budget')
        if (mode === 'preserve') return value
        if (/^\s*[{[]/.test(value)) {
          try {
            const parsed = JSON.parse(value)
            const changed = visit(parsed, hide, depth + 1, mode === 'args' ? 'args' : undefined)
            return changed === parsed ? value : JSON.stringify(changed)
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('export redaction')) throw error
          }
        }
        if (hide && mode !== 'path') return MASK
        let result = value
        if (!customOnly) {
          result = privateKeys(result)
          for (const pattern of BUILTIN_PATTERNS) result = result.replace(pattern, MASK)
          result = result.replace(ASSIGNMENT, (_, prefix) => prefix + MASK)
        }
        for (const pattern of custom) result = result.replace(pattern, MASK)
        return result
      }
      if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value
      // Refuse an over-wide array before walking it, and walk without
      // materializing an entries array, so the budget bounds memory too.
      if (Array.isArray(value) && nodes + value.length > MAX_NODES) throw new Error('export redaction row exceeds traversal budget')
      const local = objectValue(value)
      const input = local && objectValue(local.input ?? local.arguments ?? local.args)
      if (!customOnly && [local, input].some(object => object && [...PATH_KEYS].some(key => typeof object[key] === 'string' && sensitiveFile(/** @type {string} */ (object[key]))))) hide = true
      let copy
      /** @param {string | number} key @param {unknown} child */
      const step = (key, child) => {
        const childMode = mode === 'preserve' || (depth === 0 && typeof key === 'string' && isExportIdentityColumn(key)) ? 'preserve'
          : depth === 0 && key === 'tool_args' ? 'args'
            : mode === 'args' && typeof key === 'string' && PATH_KEYS.has(key) ? 'path'
              : undefined
        const changed = visit(child, hide || (!customOnly && typeof key === 'string' && CREDENTIAL_KEYS.test(key)), depth + 1, childMode)
        if (changed !== child) {
          copy ??= Array.isArray(value) ? value.slice() : { ...value }
          copy[key] = changed
        }
      }
      if (Array.isArray(value)) for (let i = 0; i < value.length; i++) step(i, value[i])
      else for (const key in value) if (Object.hasOwn(value, key)) step(key, value[key])
      return copy ?? value
    }
    return /** @type {T} */ (visit(row, mask, 0))
  }
}

/**
 * @param {ExportRedactionConfig} [config]
 * @ref LLP 0503#custom-regex [implements]: user expressions run off the event loop with a hard deadline; failure stops export
 */
export function createExportRedactor(config = {}) {
  const builtin = createRowRedactor()
  /** @type {Worker | undefined} */
  let worker
  return {
    /** @template {Record<string, unknown>} T @param {T} row @returns {Promise<T>} */
    async redact(row) {
      if (!config.custom_patterns?.length) return builtin(row)
      // Enforce the row budget and apply built-ins before structured cloning.
      const prepared = builtin(row)
      if (!worker) {
        worker = new Worker(new URL('./redaction_worker.js', import.meta.url), {
          workerData: config, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
        })
        // Keep an idle-worker error from becoming an uncaught process error.
        worker.on('error', () => {})
      }
      const current = worker
      return new Promise((resolve, reject) => {
        const finish = (error, result) => {
          clearTimeout(timer)
          current.removeListener('message', onMessage)
          current.removeListener('error', onError)
          current.removeListener('exit', onExit)
          if (error) reject(new Error(error))
          else resolve(result)
        }
        const onMessage = result => result.ok
          ? finish(undefined, result.changes.length ? { ...prepared, ...Object.fromEntries(result.changes) } : prepared)
          : finish('export redaction failed')
        const onError = () => finish('export redaction worker failed')
        const onExit = () => finish('export redaction worker stopped')
        const timer = setTimeout(() => {
          finish('export redaction timed out; no unredacted fallback is permitted')
          void current.terminate()
        }, 1000)
        current.once('message', onMessage)
        current.once('error', onError)
        current.once('exit', onExit)
        try { current.postMessage(prepared) } catch { finish('export redaction could not serialize row') }
      })
    },
    async close() { await worker?.terminate() },
  }
}
