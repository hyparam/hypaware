// @ts-check

import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * @import { CommandResult, CommandRunner, DurableBinResult } from '../../../src/core/cli/types.js'
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PACKAGE_JSON = path.join(PACKAGE_ROOT, 'package.json')

/**
 * Error raised when npm refused the durable-bin upgrade: an unwritable global
 * prefix, no registry, a failed install. A distinct class because a caller
 * deciding whether to carry on without a daemon has to tell the environment
 * saying no from a bug here, and every message names the repair (#1386).
 */
export class GlobalInstallError extends Error {
  /**
   * @param {string} message
   * @param {{ globalBinInstalled?: boolean }} [opts] whether `npm install -g` had already
   *   landed a global `hyp` when this failed, so a caller can tell whether naming a `hyp`
   *   command as the repair names one that exists (#1395). The refusal itself has not.
   */
  constructor(message, opts) {
    super(message)
    this.name = 'GlobalInstallError'
    this.globalBinInstalled = opts?.globalBinInstalled === true
  }
}

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
    throw new GlobalInstallError(
      `npx detected, but npm install -g ${packageSpec} failed${detail ? `: ${detail}` : ''}. ` +
      `Run 'npm install -g ${packageSpec}' manually, then rerun 'hyp setup', or pass ` +
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
 * Whether an entrypoint a command is about to write down names a copy of the
 * CLI that will not outlive the writing.
 *
 * The entrypoint-side counterpart to the `$PATH` rule inside
 * {@link findInstalledHypawareBin}, and deliberately not the same test. The
 * walk judges a `$PATH` *directory*, where a `node_modules` segment is always
 * some project's `.bin` and can be refused outright. This judges a *script
 * inside a package tree*, and every npm-installed package lives under a
 * `node_modules` - npm's own global root (`<prefix>/lib/node_modules/<pkg>`,
 * or `<prefix>/node_modules/<pkg>` on Windows) included. Refusing every
 * `node_modules` here would report a plain `npm install -g` as ephemeral,
 * which is the one install this whole lane exists to steer people onto and the
 * install its warning names as the repair.
 *
 * What separates them is whose tree it is. A project's `node_modules` sits
 * beside that project's `package.json`, and `npm ci`, a branch switch, or a
 * plain `rm -rf` deletes it just as npm's prune deletes the `_npx` cache; the
 * global root has no manifest beside it, because it is npm's own directory and
 * not any project's dependency tree. So the test is the outermost
 * `node_modules` on the path and one `statSync` beside it. Outermost, because
 * every nested dependency (`<root>/node_modules/a/node_modules/b`) has a
 * manifest one level up whatever root it sits under: the enclosing project
 * decides, not the package.
 *
 * A manifest that cannot be read answers "durable", so the fail direction is a
 * missed ephemeral path - today's behaviour - and never a warning on a machine
 * with nothing wrong with it. A global root some other package manager does
 * write a manifest beside (pnpm's `global/<n>` and yarn's `config/yarn/global`
 * are the two) reads as ephemeral. What that costs is the `$PATH` walk each
 * caller already runs: coming back empty it records what it was handed,
 * exactly as before, and pays one warning naming the wrong tree; finding
 * something it records the first durable `hypaware` on `$PATH`, which is the
 * copy a bare `hyp` runs anyway. Neither answer is a path that is not there,
 * which is the only outcome this predicate exists to prevent.
 *
 * @param {string} binPath
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function isEphemeralBinPath(binPath, env = process.env) {
  if (isNpxBinPath(binPath, env)) return true
  let dir = path.resolve(binPath)
  /** @type {string | undefined} */
  let projectRoot
  for (;;) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    // Whole segment, the same rigour as the `_npx` test above: a directory
    // named `node_modules_old` is a directory, not a dependency tree. Climbing
    // upwards, the last match found is the outermost one.
    if (path.basename(dir) === 'node_modules') projectRoot = parent
    dir = parent
  }
  if (projectRoot === undefined) return false
  try {
    return statSync(path.join(projectRoot, 'package.json')).isFile()
  } catch {
    return false
  }
}

/**
 * The absolute path of an already-installed HypAware CLI, or `undefined`.
 *
 * The read-only counterpart to `ensureDurableBinForNpx`, for a caller that must
 * record a CLI path on disk but cannot spend an `npm install -g` to get one: it
 * finds only what is already there, so it stays synchronous and total.
 *
 * `$PATH` is the search, not the answer - what comes back is absolute, so a
 * consumer that cannot depend on `PATH` at run time spends the lookup once,
 * here. What it will not answer with is any `node_modules` tree, npx's own
 * shim directory among them: those sit in front of `$PATH` for exactly as long
 * as one command runs and the next `npm ci` deletes them, so recording one
 * only trades npm's prune schedule for npm's install schedule.
 *
 * `accept` is how a caller narrows "executable" to whatever it actually needs,
 * without forking the walk. It runs last, after the file and `X_OK` checks, and
 * a `false` keeps walking rather than ending the search: a rejected candidate
 * is this directory's answer, never `$PATH`'s. That distinction is the whole
 * point of the parameter. `@hypaware/claude-desktop` needs a path `node` can
 * parse, because it writes `exec <node> <bin>`, and pnpm, volta and asdf all
 * put a shell script or a compiled shim at this name; those managers also put
 * their directory at the FRONT of `$PATH`, so filtering the single answer
 * instead would hide an ordinary `npm install -g` sitting one entry behind it
 * and send the operator off to run an install they have already run.
 *
 * It answers "where is an installed `hypaware`", not "where is *this*
 * `hypaware`": the first accepted executable of that name wins and no version
 * is compared, which is the one place it parts company with
 * `ensureDurableBinForNpx` and its deliberate `name@version` pin. Telling the
 * difference means resolving the candidate's own `package.json` across every
 * install layout (npm, pnpm, yarn, and volta/nvm/asdf shims) or spawning it
 * for `--version`, and each buys the check by giving up either correctness on
 * a layout nobody enumerated or the synchronous, total contract above. So skew
 * is accepted here rather than detected, and not every skew is loud: a CLI too
 * old for the subcommand answers `unknown command` in front of whoever ran it,
 * but one old enough only to predate a later contract on a subcommand it still
 * has can go on exiting 0. What the walk buys against that is a path that will
 * still be there, which is the one thing the `_npx` path it displaces cannot
 * promise. The `node_modules` rule carries most of the weight: a project-local
 * `hypaware` is both the likeliest wrong version to find and the likeliest to
 * be deleted, and it is refused on the second ground without needing the first.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {(candidate: string) => boolean} [accept] extra test a candidate must
 *   pass; a rejection resumes the walk at the next `$PATH` entry
 * @returns {string | undefined}
 */
export function findInstalledHypawareBin(env = process.env, platform = process.platform, accept) {
  const exts = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    // A relative entry (or the empty string, which `$PATH` uses to mean the
    // cwd) would resolve against whatever directory the caller happened to run
    // in, which is the same kind of path that does not survive being written
    // down. Only an absolute entry can answer the question being asked.
    if (!path.isAbsolute(dir)) continue
    // Every `node_modules/.bin` is temporary, and `npx` and `npm run` both put
    // one at the FRONT of `$PATH`. The npx cache is one instance of that and
    // has its own test because its layout is recognizable on its own; a plain
    // project-local install is the same hazard without the tell, and the next
    // `npm ci` removes it just as npm's prune removes the cache. Recording
    // either writes down a path that outlives nothing.
    //
    // Blunter than `isEphemeralBinPath`, on purpose: nothing durable is ever
    // reached *through* a `node_modules` directory on `$PATH`, while a global
    // install's own script lives under one by construction.
    if (isNpxBinPath(dir, env) || dir.split(path.sep).includes('node_modules')) continue
    for (const ext of exts) {
      const candidate = path.resolve(dir, 'hypaware' + ext)
      try {
        // `X_OK` alone is true for a directory, because directories are
        // searchable. A caller that records the answer would pin itself to
        // something that can never execute, with nothing to say so.
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, fsConstants.X_OK)
        if (accept !== undefined && !accept(candidate)) continue
        return candidate
      } catch {
        // not here, not a file, or not executable: keep walking
      }
    }
  }
  return undefined
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
    throw new GlobalInstallError(
      `npm config get prefix failed${detail ? `: ${detail}` : ''}`,
      { globalBinInstalled: true }
    )
  }
  const prefix = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  if (!prefix) {
    throw new GlobalInstallError(
      'npm config get prefix returned an empty prefix',
      { globalBinInstalled: true }
    )
  }
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
