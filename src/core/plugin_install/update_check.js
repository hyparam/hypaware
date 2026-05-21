// @ts-check

import { spawn } from 'node:child_process'

import { Attr, getKernelInstruments, SpanStatusCode, withSpan } from '../observability/index.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginLockEntry} PluginLockEntry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginUpdateState} PluginUpdateState */

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

/**
 * Run an update check for one installed plugin. The check is best-
 * effort: it never throws, and a failure is recorded on the returned
 * `PluginUpdateState.error` field with `available=false`. The kernel
 * is rate-limited to one network probe per 24h per plugin per the
 * design's "share policy with the existing npm update check" note.
 *
 * For `local-dir` sources there is no upstream to query, so the
 * check is intrinsically `available=false` and the span emits in a
 * single tick without any side effect.
 *
 * @param {object} args
 * @param {PluginLockEntry} args.entry
 * @param {() => Date}     [args.now]
 * @returns {Promise<PluginUpdateState>}
 */
export async function checkForPluginUpdate({ entry, now }) {
  const nowDate = (now ?? (() => new Date()))()
  const instruments = getKernelInstruments()

  if (isRateLimited(entry, nowDate)) {
    const previous = entry.update
    if (previous) {
      instruments.pluginUpdatesAvailable.record(previous.available ? 1 : 0, {
        [Attr.PLUGIN]: entry.name,
      })
      return previous
    }
  }

  const span = await withSpan(
    'plugin.update_check',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.update_check',
      [Attr.PLUGIN]: entry.name,
      hyp_source_kind: entry.source.kind,
    },
    async (s) => {
      const state = await runProbe(entry, nowDate)
      if (state.error) {
        s.setStatus({ code: SpanStatusCode.ERROR, message: 'update_probe_failed' })
        s.setAttribute('status', 'failed')
        s.setAttribute('error_kind', 'update_probe_failed')
      } else {
        s.setAttribute('status', 'ok')
      }
      s.setAttribute('available', !!state.available)
      if (state.latest_version) s.setAttribute('latest_version', state.latest_version)
      if (state.latest_ref) s.setAttribute('latest_ref', state.latest_ref)
      return state
    },
    { component: 'plugin-install' }
  )

  instruments.pluginUpdatesAvailable.record(span.available ? 1 : 0, {
    [Attr.PLUGIN]: entry.name,
  })
  return span
}

/**
 * Decide whether the entry's existing `update.checked_at` is recent
 * enough to skip the probe. Defensive against malformed timestamps
 * (missing or non-ISO strings count as "stale enough").
 *
 * @param {PluginLockEntry} entry
 * @param {Date}             now
 */
function isRateLimited(entry, now) {
  const previous = entry.update
  if (!previous || !previous.checked_at) return false
  const parsed = Date.parse(previous.checked_at)
  if (Number.isNaN(parsed)) return false
  return now.getTime() - parsed < TWENTY_FOUR_HOURS_MS
}

/**
 * Probe the upstream for a newer version. The Phase 7 implementation
 * intentionally only handles `local-dir` (no upstream). The other
 * kinds get a benign "no upstream wired yet" response with
 * `available=false` — when Phase 8 brings real fetch online, this
 * function gets the actual git/npm probe without changing the span
 * contract.
 *
 * @param {PluginLockEntry} entry
 * @param {Date} now
 * @returns {Promise<PluginUpdateState>}
 */
async function runProbe(entry, now) {
  const checkedAt = now.toISOString()
  if (entry.source.kind === 'local-dir') {
    return { checked_at: checkedAt, available: false }
  }
  if (entry.source.kind === 'git') {
    return runGitProbe(entry, checkedAt)
  }
  return {
    checked_at: checkedAt,
    available: false,
  }
}

/**
 * Probe a git source's upstream by running `git ls-remote`. The probe
 * compares the resolved upstream commit for the locked `source.ref`
 * (or the remote's default `HEAD`) against the entry's `resolved_ref`
 * and sets `available=true` when they differ.
 *
 * The probe is best-effort: a non-zero exit or unparseable output
 * records an error on the returned state but never throws.
 *
 * @param {import('../../../collectivus-plugin-kernel-types').PluginLockEntry} entry
 * @param {string} checkedAt
 * @returns {Promise<import('../../../collectivus-plugin-kernel-types').PluginUpdateState>}
 */
async function runGitProbe(entry, checkedAt) {
  const gitUrl = entry.source.gitUrl
  if (!gitUrl) {
    return { checked_at: checkedAt, available: false, error: 'missing gitUrl' }
  }
  const ref = entry.source.ref || 'HEAD'
  const probe = await execGit(['ls-remote', '--quiet', gitUrl, ref])
  if (probe.code !== 0) {
    return {
      checked_at: checkedAt,
      available: false,
      error: 'git_ls_remote_failed',
    }
  }
  const latestRef = parseLsRemoteOutput(probe.stdout)
  if (!latestRef) {
    return {
      checked_at: checkedAt,
      available: false,
      error: 'no_ref_resolved',
    }
  }
  const available = !!entry.resolved_ref && latestRef !== entry.resolved_ref
  return {
    checked_at: checkedAt,
    latest_ref: latestRef,
    available,
  }
}

/**
 * Extract the first commit SHA from `git ls-remote` output. Each line
 * is `<sha>\t<refname>`; we take the first SHA so behavior is stable
 * regardless of whether the caller asked for `HEAD`, a branch, or a
 * tag.
 *
 * @param {string} stdout
 */
function parseLsRemoteOutput(stdout) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const sha = trimmed.split(/\s+/)[0]
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha
  }
  return undefined
}

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function execGit(args) {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    const child = spawn('git', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /** @type {Buffer[]} */
    const stdoutChunks = []
    /** @type {Buffer[]} */
    const stderrChunks = []
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)))
    child.on('error', () => resolve({ code: -1, stdout: '', stderr: 'git binary unavailable' }))
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    })
  })
}
