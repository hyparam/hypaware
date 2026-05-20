import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * @import {
 *   SkillInstallClient,
 *   SkillInstallDestination,
 *   SkillInstallDestinationResult,
 *   SkillInstallOptions,
 *   SkillInstallResult,
 * } from './types.d.ts'
 */

export const COLLECTIVUS_QUERY_SKILL = 'collectivus-query'
const MANAGED_MARKER = '.collectivus-skill.json'
const DEFAULT_SKILL_SOURCE = fileURLToPath(new URL('../../skills/collectivus-query', import.meta.url))
const SKILLS_ROOT = fileURLToPath(new URL('../../skills', import.meta.url))

/**
 * Skills shipped in this package. Each entry declares which clients it
 * targets — `ctvs-ignore` / `ctvs-unignore` rely on `$CLAUDE_CODE_SESSION_ID`
 * which is Claude-Code-specific, so they are not installed under Codex.
 *
 * @type {ReadonlyArray<{ name: string, clients: ReadonlyArray<'claude' | 'codex'> }>}
 */
export const BUNDLED_SKILLS = Object.freeze([
  { name: 'collectivus-query', clients: ['claude', 'codex'] },
  { name: 'ctvs-ignore', clients: ['claude'] },
  { name: 'ctvs-unignore', clients: ['claude'] },
])

export class SkillInstallError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, path?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'SkillInstallError'
    /** @type {string | undefined} */
    this.code = opts.code
    /** @type {string | undefined} */
    this.path = opts.path
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * @param {SkillInstallOptions} opts
 * @returns {Promise<SkillInstallResult>}
 */
export async function installSkill(opts) {
  const { client } = opts
  if (client !== 'claude' && client !== 'codex' && client !== 'all') {
    throw new SkillInstallError(`invalid client: ${String(client)}`, { code: 'INVALID_CLIENT' })
  }

  const sourceDir = opts.sourceDir ?? DEFAULT_SKILL_SOURCE
  await assertSkillSource(sourceDir)

  /** @type {SkillInstallDestinationResult[]} */
  const results = []
  for (const destination of skillDestinations(opts)) {
    results.push(await installDestination({
      sourceDir,
      destination,
      force: Boolean(opts.force),
      dryRun: Boolean(opts.dryRun),
      skillName: opts.skillName ?? COLLECTIVUS_QUERY_SKILL,
    }))
  }
  return { destinations: results }
}

/**
 * Install every entry in {@link BUNDLED_SKILLS} that is compatible with the
 * requested `client`. The bundle is the surface that `ctvs skills install`
 * and `ctvs attach --client claude` rely on so new skills can be added in
 * one place. Each skill's source directory is resolved beneath the package
 * `skills/` root unless overridden via the `skillsRoot` option (tests use it
 * to point at a temporary fixture).
 *
 * @param {SkillInstallOptions & { skillsRoot?: string }} opts
 * @returns {Promise<SkillInstallResult>}
 */
export async function installSkillBundle(opts) {
  const { client } = opts
  if (client !== 'claude' && client !== 'codex' && client !== 'all') {
    throw new SkillInstallError(`invalid client: ${String(client)}`, { code: 'INVALID_CLIENT' })
  }
  const root = opts.skillsRoot ?? SKILLS_ROOT
  /** @type {SkillInstallDestinationResult[]} */
  const destinations = []
  for (const skill of BUNDLED_SKILLS) {
    if (!skillSupportsClient(skill, client)) continue
    const sourceDir = path.join(root, skill.name)
    const result = await installSkill({
      ...opts,
      client: clientForSkill(skill, client),
      skillName: skill.name,
      sourceDir,
    })
    for (const destination of result.destinations) destinations.push(destination)
  }
  return { destinations }
}

/**
 * @param {{ clients: ReadonlyArray<'claude' | 'codex'> }} skill
 * @param {SkillInstallClient} requested
 * @returns {boolean}
 */
function skillSupportsClient(skill, requested) {
  if (requested === 'all') return skill.clients.length > 0
  return skill.clients.includes(requested)
}

/**
 * Narrow `requested === 'all'` down to the intersection of `requested` with
 * the skill's declared clients so a Claude-only skill stays out of the Codex
 * install paths even when the caller asked for `all`.
 *
 * @param {{ clients: ReadonlyArray<'claude' | 'codex'> }} skill
 * @param {SkillInstallClient} requested
 * @returns {SkillInstallClient}
 */
function clientForSkill(skill, requested) {
  if (requested !== 'all') return requested
  if (skill.clients.length === 2) return 'all'
  return skill.clients[0]
}

/**
 * @param {SkillInstallOptions} opts
 * @returns {SkillInstallDestination[]}
 */
export function skillDestinations(opts) {
  const { client } = opts
  const skillName = opts.skillName ?? COLLECTIVUS_QUERY_SKILL
  const homeDir = opts.homeDir ?? os.homedir()
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME

  /** @type {SkillInstallDestination[]} */
  const destinations = []
  if (client === 'claude' || client === 'all') {
    destinations.push({
      client: 'claude',
      path: path.join(homeDir, '.claude', 'skills', skillName),
    })
  }
  if (client === 'codex' || client === 'all') {
    destinations.push({
      client: 'codex',
      path: path.join(homeDir, '.agents', 'skills', skillName),
    })
    destinations.push({
      client: 'codex',
      path: path.join(codexHome && codexHome.length > 0 ? codexHome : path.join(homeDir, '.codex'), 'skills', skillName),
    })
  }
  return dedupeDestinations(destinations)
}

/**
 * @param {{
 *   sourceDir: string,
 *   destination: SkillInstallDestination,
 *   force: boolean,
 *   dryRun: boolean,
 *   skillName: string,
 * }} args
 * @returns {Promise<SkillInstallDestinationResult>}
 */
async function installDestination(args) {
  const exists = await pathExists(args.destination.path)
  if (args.dryRun) {
    return {
      ...args.destination,
      action: exists ? 'would-update' : 'would-install',
    }
  }

  const managed = exists ? await hasManagedMarker(args.destination.path, args.skillName) : false
  if (exists && !managed && !args.force) {
    throw new SkillInstallError(
      `${args.destination.path} already exists and is not managed by collectivus; pass --force to overwrite`,
      { code: 'EEXIST', path: args.destination.path }
    )
  }

  if (exists) await fs.rm(args.destination.path, { recursive: true, force: true })
  await copyDir(args.sourceDir, args.destination.path)
  await writeManagedMarker(args.destination.path, args.destination.client, args.skillName)
  return {
    ...args.destination,
    action: exists ? 'updated' : 'installed',
  }
}

/**
 * @param {string} sourceDir
 * @returns {Promise<void>}
 */
async function assertSkillSource(sourceDir) {
  const skillPath = path.join(sourceDir, 'SKILL.md')
  try {
    const stat = await fs.stat(skillPath)
    if (!stat.isFile()) throw new Error('not a file')
  } catch (err) {
    throw new SkillInstallError(`packaged skill is missing ${skillPath}`, {
      code: 'MISSING_SOURCE',
      path: skillPath,
      cause: err,
    })
  }
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true })
  const entries = await fs.readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) {
      await copyDir(src, dest)
    } else if (entry.isFile()) {
      await fs.copyFile(src, dest)
    }
  }
}

/**
 * @param {string} dir
 * @param {'claude' | 'codex'} client
 * @param {string} skillName
 * @returns {Promise<void>}
 */
async function writeManagedMarker(dir, client, skillName) {
  const marker = {
    managed_by: 'collectivus',
    skill: skillName,
    client,
    installed_at: new Date().toISOString(),
  }
  await fs.writeFile(path.join(dir, MANAGED_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf8')
}

/**
 * @param {string} dir
 * @param {string} skillName
 * @returns {Promise<boolean>}
 */
async function hasManagedMarker(dir, skillName) {
  /** @type {unknown} */
  let marker
  try {
    marker = JSON.parse(await fs.readFile(path.join(dir, MANAGED_MARKER), 'utf8'))
  } catch {
    return false
  }
  return isPlainObject(marker) &&
    marker.managed_by === 'collectivus' &&
    marker.skill === skillName
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function pathExists(p) {
  try {
    await fs.stat(p)
    return true
  } catch (err) {
    if (errCode(err) === 'ENOENT') return false
    throw err
  }
}

/**
 * @param {SkillInstallDestination[]} destinations
 * @returns {SkillInstallDestination[]}
 */
function dedupeDestinations(destinations) {
  const seen = new Set()
  /** @type {SkillInstallDestination[]} */
  const out = []
  for (const destination of destinations) {
    const key = path.resolve(destination.path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(destination)
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value) &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
}

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errCode(err) {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  const code = Reflect.get(err, 'code')
  return typeof code === 'string' ? code : undefined
}
