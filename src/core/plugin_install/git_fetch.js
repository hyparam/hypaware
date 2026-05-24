// @ts-check

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { loadManifest } from '../manifest.js'
import { Attr, withSpan } from '../observability/index.js'
import { provenanceFromUrl } from './git_source.js'
import { pluginInstallDir } from './paths.js'

/**
 * @import { PluginManifest, PluginSourceSpec } from '../../../collectivus-plugin-kernel-types'
 */

const SKIPPED_DIR_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.npm',
  '.pnpm',
  '.yarn',
  '.DS_Store',
])

/**
 * @import {
 *   GitFetchSuccess,
 *   GitFetchFailure,
 *   GitFetchResult,
 *   GitFetchErrorKind,
 *   GitFetchStaged,
 *   BeforeCommitCallback,
 * } from './types.d.ts'
 */

/**
 * Clone a git source, validate its plugin manifest, copy the artifact
 * tree into the kernel install root, and return the hashes plus the
 * resolved commit ref.
 *
 * Pipeline (each external boundary wrapped in its own span):
 *
 *   1. `plugin.git.clone`     — `git clone --filter=blob:none --no-checkout`
 *   2. `plugin.git.checkout`  — `git checkout <ref>` (default branch HEAD when omitted)
 *   3. `plugin.git.resolve_ref` — `git rev-parse HEAD`
 *   4. `plugin.artifact.validate` — manifest, entrypoint, symlink-free
 *   5. `plugin.artifact.copy` — copy into install dir (atomic swap)
 *
 * On any failure after the clone, temp directories are cleaned up and
 * any prior install is left untouched.
 *
 * @param {object} args
 * @param {PluginSourceSpec & { subdir?: string }} args.source
 * @param {string} args.stateDir
 * @param {string} [args.runId] — injectable for tests/smokes
 * @param {BeforeCommitCallback} [args.beforeCommit] — fires after manifest
 *   validate + hash computation, immediately before the artifact rename
 *   swap. Returning `proceed=false` aborts the fetch with the supplied
 *   `errorKind` and leaves any prior install untouched.
 * @returns {Promise<GitFetchResult>}
 */
export async function fetchGitSource({ source, stateDir, runId, beforeCommit }) {
  if (source.subdir) {
    // The resolver normally rejects this, but defensive double-check in
    // case a caller hand-builds a spec.
    return {
      ok: false,
      errorKind: 'git_subdir_unsupported',
      message: `plugin install: git subdir '${source.subdir}' is reserved but not supported`,
    }
  }
  if (!source.gitUrl) {
    return {
      ok: false,
      errorKind: 'git_clone_failed',
      message: 'plugin install: git source missing gitUrl',
    }
  }

  const provenance = provenanceFromUrl(source.gitUrl)

  const gitOk = await isGitOnPath()
  if (!gitOk) {
    return {
      ok: false,
      errorKind: 'git_unavailable',
      message: 'plugin install: git is required on PATH for git sources',
    }
  }

  const tmpRoot = path.join(stateDir, 'tmp', 'plugin-fetch', runId ?? defaultRunId())
  const tmpRepo = path.join(tmpRoot, 'repo')
  const tmpArtifact = path.join(tmpRoot, 'artifact')

  try {
    await fs.mkdir(tmpRoot, { recursive: true })

    const cloneResult = await runGitCloneSpan(source.gitUrl, tmpRepo, provenance)
    if (cloneResult.ok === false) return cloneResult

    const checkoutResult = await runGitCheckoutSpan(tmpRepo, source.ref, provenance)
    if (checkoutResult.ok === false) return checkoutResult

    const resolveRefResult = await runResolveRefSpan(tmpRepo, provenance)
    if (resolveRefResult.ok === false) return resolveRefResult
    const resolvedRef = resolveRefResult.resolvedRef

    const validateResult = await runValidateArtifactSpan(tmpRepo)
    if (validateResult.ok === false) return validateResult
    const manifest = validateResult.manifest

    // Compute hashes from the staged source tree (skipping `.git` and
    // friends, same set as `copyArtifactTree`) so the `beforeCommit`
    // callback sees the exact `content_hash` / `manifest_hash` that
    // would land in the lock file.
    const manifestRaw = await fs.readFile(
      path.join(tmpRepo, 'hypaware.plugin.json'),
      'utf8'
    )
    const manifestHash = hashString(manifestRaw)
    const stagedContentHash = await hashArtifactTree(tmpRepo)

    if (beforeCommit) {
      const decision = await beforeCommit({
        manifest,
        resolvedRef,
        contentHash: stagedContentHash,
        manifestHash,
        provenance,
      })
      if (!decision.proceed) {
        return {
          ok: false,
          errorKind: decision.errorKind ?? 'remote_install_rejected',
          message: decision.message ?? 'plugin install: confirmation rejected',
        }
      }
    }

    const installDir = pluginInstallDir(stateDir, manifest.name)
    const copyResult = await runCopyArtifactSpan({
      sourceRoot: tmpRepo,
      tmpArtifact,
      finalInstallDir: installDir,
      manifestName: manifest.name,
    })
    if (copyResult.ok === false) return copyResult

    // Re-read the manifest from the install dir so a TOCTOU file-system
    // race between staging and copy is still caught.
    const installedManifestRaw = await fs.readFile(
      path.join(installDir, 'hypaware.plugin.json'),
      'utf8'
    )
    const installedManifestHash = hashString(installedManifestRaw)
    const contentHash = await hashArtifactTree(installDir)

    return {
      ok: true,
      manifest,
      installDir,
      contentHash,
      manifestHash: installedManifestHash,
      resolvedRef,
      provenance,
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * @param {string} gitUrl
 * @param {string} tmpRepo
 * @param {{ host?: string, owner?: string, repo?: string }} provenance
 * @returns {Promise<{ ok: true } | GitFetchFailure>}
 */
async function runGitCloneSpan(gitUrl, tmpRepo, provenance) {
  return withSpan(
    'plugin.git.clone',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.git.clone',
      git_url_host: provenance.host ?? '',
      git_owner: provenance.owner ?? '',
      git_repo: provenance.repo ?? '',
    },
    async (span) => {
      // `--` separates options from positional args so a hostile
      // gitUrl like `--upload-pack=<cmd>` cannot be interpreted by
      // git as an option (CVE-2018-17456 family). `parseGitSource`
      // already rejects leading-dash inputs but the separator is the
      // standard belt-and-braces defense at the spawn boundary.
      const cloned = await execGit(['clone', '--filter=blob:none', '--no-checkout', '--', gitUrl, tmpRepo])
      if (cloned.code !== 0) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'git_clone_failed')
        return /** @type {GitFetchFailure} */ ({
          ok: false,
          errorKind: 'git_clone_failed',
          message: `plugin install: git clone failed: ${redactGitMessage(cloned.stderr)}`,
        })
      }
      span.setAttribute('status', 'ok')
      return /** @type {{ ok: true }} */ ({ ok: true })
    },
    { component: 'plugin-install' }
  )
}

/**
 * @param {string} tmpRepo
 * @param {string | undefined} ref
 * @param {{ host?: string, owner?: string, repo?: string }} provenance
 * @returns {Promise<{ ok: true } | GitFetchFailure>}
 */
async function runGitCheckoutSpan(tmpRepo, ref, provenance) {
  return withSpan(
    'plugin.git.checkout',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.git.checkout',
      git_url_host: provenance.host ?? '',
      git_owner: provenance.owner ?? '',
      git_repo: provenance.repo ?? '',
      git_ref: ref ?? '',
    },
    async (span) => {
      const target = ref ?? (await resolveDefaultBranch(tmpRepo))
      if (!target) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'git_checkout_failed')
        return /** @type {GitFetchFailure} */ ({
          ok: false,
          errorKind: 'git_checkout_failed',
          message: 'plugin install: could not determine default branch on cloned repo',
        })
      }
      // `--` here disambiguates the ref from any same-named pathspec
      // and blocks an injected `--upload-pack=`-style argument from
      // being parsed as an option. The clone path already vetted the
      // URL; this protects the user-supplied `ref`.
      const checked = await execGit(['-C', tmpRepo, 'checkout', target, '--'])
      if (checked.code !== 0) {
        const isRefError = /pathspec|did not match|unknown revision|not a tree/i.test(checked.stderr)
        const errorKind = isRefError ? 'git_ref_not_found' : 'git_checkout_failed'
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', errorKind)
        return /** @type {GitFetchFailure} */ ({
          ok: false,
          errorKind,
          message: `plugin install: git checkout failed: ${redactGitMessage(checked.stderr)}`,
        })
      }
      span.setAttribute('status', 'ok')
      return /** @type {{ ok: true }} */ ({ ok: true })
    },
    { component: 'plugin-install' }
  )
}

/**
 * @param {string} tmpRepo
 * @param {{ host?: string, owner?: string, repo?: string }} provenance
 * @returns {Promise<{ ok: true, resolvedRef: string } | GitFetchFailure>}
 */
async function runResolveRefSpan(tmpRepo, provenance) {
  return withSpan(
    'plugin.git.resolve_ref',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.git.resolve_ref',
      git_url_host: provenance.host ?? '',
      git_owner: provenance.owner ?? '',
      git_repo: provenance.repo ?? '',
    },
    async (span) => {
      const probe = await execGit(['-C', tmpRepo, 'rev-parse', 'HEAD'])
      if (probe.code !== 0) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'git_checkout_failed')
        return /** @type {GitFetchFailure} */ ({
          ok: false,
          errorKind: 'git_checkout_failed',
          message: `plugin install: git rev-parse HEAD failed: ${redactGitMessage(probe.stderr)}`,
        })
      }
      const resolvedRef = probe.stdout.trim()
      span.setAttribute('git_resolved_ref', resolvedRef)
      span.setAttribute('status', 'ok')
      return /** @type {{ ok: true, resolvedRef: string }} */ ({ ok: true, resolvedRef })
    },
    { component: 'plugin-install' }
  )
}

/**
 * @param {string} sourceRoot
 * @returns {Promise<{ ok: true, manifest: PluginManifest } | GitFetchFailure>}
 */
async function runValidateArtifactSpan(sourceRoot) {
  return withSpan(
    'plugin.artifact.validate',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.artifact.validate',
    },
    async (span) => {
      const manifestResult = await loadManifest(sourceRoot)
      if (!manifestResult.ok) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'manifest_invalid')
        return /** @type {GitFetchFailure} */ ({
          ok: false,
          errorKind: 'manifest_invalid',
          message: manifestResult.message,
        })
      }
      const manifest = manifestResult.manifest

      const entrypointError = validateEntrypoint(manifest.entrypoint, sourceRoot)
      if (entrypointError) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'entrypoint_invalid')
        return /** @type {GitFetchFailure} */ ({
          ok: false,
          errorKind: 'entrypoint_invalid',
          message: entrypointError,
        })
      }

      const symlinkPath = await findSymlink(sourceRoot, sourceRoot)
      if (symlinkPath) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'artifact_symlink_unsupported')
        return /** @type {GitFetchFailure} */ ({
          ok: false,
          errorKind: 'artifact_symlink_unsupported',
          message: `plugin install: remote installs reject symlinks (found ${symlinkPath})`,
        })
      }

      span.setAttribute(Attr.PLUGIN, manifest.name)
      span.setAttribute('status', 'ok')
      return /** @type {{ ok: true, manifest: PluginManifest }} */ ({ ok: true, manifest })
    },
    { component: 'plugin-install' }
  )
}

/**
 * @param {{ sourceRoot: string, tmpArtifact: string, finalInstallDir: string, manifestName: string }} args
 * @returns {Promise<{ ok: true } | GitFetchFailure>}
 */
async function runCopyArtifactSpan({ sourceRoot, tmpArtifact, finalInstallDir, manifestName }) {
  return withSpan(
    'plugin.artifact.copy',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.artifact.copy',
      [Attr.PLUGIN]: manifestName,
    },
    async (span) => {
      try {
        await fs.mkdir(tmpArtifact, { recursive: true })
        await copyArtifactTree(sourceRoot, tmpArtifact)
      } catch (err) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'artifact_copy_failed')
        return /** @type {GitFetchFailure} */ ({
          ok: false,
          errorKind: 'artifact_copy_failed',
          message: `plugin install: copy failed: ${describeError(err)}`,
        })
      }

      await fs.mkdir(path.dirname(finalInstallDir), { recursive: true })
      const backupDir = `${finalInstallDir}.bak-${process.pid}-${Date.now()}`
      let backedUp = false
      try {
        await fs.rename(finalInstallDir, backupDir)
        backedUp = true
      } catch (err) {
        if (!(err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT')) {
          span.setAttribute('status', 'failed')
          span.setAttribute('error_kind', 'artifact_copy_failed')
          return /** @type {GitFetchFailure} */ ({
            ok: false,
            errorKind: 'artifact_copy_failed',
            message: `plugin install: could not move prior install aside: ${describeError(err)}`,
          })
        }
      }

      try {
        await fs.rename(tmpArtifact, finalInstallDir)
      } catch (err) {
        // Roll back the rename of the prior install if we did move one.
        if (backedUp) {
          await fs.rename(backupDir, finalInstallDir).catch(() => undefined)
        }
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'artifact_copy_failed')
        return /** @type {GitFetchFailure} */ ({
          ok: false,
          errorKind: 'artifact_copy_failed',
          message: `plugin install: install rename failed: ${describeError(err)}`,
        })
      }

      if (backedUp) {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
      }

      span.setAttribute('status', 'ok')
      return /** @type {{ ok: true }} */ ({ ok: true })
    },
    { component: 'plugin-install' }
  )
}

/**
 * Validate that a manifest entrypoint is a relative path that stays
 * inside the artifact root. Returns an error message string when the
 * entrypoint is invalid, or `undefined` when it passes.
 *
 * @param {string} entrypoint
 * @param {string} root
 */
export function validateEntrypoint(entrypoint, root) {
  if (path.isAbsolute(entrypoint)) {
    return `plugin install: entrypoint '${entrypoint}' must be a relative path`
  }
  const segs = entrypoint.split(/[\\/]/)
  if (segs.includes('..')) {
    return `plugin install: entrypoint '${entrypoint}' must not escape the artifact root`
  }
  const resolved = path.resolve(root, entrypoint)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return `plugin install: entrypoint '${entrypoint}' resolves outside the artifact root`
  }
  return undefined
}

/**
 * Walk the source tree and return the first symlink encountered.
 * Skipped directories (`.git`, `node_modules`, etc.) are ignored.
 *
 * @param {string} root
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
export async function findSymlink(root, dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
    throw err
  }
  for (const entry of entries) {
    if (SKIPPED_DIR_NAMES.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      return path.relative(root, full).split(path.sep).join('/') || entry.name
    }
    if (entry.isDirectory()) {
      const nested = await findSymlink(root, full)
      if (nested) return nested
    }
  }
  return null
}

/**
 * Copy a directory tree, skipping development byproducts and refusing
 * symlinks. The symlink check is also done in `findSymlink` during
 * validate, but this guards against a TOCTOU race where the tree
 * changed between validate and copy.
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
    if (entry.isSymbolicLink()) {
      throw new Error(`unexpected symlink in artifact tree: ${entry.name}`)
    }
    if (entry.isDirectory()) {
      await fs.mkdir(toPath, { recursive: true })
      await copyArtifactTree(fromPath, toPath)
    } else if (entry.isFile()) {
      await fs.copyFile(fromPath, toPath)
    }
  }
}

/**
 * Compute a stable SHA-256 over the artifact tree. Files are visited
 * in lexicographic order (relative path) and each file contributes a
 * `path\0sha256(content)\n` line. Mirrors `fetch.hashArtifactTree`
 * for parity with the local-dir code path.
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
    if (SKIPPED_DIR_NAMES.has(entry.name)) continue
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

/**
 * Best-effort default-branch resolution. Tries the `HEAD` symbolic ref
 * first, then `origin/HEAD` if that fails. Returns `undefined` if both
 * paths come up empty so the caller can surface `git_checkout_failed`.
 *
 * @param {string} tmpRepo
 * @returns {Promise<string | undefined>}
 */
async function resolveDefaultBranch(tmpRepo) {
  const localHead = await execGit(['-C', tmpRepo, 'symbolic-ref', '--short', '-q', 'HEAD'])
  if (localHead.code === 0 && localHead.stdout.trim()) {
    return localHead.stdout.trim()
  }
  const remoteHead = await execGit(['-C', tmpRepo, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
  if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
    const fullName = remoteHead.stdout.trim()
    return fullName.replace(/^origin\//, '')
  }
  return undefined
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function execGit(args, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' }
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /** @type {Buffer[]} */
    const stdoutChunks = []
    /** @type {Buffer[]} */
    const stderrChunks = []
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)))
    child.on('error', () => {
      resolve({ code: -1, stdout: '', stderr: 'git binary unavailable' })
    })
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    })
  })
}

/** @returns {Promise<boolean>} */
async function isGitOnPath() {
  const probe = await execGit(['--version'])
  return probe.code === 0
}

/**
 * Strip anything that looks like an authentication token before
 * surfacing a git CLI error. `git` is generally well-behaved here, but
 * a malformed user-supplied URL can echo `https://x:secret@host/...`
 * straight into stderr.
 *
 * @param {string} msg
 */
function redactGitMessage(msg) {
  return msg
    .replace(/https?:\/\/[^@/\s]+:[^@\s]+@/g, 'https://<redacted>@')
    .replace(/(token|authorization|x-api-key)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .trim()
}

/** @param {unknown} err */
function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}

/** @param {string} s */
function hashString(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function defaultRunId() {
  return `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
}
