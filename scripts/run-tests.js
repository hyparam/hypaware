#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

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

  const result = spawnSync(
    process.execPath,
    buildNodeTestArgs(files, forwardedArgs),
    { stdio: 'inherit' },
  )

  if (result.error) {
    process.stderr.write(`failed to spawn node --test: ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
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
