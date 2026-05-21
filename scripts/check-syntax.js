#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOTS = ['bin', 'src', 'hypaware-core', 'test']
const IGNORED_DIRS = new Set(['.git', '.github', 'node_modules'])

/** @type {string[]} */
const files = []
for (const root of ROOTS) {
  collectJsFiles(path.resolve(root), files)
}
files.sort()

let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    failed = true
    process.stderr.write(`${path.relative(process.cwd(), file)}\n`)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.stdout) process.stderr.write(result.stdout)
  }
}

if (failed) {
  process.exit(1)
}

process.stdout.write(`checked ${files.length} JavaScript files\n`)

/**
 * @param {string} dir
 * @param {string[]} out
 */
function collectJsFiles(dir, out) {
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
        collectJsFiles(path.join(dir, entry.name), out)
      }
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name))
    }
  }
}
