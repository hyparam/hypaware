// @ts-check

import { Attr, withSpan } from '../observability/index.js'
import { collectHypAwareStatus } from '../daemon/status.js'
import { formatFirstSyncDeadline } from '../usage-policy/first_sync_hold.js'
import { ANSI, boxed, paint } from '../cli/style.js'
import { useColor } from '../cli/stdio.js'
import { formatBytesShort, formatCount, friendlyClientLabel, wrapToWidth } from '../cli/format.js'

/**
 * @import { AiGatewayCapability, CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { HypAwareStatusReport, ServiceState } from '../../../src/core/daemon/types.js'
 * @import { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../../../src/core/registry/types.js'
 */

/**
 * `hyp status [--full] [--json]`
 *
 * Default: a fixed-shape summary answering the one question `hyp --help`
 * sends readers here for - is this install healthy, is it recording, where
 * does the data go, and what needs the user. `--full` renders the whole
 * inventory (config path, active plugins, source/sink/client rosters, the
 * client-action ledger, remote-config state); `--json` is unchanged and
 * remains the fixed-shape surface for machine consumers.
 *
 * Span: `status.render`. Attributes match the bead contract
 * (`source_count`, `sink_count`, `cache_size_bytes`,
 * `oldest_partition_date`, `daemon_state`, `diagnostics_count`) and
 * also carry the legacy attributes (`client_count`, `retention_days`)
 * that earlier smokes assert on.
 *
 * @ref LLP 0212#decision [implements]: the default screen is a triage summary; the inventory moves behind --full
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runStatus(argv, ctx) {
  const json = argv.includes('--json')
  const full = argv.includes('--full')

  const sources = /** @type {ExtendedSourceRegistry} */ (ctx.sources)
  const sinks = /** @type {ExtendedSinkRegistry} */ (ctx.sinks)

  const runtimeClientNames = listClientNames(ctx.capabilities)

  const report = await collectHypAwareStatus({
    env: ctx.env,
    runtime: {
      sources,
      sinks,
      capabilities: ctx.capabilities,
      query: ctx.query,
      storage: ctx.storage,
    },
  })

  // Source/sink lists from the report are the canonical set. The
  // walkthrough smoke checks for plugin names in stdout, so we lean
  // on the report's `sources`/`sinks` arrays which include both
  // contributions and running state.
  const sourceRows = report.sources
  const sinkRows = report.sinks
  const clientNames = runtimeClientNames.length > 0
    ? runtimeClientNames
    : report.clients
      .filter((c) => c.configured)
      .map((c) => c.name)
      .sort()
  const registeredDatasets = ctx.query.listDatasets()
  const datasets = registeredDatasets.length > 0
    ? registeredDatasets
    : inferDatasetsFromPlugins(report.activePlugins)

  return withSpan(
    'status.render',
    {
      [Attr.COMPONENT]: 'status',
      [Attr.OPERATION]: 'status.render',
      source_count: sourceRows.length,
      sink_count: sinkRows.length,
      client_count: clientNames.length,
      dataset_count: datasets.length,
      cache_size_bytes: report.cache.totalBytes,
      oldest_partition_date: report.cache.oldestDate ?? '',
      retention_days: report.retention.days,
      active_plugin_count: report.activePlugins.length,
      daemon_state: report.daemon.state ?? (report.daemon.running ? 'running' : 'stopped'),
      diagnostics_count: report.diagnostics.length,
      overall: report.overall,
      format: json ? 'json' : full ? 'full' : 'summary',
      status: 'ok',
    },
    async () => {
      if (json) {
        const payload = renderStatusJson({
          report,
          clientNames,
          datasets,
          cacheRoot: ctx.storage.cacheRoot,
        })
        ctx.stdout.write(JSON.stringify(payload, null, 2) + '\n')
        return 0
      }
      if (full) {
        renderStatusFull({
          report,
          clientNames,
          datasets,
          cacheRoot: ctx.storage.cacheRoot,
          stdout: ctx.stdout,
        })
        return 0
      }
      renderStatusSummary({
        report,
        stdout: ctx.stdout,
        env: ctx.env,
      })
      return 0
    },
    { component: 'status' }
  )
}

/**
 * Render the V1 status report as a stable JSON shape. Consumers may
 * pin keys without dispatching on platform; missing values surface as
 * `null` rather than being omitted, so smoke assertions can probe
 * specific fields directly.
 *
 * Excludes any `@hypaware/central` and `@hypaware/gascity` keys per
 * V1 contract (Phase 8 bead): the V1 surface must not require either.
 *
 * @param {{
 *   report: HypAwareStatusReport,
 *   clientNames: string[],
 *   datasets: { name: string, plugin: string }[],
 *   cacheRoot: string,
 * }} args
 */
export function renderStatusJson({ report, clientNames, datasets, cacheRoot }) {
  return {
    overall: report.overall,
    config: {
      path: report.configPath,
      exists: report.configExists,
      valid: report.configValid,
    },
    // V1 stable shape: array of `{name}` so consumers can pin keys
    // without needing to know the version. The collector currently
    // does not track per-plugin version (Phase 2 set version on each
    // entry but it was always 'unknown'); keeping the field reserved
    // lets later phases populate it without breaking smokes. On a
    // centrally-managed host each entry also carries its layer
    // provenance (LLP 0031).
    active_plugins: report.activePlugins.map((name) => ({
      name,
      ...(report.layered
        ? { provenance: report.layered.centralPlugins.includes(name) ? 'central' : 'local' }
        : {}),
    })),
    daemon: {
      installed: report.daemon.installed,
      loaded: report.daemon.loaded,
      running: report.daemon.running,
      state: report.daemon.state ?? 'unknown',
      pid: report.daemon.pid ?? null,
      mode: report.daemon.mode ?? null,
      run_id: report.daemon.runId ?? null,
      platform: report.daemon.platform,
      ...(report.daemon.error ? { error: report.daemon.error } : {}),
    },
    sources: report.sources.map((s) => ({
      name: s.name,
      plugin: s.plugin,
      state: s.state,
      ...(report.layered
        ? { provenance: report.layered.centralPlugins.includes(s.plugin) ? 'central' : 'local' }
        : {}),
      ...(s.error ? { error: s.error } : {}),
    })),
    sinks: report.sinks.map((s) => ({
      instance: s.instance,
      plugin: s.plugin,
      kind: s.kind,
      ...(report.layered
        ? { provenance: report.layered.centralSinks.includes(s.instance) ? 'central' : 'local' }
        : {}),
      ...(s.lastTickAt ? { last_tick_at: s.lastTickAt } : {}),
      ...(s.lastSuccessAt ? { last_success_at: s.lastSuccessAt } : {}),
    })),
    // Backwards-compatible shape: array of registered client names.
    // Phase 8 attach detail lives under `client_attach`.
    clients: clientNames,
    client_attach: report.clients.map((c) => ({
      name: c.name,
      configured: c.configured,
      attached: c.attached,
      ...(report.layered
        ? { provenance: report.layered.centralPlugins.includes(c.plugin) ? 'central' : 'local' }
        : {}),
      ...(c.settingsPath ? { settings_path: c.settingsPath } : {}),
      ...(c.version ? { version: c.version } : {}),
      ...(c.port ? { port: c.port } : {}),
      ...(c.error ? { error: c.error } : {}),
    })),
    // Picked clients grouped by provenance (LLP 0132 #never-silent). Null on
    // a solo host with no central layer, so the V1 JSON shape is unchanged.
    client_sync: report.clientSync
      ? { syncing: report.clientSync.syncing, local_only: report.clientSync.localOnly }
      : null,
    // Client surfaces the daemon's gateway actually produced rows for (LLP
    // 0164). Always an array so a consumer can pin the key; empty means "no
    // daemon has recorded any", which is not the same as "no traffic ever" -
    // the cache is the durable record, this is only the activity signal.
    // @ref LLP 0164#status-reads-it-from-the-status-file [implements]: --json carries the machine-readable last-seen list
    recent_entrypoints: report.recentEntrypoints.map((e) => ({
      entrypoint: e.entrypoint,
      client_name: e.clientName,
      last_seen: e.lastSeen,
      rows: e.rows,
    })),
    datasets: datasets.map((d) => ({ name: d.name, plugin: d.plugin })),
    cache: {
      dir: cacheRoot,
      retention_days: report.retention.days,
      retention_source: report.retention.source,
      size_bytes: report.cache.totalBytes,
      oldest_partition_date: report.cache.oldestDate,
    },
    recent_error_count: report.recentErrorCount,
    // Machine-local local-only directory withholding (LLP 0069 R9). Null
    // only when the exclusion list itself could not be read (see the
    // `local_only_list_unreadable` diagnostic).
    usage_policy: report.usagePolicy
      ? {
        local_only_dir_count: report.usagePolicy.localOnlyDirCount,
        folder_ask: report.usagePolicy.folderAsk,
      }
      : null,
    // Pending first-sync export hold (LLP 0101 / LLP 0100 R9): null once the
    // hold has expired or was never written, exactly matching the sink
    // driver's own fail-open read of the marker.
    first_sync_hold: report.firstSyncHoldDeadline !== null
      ? {
        deadline: new Date(report.firstSyncHoldDeadline).toISOString(),
        deadline_ms: report.firstSyncHoldDeadline,
      }
      : null,
    // Two-layer provenance (LLP 0031). Null on a host that never joined,
    // so the V1 JSON shape is unchanged for ordinary installs.
    config_layers: report.layered
      ? {
        central: true,
        central_plugins: report.layered.centralPlugins,
        central_sinks: report.layered.centralSinks,
        central_query_ignored: report.layered.centralQueryIgnored,
        local_not_applied: report.layered.drops.map((d) => ({
          section: d.section,
          key: d.key,
          reason: d.reason,
          ...(d.detail ? { detail: d.detail } : {}),
        })),
      }
      : null,
    // Remote-config apply state (LLP 0025). All-null until the gateway
    // applies its first centrally-served config.
    remote_config: report.remoteConfig
      ? {
        running_etag: report.remoteConfig.runningEtag,
        probation: report.remoteConfig.probation
          ? {
            etag: report.remoteConfig.probation.etag,
            applied_at: report.remoteConfig.probation.applied_at,
            until: report.remoteConfig.probation.until,
          }
          : null,
        last_rollback: report.remoteConfig.lastRollback,
        bad_etag: report.remoteConfig.badEtag,
      }
      : null,
    // Client-action reconciler state (LLP 0036 / 0041). Null until a
    // backfill-on-join target is configured or a pass has run; a `failed`
    // entry is informational and never affects `overall`.
    client_actions: report.clientActions
      ? report.clientActions.actions.map((a) => ({
        kind: a.kind,
        request_key: a.requestKey,
        state: a.state,
        ...(a.rows !== undefined ? { rows: a.rows } : {}),
        ...(a.at ? { at: a.at } : {}),
        ...(a.reason ? { reason: a.reason } : {}),
        ...(a.lastAttempt ? { last_attempt: a.lastAttempt } : {}),
        ...(a.attempts !== undefined ? { attempts: a.attempts } : {}),
      }))
      : null,
    diagnostics: report.diagnostics.map((d) => ({
      severity: d.severity,
      kind: d.kind,
      message: d.message,
      repair: d.repair,
      ...(d.pointer ? { pointer: d.pointer } : {}),
    })),
  }
}

/**
 * Render the whole status report as text: every section, unconditionally,
 * mirroring the JSON shape. This is `hyp status --full`, and it is the
 * surface every never-silent requirement can point at without qualification
 * (LLP 0212 #never-silent). The default screen is
 * {@link renderStatusSummary}.
 *
 * @param {{
 *   report: HypAwareStatusReport,
 *   clientNames: string[],
 *   datasets: { name: string, plugin: string }[],
 *   cacheRoot: string,
 *   stdout: { write(chunk: string): unknown },
 * }} args
 */
export function renderStatusFull({ report, clientNames, datasets, cacheRoot, stdout }) {
  stdout.write('hypaware\n')
  stdout.write(`  overall:  ${report.overall}\n`)
  const configState = report.configExists
    ? (report.configValid ? 'ok' : 'invalid')
    : 'missing'
  stdout.write(`  config:   ${report.configPath} (${configState})\n`)

  const daemonLine = describeDaemon(report.daemon)
  stdout.write(`  daemon:   ${daemonLine}\n`)

  stdout.write('  active plugins:\n')
  if (report.activePlugins.length === 0) {
    stdout.write('    (none - no config or no plugins selected)\n')
  } else {
    for (const name of report.activePlugins) {
      stdout.write(`    - ${name}${provenanceTag(report.layered, isCentralPlugin(report.layered, name))}\n`)
    }
  }

  stdout.write('  sources:\n')
  if (report.sources.length === 0) {
    stdout.write('    (none)\n')
  } else {
    for (const s of report.sources) {
      stdout.write(`    - ${s.name}  (${s.plugin})  [${s.state}]${provenanceTag(report.layered, isCentralPlugin(report.layered, s.plugin))}\n`)
    }
  }

  stdout.write('  sinks:\n')
  if (report.sinks.length === 0) {
    stdout.write('    (none - keeping captured data local only)\n')
  } else {
    for (const s of report.sinks) {
      stdout.write(`    - ${s.instance}  (${s.plugin}, ${s.kind})${provenanceTag(report.layered, isCentralSink(report.layered, s.instance))}\n`)
    }
  }

  stdout.write('  clients:\n')
  // A probe that could not answer at all carries `error`, and the text surface
  // is where a human reads status. Collapsing such a client into `(none)`, or
  // printing it as a bare `not attached`, restores exactly the wrong negative
  // indistinguishable from a right one that the `error` field exists to end -
  // and an unresolvable client is typically not `configured`, so the collapse
  // would otherwise catch it. `--json` already carries the field.
  // @ref LLP 0045#settings_file-is-home-relative-and-a-violation-is-loud [implements]: a probe error is loud on the text surface too, not only under --json
  if (clientNames.length === 0 && report.clients.every((c) => !c.configured && !c.error)) {
    stdout.write('    (none)\n')
  } else {
    // Surface the union of registered clients (from the gateway) and
    // configured/attached clients (from the report). Each line shows
    // configured + attached state so a missing attach jumps out.
    const seen = new Set()
    for (const c of report.clients) {
      seen.add(c.name)
      const state = []
      state.push(c.configured ? 'configured' : 'not in config')
      state.push(c.attached ? 'attached' : 'not attached')
      stdout.write(`    - ${c.name}  [${state.join(', ')}]${provenanceTag(report.layered, isCentralPlugin(report.layered, c.plugin))}\n`)
      if (c.error) stdout.write(`        error: ${c.error}\n`)
    }
    for (const name of clientNames) {
      if (seen.has(name)) continue
      stdout.write(`    - ${name}  [registered]\n`)
    }
  }

  // Never-silent client sync split (LLP 0188 #never-silent): on an enrolled
  // host the configured sources divide into what forwards (`syncing`, the
  // default for everything) and what the user opted out (`local-only`), so
  // a withheld source is never invisible. Null (a solo host) leaves the V1
  // surface unchanged.
  if (report.clientSync) {
    const list = (/** @type {string[]} */ names) => (names.length > 0 ? names.join(' · ') : '(none)')
    stdout.write(
      `    syncing: ${list(report.clientSync.syncing)} - local-only: ${list(report.clientSync.localOnly)}\n`
    )
  }

  // Which client surfaces have actually produced rows, and when (LLP 0164).
  // This is the line that answers "did Codex Desktop traffic arrive?" and
  // "did Claude Desktop's 3p route land?" without a query. Rendered only when
  // the daemon recorded something, so an install that has never captured
  // keeps the V1 text surface unchanged; the entrypoint strings are printed
  // verbatim because they are the client's to choose, and they are the exact
  // values a follow-up `ai_gateway_messages` query filters on.
  // @ref LLP 0164#status-reads-it-from-the-status-file [implements]: hyp status names recent client surfaces and their age
  if (report.recentEntrypoints.length > 0) {
    stdout.write('  recent clients:\n')
    for (const e of report.recentEntrypoints) {
      const client = e.clientName ? `  (${e.clientName})` : ''
      stdout.write(
        `    - ${e.entrypoint}${client}  last seen ${formatEntrypointAge(e.lastSeen)}, ${e.rows} row${e.rows === 1 ? '' : 's'}\n`
      )
    }
  }

  stdout.write(`  cache:           ${cacheRoot}\n`)
  stdout.write(
    `  cache retention: ${report.retention.days} days${
      report.retention.source === 'default' ? ' (default)' : ''
    }\n`
  )
  stdout.write(`  cache size:      ${report.cache.totalBytes} bytes\n`)
  stdout.write(`  datasets:        ${datasets.length}\n`)
  stdout.write(`  recent errors:   ${report.recentErrorCount}\n`)

  // Never-silent withholding (LLP 0069 R9): only rendered when a directory
  // is actually excluded, so an ordinary host's text output is unchanged.
  if (report.usagePolicy && report.usagePolicy.localOnlyDirCount > 0) {
    stdout.write(
      `  local-only:      withholding ${report.usagePolicy.localOnlyDirCount} directories from forwarding (recorded locally)\n`
    )
  }

  // What happens the next time the user works somewhere new (LLP 0200).
  // Enrolled hosts only: on a machine with no server the question has no
  // stakes and the hook is inert (LLP 0106 #enrolled-only), so a solo
  // host's text output is unchanged. Both modes are stated - the default
  // is the one with data consequences, so it is exactly the one that must
  // not be silent.
  if (report.layered?.hasCentral && report.usagePolicy) {
    stdout.write(
      report.usagePolicy.folderAsk === 'sync'
        ? '  new folders:     sync without asking (`hyp policy folders ask` to be asked instead)\n'
        : '  new folders:     asked about once each (`hyp policy folders sync` to stop asking)\n'
    )
  }

  // Never-silent first-sync hold (LLP 0100 R9): only rendered while a hold is
  // actually live, so an ordinary (never-enrolled, or past-deadline) host's
  // text output is unchanged.
  if (report.firstSyncHoldDeadline !== null) {
    stdout.write(
      `  first sync:      held until ${formatFirstSyncDeadline(report.firstSyncHoldDeadline)} (review with the hypaware-privacy skill; \`hyp sync\` sends it now)\n`
    )
  }

  // Local entries the central layer overrides (LLP 0031): dropped at
  // merge, listed here with their reason. Loud, but not an outage signal.
  // The gateway runs fine on the central config.
  if (report.layered && (report.layered.drops.length > 0 || report.layered.centralQueryIgnored)) {
    stdout.write('  local config (not applied):\n')
    for (const d of report.layered.drops) {
      const why = d.detail
        ? `${d.reason.replace(/_/g, ' ')}: ${d.detail.replace(/_/g, ' ')}`
        : d.reason.replace(/_/g, ' ')
      stdout.write(`    - ${d.section}.${d.key}  (${why})\n`)
    }
    if (report.layered.centralQueryIgnored) {
      stdout.write('    - central query block ignored (query is local-only)\n')
    }
  }

  // Remote-config section appears only once the gateway has state to
  // show. A never-joined install keeps the V1 status surface.
  const rc = report.remoteConfig
  if (rc && (rc.runningEtag || rc.probation || rc.lastRollback || rc.badEtag)) {
    stdout.write('  remote config:\n')
    if (rc.runningEtag) stdout.write(`    running etag:  ${rc.runningEtag}\n`)
    if (rc.probation) {
      stdout.write(`    probation:     ${rc.probation.etag} until ${rc.probation.until}\n`)
    }
    if (rc.lastRollback) {
      stdout.write(`    last rollback: ${rc.lastRollback.etag} at ${rc.lastRollback.at} (${rc.lastRollback.reason})\n`)
    }
    if (rc.badEtag) {
      stdout.write(`    bad etag:      ${rc.badEtag.etag} (${rc.badEtag.reason})\n`)
    }
  }

  // Client-action reconciler section (LLP 0036 / 0041). Appears only once a
  // backfill-on-join target is configured or a pass has run; a `failed`
  // line is loud but informational. It never degrades `overall`.
  if (report.clientActions && report.clientActions.actions.length > 0) {
    stdout.write('  client actions:\n')
    for (const a of report.clientActions.actions) {
      let detail = ''
      if (a.state === 'done') {
        const bits = []
        if (a.rows !== undefined) bits.push(`${a.rows} rows`)
        if (a.at) bits.push(`at ${a.at}`)
        if (bits.length > 0) detail = `  (${bits.join(', ')})`
      } else if (a.state === 'failed') {
        const bits = []
        if (a.reason) bits.push(a.reason)
        if (a.lastAttempt) bits.push(`last attempt ${a.lastAttempt}`)
        if (a.attempts !== undefined) bits.push(`${a.attempts} attempt${a.attempts === 1 ? '' : 's'}`)
        if (bits.length > 0) detail = `  (${bits.join(', ')})`
      } else if (a.state === 'refused') {
        // The repair hint is unconditional, unlike the reason bits it follows:
        // the hint is the whole point of the state (a refusal is terminal until
        // the user acts), so a marker that carries no readable `reason` must
        // still say what to do rather than render a bare `[refused]`, which is
        // the attention signal without the action.
        // @ref LLP 0186#hyp-status-attention-needed-surface [implements]: distinct bracketed state plus a concrete next step, not a repeated generic retry line
        const bits = []
        if (a.reason) bits.push(a.reason)
        const repair = `run 'hyp attach ${a.requestKey}' after fixing the cause`
        detail = bits.length > 0 ? `  (${bits.join(', ')})  ${repair}` : `  ${repair}`
      }
      stdout.write(`    - ${a.kind} ${a.requestKey}  [${a.state}]${detail}\n`)
    }
  }

  if (report.diagnostics.length > 0) {
    stdout.write('  diagnostics:\n')
    for (const d of report.diagnostics) {
      const tag = d.severity === 'error' ? 'ERROR' : 'WARN '
      stdout.write(`    [${tag}] ${d.kind}: ${d.message}\n`)
      for (const repair of d.repair) {
        stdout.write(`        repair: ${repair}\n`)
      }
    }
  }
}

/** Width of the summary's label gutter; `HypAware` is the longest entry. */
const LABEL_WIDTH = 10

/** Width of the attention section's severity gutter, indented by two. */
const SEVERITY_WIDTH = 9

/**
 * Assumed terminal width when the stream will not say. 80 is the
 * conventional answer, and it is the right kind of wrong: a summary that
 * assumed "unbounded" would lay out a 120-column frame that breaks the
 * moment it is piped into a pager, a CI log, or a chat message. Too narrow
 * only costs a wrapped line.
 */
const ASSUMED_COLUMNS = 80

/** Narrowest frame worth drawing; below this the gutter layout is enough. */
const MIN_FRAMED_COLUMNS = 34

/**
 * @param {{ columns?: number }} stdout
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
function terminalColumns(stdout, env) {
  if (typeof stdout.columns === 'number' && stdout.columns > 0) return stdout.columns
  const declared = Number(env?.COLUMNS)
  if (Number.isFinite(declared) && declared > 0) return declared
  return ASSUMED_COLUMNS
}

/**
 * The default `hyp status` screen: four rows in one frame, then whatever
 * needs the reader.
 *
 * `hyp --help` sends people here for "whether this install is working", and
 * the inventory that used to answer alongside it (ten plugin lines, two
 * rosters, a nine-entry action ledger, a config etag, two absolute paths)
 * answered something else. Every fact it carried is still one flag away, and
 * the facts that are *conditional* - a client that is not attached, a folder
 * being withheld, a refused action - are the ones promoted here, because a
 * conditional fact is the only kind a reader can act on.
 *
 * Nothing here reads the cache or activates a plugin: the report is already
 * collected, and `activity` comes from the daemon's own status file
 * (LLP 0164).
 *
 * @ref LLP 0212#rows [implements]: healthy / recording / where it goes / what needs me, in that order
 * @ref LLP 0212#width [implements]: wrap to the terminal before drawing the frame, hang continuations in the value column
 * @ref LLP 0135#disclosure [constrained-by]: the frame is a shape, not a colour, so it survives NO_COLOR
 *
 * @param {{
 *   report: HypAwareStatusReport,
 *   stdout: { write(chunk: string): unknown, columns?: number },
 *   env?: Record<string, string | undefined>,
 *   nowMs?: number,
 * }} args
 */
export function renderStatusSummary({ report, stdout, env, nowMs = Date.now() }) {
  const color = useColor(stdout, env)
  const columns = terminalColumns(stdout, env)
  const framed = columns >= MIN_FRAMED_COLUMNS
  // The frame costs four columns (two edges, two pads). Reserving them here,
  // rather than letting the terminal discover the overflow, is what keeps the
  // rectangle a rectangle.
  const rowWidth = (framed ? columns - 4 : columns) - LABEL_WIDTH

  const healthy = report.overall !== 'degraded'
  /** @type {string[]} */
  const rows = [
    ...gutter(
      paint('HypAware'.padEnd(LABEL_WIDTH), ANSI.bold, color),
      [paint(report.overall, healthy ? ANSI.green : ANSI.yellow, color)]
    ),
    ...labelled('daemon', summariseDaemonShort(report.daemon), rowWidth, color),
    ...labelled('capture', summariseCapture(report), rowWidth, color),
    ...labelled('activity', summariseActivity(report, nowMs), rowWidth, color),
    ...labelled('data', summariseData(report), rowWidth, color),
  ]

  for (const line of framed ? boxed(rows, { color, columns }) : rows) {
    stdout.write(`${line}\n`)
  }

  const attention = collectAttention(report)
  if (attention.length > 0) {
    // Floored rather than allowed to go negative: past this the gutter itself
    // is most of the screen, and a hard-broken word is still better than a
    // line that runs off it.
    const textWidth = Math.max(8, columns - 2 - SEVERITY_WIDTH)
    stdout.write('\n')
    for (const item of attention) {
      const sgr = item.severity === 'error' ? ANSI.red : item.severity === 'warning' ? ANSI.yellow : ANSI.dim
      const lines = gutter(
        paint(item.severity.padEnd(SEVERITY_WIDTH), sgr, color),
        wrapToWidth(item.message, textWidth),
        SEVERITY_WIDTH
      )
      for (const repair of item.repair) {
        // The arrow hangs one line per repair, aligned with the message, so a
        // long command wraps under itself rather than under the severity.
        for (const line of gutter('', wrapToWidth(`→ ${repair}`, textWidth), SEVERITY_WIDTH)) {
          lines.push(paint(line, ANSI.dim, color))
        }
      }
      for (const line of lines) stdout.write(`  ${line}\n`)
    }
  }

  stdout.write('\n')
  for (const line of wrapToWidth('hyp status --full for the full inventory, --json for everything', columns)) {
    stdout.write(`${paint(line, ANSI.dim, color)}\n`)
  }
}

/**
 * Lay wrapped text against a gutter: the label on the first line, blanks
 * under it on the rest, so a continuation reads as part of the same row
 * instead of as a new one.
 *
 * @param {string} label already padded and painted; may be empty
 * @param {string[]} lines already wrapped
 * @param {number} [width] visible width of the gutter
 * @returns {string[]}
 */
function gutter(label, lines, width = LABEL_WIDTH) {
  const blank = ' '.repeat(width)
  return lines.map((line, i) => `${i === 0 && label !== '' ? label : blank}${line}`)
}

/**
 * One summary row: dim label in the gutter, value wrapped beside it.
 *
 * @param {string} label
 * @param {string} value
 * @param {number} width
 * @param {boolean} color
 * @returns {string[]}
 */
function labelled(label, value, width, color) {
  return gutter(paint(label.padEnd(LABEL_WIDTH), ANSI.dim, color), wrapToWidth(value, width))
}

/**
 * The daemon in one phrase. `installed`, `loaded` and `running` are three
 * booleans that only ever disagree in one direction that matters to a
 * reader - it is not running - so the summary reports the disagreement, not
 * the booleans. `--full` still prints all of them.
 *
 * `state` is included only when it is not `healthy`: a running daemon that
 * says `state=healthy` is saying `running` twice.
 *
 * @param {ServiceState | undefined} daemon
 * @returns {string}
 */
function summariseDaemonShort(daemon) {
  if (!daemon) return 'unknown'
  if (daemon.running) {
    const bits = []
    if (daemon.mode) bits.push(daemon.mode)
    if (daemon.pid) bits.push(`pid ${daemon.pid}`)
    if (daemon.state && daemon.state !== 'healthy') bits.push(daemon.state)
    return bits.length > 0 ? `running (${bits.join(', ')})` : 'running'
  }
  const base = daemon.installed ? 'installed, not running' : 'not installed'
  return daemon.error ? `${base} - ${daemon.error}` : base
}

/**
 * A picker source id (LLP 0188 #never-silent, the key `clientSync.localOnly`
 * is drawn from) whose source contribution uses a different name. Only
 * `otel` needs an entry: its picker id is `otel` but the plugin's own
 * source contribution is named `otlp`. Every other bare source's picker id
 * and source name already agree.
 *
 * @type {Record<string, string>}
 */
const SOURCE_PICKER_IDS = { otlp: 'otel' }

/**
 * Picker ids `clientSync.localOnly` can name that never surface as their
 * own `clients` or `sources` row: `raw-anthropic` / `raw-openai` are hidden
 * pickers whose events land under the shared `ai-gateway` source, so there
 * is no row to hang `(local only)` off of. Shared with `summariseData`,
 * which states the fact by count instead (LLP 0212 #never-silent).
 *
 * @param {HypAwareStatusReport} report
 * @returns {number}
 */
function unattributedLocalOnlyCount(report) {
  const localOnly = report.clientSync?.localOnly ?? []
  if (localOnly.length === 0) return 0
  const clientNames = new Set((report.clients ?? []).filter((c) => c.configured).map((c) => c.name))
  const sourcePickerIds = new Set(
    (report.sources ?? [])
      .filter((s) => s.name !== 'ai-gateway')
      .map((s) => SOURCE_PICKER_IDS[s.name] ?? s.name)
  )
  return localOnly.filter((id) => !clientNames.has(id) && !sourcePickerIds.has(id)).length
}

/**
 * What this machine collects, in the names the user picked it by.
 *
 * Clients carry their exceptions inline (`not attached`, `local only`) so
 * one client is one mention: the roster used to state a client's attach gap
 * in one section and its repair in another, and the reconciler ledger
 * restated it twice more. Sources that are not clients (OTEL, Hermes) are
 * appended, minus `ai-gateway` - the gateway is the plumbing behind every
 * client row, not a separate thing being captured. They carry the same
 * `local only` mark as a client would, resolved through
 * `SOURCE_PICKER_IDS` since a source's own name and its picker id are not
 * always the same string.
 *
 * @ref LLP 0188#never-silent [implements]: a local-only client is named where the client is named, never only in a list
 * @ref LLP 0212#never-silent [implements]: a local-only source with no row of its own is counted on the data row instead, via unattributedLocalOnlyCount
 *
 * @param {HypAwareStatusReport} report
 * @returns {string}
 */
function summariseCapture(report) {
  const clients = (report.clients ?? []).filter((c) => c.configured)
  const localOnly = new Set(report.clientSync?.localOnly ?? [])
  const parts = clients.map((c) => {
    const marks = []
    if (!c.attached) marks.push('not attached')
    if (localOnly.has(c.name)) marks.push('local only')
    const label = friendlyClientLabel(c.name)
    return marks.length > 0 ? `${label} (${marks.join(', ')})` : label
  })

  const named = new Set(clients.map((c) => c.name))
  for (const s of report.sources ?? []) {
    if (named.has(s.name) || s.name === 'ai-gateway') continue
    const marks = []
    if (s.state !== 'started') marks.push(s.state)
    if (localOnly.has(SOURCE_PICKER_IDS[s.name] ?? s.name)) marks.push('local only')
    const label = friendlyClientLabel(s.name)
    parts.push(marks.length > 0 ? `${label} (${marks.join(', ')})` : label)
  }

  if (parts.length === 0) {
    const sources = (report.sources ?? [])
      .filter((s) => s.name !== 'ai-gateway')
      .map((s) => friendlyClientLabel(s.name))
    return sources.length > 0 ? sources.join(', ') : 'nothing configured yet'
  }
  return parts.join(', ')
}

/**
 * Proof of capture, as opposed to the prediction of it every other row
 * makes. A client can be configured, attached and silent; rows landing is
 * the only line that says otherwise, and LLP 0164 already put the answer in
 * the daemon's status file at no query cost.
 *
 * Three surfaces at most - the question is "is anything arriving", and the
 * fourth-most-recent client does not change the answer.
 *
 * @ref LLP 0164#status-reads-it-from-the-status-file [implements]: the recent-entrypoint list is the summary's activity row
 *
 * @param {HypAwareStatusReport} report
 * @param {number} nowMs
 * @returns {string}
 */
function summariseActivity(report, nowMs) {
  const entries = report.recentEntrypoints ?? []
  if (entries.length === 0) return 'nothing recorded yet'
  const shown = entries.slice(0, 3)
  const parts = shown.map((e) => {
    const surface = e.clientName ? `${e.clientName}/${e.entrypoint}` : e.entrypoint
    return `${surface} ${formatEntrypointAge(e.lastSeen, nowMs)}`
  })
  if (entries.length > shown.length) parts.push(`+${entries.length - shown.length} more`)
  const rows = entries.reduce((sum, e) => sum + (Number.isFinite(e.rows) ? e.rows : 0), 0)
  return `${parts.join(' · ')} · ${formatCount(rows)} row${rows === 1 ? '' : 's'}`
}

/**
 * How much is stored, for how long, and whether any of it leaves.
 *
 * The destination is stated on every machine, in both directions: "stays on
 * this machine" is the claim a privacy-minded reader came to check, and an
 * absent line is not that claim. Withheld folders are appended whenever the
 * count is non-zero (LLP 0069 R9), and an `ask` folder policy whenever it is
 * not the default, since that is the setting that will interrupt a session.
 *
 * @ref LLP 0069#requirements [implements]: R9's withheld-directory count is stated on the default screen whenever it is non-zero
 * @ref LLP 0200#decision [implements]: the non-default new-folder mode is the one that gets said
 * @ref LLP 0106#enrolled-only [implements]: the new-folder ask only has stakes on an enrolled machine, so it is gated the same as `renderStatusFull`
 * @ref LLP 0212#never-silent [implements]: a local-only source with no `capture` row of its own is stated here by count
 *
 * @param {HypAwareStatusReport} report
 * @returns {string}
 */
function summariseData(report) {
  const bits = [
    formatBytesShort(report.cache?.totalBytes ?? 0),
    `${report.retention?.days ?? '?'}-day retention`,
    report.layered?.hasCentral ? 'syncing to org' : 'stays on this machine',
  ]
  const withheld = report.usagePolicy?.localOnlyDirCount ?? 0
  if (withheld > 0) bits.push(`${withheld} folder${withheld === 1 ? '' : 's'} withheld`)
  if (report.layered?.hasCentral && report.usagePolicy?.folderAsk === 'ask') bits.push('asking about new folders')
  const unattributedLocalOnly = unattributedLocalOnlyCount(report)
  if (unattributedLocalOnly > 0) bits.push(`${unattributedLocalOnly} local only`)
  return bits.join(' · ')
}

/**
 * What needs the reader, deduplicated and ordered by severity.
 *
 * Only conditional states appear: a diagnostic the collector raised, an
 * action the reconciler will not retry on its own (LLP 0186), a local config
 * entry the central layer dropped (LLP 0031), a live first-sync hold
 * (LLP 0100 R9), a rejected central config. A `pending` action is the
 * reconciler working, and a `done` one is a ledger entry; both stay in
 * `--full`.
 *
 * @ref LLP 0212#attention [implements]: one problem, one mention, with its repair attached
 * @ref LLP 0186#hyp-status-attention-needed-surface [implements]: refused is loud, with the re-arm command, on the default screen
 *
 * @param {HypAwareStatusReport} report
 * @returns {{ severity: 'error' | 'warning' | 'note', message: string, repair: string[] }[]}
 */
function collectAttention(report) {
  /** @type {{ severity: 'error' | 'warning' | 'note', message: string, repair: string[] }[]} */
  const items = []

  // The `kind` is a stable identifier for support and for grepping `--json`;
  // it is not what a person reads a warning for, and prefixing every line
  // with `client_attach_missing:` buries the sentence that says what broke.
  // `--full` still prints it.
  for (const d of report.diagnostics ?? []) {
    items.push({
      severity: d.severity === 'error' ? 'error' : 'warning',
      message: d.message,
      repair: [...d.repair],
    })
  }

  // A stopped daemon records nothing, and no collector diagnostic covers the
  // plain case (`daemon_loaded_no_pid` and `daemon_binary_missing` cover the
  // broken ones). Warning, not error: a machine mid-install is not degraded.
  if (report.daemon && !report.daemon.running) {
    items.push({
      severity: 'warning',
      message: 'the daemon is not running, so nothing is being recorded',
      repair: [report.daemon.installed ? 'hyp daemon start' : 'hyp daemon install'],
    })
  }

  for (const a of report.clientActions?.actions ?? []) {
    if (a.state === 'refused') {
      items.push({
        severity: 'warning',
        message: `${a.kind} ${a.requestKey} refused${a.reason ? `: ${a.reason}` : ''}`,
        repair: [`hyp attach ${a.requestKey} after fixing the cause`],
      })
    } else if (a.state === 'failed') {
      items.push({
        severity: 'warning',
        message: `${a.kind} ${a.requestKey} failed${a.reason ? `: ${a.reason}` : ''}`,
        repair: [],
      })
    }
  }

  // Wording matters more here than anywhere else on the screen. A collision
  // drop is about a duplicate *declaration* losing a merge, not about the
  // thing being off - and the commonest collision by far is
  // `@hypaware/ai-gateway`, which every enrolled machine that was set up
  // solo first carries, and without which nothing is recorded at all. So the
  // line has to say who configures it now, not merely that a local entry
  // "is not applied", which reads as "the gateway is not applied".
  for (const d of report.layered?.drops ?? []) {
    items.push({
      severity: 'note',
      message: d.reason === 'collides_with_central'
        ? `${d.key} is configured by your org, so your local ${d.section} entry for it is ignored`
        : `your local ${d.section} entry ${d.key} was dropped${
          d.detail ? ` (${d.detail.replace(/_/g, ' ')})` : ' (it made the merged config invalid)'
        }`,
      repair: [],
    })
  }
  if (report.layered?.centralQueryIgnored) {
    items.push({
      severity: 'note',
      message: 'the central config\'s query block is ignored (query is local-only)',
      repair: [],
    })
  }

  const badEtag = report.remoteConfig?.badEtag
  if (badEtag) {
    items.push({
      severity: 'note',
      message: `central config ${badEtag.etag} was rejected (${badEtag.reason})`,
      repair: [],
    })
  }

  if (report.firstSyncHoldDeadline !== null && report.firstSyncHoldDeadline !== undefined) {
    items.push({
      severity: 'note',
      message: `first sync is held until ${formatFirstSyncDeadline(report.firstSyncHoldDeadline)}`,
      repair: ['review with the hypaware-privacy skill, or hyp sync to send it now'],
    })
  }

  const rank = { error: 0, warning: 1, note: 2 }
  return items.sort((a, b) => rank[a.severity] - rank[b.severity])
}

/**
 * Human-readable age of a `recent clients` entry. Coarse on purpose: the
 * question the line answers is "was that just now, or last week?", and a
 * precise timestamp would invite reading the value as a query bound it is
 * not (the durable record is the cache). A future timestamp - a status file
 * written under a clock that has since gone backwards - reads as `just now`
 * rather than a negative age.
 *
 * @param {string} lastSeen ISO timestamp
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatEntrypointAge(lastSeen, nowMs = Date.now()) {
  const thenMs = Date.parse(lastSeen)
  if (Number.isNaN(thenMs)) return 'at an unreadable time'
  const deltaSec = Math.floor((nowMs - thenMs) / 1000)
  if (deltaSec < 60) return 'just now'
  const minutes = Math.floor(deltaSec / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Per-entry layer provenance tag for `hyp status` text. Empty on a host
 * that never joined (no central layer → the V1 surface is unchanged);
 * otherwise `[central · locked]` for entries the central layer owns and
 * `[local]` for the user's additive entries. Used for plugin, source,
 * sink, and client lines. Sources and clients inherit their owning
 * plugin's layer.
 *
 * @param {HypAwareStatusReport['layered']} layered
 * @param {boolean} isCentral
 * @returns {string}
 * @ref LLP 0031#status-provenance [implements]: every active plugin/source/sink/client line tagged central·locked or local
 */
function provenanceTag(layered, isCentral) {
  if (!layered) return ''
  return isCentral ? '  [central · locked]' : '  [local]'
}

/**
 * @param {HypAwareStatusReport['layered']} layered
 * @param {string} plugin
 * @returns {boolean}
 */
function isCentralPlugin(layered, plugin) {
  return !!layered && layered.centralPlugins.includes(plugin)
}

/**
 * @param {HypAwareStatusReport['layered']} layered
 * @param {string} instance
 * @returns {boolean}
 */
function isCentralSink(layered, instance) {
  return !!layered && layered.centralSinks.includes(instance)
}

/**
 * @param {ServiceState} daemon
 */
function describeDaemon(daemon) {
  const parts = []
  parts.push(daemon.installed ? 'installed' : 'not installed')
  if (daemon.installed) parts.push(daemon.loaded ? 'loaded' : 'not loaded')
  parts.push(daemon.running ? 'running' : 'not running')
  if (daemon.state) parts.push(`state=${daemon.state}`)
  if (daemon.pid) parts.push(`pid=${daemon.pid}`)
  if (daemon.mode) parts.push(`mode=${daemon.mode}`)
  if (daemon.error) parts.push(`error=${daemon.error}`)
  return parts.join(', ')
}

/**
 * @param {CommandRunContext['capabilities']} capabilities
 * @returns {string[]}
 */
function listClientNames(capabilities) {
  if (!capabilities.has('hypaware.ai-gateway')) return []
  /** @type {AiGatewayCapability} */
  const gateway = capabilities.require('hyp-core/status', 'hypaware.ai-gateway', '^2.0.0')
  return gateway.listClients().map((c) => c.name).sort()
}

/**
 * `hyp status` intentionally avoids activating configured plugins so
 * the command does not bind local listeners just to render a report.
 * When no live query registry exists, infer the V1 bundled datasets
 * from the config-backed active plugin set.
 *
 * @param {string[]} activePlugins
 * @returns {{ name: string, plugin: string }[]}
 */
function inferDatasetsFromPlugins(activePlugins) {
  const active = new Set(activePlugins)
  /** @type {{ name: string, plugin: string }[]} */
  const datasets = []
  if (active.has('@hypaware/ai-gateway')) {
    datasets.push({ name: 'ai_gateway_messages', plugin: '@hypaware/ai-gateway' })
  }
  if (active.has('@hypaware/otel')) {
    datasets.push(
      { name: 'logs', plugin: '@hypaware/otel' },
      { name: 'metrics', plugin: '@hypaware/otel' },
      { name: 'traces', plugin: '@hypaware/otel' }
    )
  }
  return datasets.sort((a, b) => a.name.localeCompare(b.name))
}
