// @ts-check

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { loadManifest } from '../manifest.js'
import { fetchGitSource } from './git_fetch.js'
import { pluginInstallDir } from './paths.js'

/**
 * @import { PluginManifest, PluginSourceSpec } from '../../../collectivus-plugin-kernel-types'
 */

/**
 * @import {
 *   FetchSuccess,
 *   FetchFailure,
 *   FetchResult,
 *   FetchErrorKind,
 *   BeforeCommitCallback,
 * } from './types.d.ts'
 */

const SKIPPED_DIR_NAMES = new Set(['node_modules', '.git', '.DS_Store'])

/**
 * Fetch a plugin artifact and install it into
 * `<stateDir>/plugins/<name>/`. Phase 7 implements `local-dir`; the
 * other kinds are recognized but rejected with `fetch_unsupported`
 * until Phase 8 introduces real git fetch.
 *
 * The caller wraps this in a `plugin.install` span and is expected
 * to feed the returned `errorKind` back as the span's `error_kind`.
 *
 * @param {object} args
 * @param {PluginSourceSpec} args.source
 * @param {string} args.stateDir
 * @param {BeforeCommitCallback} [args.beforeCommit] — forwarded to the
 *   git fetcher so the CLI can prompt for confirmation immediately
 *   before the artifact rename swap. Ignored for local-dir sources,
 *   which keep their non-interactive behavior by design.
 * @returns {Promise<FetchResult>}
 */
export async function fetchPlugin({ source, stateDir, beforeCommit }) {
  switch (source.kind) {
    case 'local-dir':
      return fetchLocalDir({ source, stateDir })
    case 'git':
      return fetchGitSource({ source, stateDir, beforeCommit })
    case 'first-party':
    case 'scoped-third-party':
    case 'unscoped-third-party':
      return {
        ok: false,
        errorKind: 'fetch_unsupported',
        message: `plugin install: source kind '${source.kind}' lands in a follow-up phase (git URL is wired in hy-gh-1)`,
      }
    default:
      return {
        ok: false,
        errorKind: 'fetch_unsupported',
        message: `plugin install: unknown source kind '${/** @type {{ kind: string }} */ (source).kind}'`,
      }
  }
}

/**
 * Read and validate the manifest at the source root, then copy the
 * artifact tree into the kernel's install root. Returns hashes so the
 * caller can write a lock entry.
 *
 * @param {{ source: PluginSourceSpec, stateDir: string }} args
 * @returns {Promise<FetchResult>}
 */
async function fetchLocalDir({ source, stateDir }) {
  if (!source.path) {
    return {
      ok: false,
      errorKind: 'local_dir_invalid',
      message: 'local-dir source missing path',
    }
  }
  let sourceStat
  try {
    sourceStat = await fs.stat(source.path)
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return {
        ok: false,
        errorKind: 'local_dir_missing',
        message: `plugin install: local directory does not exist: ${source.path}`,
      }
    }
    throw err
  }
  if (!sourceStat.isDirectory()) {
    return {
      ok: false,
      errorKind: 'local_dir_invalid',
      message: `plugin install: local source is not a directory: ${source.path}`,
    }
  }

  const manifestResult = await loadManifest(source.path)
  if (!manifestResult.ok) {
    return {
      ok: false,
      errorKind: 'manifest_invalid',
      message: manifestResult.message,
    }
  }
  const manifest = manifestResult.manifest

  if (source.name && source.name !== manifest.name) {
    return {
      ok: false,
      errorKind: 'manifest_name_mismatch',
      message: `plugin install: manifest name '${manifest.name}' does not match requested '${source.name}'`,
    }
  }

  const installDir = pluginInstallDir(stateDir, manifest.name)
  await fs.rm(installDir, { recursive: true, force: true })
  await fs.mkdir(installDir, { recursive: true })
  await copyArtifactTree(source.path, installDir)

  const contentHash = await hashArtifactTree(installDir)
  const manifestRaw = await fs.readFile(path.join(installDir, 'hypaware.plugin.json'), 'utf8')
  const manifestHash = hashString(manifestRaw)

  return {
    ok: true,
    manifest,
    installDir,
    contentHash,
    manifestHash,
  }
}

/**
 * Copy a directory tree, skipping the standard development byproducts
 * (`node_modules`, `.git`, OS detritus). Symlinks copy as symlinks so
 * a future `local-dir` install of a workspace plugin doesn't materialize
 * the entire dev tree.
 *
 * @param {string} src
 * @param {string} dest
 */
async function copyArtifactTree(src, dest) {
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (SKIPPED_DIR_NAMES.has(entry.name)) continue
    const fromPath = path.join(src, entry.name)
    const toPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await fs.mkdir(toPath, { recursive: true })
      await copyArtifactTree(fromPath, toPath)
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(fromPath)
      await fs.symlink(target, toPath)
    } else if (entry.isFile()) {
      await fs.copyFile(fromPath, toPath)
    }
  }
}

/**
 * Compute a stable SHA-256 over the artifact tree. Files are visited
 * in lexicographic order (relative path) and each file contributes a
 * `path\0sha256(content)\n` line. The same tree always hashes to the
 * same value regardless of FS read order, and identical reinstalls
 * verify against the previous content_hash on the lock entry.
 *
 * @param {string} root
 */
export async function hashArtifactTree(root) {
  /** @type {string[]} */
  const records = []
  await walk(root, root, records)
  records.sort()
  const hash = crypto.createHash('sha256')
  for (const rec of records) hash.update(rec)
  return hash.digest('hex')
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {string[]} records
 */
async function walk(root, dir, records) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (entry.isDirectory()) {
      await walk(root, full, records)
    } else if (entry.isFile()) {
      const buf = await fs.readFile(full)
      const sha = crypto.createHash('sha256').update(buf).digest('hex')
      records.push(`${rel}\0${sha}\n`)
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(full)
      const sha = crypto.createHash('sha256').update(`link:${target}`).digest('hex')
      records.push(`${rel}\0${sha}\n`)
    }
  }
}

/** @param {string} s */
function hashString(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}
