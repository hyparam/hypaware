// @ts-check

/**
 * Strict reader for the flat `key: value` frontmatter a shipped SKILL.md carries.
 *
 * Hosts parse that block with a real YAML parser (Pi calls `yaml.parse` and drops
 * the skill when it throws), but the repo has no YAML dependency, and a splitter on
 * the first `': '` accepts text YAML rejects: an unquoted value containing `': '`
 * reads as a nested mapping. So this accepts only the subset the skills use, flat
 * single-line scalars, and holds plain scalars to the YAML rules a real parser
 * enforces. Anything it cannot read is an error, never a silently skipped line.
 */

import fs from 'node:fs'

/** Characters that may not start a plain scalar (YAML 1.2 c-indicator). */
const INDICATORS = new Set(['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`'])

/** Double-quoted escapes the skills may use, mapped to the character they stand for. */
const ESCAPES = /** @type {Record<string, string>} */ ({ '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t' })

/**
 * Parse a SKILL.md's frontmatter into its keys and string values.
 *
 * @param {string} text the whole SKILL.md
 * @returns {Record<string, string>}
 */
export function parseSkillFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0] !== '---') throw new Error('frontmatter must open with --- on line 1')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error('unterminated frontmatter')
  /** @type {Record<string, string>} */
  const out = {}
  for (const [i, line] of lines.slice(1, end).entries()) {
    const where = `line ${i + 2}`
    const m = /^([A-Za-z][\w-]*):(?: (.*))?$/.exec(line)
    if (!m) throw new Error(`${where}: not a flat "key: value" line: ${JSON.stringify(line)}`)
    const [, key, raw = ''] = m
    if (Object.hasOwn(out, key)) throw new Error(`${where}: duplicate key ${key}`)
    out[key] = parseScalar(raw, where)
  }
  return out
}

/**
 * Read and parse a SKILL.md file's frontmatter, naming the file in any error.
 *
 * @param {string} file
 * @returns {Record<string, string>}
 */
export function readSkillFrontmatter(file) {
  try {
    return parseSkillFrontmatter(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file}: ${/** @type {Error} */ (err).message}`)
  }
}

/**
 * One single-line scalar: double-quoted, single-quoted, or plain.
 *
 * @param {string} raw the text after `key: `
 * @param {string} where
 * @returns {string}
 */
function parseScalar(raw, where) {
  const value = raw.trimEnd()
  if (value === '') throw new Error(`${where}: empty value`)
  if (value.startsWith('"')) return parseDoubleQuoted(value, where)
  if (value.startsWith("'")) return parseSingleQuoted(value, where)
  if (INDICATORS.has(value[0])) throw new Error(`${where}: a plain scalar may not start with ${JSON.stringify(value[0])}; quote it`)
  if (value.includes(': ') || value.endsWith(':')) throw new Error(`${where}: a plain scalar may not contain ": "; quote it`)
  if (value.includes(' #')) throw new Error(`${where}: " #" starts a comment in a plain scalar; quote it`)
  return value
}

/**
 * @param {string} value
 * @param {string} where
 * @returns {string}
 */
function parseDoubleQuoted(value, where) {
  let out = ''
  for (let i = 1; i < value.length; i++) {
    const c = value[i]
    if (c === '"') {
      if (i !== value.length - 1) throw new Error(`${where}: text after the closing double quote`)
      return out
    }
    if (c === '\\') {
      const escaped = ESCAPES[value[++i]]
      if (escaped === undefined) throw new Error(`${where}: unsupported escape \\${value[i] ?? ''}`)
      out += escaped
    } else {
      out += c
    }
  }
  throw new Error(`${where}: unterminated double-quoted scalar`)
}

/**
 * @param {string} value
 * @param {string} where
 * @returns {string}
 */
function parseSingleQuoted(value, where) {
  let out = ''
  for (let i = 1; i < value.length; i++) {
    const c = value[i]
    if (c !== "'") {
      out += c
    } else if (value[i + 1] === "'") {
      out += "'"
      i++
    } else {
      if (i !== value.length - 1) throw new Error(`${where}: text after the closing single quote`)
      return out
    }
  }
  throw new Error(`${where}: unterminated single-quoted scalar`)
}
