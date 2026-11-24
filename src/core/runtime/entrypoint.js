// @ts-check

// The entry point: which copy of the CLI owns this machine.
//
// A machine can carry more than one HypAware: an npm global, an npx cache, a
// dev checkout, and the copy a native app bundles. Each writes the service
// unit and the client hooks with its own path, so two copies take the daemon
// and the hooks back and forth. The entry point is a small state file naming
// the one copy that owns them. Every other copy hands its command to that one,
// so the service, the hooks, and the updater are only ever written by the
// owner.
//
// This module is imported statically by bin/hypaware.js ahead of every other
// kernel module, so it stays on node built-ins and runtime/paths.js.
//
// @ref LLP 0621#decision: one pointer, read at the front door; the owner does the work

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { entrypointStatePath, hypHomeFromEnv, stateRootOf } from './paths.js'

/**
 * @import { EntrypointRecord } from '../../../src/core/runtime/types.js'
 */

/** Set on the child of a hand-off so it runs the command instead of passing it on again. */
export const HANDOFF_ENV = 'HYP_ENTRYPOINT_HANDOFF'

/** Set to `1` to run this copy whatever the entry point names (a developer's checkout). */
export const NO_HANDOFF_ENV = 'HYP_NO_HANDOFF'

/** Commands that always run in the copy that was invoked, so an installer can claim or release. */
const LOCAL_COMMANDS = new Set(['entrypoint'])

/** This package's own CLI, the path the entry point is compared against. */
export const SELF_BIN_PATH = fileURLToPath(new URL('../../../bin/hypaware.js', import.meta.url))

/**
 * `<HYP_HOME>/hypaware/entrypoint.json`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function entrypointPath(env = process.env) {
  return entrypointStatePath(stateRootOf(hypHomeFromEnv(env)))
}

/**
 * The recorded entry point, or `undefined` when none is set or the file is
 * unreadable or malformed. A broken pointer never blocks a command.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {EntrypointRecord | undefined}
 */
export function readEntrypoint(env = process.env) {
  let text
  try {
    text = fs.readFileSync(entrypointPath(env), 'utf8')
  } catch {
    return undefined
  }
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || typeof value.bin !== 'string' || !path.isAbsolute(value.bin)) return undefined
    /** @type {EntrypointRecord} */
    const record = { bin: value.bin }
    if (typeof value.node === 'string' && path.isAbsolute(value.node)) record.node = value.node
    if (typeof value.owner === 'string' && value.owner) record.owner = value.owner
    return record
  } catch {
    return undefined
  }
}

/**
 * Record `record` as the entry point, atomically (write then rename).
 *
 * @param {EntrypointRecord} record
 * @param {NodeJS.ProcessEnv} [env]
 */
export function writeEntrypoint(record, env = process.env) {
  const file = entrypointPath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...record }, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/**
 * Remove the entry point. Returns whether a file was removed.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function clearEntrypoint(env = process.env) {
  try {
    fs.unlinkSync(entrypointPath(env))
    return true
  } catch {
    return false
  }
}

/**
 * Whether two paths name the same file, following symlinks. A path that does
 * not resolve only matches itself.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameBin(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

/**
 * The live entry point: the recorded one when its CLI still exists, else
 * `undefined`. A dead pointer (the app was dragged to the Trash, an nvm
 * switch moved the npm prefix) reads as no pointer, so whatever copy runs
 * next behaves as it would with none set.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {EntrypointRecord | undefined}
 */
export function liveEntrypoint(env = process.env) {
  const record = readEntrypoint(env)
  if (!record) return undefined
  try {
    if (!fs.statSync(record.bin).isFile()) return undefined
  } catch {
    return undefined
  }
  return record
}

/**
 * Where this invocation should run instead of here, or `undefined` to run
 * here.
 *
 * @param {string[]} argv the CLI arguments (process.argv.slice(2))
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [selfBin]
 * @returns {EntrypointRecord | undefined}
 */
export function handoffTarget(argv, env = process.env, selfBin = SELF_BIN_PATH) {
  if (env[HANDOFF_ENV] === '1' || env[NO_HANDOFF_ENV] === '1') return undefined
  if (argv[0] !== undefined && LOCAL_COMMANDS.has(argv[0])) return undefined
  const record = liveEntrypoint(env)
  if (!record || sameBin(record.bin, selfBin)) return undefined
  return record
}

/**
 * Run `argv` in the entry point's copy and return its exit code. stdio is
 * inherited, so hooks that read stdin and commands that prompt behave as if
 * they had been invoked there directly. A child killed by a signal is
 * reported the way a shell would, 128 plus the signal number.
 *
 * @param {EntrypointRecord} target
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function runHandoff(target, argv, env = process.env) {
  const result = spawnSync(target.node ?? process.execPath, [target.bin, ...argv], {
    stdio: 'inherit',
    env: { ...env, [HANDOFF_ENV]: '1' },
  })
  if (result.error) {
    process.stderr.write(`hyp: could not run the entry point ${target.bin}: ${result.error.message}\n`)
    return 1
  }
  if (result.signal) return 128 + (os.constants.signals[result.signal] ?? 0)
  return result.status ?? 1
}
