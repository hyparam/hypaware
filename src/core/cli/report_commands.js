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
import { Attr, markSpanStatus, withSpan } from '../observability/index.js'
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
import { isPromptBackError, isPromptCancelledError } from './tui/runtime.js'
import { buildWalkthroughClientDescriptorMap } from './walkthrough.js'
import { launchClient, resolveLaunchers } from './wizard/first_ask.js'
import { PICK_DEADLINE_NOTICE, armPickDeadline, askableClients, attachHint } from '../commands/ask.js'
import { escapeForDisplay } from '../util/json_util.js'

/**
 * @import { Dir, Stats } from 'node:fs'
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { FirstAskLauncher } from '../../../src/core/cli/wizard/types.js'
 * @import { FixBasisQuery, FixEvidence, FixRecommendation, LocalReportRow, RecommendationStatus } from '../../../src/core/cli/types.js'
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
 * The client picker, asked under the deadline `hyp ask` puts on the same
 * screen: the gate that opens it reads two `isTTY` flags, and a TTY says a
 * terminal is attached, never that a person is reading it, so under
 * `docker run -t`, a tty-allocating CI runner, tmux or expect the keypress
 * never comes and the run ends only when something kills it. An expired
 * deadline is answered apart from a cancel because it is not one: nobody
 * declined, so the caller falls through to the client it would have started
 * with no prompt at all rather than to a choice nobody made.
 *
 * @param {typeof select} ask
 * @param {CommandRunContext} ctx
 * @param {Parameters<typeof select>[0]} spec
 * @param {number} [deadlineMs]
 * @returns {Promise<{ client: string | number } | { cancelled: true } | { timedOut: true }>}
 */
async function pickClient(ask, ctx, spec, deadlineMs) {
  const controller = new AbortController()
  const disarm = armPickDeadline(ctx.stdin, controller, deadlineMs)
  try {
    return { client: await ask({ ...spec, signal: controller.signal }) }
  } catch (err) {
    // The abort settles the prompt as an escape does, so which one happened
    // is the controller's to answer, not the error's.
    if (controller.signal.aborted) return { timedOut: true }
    if (isPromptCancelledError(err) || isPromptBackError(err)) return { cancelled: true }
    throw err
  } finally {
    disarm()
  }
}

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
const VALUE_FLAGS = new Set(['--kind', '--period', '--title', '--org', '--remote', '--limit', '--before', '--output', '--status', '--reason', '--link'])

/**
 * @ref LLP 0450#launch [implements]: the skill owns analysis; the CLI starts a client in the caller's directory
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {Parameters<typeof runReportFix>[2]} [deps]
 * @returns {Promise<number>}
 */
export async function runReportGenerate(argv, ctx, deps = {}) {
  const gate = parseCoreCommandArgv('report generate', argv, ctx)
  if (!gate.ok) return gate.code
  return withSpan('report.generate', {
    [Attr.COMPONENT]: 'reports',
    [Attr.OPERATION]: 'report.generate',
    status: 'error',
  }, async (span) => {
    const home = ctx.env.HOME || os.homedir()
    const cwd = ctx.cwd
    const clients = await askableClients(ctx, deps.collectStatus ? { collectStatus: deps.collectStatus } : {})
    const descriptors = await buildWalkthroughClientDescriptorMap()
    const candidates = await (deps.resolveLaunchers ?? resolveLaunchers)({ clients, descriptors, env: ctx.env })
    const launchers = []
    for (const launcher of candidates) {
      const descriptor = descriptors.get(launcher.client)
      if (!descriptor) continue
      const skill = path.join(home, descriptor.skillDir, 'hypaware-report', 'SKILL.md')
      try {
        await fs.access(skill)
        launchers.push({ launcher, skill })
      } catch {
        // Only offer clients that can read the report workflow.
      }
    }
    span.setAttribute('launcher_count', launchers.length)
    if (launchers.length === 0) {
      span.setAttribute('error_kind', 'no-launcher')
      ctx.stderr.write('hyp report generate: no recorded client with the hypaware-report skill can be started.\n')
      ctx.stderr.write(`  ${attachHint(descriptors)}\n`)
      return 1
    }
    let chosen = launchers[0]
    if (launchers.length > 1 && isTty(ctx.stdout) && isTty(ctx.stdin) && ctx.env.HYP_NO_TUI !== '1') {
      const outcome = await pickClient(deps.select ?? select, ctx, {
        box: true,
        title: 'Which client should generate the report?',
        options: launchers.map(({ launcher }) => ({ value: launcher.client, label: launcher.label })),
        ...(ctx.stdin ? { stdin: ctx.stdin } : {}),
        stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (ctx.stdout)),
        env: ctx.env,
      }, deps.pickDeadlineMs)
      let picked = 'client' in outcome ? launchers.find(({ launcher }) => launcher.client === outcome.client) : undefined
      if ('timedOut' in outcome) {
        ctx.stdout.write(PICK_DEADLINE_NOTICE)
        picked = launchers[0]
      }
      // An escape, a back request, and an answer that is not on the list all
      // mean the same thing to the user: no client was chosen, so nothing
      // starts. Turning the third into a throw would hand back a stack trace
      // on the one path the other two exit cleanly, so it exits quietly like
      // runReportFix's client picker (which leaves 'launcher' undefined and
      // returns 0). It is still a defect rather than a choice, so unlike a
      // cancel it is recorded on the span: runReportFix's recommendation
      // picker, whose ids come off a server page instead of a fixed local
      // list, goes further and exits 1.
      if (!picked) {
        if (!('cancelled' in outcome)) span.setAttribute('error_kind', 'picker-off-list')
        markSpanStatus(span, 'cancelled')
        ctx.stdout.write('Nothing started.\n')
        return 0
      }
      chosen = picked
    }
    const instructions = String(gate.params.instructions ?? '')
    const prompt = `Use the hypaware-report skill at ${JSON.stringify(chosen.skill)} to generate a report from this machine's local HypAware recordings. ` +
      `Follow its analysis, review, and delivery workflow. Unless the user requests another destination, draft the report in a new hypaware-report-<from>-to-<to> directory under ${JSON.stringify(cwd)}, using a numbered suffix if it already exists, and when it is reviewed move it into HypAware's reports store by running 'hyp report save <that directory>' and return the saved path it prints. ` +
      'Use the skill\'s default reporting period unless the instructions below specify one.' +
      (instructions ? `\n\nAdditional instructions from the user:\n${instructions}` : '')
    span.setAttribute('client', chosen.launcher.client)
    ctx.stdout.write(`\nStarting ${chosen.launcher.label} to generate a local report...\n\n`)
    const result = await (deps.launchClient ?? launchClient)({ launcher: chosen.launcher, prompt, cwd, env: ctx.env })
    if (!result.ok) {
      span.setAttribute('error_kind', 'client-launch')
      ctx.stderr.write(`hyp report generate: could not start ${chosen.launcher.bin}: ${result.error ?? 'spawn failed'}\n`)
      return 1
    }
    markSpanStatus(span, 'ok')
    return 0
  })
}

/**
 * `hyp report save <dir> [--keep]`: move a finished report folder into the
 * store, `$HYP_HOME/reports/<name>`, where `hyp report list` finds it and
 * `hyp report publish <name>` can take it by name.
 *
 * The skill drafts in the caller's directory (LLP 0450), so without this step
 * finished reports accumulate wherever a report was last asked for. The CLI
 * does the move because the alternative, an agent writing under the user's
 * home directory itself, is an access the skill should never need to ask for.
 * The folder is held to the publish allow-list before a byte moves, so the
 * store only ever holds what a publish would accept: no ledgers, raw logs, or
 * stray files. The default moves rather than copies, since the draft left
 * behind is the clutter the store exists to end; only the pages that were
 * copied are removed, one by one, so a file that appears mid-move is left
 * where it is and named.
 *
 * @ref LLP 0465#save [implements]: the CLI moves a validated folder into the store; the agent never writes under HYP_HOME
 * @ref LLP 0465#move [implements]: move by default, remove only what was copied, --keep leaves the draft
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runReportSave(argv, ctx) {
  const gate = parseCoreCommandArgv('report save', argv, ctx)
  if (!gate.ok) return gate.code
  const source = /** @type {string | undefined} */ (gate.params.source)
  if (!source) {
    ctx.stderr.write('usage: hyp report save <dir> [--keep]\n')
    return 2
  }
  const keep = gate.params.keep === true
  return withSpan('report.save', {
    [Attr.COMPONENT]: 'reports',
    [Attr.OPERATION]: 'report.save',
    status: 'error',
    keep,
  }, async (span) => {
    const abs = path.resolve(ctx.cwd ?? process.cwd(), source)
    /** @type {Stats} */
    let stat
    try {
      stat = await fs.stat(abs)
    } catch {
      span.setAttribute('error_kind', 'missing')
      ctx.stderr.write(`hyp report save: no such directory: ${esc(source)}\n`)
      return 2
    }
    if (!stat.isDirectory()) {
      span.setAttribute('error_kind', 'not-directory')
      ctx.stderr.write(`hyp report save: ${esc(source)} is not a directory; save the report folder (the one holding report.md)\n`)
      return 2
    }
    const name = path.basename(abs)
    if (!SAVED_NAME_RE.test(name)) {
      span.setAttribute('error_kind', 'name')
      ctx.stderr.write(`hyp report save: folder name must match ${SAVED_NAME_RE.source} (got '${esc(name)}'); rename it, e.g. hypaware-report-<from>-to-<to>\n`)
      return 2
    }
    const root = reportsStoreRoot(ctx)
    // The store's own members are already saved; refuse early rather than
    // copying a folder onto a sibling of itself. Realpath on both ends so a
    // symlinked HYP_HOME compares equal to its target.
    const [realRoot, realAbs] = await Promise.all([fs.realpath(root).catch(() => root), fs.realpath(abs).catch(() => abs)])
    if (path.dirname(realAbs) === realRoot) {
      span.setAttribute('error_kind', 'already-saved')
      ctx.stderr.write(`hyp report save: ${esc(name)} is already in the store (${esc(root)}); 'hyp report list --local' shows it\n`)
      return 2
    }
    if (!await fileExists(path.join(abs, 'report.md'))) {
      span.setAttribute('error_kind', 'no-entry')
      ctx.stderr.write(`hyp report save: ${esc(source)} must contain report.md at its root\n`)
      return 2
    }
    /** @type {string[]} */
    let pages
    try {
      pages = await reportSourcePages(abs)
    } catch (err) {
      span.setAttribute('error_kind', 'unsupported-entry')
      ctx.stderr.write(`hyp report save: ${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }
    /** @type {string} */
    let dest
    try {
      await fs.mkdir(root, { recursive: true })
      dest = await claimStoreSlot(root, name)
    } catch (err) {
      span.setAttribute('error_kind', 'store')
      ctx.stderr.write(`hyp report save: could not create the store under ${esc(root)}: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    try {
      for (const page of pages) {
        await fs.copyFile(path.join(abs, page), path.join(dest, page), fs.constants.COPYFILE_EXCL)
      }
    } catch (err) {
      span.setAttribute('error_kind', 'copy')
      ctx.stderr.write(`hyp report save: could not copy into ${esc(dest)}: ${err instanceof Error ? err.message : String(err)}; the source is untouched\n`)
      return 1
    }
    const savedName = path.basename(dest)
    span.setAttribute('page_count', pages.length)
    span.setAttribute('renamed', savedName !== name)
    /** @type {string | null} */
    let leftBehind = null
    if (!keep) {
      // Only the pages that were copied are unlinked, never `rm -rf`: the
      // list was validated above, so an rmdir that fails afterwards means a
      // file appeared since, and that file is left where it is and named.
      for (const page of pages) await fs.unlink(path.join(abs, page))
      try {
        await fs.rmdir(abs)
      } catch (err) {
        leftBehind = err instanceof Error ? err.message : String(err)
      }
    }
    markSpanStatus(span, 'ok')
    ctx.stdout.write(`saved ${esc(savedName)} to ${esc(dest)}${savedName !== name ? ` (${esc(name)} was taken)` : ''}\n`)
    if (keep) ctx.stdout.write(`  kept: ${esc(abs)}\n`)
    else if (leftBehind) ctx.stdout.write(`  not removed: ${esc(abs)} (${esc(leftBehind)}); its report pages moved\n`)
    ctx.stdout.write(`  list: hyp report list --local\n`)
    ctx.stdout.write(`  publish: hyp report publish ${shellWord(savedName)} --kind usage-review --period ${publishPeriodHint(savedName)}\n`)
    return 0
  })
}

/**
 * `hyp report publish <file-or-dir>`: publish a report artifact to the org's
 * reports plane. A file publishes a single Markdown document; a
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
  const located = await locateReportSource(ctx, source)
  if (!located) {
    ctx.stderr.write(`hyp report publish: no such file or directory: ${esc(source)}${SAVED_NAME_RE.test(source) ? `, and no saved report of that name in ${esc(reportsStoreRoot(ctx))} ('hyp report list --local' shows them)` : ''}\n`)
    return 2
  }
  ;({ stat } = located)
  const sourcePath = located.path
  if (stat.isDirectory()) {
    // A bundle without an entry document is rejected server-side after the
    // whole upload; catch it here in milliseconds instead.
    const hasEntry = await fileExists(path.join(sourcePath, 'report.md'))
    if (!hasEntry) {
      ctx.stderr.write(`hyp report publish: ${esc(source)} must contain report.md at its root\n`)
      return 2
    }
    let pages
    try {
      pages = await reportSourcePages(sourcePath)
    } catch (err) {
      ctx.stderr.write(`hyp report publish: ${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }
    try {
      body = await packUstarBundle(sourcePath, pages)
    } catch (err) {
      ctx.stderr.write(`hyp report publish: could not build the bundle: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    contentType = 'application/gzip'
  } else {
    const ext = path.extname(sourcePath).toLowerCase()
    if (ext === '.md' || ext === '.markdown') contentType = 'text/markdown'
    else {
      ctx.stderr.write(`hyp report publish: a single-file report must be Markdown (.md or .markdown); the remote renders HTML (got '${esc(ext || source)}')\n`)
      return 2
    }
    body = await fs.readFile(sourcePath)
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
  // The receipt echoes the server's own record back, so every `record` field is
  // remote text on its way to a terminal and takes `esc` (the policy at the top of
  // this file). The `??` fallbacks are this run's own argv, already checked against
  // KIND_RE/PERIOD_RE above, and both grammars admit only characters `esc` and
  // `shellWord` leave alone, so wrapping the whole expression costs a conforming
  // run nothing.
  const recordKind = record.kind ?? kind
  const recordPeriod = record.period ?? period
  const where = `${esc(recordKind)}/${esc(recordPeriod)}/${esc(record.id ?? '?')}`
  if (response.status === 200) {
    ctx.stdout.write(`already published as ${where} (same content) - nothing new uploaded\n`)
  } else {
    ctx.stdout.write(`published ${where} (${esc(record.files ?? '?')} file(s), ${esc(record.bytes ?? '?')} bytes)\n`)
    // Unlike the `where` prose above, this line is a command to paste, so its
    // server-authored words take both treatments, `shellWord(esc(...))`, as the
    // missing-page hint composes them below. `<id>` is this file's own placeholder
    // for a reader to fill in rather than a value to run, so it stays bare.
    const viewId = record.id === undefined || record.id === null ? '<id>' : shellWord(esc(record.id))
    ctx.stdout.write(`  view: hyp report get ${shellWord(esc(recordKind))} ${shellWord(esc(recordPeriod))} ${viewId}\n`)
  }
  return 0
}

/**
 * `hyp report recommend <file.md>`: publish one recommendation page with no
 * report around it. The server wraps the page in a report of kind
 * `recommendation` whose period is the publish date, mints the `hyprec-` id,
 * and dedupes by content hash exactly as `publish` does, so the receipt is
 * the id and the read that takes it. The page follows the same rules as a
 * `recommendation-<slug>.md` page inside a report: the first `# ` heading is
 * the title (`--title` overrides it) and the slug derives from that.
 *
 * @ref LLP 0461#standalone [implements]: one page is a publish of its own; the server supplies the report around it
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runReportRecommend(argv, ctx) {
  const gate = parseCoreCommandArgv('report recommend', argv, ctx)
  if (!gate.ok) return gate.code
  const source = /** @type {string | undefined} */ (gate.params.source)
  if (!source) {
    ctx.stderr.write('usage: hyp report recommend <file.md> [--title <title>] [--org <org>] [--remote <target>]\n')
    return 2
  }
  const ext = path.extname(source).toLowerCase()
  if (ext !== '.md' && ext !== '.markdown') {
    ctx.stderr.write(`hyp report recommend: a recommendation page must be Markdown (.md or .markdown); the remote renders HTML (got '${esc(ext || source)}')\n`)
    return 2
  }
  /** @type {Buffer} */
  let body
  try {
    body = await fs.readFile(source)
  } catch {
    ctx.stderr.write(`hyp report recommend: no such file: ${esc(source)}\n`)
    return 2
  }
  // Emptiness, not presence, as `publish` reads the same parameter: `--title ''`
  // names no title, so it must neither satisfy the heading check below nor travel
  // as an empty `title` the server refuses after the upload.
  const title = /** @type {string | undefined} */ (gate.params.title) || undefined
  // The slug is derived from the title, so a page with no `# ` heading and no
  // --title is refused server-side after the upload; catch it here first.
  // @ref LLP 0155#fail-fast [implements]: the server stays authoritative on the page rules; this rejects the one certain miss
  if (title === undefined && pageTitle(body.toString('utf8'), 'md') === undefined) {
    ctx.stderr.write(`hyp report recommend: ${esc(source)} has no '# ' heading to take the title from - add one or pass --title <title>\n`)
    return 2
  }
  const resolved = resolveReportsTarget(gate.params, ctx, 'report recommend')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  const url = new URL(`${resolved.endpoint}/_recommendations`)
  if (title !== undefined) url.searchParams.set('title', title)
  applyOrgParam(gate.params, url)

  const outcome = await reportsRequest({ ctx, ...resolved, write: true, cmd: 'report recommend' }, (token) =>
    fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/markdown',
        // Same retry safety as `publish`: a re-run of the same page answers
        // 200 with the existing recommendation instead of a second id.
        'x-report-content-hash': crypto.createHash('sha256').update(body).digest('hex'),
      },
      body,
    })
  )
  if (!outcome.ok) {
    ctx.stderr.write(`hyp report recommend: ${outcome.error}\n`)
    return outcome.exitCode
  }
  const { response } = outcome
  if (response.status === 404) {
    // The route is new, so a server that predates it answers 404 with nothing
    // `describeErrorResponse` can name. Say which reading it is, as `mark`
    // does, for that answer only: a 404 that names an error (an unknown
    // `--org`, say) is about the request, and shadowing it would misdirect the
    // one reader who can act on it.
    ctx.stderr.write(`hyp report recommend: ${await describeErrorResponse(response, `'${esc(resolved.target)}' cannot publish a standalone recommendation - is the server up to date? publish the page inside a report with 'hyp report publish' meanwhile`)}\n`)
    return 1
  }
  if (response.status !== 200 && response.status !== 201) {
    ctx.stderr.write(`hyp report recommend: ${await describeErrorResponse(response)}\n`)
    return 1
  }
  const parsed = /** @type {any} */ (await response.json().catch(() => null))
  const rec = parsed?.recommendation ?? {}
  const record = parsed?.report ?? {}
  // The id lands on a command line below, so like a picked id in `fix` it is
  // held to the grammar before it is pasted; one that is not an id is shown
  // escaped and the hint keeps the `<id>` placeholder.
  const id = typeof rec.id === 'string' && RECOMMENDATION_ID_RE.test(rec.id) ? rec.id : undefined
  const shown = id ?? (rec.id === undefined || rec.id === null ? '?' : esc(rec.id))
  const where = `${esc(record.kind ?? 'recommendation')}/${esc(record.period ?? '?')}/${esc(record.id ?? '?')}`
  if (response.status === 200) {
    ctx.stdout.write(`already published as ${shown} (${where}, same content) - nothing new uploaded\n`)
  } else {
    ctx.stdout.write(`published ${shown} (${where})\n`)
  }
  ctx.stdout.write(`  view: ${['hyp report get', id ?? '<id>', ...targetFlags(gate.params)].join(' ')}\n`)
  return 0
}

/**
 * `hyp report list`: list the org's published reports, newest first, each
 * with its recommendations and their status beneath it. With
 * `--recommendations` (or a `--status` filter, which implies it) the list is
 * the recommendations themselves, flat across reports, from the server's
 * `_recommendations` route.
 *
 * @ref LLP 0461#status-is-visible [implements]: every listing line that names a recommendation names its state
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runReportList(argv, ctx) {
  const gate = parseCoreCommandArgv('report list', argv, ctx)
  if (!gate.ok) return gate.code
  const json = gate.params.json === true
  const status = Array.isArray(gate.params.status) ? gate.params.status.map(String) : []
  // Presence of `--status`, not the length of what survived the codec's comma
  // split: the array coercion drops empty parts, so `--status ''` (an unset
  // shell variable) parses to `[]`, and reading the length would quietly list
  // reports instead of the flat form the flag asks for.
  const flat = gate.params.recommendations === true || Array.isArray(gate.params.status)
  // The remote's selectors and filters. `--local` refuses them because none
  // has a local meaning; their absence is also what makes a remote read
  // implicit, the one case a failed read degrades to the saved section.
  const remoteFlags = ['kind', 'period', 'limit', 'before', 'org', 'remote'].filter((flag) => gate.params[flag] !== undefined)
  if (flat) remoteFlags.push(gate.params.recommendations === true ? 'recommendations' : 'status')
  // @ref LLP 0465#list [implements]: saved reports are a section of the one listing; --local is that section alone
  if (gate.params.local === true) {
    if (remoteFlags.length > 0) {
      ctx.stderr.write(`hyp report list: --local lists saved reports only and takes none of ${remoteFlags.map((f) => `--${f}`).join(', ')}\n`)
      ctx.stderr.write('usage: hyp report list [--local] [--json]\n')
      return 2
    }
    const inventory = await localReportInventory(reportsStoreRoot(ctx))
    if (inventory.error) {
      ctx.stderr.write(`hyp report list: cannot read saved reports in ${esc(inventory.root)}: ${esc(inventory.error)}\n`)
      return 1
    }
    if (json) {
      ctx.stdout.write(JSON.stringify(inventory.rows.map(localRow), null, 2) + '\n')
      return 0
    }
    writeLocalSection(ctx, inventory, { standalone: true })
    return 0
  }
  const inventory = flat ? null : await localReportInventory(reportsStoreRoot(ctx))
  if (inventory?.error) ctx.stderr.write(`hyp report list: cannot read saved reports in ${esc(inventory.root)}: ${esc(inventory.error)}\n`)
  /**
   * A remote read that failed. With nothing selecting or filtering the remote,
   * saved reports to show, and a person reading (not `--json`, whose array a
   * script would take for the whole listing), the failure becomes a warning
   * above the saved section; otherwise it is the exit it always was.
   *
   * @ref LLP 0465#list [implements]: an implicit remote failure still lists saved reports; an explicit one keeps its exit code
   * @param {string} line the whole stderr line, prefix included
   * @param {number} code
   * @returns {number}
   */
  const failRemote = (line, code) => {
    if (remoteFlags.length === 0 && !json && inventory && inventory.rows.length > 0) {
      ctx.stderr.write(`${line} - listing saved reports only\n`)
      writeLocalSection(ctx, inventory, { standalone: true })
      return 0
    }
    ctx.stderr.write(`${line}\n`)
    return code
  }
  const resolved = resolveReportsTarget(gate.params, ctx, 'report list')
  if ('error' in resolved) return failRemote(resolved.error, 2)
  const url = new URL(flat ? `${resolved.endpoint}/_recommendations` : resolved.endpoint)
  // Same reason `--json` below reads the gate: `valueFlag()` drops a value
  // whose first character is `-`, so `--limit -5` used to list with the
  // server's default and exit 0 instead of refusing the token.
  for (const flag of ['kind', 'period', 'limit', 'before']) {
    const value = gate.params[flag]
    if (value !== undefined) url.searchParams.set(flag, String(value))
  }
  if (status.length > 0) url.searchParams.set('status', status.join(','))
  applyOrgParam(gate.params, url)

  const outcome = await reportsRequest({ ctx, ...resolved, write: false, cmd: 'report list' }, (token) =>
    fetch(url, { headers: { authorization: `Bearer ${token}` } })
  )
  if (!outcome.ok) return failRemote(`hyp report list: ${outcome.error}`, outcome.exitCode)
  const { response } = outcome
  if (flat && response.status === 404) {
    // Only the flat form asks for a route an older server may not have, and it
    // answers 404 with nothing `describeErrorResponse` can name. One that does
    // name an error came from a server that has the route, so it keeps its own
    // word, the same relay the plain form gives below.
    ctx.stderr.write(`hyp report list: ${await describeErrorResponse(response, `'${esc(resolved.target)}' cannot list recommendations on their own - is the server up to date? 'hyp report list' with no --recommendations/--status lists them under their reports`)}\n`)
    return 1
  }
  if (response.status !== 200) return failRemote(`hyp report list: ${await describeErrorResponse(response)}`, 1)
  const parsed = /** @type {any} */ (await response.json().catch(() => null))
  if (flat) {
    const rows = Array.isArray(parsed?.recommendations) ? parsed.recommendations : []
    if (json) {
      ctx.stdout.write(JSON.stringify(rows, null, 2) + '\n')
      return 0
    }
    if (rows.length === 0) {
      ctx.stdout.write("no recommendations match - 'hyp report list' shows every report; 'hyp report recommend <file.md>' publishes one on its own\n")
      return 0
    }
    for (const c of rows) {
      if (typeof c?.id !== 'string') continue
      const r = c.report
      // A standalone recommendation's report is the wrapper the server made
      // for it, so naming it would send a reader to a report that is the
      // same page; the slot says what it is instead.
      const where = c.standalone === true || r?.kind === 'recommendation'
        ? 'standalone'
        : `${esc(r?.kind ?? '?')}/${esc(r?.period ?? '?')}/${esc(r?.id ?? '?')}`
      const titleCell = typeof c.title === 'string' && c.title ? `\t${esc(c.title)}` : ''
      ctx.stdout.write(`  ${esc(c.id)}\t[${esc(recommendationState(c))}]\t${esc(r?.publishedAt ?? '')}\t${where}${titleCell}\n`)
      if (typeof c.summary === 'string' && c.summary) ctx.stdout.write(`      ${esc(c.summary)}\n`)
    }
    return 0
  }
  const reports = Array.isArray(parsed?.reports) ? parsed.reports : []
  const local = inventory ? inventory.rows : []
  // Read the mode the gate parsed, not argv: the codec also accepts
  // `--json=true`, and a token it blessed must not be dropped downstream.
  // One array, as before: the remote's records whole, then a row per saved
  // report marked `source: 'local'`, so a reader with no saved reports sees
  // the bytes it always did.
  if (json) {
    ctx.stdout.write(JSON.stringify([...reports, ...local.map(localRow)], null, 2) + '\n')
    return 0
  }
  if (reports.length === 0) {
    ctx.stdout.write("no reports published - publish one with 'hyp report publish <file-or-dir> --kind <kind> --period <period>'\n")
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
    // field, so a report with none prints nothing extra. The state marker
    // reads `open` off a record with no status, which is also what an
    // older server, which joins none, lists.
    const recommendations = Array.isArray(r.recommendations) ? r.recommendations : []
    for (const c of recommendations) {
      if (typeof c?.id !== 'string' || typeof c?.page !== 'string') continue
      const titleCell = typeof c.title === 'string' && c.title ? `\t${esc(c.title)}` : ''
      ctx.stdout.write(`      ${esc(c.id)}\t[${esc(recommendationState(c))}]\t${esc(c.page)}${titleCell}\n`)
      if (typeof c.summary === 'string' && c.summary) ctx.stdout.write(`          ${esc(c.summary)}\n`)
    }
  }
  if (inventory) writeLocalSection(ctx, inventory, { standalone: false })
  return 0
}

/**
 * The state a listed recommendation is in. A record that was never marked
 * carries no `status` field, and the contract reads that as `open`.
 *
 * @param {any} c a recommendation row as the server lists it
 * @returns {string}
 */
function recommendationState(c) {
  const state = c?.status?.state
  return typeof state === 'string' && state ? state : 'open'
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
  const segments = fileSegments.flatMap((s) => s.split('/'))
  const suffix = segments.map(encodeURIComponent).join('/')
  // `hyp report list` prints a recommendation by its page stem and calls
  // that stem the path this command takes, but a page is stored under an
  // extension. A last segment that names no extension of its own is therefore
  // tried bare (an artifact may genuinely have none) and then in the forms a
  // page is published in; a path that names an extension is one request.
  const last = segments.at(-1) ?? ''
  const candidates = last && !NAMES_EXTENSION_RE.test(last) ? [suffix, ...PAGE_EXTS.map((ext) => `${suffix}.${ext}`)] : [suffix]
  /** @type {Response} */
  let response
  for (let i = 0; ; i++) {
    const url = new URL(`${resolved.endpoint}/${encodeURIComponent(kind)}/${encodeURIComponent(period)}/${encodeURIComponent(id)}/${candidates[i]}`)
    applyOrgParam(gate.params, url)
    const outcome = await reportsRequest({ ctx, ...resolved, write: false, cmd: 'report get' }, (token) =>
      fetch(url, { headers: { authorization: `Bearer ${token}` } })
    )
    if (!outcome.ok) {
      ctx.stderr.write(`hyp report get: ${outcome.error}\n`)
      return outcome.exitCode
    }
    response = outcome.response
    if (response.status !== 404 || i + 1 === candidates.length) break
  }
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

/**
 * The shape of a server-minted recommendation id: `hyprec-` and 16 hex
 * characters. The `rec-` form is what servers minted before server LLP
 * 0432 and what an older server still lists; it is admitted so a client
 * and a server updated in either order keep working, and the server
 * answers either form with the current one.
 *
 * @ref LLP 0414#id-is-the-handle [constrained-by]: the grammar is the server's; the CLI admits what any live server mints
 */
const RECOMMENDATION_ID_RE = /^(?:hyprec|rec)-[0-9a-f]{16}$/

/**
 * The forms a recommendation page is published in, most readable first:
 * Markdown is what the report generator writes, HTML is what a report
 * published without it carries. Both the page read and the stem
 * `hyp report get` accepts probe them in this order.
 */
const PAGE_EXTS = ['md', 'html']

/**
 * Whether a path segment's trailing dot-run names a file extension. That is
 * a narrower question than `path.extname`'s, which answers what POSIX calls
 * the extension (everything after the last dot) and so reads a slug's version
 * number as one: `path.extname('recommendation-http-1.1-keepalive')` is
 * '.1-keepalive', which would skip the probe for a stem the listing prints.
 * An extension is a word: alphanumerics to the end of the segment with at
 * least one letter among them, so '.md' and '.png' are extensions while
 * '.2026-W29' and '.2' are parts of a name.
 *
 * @ref LLP 0414#list-shows-ids [constrained-by]: every stem the listing prints has to be a path `hyp report get` takes
 */
const NAMES_EXTENSION_RE = /\.[0-9]*[a-z][a-z0-9]*$/i

/**
 * `hyp report fix [id]`: start an attached client on one of a report's
 * recommendations, in the directory the command was typed in.
 *
 * The id is the server's (`hyprec-` and sixteen hex characters, minted at
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
 *   pickDeadlineMs?: number,
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
      ctx.stderr.write(`hyp report fix: '${id}' is not a recommendation id - take one from 'hyp report list' (they look like hyprec-0123456789abcdef)\n`)
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
      // Every row's value is a key in `byId`, so a miss means the prompt
      // answered with something it was never offered. That is said rather
      // than exited 0 in silence, and said once: re-asking a prompt that
      // answers off-list is a loop with nothing to end it.
      hit = group.byId.get(String(picked))
      if (!hit) {
        ctx.stderr.write(`hyp report fix: the picker answered '${esc(String(picked))}', which is not one of the recommendations offered\n`)
        return 1
      }
    }
    recommendation = hit.recommendation
    report = hit.report
  }

  // 2. Which client: attached and on PATH, asked only when that is ambiguous.
  const clients = await askableClients(ctx, deps.collectStatus ? { collectStatus: deps.collectStatus } : {})
  const descriptors = await buildWalkthroughClientDescriptorMap()
  const launchers = await (deps.resolveLaunchers ?? resolveLaunchers)({ clients, descriptors, env: ctx.env })
  if (launchers.length === 0) {
    ctx.stderr.write('hyp report fix: no recorded client can be started here.\n')
    ctx.stderr.write(`  ${attachHint(descriptors)}\n`)
    return 1
  }
  /** @type {FirstAskLauncher | undefined} */
  let launcher = launchers[0]
  if (launchers.length > 1 && interactive) {
    const outcome = await pickClient(ask, ctx, {
      box: true,
      title: 'Which client should make the change?',
      options: launchers.map((l) => ({ value: l.client, label: l.label })),
      ...io,
    }, deps.pickDeadlineMs)
    // An expired deadline leaves `launcher` as it was: the first one, which
    // is what a run that could not prompt at all starts.
    if ('timedOut' in outcome) {
      ctx.stdout.write(PICK_DEADLINE_NOTICE)
    } else {
      launcher = 'client' in outcome ? launchers.find((l) => l.client === outcome.client) : undefined
      if (!launcher) {
        ctx.stdout.write('Nothing started.\n')
        return 0
      }
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
  const title = pageTitle(page.bytes.toString('utf8'), page.ext) ?? recommendation.title ?? recommendationLabel(recommendation.page)
  const where = `${report.kind}/${report.period}${typeof report.title === 'string' && report.title ? `, "${report.title}"` : ''}`
  // The target flags ride along so the client resolves the same org and
  // remote this run did; the credential reaches it through the inherited
  // environment, as every `hyp` call the client makes already relies on.
  const readCommand = ['hyp report get', recommendation.id, ...targetFlags(gate.params)].join(' ')
  const queryFlags = queryTargetFlags(resolved, gate.params)
  // The outcome is recorded by the client that produced it, through the same
  // verb a person would use, against the same target this run resolved.
  // @ref LLP 0461#fix-asks-for-the-mark [implements]: the launched session is told how to close the loop it was started on
  const markCommand = ['hyp report mark', recommendation.id].join(' ')
  const markFlags = targetFlags(gate.params).map((f) => ` ${f}`).join('')
  const prompt =
    `Run \`${readCommand}\` and read its output. It is one recommendation from a HypAware usage report (${where}): "${title}", ` +
    'followed by the evidence it cites and the queries the report ran to reach it. ' +
    'Before implementing, validate the recommendation against current code and its cited evidence. ' +
    'Use remote queries when the evidence comes from the server, keeping the same remote target and organization scope. ' +
    'Treat proposed causes and remedies as hypotheses where indicated; revise or reject them if the investigation points elsewhere. ' +
    'Implement the justified change in this repository, verify it the way this repository verifies changes, ' +
    'and summarise what you changed. If it does not apply to this repository, say why instead of forcing it.' +
    (recommendation.basis.length > 0
      ? ` Re-run the queries with \`hyp query sql ${queryFlags}\` to check the server finding; local queries check only this machine's recordings.`
      : '') +
    ` When the change is landed, run \`${markCommand} applied --reason "<one line>" --link <PR url>${markFlags}\`; ` +
    `if the recommendation should not be done, run \`${markCommand} dismissed --reason "<why>"${markFlags}\`.`
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
    ctx.stderr.write(`hyp ${cmd}: '${id}' is not a recommendation id - take one from 'hyp report list' (they look like hyprec-0123456789abcdef)\n`)
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
    // A server that predates the resolve route answers a listed id with the
    // same 404 an unknown id gets, and nothing in the response separates the
    // two, so both readings are named: the listing the id came from is what
    // tells them apart.
    ctx.stderr.write(`hyp ${cmd}: no recommendation '${id}' in this org - list them with 'hyp report list'; if it is on that listing, '${resolved.target}' cannot resolve recommendation ids - is the server up to date?\n`)
    return 1
  }
  if (outcome.response.status !== 200) {
    ctx.stderr.write(`hyp ${cmd}: ${await describeErrorResponse(outcome.response)}\n`)
    return 1
  }
  const parsed = /** @type {any} */ (await outcome.response.json().catch(() => null))
  // Every field the page URL is built from, not just the id: a report
  // missing `kind` or `period` would fetch `.../undefined/undefined/...` and
  // read as a page the report no longer carries, not as an answer it owes.
  const answered = parsed?.report
  if (
    typeof parsed?.recommendation?.page !== 'string' ||
    typeof answered?.id !== 'string' ||
    typeof answered?.kind !== 'string' ||
    typeof answered?.period !== 'string'
  ) {
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
  for (const ext of PAGE_EXTS) {
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
    const appendix = recordAppendix(recommendation, ext, queryTargetFlags(resolved, gate.params))
    return { bytes: Buffer.concat([bytes, Buffer.from(appendix, 'utf8')]), ext }
  }
  // The repair has to run and do what the sentence says (LLP 0139
  // #repair-must-be-runnable). `report get` on the report fetches its entry
  // document to stdout and lists nothing; the listing filtered to this
  // report prints every recommendation page the record carries.
  // `kind` and `period` are server-authored and land in command position, so they
  // take both treatments: `esc` because a person reads the sentence (LLP 0225), and
  // `shellWord` because they are pasted as arguments. Escaping first puts the quoting
  // decision on the bytes the reader sees. Both are the identity on every
  // KIND_RE/PERIOD_RE value, so a conforming server's hint is unchanged.
  const listCommand = [`hyp report list --kind ${shellWord(esc(report.kind))} --period ${shellWord(esc(report.period))}`, ...targetFlags(gate.params)].join(' ')
  ctx.stderr.write(`hyp ${cmd}: the report no longer carries '${esc(recommendation.page)}' - list the pages it does carry with '${listCommand}'\n`)
  return 1
}

/**
 * One argument as it can be pasted into a shell: bare when it is plain,
 * single-quoted otherwise. For every value a message hands back inside a command.
 *
 * @param {string} s
 * @returns {string}
 */
function shellWord(s) {
  return /^[A-Za-z0-9_.:@%+=\/-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`
}

/**
 * The run's target flags as pasteable words, shellWord-quoted: a command
 * handed back to the user has to reach the target the run did, or it answers
 * about another org's reports. A default-target run yields none.
 *
 * @param {Record<string, unknown>} params the gate's parsed params
 * @returns {string[]}
 */
function targetFlags(params) {
  return ['org', 'remote'].flatMap((f) => params[f] !== undefined ? [`--${f} ${shellWord(String(params[f]))}`] : [])
}

/**
 * The flags a `hyp query sql` re-run needs to reach the population this report
 * was measured over, as pasteable words. Unlike `targetFlags()` this names the
 * *resolved* target, not the typed one, because a bare run resolved its target
 * from config and echoing what was typed would name no remote at all.
 *
 * Every re-run sentence `report fix` puts in front of the launched client comes
 * from here, the prompt and the citations tail of the `hyp report get` it sends
 * the client to read alike: a `<target>` placeholder in either leaves the client
 * nothing to substitute, so its cheapest path is to drop the flag and query the
 * local cache, which is what those sentences exist to prevent.
 *
 * The org gate is emptiness, not presence, unlike `applyOrgParam()`'s: `--org=`
 * is the admin single-org form on the reports plane, but the query plane has no
 * such form (`parseControlFlags` refuses an empty org), so a hint naming it is
 * a command `hyp query sql` rejects. Dropping it scopes nothing away: an
 * omitted `--org` says there what the empty form says on the reports plane, no
 * org named, so the server serves the bearer its own scope.
 *
 * @param {{ target: string }} resolved
 * @param {Record<string, unknown>} params the gate's parsed params
 * @returns {string}
 */
function queryTargetFlags(resolved, params) {
  const org = params.org === undefined ? '' : String(params.org)
  return `--remote ${shellWord(resolved.target)}${org ? ` --org ${shellWord(org)}` : ''}`
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
  // The status the server joins on (its recommendation-status RFC): the
  // current event, absent when never marked, and on the resolve route the
  // whole history oldest first. The listing route carries no history, and an
  // older server carries neither, which reads as never marked.
  const status = recommendationStatus(c?.status)
  /** @type {RecommendationStatus[]} */
  const history = []
  if (Array.isArray(c?.history)) {
    for (const e of c.history) {
      const event = recommendationStatus(e)
      if (event) history.push(event)
    }
  }
  return {
    id,
    page: c.page,
    ...(typeof c.title === 'string' ? { title: c.title } : {}),
    evidence,
    basis,
    ...(status ? { status } : {}),
    history,
  }
}

/**
 * One status event in the shape the server types it, or undefined when the
 * value is not one. The state is admitted as any non-empty string rather
 * than checked against the known four, so a client older than a server that
 * grows a state still shows it instead of calling the recommendation open.
 *
 * @param {any} s
 * @returns {RecommendationStatus | undefined}
 */
function recommendationStatus(s) {
  if (typeof s?.state !== 'string' || !s.state) return undefined
  return {
    state: s.state,
    ...(typeof s.reason === 'string' && s.reason ? { reason: s.reason } : {}),
    links: Array.isArray(s.links) ? s.links.filter((/** @type {unknown} */ l) => typeof l === 'string') : [],
    ...(typeof s.by === 'string' ? { by: s.by } : {}),
    ...(typeof s.at === 'string' ? { at: s.at } : {}),
    ...(typeof s.via === 'string' ? { via: s.via } : {}),
  }
}

/**
 * The record as a tail for the page: the citations, an Evidence list the
 * page's `evidence:N` marks number into and the Basis queries verbatim in
 * fenced blocks, when the record carries any; then the Status, always, so a
 * reader who was handed the id sees whether someone already acted on it
 * before starting. Written as Markdown; on an HTML page (a report published
 * without the Markdown form) the same text sits in one `<pre>` so the file
 * stays HTML and the model still reads it.
 *
 * @ref LLP 0461#status-is-visible [implements]: the brief ends with the recommendation's state, `open` when nothing was ever recorded
 * @param {FixRecommendation} recommendation
 * @param {string} ext `md` or `html`
 * @param {string} queryFlags the run's resolved target flags, for the re-run sentences
 * @returns {string}
 */
function recordAppendix(recommendation, ext, queryFlags) {
  const { evidence, basis } = recommendation
  const lines = ['', '---', '']
  if (evidence.length > 0 || basis.length > 0) lines.push('## Citations from the report record', '')
  if (evidence.length > 0) {
    lines.push('### Evidence', '', `The turns this page cites as \`evidence:N\`, by N. Each is a recorded message; look it up with \`hyp query sql ${queryFlags}\` against \`ai_gateway_messages\` by \`session_id\` and \`message_id\` for server evidence.`, '')
    evidence.forEach((e, i) => {
      const where = [`session ${e.sessionId}`, e.chainId ? `chain ${e.chainId}` : '', `message ${e.messageId}`, e.toolCallId ? `tool call ${e.toolCallId}` : '', e.day].filter(Boolean).join(', ')
      lines.push(`${i + 1}. ${e.note} (${where})`)
    })
    lines.push('')
  }
  if (basis.length > 0) {
    lines.push('### Basis', '', `The queries the report ran to reach this recommendation, verbatim. Re-run them with \`hyp query sql ${queryFlags}\`, keeping the report's date filters. Local queries see only this machine's recordings and do not reproduce the server population.`, '')
    for (const q of basis) {
      if (q.agent) lines.push(`Run by ${q.agent}:`, '')
      // A fence longer than any backtick run in the query, so a query that
      // carries a ``` line of its own cannot close the block early.
      const query = q.query.trim()
      const fence = '`'.repeat(Math.max(3, ...(query.match(/`+/g) ?? []).map((run) => run.length + 1)))
      lines.push(`${fence}sql`, query, fence, '')
    }
  }
  lines.push('## Status', '', ...statusLines(recommendation))
  const text = lines.join('\n')
  if (ext !== 'html') return text
  return `\n<pre>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>\n`
}

/**
 * The Status section's lines: the current event field by field, then the
 * history one line per event, oldest first, when the record carries one.
 * A reason is a free-text field of the server's, so its whitespace is
 * collapsed to keep each event on the one line the section promises.
 *
 * @param {FixRecommendation} recommendation
 * @returns {string[]}
 */
function statusLines({ status, history }) {
  if (!status) return ['State: open (never marked)', '']
  const lines = [`State: ${status.state}`]
  if (status.reason) lines.push(`Reason: ${oneLine(status.reason)}`)
  for (const link of status.links) lines.push(`Link: ${link}`)
  if (status.by) lines.push(`By: ${status.by}${status.via ? ` (via ${status.via})` : ''}`)
  if (status.at) lines.push(`At: ${status.at}`)
  lines.push('')
  if (history.length > 0) {
    lines.push('History, oldest first:', '')
    for (const e of history) {
      const head = [e.at ?? '', e.state, e.by ? `by ${e.by}` : '', e.via ? `via ${e.via}` : ''].filter(Boolean).join('  ')
      const tail = [e.reason ? `: ${oneLine(e.reason)}` : '', ...e.links.map((l) => ` ${l}`)].join('')
      lines.push(`- ${head}${tail}`)
    }
    lines.push('')
  }
  return lines
}

/**
 * @param {string} s
 * @returns {string}
 */
function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Whether a `--link` value is an absolute http(s) URL, the one form the
 * server admits. Checked before the round trip for the fail-fast reason the
 * other grammars are.
 *
 * @param {string} s
 * @returns {boolean}
 */
function isHttpUrl(s) {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
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
 * The page's own title, read the way the page is written: the first
 * Markdown `#` heading of a Markdown page, the first `<h1>` of an HTML one.
 * Undefined when the page has none, so the caller falls back to the stem.
 * Reading both forms out of either page would let a `# ` line inside an HTML
 * `<pre>` (the citations tail writes one) title the brief the client gets.
 *
 * @param {string} text
 * @param {string} ext `md` or `html`, as the page was fetched
 * @returns {string | undefined}
 */
function pageTitle(text, ext) {
  if (ext === 'html') {
    const html = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    return html ? (html[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || undefined) : undefined
  }
  const md = text.match(/^#\s+(.+?)\s*$/m)
  return md ? md[1].replaceAll('`', '') : undefined
}

/**
 * `hyp report mark <id> <state>`: record what became of a recommendation.
 * One PUT to the server's status route appends an event; the server keeps
 * the ledger and the vocabulary, the CLI carries the id, the state, the
 * reason and the links, and says it came from the CLI. Any state may follow
 * any state, so reopening is the same verb. The id takes the same grammar
 * `get` and `fix` do, the legacy `rec-` form included.
 *
 * @ref LLP 0461#mark [implements]: the outcome is one verb on the id, appended server-side, never a field the CLI keeps
 * @ref LLP 0461#reason-for-dismissed [implements]: a dismissal is refused without its reason before any bytes move
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runReportMark(argv, ctx) {
  const gate = parseCoreCommandArgv('report mark', argv, ctx)
  if (!gate.ok) return gate.code
  const id = gate.params.id !== undefined ? String(gate.params.id).trim() : ''
  const state = typeof gate.params.state === 'string' ? gate.params.state : ''
  if (!id || !state) {
    ctx.stderr.write('usage: hyp report mark <id> <open|in_progress|applied|dismissed> [--reason <text>] [--link <url>]... [--org <org>] [--remote <target>]\n')
    return 2
  }
  if (!RECOMMENDATION_ID_RE.test(id)) {
    ctx.stderr.write(`hyp report mark: '${id}' is not a recommendation id - take one from 'hyp report list' (they look like hyprec-0123456789abcdef)\n`)
    return 2
  }
  const reason = gate.params.reason === undefined ? '' : oneLine(String(gate.params.reason))
  if (state === 'dismissed' && !reason) {
    ctx.stderr.write('hyp report mark: dismissed needs --reason "<why>" - the reason is what the next reader sees in place of the change\n')
    return 2
  }
  const links = Array.isArray(gate.params.link) ? gate.params.link.map(String) : []
  // The codec splits an array flag on commas and drops the empty parts, so
  // `--link ''` (an unset shell variable) reaches here as no link at all. The
  // link is the one field a later reader follows to the diff, so a run that
  // asked for one and carries none is refused rather than recorded without it.
  if (Array.isArray(gate.params.link) && links.length === 0) {
    ctx.stderr.write('hyp report mark: --link takes an absolute http(s) URL, got an empty value\n')
    return 2
  }
  for (const link of links) {
    if (!isHttpUrl(link)) {
      ctx.stderr.write(`hyp report mark: --link takes an absolute http(s) URL, got '${link}'\n`)
      return 2
    }
  }
  const resolved = resolveReportsTarget(gate.params, ctx, 'report mark')
  if ('error' in resolved) {
    ctx.stderr.write(`${resolved.error}\n`)
    return 2
  }
  const url = new URL(`${resolved.endpoint}/_recommendations/${encodeURIComponent(id)}/status`)
  applyOrgParam(gate.params, url)
  const body = JSON.stringify({ state, ...(reason ? { reason } : {}), ...(links.length > 0 ? { links } : {}), via: 'cli' })
  const outcome = await reportsRequest({ ctx, ...resolved, write: true, cmd: 'report mark' }, (token) =>
    fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body })
  )
  if (!outcome.ok) {
    ctx.stderr.write(`hyp report mark: ${outcome.error}\n`)
    return outcome.exitCode
  }
  const { response } = outcome
  if (response.status === 404) {
    // As on the resolve route: an unknown id and a server that predates the
    // status route answer alike, so both readings are named.
    ctx.stderr.write(`hyp report mark: no recommendation '${id}' in this org - list them with 'hyp report list'; if it is on that listing, '${resolved.target}' cannot record recommendation status - is the server up to date?\n`)
    return 1
  }
  if (response.status !== 200 && response.status !== 201) {
    ctx.stderr.write(`hyp report mark: ${await describeErrorResponse(response)}\n`)
    return 1
  }
  const parsed = /** @type {any} */ (await response.json().catch(() => null))
  const answered = parsed?.recommendation
  // The receipt is the server's record where it answered with one, so a
  // legacy `rec-` id prints as the `hyprec-` id the server now mints; the
  // fallbacks are this run's own, gate-checked arguments.
  const shown = typeof answered?.id === 'string' && RECOMMENDATION_ID_RE.test(answered.id) ? answered.id : id
  const now = recommendationStatus(answered?.status) ?? { state, ...(reason ? { reason } : {}), links }
  const title = typeof answered?.title === 'string' && answered.title ? `\t${esc(answered.title)}` : ''
  ctx.stdout.write(`marked ${shown} [${esc(now.state)}]${title}\n`)
  if (now.reason) ctx.stdout.write(`  reason: ${esc(now.reason)}\n`)
  for (const link of now.links) ctx.stdout.write(`  link: ${esc(link)}\n`)
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
 * `unnamed` replaces the bare `HTTP <status>` a body that names nothing falls
 * back to. A route this CLI added answers 404 that way on a server predating
 * it, a reading worth naming; a server that does name an error on the same
 * status has the route and is answering about the request, and its own word is
 * the better one to relay.
 *
 * @param {Response} response
 * @param {string} [unnamed] what to say when the body names no error
 * @returns {Promise<string>}
 */
async function describeErrorResponse(response, unnamed) {
  const parsed = /** @type {any} */ (await response.json().catch(() => null))
  const code = typeof parsed?.error === 'string' ? parsed.error : null
  const detail = typeof parsed?.detail === 'string' ? parsed.detail : null
  if (code === 'report_quota_exceeded') {
    return `the org's report quota is full (HTTP 507)${detail ? ` - ${detail}` : ''} - delete old reports with 'hyp report delete' or ask the operator to raise the quota; nothing is auto-pruned`
  }
  if (code) return `HTTP ${response.status}: ${code}${detail ? ` - ${detail}` : ''}`
  return unnamed ?? `HTTP ${response.status}`
}

/**
 * @ref LLP 0436#sources [implements]: reject assets before packing; the server still validates every upload
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function reportSourcePages(dir) {
  const pages = []
  const entries = await fs.opendir(dir)
  for await (const entry of entries) {
    if (!entry.isFile() || !/^(?:report|usage|work|health|(?:recommendation|change)-[a-z0-9][a-z0-9-]*)\.md$/.test(entry.name)) {
      throw new Error(`unsupported report entry '${esc(entry.name)}'; upload only report.md, usage.md, work.md, health.md, and recommendation-<slug>.md as regular files, without HTML, assets, directories, or symlinks; names are lowercase, and a slug is [a-z0-9][a-z0-9-]* - remove stray files such as .DS_Store first`)
    }
    pages.push(entry.name)
  }
  return pages.sort()
}

/**
 * Build a gzipped plain-ustar bundle of the validated pages with system tar. The format
 * is pinned because default formats emit pax/GNU extension entries
 * (typeflags x/g/L/K) the server rejects - and only for some inputs, which
 * would make bundles that work in tests and break on the first long filename.
 *
 * @param {string} dir
 * @param {string[]} pages
 * @returns {Promise<Buffer>}
 * @ref LLP 0155#bundle [implements]: the publish CLI owns bundle creation and pins tar --format=ustar
 */
async function packUstarBundle(dir, pages) {
  const { stdout } = await execFileAsync('tar', ['--format=ustar', '-cz', '-C', dir, '--', ...pages], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
  })
  return stdout
}

/* ---------- the saved-report store ---------- */

/**
 * What a saved report may be called: a plain directory name, nothing hidden,
 * no separator. The skill's `hypaware-report-<from>-to-<to>[-N]` fits; so
 * does a hand-named folder. The grammar is also what lets `publish` tell a
 * saved name from a path it should look up on disk alone.
 */
const SAVED_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The newest saved reports a listing shows; the rest are counted, not read. */
const LOCAL_LIST_LIMIT = 100

/** Slots tried for one name before giving up: `name`, `name-2`, ... */
const STORE_SLOT_LIMIT = 1000

/**
 * The store: `$HYP_HOME/reports`, beside `$HYP_HOME/ask` and under the same
 * resolution (`HYP_HOME`, else `~/.hyp`). Outside every project directory, so
 * no folder marking applies to it, and fixed, so a listing knows where to look.
 *
 * @ref LLP 0465#store [implements]: one fixed folder under HYP_HOME holds finished reports; the caller's directory holds drafts
 * @param {CommandRunContext} ctx
 * @returns {string}
 */
function reportsStoreRoot(ctx) {
  const home = ctx.env.HOME || os.homedir()
  const hypHome = ctx.env.HYP_HOME || path.join(home, '.hyp')
  return path.resolve(ctx.cwd ?? process.cwd(), hypHome, 'reports')
}

/**
 * Claim `root/<name>`, else `root/<name>-2`, `-3`, ... with an exclusive
 * mkdir, so two saves of the same name at once cannot share a slot.
 *
 * @param {string} root
 * @param {string} name
 * @returns {Promise<string>} the directory created
 */
async function claimStoreSlot(root, name) {
  for (let n = 1; n <= STORE_SLOT_LIMIT; n++) {
    const dest = path.join(root, n === 1 ? name : `${name}-${n}`)
    try {
      await fs.mkdir(dest)
      return dest
    } catch (err) {
      if (!(err instanceof Error) || /** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err
    }
  }
  throw new Error(`${STORE_SLOT_LIMIT} folders already share the name '${name}'`)
}

/**
 * The saved reports, newest first by the brief's mtime, capped at
 * `LOCAL_LIST_LIMIT` with the rest counted. One `opendir` and one `lstat` per
 * candidate; no page is read and no symlink followed (a Dirent that is a
 * symlink answers `isDirectory()` false, and a symlinked `report.md` is not a
 * regular file). A missing store is an empty one; any other read failure is
 * returned for the caller to name, never thrown.
 *
 * @ref LLP 0465#list [implements]: directory entries and one stat each, bounded to the newest 100, never report contents
 * @param {string} root
 * @returns {Promise<{ root: string, rows: LocalReportRow[], total: number, error: string | null }>}
 */
async function localReportInventory(root) {
  /** @type {LocalReportRow[]} */
  const rows = []
  let total = 0
  /** @type {Dir} */
  let dir
  try {
    dir = await fs.opendir(root)
  } catch (err) {
    const code = err instanceof Error ? /** @type {NodeJS.ErrnoException} */ (err).code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') return { root, rows, total, error: null }
    return { root, rows, total, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    for await (const entry of dir) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      /** @type {Stats} */
      let brief
      try {
        brief = await fs.lstat(path.join(root, entry.name, 'report.md'))
      } catch {
        continue
      }
      if (!brief.isFile()) continue
      total++
      insertNewest(rows, { name: entry.name, path: path.join(root, entry.name), modifiedAt: brief.mtime.toISOString(), mtimeMs: brief.mtimeMs })
    }
  } catch (err) {
    return { root, rows, total, error: err instanceof Error ? err.message : String(err) }
  }
  return { root, rows, total, error: null }
}

/**
 * Keep `rows` sorted newest first and no longer than `LOCAL_LIST_LIMIT`: a
 * row older than a full set's last member is dropped without a sort.
 *
 * @param {LocalReportRow[]} rows
 * @param {LocalReportRow} row
 */
function insertNewest(rows, row) {
  let i = rows.length
  while (i > 0 && rows[i - 1].mtimeMs < row.mtimeMs) i--
  if (i >= LOCAL_LIST_LIMIT) return
  rows.splice(i, 0, row)
  if (rows.length > LOCAL_LIST_LIMIT) rows.pop()
}

/**
 * A saved report as `--json` lists it beside the remote's records: marked
 * `source: 'local'`, with the path derived here, never read from anywhere.
 *
 * @param {LocalReportRow} row
 * @returns {{ source: 'local', name: string, path: string, modifiedAt: string }}
 */
function localRow(row) {
  return { source: 'local', name: row.name, path: row.path, modifiedAt: row.modifiedAt }
}

/**
 * The saved section of a listing. Nothing is printed when there is nothing
 * saved and the section follows a remote listing, so a reader with no store
 * sees the listing they always did; `--local` says so instead.
 *
 * @param {CommandRunContext} ctx
 * @param {Awaited<ReturnType<typeof localReportInventory>>} inventory
 * @param {{ standalone: boolean }} opts
 */
function writeLocalSection(ctx, inventory, { standalone }) {
  const { rows, total, root } = inventory
  if (rows.length === 0) {
    if (standalone) ctx.stdout.write(`no saved reports in ${esc(root)} - 'hyp report save <dir>' moves a finished report folder there\n`)
    return
  }
  if (!standalone) ctx.stdout.write('\n')
  ctx.stdout.write(`saved reports (${esc(root)}):\n`)
  for (const row of rows) ctx.stdout.write(`  ${row.modifiedAt}\tlocal\t${esc(row.name)}\n`)
  if (total > rows.length) ctx.stdout.write(`  ${total - rows.length} more not listed (newest ${LOCAL_LIST_LIMIT} shown)\n`)
  ctx.stdout.write('  publish one: hyp report publish <name> --kind <kind> --period <period>\n')
}

/**
 * Where `publish` reads from: the path as given, else the saved report of
 * that name. A path wins when both exist, since a path is what the argument
 * always meant; a token that is not a plain name is never looked up in the
 * store. A saved name resolves only to a directory, the one thing `save`
 * puts there.
 *
 * @ref LLP 0465#publish-by-name [implements]: a saved report publishes by its name; a path that exists still wins
 * @param {CommandRunContext} ctx
 * @param {string} source
 * @returns {Promise<{ path: string, stat: Stats } | null>}
 */
async function locateReportSource(ctx, source) {
  const direct = path.resolve(ctx.cwd ?? process.cwd(), source)
  try {
    return { path: direct, stat: await fs.stat(direct) }
  } catch {
    // Not a path on disk; try the store below.
  }
  if (!SAVED_NAME_RE.test(source)) return null
  const saved = path.join(reportsStoreRoot(ctx), source)
  try {
    const stat = await fs.stat(saved)
    return stat.isDirectory() ? { path: saved, stat } : null
  } catch {
    return null
  }
}

/**
 * The `--period` a saved report's name suggests: the skill encodes the
 * covered range as `hypaware-report-<from>-to-<to>`, and `<from>-to-<to>` is
 * a valid period. Any other name yields the bare placeholder. A hint in a
 * receipt, never a default the command applies.
 *
 * @ref LLP 0155#period-explicit [constrained-by]: the period is only ever suggested from the name the generator chose, never defaulted from today
 * @param {string} name
 * @returns {string}
 */
function publishPeriodHint(name) {
  const m = /^hypaware-report-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})(?:-\d+)?$/.exec(name)
  return m ? `${m[1]}-to-${m[2]}` : '<period>'
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
