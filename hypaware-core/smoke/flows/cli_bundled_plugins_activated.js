// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { installObservability } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import {
  V1_BUNDLED_PLUGIN_ALLOWLIST,
  V1_EXCLUDED_FROM_DEFAULT,
  discoverBundledPlugins,
} from '../../../src/core/runtime/bundled.js'

/**
 * Phase 2 V1 smoke (finish-v1.md §Phase 2). Drives the unified
 * `bootKernel` path through the dispatcher under a temp HYP_HOME and
 * asserts the four bead acceptance criteria:
 *
 *  1. `hyp plugin list` shows active bundled plugins from the
 *     generated config (both text and `--json` form).
 *  2. `hyp client attach claude --dry-run` reaches the Claude
 *     adapter (the adapter's own `client.attach` span fires with
 *     `dry_run=true` and the dry-run banner lands on stdout).
 *  3. `hyp client attach codex --dry-run` reaches the Codex adapter
 *     (same shape), and `hyp client attach openclaw --dry-run`
 *     reaches the OpenClaw adapter against a seeded OPENCLAW_HOME.
 *  4. `hyp status --json` emits a stable JSON document listing the
 *     configured sources, sinks, clients, and active plugins. This
 *     config names none of `V1_EXCLUDED_FROM_DEFAULT`, so no member of
 *     that set may appear: they are excluded from default activation
 *     but remain discoverable through the plugin catalog and
 *     activatable via explicit config or init presets.
 *
 * Telemetry contract (per bead):
 *  - One `kernel.boot` root span per dispatch boot.
 *  - One `plugin.activate` child span per active plugin per boot.
 *  - One `plugin.skipped` log row per bundled-but-not-selected plugin
 *    with `status=skipped` and `hyp_reason=not_configured`. The config
 *    below names a subset of the default activation surface, so every
 *    other plugin on that surface lands on the skipped path.
 *
 * The rosters here are derived from the shipped allowlist, exclude set,
 * and manifests, because a pinned one goes stale the moment a plugin
 * joins or leaves the tree (issues #2079, #2081).
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'cli_bundled_plugins_activated: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  // Stage a v2 config naming a proper subset of the default activation
  // surface, so the rest of that surface lands on the "skipped" log path the
  // assertions below derive. Nothing in `V1_EXCLUDED_FROM_DEFAULT` is named,
  // so none of it activates: that set never reaches the skip loop either, it
  // is activatable only via explicit config.
  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [
      {
        // A concrete `listen` port (not `:0`) is load-bearing for the
        // OpenClaw dry-run below: `hyp client attach --dry-run` derives the
        // gateway endpoint from this configured `listen` (the source is
        // never started in a CLI dispatch, so `localEndpoint()` is
        // unavailable), and the OpenClaw adapter only runs
        // `readSettings()`/`prepareAttach()` against the seeded config
        // when that derived port is defined - a `:0` listen resolves to
        // port 0, which the adapter treats as the unstarted placeholder
        // and skips the validation entirely. The port is never bound in
        // this smoke (activation registers the source without listening),
        // so a fixed value cannot collide across parallel runs.
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:4317',
          upstreams: [
            { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' },
          ],
        },
      },
      // Bound to ephemeral port so multiple smoke runs don't collide.
      // The activate() of @hypaware/otel auto-starts a listener.
      {
        name: '@hypaware/otel',
        config: { listen_host: '127.0.0.1', listen_port: 0 },
      },
      { name: '@hypaware/claude' },
      { name: '@hypaware/codex', config: { proxy: '@hypaware/ai-gateway' } },
      { name: '@hypaware/openclaw' },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
    ],
    query: { cache: { retention: { default_days: 30 } } },
  }, null, 2))

  const baseEnv = {
    ...process.env,
    HYP_HOME: harness.hypHome,
    HYP_CONFIG: configPath,
    DEV_RUN_ID: harness.devRunId,
  }

  // ----- 1. hyp plugin list (JSON form drives strict assertions) -----
  const listStdout = makeBuf()
  const listStderr = makeBuf()
  const listCode = await dispatch(['plugin', 'list', '--json'], {
    stdout: listStdout,
    stderr: listStderr,
    env: baseEnv,
  })
  expect.that('dispatch: hyp plugin list --json exited 0', listCode, (v) => v === 0)
  expect.that(
    'stderr: hyp plugin list had no errors',
    listStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )

  const listed = parseJson(listStdout.text())
  expect.that(
    'stdout: hyp plugin list --json emitted a {plugins:[]} document',
    listed,
    (v) => v !== undefined && Array.isArray(v?.plugins)
  )

  const activeNames = (listed.plugins ?? [])
    .filter((/** @type {any} */ p) => p.active === true)
    .map((/** @type {any} */ p) => p.name)
    .sort()
  const expectedActive = [
    '@hypaware/ai-gateway',
    '@hypaware/claude',
    '@hypaware/codex',
    '@hypaware/format-parquet',
    // The seeded config is deliberately a legacy one that never named grep:
    // the boot migration adds it, so this flow also covers the upgrade
    // reaching `hyp plugin list`.
    '@hypaware/grep',
    '@hypaware/local-fs',
    '@hypaware/openclaw',
    '@hypaware/otel',
  ]
  expect.that(
    `plugins: active set matches the configured allowlist subset (got ${activeNames.join(',')})`,
    activeNames,
    (v) => Array.isArray(v) && v.join(',') === expectedActive.join(',')
  )
  expect.that(
    'plugins: every active plugin carries source=bundled',
    (listed.plugins ?? []).filter((/** @type {any} */ p) => p.active),
    (rows) => Array.isArray(rows) && rows.every((/** @type {any} */ r) => r.source === 'bundled')
  )
  // The whole exclude set, so a name joining it is covered the moment it
  // joins. A pinned subset of it just stops covering the rest (issue #2081).
  expect.that(
    'plugins: no excluded-from-default plugin appears in hyp plugin list',
    (listed.plugins ?? []).map((/** @type {any} */ p) => p.name),
    (v) => Array.isArray(v) && !v.some((/** @type {any} */ n) => V1_EXCLUDED_FROM_DEFAULT.has(n))
  )

  // ----- 2. hyp client attach claude --dry-run -----
  const claudeStdout = makeBuf()
  const claudeStderr = makeBuf()
  const claudeCode = await dispatch(
    ['client', 'attach', 'claude', '--dry-run'],
    { stdout: claudeStdout, stderr: claudeStderr, env: baseEnv }
  )
  expect.that('dispatch: hyp client attach claude --dry-run exited 0', claudeCode, (v) => v === 0)
  expect.that(
    'stderr: claude attach dry-run had no errors',
    claudeStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )
  expect.that(
    "stdout: claude dry-run prints '(dry-run) Would attach Claude Code'",
    claudeStdout.text(),
    (v) => typeof v === 'string' && v.includes('(dry-run) Would attach Claude Code')
  )

  // ----- 3. hyp client attach codex --dry-run -----
  const codexStdout = makeBuf()
  const codexStderr = makeBuf()
  const codexCode = await dispatch(
    ['client', 'attach', 'codex', '--dry-run'],
    { stdout: codexStdout, stderr: codexStderr, env: baseEnv }
  )
  expect.that('dispatch: hyp client attach codex --dry-run exited 0', codexCode, (v) => v === 0)
  expect.that(
    'stderr: codex attach dry-run had no errors',
    codexStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )
  expect.that(
    "stdout: codex dry-run prints '(dry-run) Would attach Codex'",
    codexStdout.text(),
    (v) => typeof v === 'string' && v.includes('(dry-run) Would attach Codex')
  )

  // ----- 3b. hyp client attach openclaw --dry-run -----
  // Seeded OPENCLAW_HOME keeps the step hermetic: the adapter refuses a
  // missing settings file or a non-Anthropic primary (LLP 0109), so the
  // real user HOME must never leak into this dispatch. The placeholder
  // API key suppresses the unset-ANTHROPIC_API_KEY stderr warning.
  const openclawHome = path.join(harness.hypHome, 'openclaw-home')
  await fs.mkdir(openclawHome, { recursive: true })
  await fs.writeFile(
    path.join(openclawHome, 'openclaw.json'),
    JSON.stringify({
      agents: { defaults: { model: { primary: 'anthropic/claude-opus-4-8' } } },
    }, null, 2) + '\n'
  )
  // The adapter reads its activation ctx.env, which is process.env in
  // this in-process dispatch (same convention claude_attach_detach uses
  // for HOME), so the overrides must go on process.env for the step.
  const openclawEnv = {
    ...baseEnv,
    OPENCLAW_HOME: openclawHome,
    ANTHROPIC_API_KEY: 'smoke-placeholder',
  }
  const prevOpenclawHome = process.env.OPENCLAW_HOME
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY
  process.env.OPENCLAW_HOME = openclawHome
  process.env.ANTHROPIC_API_KEY = 'smoke-placeholder'
  const openclawStdout = makeBuf()
  const openclawStderr = makeBuf()
  /** @type {number} */
  let openclawCode
  try {
    openclawCode = await dispatch(
      ['client', 'attach', 'openclaw', '--dry-run'],
      { stdout: openclawStdout, stderr: openclawStderr, env: openclawEnv }
    )
  } finally {
    if (prevOpenclawHome === undefined) delete process.env.OPENCLAW_HOME
    else process.env.OPENCLAW_HOME = prevOpenclawHome
    if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevAnthropicKey
  }
  expect.that('dispatch: hyp client attach openclaw --dry-run exited 0', openclawCode, (v) => v === 0)
  expect.that(
    'stderr: openclaw attach dry-run had no errors',
    openclawStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )
  expect.that(
    "stdout: openclaw dry-run prints '(dry-run) Would attach OpenClaw'",
    openclawStdout.text(),
    (v) => typeof v === 'string' && v.includes('(dry-run) Would attach OpenClaw')
  )

  // ----- 4. hyp status --json -----
  const statusStdout = makeBuf()
  const statusStderr = makeBuf()
  const statusCode = await dispatch(['status', '--json'], {
    stdout: statusStdout,
    stderr: statusStderr,
    env: baseEnv,
  })
  expect.that('dispatch: hyp status --json exited 0', statusCode, (v) => v === 0)
  expect.that(
    'stderr: status --json had no errors',
    statusStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )
  const statusText = statusStdout.text()
  const status = parseJson(statusText)
  expect.that('stdout: status --json parses', status, (v) => v && typeof v === 'object')
  expect.that(
    'status: active_plugins enumerates the configured set',
    (status?.active_plugins ?? []).map((/** @type {any} */ p) => p.name).sort(),
    (v) => Array.isArray(v) && v.join(',') === expectedActive.join(',')
  )
  expect.that(
    'status: sources list includes ai-gateway and otlp',
    (status?.sources ?? []).map((/** @type {any} */ s) => s.name).sort(),
    (v) => Array.isArray(v) && v.includes('ai-gateway') && v.includes('otlp')
  )
  expect.that(
    'status: clients include claude, codex, and openclaw',
    (status?.clients ?? []).slice().sort(),
    (v) => Array.isArray(v) && v.join(',').includes('claude') && v.join(',').includes('codex') &&
      v.join(',').includes('openclaw')
  )
  expect.that(
    'status: daemon block is present with a deterministic shape',
    status?.daemon,
    (v) =>
      v &&
      typeof v === 'object' &&
      typeof v.installed === 'boolean' &&
      typeof v.running === 'boolean' &&
      typeof v.state === 'string'
  )
  // Same derivation as the `hyp plugin list` check, over the whole rendered
  // document rather than the parsed plugin rows.
  for (const name of V1_EXCLUDED_FROM_DEFAULT) {
    expect.that(
      `status: unconfigured ${name} absent from status JSON`,
      statusText,
      (v) => typeof v === 'string' && !v.includes(name)
    )
  }

  await obs.shutdown()

  // ----- Telemetry assertions -----
  const traces = await expect.traces()
  const logs = await expect.logs()

  const bootSpans = traces.filter((/** @type {any} */ t) => t.name === 'kernel.boot')
  expect.that(
    'traces: at least one kernel.boot root span emitted',
    bootSpans,
    (rows) => Array.isArray(rows) && rows.length >= 1
  )
  expect.that(
    'traces: every kernel.boot span is a root span',
    bootSpans.map((/** @type {any} */ s) => s.parentSpanId),
    (ids) => Array.isArray(ids) && ids.every((id) => id === null)
  )
  expect.that(
    'traces: every kernel.boot tags mode=cli',
    bootSpans.map((/** @type {any} */ s) => s.attributes?.mode),
    (modes) => Array.isArray(modes) && modes.every((m) => m === 'cli')
  )
  const configBoots = bootSpans.filter(
    (/** @type {any} */ s) => s.attributes?.boot_profile === 'config'
  )
  expect.that(
    `traces: at least one config-profile boot reports plugins_activated=${expectedActive.length}`,
    configBoots.map((/** @type {any} */ s) => s.attributes?.plugins_activated),
    (rows) => Array.isArray(rows) && rows.some((n) => n === expectedActive.length)
  )
  // A manifest the workspace ships under a name neither the allowlist nor the
  // exclude set claims is a half-landed plugin: the directory landed, the
  // kernel's declaration of it did not. It gets its own assertion rather than
  // joining the roster below, because boot never pools such a manifest
  // (`selectBootPlugins` pools `loaded` + `excluded`), so it is neither
  // activated nor skip-logged: counting it into `expectedSkipped` would demand
  // boot skip a name it cannot see, failing the smoke on a correct kernel and
  // blaming the skip count for it (issue #2085). Sorted so the names the
  // failure prints are stable.
  const { unknown } = await discoverBundledPlugins()
  expect.that(
    'bundled: every shipped manifest is claimed by the allowlist or the exclude set',
    unknown.map((m) => m.manifest.name).sort(),
    (v) => Array.isArray(v) && v.length === 0
  )
  // Skipped = every default-surface bundled plugin this flow's config does
  // not name (the excluded-from-default set never reaches the skip loop).
  // Derived rather than pinned as a literal, which drifts the moment a plugin
  // joins the default surface (issue #2079).
  //
  // The allowlist, not the `loaded` bucket boot skips from: that bucket is
  // declared intersected with shipped, so it moves with the run, and a plugin
  // declared but no longer shipped would shrink the expectation by exactly
  // what it shrinks the run by. The allowlist does not move, so that
  // disagreement still fails.
  const expectedSkipped = [...V1_BUNDLED_PLUGIN_ALLOWLIST]
    .filter((n) => !expectedActive.includes(n))
    .sort()
  expect.that(
    `traces: at least one config-profile boot reports plugins_skipped=${expectedSkipped.length}` +
      ` (${expectedSkipped.join(',')})`,
    configBoots.map((/** @type {any} */ s) => s.attributes?.plugins_skipped),
    (rows) => Array.isArray(rows) && rows.some((n) => n === expectedSkipped.length)
  )

  const activateSpans = traces.filter((/** @type {any} */ t) => t.name === 'plugin.activate')
  const activatedNames = new Set(
    activateSpans
      .map((/** @type {any} */ s) => s.attributes?.hyp_plugin)
      .filter(Boolean)
  )
  for (const expected of expectedActive) {
    expect.that(
      `traces: plugin.activate span exists for ${expected}`,
      activatedNames.has(expected),
      (v) => v === true
    )
  }
  expect.that(
    'traces: every plugin.activate span is a child of a kernel.boot span',
    activateSpans.map((/** @type {any} */ s) => s.parentSpanId),
    (ids) =>
      Array.isArray(ids) &&
      ids.every((id) =>
        bootSpans.some((/** @type {any} */ b) => b.spanId === id)
      )
  )

  // Scoped to the boots under test by `spanId`, which `plugin.skipped` carries
  // because it is logged inside the `kernel.boot` span. These dispatches also
  // produce an `explicit:0` boot that selects nothing and so skips the whole
  // default surface: an unfiltered scan therefore holds every bundled name,
  // and a name check against it is true no matter which boot skipped it, so it
  // cannot fail (issue #2081).
  const configBootSpanIds = new Set(configBoots.map((/** @type {any} */ s) => s.spanId))
  const skippedLogs = logs.filter(
    (/** @type {any} */ l) =>
      l.body === 'plugin.skipped' &&
      l.attributes?.hyp_reason === 'not_configured' &&
      l.attributes?.status === 'skipped' &&
      configBootSpanIds.has(l.spanId)
  )
  const skippedPlugins = new Set(
    skippedLogs.map((/** @type {any} */ l) => l.attributes?.hyp_plugin).filter(Boolean)
  )
  expect.that(
    'logs: config-profile boots skipped exactly the default-surface plugins this' +
      ` config omits (${expectedSkipped.join(',')})`,
    [...skippedPlugins].sort(),
    (v) => Array.isArray(v) && v.join(',') === expectedSkipped.join(',')
  )
  // Named, where the set above is derived, and that is the point: the
  // derivation moves with `expectedActive`, so re-scoping this config to
  // activate one of these would carry the expectation along and prove nothing.
  // These four are the flow's own claim about the skipped path it covers.
  for (const name of [
    '@hypaware/cursor',
    '@hypaware/format-jsonl',
    '@hypaware/s3',
    '@hypaware/format-iceberg',
  ]) {
    expect.that(
      `logs: ${name} emitted a plugin.skipped log with hyp_reason=not_configured`,
      skippedPlugins.has(name),
      (v) => v === true
    )
  }
}

/**
 * Tiny WriteStream that captures chunks for later inspection.
 */
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
 * Find the first balanced `{...}` block in `text` and JSON.parse it.
 * Returns undefined if nothing parses.
 *
 * @param {string} text
 */
function parseJson(text) {
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        const slice = text.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch {
          start = -1
        }
      }
    }
  }
  return undefined
}
