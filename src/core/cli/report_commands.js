// @ts-check

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { askYesNo } from './confirm.js'
import { parseCoreCommandArgv } from './command_args.js'
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
import { positionals } from './remote_commands.js'
import { isTty } from './stdio.js'
import { PromptCancelledError, select } from './tui/index.js'
import { isPromptBackError } from './tui/runtime.js'
import { buildWalkthroughClientDescriptorMap } from './walkthrough.js'
import { launchClient, resolveLaunchers } from './wizard/first_ask.js'
import { askableClients, attachHint } from '../commands/ask.js'
import { escapeForDisplay } from '../util/json_util.js'

/**
 * @import { Stats } from 'node:fs'
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { FirstAskLauncher } from '../../../src/core/cli/wizard/types.js'
 * @import { FixBasisQuery, FixEvidence, FixRecommendation } from '../../../src/core/cli/types.js'
 */

const execFileAsync = promisify(execFile)

/**
 * Reports-plane text on its way to a person's terminal. Every field the
 * server sends is remote-authored, and an ESC or `\r` in a title could
 * repaint the listing line that pairs a title with the id a reader pastes
 * into `hyp report fix`. Machine renders (`--json`, the client's prompt)
 * stay byte-exact.
 *
 * @ref LLP 0225#decision [constrained-by]: remote text is escaped where a person reads it, never where a program does
 * @param {unknown} value
 * @returns {string}
 */
const esc = (value) => escapeForDisplay(String(value))

/**
 * Core `report` commands: the member-facing client of the server's org-scoped
 * reports plane (`/v1/reports`). Core, not a plugin, on the same ground that
 * made `remote` core: `hyp` is the human-CLI client of the server's
 * self-authenticating planes, and these commands reuse the whole `--remote`
 * credential stack (target registry, 0600 store, silent refresh). Reports are
 * server-specific, so there is no local mode: `--remote` selects a server, it
 * never switches one on.
 *
 * @ref LLP 0155#core-group [implements]: report commands are core and ride the remote credential machinery verbatim
 */

/** Server grammar for `kind` and `period`, copied for fail-fast UX only. */
// @ref LLP 0155#fail-fast [implements]: client-side copies reject a typo before bytes move; the server stays authoritative
const KIND_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const PERIOD_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/

/** The value-taking flags shared across the `report` subcommands. */
const VALUE_FLAGS = new Set(['--kind', '--period', '--title', '--org', '--remote', '--limit', '--before', '--output'])

/**
 * `hyp report render [<dir>]`: build the static HTML site for a local reports tree.
 *
 * @ref LLP 0196#mechanics-as-code [implements]: the deterministic half of rendering is a
 * command, so the skill calls it instead of narrating a shell script it cannot version
 *
 * The one subcommand in this group that is NOT a call to the server's reports plane.
 * It takes no `--remote`, reads and writes only local files, and needs no credential.
 * It lives here anyway because a user's workflow is render-then-publish and splitting
 * those across two command namespaces would serve the implementation, not the reader.
 * LLP 0155's "there is no local reports plane" is still true of publish/list/get/delete;
 * this is a local build step, not a plane operation, and the group help says so.
 *
 * Not destructive in the way `delete` is, so it does not prompt: it rebuilds `html/`
 * (derived output, wiped and regenerated every run) and refreshes the command-owned
 * assets. It never touches the report `.md` sources, and never `assets/theme.css`,
 * which is the user's (LLP 0196 #theme-layer).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runReportRender(argv, ctx) {
  const parsed = parseCoreCommandArgv('report render', argv, ctx)
  if (!parsed.ok) return parsed.code
  const { renderReports, discoverReports } = await import('../reports/render.js')

  const dir = path.resolve(
    /** @type {string | undefined} */ (parsed.params.dir) ?? path.join(os.homedir(), 'hypaware-reports')
  )

  /** @type {Stats} */
  let stat
  try {
    stat = await fs.stat(dir)
  } catch {
    ctx.stderr.write(`hyp report render: no such directory: ${dir}\n`)
    return 2
  }
  if (!stat.isDirectory()) {
    ctx.stderr.write(`hyp report render: not a directory: ${dir}\n`)
    return 2
  }

  // Refuse before wiping html/. An empty tree usually means the reports were just
  // archived, and rebuilding would replace a good site with an empty one.
  const found = discoverReports(dir)
  if (found.length === 0) {
    ctx.stderr.write(
      `hyp report render: no reports in ${dir} (expected a top-level <slug>.md).\n` +
        'Nothing was changed. If the reports were archived, generate new ones first.\n',
    )
    return 1
  }

  try {
    const result = renderReports({ dir, refreshAssets: parsed.params['no-refresh-assets'] !== true })
    ctx.stdout.write(`Built html/ : ${result.reports} report(s) into html/<slug>/ (index + sections + assets)\n`)
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp report render: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

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
  const gate = parseCoreCommandArgv('report publish', argv, ctx)
  if (!gate.ok) return gate.code
  // As in `report list` and `report delete`: read what the gate parsed, not
  // argv. `valueFlag()` drops a value whose first character is `-`, so reading
  // `--title` from argv published `--title '-Q3 rollup'` with no title at all,
  // exit 0 - a token the gate had just blessed, silently discarded.
  const source = /** @type {string | undefined} */ (gate.params.source)
  const kind = /** @type {string | undefined} */ (gate.params.kind)
  const period = /** @type {string | undefined} */ (gate.params.period)
  // @ref LLP 0155#period-explicit [constrained-by]: period is the coverage window only the generator knows; never default it from the current date
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
  /** @type {Stats} */
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

  const resolved = resolveReportsTarget(gate.params, ctx, 'report publish')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  const title = /** @type {string | undefined} */ (gate.params.title)
  const url = new URL(resolved.endpoint)
  url.searchParams.set('kind', kind)
  url.searchParams.set('period', period)
  if (title) url.searchParams.set('title', title)
  applyOrgParam(gate.params, url)

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
  const gate = parseCoreCommandArgv('report list', argv, ctx)
  if (!gate.ok) return gate.code
  const resolved = resolveReportsTarget(gate.params, ctx, 'report list')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  const url = new URL(resolved.endpoint)
  // Same reason `--json` below reads the gate: `valueFlag()` drops a value
  // whose first character is `-`, so `--limit -5` used to list with the
  // server's default and exit 0 instead of refusing the token.
  for (const flag of ['kind', 'period', 'limit', 'before']) {
    const value = gate.params[flag]
    if (value !== undefined) url.searchParams.set(flag, String(value))
  }
  applyOrgParam(gate.params, url)

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
  // Read the mode the gate parsed, not argv: the codec also accepts
  // `--json=true`, and a token it blessed must not be dropped downstream.
  if (gate.params.json === true) {
    ctx.stdout.write(JSON.stringify(reports, null, 2) + '\n')
    return 0
  }
  if (reports.length === 0) {
    ctx.stdout.write("no reports published - publish one with 'hyp report publish <file-or-dir> --kind <kind> --period <period>'\n")
    return 0
  }
  for (const r of reports) {
    const title = typeof r.title === 'string' && r.title ? `\t${esc(r.title)}` : ''
    ctx.stdout.write(`  ${esc(r.publishedAt)}\t${esc(r.kind)}/${esc(r.period)}\t${esc(r.id)}\t${esc(r.bytes)} bytes${title}\n`)
    // The server mints one id per `recommendation-<slug>` page and lists them
    // on the record, in page order, so a report's recommendations read
    // beneath it without fetching the report; the id is the token a caller
    // copies, the page is what `hyp report get` takes. A server that reads
    // the page's opening at publish adds its title and thesis (server LLP
    // 0416); an older server, or a report that predates that, lists the id
    // and page alone. A record with no recommendation pages carries no
    // field, so a report with none prints nothing extra.
    const recommendations = Array.isArray(r.recommendations) ? r.recommendations : []
    for (const c of recommendations) {
      if (typeof c?.id !== 'string' || typeof c?.page !== 'string') continue
      const title = typeof c.title === 'string' && c.title ? `\t${esc(c.title)}` : ''
      ctx.stdout.write(`      ${esc(c.id)}\t${esc(c.page)}${title}\n`)
      if (typeof c.summary === 'string' && c.summary) ctx.stdout.write(`          ${esc(c.summary)}\n`)
    }
  }
  return 0
}

/**
 * `hyp report get <kind> <period> <id> [path]`: fetch a report's entry
 * document (or one named artifact) and write it to stdout or `--output`.
 *
 * `hyp report get <rec-id>`: the one form that takes a recommendation id.
 * It resolves the id to its report and page as `fix` does, and writes the
 * page with the record's citations under it. This is the read a client
 * already in a session makes when asked to fix a recommendation by id, and
 * the read `fix` tells the client it starts to make: one command, one
 * output, whichever way the session began.
 *
 * @ref LLP 0414#page-is-the-brief [implements]: the recommendation is read by id from the server, never from a file the CLI wrote
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runReportGet(argv, ctx) {
  const gate = parseCoreCommandArgv('report get', argv, ctx)
  if (!gate.ok) return gate.code
  const [kind, period, id, ...fileSegments] = positionals(argv, VALUE_FLAGS)
  // A kind may legally be spelled like a recommendation id (KIND_RE admits
  // it), so the full <kind> <period> <id> form stays a report read; only a
  // lone id, or an id with one stray positional, is taken as a recommendation.
  if (kind && RECOMMENDATION_ID_RE.test(kind) && id === undefined) {
    if (period !== undefined) {
      ctx.stderr.write(`hyp report get: '${kind}' is a recommendation id and takes no other positional\n`)
      return 2
    }
    const resolved = resolveReportsTarget(gate.params, ctx, 'report get')
    if ('error' in resolved) {
      ctx.stderr.write(`${resolved.error}\n`)
      return 2
    }
    const found = await resolveRecommendation({ ctx, gate, resolved, cmd: 'report get' }, kind)
    if (typeof found === 'number') return found
    const page = await fetchRecommendationPage({ ctx, gate, resolved, cmd: 'report get' }, found)
    if (typeof page === 'number') return page
    const output = /** @type {string | undefined} */ (gate.params.output)
    if (output) {
      try {
        await fs.writeFile(output, page.bytes)
      } catch (err) {
        ctx.stderr.write(`hyp report get: ${err instanceof Error ? err.message : String(err)}\n`)
        return 1
      }
      ctx.stderr.write(`saved ${page.bytes.length} bytes to ${output}\n`)
      return 0
    }
    /** @type {{ write(chunk: string | Buffer): unknown }} */ (ctx.stdout).write(page.bytes)
    return 0
  }
  if (!kind || !period || !id) {
    ctx.stderr.write('usage: hyp report get <kind> <period> <id> [path] [--output <file>] [--org <org>] [--remote <target>]\n')
    return 2
  }
  // The last raw-argv read in this file, for the same reason as the rest:
  // `valueFlag()` takes the FIRST occurrence while the codec keeps the LAST,
  // so `--output a --output b` validated b and wrote the bytes to a, exit 0.
  // The gate refuses `--output` with no value before this line runs.
  const output = /** @type {string | undefined} */ (gate.params.output)
  const resolved = resolveReportsTarget(gate.params, ctx, 'report get')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  // The artifact path is one positional with '/' separators; encode each
  // segment, never the separators.
  const suffix = fileSegments.flatMap((s) => s.split('/')).map(encodeURIComponent).join('/')
  const url = new URL(`${resolved.endpoint}/${encodeURIComponent(kind)}/${encodeURIComponent(period)}/${encodeURIComponent(id)}/${suffix}`)
  applyOrgParam(gate.params, url)

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
  if (output) {
    try {
      await fs.writeFile(output, bytes)
    } catch (err) {
      ctx.stderr.write(`hyp report get: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    ctx.stderr.write(`saved ${bytes.length} bytes to ${output}\n`)
    return 0
  }
  // Artifacts can be binary (images, fonts); the kernel WriteStream type is
  // string-only but the real stream accepts Buffers, so bypass the type here
  // rather than corrupt bytes through a string round-trip.
  /** @type {{ write(chunk: string | Buffer): unknown }} */ (ctx.stdout).write(bytes)
  return 0
}

/** The shape of a server-minted recommendation id: `rec-` and 16 hex characters. */
const RECOMMENDATION_ID_RE = /^rec-[0-9a-f]{16}$/

/**
 * `hyp report fix [id]`: start an attached client on one of a report's
 * recommendations, in the directory the command was typed in.
 *
 * The id is the server's (`rec-` and sixteen hex characters, minted at
 * publish and listed by `hyp report list`), so a bare id is enough to
 * resolve the report and the page: the resolve route answers with both.
 * With no id on a terminal, the recent listing becomes a picker, one row
 * per recommendation across the reports it names; piped, the id is
 * required. The client is told to read the page through
 * `hyp report get <id>` and implement it here: the fix applies to a
 * repository, so unlike the recommendation ask this session starts where
 * it was typed, not in a folder HypAware owns, and nothing is written to
 * disk for it.
 *
 * `deps` are the process-touching seams (status probe, PATH probe, spawn,
 * prompt), injected by tests; the defaults are the real ones `hyp ask` uses.
 *
 * @ref LLP 0414#page-is-the-brief [implements]: the client is pointed at the read, not at a copy
 * @ref LLP 0414#run-where-typed [implements]: the fix is to a repository, so the client starts in the caller's directory
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{
 *   collectStatus?: Parameters<typeof askableClients>[1] extends { collectStatus?: infer T } | undefined ? T : never,
 *   resolveLaunchers?: typeof resolveLaunchers,
 *   launchClient?: typeof launchClient,
 *   select?: typeof select,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runReportFix(argv, ctx, deps = {}) {
  const gate = parseCoreCommandArgv('report fix', argv, ctx)
  if (!gate.ok) return gate.code
  const resolved = resolveReportsTarget(gate.params, ctx, 'report fix')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  // `HYP_NO_TUI` is the same veto the prompt runtime honours; reading it
  // here keeps a deliberate no-TUI run reported as one that cannot prompt.
  const interactive = isTty(ctx.stdout) && isTty(ctx.stdin) && ctx.env.HYP_NO_TUI !== '1'
  const ask = deps.select ?? select
  const io = {
    ...(ctx.stdin ? { stdin: ctx.stdin } : {}),
    stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (ctx.stdout)),
    env: ctx.env,
  }

  /** @param {(token: string) => Promise<Response>} send */
  const request = (send) => reportsRequest({ ctx, ...resolved, write: false, cmd: 'report fix' }, send)

  // 1. Which recommendation: the id given, else one picked from the listing.
  /** @type {FixRecommendation} */
  let recommendation
  /** @type {{ id: string, kind: string, period: string, title?: string }} */
  let report
  const id = gate.params.id !== undefined ? String(gate.params.id).trim() : ''
  if (id) {
    // Grammar first, as the server does: an id that could never have been
    // minted is refused without a round trip.
    if (!RECOMMENDATION_ID_RE.test(id)) {
      ctx.stderr.write(`hyp report fix: '${id}' is not a recommendation id - take one from 'hyp report list' (they look like rec-0123456789abcdef)\n`)
      return 2
    }
    const found = await resolveRecommendation({ ctx, gate, resolved, cmd: 'report fix' }, id)
    if (typeof found === 'number') return found
    recommendation = found.recommendation
    report = found.report
  } else {
    if (!interactive) {
      ctx.stderr.write("usage: hyp report fix <id> [--org <org>] [--remote <target>]\n  the id comes from 'hyp report list'; run on a terminal to pick one from a list instead\n")
      return 2
    }
    const url = new URL(resolved.endpoint)
    for (const flag of ['kind', 'period', 'limit']) {
      const value = gate.params[flag]
      if (value !== undefined) url.searchParams.set(flag, String(value))
    }
    applyOrgParam(gate.params, url)
    const outcome = await request((token) => fetch(url, { headers: { authorization: `Bearer ${token}` } }))
    if (!outcome.ok) {
      ctx.stderr.write(`hyp report fix: ${outcome.error}\n`)
      return outcome.exitCode
    }
    if (outcome.response.status !== 200) {
      ctx.stderr.write(`hyp report fix: ${await describeErrorResponse(outcome.response)}\n`)
      return 1
    }
    const parsed = /** @type {any} */ (await outcome.response.json().catch(() => null))
    const reports = Array.isArray(parsed?.reports) ? parsed.reports : []
    // Two lists: the reports, newest first as the listing returns them,
    // then the picked report's recommendations. A report's recommendations
    // are ranked against each other, not against another report's, so a
    // flat list across reports would rank nothing; and the report is what
    // a person remembers ("last week's"), so it is the first question.
    // Escape on the second list goes back to the first.
    /** @type {Array<{ report: any, rows: Array<{ value: string, label: string, summary: string }>, byId: Map<string, { recommendation: FixRecommendation, report: any }> }>} */
    const groups = []
    for (const r of reports) {
      const list = Array.isArray(r?.recommendations) ? r.recommendations : []
      /** @type {Array<{ value: string, label: string, summary: string }>} */
      const rows = []
      /** @type {Map<string, { recommendation: FixRecommendation, report: any }>} */
      const byId = new Map()
      for (const c of list) {
        // Held to the same grammar as an id typed on the command line, and
        // for a sharper reason: a picked id is pasted into the command the
        // client is told to run, so a listed id that is not one would put
        // text of the server's choosing on a command line.
        if (typeof c?.id !== 'string' || !RECOMMENDATION_ID_RE.test(c.id) || typeof c?.page !== 'string') continue
        byId.set(c.id, { recommendation: fixRecommendation(c.id, c), report: r })
        // Labelled by the page's own title when the server read one, else
        // by the slug read as words; described by the thesis's first
        // sentence, which names the problem, else by the id.
        const label = typeof c.title === 'string' && c.title ? c.title : recommendationLabel(c.page)
        const summary = typeof c.summary === 'string' && c.summary ? firstSentence(c.summary) : c.id
        rows.push({ value: c.id, label: esc(label), summary: esc(summary) })
      }
      // A report with nothing to fix is not offered: picking it would open
      // an empty list.
      if (rows.length > 0) groups.push({ report: r, rows, byId })
    }
    if (groups.length === 0) {
      ctx.stdout.write("no recommendations to fix - the listed reports carry none, or none are published yet ('hyp report list')\n")
      return 0
    }
    const reportOptions = groups.map((g, i) => {
      const r = g.report
      const title = typeof r.title === 'string' && r.title ? r.title : `${r.kind}/${r.period}`
      const when = typeof r.publishedAt === 'string' ? r.publishedAt.slice(0, 10) : ''
      const count = `${g.rows.length} recommendation${g.rows.length === 1 ? '' : 's'}`
      return { value: String(i), label: esc(title), summary: esc([when, `${r.kind}/${r.period}`, count].filter(Boolean).join('  ')) }
    })
    /** @type {{ recommendation: FixRecommendation, report: any } | undefined} */
    let hit
    /** @type {string} */
    let reportCursor = reportOptions[0].value
    while (!hit) {
      /** @type {string | number} */
      let pickedReport
      try {
        pickedReport = await ask({ box: true, title: 'Which report?', options: reportOptions, default: reportCursor, ...io })
      } catch (err) {
        if (err instanceof PromptCancelledError || isPromptBackError(err) || (err instanceof Error && err.name === 'PromptCancelledError')) {
          ctx.stdout.write('Nothing started.\n')
          return 0
        }
        throw err
      }
      reportCursor = String(pickedReport)
      const group = groups[Number(pickedReport)]
      if (!group) return 0
      /** @type {string | number} */
      let picked
      try {
        picked = await ask({ box: true, title: 'Which recommendation should be fixed?', options: group.rows, allowBack: true, ...io })
      } catch (err) {
        if (isPromptBackError(err)) continue
        if (err instanceof PromptCancelledError || (err instanceof Error && err.name === 'PromptCancelledError')) {
          ctx.stdout.write('Nothing started.\n')
          return 0
        }
        throw err
      }
      hit = group.byId.get(String(picked))
      if (!hit) return 0
    }
    recommendation = hit.recommendation
    report = hit.report
  }

  // 2. Which client: attached and on PATH, asked only when that is ambiguous.
  const clients = await askableClients(ctx, deps.collectStatus ? { collectStatus: deps.collectStatus } : {})
  const descriptors = await buildWalkthroughClientDescriptorMap()
  const launchers = await (deps.resolveLaunchers ?? resolveLaunchers)({ clients, descriptors, env: ctx.env })
  if (launchers.length === 0) {
    ctx.stderr.write('hyp report fix: no attached client can be started here.\n')
    ctx.stderr.write(`  ${attachHint(descriptors)}\n`)
    return 1
  }
  /** @type {FirstAskLauncher | undefined} */
  let launcher = launchers[0]
  if (launchers.length > 1 && interactive) {
    try {
      const client = await ask({
        box: true,
        title: 'Which client should make the change?',
        options: launchers.map((l) => ({ value: l.client, label: l.label })),
        ...io,
      })
      launcher = launchers.find((l) => l.client === client)
    } catch (err) {
      if (err instanceof PromptCancelledError || isPromptBackError(err) || (err instanceof Error && err.name === 'PromptCancelledError')) {
        launcher = undefined
      } else {
        throw err
      }
    }
    if (!launcher) {
      ctx.stdout.write('Nothing started.\n')
      return 0
    }
  }

  // 3. The page, fetched here only to prove the id still names one and to
  // put its title on the launch line. The client reads it itself, through
  // `hyp report get <id>`: the same read a session asked to fix an id
  // makes on its own, so there is one way to see a recommendation and no
  // file under HYP_HOME to keep in step with the server.
  const page = await fetchRecommendationPage({ ctx, gate, resolved, cmd: 'report fix' }, { recommendation, report })
  if (typeof page === 'number') return page

  // 4. The launch, in the directory the command was typed in.
  const title = pageTitle(page.bytes.toString('utf8')) ?? recommendation.title ?? recommendationLabel(recommendation.page)
  const where = `${report.kind}/${report.period}${typeof report.title === 'string' && report.title ? `, "${report.title}"` : ''}`
  // The target flags ride along so the client resolves the same org and
  // remote this run did; the credential reaches it through the inherited
  // environment, as every `hyp` call the client makes already relies on.
  const targetFlags = ['org', 'remote'].flatMap((f) => gate.params[f] !== undefined ? [`--${f} ${shellWord(String(gate.params[f]))}`] : [])
  const readCommand = ['hyp report get', recommendation.id, ...targetFlags].join(' ')
  const prompt =
    `Run \`${readCommand}\` and read its output. It is one recommendation from a HypAware usage report (${where}): "${title}", ` +
    'followed by the evidence it cites and the queries the report ran to reach it. ' +
    'Implement it in this repository: make the change it describes, verify it the way this repository verifies changes, ' +
    'and summarise what you changed. If it does not apply to this repository, say why instead of forcing it.' +
    (recommendation.basis.length > 0
      ? ' Re-run the queries with `hyp query sql` if you need to check the finding against the recordings on this machine.'
      : '')
  ctx.stdout.write(`\nStarting ${launcher.label} on "${esc(title)}"...\n\n`)
  const result = await (deps.launchClient ?? launchClient)({ launcher, prompt, cwd: ctx.cwd, env: ctx.env })
  if (!result.ok) {
    ctx.stderr.write(`hyp report fix: could not start ${launcher.bin}: ${result.error ?? 'spawn failed'}\n`)
    return 1
  }
  return 0
}

/**
 * A recommendation page stem as a picker label: `recommendation-batch-the-retries`
 * reads as `batch the retries`. The pre-rename `change-` prefix is the same
 * page under its old name.
 *
 * @param {string} page
 * @returns {string}
 */
function recommendationLabel(page) {
  return page.replace(/^(recommendation|change)-/, '').replaceAll('-', ' ')
}

/**
 * The resolve round trip a recommendation id makes, shared by `get` and
 * `fix`: grammar first, as the server checks it, so a report id or a page
 * name given by mistake is refused with the shape an id has rather than
 * answered as unknown; then the server's resolve route, which answers with
 * the report and the recommendation entry, citations included. Errors are
 * written under `cmd` and returned as the exit code.
 *
 * @ref LLP 0414#id-is-the-handle [implements]: the server-minted id is the only argument; everything else is resolved from it
 * @param {{ ctx: CommandRunContext, gate: { params: Record<string, unknown> }, resolved: { target: string, endpoint: string, identityBase: string | undefined }, cmd: string }} run
 * @param {string} id
 * @returns {Promise<{ recommendation: FixRecommendation, report: any } | number>}
 */
async function resolveRecommendation({ ctx, gate, resolved, cmd }, id) {
  if (!RECOMMENDATION_ID_RE.test(id)) {
    ctx.stderr.write(`hyp ${cmd}: '${id}' is not a recommendation id - take one from 'hyp report list' (they look like rec-0123456789abcdef)\n`)
    return 2
  }
  const url = new URL(`${resolved.endpoint}/_recommendations/${encodeURIComponent(id)}`)
  applyOrgParam(gate.params, url)
  const outcome = await reportsRequest({ ctx, ...resolved, write: false, cmd }, (token) => fetch(url, { headers: { authorization: `Bearer ${token}` } }))
  if (!outcome.ok) {
    ctx.stderr.write(`hyp ${cmd}: ${outcome.error}\n`)
    return outcome.exitCode
  }
  if (outcome.response.status === 404) {
    ctx.stderr.write(`hyp ${cmd}: no recommendation '${id}' in this org - list them with 'hyp report list'\n`)
    return 1
  }
  if (outcome.response.status !== 200) {
    ctx.stderr.write(`hyp ${cmd}: ${await describeErrorResponse(outcome.response)}\n`)
    return 1
  }
  const parsed = /** @type {any} */ (await outcome.response.json().catch(() => null))
  if (typeof parsed?.recommendation?.page !== 'string' || typeof parsed?.report?.id !== 'string') {
    ctx.stderr.write(`hyp ${cmd}: '${resolved.target}' answered without the recommendation's report - is the server up to date?\n`)
    return 1
  }
  return { recommendation: fixRecommendation(id, parsed.recommendation), report: parsed.report }
}

/**
 * The recommendation page as a reader gets it: Markdown first (the form
 * the report generator writes and a model reads best), HTML when a report
 * was published without it, with the record's citations rendered under it
 * (server LLP 0419: the Markdown keeps its `evidence:N` marks and the CLI
 * pairs them with the list itself), so a reader can open the cited turns
 * and re-run the queries the claim was measured over instead of taking it
 * on faith. Errors are written under `cmd` and returned as the exit code.
 *
 * @param {{ ctx: CommandRunContext, gate: { params: Record<string, unknown> }, resolved: { target: string, endpoint: string, identityBase: string | undefined }, cmd: string }} run
 * @param {{ recommendation: FixRecommendation, report: { id: string, kind: string, period: string } }} found
 * @returns {Promise<{ bytes: Buffer, ext: string } | number>}
 */
async function fetchRecommendationPage({ ctx, gate, resolved, cmd }, { recommendation, report }) {
  const base = `${resolved.endpoint}/${encodeURIComponent(report.kind)}/${encodeURIComponent(report.period)}/${encodeURIComponent(report.id)}/${encodeURIComponent(recommendation.page)}`
  for (const ext of ['md', 'html']) {
    const url = new URL(`${base}.${ext}`)
    applyOrgParam(gate.params, url)
    const outcome = await reportsRequest({ ctx, ...resolved, write: false, cmd }, (token) => fetch(url, { headers: { authorization: `Bearer ${token}` } }))
    if (!outcome.ok) {
      ctx.stderr.write(`hyp ${cmd}: ${outcome.error}\n`)
      return outcome.exitCode
    }
    if (outcome.response.status === 404) continue
    if (outcome.response.status !== 200) {
      ctx.stderr.write(`hyp ${cmd}: ${await describeErrorResponse(outcome.response)}\n`)
      return 1
    }
    const bytes = Buffer.from(await outcome.response.arrayBuffer())
    const appendix = citationsAppendix(recommendation, ext)
    return { bytes: appendix ? Buffer.concat([bytes, Buffer.from(appendix, 'utf8')]) : bytes, ext }
  }
  ctx.stderr.write(`hyp ${cmd}: the report no longer carries '${esc(recommendation.page)}' - list what it has with 'hyp report get ${esc(report.kind)} ${esc(report.period)} ${esc(report.id)}'\n`)
  return 1
}

/**
 * One argument as it can be pasted into a shell: bare when it is plain,
 * single-quoted otherwise. For the flags the launch prompt carries.
 *
 * @param {string} s
 * @returns {string}
 */
function shellWord(s) {
  return /^[A-Za-z0-9_.:@%+=\/-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`
}

/**
 * A recommendation as `fix` carries it from the record to the brief: the
 * page and title the picker and prompt use, plus the citations the server
 * attached at publish (LLP 0419 on the server): `evidence`, the turns the
 * page cites by `evidence:N`, and `basis`, the queries the job ran. Each
 * entry is admitted only in the shape the server types it, so a record from
 * an older server, or an uploaded report, yields two empty lists and a page
 * with no appendix. Both lists are server-capped, so this bounds nothing new.
 *
 * @param {string} id
 * @param {any} c the record's recommendation entry
 * @returns {FixRecommendation}
 */
function fixRecommendation(id, c) {
  /** @type {FixEvidence[]} */
  const evidence = []
  if (Array.isArray(c?.evidence)) {
    for (const e of c.evidence) {
      if (typeof e?.sessionId !== 'string' || typeof e?.messageId !== 'string' || typeof e?.day !== 'string' || typeof e?.note !== 'string') continue
      evidence.push({
        sessionId: e.sessionId,
        chainId: typeof e.chainId === 'string' ? e.chainId : null,
        messageId: e.messageId,
        toolCallId: typeof e.toolCallId === 'string' ? e.toolCallId : null,
        day: e.day,
        note: e.note,
      })
    }
  }
  /** @type {FixBasisQuery[]} */
  const basis = []
  if (Array.isArray(c?.basis)) {
    for (const q of c.basis) {
      if (typeof q?.query !== 'string' || !q.query.trim()) continue
      basis.push({ agent: typeof q.agent === 'string' ? q.agent : '', query: q.query })
    }
  }
  return { id, page: c.page, ...(typeof c.title === 'string' ? { title: c.title } : {}), evidence, basis }
}

/**
 * The citations as a tail for the saved page: an Evidence list the page's
 * `evidence:N` marks number into, and the Basis queries verbatim in fenced
 * blocks. Written as Markdown; on an HTML page (a report published without
 * the Markdown form) the same text sits in one `<pre>` so the file stays
 * HTML and the model still reads it. Empty when there is nothing to append.
 *
 * @param {FixRecommendation} recommendation
 * @param {string} ext `md` or `html`
 * @returns {string}
 */
function citationsAppendix(recommendation, ext) {
  const { evidence, basis } = recommendation
  if (evidence.length === 0 && basis.length === 0) return ''
  const lines = ['', '---', '', '## Citations from the report record', '']
  if (evidence.length > 0) {
    lines.push('### Evidence', '', 'The turns this page cites as `evidence:N`, by N. Each is a recorded message; look it up on this machine with `hyp query sql` against `ai_gateway_messages` by `session_id` and `message_id`.', '')
    evidence.forEach((e, i) => {
      const where = [`session ${e.sessionId}`, e.chainId ? `chain ${e.chainId}` : '', `message ${e.messageId}`, e.toolCallId ? `tool call ${e.toolCallId}` : '', e.day].filter(Boolean).join(', ')
      lines.push(`${i + 1}. ${e.note} (${where})`)
    })
    lines.push('')
  }
  if (basis.length > 0) {
    lines.push('### Basis', '', 'The queries the report ran to reach this recommendation, verbatim. They ran on the server over the whole org; `hyp query sql` on this machine sees only its own recordings, so counts will differ but the shape of the check is the same.', '')
    for (const q of basis) {
      if (q.agent) lines.push(`Run by ${q.agent}:`, '')
      // A fence longer than any backtick run in the query, so a query that
      // carries a ``` line of its own cannot close the block early.
      const query = q.query.trim()
      const fence = '`'.repeat(Math.max(3, ...(query.match(/`+/g) ?? []).map((run) => run.length + 1)))
      lines.push(`${fence}sql`, query, fence, '')
    }
  }
  const text = lines.join('\n')
  if (ext !== 'html') return text
  return `\n<pre>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>\n`
}

/**
 * The first sentence of a thesis, for a picker row that has one line. The
 * house style's thesis is two sentences, problem then fix, and the problem
 * is the half that tells the rows apart.
 *
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
  const m = /^(.+?[.!?])(?:\s|$)/.exec(text)
  return m ? m[1] : text
}

/**
 * The page's own title: its first Markdown `#` heading, or the first `<h1>`
 * of an HTML page. Undefined when neither is present, so the caller falls
 * back to the stem.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
function pageTitle(text) {
  const md = text.match(/^#\s+(.+?)\s*$/m)
  if (md) return md[1].replaceAll('`', '')
  const html = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (html) return html[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || undefined
  return undefined
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
 * @ref LLP 0155#delete-confirm [implements]: org-wide destructive verb confirms like purge, not like remote remove
 */
export async function runReportDelete(argv, ctx) {
  const gate = parseCoreCommandArgv('report delete', argv, ctx)
  if (!gate.ok) return gate.code
  const [kind, period, id] = positionals(argv, VALUE_FLAGS)
  if (!kind || !period || !id) {
    ctx.stderr.write('usage: hyp report delete <kind> <period> <id> [--yes] [--org <org>] [--remote <target>]\n')
    return 2
  }
  const resolved = resolveReportsTarget(gate.params, ctx, 'report delete')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  // As in `report list`: the gate accepts `--yes=true`, so reading argv
  // directly would refuse a confirmation the validator just accepted.
  if (gate.params.yes !== true) {
    const stdin = /** @type {any} */ (ctx.stdin ?? process.stdin)
    if (!stdin || !stdin.isTTY) {
      ctx.stderr.write('error: refusing to delete without confirmation - pass --yes to delete non-interactively\n')
      return 2
    }
    const ok = await askYesNo(
      ctx,
      `Delete report ${kind}/${period}/${id} for the whole org? This cannot be undone. [y/N] `
    )
    if (!ok) {
      ctx.stdout.write('delete cancelled\n')
      return 0
    }
  }
  const url = new URL(`${resolved.endpoint}/${encodeURIComponent(kind)}/${encodeURIComponent(period)}/${encodeURIComponent(id)}`)
  applyOrgParam(gate.params, url)

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
 * Reads the gate's parsed params, never argv, for the reason `applyOrgParam()`
 * does: `valueFlag()` takes the FIRST occurrence while the codec keeps the
 * LAST, so `--remote a --remote b` validated 'b' and then sent the request,
 * with b's credential resolved, to a. The target picks the *server*, so on
 * `report delete` that is a destructive call against a scope the gate never
 * blessed. The old `present && !value` guard is not lost: the gate refuses
 * `--remote` with no value ahead of this function, and a dash-leading target
 * now reaches the registry lookup and gets named in the refusal.
 *
 * @param {Record<string, unknown>} params the gate's parsed params
 * @param {CommandRunContext} ctx
 * @param {string} cmd for error prefixes, e.g. `report list`
 * @returns {{ target: string, endpoint: string, identityBase: string | undefined } | { error: string }}
 * @ref LLP 0155#target [implements]: target defaults like bare --remote; the endpoint derives from the one registered URL
 * @ref LLP 0293#one-contract [implements]: a token the gate validated is the token the command acts on
 */
function resolveReportsTarget(params, ctx, cmd) {
  const remote = params.remote
  const target = remote !== undefined ? String(remote) : effectiveDefaultRemote(ctx.config)
  // Own-key read: an inherited Object.prototype member is truthy, so a target
  // named `constructor` walked past the refusal below and reached
  // `deriveReportsEndpoint(undefined).replace`.
  const remotes = effectiveRemotes(ctx.config)
  const entry = Object.hasOwn(remotes, target) ? remotes[target] : undefined
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
 * Reads the gate's parsed params, never argv: `valueFlag()` drops a value whose
 * first character is `-` and takes the FIRST occurrence, while the codec
 * validates the LAST. So `--org -acme` was blessed and then sent as no org at
 * all (exit 0, nothing on stderr), and `--org a --org b` validated 'b' and sent
 * 'a'. Same class as the `--title` and `--limit` drops above.
 *
 * @param {Record<string, unknown>} params the gate's parsed params
 * @param {URL} url
 */
function applyOrgParam(params, url) {
  // `--org=''` is the admin single-org form, so presence matters, not truthiness.
  const org = params.org
  if (org !== undefined) url.searchParams.set('org', String(org))
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
 * @ref LLP 0155#write-401 [implements]: a write 401 that survives the retry is ambiguous - say both expiry and missing scope
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
 * @ref LLP 0155#bundle [implements]: the publish CLI owns bundle creation and pins tar --format=ustar
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
