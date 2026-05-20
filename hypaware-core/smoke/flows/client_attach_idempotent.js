// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'
import { requireAiGatewayRuntime } from '../../plugins-workspace/ai-gateway/src/runtime.js'

/**
 * Phase 6 smoke. Hardens attach/detach for both Claude Code and
 * Codex adapters against a temp Claude `settings.json` + temp Codex
 * `config.toml`, then asserts the §Phase 6 contract:
 *
 *  - Attach twice does not duplicate settings (idempotent).
 *  - Detach twice succeeds (second call is a no-op).
 *  - Attach after detach restores the expected state.
 *  - Unrelated user keys survive every attach/detach cycle.
 *  - Claude attach writes the marker, env.ANTHROPIC_BASE_URL, and the
 *    managed session-context hooks.
 *  - Codex attach writes `model_provider = "hypaware"`, the
 *    `[model_providers.hypaware]` table with `base_url`,
 *    `wire_api = "responses"`, and `requires_openai_auth = true`.
 *  - `--json` output is structurally well-formed JSON, one object
 *    per call, status=ok.
 *  - `client.attach` / `client.detach` spans carry `status=ok` and
 *    `hyp_client=<name>`.
 *  - Missing gateway capability yields exit 1 with a `client.attach`
 *    span whose `status=failed` and `error_kind=cap_missing`.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'client_attach_idempotent: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const fakeHome = path.join(harness.tmpDir, 'home')
  const codexHome = path.join(harness.tmpDir, 'codex-home')
  await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true })
  await fs.mkdir(codexHome, { recursive: true })

  const claudeSettingsPath = path.join(fakeHome, '.claude', 'settings.json')
  const codexConfigPath = path.join(codexHome, 'config.toml')

  // Seed both files with unrelated user content so we can verify
  // attach/detach preserves it byte-for-byte across cycles.
  const seedClaudeSettings = {
    env: { ANTHROPIC_API_KEY: 'sk-original-key' },
    permissions: { allow: ['Bash(ls *)'] },
  }
  const seedClaudeBody = JSON.stringify(seedClaudeSettings, null, 2) + '\n'
  await fs.writeFile(claudeSettingsPath, seedClaudeBody, 'utf8')

  const seedCodexBody = [
    '# user preferences — must survive attach/detach',
    'model = "gpt-5-codex"',
    '',
    '[history]',
    'max_bytes = 1024',
    '',
  ].join('\n')
  await fs.writeFile(codexConfigPath, seedCodexBody, 'utf8')

  const previousHome = process.env.HOME
  const previousCodexHome = process.env.CODEX_HOME
  process.env.HOME = fakeHome
  process.env.CODEX_HOME = codexHome

  try {
    // ----------------------------------------------------------------
    // Kernel #1: ai-gateway + claude + codex. Drives the idempotency
    // and round-trip assertions.
    // ----------------------------------------------------------------
    const registry = createCommandRegistry()
    registerCoreCommands(registry)
    const cacheRoot = path.join(harness.stateDir, 'cache')
    const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

    const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
    const aiGatewayDir = path.join(pluginsRoot, 'ai-gateway')
    const claudeDir = path.join(pluginsRoot, 'claude')
    const codexDir = path.join(pluginsRoot, 'codex')

    const aiGatewayConfig = {
      listen: '127.0.0.1:0',
      upstreams: [
        {
          name: 'anthropic',
          base_url: 'https://api.anthropic.com',
          path_prefix: '/',
        },
        {
          name: 'openai',
          base_url: 'https://api.openai.com',
          path_prefix: '/v1',
        },
      ],
    }

    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests([aiGatewayDir, claudeDir, codexDir])
        if (loaded.length !== 3) {
          throw new Error(
            `client_attach_idempotent: expected 3 plugins loaded, got ${loaded.length}`
          )
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `client_attach_idempotent: unsatisfied requirements: ${
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
            config: l.manifest.name === '@hypaware/ai-gateway' ? aiGatewayConfig : {},
          }))
        return activatePlugins({
          plugins: entries,
          stateRoot: harness.stateDir,
          runId: harness.devRunId,
          runtime: kernel,
          tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
        })
      }
    )

    const runtime = requireAiGatewayRuntime()
    await kernel.sources.start('ai-gateway', runtime.ctx)
    runtime.started = true

    const env = smokeEnv(harness)

    // ----------------------------------------------------------------
    // Claude: attach -> attach -> assert idempotent + preserved keys
    // ----------------------------------------------------------------
    let code = await runAttach(['--client', 'claude', '--yes'], { registry, kernel, env })
    expect.that('claude attach #1 exited 0', code, (v) => v === 0)

    const afterFirstClaude = await fs.readFile(claudeSettingsPath, 'utf8')

    code = await runAttach(['--client', 'claude', '--yes'], { registry, kernel, env })
    expect.that('claude attach #2 (idempotent) exited 0', code, (v) => v === 0)

    const afterSecondClaude = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8'))
    expect.that(
      'claude settings: unrelated env.ANTHROPIC_API_KEY survived two attaches',
      afterSecondClaude?.env?.ANTHROPIC_API_KEY,
      (v) => v === 'sk-original-key'
    )
    expect.that(
      'claude settings: unrelated permissions block survived',
      afterSecondClaude?.permissions?.allow,
      (v) => Array.isArray(v) && v.length === 1 && v[0] === 'Bash(ls *)'
    )
    expect.that(
      'claude settings: _hypaware marker present once',
      afterSecondClaude?._hypaware,
      (v) => v !== null && typeof v === 'object' && typeof v.port === 'number'
    )
    expect.that(
      'claude settings: managed SessionStart hook installed exactly once',
      afterSecondClaude?.hooks?.SessionStart,
      (v) => Array.isArray(v) && v.length === 1
    )
    expect.that(
      'claude settings: managed PostToolUse hook installed exactly once',
      afterSecondClaude?.hooks?.PostToolUse,
      (v) => Array.isArray(v) && v.length === 1 && v[0]?.matcher === 'Bash'
    )

    // Detach -> detach -> attach -> verify round-trip integrity.
    code = await runDetach(['--client', 'claude'], { registry, kernel, env })
    expect.that('claude detach #1 exited 0', code, (v) => v === 0)
    const afterFirstDetach = await fs.readFile(claudeSettingsPath, 'utf8')
    expect.that(
      'claude settings: first detach restored the seed file byte-for-byte',
      afterFirstDetach,
      (v) => v === seedClaudeBody
    )

    const detach2Stdout = makeBuf()
    code = await runDetach(['--client', 'claude'], {
      registry,
      kernel,
      env,
      stdout: detach2Stdout,
    })
    expect.that('claude detach #2 (no-op) exited 0', code, (v) => v === 0)
    expect.that(
      'claude detach #2 stdout reported nothing to do',
      detach2Stdout.text(),
      (v) => typeof v === 'string' && v.includes('No HypAware marker found')
    )

    code = await runAttach(['--client', 'claude', '--yes'], { registry, kernel, env })
    expect.that('claude attach after detach exited 0', code, (v) => v === 0)
    const reattachedClaude = await fs.readFile(claudeSettingsPath, 'utf8')
    // Byte-for-byte comparison ignoring the `_hypaware.attached_at`
    // wall-clock timestamp, which legitimately differs between
    // attaches.
    expect.that(
      'claude settings: re-attach matches the first attached state (modulo attached_at)',
      normalizeClaudeForCompare(reattachedClaude),
      (v) => v === normalizeClaudeForCompare(afterFirstClaude)
    )

    // JSON output: detach with --json should emit one parseable JSON
    // object on stdout with status=ok.
    const detachJsonStdout = makeBuf()
    code = await runDetach(['--client', 'claude', '--json'], {
      registry,
      kernel,
      env,
      stdout: detachJsonStdout,
    })
    expect.that('claude detach --json exited 0', code, (v) => v === 0)
    const detachJson = JSON.parse(detachJsonStdout.text().trim())
    expect.that(
      'claude detach --json: status=ok',
      detachJson?.status,
      (v) => v === 'ok'
    )
    expect.that(
      'claude detach --json: action=detach',
      detachJson?.action,
      (v) => v === 'detach'
    )
    expect.that(
      'claude detach --json: client=claude',
      detachJson?.client,
      (v) => v === 'claude'
    )
    expect.that(
      'claude detach --json: settings_path matches the patched file',
      detachJson?.settings_path,
      (v) => v === claudeSettingsPath
    )

    // Restore claude marker for one more attach cycle below (so the
    // codex tests run against a kernel where Claude is also attached).
    code = await runAttach(['--client', 'claude', '--yes'], { registry, kernel, env })
    expect.that('claude re-attach for codex phase exited 0', code, (v) => v === 0)

    // ----------------------------------------------------------------
    // Codex: attach -> attach -> assert idempotent + preserved keys
    // ----------------------------------------------------------------
    code = await runAttach(['--client', 'codex', '--yes'], { registry, kernel, env })
    expect.that('codex attach #1 exited 0', code, (v) => v === 0)

    const afterFirstCodex = await fs.readFile(codexConfigPath, 'utf8')
    expect.that(
      'codex config: contains model_provider = "hypaware"',
      afterFirstCodex,
      (v) => typeof v === 'string' && /^\s*model_provider\s*=\s*"hypaware"\s*$/m.test(v)
    )
    expect.that(
      'codex config: contains [model_providers.hypaware] table',
      afterFirstCodex,
      (v) => typeof v === 'string' && /\[model_providers\.hypaware\]/.test(v)
    )
    expect.that(
      'codex config: base_url points at the local gateway /v1',
      afterFirstCodex,
      (v) => typeof v === 'string' && /base_url\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/v1"/.test(v)
    )
    expect.that(
      'codex config: wire_api = "responses" (Responses API support)',
      afterFirstCodex,
      (v) => typeof v === 'string' && /wire_api\s*=\s*"responses"/.test(v)
    )
    expect.that(
      'codex config: requires_openai_auth = true',
      afterFirstCodex,
      (v) => typeof v === 'string' && /requires_openai_auth\s*=\s*true/.test(v)
    )
    expect.that(
      'codex config: unrelated user model setting survived',
      afterFirstCodex,
      (v) => typeof v === 'string' && /^model\s*=\s*"gpt-5-codex"\s*$/m.test(v)
    )
    expect.that(
      'codex config: unrelated [history] block survived',
      afterFirstCodex,
      (v) => typeof v === 'string' && /\[history\][\s\S]*?max_bytes\s*=\s*1024/.test(v)
    )

    code = await runAttach(['--client', 'codex', '--yes'], { registry, kernel, env })
    expect.that('codex attach #2 (idempotent) exited 0', code, (v) => v === 0)
    const afterSecondCodex = await fs.readFile(codexConfigPath, 'utf8')
    expect.that(
      'codex config: re-attach matches first attach (modulo attached_at)',
      normalizeCodexForCompare(afterSecondCodex),
      (v) => v === normalizeCodexForCompare(afterFirstCodex)
    )

    code = await runDetach(['--client', 'codex'], { registry, kernel, env })
    expect.that('codex detach #1 exited 0', code, (v) => v === 0)
    const afterCodexDetach = await fs.readFile(codexConfigPath, 'utf8')
    expect.that(
      'codex config: detach removed [model_providers.hypaware] table',
      afterCodexDetach,
      (v) => typeof v === 'string' && !/\[model_providers\.hypaware\]/.test(v)
    )
    expect.that(
      'codex config: detach removed root model_provider assignment',
      afterCodexDetach,
      (v) => typeof v === 'string' && !/^\s*model_provider\s*=\s*"hypaware"\s*$/m.test(v)
    )
    expect.that(
      'codex config: detach preserved unrelated [history] block',
      afterCodexDetach,
      (v) => typeof v === 'string' && /\[history\][\s\S]*?max_bytes\s*=\s*1024/.test(v)
    )
    expect.that(
      'codex config: detach preserved unrelated root model = "gpt-5-codex"',
      afterCodexDetach,
      (v) => typeof v === 'string' && /^model\s*=\s*"gpt-5-codex"\s*$/m.test(v)
    )

    const codexDetach2Stdout = makeBuf()
    code = await runDetach(['--client', 'codex'], {
      registry,
      kernel,
      env,
      stdout: codexDetach2Stdout,
    })
    expect.that('codex detach #2 (no-op) exited 0', code, (v) => v === 0)
    expect.that(
      'codex detach #2 stdout reported nothing to do',
      codexDetach2Stdout.text(),
      (v) => typeof v === 'string' && v.includes('No HypAware marker found')
    )

    code = await runAttach(['--client', 'codex', '--yes'], { registry, kernel, env })
    expect.that('codex attach after detach exited 0', code, (v) => v === 0)
    const reattachedCodex = await fs.readFile(codexConfigPath, 'utf8')
    expect.that(
      'codex config: re-attach matches the first attached state (modulo attached_at)',
      normalizeCodexForCompare(reattachedCodex),
      (v) => v === normalizeCodexForCompare(afterFirstCodex)
    )

    // JSON output: codex attach with --json should emit a parseable
    // JSON object with the gateway base_url echoed back.
    const codexAttachJsonStdout = makeBuf()
    code = await runAttach(['--client', 'codex', '--yes', '--json'], {
      registry,
      kernel,
      env,
      stdout: codexAttachJsonStdout,
    })
    expect.that('codex attach --json exited 0', code, (v) => v === 0)
    const codexAttachJson = JSON.parse(codexAttachJsonStdout.text().trim())
    expect.that(
      'codex attach --json: status=ok',
      codexAttachJson?.status,
      (v) => v === 'ok'
    )
    expect.that(
      'codex attach --json: action=attach',
      codexAttachJson?.action,
      (v) => v === 'attach'
    )
    expect.that(
      'codex attach --json: base_url echoes gateway /v1 endpoint',
      codexAttachJson?.base_url,
      (v) => typeof v === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(v)
    )

    await kernel.sources.stop('ai-gateway')

    // ----------------------------------------------------------------
    // Kernel #2: NO ai-gateway. `hyp attach --client claude` must
    // exit 1 and emit a client.attach span with error_kind=cap_missing.
    // ----------------------------------------------------------------
    const missingRegistry = createCommandRegistry()
    registerCoreCommands(missingRegistry)
    const missingKernel = createKernelRuntime({
      commandRegistry: missingRegistry,
      cacheRoot: path.join(harness.stateDir, 'cache-missing'),
    })

    const capMissingStdout = makeBuf()
    const capMissingStderr = makeBuf()
    const capMissingCode = await dispatch(
      ['attach', '--client', 'claude', '--yes'],
      {
        stdout: capMissingStdout,
        stderr: capMissingStderr,
        kernel: missingKernel,
        registry: missingRegistry,
        env,
      }
    )
    expect.that(
      'attach without ai-gateway exits 1',
      capMissingCode,
      (v) => v === 1
    )
    expect.that(
      'attach without ai-gateway prints a clear error',
      capMissingStderr.text(),
      (v) => typeof v === 'string' && v.includes('@hypaware/ai-gateway')
    )

    await obs.shutdown()

    // ----------------------------------------------------------------
    // Telemetry assertions.
    // ----------------------------------------------------------------
    const traces = await expect.traces()

    const claudeAttachSpans = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'client.attach' &&
        t.attributes?.[Attr.PLUGIN] === '@hypaware/claude'
    )
    expect.that(
      'traces: at least 3 client.attach spans for claude (initial, idempotent, re-attach)',
      claudeAttachSpans,
      (rows) => rows.length >= 3
    )
    expect.that(
      'traces: every claude client.attach span has hyp_client=claude',
      claudeAttachSpans,
      (rows) => rows.every((/** @type {any} */ s) => s.attributes?.hyp_client === 'claude')
    )
    expect.that(
      'traces: every claude client.attach span has status=ok',
      claudeAttachSpans,
      (rows) => rows.every((/** @type {any} */ s) => s.attributes?.status === 'ok')
    )

    const codexAttachSpans = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'client.attach' &&
        t.attributes?.[Attr.PLUGIN] === '@hypaware/codex'
    )
    expect.that(
      'traces: at least 3 client.attach spans for codex',
      codexAttachSpans,
      (rows) => rows.length >= 3
    )
    expect.that(
      'traces: every codex client.attach span has hyp_client=codex',
      codexAttachSpans,
      (rows) => rows.every((/** @type {any} */ s) => s.attributes?.hyp_client === 'codex')
    )
    expect.that(
      'traces: every codex client.attach span has status=ok',
      codexAttachSpans,
      (rows) => rows.every((/** @type {any} */ s) => s.attributes?.status === 'ok')
    )

    const capMissingSpans = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'client.attach' &&
        t.attributes?.error_kind === 'cap_missing'
    )
    expect.that(
      'traces: exactly one cap_missing client.attach span',
      capMissingSpans,
      (rows) => rows.length === 1
    )
    expect.that(
      'traces: cap_missing span has status=failed',
      capMissingSpans[0]?.attributes?.status,
      (v) => v === 'failed'
    )
    expect.that(
      'traces: cap_missing span has hyp_client=claude (the requested client)',
      capMissingSpans[0]?.attributes?.hyp_client,
      (v) => v === 'claude'
    )

    const logs = await expect.logs()
    const writeLogs = logs.filter(
      (/** @type {any} */ l) =>
        typeof l?.body === 'string' && l.body === 'client.attach.write'
    )
    expect.that(
      'logs: at least one client.attach.write log per client',
      writeLogs,
      (rows) => {
        const byClient = new Set(
          rows.map((/** @type {any} */ r) => r.attributes?.hyp_client)
        )
        return byClient.has('claude') && byClient.has('codex')
      }
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
  }
}

/**
 * @param {{ hypHome: string }} harness
 */
function smokeEnv(harness) {
  return { ...process.env, HYP_HOME: harness.hypHome }
}

/**
 * @param {string[]} extra
 * @param {{
 *   registry: any,
 *   kernel: any,
 *   env: NodeJS.ProcessEnv,
 *   stdout?: { write(chunk: unknown): boolean },
 *   stderr?: { write(chunk: unknown): boolean },
 * }} opts
 */
async function runAttach(extra, opts) {
  return dispatch(['attach', ...extra], {
    stdout: opts.stdout ?? makeBuf(),
    stderr: opts.stderr ?? makeBuf(),
    kernel: opts.kernel,
    registry: opts.registry,
    env: opts.env,
  })
}

/**
 * @param {string[]} extra
 * @param {{
 *   registry: any,
 *   kernel: any,
 *   env: NodeJS.ProcessEnv,
 *   stdout?: { write(chunk: unknown): boolean },
 *   stderr?: { write(chunk: unknown): boolean },
 * }} opts
 */
async function runDetach(extra, opts) {
  return dispatch(['detach', ...extra], {
    stdout: opts.stdout ?? makeBuf(),
    stderr: opts.stderr ?? makeBuf(),
    kernel: opts.kernel,
    registry: opts.registry,
    env: opts.env,
  })
}

/**
 * Strip the wall-clock `_hypaware.attached_at` field from a Claude
 * settings.json string so two attach cycles can be compared byte-
 * for-byte.
 *
 * @param {string} body
 * @returns {string}
 */
function normalizeClaudeForCompare(body) {
  const parsed = JSON.parse(body)
  if (parsed && typeof parsed === 'object' && parsed._hypaware && typeof parsed._hypaware === 'object') {
    delete parsed._hypaware.attached_at
  }
  return JSON.stringify(parsed, null, 2) + '\n'
}

/**
 * Strip the wall-clock `# attached_at = ...` comment from a Codex
 * config.toml string so two attach cycles can be compared.
 *
 * @param {string} body
 * @returns {string}
 */
function normalizeCodexForCompare(body) {
  return body.replace(/^# attached_at\s*=.*$/m, '# attached_at = "<normalized>"')
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
