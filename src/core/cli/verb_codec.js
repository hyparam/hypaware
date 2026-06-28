// @ts-check

/**
 * @import { VerbInputProperty, VerbInputSchema, VerbRenderControls } from '../../../collectivus-plugin-kernel-types.js'
 */

/**
 * The argv↔schema codec: the **single place** CLI parsing for the verb
 * (query) family lives. A verb declares one `inputSchema`; the kernel
 * projects a CLI command and an MCP tool from it
 * ([LLP 0034 §verbs](../../../llp/0034-mcp-host-intrinsic.decision.md#verbs)).
 * This module turns argv into typed params (CLI side) and emits the clean
 * JSON Schema the MCP tool advertises — so the flag set and the tool
 * schema can never drift, they are the same object.
 */

/**
 * Default per-cell truncation cap (code points) for inline output. Keeps
 * fat JSON/text columns to a peek while leaving scalar columns whole. The
 * canonical home for the render-control defaults; `core_commands.js`
 * re-exports these for back-compat.
 */
export const DEFAULT_QUERY_MAX_CELL = 200

/**
 * Default context byte budget for inline output. Bounds the total result
 * a query can push into a caller's context; `--output` or `--max-bytes 0`
 * lift it.
 */
export const DEFAULT_QUERY_MAX_BYTES = 32_768

const FORMATS = new Set(['table', 'json', 'jsonl', 'markdown'])
const REFRESH_MODES = new Set(['never', 'auto', 'always'])

/**
 * Kernel-owned render/transport control flags, common to every verb and
 * stripped before the schema codec sees the rest. Keeping them out of the
 * per-verb `inputSchema` is deliberate: `--refresh` is a local-cache
 * control and `--remote` a transport selector — neither is an operation
 * param, so neither belongs in the MCP tool schema.
 *
 * @param {string[]} argv
 * @returns {{ ok: true, controls: VerbRenderControls & { refresh: 'never'|'auto'|'always', refreshExplicit: boolean, remote: string | undefined }, rest: string[] } | { ok: false, error: string }}
 */
export function parseControlFlags(argv) {
  /** @type {VerbRenderControls & { refresh: 'never'|'auto'|'always', refreshExplicit: boolean, remote: string | undefined }} */
  const controls = {
    format: 'table',
    json: false,
    output: undefined,
    maxCell: DEFAULT_QUERY_MAX_CELL,
    maxBytes: DEFAULT_QUERY_MAX_BYTES,
    refresh: 'auto',
    refreshExplicit: false,
    remote: undefined,
  }
  /** @type {string[]} */
  const rest = []

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const isFlag = token.startsWith('--') || token === '-o'
    const eq = isFlag ? token.indexOf('=') : -1
    const name = eq >= 0 ? token.slice(0, eq) : token
    const inlineVal = eq >= 0 ? token.slice(eq + 1) : undefined
    /** @returns {string | undefined} */
    const takeVal = () => {
      if (inlineVal !== undefined) return inlineVal
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) return undefined
      i += 1
      return v
    }

    switch (name) {
      case '--json':
        controls.json = true
        break
      case '--format': {
        const v = takeVal()
        if (v === undefined || !FORMATS.has(v)) {
          return { ok: false, error: `--format expects one of table|json|jsonl|markdown (got ${v ?? '<missing>'})` }
        }
        controls.format = /** @type {VerbRenderControls['format']} */ (v)
        break
      }
      case '--output':
      case '-o': {
        const v = takeVal()
        if (v === undefined) return { ok: false, error: '--output expects a file path' }
        controls.output = v
        break
      }
      case '--max-cell':
      case '--max-bytes': {
        const v = takeVal()
        const n = Number(v)
        if (v === undefined || !Number.isInteger(n) || n < 0) {
          return { ok: false, error: `${name} expects a non-negative integer (got ${v ?? '<missing>'})` }
        }
        if (name === '--max-cell') controls.maxCell = n
        else controls.maxBytes = n
        break
      }
      case '--refresh': {
        const v = takeVal()
        if (v === undefined || !REFRESH_MODES.has(v)) {
          return { ok: false, error: `--refresh expects one of never|auto|always (got ${v ?? '<missing>'})` }
        }
        controls.refresh = /** @type {'never'|'auto'|'always'} */ (v)
        controls.refreshExplicit = true
        break
      }
      case '--remote': {
        const v = takeVal()
        if (v === undefined) return { ok: false, error: '--remote expects a target name' }
        controls.remote = v
        break
      }
      default:
        rest.push(token)
    }
  }

  return { ok: true, controls, rest }
}

/**
 * Coerce the verb-specific argv tail (positionals + the verb's own flags)
 * into a typed params object per `inputSchema`. Flags map to schema
 * properties (`--edge-type` → `edge_type`); the final string positional
 * may be `greedy` and absorb all remaining tokens (a SQL string).
 *
 * @param {VerbInputSchema} inputSchema
 * @param {string[]} argv
 * @returns {{ ok: true, params: Record<string, unknown> } | { ok: false, error: string }}
 */
export function argvToParams(inputSchema, argv) {
  const props = inputSchema.properties ?? {}
  /** @type {Record<string, unknown>} */
  const params = {}
  /** @type {string[]} */
  const positionals = []

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const flag = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    const inlineVal = eq >= 0 ? token.slice(eq + 1) : undefined
    const propName = resolveFlag(props, flag)
    const prop = propName ? props[propName] : undefined
    if (!prop || !propName) {
      return { ok: false, error: `unknown flag --${flag}` }
    }
    if (prop.type === 'boolean') {
      if (inlineVal === undefined) {
        params[propName] = true
      } else if (inlineVal === 'true' || inlineVal === 'false') {
        params[propName] = inlineVal === 'true'
      } else {
        return { ok: false, error: `--${flag} expects true|false (got ${inlineVal})` }
      }
      continue
    }
    let value = inlineVal
    if (value === undefined) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: `--${flag} expects a value` }
      }
      value = next
      i += 1
    }
    const coerced = coerceValue(prop, value, `--${flag}`)
    if (!coerced.ok) return coerced
    if (prop.type === 'array') {
      const existing = /** @type {unknown[]} */ (params[propName] ?? [])
      params[propName] = [...existing, ...(/** @type {unknown[]} */ (coerced.value))]
    } else {
      params[propName] = coerced.value
    }
  }

  const bound = bindPositionals(inputSchema, props, positionals, params)
  if (!bound.ok) return bound

  applyDefaults(props, params)

  const missing = requiredMissing(inputSchema, params)
  if (missing) return { ok: false, error: `missing required ${missing}` }

  return { ok: true, params }
}

/**
 * Validate + coerce an MCP `tools/call` arguments object against the same
 * schema. MCP delivers typed JSON, but a client may send a string for an
 * integer; we coerce defensively, apply defaults, and enforce
 * required/enum — the identical contract the CLI path enforces.
 *
 * @param {VerbInputSchema} inputSchema
 * @param {Record<string, unknown>} args
 * @returns {{ ok: true, params: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateToolArguments(inputSchema, args) {
  const props = inputSchema.properties ?? {}
  /** @type {Record<string, unknown>} */
  const params = {}
  for (const [key, raw] of Object.entries(args ?? {})) {
    const prop = props[key]
    if (!prop) return { ok: false, error: `unknown argument '${key}'` }
    if (raw === undefined || raw === null) continue
    if (prop.type === 'array') {
      const items = Array.isArray(raw) ? raw : [raw]
      /** @type {unknown[]} */
      const out = []
      for (const item of items) {
        const c = coerceValue({ ...prop, type: prop.items?.type ?? 'string' }, String(item), key)
        if (!c.ok) return c
        out.push(c.value)
      }
      params[key] = out
    } else if (prop.type === 'boolean') {
      params[key] = typeof raw === 'boolean' ? raw : raw === 'true'
    } else {
      const c = coerceValue(prop, String(raw), key)
      if (!c.ok) return c
      params[key] = c.value
    }
  }
  applyDefaults(props, params)
  const missing = requiredMissing(inputSchema, params)
  if (missing) return { ok: false, error: `missing required ${missing}` }
  return { ok: true, params }
}

/**
 * Project the verb's `inputSchema` to the clean JSON Schema the MCP tool
 * advertises — the same properties, minus the CLI-only `positional` and
 * per-property `greedy` hints (those describe argv binding, not the wire
 * contract).
 *
 * @param {VerbInputSchema} inputSchema
 * @returns {{ type: 'object', properties: Record<string, object>, required?: string[] }}
 */
export function toJsonSchema(inputSchema) {
  /** @type {Record<string, object>} */
  const properties = {}
  for (const [name, prop] of Object.entries(inputSchema.properties ?? {})) {
    const { greedy: _greedy, ...rest } = prop
    properties[name] = rest
  }
  /** @type {{ type: 'object', properties: Record<string, object>, required?: string[] }} */
  const schema = { type: 'object', properties }
  if (inputSchema.required && inputSchema.required.length > 0) schema.required = [...inputSchema.required]
  return schema
}

/**
 * Build a CLI usage string from the schema: positionals first, then the
 * verb's own flags.
 *
 * @param {string} name
 * @param {VerbInputSchema} inputSchema
 * @returns {string}
 */
export function usageForVerb(name, inputSchema) {
  const props = inputSchema.properties ?? {}
  const required = new Set(inputSchema.required ?? [])
  const positional = inputSchema.positional ?? []
  const parts = [`hyp ${name}`]
  for (const p of positional) {
    parts.push(required.has(p) ? `<${p}>` : `[${p}]`)
  }
  for (const [propName, prop] of Object.entries(props)) {
    if (positional.includes(propName)) continue
    const flag = `--${propName.replace(/_/g, '-')}`
    if (prop.type === 'boolean') {
      parts.push(`[${flag}]`)
    } else if (prop.enum) {
      parts.push(`[${flag} ${prop.enum.join('|')}]`)
    } else {
      parts.push(`[${flag} <${prop.type === 'array' ? `${propName}...` : propName}>]`)
    }
  }
  parts.push('[--format <fmt>] [--output <file>] [--max-cell <n>] [--max-bytes <n>] [--remote <target>]')
  return parts.join(' ')
}

/* ---------- internals ---------- */

/**
 * @param {Record<string, VerbInputProperty>} props
 * @param {string} flag
 * @returns {string | undefined}
 */
function resolveFlag(props, flag) {
  const snake = flag.replace(/-/g, '_')
  if (props[snake]) return snake
  if (props[flag]) return flag
  return undefined
}

/**
 * @param {VerbInputProperty} prop
 * @param {string} value
 * @param {string} label
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function coerceValue(prop, value, label) {
  switch (prop.type) {
    case 'integer': {
      const n = Number(value)
      const noun = prop.minimum === 1
        ? 'a positive integer'
        : prop.minimum !== undefined ? `an integer >= ${prop.minimum}` : 'an integer'
      if (!Number.isInteger(n) || (prop.minimum !== undefined && n < prop.minimum)) {
        return { ok: false, error: `${label} expects ${noun} (got ${value})` }
      }
      return { ok: true, value: n }
    }
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n)) return { ok: false, error: `${label} expects a number (got ${value})` }
      if (prop.minimum !== undefined && n < prop.minimum) {
        return { ok: false, error: `${label} expects a number >= ${prop.minimum} (got ${value})` }
      }
      return { ok: true, value: n }
    }
    case 'boolean':
      return { ok: true, value: value === 'true' }
    case 'array': {
      const itemType = prop.items?.type ?? 'string'
      /** @type {unknown[]} */
      const out = []
      for (const part of value.split(',')) {
        const p = part.trim()
        if (!p) continue
        const c = coerceValue({ type: itemType }, p, label)
        if (!c.ok) return c
        out.push(c.value)
      }
      return { ok: true, value: out }
    }
    case 'string':
    default:
      if (prop.enum && !prop.enum.includes(value)) {
        return { ok: false, error: `${label} expects ${prop.enum.join('|')} (got ${value})` }
      }
      return { ok: true, value }
  }
}

/**
 * @param {VerbInputSchema} inputSchema
 * @param {Record<string, VerbInputProperty>} props
 * @param {string[]} positionals
 * @param {Record<string, unknown>} params
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function bindPositionals(inputSchema, props, positionals, params) {
  const names = inputSchema.positional ?? []
  let pi = 0
  for (let k = 0; k < names.length; k += 1) {
    const name = names[k]
    const prop = props[name]
    if (!prop) return { ok: false, error: `schema error: positional '${name}' has no property` }
    if (params[name] !== undefined) continue
    const isLast = k === names.length - 1
    if (prop.greedy && isLast) {
      if (pi < positionals.length) {
        params[name] = positionals.slice(pi).join(' ')
        pi = positionals.length
      }
      continue
    }
    if (pi < positionals.length) {
      const c = coerceValue(prop, positionals[pi], name)
      if (!c.ok) return c
      params[name] = c.value
      pi += 1
    }
  }
  if (pi < positionals.length) {
    return { ok: false, error: `unexpected argument '${positionals[pi]}' (quote multi-word values)` }
  }
  return { ok: true }
}

/**
 * @param {Record<string, VerbInputProperty>} props
 * @param {Record<string, unknown>} params
 */
function applyDefaults(props, params) {
  for (const [name, prop] of Object.entries(props)) {
    if (params[name] === undefined && prop.default !== undefined) {
      params[name] = prop.default
    }
  }
}

/**
 * @param {VerbInputSchema} inputSchema
 * @param {Record<string, unknown>} params
 * @returns {string | undefined}
 */
function requiredMissing(inputSchema, params) {
  for (const name of inputSchema.required ?? []) {
    if (params[name] === undefined) return name
  }
  return undefined
}
