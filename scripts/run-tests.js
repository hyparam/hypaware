#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { isolatedClientEnv } from '../hypaware-core/smoke/lib/isolation.js'

const ROOT = 'test'
const IGNORED_DIRS = new Set(['.git', '.github', 'node_modules'])

/**
 * Test files whose entire subject is a POSIX mechanism the OS refuses on
 * stock Windows, skipped there as whole files (LLP 0300 names the port
 * status). TODO(win32): replace the first with a symlink capability probe
 * (Developer Mode allows symlinks) instead of a blanket skip.
 * - usage-policy-symlink: creates real file symlinks (EPERM without
 *   Developer Mode / admin)
 * - service-command-timeout: drives hanging children through sh-script fake
 *   `security` / `launchctl` binaries on PATH (shebangs + exec bits)
 * - service-manager-test-sandbox: meta-suite spawning the launchctl /
 *   systemctl attach fixtures
 */
const WIN32_SKIPPED_FILES = new Set([
  path.join('core', 'usage-policy-symlink.test.js'),
  path.join('core', 'service-command-timeout.test.js'),
  path.join('core', 'service-manager-test-sandbox.test.js'),
])

// Windows refuses a CreateProcess command line past 32,767 characters
// (spawnSync reports ENAMETOOLONG), and the full suite's absolute paths are
// several times that. Headroom for the quoting spawnSync adds per argument.
const WIN32_CMDLINE_LIMIT = 28_000

if (isMain(import.meta.url, process.argv[1])) {
  process.exit(run(process.argv.slice(2)))
}

/**
 * @param {string[]} forwardedArgs
 * @returns {number}
 */
export function run(forwardedArgs) {
  /** @type {string[]} */
  const files = []
  collectTestFiles(path.resolve(ROOT), files)
  files.sort()

  if (process.platform === 'win32') {
    // Anchor on the same resolved root the collector walked, so matching
    // does not silently depend on npm test running from the repo root.
    const skipped = files.filter((f) => WIN32_SKIPPED_FILES.has(path.relative(path.resolve(ROOT), f)))
    if (skipped.length > 0) {
      // Loud, never silent: name what this platform is not running.
      process.stderr.write(`win32: skipping ${skipped.length} POSIX-bound test file(s): ${skipped.map((f) => path.basename(f)).join(', ')}\n`)
      for (const f of skipped) files.splice(files.indexOf(f), 1)
    }
  }

  if (files.length === 0) {
    process.stderr.write(`no test files found under ${ROOT}\n`)
    return 1
  }

  // The parent owns this directory even when a test exits before its hooks run.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-t-'))
  try {
    const homeDir = path.join(temp, 'home')
    fs.mkdirSync(homeDir)
    const limit = process.platform === 'win32' ? WIN32_CMDLINE_LIMIT : Infinity
    const batches = batchTestFiles(files, forwardedArgs, limit)
    let status = 0
    for (const batch of batches) {
      const result = spawnSync(
        process.execPath,
        buildNodeTestArgs(batch, forwardedArgs),
        { stdio: 'inherit', env: { ...isolatedClientEnv(process.env, homeDir), TMPDIR: temp, TMP: temp, TEMP: temp } },
      )
      if (result.error) {
        process.stderr.write(`failed to spawn node --test: ${result.error.message}\n`)
        return 1
      }
      if (status === 0 && (result.status ?? 1) !== 0) status = result.status ?? 1
    }
    return status
  } finally {
    // Best effort. `force` only swallows ENOENT and `maxRetries` never retries
    // EACCES, so a fixture the suite left unreadable (a test that chmod'd a
    // directory and died before restoring it) would otherwise throw from here,
    // discard the run's exit status, and report a green suite as a crash.
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 })
    } catch (err) {
      process.stderr.write(`could not remove the test temp root ${temp}: ${/** @type {Error} */ (err).message}\n`)
    }
  }
}

/**
 * @param {string[]} files
 * @param {string[]} forwardedArgs
 * @returns {string[]}
 */
export function buildNodeTestArgs(files, forwardedArgs = []) {
  return ['--test', ...forwardedArgs, ...files]
}

/**
 * Split `files` into runs whose spawned command line stays under `limit`
 * characters, counting the interpreter path, the fixed `--test` flags, and
 * per-argument quoting overhead. One batch (today's behavior) everywhere the
 * limit is `Infinity`; a batch always takes at least one file so an oversized
 * single path fails in the spawn, where the error names it, not here.
 *
 * @param {string[]} files
 * @param {string[]} forwardedArgs
 * @param {number} limit
 * @returns {string[][]}
 */
export function batchTestFiles(files, forwardedArgs, limit) {
  const fixed = process.execPath.length + 3 +
    ['--test', ...forwardedArgs].reduce((n, arg) => n + arg.length + 3, 0)
  /** @type {string[][]} */
  const batches = []
  /** @type {string[]} */
  let batch = []
  let length = fixed
  for (const file of files) {
    const cost = file.length + 3
    if (batch.length > 0 && length + cost > limit) {
      batches.push(batch)
      batch = []
      length = fixed
    }
    batch.push(file)
    length += cost
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/**
 * @param {string} dir
 * @param {string[]} out
 */
export function collectTestFiles(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        collectTestFiles(path.join(dir, entry.name), out)
      }
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(path.join(dir, entry.name))
    }
  }
}

/**
 * @param {string} moduleUrl
 * @param {string | undefined} argvPath
 */
function isMain(moduleUrl, argvPath) {
  return !!argvPath && moduleUrl === pathToFileURL(argvPath).href
}
