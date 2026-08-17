// @ts-check

import { Attr, withSpan } from '../observability/index.js'
import { collectHypAwareStatus } from '../daemon/status.js'
import { ENV_VAR_NAME } from '../daemon/launchd_env.js'
import { formatFirstSyncDeadline } from '../usage-policy/first_sync_hold.js'

/**
 * @import { AiGatewayCapability, CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { HypAwareStatusReport, ServiceState } from '../../../src/core/daemon/types.js'
 * @import { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../../../src/core/registry/types.js'
 */

/**
 * `hyp status [--json]`
 *
 * Renders the V1 install state (config path, daemon install/run
 * state, active plugins, source/sink/client status, cache + retention
 * window, recent error count) and any diagnostics + repair
 * suggestions surfaced by the Phase 8 collector.
 *
 * Span: `status.render`. Attributes match the bead contract
 * (`source_count`, `sink_count`, `cache_size_bytes`,
 * `oldest_partition_date`, `daemon_state`, `diagnostics_count`) and
 * also carry the legacy attributes (`client_count`, `retention_days`)
 * that earlier smokes assert on.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runStatus(argv, ctx) {
  const json = argv.includes('--json')

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
      format: json ? 'json' : 'text',
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
      renderStatusText({
        report,
        clientNames,
        datasets,
        cacheRoot: ctx.storage.cacheRoot,
        stdout: ctx.stdout,
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
    // Proxy-mode trust (LLP 0237 / LLP 0239). Additive: the key is emitted on
    // every platform, and is `null` wherever the question does not apply (not
    // darwin, or no CA), following this renderer's null-not-omitted contract
    // rather than leaving an ordinary install's payload byte-identical to V1.
    // `ca_trusted` / `launchd_env_set` are tri-state: `null` means the probe
    // could not run, which a consumer must not read as "not trusted".
    // @ref LLP 0237#consequences [implements]: --json carries the trust state next to the CA fingerprint
    // @ref LLP 0238#consequences [implements]: and the full permitted host set the grant covers
    proxy_trust: report.proxyTrust
      ? {
        ca_fingerprint: report.proxyTrust.caFingerprint,
        permitted_hosts: report.proxyTrust.hosts,
        ca_trusted: report.proxyTrust.trusted,
        launchd_env_set: report.proxyTrust.launchdEnvSet,
      }
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
 * Render the V1 status report as human-friendly text. Mirrors the
 * JSON shape but groups sections and surfaces diagnostics + repair
 * suggestions at the bottom.
 *
 * @param {{
 *   report: HypAwareStatusReport,
 *   clientNames: string[],
 *   datasets: { name: string, plugin: string }[],
 *   cacheRoot: string,
 *   stdout: { write(chunk: string): unknown },
 * }} args
 */
export function renderStatusText({ report, clientNames, datasets, cacheRoot, stdout }) {
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

  // Proxy mode's two invisible preconditions (LLP 0237, LLP 0239). Rendered
  // only where the question applies - macOS with a CA on disk - so an ordinary
  // install's text output is unchanged and a Linux host is never told about a
  // keychain it does not have. This is the line that answers "the password
  // dialog was cancelled last month" and "the CA was re-minted and the
  // keychain still trusts the old one", neither of which any other line here
  // can be read for.
  //
  // The permitted hosts are named here and not only in the attach dialog: the
  // grant covers every provider host the product can intercept, so on an
  // install that captures Claude alone it is wider than anything the config
  // shows, and after attach this is the only place it can be re-read.
  // @ref LLP 0237#consequences [implements]: the trust state is reported next to the CA fingerprint, so a cancelled dialog is diagnosable without re-running attach
  // @ref LLP 0238#consequences [implements]: hyp status names all permitted hosts, so the standing grant stays informed and not just the moment it was asked for
  // @ref LLP 0239#terminals-predating-attach [implements]: and next to it, whether the launchd environment carries the variable
  if (report.proxyTrust) {
    stdout.write('  proxy trust:\n')
    stdout.write(`    ca fingerprint: ${report.proxyTrust.caFingerprint}\n`)
    stdout.write(`    permitted:      ${describePermittedHosts(report.proxyTrust.hosts)}\n`)
    stdout.write(`    login keychain: ${describeCaTrust(report.proxyTrust.trusted)}\n`)
    stdout.write(`    launchd env:    ${describeLaunchdEnv(report.proxyTrust.launchdEnvSet)}\n`)
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

/**
 * The keychain half of the `proxy trust` block. An untrusted CA carries the
 * repair with it because the repair is one command and the state is otherwise
 * silent: capture keeps working, so nothing else in the report will ever
 * mention it (LLP 0237#attach-anyway-on-refusal). `null` is a probe that could
 * not run, which is a different answer from "not trusted" and says so.
 *
 * @param {boolean | null} trusted
 * @returns {string}
 */
function describeCaTrust(trusted) {
  if (trusted === true) return 'trusted'
  if (trusted === false) {
    return 'not trusted - Remote Control inbound will not work, run `hyp attach claude` to retry'
  }
  return 'unknown - the keychain probe could not run'
}

/**
 * The host set the trust grant covers. Printed as the certificate's own
 * permitted subtrees, in the order the DER carries them, so the line is the
 * grant rather than a restatement of the configured providers.
 *
 * An empty set is not "no hosts": a CA carrying no `dNSName` constraint at
 * all can vouch for anything, which is the one reading the user most needs,
 * so it is named rather than rendered as a blank line. HypAware's own mint
 * never produces one (LLP 0238#full-provider-constraints), so this arm only
 * fires for a foreign or damaged certificate at the CA path.
 *
 * @param {string[]} hosts
 * @returns {string}
 */
function describePermittedHosts(hosts) {
  if (hosts.length === 0) return 'no dNSName constraints found - this CA is not host-limited'
  return hosts.join(', ')
}

/**
 * The launchd half of the `proxy trust` block. Same tri-state, same reason.
 *
 * @param {boolean | null} set
 * @returns {string}
 */
function describeLaunchdEnv(set) {
  if (set === true) return `${ENV_VAR_NAME}=1 set`
  if (set === false) return `${ENV_VAR_NAME} not set - run \`hyp attach claude\` to set it`
  return 'unknown - the launchctl probe could not run'
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
