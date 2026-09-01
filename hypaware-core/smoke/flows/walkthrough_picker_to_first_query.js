// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { discoverBundledPlugins } from '../../../src/core/runtime/bundled.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { requireAiGatewayRuntime } from '../../plugins-workspace/ai-gateway/src/runtime.js'

/**
 * @import { AiGatewayCapability } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Phase 5 V1-milestone smoke. Drives `hyp setup --yes --client claude
 * --client codex --client opencode --source otel --export local-parquet
 * --retention-days 30 --dry-run --bin <stable-bin>` end-to-end against a
 * tmp HYP_HOME with all seven first-party plugins active (ai-gateway,
 * otel, local-fs, format-parquet, claude, codex, opencode). Then exercises the resulting
 * install just like Phase 9 did so the `walkthrough_picker_to_first_query`
 * bead's full assertion list lands.
 *
 * Assertions (per bead hy-5oz4):
 *
 * - Non-interactive picker selections generate a config matching the
 *   expected v2 shape (both AI upstreams, OTEL, Parquet sink), plus the
 *   riders those picks pull in (LLP 0213 #d1): the written config is wider
 *   than the seven plugins this smoke activates by injection.
 * - Dry-run daemon install chooses the stable binary path passed via
 *   `--bin <stable-bin>` and outputs a sensible target path.
 * - Claude + Codex + OpenCode attach dry-runs produce expected file edits
 *   *without* touching the per-client settings/config files under the tmp HOME.
 * - One OTLP log POST + one gateway exchange each round-trip through
 *   the running sources with `dev_run_id` preserved.
 * - SQL count(*) on both `logs` and `ai_gateway_messages` returns 1
 *   under the same `dev_run_id`.
 * - The wizard pick-phase span contract (`wizard.pick.start`,
 *   `wizard.pick.write_config`, `daemon.install`, `client.attach`,
 *   `skills.install`, `wizard.pick.finish`) is honored (`hyp setup` routes
 *   through `runInitWizard` -> `runWizardPick` now, LLP 0135).
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'walkthrough_picker_to_first_query: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const echo = await startEchoUpstream()

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = {
    aiGateway: path.join(pluginsRoot, 'ai-gateway'),
    otel: path.join(pluginsRoot, 'otel'),
    localFs: path.join(pluginsRoot, 'local-fs'),
    parquet: path.join(pluginsRoot, 'format-parquet'),
    claude: path.join(pluginsRoot, 'claude'),
    codex: path.join(pluginsRoot, 'codex'),
    opencode: path.join(pluginsRoot, 'opencode'),
  }

  // Same recipe as gateway_claude_capture: a distinct name so the merge
  // in source.js does not collapse this entry into the Claude plugin's
  // contributed anthropic preset (which would swap the base_url for
  // api.anthropic.com), with a priority that wins routing over it. The
  // claude projector still matches on path + headers, so the exchange
  // projects into ai_gateway_messages.
  const aiGatewayConfig = {
    listen: '127.0.0.1:0',
    upstreams: [
      {
        name: 'echo-anthropic',
        base_url: echo.url,
        path_prefix: '/v1/messages',
        priority: 1000,
      },
    ],
  }
  const otelConfig = { listen_host: '127.0.0.1', listen_port: 0 }

  const fakeHome = path.join(harness.tmpDir, 'home')
  await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true })
  await fs.mkdir(path.join(fakeHome, '.codex'), { recursive: true })
  const previousHome = process.env.HOME
  process.env.HOME = fakeHome
  // Redirecting HOME is not enough to sandbox OpenCode. `resolveClientSettingsPath`
  // relocates the `.config/opencode` prefix to `$XDG_CONFIG_HOME/opencode` when
  // that variable is set, and it is an absolute path that HOME does not move, so
  // an inherited one sends this run's attach at the developer's real config home:
  // the assertions below then compare against a path the run never touched, and
  // the smoke reds on a machine where nothing is wrong.
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = path.join(fakeHome, '.config')
  // Pin the version the LLP 0258 floor check sees, so the init-driven attach
  // never depends on whatever `claude` binary the machine running it carries.
  const previousClaudeVersion = process.env.HYP_CLAUDE_CODE_VERSION
  process.env.HYP_CLAUDE_CODE_VERSION = '2.1.233'

  // Pre-existing settings files would let us detect that dry-runs do
  // not modify them. Seed harmless baselines and snapshot them.
  const claudeSettingsPath = path.join(fakeHome, '.claude', 'settings.json')
  const codexConfigPath = path.join(fakeHome, '.codex', 'config.toml')
  await fs.writeFile(claudeSettingsPath, JSON.stringify({ _baseline: true }, null, 2) + '\n', 'utf8')
  await fs.writeFile(codexConfigPath, '# baseline codex config\n', 'utf8')
  const claudeBaseline = await fs.readFile(claudeSettingsPath, 'utf8')
  const codexBaseline = await fs.readFile(codexConfigPath, 'utf8')

  const stableBinPath = path.join(harness.tmpDir, 'stable', 'hypaware-bin', 'hypaware')

  /**
   * Activate the seven workspace plugins with the smoke's injected
   * ai-gateway (echo upstream) and otel (ephemeral port) configs.
   * Called once for the init phase and again into a fresh kernel for
   * the capture phase: init's finale boots the bundled plugins from
   * the picker-written config, which repoints the ai-gateway runtime
   * module singleton away from the echo upstream.
   *
   * @param {ReturnType<typeof createKernelRuntime>} targetKernel
   * @param {string} smokeStep
   */
  async function activateInjectedPlugins(targetKernel, smokeStep) {
    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: smokeStep,
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests(Object.values(pluginDirs))
        if (loaded.length !== 7) {
          throw new Error(
            `walkthrough_picker_to_first_query: expected 7 manifests loaded, got ${loaded.length}`
          )
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `walkthrough_picker_to_first_query: unsatisfied requirements: ${
              resolution.unsatisfied.map((u) => `${u.plugin}:${u.errorKind}`).join(', ')
            }`
          )
        }
        const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
        const entries = resolution.order
          .map((name) => byName.get(name))
          .filter((l) => l !== undefined)
          .map((l) => ({
            manifest: l.manifest,
            rootDir: l.rootDir,
            config:
              l.manifest.name === '@hypaware/ai-gateway' ? aiGatewayConfig
              : l.manifest.name === '@hypaware/otel'      ? otelConfig
              : {},
          }))
        return activatePlugins({
          plugins: entries,
          stateRoot: harness.stateDir,
          runId: harness.devRunId,
          runtime: targetKernel,
          tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
        })
      }
    )
  }

  try {
    await activateInjectedPlugins(kernel, 'picker_activate')

    // ----- 1. hyp setup via Phase 5 flags -----
    const initStdout = makeBuf()
    const initStderr = makeBuf()
    const initCode = await dispatch(
      [
        'setup',
        '--yes',
        '--client', 'claude',
        '--client', 'codex',
        '--client', 'opencode',
        '--source', 'claude',
        '--source', 'codex',
        '--source', 'opencode',
        '--source', 'otel',
        '--export', 'local-parquet',
        '--retention-days', '30',
        '--dry-run',
        '--bin', stableBinPath,
      ],
      {
        stdout: initStdout,
        stderr: initStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: hyp setup Phase 5 flags exited 0', initCode, (v) => v === 0)
    expect.that(
      'stderr: hyp setup had no errors',
      initStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )

    const initText = initStdout.text()

    // Assert daemon install dry-run picked up the stable binary path.
    expect.that(
      'stdout: dry-run daemon install referenced the stable binary path',
      initText,
      (v) => typeof v === 'string' && v.includes(stableBinPath)
    )

    // Assert client attach dry-runs printed the per-client paths.
    expect.that(
      'stdout: dry-run claude attach referenced ~/.claude/settings.json',
      initText,
      (v) =>
        typeof v === 'string' &&
        v.includes(claudeSettingsPath) &&
        v.includes('(dry-run) Would attach Claude')
    )
    expect.that(
      'stdout: dry-run codex attach referenced ~/.codex/config.toml',
      initText,
      (v) =>
        typeof v === 'string' &&
        v.includes(codexConfigPath) &&
        v.includes('(dry-run) Would attach Codex')
    )
    const opencodePluginPath = path.join(fakeHome, '.config', 'opencode', 'plugins', 'hypaware.js')
    expect.that(
      'stdout: dry-run opencode attach referenced the shared CLI/Desktop plugin path',
      initText,
      (v) =>
        typeof v === 'string' &&
        v.includes(opencodePluginPath) &&
        v.includes('Would install') &&
        v.includes('Dry run: nothing was written.')
    )

    // ----- 2. Config written matches Phase 5 shape -----
    const configPath = defaultConfigPath(harness.hypHome)
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'))
    const expected = await goldenPickerConfig(harness.hypHome)
    expect.that(
      'config: Phase 5 picker config matches expected shape',
      written,
      (v) => deepEqual(v, expected)
    )

    // ----- 3. Dry-run did not touch real per-client files -----
    const claudeAfter = await fs.readFile(claudeSettingsPath, 'utf8')
    const codexAfter = await fs.readFile(codexConfigPath, 'utf8')
    expect.that(
      'dry-run preserved tmp HOME/.claude/settings.json',
      claudeAfter,
      (v) => v === claudeBaseline
    )
    expect.that(
      'dry-run preserved tmp HOME/.codex/config.toml',
      codexAfter,
      (v) => v === codexBaseline
    )
    expect.that(
      'dry-run did not create the OpenCode managed plugin',
      await fs.stat(opencodePluginPath).then(() => true, () => false),
      (v) => v === false
    )

    // ----- 4. Start the sources and exercise both ingest paths -----
    // Fresh kernel + re-activation: the init dispatches above booted the
    // bundled plugins from the picker-written config, so the ai-gateway
    // runtime singleton no longer points at the injected echo upstream.
    const captureRegistry = createCommandRegistry()
    registerCoreCommands(captureRegistry)
    const captureKernel = createKernelRuntime({ commandRegistry: captureRegistry, cacheRoot })
    await activateInjectedPlugins(captureKernel, 'capture_activate')

    const otelStarted = captureKernel.sources.started('otlp')
    if (!otelStarted) {
      throw new Error('walkthrough_picker_to_first_query: source `otlp` not started after activate')
    }
    const otelStatus = await /** @type {NonNullable<typeof otelStarted.status>} */ (otelStarted.status)()
    const otelDetails = /** @type {{ listen_host?: string, listen_port?: number }} */ (otelStatus.details ?? {})
    if (typeof otelDetails.listen_host !== 'string' || typeof otelDetails.listen_port !== 'number') {
      throw new Error(
        `walkthrough_picker_to_first_query: expected listen_host/listen_port in OTLP source details, got ${JSON.stringify(otelStatus.details)}`
      )
    }

    const runtime = requireAiGatewayRuntime()
    await captureKernel.sources.start('ai-gateway', runtime.ctx)
    runtime.started = true

    /** @type {AiGatewayCapability} */
    const gatewayApi = captureKernel.capabilities.require(
      '@smoke/walkthrough-picker',
      'hypaware.ai-gateway',
      '^2.0.0'
    )
    const gatewayUrl = gatewayApi.localEndpoint()

    const otlpPayload = buildOtlpLogPayload(harness.devRunId)
    const otlpResponse = await fetch(
      `http://${otelDetails.listen_host}:${otelDetails.listen_port}/v1/logs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(otlpPayload),
      }
    )
    expect.that('otlp POST: server returned 200', otlpResponse.status, (v) => v === 200)
    await otlpResponse.text()

    const gatewayBody = JSON.stringify({
      model: 'claude-picker',
      messages: [{ role: 'user', content: `picker ${harness.devRunId}` }],
    })
    const gatewayResponse = await postThroughGateway({
      url: `${gatewayUrl}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-hyp-dev-run-id': harness.devRunId,
      },
      body: gatewayBody,
    })
    expect.that(
      'gateway: response status 200 from echo upstream',
      gatewayResponse.statusCode,
      (v) => v === 200
    )

    await captureKernel.sources.stop('ai-gateway')

    // ----- 5. SQL assertions on both datasets -----
    const sql = `
      select 'logs' as dataset, count(*) as n from logs
        where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'
      union all
      select 'ai_gateway_messages' as dataset, count(*) as n from ai_gateway_messages
        where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'
    `.trim().replace(/\s+/g, ' ')

    const sqlStdout = makeBuf()
    const sqlStderr = makeBuf()
    const sqlCode = await dispatch(
      ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
      {
        stdout: sqlStdout,
        stderr: sqlStderr,
        kernel: captureKernel,
        registry: captureRegistry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: query sql exited 0', sqlCode, (v) => v === 0)
    expect.that(
      'stderr: query sql had no errors',
      sqlStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )

    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(sqlStdout.text())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect.that(
        `stdout: query sql JSON parse failed (${message})`,
        false,
        (v) => v === true
      )
    }
    const rows = Array.isArray(parsed) ? parsed : []
    expect.that(
      'sql: both rows present (logs + ai_gateway_messages)',
      rows.map((/** @type {any} */ r) => r.dataset).sort(),
      (v) => Array.isArray(v) && v.join(',') === 'ai_gateway_messages,logs'
    )
    const logsRow = rows.find((/** @type {any} */ r) => r.dataset === 'logs')
    const aigwRow = rows.find((/** @type {any} */ r) => r.dataset === 'ai_gateway_messages')
    expect.that(
      'sql: logs has exactly one row for this dev_run_id',
      Number(logsRow?.n ?? 0),
      (v) => v === 1
    )
    // One projected exchange = two message rows (user + assistant).
    expect.that(
      'sql: ai_gateway_messages has the projected user+assistant rows for this dev_run_id',
      Number(aigwRow?.n ?? 0),
      (v) => v === 2
    )

    // ----- 6. Real attach during init uses the configured gateway port -----
    // Runs after the capture + SQL phase: init re-boots the kernel from
    // the picker-written config (post-attach one-shot re-boot), which
    // replaces this smoke's injected echo upstream, so the echo
    // round-trip must complete first. The dry-run above already wrote
    // the config, and init refuses to overwrite an existing config
    // without --force (LLP 0129).
    const realInitStdout = makeBuf()
    const realInitStderr = makeBuf()
    const realInitCode = await dispatch(
      [
        'setup',
        '--yes',
        '--force',
        '--source', 'claude',
        '--export', 'keep-local',
        '--retention-days', '30',
        '--no-daemon',
        '--bin', stableBinPath,
      ],
      {
        stdout: realInitStdout,
        stderr: realInitStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: real hyp setup attach exited 0', realInitCode, (v) => v === 0)
    expect.that(
      'stderr: real hyp setup attach had no errors',
      realInitStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )
    // The picker writes no `listen`, so the port the client is wired to is the
    // fixed default the daemon's gateway will bind, not a wizard-pinned one.
    // @ref LLP 0114#fixed-default-port [tests]: a wizard-created install attaches at the well-known default
    const realClaudeSettings = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8'))
    expect.that(
      'real init attach: claude marker uses the default gateway port',
      realClaudeSettings?._hypaware?.port,
      (v) => v === 18521
    )
    // `otel` attach (LLP 0258): the telemetry block is written and the base
    // URL is not; the marker's port above is what carries the gateway
    // endpoint for the drift check.
    expect.that(
      'real init attach: the telemetry endpoint points at the loopback listener',
      realClaudeSettings?.env?.OTEL_EXPORTER_OTLP_ENDPOINT,
      (v) => typeof v === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(v)
    )
    expect.that(
      'real init attach: no base URL was written (mode=otel)',
      realClaudeSettings,
      (v) =>
        v?._hypaware?.mode === 'otel' &&
        !Object.hasOwn(v?.env ?? {}, 'ANTHROPIC_BASE_URL')
    )

    // ----- 7. Span + log assertions -----
    await obs.shutdown()

    const traces = await expect.traces()

    const startSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'wizard.pick.start'
    )
    // 9 bundled picker rows: claude, codex, opencode, claude-desktop,
    // openclaw, hermes, raw-anthropic, raw-openai, otel.
    expect.that(
      'traces: wizard.pick.start span emitted with sources_available=9',
      startSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.sources_available === 9
    )

    const writeSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'wizard.pick.write_config'
    )
    expect.that(
      'traces: wizard.pick.write_config span emitted with plugin_count',
      writeSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        typeof v.plugin_count === 'number' &&
        v.plugin_count >= 4 &&
        typeof v.config_path === 'string'
    )

    const finishSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'wizard.pick.finish'
    )
    expect.that(
      'traces: wizard.pick.finish span has Phase 5 picks counts',
      finishSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.sources_picked === 4 &&
        v.export_picked === 'local-parquet' &&
        v.clients_picked === 3 &&
        v.retention_days === 30
    )

    const daemonInstallSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'daemon.install'
    )
    expect.that(
      'traces: daemon.install span emitted with dry_run=true + stable bin path',
      daemonInstallSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.dry_run === true &&
        v.bin_path === stableBinPath
    )

    const attachSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'client.attach'
    )
    const dryRunAttachSpans = attachSpans.filter(
      (/** @type {any} */ s) => s.attributes?.dry_run === true
    )
    const attachClients = new Set(
      dryRunAttachSpans.map((/** @type {any} */ s) => s.attributes?.client_name).filter(Boolean)
    )
    expect.that(
      'traces: client.attach span emitted for claude, codex, and opencode (dry-run)',
      attachClients,
      (v) => v instanceof Set && v.has('claude') && v.has('codex') && v.has('opencode')
    )
    expect.that(
      'traces: client.attach dry_run=true for all three clients',
      dryRunAttachSpans.length >= 3 &&
        dryRunAttachSpans.every((/** @type {any} */ s) => s.attributes?.dry_run === true),
      (v) => v === true
    )
    expect.that(
      'traces: real init emitted non-dry-run claude attach span',
      attachSpans.some(
        (/** @type {any} */ s) =>
          s.attributes?.client_name === 'claude' && s.attributes?.dry_run === false
      ),
      (v) => v === true
    )

    const skillsInstallSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'skills.install'
    )
    expect.that(
      'traces: skills.install span emitted with dry_run=true',
      skillsInstallSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.dry_run === true &&
        typeof v.installed_count === 'number' &&
        v.installed_count >= 1
    )

    const logs = await expect.logs()
    const pickLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'wizard.pick'
    )
    const pickTypes = new Set(pickLogs.map((/** @type {any} */ l) => l.attributes?.pick_type))
    expect.that(
      'logs: wizard.pick emitted for sources AND exports',
      pickTypes,
      (v) => v instanceof Set && v.has('sources') && v.has('exports')
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    if (previousClaudeVersion === undefined) delete process.env.HYP_CLAUDE_CODE_VERSION
    else process.env.HYP_CLAUDE_CODE_VERSION = previousClaudeVersion
    await echo.close()
  }
}

/**
 * Bundled plugins that ride the composed picks rather than being picked:
 * a manifest whose `compose_with` names plugins that are, transitively,
 * already composed (picked, or riders composed in an earlier pass) is
 * written into the config with no picker row and no prompt
 * ([LLP 0213 #d1](../../../llp/0213-graph-plugin-always-active.decision.md)).
 *
 * Derived from the manifests instead of restated by name, because a literal
 * list here is a second copy of a declaration that lives in the plugins: the
 * next derived-data plugin would re-red this smoke for correctly doing what
 * its manifest asks. What the golden keeps literal is what the *picker*
 * decides (which rows compose, the upstreams, the OTLP port, the sink shape,
 * retention); a rider is decided by the plugin, so it is read from there.
 *
 * Run to a fixpoint, mirroring `ridersFor`: a rider whose `compose_with`
 * names another rider (rather than a picked plugin) still lands, so the
 * golden does not go stale the moment a rider rides a rider.
 *
 * This deliberately does not call `composePickerConfig` or `ridersFor`: an
 * expectation that runs the code under test asserts nothing. It reads the
 * declarations and applies the rule to the literal picked set below, so a
 * plugin appearing in the config that is neither picked nor declared as a
 * rider still fails the assertion. The rider *mechanism* (fixpoint, the
 * unmet-condition case, reconfigure) is unit-tested in
 * `test/core/compose-picker-config.test.js`.
 *
 * Reading only `loaded` keeps the default-activation boundary without
 * restating it: it agrees with the cut `ridersInDefaultSet` makes, because
 * the allowlist and the excluded set are disjoint, so nothing in `loaded` is
 * something that filter drops. A plugin in neither list is invisible to both
 * sides: it is not in `loaded`, and `loadPickerCatalog` reads only those two
 * buckets. It is disjointness, not coverage, that does the work here: the
 * union can span the whole bundled workspace while a name sits in both sets,
 * and `discoverBundledPlugins` checks the allowlist before the exclude set,
 * so that name stays in `loaded`. For a rider that is a live disagreement:
 * this function composes it into the golden while `ridersInDefaultSet` drops
 * it from what the install writes. A name that declares no `compose_with`
 * never reaches that filter, so the two reads here still agree and this
 * smoke stays green; `computeSelectedPlugins` (src/core/runtime/boot.js) is
 * where an overlap bites in that case.
 * `test/core/bundled-sets.test.js` guards the disjointness.
 *
 * @param {string[]} picked  plugin names the picker composed from its rows
 * @returns {Promise<string[]>}
 * @ref LLP 0213#d1 [tests]: the graph pair reaches a default install by riding the gateway pick, asserted by declaration rather than by name
 */
async function composedRiders(picked) {
  const { loaded } = await discoverBundledPlugins()
  const present = new Set(picked)
  /** @type {string[]} */
  const riders = []
  let grew = true
  while (grew) {
    grew = false
    for (const { manifest } of loaded) {
      const waitsFor = manifest.compose_with
      if (!Array.isArray(waitsFor) || waitsFor.length === 0) continue
      if (present.has(manifest.name)) continue
      if (!waitsFor.every((name) => present.has(name))) continue
      present.add(manifest.name)
      riders.push(manifest.name)
      grew = true
    }
  }
  return riders
}

/**
 * @param {string} hypHome
 */
async function goldenPickerConfig(hypHome) {
  /** @type {{ name: string, config?: unknown }[]} */
  const plugins = [
    {
      name: '@hypaware/ai-gateway',
      config: {
        upstreams: [
          { name: 'openai', base_url: 'https://api.openai.com', path_prefix: '/v1', provider: 'openai' },
          { name: 'chatgpt', base_url: 'https://chatgpt.com', path_prefix: '/backend-api/codex', provider: 'chatgpt' },
        ],
        // No `proxy_mode`: no bundled picker row declares proxy attach since
        // the claude client went otel-only, so the wizard composes a gateway
        // that mints no CA.
        // @ref LLP 0262#requirements [tests]: R5 - a composed claude install needs no CA and no keychain trust
      },
    },
    // Ahead of otel: opencode is a first-class client row, and
    // `PICKER_DISPLAY_ORDER` puts those before the infra receivers.
    { name: '@hypaware/opencode' },
    {
      name: '@hypaware/otel',
      config: { listen_host: '127.0.0.1', listen_port: 4318 },
    },
    { name: '@hypaware/local-fs' },
    { name: '@hypaware/format-parquet' },
    { name: '@hypaware/claude' },
    {
      name: '@hypaware/codex',
      config: { proxy: '@hypaware/ai-gateway' },
    },
  ]

  // Riders land after every picked plugin, in the order the composer folds
  // them: `composePickerConfig` appends them last, once the picks are settled.
  for (const rider of await composedRiders(plugins.map((p) => p.name))) {
    plugins.push({ name: rider })
  }

  return {
    version: 2,
    plugins,
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: {
          dir: path.join(hypHome, 'exports'),
          schedule: '*/5 * * * *',
        },
      },
    },
    query: {
      cache: {
        retention: { default_days: 30 },
      },
    },
  }
}

/**
 * @param {string} runId
 */
function buildOtlpLogPayload(runId) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'picker-smoke' } }] },
        scopeLogs: [
          {
            scope: { name: 'walkthrough_picker_to_first_query' },
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                body: { stringValue: 'picker smoke log row' },
                attributes: [{ key: 'dev_run_id', value: { stringValue: runId } }],
                severityNumber: 9,
                severityText: 'INFO',
              },
            ],
          },
        ],
      },
    ],
  }
}

async function startEchoUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = /** @type {Buffer[]} */ ([])
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      Buffer.concat(chunks)
      // Anthropic-shaped response so the claude plugin's projector
      // matches and projects the exchange into ai_gateway_messages.
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'msg_smoke_echo',
          type: 'message',
          role: 'assistant',
          model: 'claude-picker',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      )
    })
  })
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = /** @type {{ address: string, port: number }} */ (server.address())
  return {
    url: `http://${address.address}:${address.port}`,
    close: () => new Promise((res) => server.close(() => res(undefined))),
  }
}

/**
 * @param {{ url: string, headers: Record<string, string>, body: string }} req
 */
function postThroughGateway(req) {
  return new Promise((resolve, reject) => {
    const u = new URL(req.url)
    const r = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: req.headers,
      },
      (res) => {
        const chunks = /** @type {Buffer[]} */ ([])
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      }
    )
    r.on('error', reject)
    r.write(req.body)
    r.end()
  })
}

/**
 * @param {{ hypHome: string }} harness
 */
function smokeEnv(harness) {
  return { ...process.env, HYP_HOME: harness.hypHome }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== /** @type {unknown[]} */ (b).length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], /** @type {unknown[]} */ (b)[i])) return false
    }
    return true
  }
  const ak = Object.keys(/** @type {object} */ (a))
  const bk = Object.keys(/** @type {object} */ (b))
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!bk.includes(k)) return false
    if (!deepEqual(
      /** @type {Record<string, unknown>} */ (a)[k],
      /** @type {Record<string, unknown>} */ (b)[k]
    )) return false
  }
  return true
}
