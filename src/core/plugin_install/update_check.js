// @ts-check

import { spawn } from 'node:child_process'

import { Attr, getKernelInstruments, SpanStatusCode, withSpan } from '../observability/index.js'

/**
 * @import { PluginLockEntry, PluginUpdateState } from '../../../collectivus-plugin-kernel-types.js'
 */

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

/**
 * Hard ceiling on `git ls-remote` probes. The plugin install pipeline
 * runs this synchronously inside `installPlugin` after the artifact has
 * already landed, so an unbounded wait turns a slow or blackholed
 * remote into a frozen CLI. Five seconds is well above a healthy
 * remote round-trip and well below human "is it stuck?" patience.
 *
 * Overridable via `HYP_GIT_PROBE_TIMEOUT_MS` for tests and operators
 * with unusually slow remotes; clamped to a sane range so a hostile
 * env value cannot disable the timeout outright.
 */
const DEFAULT_GIT_PROBE_TIMEOUT_MS = 5000
const MIN_GIT_PROBE_TIMEOUT_MS = 250
const MAX_GIT_PROBE_TIMEOUT_MS = 60_000

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
 * The `freshlyResolved` flag short-circuits the network probe when
 * the caller already resolved the upstream ref (install / update
 * flows). In that case the recorded `resolved_ref` IS the canonical
 * upstream value as of "now," so re-querying just risks hanging the
 * CLI on a slow remote. The synthesized state reuses the same
 * `checked_at` semantics as a real probe.
 *
 * @param {object} args
 * @param {PluginLockEntry} args.entry
 * @param {() => Date}     [args.now]
 * @param {boolean}        [args.freshlyResolved]
 * @returns {Promise<PluginUpdateState>}
 */
export async function checkForPluginUpdate({ entry, now, freshlyResolved }) {
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
      let state
      if (freshlyResolved) {
        // The fetch path resolved the upstream ref a tick ago; re-
        // querying just risks blocking the install span on a slow
        // remote. Synthesize the state and mark the span so smokes can
        // see we deliberately skipped the network probe.
        s.setAttribute('probe_skipped', 'freshly_resolved')
        state = freshlyResolvedState(entry, nowDate)
      } else {
        state = await runProbe(entry, nowDate)
      }
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
 * Build a synthesized "no update available" state for entries whose
 * upstream ref was just resolved by the install / update path. Mirrors
 * the shape `runProbe` produces on success so callers and observers do
 * not need a separate branch.
 *
 * @param {PluginLockEntry} entry
 * @param {Date} now
 * @returns {PluginUpdateState}
 */
function freshlyResolvedState(entry, now) {
  /** @type {PluginUpdateState} */
  const state = {
    checked_at: now.toISOString(),
    available: false,
  }
  if (entry.resolved_ref) state.latest_ref = entry.resolved_ref
  return state
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
 * `available=false` when Phase 8 brings real fetch online, this
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
 * @param {PluginLockEntry} entry
 * @param {string} checkedAt
 * @returns {Promise<PluginUpdateState>}
 */
async function runGitProbe(entry, checkedAt) {
  const gitUrl = entry.source.gitUrl
  if (!gitUrl) {
    return { checked_at: checkedAt, available: false, error: 'missing gitUrl' }
  }
  const ref = entry.source.ref || 'HEAD'
  // `--` separates options from the URL/ref positionals so a hostile
  // gitUrl or ref like `--upload-pack=<cmd>` cannot be parsed as a
  // git option (CVE-2018-17456 family). The resolver also rejects
  // leading-dash inputs upstream: this is the spawn-boundary defense.
  const probe = await execGit(['ls-remote', '--quiet', '--', gitUrl, ref])
  if (probe.code !== 0) {
    return {
      checked_at: checkedAt,
      available: false,
      error: probe.timedOut ? 'git_probe_timeout' : 'git_ls_remote_failed',
    }
  }
  const latestRef = pickLsRemoteSha(probe.stdout, ref)
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
 * Pick the upstream commit SHA from `git ls-remote` output, preferring
 * the peeled `<ref>^{}` line when present so annotated tags resolve to
 * the tagged commit instead of the tag object's own SHA.
 *
 * `git ls-remote --quiet -- <url> <ref>` prints one line per ref it
 * matches, formatted `<sha>\t<refname>`. For annotated tags the
 * output contains both `refs/tags/<name>` (the tag object) and
 * `refs/tags/<name>^{}` (the peeled commit). Comparing the tag-object
 * SHA against `entry.resolved_ref`, which is always a commit SHA,
 * produces a spurious "update available" signal. The peeled line is
 * the authoritative match.
 *
 * When the caller asked for `HEAD`, prefer the line whose refname ends
 * with `HEAD` so we don't accidentally pick up a stale tag line that
 * may also be present.
 *
 * @param {string} stdout
 * @param {string} requestedRef
 * @returns {string | undefined}
 */
export function pickLsRemoteSha(stdout, requestedRef) {
  /** @type {Array<{ sha: string, refname: string }>} */
  const rows = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    const sha = parts[0]
    const refname = parts[1] ?? ''
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue
    rows.push({ sha, refname })
  }
  if (rows.length === 0) return undefined

  // Prefer a peeled annotated tag (refs/tags/<x>^{}): its SHA is the
  // commit the tag points at, which is what we compared `resolved_ref`
  // against when we recorded it.
  const peeled = rows.find((r) => r.refname.endsWith('^{}'))
  if (peeled) return peeled.sha

  if (requestedRef === 'HEAD' || requestedRef === '') {
    const head = rows.find(
      (r) => r.refname === 'HEAD' || r.refname.endsWith('/HEAD')
    )
    if (head) return head.sha
  }

  return rows[0].sha
}

/**
 * @returns {number}
 */
function gitProbeTimeoutMs() {
  const raw = process.env.HYP_GIT_PROBE_TIMEOUT_MS
  if (!raw) return DEFAULT_GIT_PROBE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_GIT_PROBE_TIMEOUT_MS
  return Math.min(MAX_GIT_PROBE_TIMEOUT_MS, Math.max(MIN_GIT_PROBE_TIMEOUT_MS, parsed))
}

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut?: boolean }>}
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
    let timedOut = false
    let settled = false

    const timeoutMs = gitProbeTimeoutMs()
    const timer = setTimeout(() => {
      timedOut = true
      // SIGTERM first; if the child ignores it, the SIGKILL closes it.
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      setTimeout(() => {
        if (!settled) {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }
      }, 250).unref()
    }, timeoutMs)
    timer.unref?.()

    /** @param {{ code: number, stdout: string, stderr: string, timedOut?: boolean }} result */
    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)))
    child.on('error', () => finish({ code: -1, stdout: '', stderr: 'git binary unavailable' }))
    child.on('close', (code) => {
      finish({
        code: timedOut ? -1 : (code ?? -1),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        ...(timedOut ? { timedOut: true } : {}),
      })
    })
  })
}
