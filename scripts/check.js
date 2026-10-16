#!/usr/bin/env node

// The plugin repo's own checks, run by .github/workflows/validate.yml.
//
//   node scripts/check.js [cursor] [skills] [drift] [registry] [hygiene]
//   npx skills add . --list | node scripts/check.js skills-list
//
// With no step named, runs cursor, skills, drift, registry and hygiene.
// Each failure prints one line; any failure exits 1. Standard library only.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { SKILLS, readVersionFields, unpackSkills } from './sync-skills.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The one endpoint every manifest and the registry entry name. */
const ENDPOINT = 'https://api.hypaware.ai/v1/mcp'

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const URL_PATTERN = /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'`<>)\]]+/gi
const TOKEN_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/,
]
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

/** @type {string[]} */
const failures = []

/** @param {string} message */
function fail(message) {
  failures.push(message)
}

/**
 * @param {string} file repo-relative
 * @returns {any}
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
}

/**
 * Every file under `dir`, as paths relative to it, skipping `.git`.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  /** @param {string} rel */
  const visit = rel => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(child)
      else out.push(child)
    }
  }
  visit('')
  return out.sort()
}

// Cursor: the cursor/plugin-template checklist rules that apply here.
function checkCursor() {
  const plugin = readJson('.cursor-plugin/plugin.json')
  const market = readJson('.cursor-plugin/marketplace.json')
  if (!KEBAB.test(plugin.name ?? '')) fail(`.cursor-plugin/plugin.json: name ${JSON.stringify(plugin.name)} is not kebab-case`)
  if (!KEBAB.test(market.name ?? '')) fail(`.cursor-plugin/marketplace.json: name ${JSON.stringify(market.name)} is not kebab-case`)
  const listed = (market.plugins ?? []).map((/** @type {{ name?: string }} */ p) => p.name)
  if (!listed.includes(plugin.name)) fail(`.cursor-plugin/marketplace.json: plugins do not list ${JSON.stringify(plugin.name)}`)
  const declared = Object.keys(plugin.variables?.properties ?? {})
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp.json'), 'utf8')
  for (const [, name] of mcp.matchAll(/\$\{([^}]+)\}/g)) {
    if (!declared.includes(name)) fail(`mcp.json: \${${name}} is not declared in .cursor-plugin/plugin.json variables`)
  }
  for (const file of ['.cursor-plugin/plugin.json', '.cursor-plugin/marketplace.json', 'mcp.json']) checkHttps(file)
}

/**
 * Parse the flat `key: value` frontmatter of a SKILL.md: single-line scalars,
 * plain, single-quoted or double-quoted, as the shipped skills use.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0] !== '---') throw new Error('frontmatter must open with --- on line 1')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error('unterminated frontmatter')
  /** @type {Record<string, string>} */
  const out = {}
  for (const [i, line] of lines.slice(1, end).entries()) {
    const m = /^([A-Za-z][\w-]*):(?: (.*))?$/.exec(line)
    if (!m) throw new Error(`line ${i + 2}: not a flat "key: value" line`)
    const [, key, raw = ''] = m
    if (Object.hasOwn(out, key)) throw new Error(`line ${i + 2}: duplicate key ${key}`)
    out[key] = parseScalar(raw.trimEnd(), `line ${i + 2}`)
  }
  return out
}

/**
 * @param {string} value
 * @param {string} where
 * @returns {string}
 */
function parseScalar(value, where) {
  if (value === '') throw new Error(`${where}: empty value`)
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error(`${where}: unterminated single-quoted scalar`)
    const inner = value.slice(1, -1)
    if (/'(?!')/.test(inner.replaceAll("''", ''))) throw new Error(`${where}: stray single quote`)
    return inner.replaceAll("''", "'")
  }
  if (value.startsWith('"')) return JSON.parse(value)
  if (value.includes(': ') || value.includes(' #')) throw new Error(`${where}: plain scalar needs quoting`)
  return value
}

/**
 * Markdown link targets in `text`, outside fenced code and inline code spans.
 *
 * @param {string} text
 * @returns {string[]}
 */
function linkTargets(text) {
  const prose = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '')
  const inline = [...prose.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map(m => m[1])
  const defs = [...prose.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)].map(m => m[1])
  return [...inline, ...defs]
}

// Skills: frontmatter caps, and no link that leaves its own skill directory.
function checkSkills() {
  const skillsDir = path.join(ROOT, 'skills')
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      fail(`skills/${entry.name}: not a skill directory`)
      continue
    }
    const dir = path.join(skillsDir, entry.name)
    const skillFile = path.join(dir, 'SKILL.md')
    if (!fs.existsSync(skillFile)) {
      fail(`skills/${entry.name}: no SKILL.md`)
      continue
    }
    try {
      const { name, description } = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'))
      if (name !== entry.name) fail(`skills/${entry.name}/SKILL.md: name ${JSON.stringify(name)} does not match its directory`)
      if (!/^[a-z0-9-]{1,64}$/.test(name ?? '')) fail(`skills/${entry.name}/SKILL.md: name must be 1 to 64 characters of [a-z0-9-]`)
      if (!description || description.length > 1024) fail(`skills/${entry.name}/SKILL.md: description must be 1 to 1024 characters (is ${description?.length ?? 0})`)
    } catch (err) {
      fail(`skills/${entry.name}/SKILL.md: ${/** @type {Error} */ (err).message}`)
    }
    for (const rel of walk(dir).filter(f => f.endsWith('.md'))) {
      const fileDir = path.dirname(path.join(dir, rel))
      for (const target of linkTargets(fs.readFileSync(path.join(dir, rel), 'utf8'))) {
        if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
        const resolved = path.resolve(fileDir, decodeURIComponent(target.replace(/[?#].*$/, '')))
        const inside = path.relative(dir, resolved)
        if (inside.startsWith('..') || path.isAbsolute(inside)) fail(`skills/${entry.name}/${rel}: link ${target} leaves skills/${entry.name}/`)
      }
    }
  }
}

/**
 * The `skills` CLI's `add . --list` output must name exactly the shipped skills.
 *
 * @param {string} output
 */
function checkSkillsList(output) {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  const listed = [...plain.matchAll(/^│ {4}([a-z0-9-]+)\s*$/gm)].map(m => m[1]).sort()
  const want = [...SKILLS].sort()
  if (listed.join(',') !== want.join(',')) fail(`skills add --list names [${listed.join(', ')}], want [${want.join(', ')}]`)
}

/**
 * The pin is the Claude Code manifest's version; every other version field must equal it.
 *
 * @returns {string}
 */
function readPin() {
  const fields = readVersionFields()
  const pin = String(fields[0].value)
  for (const { field, value } of fields) {
    if (value !== pin) fail(`${field} is ${JSON.stringify(value)}, the pin is ${pin}`)
  }
  return pin
}

// Drift: skills/ is byte-identical to the pinned release's tarball.
function checkDrift() {
  const pin = readPin()
  const local = fs.readdirSync(path.join(ROOT, 'skills')).sort()
  if (local.join(',') !== [...SKILLS].sort().join(',')) fail(`skills/ holds [${local.join(', ')}], want [${[...SKILLS].sort().join(', ')}]`)
  const { tmp, skillsDir } = unpackSkills(pin)
  try {
    for (const name of SKILLS) {
      const ours = path.join(ROOT, 'skills', name)
      const theirs = path.join(skillsDir, name)
      const oursFiles = fs.existsSync(ours) ? walk(ours) : []
      const theirFiles = fs.existsSync(theirs) ? walk(theirs) : []
      for (const rel of theirFiles) {
        if (!oursFiles.includes(rel)) fail(`skills/${name}/${rel}: missing (hypaware@${pin} ships it)`)
        else if (!fs.readFileSync(path.join(ours, rel)).equals(fs.readFileSync(path.join(theirs, rel)))) fail(`skills/${name}/${rel}: differs from hypaware@${pin}`)
      }
      for (const rel of oursFiles) {
        if (!theirFiles.includes(rel)) fail(`skills/${name}/${rel}: extra (hypaware@${pin} does not ship it)`)
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// Registry entry: the rules the schema does not state.
function checkRegistry() {
  const pin = readPin()
  const server = readJson('registry/server.json')
  if (typeof server.description !== 'string' || server.description.length > 100) fail(`registry/server.json: description must be 100 characters or fewer (is ${server.description?.length})`)
  if (server.version !== pin) fail(`registry/server.json: version ${server.version} is not the pin ${pin}`)
  if (server.packages?.[0]?.version !== pin) fail(`registry/server.json: packages[0].version ${server.packages?.[0]?.version} is not the pin ${pin}`)
  const urls = {
    'registry/server.json remotes[0].url': server.remotes?.[0]?.url,
    '.mcp.json': readJson('.mcp.json').mcpServers?.hypaware?.url,
    'mcp.json': readJson('mcp.json').mcpServers?.hypaware?.url,
  }
  for (const [where, url] of Object.entries(urls)) {
    if (url !== ENDPOINT) fail(`${where}: url ${JSON.stringify(url)} is not ${ENDPOINT}`)
  }
  if (/localhost|127\.0\.0\.1|\[::1\]/i.test(fs.readFileSync(path.join(ROOT, 'registry/server.json'), 'utf8'))) fail('registry/server.json: names a local address')
}

/** @param {string} file repo-relative */
function checkHttps(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  for (const [url, scheme] of text.matchAll(URL_PATTERN)) {
    if (scheme.toLowerCase() !== 'https') fail(`${file}: ${url} is not https`)
  }
}

// Directory hygiene, kept for the Anthropic directory in Phase 3.
function checkHygiene() {
  const readme = path.join(ROOT, 'README.md')
  const words = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8').split(/\s+/).filter(Boolean).length : 0
  if (words < 40) fail(`README.md: ${words} words, want at least 40`)
  if (!fs.existsSync(path.join(ROOT, 'LICENSE'))) fail('LICENSE: missing')
  const ignore = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map(l => l.trim()) : []
  if (!ignore.includes('*.pem')) fail('.gitignore: does not list *.pem')
  for (const file of walk(ROOT)) {
    checkHttps(file)
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    if (TOKEN_PATTERNS.some(p => p.test(text))) fail(`${file}: holds a string shaped like a token`)
    if (PRIVATE_KEY.test(text)) fail(`${file}: holds a private key`)
  }
}

const STEPS = /** @type {Record<string, () => void>} */ ({
  cursor: checkCursor,
  skills: checkSkills,
  drift: checkDrift,
  registry: checkRegistry,
  hygiene: checkHygiene,
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  try {
    if (args.length === 1 && args[0] === 'skills-list') {
      checkSkillsList(fs.readFileSync(0, 'utf8'))
    } else {
      const steps = args.length ? args : Object.keys(STEPS)
      for (const step of steps) {
        if (!STEPS[step]) throw new Error(`unknown step ${step}; steps: ${Object.keys(STEPS).join(', ')}, skills-list`)
        STEPS[step]()
      }
    }
  } catch (err) {
    fail(/** @type {Error} */ (err).message)
  }
  for (const message of failures) process.stderr.write(`check: ${message}\n`)
  if (failures.length) process.exit(1)
  process.stdout.write(`check: ${args.join(' ') || Object.keys(STEPS).join(' ')} ok\n`)
}
