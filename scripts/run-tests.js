#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const ROOT = 'test'
const IGNORED_DIRS = new Set(['.git', '.github', 'node_modules'])

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
