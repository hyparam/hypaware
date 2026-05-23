#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = 'test'
const IGNORED_DIRS = new Set(['.git', '.github', 'node_modules'])

/** @type {string[]} */
const files = []
collectTestFiles(path.resolve(ROOT), files)
files.sort()

if (files.length === 0) {
  process.stderr.write(`no test files found under ${ROOT}\n`)
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--test', ...files, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)

if (result.error) {
  process.stderr.write(`failed to spawn node --test: ${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)

/**
 * @param {string} dir
 * @param {string[]} out
 */
function collectTestFiles(dir, out) {
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
