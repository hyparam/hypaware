// @ts-check

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { readObservabilityEnv } from '../observability/env.js'
import { effectiveDefaultRemote, effectiveRemotes } from '../remote/builtin_remotes.js'
import {
  attachWithRefresh,
  deriveIdentityBase,
  deriveReportsEndpoint,
  describeAuthRejection,
  isRefreshable,
  resolveAccessJwt,
} from '../remote/credentials.js'
import { describeRefreshError, NO_FETCH_MESSAGE } from '../remote/identity_client.js'
import { positionals, valueFlag } from './remote_commands.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

const execFileAsync = promisify(execFile)

/**
 * Core `report` commands: the member-facing client of the server's org-scoped
 * reports plane (`/v1/reports`). Core, not a plugin, on the same ground that
 * made `remote` core: `hyp` is the human-CLI client of the server's
 * self-authenticating planes, and these commands reuse the whole `--remote`
 * credential stack (target registry, 0600 store, silent refresh). Reports are
 * server-specific, so there is no local mode: `--remote` selects a server, it
 * never switches one on.
 *
 * @ref LLP 0111#core-group [implements]: report commands are core and ride the remote credential machinery verbatim
 */

/** Server grammar for `kind` and `period`, copied for fail-fast UX only. */
// @ref LLP 0111#fail-fast [implements]: client-side copies reject a typo before bytes move; the server stays authoritative
const KIND_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const PERIOD_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/

/** The value-taking flags shared across the `report` subcommands. */
const VALUE_FLAGS = new Set(['--kind', '--period', '--title', '--org', '--remote', '--limit', '--before', '--output'])

/**
 * `hyp report publish <file-or-dir>`: publish a report artifact to the org's
 * reports plane. A file publishes a single document (`.html`/`.md`); a
 * directory publishes a gzipped ustar bundle built by the system tar.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runReportPublish(argv, ctx) {
  const source = positionals(argv, VALUE_FLAGS)[0]
  const kind = valueFlag(argv, '--kind').value
  const period = valueFlag(argv, '--period').value
  // @ref LLP 0111#period-explicit [constrained-by]: period is the coverage window only the generator knows; never default it from the current date
  if (!source || !kind || !period) {
    ctx.stderr.write('usage: hyp report publish <file-or-dir> --kind <kind> --period <period> [--title <title>] [--org <org>] [--remote <target>]\n')
    return 2
  }
  if (!KIND_RE.test(kind)) {
    ctx.stderr.write(`hyp report publish: kind must match [a-z0-9][a-z0-9-]* (max 64), got '${kind}'\n`)
    return 2
  }
  if (!PERIOD_RE.test(period)) {
    ctx.stderr.write(`hyp report publish: period must match [A-Za-z0-9][A-Za-z0-9.-]* (max 64), got '${period}' (e.g. 2026-W29 or 2026-07-20)\n`)
    return 2
  }

  /** @type {Buffer} */
  let body
  /** @type {string} */
  let contentType
  /** @type {import('node:fs').Stats} */
  let stat
  try {
    stat = await fs.stat(source)
  } catch {
    ctx.stderr.write(`hyp report publish: no such file or directory: ${source}\n`)
    return 2
  }
  if (stat.isDirectory()) {
    // A bundle without an entry document is rejected server-side after the
    // whole upload; catch it here in milliseconds instead.
    const hasEntry = await fileExists(path.join(source, 'report.html')) || await fileExists(path.join(source, 'report.md'))
    if (!hasEntry) {
      ctx.stderr.write(`hyp report publish: ${source} must contain report.html or report.md at its root\n`)
      return 2
    }
    try {
      body = await packUstarBundle(source)
    } catch (err) {
      ctx.stderr.write(`hyp report publish: could not build the bundle: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    contentType = 'application/gzip'
  } else {
    const ext = path.extname(source).toLowerCase()
    if (ext === '.html' || ext === '.htm') contentType = 'text/html'
    else if (ext === '.md' || ext === '.markdown') contentType = 'text/markdown'
    else {
      ctx.stderr.write(`hyp report publish: a single-file report must be .html or .md (got '${ext || source}'); publish a folder for anything richer\n`)
      return 2
    }
    body = await fs.readFile(source)
  }

  const resolved = resolveReportsTarget(argv, ctx, 'report publish')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  const title = valueFlag(argv, '--title').value
  const url = new URL(resolved.endpoint)
  url.searchParams.set('kind', kind)
  url.searchParams.set('period', period)
  if (title) url.searchParams.set('title', title)
  applyOrgParam(argv, url)

  const outcome = await reportsRequest({ ctx, ...resolved, write: true, cmd: 'report publish' }, (token) =>
    fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': contentType,
        // Retry safety: a timed-out re-run of the same artifact answers 200
        // with the existing report instead of double-listing it.
        'x-report-content-hash': crypto.createHash('sha256').update(body).digest('hex'),
      },
      body,
    })
  )
  if (!outcome.ok) {
    ctx.stderr.write(`hyp report publish: ${outcome.error}\n`)
    return outcome.exitCode
  }
  const { response } = outcome
  if (response.status !== 200 && response.status !== 201) {
    ctx.stderr.write(`hyp report publish: ${await describeErrorResponse(response)}\n`)
    return 1
  }
  const parsed = /** @type {any} */ (await response.json().catch(() => null))
  const record = parsed?.report ?? {}
  const where = `${record.kind ?? kind}/${record.period ?? period}/${record.id ?? '?'}`
  if (response.status === 200) {
    ctx.stdout.write(`already published as ${where} (same content) - nothing new uploaded\n`)
  } else {
    ctx.stdout.write(`published ${where} (${record.files ?? '?'} file(s), ${record.bytes ?? '?'} bytes)\n`)
    ctx.stdout.write(`  view: hyp report get ${record.kind ?? kind} ${record.period ?? period} ${record.id ?? '<id>'}\n`)
  }
  return 0
}

/**
 * `hyp report list`: list the org's published reports, newest first.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runReportList(argv, ctx) {
  const resolved = resolveReportsTarget(argv, ctx, 'report list')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  const url = new URL(resolved.endpoint)
  for (const flag of ['kind', 'period', 'limit', 'before']) {
    const value = valueFlag(argv, `--${flag}`).value
    if (value !== undefined) url.searchParams.set(flag, value)
  }
  applyOrgParam(argv, url)

  const outcome = await reportsRequest({ ctx, ...resolved, write: false, cmd: 'report list' }, (token) =>
    fetch(url, { headers: { authorization: `Bearer ${token}` } })
  )
  if (!outcome.ok) {
    ctx.stderr.write(`hyp report list: ${outcome.error}\n`)
    return outcome.exitCode
  }
  const { response } = outcome
  if (response.status !== 200) {
    ctx.stderr.write(`hyp report list: ${await describeErrorResponse(response)}\n`)
    return 1
  }
  const parsed = /** @type {any} */ (await response.json().catch(() => null))
  const reports = Array.isArray(parsed?.reports) ? parsed.reports : []
  if (argv.includes('--json')) {
    ctx.stdout.write(JSON.stringify(reports, null, 2) + '\n')
    return 0
  }
  if (reports.length === 0) {
    ctx.stdout.write("no reports published - publish one with 'hyp report publish <file-or-dir> --kind <kind> --period <period>'\n")
    return 0
  }
  for (const r of reports) {
    const title = typeof r.title === 'string' && r.title ? `\t${r.title}` : ''
    ctx.stdout.write(`  ${r.publishedAt}\t${r.kind}/${r.period}\t${r.id}\t${r.bytes} bytes${title}\n`)
  }
  return 0
}

/**
 * `hyp report get <kind> <period> <id> [path]`: fetch a report's entry
 * document (or one named artifact) and write it to stdout or `--output`.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runReportGet(argv, ctx) {
  const [kind, period, id, ...fileSegments] = positionals(argv, VALUE_FLAGS)
  if (!kind || !period || !id) {
    ctx.stderr.write('usage: hyp report get <kind> <period> <id> [path] [--output <file>] [--org <org>] [--remote <target>]\n')
    return 2
  }
  const outputArg = valueFlag(argv, '--output')
  if (outputArg.present && !outputArg.value) {
    ctx.stderr.write('hyp report get: --output expects a file path\n')
    return 2
  }
  const resolved = resolveReportsTarget(argv, ctx, 'report get')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  // The artifact path is one positional with '/' separators; encode each
  // segment, never the separators.
  const suffix = fileSegments.flatMap((s) => s.split('/')).map(encodeURIComponent).join('/')
  const url = new URL(`${resolved.endpoint}/${encodeURIComponent(kind)}/${encodeURIComponent(period)}/${encodeURIComponent(id)}/${suffix}`)
  applyOrgParam(argv, url)

  const outcome = await reportsRequest({ ctx, ...resolved, write: false, cmd: 'report get' }, (token) =>
    fetch(url, { headers: { authorization: `Bearer ${token}` } })
  )
  if (!outcome.ok) {
    ctx.stderr.write(`hyp report get: ${outcome.error}\n`)
    return outcome.exitCode
  }
  const { response } = outcome
  if (response.status !== 200) {
    ctx.stderr.write(`hyp report get: ${await describeErrorResponse(response)}\n`)
    return 1
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (outputArg.value) {
    try {
      await fs.writeFile(outputArg.value, bytes)
    } catch (err) {
      ctx.stderr.write(`hyp report get: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    ctx.stderr.write(`saved ${bytes.length} bytes to ${outputArg.value}\n`)
    return 0
  }
  // Artifacts can be binary (images, fonts); the kernel WriteStream type is
  // string-only but the real stream accepts Buffers, so bypass the type here
  // rather than corrupt bytes through a string round-trip.
  /** @type {{ write(chunk: string | Buffer): unknown }} */ (ctx.stdout).write(bytes)
  return 0
}

/**
 * `hyp report delete <kind> <period> <id>`: tombstone a report and delete its
 * artifacts. Org-wide and unrecoverable (any publish-scope holder can delete
 * any of the org's reports), so it follows `hyp purge`'s confirmation
 * posture: prompt on a TTY, require `--yes` otherwise.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 * @ref LLP 0111#delete-confirm [implements]: org-wide destructive verb confirms like purge, not like remote remove
 */
export async function runReportDelete(argv, ctx) {
  const [kind, period, id] = positionals(argv, VALUE_FLAGS)
  if (!kind || !period || !id) {
    ctx.stderr.write('usage: hyp report delete <kind> <period> <id> [--yes] [--org <org>] [--remote <target>]\n')
    return 2
  }
  const resolved = resolveReportsTarget(argv, ctx, 'report delete')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  if (!argv.includes('--yes')) {
    const stdin = /** @type {any} */ (ctx.stdin ?? process.stdin)
    if (!stdin || !stdin.isTTY) {
      ctx.stderr.write('error: refusing to delete without confirmation - pass --yes to delete non-interactively\n')
      return 2
    }
    const ok = await confirm(ctx, `${kind}/${period}/${id}`)
    if (!ok) {
      ctx.stdout.write('delete cancelled\n')
      return 0
    }
  }
  const url = new URL(`${resolved.endpoint}/${encodeURIComponent(kind)}/${encodeURIComponent(period)}/${encodeURIComponent(id)}`)
  applyOrgParam(argv, url)

  const outcome = await reportsRequest({ ctx, ...resolved, write: true, cmd: 'report delete' }, (token) =>
    fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
  )
  if (!outcome.ok) {
    ctx.stderr.write(`hyp report delete: ${outcome.error}\n`)
    return outcome.exitCode
  }
  const { response } = outcome
  if (response.status !== 200) {
    ctx.stderr.write(`hyp report delete: ${await describeErrorResponse(response)}\n`)
    return 1
  }
  ctx.stdout.write(`deleted ${kind}/${period}/${id}\n`)
  return 0
}

/* ---------- helpers ---------- */

/**
 * Resolve the target server for a report subcommand: `--remote <target>`,
 * else the effective default (`query.default_remote`, else the shipped
 * built-in). Reports are server-only, so unlike queries there is no local
 * fallback to select away from.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {string} cmd for error prefixes, e.g. `report list`
 * @returns {{ target: string, endpoint: string, identityBase: string | undefined } | { error: string }}
 * @ref LLP 0111#target [implements]: target defaults like bare --remote; the endpoint derives from the one registered URL
 */
function resolveReportsTarget(argv, ctx, cmd) {
  const remoteArg = valueFlag(argv, '--remote')
  if (remoteArg.present && !remoteArg.value) {
    return { error: `hyp ${cmd}: --remote expects a target name (omit it to use the default target)` }
  }
  const target = remoteArg.value ?? effectiveDefaultRemote(ctx.config)
  const entry = effectiveRemotes(ctx.config)[target]
  if (!entry) {
    return { error: `hyp ${cmd}: unknown remote target '${target}' - add it with 'hyp remote add ${target} <url>'` }
  }
  return {
    target,
    endpoint: deriveReportsEndpoint(entry.url).replace(/\/+$/, ''),
    identityBase: deriveIdentityBase(entry.url) ?? undefined,
  }
}

/**
 * Forward an explicit `--org` as the `org` query parameter. Needed only when
 * the bearer is the operator admin token (via the per-target env override),
 * which must name its org explicitly; a scoped credential pins its own org
 * and a mismatching param is a server-side 403, never a merge.
 *
 * @param {string[]} argv
 * @param {URL} url
 */
function applyOrgParam(argv, url) {
  const org = valueFlag(argv, '--org')
  // `--org=''` is the admin single-org form, so presence matters, not truthiness.
  if (org.present && org.value !== undefined) url.searchParams.set('org', org.value)
}

/**
 * Run one authorized request against the reports plane with the shared
 * one-shot refresh + retry policy (LLP 0058 D5): resolve the bearer, call
 * `send`, and on a 401 from a refreshable session force one refresh and
 * retry. A 401 that survives is explained per direction: reads get the
 * standard guidance; writes name the missing-publisher-role cause too, since
 * the server answers 401 (not 403) to a valid session that lacks the
 * report-publish scope.
 *
 * @param {{ ctx: CommandRunContext, target: string, identityBase: string | undefined, write: boolean, cmd: string }} args
 * @param {(token: string) => Promise<Response>} send
 * @returns {Promise<{ ok: true, response: Response } | { ok: false, error: string, exitCode: number }>}
 * @ref LLP 0111#write-401 [implements]: a write 401 that survives the retry is ambiguous - say both expiry and missing scope
 */
async function reportsRequest({ ctx, target, identityBase, write, cmd }, send) {
  if (typeof (/** @type {unknown} */ (globalThis.fetch)) !== 'function') {
    return { ok: false, error: `${NO_FETCH_MESSAGE} for 'hyp ${cmd}'`, exitCode: 1 }
  }
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  /** @type {Awaited<ReturnType<typeof resolveAccessJwt>>} */
  let resolved
  try {
    resolved = await resolveAccessJwt({ target, env: ctx.env, stateDir, identityBase })
  } catch (err) {
    return mapRefreshError(err, target)
  }
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, exitCode: 2 }
  }

  /** @param {string} token @returns {Promise<{ authFailed: boolean, value: { ok: true, response: Response } | { ok: false, error: string, exitCode: number } }>} */
  const op = async (token) => {
    /** @type {Response} */
    let response
    try {
      response = await send(token)
    } catch (err) {
      return { authFailed: false, value: { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 } }
    }
    // Only a 401 is retryable-by-refresh here. A 403 is org_mismatch (an
    // explicit --org differing from the credential's org), which no refresh
    // can fix; it flows through as an ordinary error response.
    return { authFailed: response.status === 401, value: { ok: true, response } }
  }

  try {
    const out = await attachWithRefresh({
      resolved,
      refresh: () => resolveAccessJwt({ target, env: ctx.env, stateDir, identityBase, forceRefresh: true }),
      op,
    })
    if (!out.ok) return { ok: false, error: out.error, exitCode: 2 }
    if (out.authFailed) {
      if (write && isRefreshable(resolved)) {
        return {
          ok: false,
          error:
            `'${target}' refused the credential (HTTP 401) - your session may have expired ` +
            `(re-run 'hyp remote login ${target}'), or your account lacks the publisher role that ` +
            `report writes require - ask a server admin for it, or store an operator-minted publish ` +
            `token with 'hyp remote login ${target} --token-file <path>'`,
          exitCode: 1,
        }
      }
      const { message, exitCode } = describeAuthRejection({ target, status: 401, resolved })
      return { ok: false, error: message, exitCode }
    }
    return out.value
  } catch (refreshErr) {
    return mapRefreshError(refreshErr, target)
  }
}

/**
 * @param {unknown} err
 * @param {string} target
 * @returns {{ ok: false, error: string, exitCode: number }}
 */
function mapRefreshError(err, target) {
  const { sessionExpired, message } = describeRefreshError(err, target)
  return { ok: false, error: message, exitCode: sessionExpired ? 2 : 1 }
}

/**
 * Render a non-2xx reports-plane response: the server's `{ error, detail }`
 * JSON when present, with the quota error carrying its make-room-explicitly
 * guidance (nothing is ever auto-pruned).
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function describeErrorResponse(response) {
  const parsed = /** @type {any} */ (await response.json().catch(() => null))
  const code = typeof parsed?.error === 'string' ? parsed.error : null
  const detail = typeof parsed?.detail === 'string' ? parsed.detail : null
  if (code === 'report_quota_exceeded') {
    return `the org's report quota is full (HTTP 507)${detail ? ` - ${detail}` : ''} - delete old reports with 'hyp report delete' or ask the operator to raise the quota; nothing is auto-pruned`
  }
  if (code) return `HTTP ${response.status}: ${code}${detail ? ` - ${detail}` : ''}`
  return `HTTP ${response.status}`
}

/**
 * Build a gzipped plain-ustar bundle of `dir` with the system tar. The format
 * is pinned because default formats emit pax/GNU extension entries
 * (typeflags x/g/L/K) the server rejects - and only for some inputs, which
 * would make bundles that work in tests and break on the first long filename.
 *
 * @param {string} dir
 * @returns {Promise<Buffer>}
 * @ref LLP 0111#bundle [implements]: the publish CLI owns bundle creation and pins tar --format=ustar
 */
async function packUstarBundle(dir) {
  const { stdout } = await execFileAsync('tar', ['--format=ustar', '-cz', '-C', dir, '.'], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
  })
  return stdout
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function fileExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * @param {CommandRunContext} ctx
 * @param {string} what
 * @returns {Promise<boolean>}
 */
async function confirm(ctx, what) {
  const rl = readline.createInterface({
    input: /** @type {NodeJS.ReadableStream} */ (ctx.stdin ?? process.stdin),
    output: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (ctx.stderr)),
  })
  try {
    const answer = await rl.question(`Delete report ${what} for the whole org? This cannot be undone. [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}
