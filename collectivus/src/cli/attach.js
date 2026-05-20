import path from 'node:path'
import process from 'node:process'
import { ConfigError, loadConfigAsync as defaultLoadConfig } from '../config.js'
import { attach as defaultAttachClaude, defaultSettingsPath } from '../claude-code/settings.js'
import { attach as defaultAttachCodex, defaultConfigPath as defaultCodexConfigPath } from '../codex/settings.js'
import { parseListenPort, readPackageVersion, resolveDefaultConfigPath } from './common.js'
import { pathMatchesPrefix } from '../proxy.js'
import { installSkillBundle as defaultInstallSkillBundle } from '../skills/install.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import { AttachHooks, AttachParseResult } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs attach [--config <path|url> | --port <n>] [--client claude|codex|all]

Options:
  --config <path|url>  Read the proxy port from this collectivus config (path or http(s) URL)
                       (default: ~/.hyp/collectivus.json)
  --port <n>           Use this port directly
  --client <name>      Tool to configure: claude, codex, or all (default: claude)
  --help, -h           Show this help

Edits Claude Code and/or Codex configuration to point at the local proxy.
Without --config or --port, falls back to ~/.hyp/collectivus.json when present.`

/**
 * Parse the argument list of `collectivus attach`.
 *
 * @param {string[]} argv
 * @returns {AttachParseResult}
 */
export function parseAttachArgs(argv) {
  /** @type {AttachParseResult} */
  const r = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      r.help = true
      return r
    }
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? argv[++i] : arg.slice('--port='.length)
      if (!value) { r.error = '--port requires a number'; return r }
      if (!/^\d+$/.test(value)) { r.error = `--port: not a valid port (got "${value}")`; return r }
      const n = Number.parseInt(value, 10)
      if (n < 1 || n > 65535) { r.error = `--port: not a valid port (got "${value}")`; return r }
      r.port = n
      continue
    }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!value) { r.error = '--client requires claude, codex, or all'; return r }
      if (value !== 'claude' && value !== 'codex' && value !== 'all') {
        r.error = `--client: expected claude, codex, or all (got "${value}")`
        return r
      }
      r.client = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  if (r.configPath !== undefined && r.port !== undefined) {
    r.error = '--config and --port are mutually exclusive'
  }
  // The "neither --config nor --port" case is handled in runAttach so it can
  // fall back to ~/.hyp/collectivus.json when present.
  if (r.client === undefined) r.client = 'claude'
  return r
}

/**
 * Run `collectivus attach`.
 *
 * Resolves the proxy port from `--port` or `proxy.listen` in the supplied
 * config, then updates the selected client configuration.
 *
 * @param {string[]} argv
 * @param {AttachHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runAttach(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const attachClaude = hooks.attachClaude ?? hooks.attach ?? defaultAttachClaude
  const attachCodex = hooks.attachCodex ?? defaultAttachCodex
  const loadConfigFn = hooks.loadConfig ?? defaultLoadConfig
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()
  const codexConfigPath = hooks.codexConfigPath ?? defaultCodexConfigPath()
  const binPath = hooks.binPath ?? process.argv[1] ?? 'ctvs'
  // Auto-install Claude helper skills after a successful Claude attach. Tests
  // that mock `attach` / `attachClaude` to avoid touching real settings.json
  // should similarly not have skills materialized into `~/.claude/skills/` —
  // so when those hooks are overridden but `installSkillBundle` isn't, we
  // short-circuit to a noop. Tests that DO want to verify the auto-install
  // can opt in by passing their own `installSkillBundle` spy.
  /** @type {((opts: import('../skills/types.d.ts').SkillInstallOptions) => Promise<import('../skills/types.d.ts').SkillInstallResult>) | null} */
  const installSkillBundle = hooks.installSkillBundle
    ?? (hooks.attach || hooks.attachClaude
      ? null
      : defaultInstallSkillBundle)

  const parsed = parseAttachArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  if (parsed.port === undefined && parsed.configPath === undefined) {
    const fallback = resolveDefaultConfigPath(hooks.homeDir)
    if (fallback) {
      parsed.configPath = fallback
    } else {
      stderr.write(`error: one of --config or --port is required\n\n${USAGE}\n`)
      return 2
    }
  }

  /** @type {number} */
  let port
  /** @type {CollectivusConfig | undefined} */
  let config
  if (parsed.port !== undefined) {
    port = parsed.port
  } else if (parsed.configPath !== undefined) {
    try {
      config = await loadConfigFn(parsed.configPath)
    } catch (err) {
      if (err instanceof ConfigError) {
        stderr.write(`config error: ${err.message}\n`)
        return 1
      }
      throw err
    }
    if (!config.proxy) {
      stderr.write('error: config must define `proxy.listen` to derive the attach port\n')
      return 1
    }
    try {
      port = parseListenPort(config.proxy.listen)
    } catch (err) {
      stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  } else {
    // Defensive: branch above set configPath when neither was provided.
    stderr.write('error: one of --config or --port is required\n')
    return 2
  }

  if ((parsed.client === 'codex' || parsed.client === 'all') && config && !hasProxyRoute(config, '/v1/responses')) {
    stderr.write(
      'error: Codex attach requires a proxy upstream that routes /v1/responses ' +
      '(for OpenAI, use match.path_prefix "/v1" with base_url "https://api.openai.com")\n'
    )
    return 1
  }

  const version = hooks.version ?? readPackageVersion()

  if (parsed.client === 'claude' || parsed.client === 'all') {
    /** @type {{ changed: boolean, prevValue?: string }} */
    let result
    try {
      result = await attachClaude({ port, version, settingsPath, binPath })
    } catch (err) {
      stderr.write(`error: failed to attach Claude Code: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }

    stdout.write(`✓ Claude Code attached (${settingsPath})\n`)
    stdout.write(`  ANTHROPIC_BASE_URL = http://127.0.0.1:${port}\n`)
    if (result.prevValue !== undefined) {
      stdout.write(`  (previous ANTHROPIC_BASE_URL was ${result.prevValue})\n`)
    }

    // Auto-install the Claude-targeted helper skills so the user gets
    // `/ctvs-ignore`, `/ctvs-unignore`, and `collectivus-query` without a
    // second command. Failure is a warning, not an error, so a transient
    // filesystem problem doesn't undo a successful Claude attach.
    if (installSkillBundle) {
      try {
        const skillResult = await installSkillBundle({ client: 'claude' })
        for (const destination of skillResult.destinations) {
          const verb = destination.action === 'updated' ? 'Updated' : 'Installed'
          stdout.write(`  ${verb} Claude skill ${path.basename(destination.path)} (${destination.path})\n`)
        }
      } catch (err) {
        stderr.write(
          `warning: failed to install Claude helper skills: ${err instanceof Error ? err.message : String(err)}\n` +
          '  run \'ctvs skills install --client claude\' to retry\n'
        )
      }
    }
  }

  if (parsed.client === 'codex' || parsed.client === 'all') {
    /** @type {{ changed: boolean, prevValue?: string }} */
    let result
    try {
      result = await attachCodex({ port, version, configPath: codexConfigPath })
    } catch (err) {
      stderr.write(`error: failed to attach Codex: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }

    stdout.write(`✓ Codex attached (${codexConfigPath})\n`)
    stdout.write('  model_provider = collectivus\n')
    stdout.write(`  base_url = http://127.0.0.1:${port}/v1\n`)
    if (result.prevValue !== undefined) {
      stdout.write(`  (previous model_provider was ${result.prevValue})\n`)
    }
  }

  return 0
}

/**
 * @param {CollectivusConfig} config
 * @param {string} requestPath
 * @returns {boolean}
 */
function hasProxyRoute(config, requestPath) {
  return (config.proxy?.upstreams ?? []).some(function(upstream) {
    const prefix = upstream?.match?.path_prefix
    return typeof prefix === 'string' && prefix.length > 0 && pathMatchesPrefix(requestPath, prefix)
  })
}
