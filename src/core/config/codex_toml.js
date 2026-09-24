// @ts-check

export class CodexSettingsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'CodexSettingsError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * TOML editor for Codex's `config.toml`. Owns the `hypaware` managed
 * provider block delimited by `# BEGIN hypaware codex …` markers.
 *
 * Public API:
 *  - `prepareAttach(content, port, version, opts?)` → `{ content, prevValue? }`
 *  - `prepareDetach(content)` → `{ changed, content?, removed?, restoredValue?, warning? }`
 *  - `isManagedAttached(content)` → boolean
 */

const PROVIDER_ID = 'hypaware'
const ROOT_BEGIN = '# BEGIN hypaware codex model_provider'
const ROOT_END = '# END hypaware codex model_provider'
const PROVIDER_BEGIN = '# BEGIN hypaware codex provider'
const PROVIDER_END = '# END hypaware codex provider'
const TOML_KEY_PART = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)`
const TOML_DOTTED_KEY = String.raw`${TOML_KEY_PART}(?:\s*\.\s*${TOML_KEY_PART})*`
const TOML_TABLE_HEADER_RE = new RegExp(String.raw`^\s*\[\s*(${TOML_DOTTED_KEY})\s*\]\s*(?:#.*)?$`)
const TOML_TABLE_ARRAY_HEADER_RE = new RegExp(String.raw`^\s*\[\[\s*(${TOML_DOTTED_KEY})\s*\]\]\s*(?:#.*)?$`)
const TOML_ASSIGNMENT_RE = new RegExp(String.raw`^\s*(${TOML_DOTTED_KEY})\s*=`)
const TOML_KEY_PART_RE = new RegExp(TOML_KEY_PART, 'g')

/**
 * @param {string} content
 * @param {number} port
 * @param {string} version
 * @param {{ baseUrl?: string, providerName?: string }} [opts]
 * @returns {{ content: string, prevValue?: string }}
 */
export function prepareAttach(content, port, version, opts = {}) {
  let lines = expandInlineProviderMap(splitLines(content))
  const previousFromMarker = readPreviousModelProvider(lines)
  lines = removeMarkedBlock(lines, ROOT_BEGIN, ROOT_END)
  lines = removeMarkedBlock(lines, PROVIDER_BEGIN, PROVIDER_END)

  const root = removeRootModelProvider(lines)
  lines = root.lines
  lines = removeProviderTable(lines)
  lines = removeProviderDottedAssignments(lines)

  const prevValue = root.prevValue ?? previousFromMarker
  const now = new Date().toISOString()
  const rootBlock = [
    ROOT_BEGIN,
    `# attached_at = ${tomlString(now)}`,
    `# version = ${tomlString(version)}`,
    `# port = ${port}`,
  ]
  if (prevValue !== undefined) {
    rootBlock.push(`# previous_model_provider = ${tomlString(prevValue)}`)
  }
  rootBlock.push(`model_provider = ${tomlString(PROVIDER_ID)}`, ROOT_END)
  insertRootLines(lines, rootBlock)

  const providerBlock = [
    PROVIDER_BEGIN,
    `[model_providers.${PROVIDER_ID}]`,
    `name = ${tomlString(opts.providerName ?? 'HypAware Codex Gateway')}`,
    `base_url = ${tomlString(opts.baseUrl ?? `http://127.0.0.1:${port}/backend-api/codex`)}`,
    'requires_openai_auth = true',
    'wire_api = "responses"',
    'supports_websockets = false',
    PROVIDER_END,
  ]
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
  lines.push(...providerBlock)

  /** @type {{ content: string, prevValue?: string }} */
  const result = { content: formatLines(lines) }
  if (prevValue !== undefined) result.prevValue = prevValue
  return result
}

/**
 * @param {string} content
 * @returns {{ changed: false } | { changed: true, content: string, removed?: string, restoredValue?: string, warning?: string }}
 */
export function prepareDetach(content) {
  const lines = splitLines(content)
  const hadRoot = hasMarkedBlock(lines, ROOT_BEGIN, ROOT_END)
  const hadProvider = hasMarkedBlock(lines, PROVIDER_BEGIN, PROVIDER_END)
  if (!hadRoot && !hadProvider && hasProvider(lines)) return { changed: false }

  const previous = readPreviousModelProvider(lines)
  const removed = readManagedProviderBaseUrl(lines)

  let next = removeMarkedBlock(expandInlineProviderMap(lines), ROOT_BEGIN, ROOT_END)
  next = removeMarkedBlock(next, PROVIDER_BEGIN, PROVIDER_END)

  /** @type {string | undefined} */
  let restoredValue
  /** @type {string | undefined} */
  let warning
  if (previous !== undefined) {
    const current = readRootModelProvider(next)
    if (current === undefined) {
      insertRootLines(next, [`model_provider = ${tomlString(previous)}`])
      restoredValue = previous
    } else if (current !== previous) {
      warning = `model_provider was changed externally; leaving ${current} in place`
    }
  }

  // Saved sessions retain the provider ID. A missing base_url lets Codex
  // choose its native ChatGPT or API endpoint from the current login.
  // @ref LLP 0432#compatibility [implements]: add-only repair also covers 1.38.0's markerless migration
  if (!hasProvider(next)) {
    if (next.length && next[next.length - 1] !== '') next.push('')
    next.push(
      '[model_providers.hypaware]',
      'name = "OpenAI"',
      'requires_openai_auth = true',
      'wire_api = "responses"',
      'supports_websockets = true',
      '# Compatibility for saved Codex chats previously captured by HypAware.',
    )
  }

  /** @type {{ changed: true, content: string, removed?: string, restoredValue?: string, warning?: string }} */
  const result = { changed: true, content: formatLines(next) }
  if (removed !== undefined) result.removed = removed
  if (restoredValue !== undefined) result.restoredValue = restoredValue
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * @param {string} content
 * @returns {boolean}
 */
export function isManagedAttached(content) {
  const lines = splitLines(content)
  return hasMarkedBlock(lines, ROOT_BEGIN, ROOT_END)
    && hasMarkedBlock(lines, PROVIDER_BEGIN, PROVIDER_END)
}

/**
 * @param {string} content
 * @returns {string[]}
 */
function splitLines(content) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * @param {string[]} lines
 */
function formatLines(lines) {
  let start = 0
  let end = lines.length
  while (start < end && lines[start] === '') start++
  while (end > start && lines[end - 1] === '') end--
  const out = lines.slice(start, end)
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

/**
 * @param {string[]} lines
 * @param {string[]} insert
 */
function insertRootLines(lines, insert) {
  let index = findFirstTableIndex(lines)
  if (index === lines.length) {
    while (index > 0 && lines[index - 1] === '') index--
  }
  lines.splice(index, 0, ...insert)
}

/**
 * @param {string[]} lines
 * @returns {{ lines: string[], prevValue?: string }}
 */
function removeRootModelProvider(lines) {
  const firstTable = findFirstTableIndex(lines)
  /** @type {string[]} */
  const next = []
  /** @type {string | undefined} */
  let prevValue
  /** @type {string | undefined} */
  let multilineDelimiter

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i < firstTable && multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(line, multilineDelimiter)
      next.push(line)
      continue
    }
    if (i < firstTable && isRootModelProviderLine(line)) {
      if (prevValue === undefined) prevValue = parseAssignmentString(line)
      continue
    }
    next.push(line)
    if (i < firstTable) {
      multilineDelimiter = openMultilineString(line)
    }
  }

  /** @type {{ lines: string[], prevValue?: string }} */
  const result = { lines: next }
  if (prevValue !== undefined) result.prevValue = prevValue
  return result
}

/**
 * @param {string[]} lines
 * @returns {string | undefined}
 */
function readRootModelProvider(lines) {
  const firstTable = findFirstTableIndex(lines)
  /** @type {string | undefined} */
  let multilineDelimiter
  for (let i = 0; i < firstTable; i++) {
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(lines[i], multilineDelimiter)
      continue
    }
    const parsed = parseRootModelProvider(lines[i])
    if (parsed !== undefined) return parsed
    multilineDelimiter = openMultilineString(lines[i])
  }
  return undefined
}

/** @param {string[]} lines */
function findFirstTableIndex(lines) {
  return findNextTableIndex(lines, 0)
}

/**
 * @param {string[]} lines
 * @param {number} start
 */
function findNextTableIndex(lines, start) {
  /** @type {string | undefined} */
  let multilineDelimiter
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(line, multilineDelimiter)
      continue
    }
    if (isTableHeader(line)) return i
    multilineDelimiter = openMultilineString(line)
  }
  return lines.length
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function removeProviderTable(lines) {
  /** @type {string[]} */
  const next = []
  for (let i = 0; i < lines.length; i++) {
    const tableIndex = findNextTableIndex(lines, i)
    if (tableIndex === lines.length) {
      next.push(...lines.slice(i))
      break
    }
    next.push(...lines.slice(i, tableIndex))
    if (isManagedProviderTableHeader(lines[tableIndex])) {
      i = findNextTableIndex(lines, tableIndex + 1) - 1
      continue
    }
    next.push(lines[tableIndex])
    i = tableIndex
  }
  return next
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function removeProviderDottedAssignments(lines) {
  /** @type {string[]} */
  const next = []
  /** @type {'root' | 'model_providers' | 'other'} */
  let table = 'root'
  /** @type {string | undefined} */
  let multilineDelimiter
  /** @type {string | undefined} */
  let removedMultilineDelimiter

  for (const line of lines) {
    if (removedMultilineDelimiter !== undefined) {
      removedMultilineDelimiter = closeMultilineString(line, removedMultilineDelimiter)
      continue
    }
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(line, multilineDelimiter)
      next.push(line)
      continue
    }
    if (isTableHeader(line)) {
      table = hasKeyPrefix(TOML_TABLE_HEADER_RE.exec(line)?.[1], ['model_providers'], true) ? 'model_providers' : 'other'
      next.push(line)
      continue
    }
    if (
      (table === 'root' && hasKeyPrefix(TOML_ASSIGNMENT_RE.exec(line)?.[1], ['model_providers', PROVIDER_ID]))
      || (table === 'model_providers' && hasKeyPrefix(TOML_ASSIGNMENT_RE.exec(line)?.[1], [PROVIDER_ID]))
    ) {
      removedMultilineDelimiter = openMultilineString(line)
      continue
    }
    next.push(line)
    multilineDelimiter = openMultilineString(line)
  }
  return next
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 * @returns {string[]}
 */
function removeMarkedBlock(lines, begin, end) {
  /** @type {string[]} */
  const next = []
  let inside = false
  let root = true
  // Ownership follows the provider namespace even when a descendant table
  // appears outside the comments or after unrelated tables.
  let ownsProviderNamespace = false
  if (begin === PROVIDER_BEGIN) {
    for (const line of syntaxLines(lines)) {
      if (line.trim() === begin) inside = true
      else if (line.trim() === end) inside = false
      else if (inside && isManagedProviderTableHeader(line)) ownsProviderNamespace = true
    }
    inside = false
  }
  let ownedProvider = false
  /** @type {string | undefined} */
  let multilineDelimiter
  for (const line of lines) {
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(line, multilineDelimiter)
      if (!ownedProvider) next.push(line)
      continue
    }
    const trimmed = line.trim()
    if (trimmed === begin) {
      inside = true
      continue
    }
    if (trimmed === end && inside) {
      inside = false
      continue
    }
    if (isTableHeader(line)) {
      root = false
      ownedProvider = ownsProviderNamespace && isManagedProviderTableHeader(line)
    }
    multilineDelimiter = openMultilineString(line)
    // Markers are comments, not TOML scope: Codex may insert unrelated root
    // keys and whole tables between them. Only the managed keys are ours.
    // @ref LLP 0432#ownership [implements]
    if (ownedProvider) continue
    if (inside && begin === ROOT_BEGIN) {
      if (/^#\s*(attached_at|version|port|previous_model_provider)\s*=/.test(trimmed)) continue
      if (root && parseRootModelProvider(line) === PROVIDER_ID) continue
    }
    next.push(line)
  }
  if (inside) {
    throw new CodexSettingsError('unterminated hypaware-managed Codex config block', { code: 'MALFORMED_MARKER' })
  }
  return next
}

/** @param {string[]} lines */
function hasProvider(lines) {
  // Reuse the syntax-aware ownership readers, including quoted/dotted keys
  // and inline entries. Never overwrite an existing unmarked provider.
  return removeProviderTable(lines).length !== lines.length
    || removeProviderDottedAssignments(lines).length !== lines.length
    || (findInlineProviderMap(lines)?.entries.some(entry => {
      const key = TOML_ASSIGNMENT_RE.exec(entry.slice(inlineKeyStart(entry)))?.[1]
      return hasKeyPrefix(key, [PROVIDER_ID])
    }) ?? false)
}

/**
 * An inline table cannot be extended with a later [model_providers.hypaware]
 * header. Expand its entries into equivalent root dotted assignments first,
 * retaining each value verbatim. This also lets explicit gateway attach reuse
 * the existing provider replacement logic without writing duplicate tables.
 * @ref LLP 0432#ownership [implements]: preserve inline provider values while repairing a missing child
 * @param {string[]} lines
 */
function expandInlineProviderMap(lines) {
  const map = findInlineProviderMap(lines)
  if (!map) return lines
  const expanded = map.entries.map(entry => {
    const start = inlineKeyStart(entry)
    if (start === entry.length) return entry
    return entry.slice(0, start) + map.key + '.' + entry.slice(start)
  }).join('\n')
  return splitLines(map.text.slice(0, map.start) + expanded + map.text.slice(map.end))
}

/** @param {string[]} lines */
function findInlineProviderMap(lines) {
  let offset = 0
  let multiline
  for (const line of lines) {
    if (multiline !== undefined) multiline = closeMultilineString(line, multiline)
    else {
      if (isTableHeader(line)) return undefined
      const match = TOML_ASSIGNMENT_RE.exec(line)
      if (match && hasKeyPrefix(match[1], ['model_providers'], true)) {
        const text = lines.join('\n')
        let start = offset + match[0].length
        while (/\s/.test(text[start] ?? '') && start < text.length) start++
        if (text[start] !== '{') throw new CodexSettingsError('model_providers must be a TOML table', { code: 'INVALID_TOML' })
        const { entries, end } = readInlineEntries(text, start)
        return { text, start: offset, end, key: match[1], entries }
      }
      multiline = openMultilineString(line)
    }
    offset += line.length + 1
  }
  return undefined
}

/**
 * Split only at this table's commas. Strings, nested tables, arrays and
 * comments are opaque: braces or commas in a header value are not syntax.
 * @param {string} text
 * @param {number} start
 */
function readInlineEntries(text, start) {
  /** @type {string[]} */
  const entries = []
  const stack = ['}']
  let entryStart = start + 1
  let quote = ''
  for (let i = entryStart; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (text.startsWith(quote, i) && (quote[0] === "'" || !isEscaped(text, i))) {
        i += quote.length - 1
        // TOML permits one or two quotes just before the closing triple.
        if (quote.length === 3) while (text[i + 1] === quote[0]) i++
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = text.startsWith(char.repeat(3), i) ? char.repeat(3) : char
      i += quote.length - 1
    } else if (char === '#') {
      const newline = text.indexOf('\n', i)
      if (newline < 0) break
      i = newline
    } else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']')
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) break
      if (stack.length === 0) {
        const entry = text.slice(entryStart, i).trim()
        if (entry) entries.push(entry)
        return { entries, end: i + 1 }
      }
    } else if (char === ',' && stack.length === 1) {
      entries.push(text.slice(entryStart, i).trim())
      entryStart = i + 1
    }
  }
  throw new CodexSettingsError('unterminated or malformed inline model_providers table', { code: 'INVALID_TOML' })
}

/** Skip leading whitespace/comments without changing the entry's value. @param {string} entry */
function inlineKeyStart(entry) {
  let i = 0
  while (i < entry.length) {
    if (/\s/.test(entry[i])) i++
    else if (entry[i] === '#') {
      const end = entry.indexOf('\n', i)
      i = end < 0 ? entry.length : end + 1
    } else break
  }
  return i
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 */
function hasMarkedBlock(lines, begin, end) {
  let inside = false
  for (const line of syntaxLines(lines)) {
    if (line.trim() === begin) inside = true
    if (inside && line.trim() === end) return true
  }
  if (inside) throw new CodexSettingsError('unterminated hypaware-managed Codex config block', { code: 'MALFORMED_MARKER' })
  return false
}

/**
 * Lines that are not the contents of a multiline string.
 * @param {string[]} lines
 */
function* syntaxLines(lines) {
  /** @type {string | undefined} */
  let delimiter
  for (const line of lines) {
    if (delimiter !== undefined) {
      delimiter = closeMultilineString(line, delimiter)
      continue
    }
    yield line
    delimiter = openMultilineString(line)
  }
}

/**
 * @param {string[]} lines
 */
function readPreviousModelProvider(lines) {
  return readCommentedString(lines, ROOT_BEGIN, ROOT_END, 'previous_model_provider')
}

/**
 * @param {string[]} lines
 */
function readManagedProviderBaseUrl(lines) {
  return readAssignmentInBlock(lines, PROVIDER_BEGIN, PROVIDER_END, 'base_url')
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 * @param {string} key
 */
function readCommentedString(lines, begin, end, key) {
  const re = new RegExp(`^#\\s*${escapeRegExp(key)}\\s*=\\s*(.+)$`)
  let inside = false
  for (const line of syntaxLines(lines)) {
    const trimmed = line.trim()
    if (trimmed === begin) {
      inside = true
      continue
    }
    if (inside && trimmed === end) return undefined
    if (!inside) continue
    const match = line.match(re)
    if (!match) continue
    return parseTomlString(match[1])
  }
  return undefined
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 * @param {string} key
 */
function readAssignmentInBlock(lines, begin, end, key) {
  let inside = false
  for (const line of syntaxLines(lines)) {
    const trimmed = line.trim()
    if (trimmed === begin) {
      inside = true
      continue
    }
    if (inside && trimmed === end) return undefined
    if (!inside || !new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) continue
    return parseAssignmentString(line)
  }
  return undefined
}

/** @param {string} line */
function parseRootModelProvider(line) {
  if (!isRootModelProviderLine(line)) return undefined
  return parseAssignmentString(line)
}

/** @param {string} line */
function isRootModelProviderLine(line) {
  return hasKeyPrefix(TOML_ASSIGNMENT_RE.exec(line)?.[1], ['model_provider'], true)
}

/** @param {string} line */
function parseAssignmentString(line) {
  const index = line.indexOf('=')
  if (index === -1) return undefined
  return parseTomlString(line.slice(index + 1))
}

/** @param {string} value */
function parseTomlString(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^"(?:\\.|[^"\\])*"/)
    if (!match) return undefined
    try {
      // JSON and TOML share basic escapes, except TOML also accepts \U.
      // Consume escaped backslashes too, so a literal \\U stays literal.
      const normalized = match[0].replace(/\\(?:U([0-9a-fA-F]{8})|.)/g, (escape, hex) =>
        hex ? JSON.stringify(String.fromCodePoint(Number.parseInt(hex, 16))).slice(1, -1) : escape)
      return JSON.parse(normalized)
    } catch { return undefined }
  }
  if (trimmed.startsWith('\'')) {
    const match = trimmed.match(/^'([^']*)'/)
    return match ? match[1] : undefined
  }
  return undefined
}

/** @param {string} value */
function tomlString(value) {
  return JSON.stringify(value)
}

/** @param {string} line */
function isTableHeader(line) {
  return TOML_TABLE_HEADER_RE.test(line) || TOML_TABLE_ARRAY_HEADER_RE.test(line)
}

/** @param {string} line */
function openMultilineString(line) {
  return scanStringState(line)
}

/**
 * @param {string} line
 * @param {string} delimiter
 */
function closeMultilineString(line, delimiter) {
  return scanStringState(line, delimiter)
}

/**
 * Track strings even inside inline tables/arrays, where header-looking lines
 * are still value text. Ordinary strings and comments cannot open a triple.
 * @param {string} line
 * @param {string} [quote]
 */
function scanStringState(line, quote = '') {
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote) {
      if (line.startsWith(quote, i) && (quote[0] === "'" || !isEscaped(line, i))) {
        i += quote.length - 1
        if (quote.length === 3) while (line[i + 1] === quote[0]) i++
        quote = ''
      }
    } else if (char === '#') break
    else if (char === '"' || char === "'") {
      quote = line.startsWith(char.repeat(3), i) ? char.repeat(3) : char
      i += quote.length - 1
    }
  }
  return quote.length === 3 ? quote : undefined
}

/**
 * @param {string} value
 * @param {number} index
 */
function isEscaped(value, index) {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 1
}

/** @param {string} line */
function isManagedProviderTableHeader(line) {
  const key = (TOML_TABLE_HEADER_RE.exec(line) ?? TOML_TABLE_ARRAY_HEADER_RE.exec(line))?.[1]
  return hasKeyPrefix(key, ['model_providers', PROVIDER_ID])
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compare decoded TOML key segments without changing their source spelling.
 * @param {string | undefined} key
 * @param {string[]} prefix
 * @param {boolean} [exact]
 */
function hasKeyPrefix(key, prefix, exact = false) {
  if (key === undefined) return false
  const parts = key.match(TOML_KEY_PART_RE) ?? []
  return (!exact || parts.length === prefix.length) && prefix.every((part, i) =>
    parts[i] === part || (parts[i] !== undefined && parseTomlString(parts[i]) === part))
}
