// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { installObservability } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'

/**
 * Phase 2 V1 smoke (finish-v1.md §Phase 2). Drives the unified
 * `bootKernel` path through the dispatcher under a temp HYP_HOME and
 * asserts the four bead acceptance criteria:
 *
 *  1. `hyp plugin list` shows active bundled plugins from the
 *     generated config (both text and `--json` form).
 *  2. `hyp attach --client claude --dry-run` reaches the Claude
 *     adapter (the adapter's own `client.attach` span fires with
 *     `dry_run=true` and the dry-run banner lands on stdout).
 *  3. `hyp attach --client codex --dry-run` reaches the Codex adapter
 *     (same shape).
 *  4. `hyp status --json` emits a stable JSON document listing the
 *     configured sources, sinks, clients, and active plugins. Because
 *     neither `@hypaware/central` nor `@hypaware/gascity` is in this
 *     config, they must not appear as they are excluded from default
 *     activation but remain discoverable through the plugin catalog and
 *     activatable via explicit config or init presets.
 *
 * Telemetry contract (per bead):
 *  - One `kernel.boot` root span per dispatch boot.
 *  - One `plugin.activate` child span per active plugin per boot.
 *  - One `plugin.skipped` log row per bundled-but-not-selected plugin
 *    with `status=skipped` and `hyp_reason=not_configured`. The
 *    selected set here covers six of the nine V1-bundled plugins so
 *    `@hypaware/format-jsonl`, `@hypaware/s3`, and
 *    `@hypaware/format-iceberg` land on the skipped path.
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

  // Stage a v2 config that selects six of the nine V1-bundled
  // plugins. `@hypaware/format-jsonl`, `@hypaware/s3`, and
  // `@hypaware/format-iceberg` are intentionally omitted so the smoke
  // can assert the "skipped" log surface. `@hypaware/central` and
  // `@hypaware/gascity` are not in this config, they are excluded from
  // default activation but activatable via explicit config.
  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:0',
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
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
      { name: '@hypaware/codex', config: { proxy: '@hypaware/ai-gateway' } },
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
    '@hypaware/local-fs',
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
  expect.that(
    'plugins: unconfigured plugins (central/gascity) absent from active list',
    (listed.plugins ?? []).map((/** @type {any} */ p) => p.name),
    (v) =>
      Array.isArray(v) &&
      !v.includes('@hypaware/central') &&
      !v.includes('@hypaware/gascity')
  )

  // ----- 2. hyp attach --client claude --dry-run -----
  const claudeStdout = makeBuf()
  const claudeStderr = makeBuf()
  const claudeCode = await dispatch(
    ['attach', '--client', 'claude', '--dry-run'],
    { stdout: claudeStdout, stderr: claudeStderr, env: baseEnv }
  )
  expect.that('dispatch: hyp attach --client claude --dry-run exited 0', claudeCode, (v) => v === 0)
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

  // ----- 3. hyp attach --client codex --dry-run -----
  const codexStdout = makeBuf()
  const codexStderr = makeBuf()
  const codexCode = await dispatch(
    ['attach', '--client', 'codex', '--dry-run'],
    { stdout: codexStdout, stderr: codexStderr, env: baseEnv }
  )
  expect.that('dispatch: hyp attach --client codex --dry-run exited 0', codexCode, (v) => v === 0)
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
  const status = parseJson(statusStdout.text())
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
    'status: clients include claude and codex',
    (status?.clients ?? []).slice().sort(),
    (v) => Array.isArray(v) && v.join(',').includes('claude') && v.join(',').includes('codex')
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
  expect.that(
    'status: unconfigured @hypaware/central absent from status JSON',
    statusStdout.text(),
    (v) => typeof v === 'string' && !v.includes('@hypaware/central')
  )
  expect.that(
    'status: unconfigured @hypaware/gascity absent from status JSON',
    statusStdout.text(),
    (v) => typeof v === 'string' && !v.includes('@hypaware/gascity')
  )

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
    'traces: at least one config-profile boot reports plugins_activated=6',
    configBoots.map((/** @type {any} */ s) => s.attributes?.plugins_activated),
    (rows) => Array.isArray(rows) && rows.some((n) => n === 6)
  )
  // Skipped = allowlist plugins this flow's config does not name (the
  // excluded-from-default set never reaches the skip loop). Bumps
  // whenever a plugin joins V1_BUNDLED_PLUGIN_ALLOWLIST, most
  // recently @hypaware/context-graph (3 -> 4).
  expect.that(
    'traces: at least one config-profile boot reports plugins_skipped=4',
    configBoots.map((/** @type {any} */ s) => s.attributes?.plugins_skipped),
    (rows) => Array.isArray(rows) && rows.some((n) => n === 4)
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

  const skippedLogs = logs.filter(
    (/** @type {any} */ l) =>
      l.body === 'plugin.skipped' &&
      l.attributes?.hyp_reason === 'not_configured' &&
      l.attributes?.status === 'skipped'
  )
  const skippedPlugins = new Set(
    skippedLogs.map((/** @type {any} */ l) => l.attributes?.hyp_plugin).filter(Boolean)
  )
  expect.that(
    'logs: format-jsonl emitted a plugin.skipped log with hyp_reason=not_configured',
    skippedPlugins.has('@hypaware/format-jsonl'),
    (v) => v === true
  )
  expect.that(
    'logs: s3 emitted a plugin.skipped log with hyp_reason=not_configured',
    skippedPlugins.has('@hypaware/s3'),
    (v) => v === true
  )
  expect.that(
    'logs: format-iceberg emitted a plugin.skipped log with hyp_reason=not_configured',
    skippedPlugins.has('@hypaware/format-iceberg'),
    (v) => v === true
  )
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
