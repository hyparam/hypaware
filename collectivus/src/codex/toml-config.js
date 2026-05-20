import { CodexSettingsError } from './errors.js'

/**
 * @import { TomlMultilineStringDelimiter } from '../types.js'
 */

const PROVIDER_ID = 'collectivus'
const ROOT_BEGIN = '# BEGIN collectivus codex model_provider'
const ROOT_END = '# END collectivus codex model_provider'
const PROVIDER_BEGIN = '# BEGIN collectivus codex provider'
const PROVIDER_END = '# END collectivus codex provider'
const TOML_BASIC_MULTILINE_DELIMITER = '"""'
const TOML_LITERAL_MULTILINE_DELIMITER = '\'\'\''
const TOML_KEY_PART = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)`
const TOML_DOTTED_KEY = String.raw`${TOML_KEY_PART}(?:\s*\.\s*${TOML_KEY_PART})*`
const TOML_TABLE_HEADER_RE = new RegExp(String.raw`^\s*\[\s*${TOML_DOTTED_KEY}\s*\]\s*(?:#.*)?$`)
const TOML_TABLE_ARRAY_HEADER_RE = new RegExp(String.raw`^\s*\[\[\s*${TOML_DOTTED_KEY}\s*\]\]\s*(?:#.*)?$`)
const TOML_MODEL_PROVIDER_KEY = String.raw`(?:model_provider|"model_provider"|'model_provider')`
const TOML_MODEL_PROVIDERS_KEY = String.raw`(?:model_providers|"model_providers"|'model_providers')`
const TOML_COLLECTIVUS_PROVIDER_KEY = String.raw`(?:${PROVIDER_ID}|"${PROVIDER_ID}"|'${PROVIDER_ID}')`
const TOML_COLLECTIVUS_PROVIDER_DOTTED_KEY = String.raw`${TOML_MODEL_PROVIDERS_KEY}\s*\.\s*${TOML_COLLECTIVUS_PROVIDER_KEY}(?:\s*\.\s*${TOML_KEY_PART})*`
const TOML_MODEL_PROVIDERS_TABLE_HEADER_RE = new RegExp(String.raw`^\s*\[\s*${TOML_MODEL_PROVIDERS_KEY}\s*\]\s*(?:#.*)?$`)
const TOML_COLLECTIVUS_PROVIDER_TABLE_HEADER_RE = new RegExp(String.raw`^\s*\[\s*${TOML_COLLECTIVUS_PROVIDER_DOTTED_KEY}\s*\]\s*(?:#.*)?$`)
const TOML_COLLECTIVUS_PROVIDER_TABLE_ARRAY_HEADER_RE = new RegExp(String.raw`^\s*\[\[\s*${TOML_COLLECTIVUS_PROVIDER_DOTTED_KEY}\s*\]\]\s*(?:#.*)?$`)
const TOML_COLLECTIVUS_PROVIDER_DOTTED_ASSIGNMENT_RE = new RegExp(String.raw`^\s*${TOML_COLLECTIVUS_PROVIDER_DOTTED_KEY}\s*=`)
const TOML_COLLECTIVUS_PROVIDER_CHILD_ASSIGNMENT_RE = new RegExp(String.raw`^\s*${TOML_COLLECTIVUS_PROVIDER_KEY}(?:\s*\.\s*${TOML_KEY_PART})*\s*=`)
const TOML_ROOT_MODEL_PROVIDER_RE = new RegExp(String.raw`^\s*${TOML_MODEL_PROVIDER_KEY}\s*=`)

/**
 * @param {string} content
 * @param {number} port
 * @param {string} version
 * @returns {{ content: string, prevValue?: string }}
 */
export function prepareAttach(content, port, version) {
  let lines = splitLines(content)
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
    '[model_providers.collectivus]',
    `name = ${tomlString('Collectivus OpenAI Proxy')}`,
    `base_url = ${tomlString(`http://127.0.0.1:${port}/v1`)}`,
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
  if (!hadRoot && !hadProvider) return { changed: false }

  const previous = readPreviousModelProvider(lines)
  const removed = readManagedProviderBaseUrl(lines)

  let next = removeMarkedBlock(lines, ROOT_BEGIN, ROOT_END)
  next = removeMarkedBlock(next, PROVIDER_BEGIN, PROVIDER_END)
  next = removeProviderTable(next)
  next = removeProviderDottedAssignments(next)

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
 * @returns {string}
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
 * @returns {void}
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
  /** @type {TomlMultilineStringDelimiter | undefined} */
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
  /** @type {TomlMultilineStringDelimiter | undefined} */
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

/**
 * @param {string[]} lines
 * @returns {number}
 */
function findFirstTableIndex(lines) {
  return findNextTableIndex(lines, 0)
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @returns {number}
 */
function findNextTableIndex(lines, start) {
  /** @type {TomlMultilineStringDelimiter | undefined} */
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
    if (isCollectivusProviderTableHeader(lines[tableIndex])) {
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
  /** @type {TomlMultilineStringDelimiter | undefined} */
  let multilineDelimiter
  /** @type {TomlMultilineStringDelimiter | undefined} */
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
      table = TOML_MODEL_PROVIDERS_TABLE_HEADER_RE.test(line) ? 'model_providers' : 'other'
      next.push(line)
      continue
    }
    if (
      table === 'root' && TOML_COLLECTIVUS_PROVIDER_DOTTED_ASSIGNMENT_RE.test(line)
      || table === 'model_providers' && TOML_COLLECTIVUS_PROVIDER_CHILD_ASSIGNMENT_RE.test(line)
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
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== begin) {
      next.push(lines[i])
      continue
    }
    let foundEnd = false
    for (i++; i < lines.length; i++) {
      if (lines[i].trim() === end) {
        foundEnd = true
        break
      }
    }
    if (!foundEnd) {
      throw new CodexSettingsError('unterminated collectivus-managed Codex config block', {
        code: 'MALFORMED_MARKER',
      })
    }
  }
  return next
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 * @returns {boolean}
 */
function hasMarkedBlock(lines, begin, end) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== begin) continue
    for (i++; i < lines.length; i++) {
      if (lines[i].trim() === end) return true
    }
    throw new CodexSettingsError('unterminated collectivus-managed Codex config block', {
      code: 'MALFORMED_MARKER',
    })
  }
  return false
}

/**
 * @param {string[]} lines
 * @returns {string | undefined}
 */
function readPreviousModelProvider(lines) {
  return readCommentedString(lines, ROOT_BEGIN, ROOT_END, 'previous_model_provider')
}

/**
 * @param {string[]} lines
 * @returns {string | undefined}
 */
function readManagedProviderBaseUrl(lines) {
  return readAssignmentInBlock(lines, PROVIDER_BEGIN, PROVIDER_END, 'base_url')
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 * @param {string} key
 * @returns {string | undefined}
 */
function readCommentedString(lines, begin, end, key) {
  const re = new RegExp(`^#\\s*${escapeRegExp(key)}\\s*=\\s*(.+)$`)
  let inside = false
  for (const line of lines) {
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
 * @returns {string | undefined}
 */
function readAssignmentInBlock(lines, begin, end, key) {
  let inside = false
  for (const line of lines) {
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

/**
 * @param {string} line
 * @returns {string | undefined}
 */
function parseRootModelProvider(line) {
  if (!isRootModelProviderLine(line)) return undefined
  return parseAssignmentString(line)
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isRootModelProviderLine(line) {
  return TOML_ROOT_MODEL_PROVIDER_RE.test(line)
}

/**
 * @param {string} line
 * @returns {string | undefined}
 */
function parseAssignmentString(line) {
  const index = line.indexOf('=')
  if (index === -1) return undefined
  return parseTomlString(line.slice(index + 1))
}

/**
 * @param {string} value
 * @returns {string | undefined}
 */
function parseTomlString(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^"(?:\\.|[^"\\])*"/)
    if (!match) return undefined
    try {
      return JSON.parse(match[0])
    } catch {
      return undefined
    }
  }
  if (trimmed.startsWith('\'')) {
    const match = trimmed.match(/^'([^']*)'/)
    return match ? match[1] : undefined
  }
  return undefined
}

/**
 * @param {string} value
 * @returns {string}
 */
function tomlString(value) {
  return JSON.stringify(value)
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isTableHeader(line) {
  return TOML_TABLE_HEADER_RE.test(line) || TOML_TABLE_ARRAY_HEADER_RE.test(line)
}

/**
 * @param {string} line
 * @returns {TomlMultilineStringDelimiter | undefined}
 */
function openMultilineString(line) {
  const trimmed = assignmentValue(line) ?? line.trimStart()
  if (trimmed.startsWith(TOML_BASIC_MULTILINE_DELIMITER)) {
    return hasClosingMultilineString(trimmed.slice(3), TOML_BASIC_MULTILINE_DELIMITER)
      ? undefined
      : TOML_BASIC_MULTILINE_DELIMITER
  }
  if (trimmed.startsWith(TOML_LITERAL_MULTILINE_DELIMITER)) {
    return hasClosingMultilineString(trimmed.slice(3), TOML_LITERAL_MULTILINE_DELIMITER)
      ? undefined
      : TOML_LITERAL_MULTILINE_DELIMITER
  }
  return undefined
}

/**
 * @param {string} line
 * @param {TomlMultilineStringDelimiter} delimiter
 * @returns {TomlMultilineStringDelimiter | undefined}
 */
function closeMultilineString(line, delimiter) {
  return hasClosingMultilineString(line, delimiter) ? undefined : delimiter
}

/**
 * @param {string} line
 * @returns {string | undefined}
 */
function assignmentValue(line) {
  if (/^\s*#/.test(line)) return undefined
  const index = line.indexOf('=')
  return index === -1 ? undefined : line.slice(index + 1).trimStart()
}

/**
 * @param {string} value
 * @param {TomlMultilineStringDelimiter} delimiter
 * @returns {boolean}
 */
function hasClosingMultilineString(value, delimiter) {
  if (delimiter === TOML_LITERAL_MULTILINE_DELIMITER) return value.includes(delimiter)
  for (let index = value.indexOf(delimiter); index !== -1; index = value.indexOf(delimiter, index + 1)) {
    if (!isEscaped(value, index)) return true
  }
  return false
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {boolean}
 */
function isEscaped(value, index) {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 1
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isCollectivusProviderTableHeader(line) {
  return TOML_COLLECTIVUS_PROVIDER_TABLE_HEADER_RE.test(line)
    || TOML_COLLECTIVUS_PROVIDER_TABLE_ARRAY_HEADER_RE.test(line)
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
