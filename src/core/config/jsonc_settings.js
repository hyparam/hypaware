// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteFile } from '../util/fs_atomic.js'

// A token-based editor preserves comments, whitespace and unrelated values.
// Dotted VS Code setting names are literal keys, never object paths.
/** @param {string} text */
function tokens(text) {
  const result = []
  const re = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gy
  let offset = 0
  while (offset < text.length) {
    re.lastIndex = offset
    const match = re.exec(text)
    if (!match) throw new Error('settings_invalid_jsonc')
    offset = re.lastIndex
    if (!/^\s|^\//.test(match[0])) result.push({ value: match[0], start: match.index, end: offset })
  }
  return result
}

/** @param {string} text */
export function parseSettings(text) {
  const all = tokens(text)
  const cleaned = all.filter((token, i) => token.value !== ',' || !['}', ']'].includes(all[i + 1]?.value)).map(t => t.value).join('')
  const value = JSON.parse(cleaned)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings_not_object')
  const properties = new Map()
  let depth = 0
  for (let i = 0; i < all.length; i++) {
    const token = all[i]
    if (token.value === '{' || token.value === '[') depth++
    else if (token.value === '}' || token.value === ']') depth--
    else if (depth === 1 && token.value.startsWith('"') && all[i + 1]?.value === ':') {
      const key = JSON.parse(token.value)
      if (properties.has(key)) throw new Error('settings_duplicate_key')
      let j = i + 2
      let nested = 0
      for (; j < all.length; j++) {
        const v = all[j].value
        if (nested === 0 && (v === ',' || v === '}')) break
        if (v === '{' || v === '[') nested++
        if (v === '}' || v === ']') nested--
      }
      properties.set(key, { start: token.start, valueStart: all[i + 2].start, end: all[j - 1].end,
        commaAfter: all[j]?.value === ',' ? all[j] : undefined,
        commaBefore: all[i - 1]?.value === ',' ? all[i - 1] : undefined })
      i = j - 1
    }
  }
  return { value, properties, close: all.at(-1).start }
}

/** @param {string} text @param {string} key @param {unknown} value undefined removes a key */
export function editSetting(text, key, value) {
  const parsed = parseSettings(text)
  const property = parsed.properties.get(key)
  if (property) {
    if (value !== undefined) return text.slice(0, property.valueStart) + JSON.stringify(value) + text.slice(property.end)
    const start = property.commaAfter ? property.start : property.commaBefore?.start ?? property.start
    const end = property.commaAfter?.end ?? property.end
    return text.slice(0, start) + text.slice(end)
  }
  if (value === undefined) return text
  const last = [...parsed.properties.values()].at(-1)
  const comma = last && !last.commaAfter ? ',' : ''
  const position = last && comma ? last.end : parsed.close
  let next = text.slice(0, position) + comma + text.slice(position)
  const close = parseSettings(next).close
  return next.slice(0, close) + `\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}\n` + next.slice(close)
}

/** @param {string} file */
export async function readSettings(file) {
  try {
    const handle = await fs.open(file, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('settings_size_limit')
      const buffer = Buffer.alloc(Math.min(stat.size + 1, 1024 * 1024 + 1))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > stat.size) throw new Error('settings_changed')
      const text = buffer.toString('utf8', 0, bytesRead)
      return { text, mtimeMs: stat.mtimeMs, value: parseSettings(text).value }
    } finally { await handle.close() }
  } catch (err) {
    if (err?.code === 'ENOENT') return { text: '{}\n', value: {}, mtimeMs: undefined }
    throw err
  }
}

/**
 * @param {unknown} records Self-describing settings-file undo records
 * @returns {Promise<string[]>}
 * @ref LLP 0549#attachment: disk-only detach restores only settings we still own
 */
export async function restoreSettingsFiles(records) {
  if (records === undefined) return []
  if (!Array.isArray(records) || records.length > 64) throw new Error('settings_undo_invalid')
  const warnings = []
  for (const record of records) {
    if (!record || typeof record.path !== 'string' || !path.isAbsolute(record.path) || !record.managed || typeof record.managed !== 'object') throw new Error('settings_undo_invalid')
    const read = await readSettings(record.path)
    let text = read.text
    for (const [key, expected] of Object.entries(record.managed)) {
      if (JSON.stringify(read.value[key]) === JSON.stringify(expected)) {
        text = editSetting(text, key, Object.hasOwn(record.previous ?? {}, key) ? record.previous[key] : undefined)
      } else warnings.push(`${key} was overridden externally; leaving in place`)
    }
    if (text !== read.text) await atomicWriteFile(record.path, text, { expectedMtimeMs: read.mtimeMs })
  }
  return warnings
}
