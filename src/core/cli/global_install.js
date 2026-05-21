// @ts-check

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {Object} CommandResult
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 *
 * @typedef {(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv, cwd?: string }) => Promise<CommandResult>} CommandRunner
 *
 * @typedef {Object} DurableBinResult
 * @property {string} binPath
 * @property {boolean} installed
 * @property {boolean} skipped
 * @property {string} [packageSpec]
 * @property {string} [globalPrefix]
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PACKAGE_JSON = path.join(PACKAGE_ROOT, 'package.json')

/**
 * When `npx hypaware` installs the daemon directly, `process.argv[1]`
 * points into npm's `_npx` cache. Install the same package globally
 * first and use that durable binary for launchd/systemd.
 *
 * Explicit `--bin` callers already supplied their stable entrypoint,
 * so this helper should only be called for default daemon installs.
 *
 * @param {{
 *   binPath: string,
 *   env: NodeJS.ProcessEnv,
 *   stdout: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   stderr: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   runner?: CommandRunner,
 * }} opts
 * @returns {Promise<DurableBinResult>}
 */
export async function ensureDurableBinForNpx(opts) {
  const binPath = path.resolve(opts.binPath)
  if (!isNpxBinPath(binPath, opts.env)) {
    return { binPath, installed: false, skipped: true }
  }

  const pkg = await readPackageIdentity()
  const packageSpec = `${pkg.name}@${pkg.version}`
  const run = opts.runner ?? runCommand

  opts.stdout.write(`npx detected: installing durable CLI with npm install -g ${packageSpec}\n`)
  const install = await run('npm', ['install', '-g', packageSpec], {
    env: opts.env,
    cwd: PACKAGE_ROOT,
  })
  if (install.exitCode !== 0) {
    const detail = compactCommandError(install)
    throw new Error(
      `npx detected, but npm install -g ${packageSpec} failed${detail ? `: ${detail}` : ''}. ` +
      `Run 'npm install -g ${packageSpec}' manually, then rerun 'hyp init', or pass ` +
      `'--bin <stable-hypaware.js>' to use an explicit daemon binary.`
    )
  }

  const prefix = await globalPrefix(run, opts.env)
  const globalBin = globalHypawareBin(prefix, process.platform)
  opts.stdout.write(`global CLI: ${globalBin}\n`)
  return {
    binPath: globalBin,
    installed: true,
    skipped: false,
    packageSpec,
    globalPrefix: prefix,
  }
}

/**
 * @param {string} binPath
 * @param {NodeJS.ProcessEnv} env
 */
export function isNpxBinPath(binPath, env = process.env) {
  const normalized = path.resolve(binPath)
  const cache = env.npm_config_cache ? path.resolve(env.npm_config_cache) : undefined
  if (cache && isInside(normalized, path.join(cache, '_npx'))) return true
  return normalized.split(path.sep).includes('_npx')
}

/**
 * @param {string} prefix
 * @param {NodeJS.Platform} platform
 */
export function globalHypawareBin(prefix, platform = process.platform) {
  if (platform === 'win32') return path.join(prefix, 'hypaware.cmd')
  return path.join(prefix, 'bin', 'hypaware')
}

/**
 * @returns {Promise<{ name: string, version: string }>}
 */
async function readPackageIdentity() {
  const raw = await fs.readFile(PACKAGE_JSON, 'utf8')
  const parsed = JSON.parse(raw)
  const name = typeof parsed.name === 'string' ? parsed.name : ''
  const version = typeof parsed.version === 'string' ? parsed.version : ''
  if (!name || !version) {
    throw new Error(`package identity missing in ${PACKAGE_JSON}`)
  }
  return { name, version }
}

/**
 * @param {CommandRunner} run
 * @param {NodeJS.ProcessEnv} env
 */
async function globalPrefix(run, env) {
  const result = await run('npm', ['config', 'get', 'prefix'], { env, cwd: PACKAGE_ROOT })
  if (result.exitCode !== 0) {
    const detail = compactCommandError(result)
    throw new Error(`npm config get prefix failed${detail ? `: ${detail}` : ''}`)
  }
  const prefix = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  if (!prefix) throw new Error('npm config get prefix returned an empty prefix')
  return prefix
}

/** @type {CommandRunner} */
function runCommand(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * @param {CommandResult} result
 */
function compactCommandError(result) {
  return (result.stderr.trim() || result.stdout.trim()).split(/\s+/).slice(0, 40).join(' ')
}

/**
 * @param {string} child
 * @param {string} parent
 */
function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}
