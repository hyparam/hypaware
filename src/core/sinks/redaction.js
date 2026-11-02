// @ts-check

import { Worker } from 'node:worker_threads'
import { isPlainObject } from '../util/json_util.js'
import { CREDENTIAL_KEYS, SECRET_MASK as MASK, isSensitiveFile as sensitiveFile, redactSecretText } from '../secret_rules.js'

/** @import { ExportRedactionConfig, ValidationError } from '../../../hypaware-plugin-kernel-types.js' */

const MAX_PATTERNS = 32
const MAX_PATTERN_LENGTH = 2048
const MAX_NODES = 100000
const MAX_BYTES = 16 * 1024 * 1024
const MAX_TOOL_PATHS = 4096
const PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'filename', 'file'])
const PATH_KEY_LIST = [...PATH_KEYS]
const READ_TOOLS = /^(?:read|read_file|readfile)$/i
const STRUCTURAL = new Set([
  'org', 'cwd', 'date', 'timestamp', 'time', 'ts', 'role', 'part_type', 'part_index',
  'message_index', 'client_name', 'conversation_source', 'entrypoint', 'model',
  'provider', 'tool_name', 'provider_type', 'provider_subtype',
])

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

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function objectValue(value) {
  if (isPlainObject(value)) return value
  if (typeof value === 'string' && value.trimStart().startsWith('{')) {
    try { const parsed = JSON.parse(value); if (isPlainObject(parsed)) return parsed } catch {}
  }
  return undefined
}

/** @param {unknown} error */
function isBudgetError(error) {
  return error instanceof Error && error.message.startsWith('export redaction row exceeds')
}

/** @param {Record<string, unknown> | undefined} object */
function sensitivePathIn(object) {
  return object !== undefined && PATH_KEY_LIST.some(key => typeof object[key] === 'string' && sensitiveFile(/** @type {string} */ (object[key])))
}

/**
 * The record-time fallback for one column past its traversal budget. It is
 * still written, read as flat text: a string gets the text rules once, a
 * hidden file's content and a credential key's value are masked (hidden
 * tool_args keep only their path keys), and a nested value the walk could
 * not finish is dropped.
 * @param {string} key
 * @param {unknown} value
 * @param {boolean} hide
 */
function redactFlatColumn(key, value, hide) {
  if (hide && key === 'tool_args') {
    const args = objectValue(value)
    if (!args) return typeof value === 'string' ? MASK : null
    /** @type {Record<string, unknown>} */
    const kept = {}
    for (const name in args) {
      if (Object.hasOwn(args, name)) kept[name] = PATH_KEYS.has(name) && typeof args[name] === 'string' ? redactSecretText(args[name]) : MASK
    }
    return typeof value === 'string' ? JSON.stringify(kept) : kept
  }
  if (typeof value === 'string') return hide ? MASK : redactSecretText(value)
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) return null
  return value
}

/**
 * Copy on change. The state is at most MAX_TOOL_PATHS call verdicts per
 * redactor (one export iterator, or one storage service at record time) and
 * records only whether a file tool targets a sensitive path, never its
 * contents or path.
 * @param {ExportRedactionConfig} [config]
 * @param {boolean} [customOnly] Internal worker mode: built-ins already ran before IPC.
 * @param {{ overBudget(): void }} [record] Record-time mode (LLP 0568): a read
 *   with no known path is kept, and a row past the budget is written instead
 *   of refused, each column walked on its own budget and a column past it
 *   redacted as flat text. Both are irreversible at record time; export
 *   still applies the conservative rules.
 */
export function createRowRedactor(config = {}, customOnly = false, record) {
  const custom = (config.custom_patterns ?? []).map(({ pattern, flags = '' }) => new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'))
  const toolPaths = new Map()

  /** @template {Record<string, unknown>} T @param {T} row @returns {T} */
  return function redactRow(row) {
    let nodes = 0
    let bytes = 0
    const args = objectValue(row.tool_args)
    const path = args && PATH_KEY_LIST.map(key => args[key]).find(value => typeof value === 'string')
    const call = row.tool_call_id ?? row.tool_result_for
    const session = row.session_id ?? row.conversation_id
    const key = (row.part_type === 'tool_call' || row.part_type === 'tool_result') &&
      typeof session === 'string' && session && typeof call === 'string' && call
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
      // At record time the call may simply have been recorded by another
      // process, and a mask there cannot be undone, so the read is kept.
      else if (typeof path !== 'string' && !record &&
        READ_TOOLS.test(typeof row.tool_name === 'string' ? row.tool_name.split('.').at(-1) ?? '' : '')) mask = true
      // A recorded result can be written again (a failed append is replayed),
      // so at record time the verdict outlives its first use; the FIFO cap
      // still bounds the map.
      if (!record) toolPaths.delete(key)
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
        if (!customOnly) result = redactSecretText(result)
        for (const pattern of custom) result = result.replace(pattern, MASK)
        return result
      }
      if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value
      // Refuse an over-wide array before walking it, and walk without
      // materializing an entries array, so the budget bounds memory too.
      if (Array.isArray(value) && nodes + value.length > MAX_NODES) throw new Error('export redaction row exceeds traversal budget')
      const local = objectValue(value)
      const input = local && objectValue(local.input ?? local.arguments ?? local.args)
      if (!customOnly && (sensitivePathIn(local) || sensitivePathIn(input))) hide = true
      // Changes are applied after the walk, so a row refused by the budget
      // never pays for a copy of a wide container.
      /** @type {[string | number, unknown][] | undefined} */
      let changes
      /** @param {string | number} key @param {unknown} child */
      const step = (key, child) => {
        const childMode = mode === 'preserve' || (depth === 0 && typeof key === 'string' && isExportIdentityColumn(key)) ? 'preserve'
          : depth === 0 && key === 'tool_args' ? 'args'
            : mode === 'args' && typeof key === 'string' && PATH_KEYS.has(key) ? 'path'
              : undefined
        const changed = visit(child, hide || (!customOnly && typeof key === 'string' && CREDENTIAL_KEYS.test(key)), depth + 1, childMode)
        if (changed !== child) (changes ??= []).push([key, changed])
      }
      if (Array.isArray(value)) for (let i = 0; i < value.length; i++) step(i, value[i])
      else for (const key in value) if (Object.hasOwn(value, key)) step(key, value[key])
      if (!changes) return value
      /** @type {any} */
      const copy = Array.isArray(value) ? value.slice() : { ...value }
      for (const [key, changed] of changes) copy[key] = changed
      return copy
    }
    if (!record) return /** @type {T} */ (visit(row, mask, 0))
    try {
      return /** @type {T} */ (visit(row, mask, 0))
    } catch (error) {
      if (!isBudgetError(error)) throw error
      record.overBudget()
    }
    // Past the budget, each column is walked again on its own budget, so only
    // a column too large to walk degrades to flat text and the rest of the
    // row (usage, attributes, markers) is kept as the full walk would keep it.
    const hide = mask || sensitivePathIn(row) || sensitivePathIn(objectValue(row.input ?? row.arguments ?? row.args))
    /** @type {[string, unknown][] | undefined} */
    let changes
    for (const key in row) {
      if (!Object.hasOwn(row, key) || isExportIdentityColumn(key)) continue
      const value = row[key]
      const hideKey = hide || CREDENTIAL_KEYS.test(key)
      nodes = 0
      bytes = 0
      let changed
      try {
        changed = visit(value, hideKey, 1, key === 'tool_args' ? 'args' : undefined)
      } catch (error) {
        if (!isBudgetError(error)) throw error
        changed = redactFlatColumn(key, value, hideKey)
      }
      if (changed !== value) (changes ??= []).push([key, changed])
    }
    if (!changes) return row
    /** @type {Record<string, unknown>} */
    const copy = { ...row }
    for (const [key, changed] of changes) copy[key] = changed
    return /** @type {T} */ (copy)
  }
}

/**
 * The built-in rules applied to rows about to be persisted. Synchronous, so
 * rows reach the spool in the order they were appended, and copy on change:
 * a batch with nothing to mask comes back as the same array of the same rows.
 * Custom patterns stay export-only.
 * @ref LLP 0568#seam [implements]: one built-in pass per row before the spool or a commit
 */
export function createRecordRedactor() {
  let overBudget = 0
  const redactRow = createRowRedactor({}, false, { overBudget() { overBudget++ } })
  /**
   * @param {Record<string, unknown>[]} rows
   * @param {Set<Record<string, unknown>>} [done] rows already redacted, passed through
   * @returns {{ rows: Record<string, unknown>[], redacted: number, overBudget: number }}
   */
  return function redactRows(rows, done) {
    overBudget = 0
    /** @type {Record<string, unknown>[] | undefined} */
    let out
    let redacted = 0
    for (let i = 0; i < rows.length; i++) {
      if (done?.has(rows[i])) continue
      const row = redactRow(rows[i])
      if (row === rows[i]) continue
      ;(out ??= rows.slice())[i] = row
      redacted++
    }
    return { rows: out ?? rows, redacted, overBudget }
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
