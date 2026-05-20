import process from 'node:process'
import { ConfigError, loadConfigAsync as defaultLoadConfig } from '../config.js'
import { attach as defaultAttach, defaultSettingsPath } from '../claude-code/settings.js'
import {
  LAUNCH_AGENT_LABEL,
  daemonKindLabel,
  defaultLogDir,
  defaultPrompt,
  isNpxBinPath,
  parseListenPort,
  readPackageVersion,
  resolveDefaultConfigPath,
} from './common.js'
import { installDaemon } from '../daemon/index.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import { InstallHooks, InstallParseResult } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs install [--config <path|url>] [--yes|--no]

Options:
  --config <path|url>  Path or http(s) URL to the collectivus JSON config
                       (default: ~/.hyp/collectivus.json)
  --yes                Attach Claude Code without prompting
  --no                 Skip the Claude Code attach step
  --help, -h           Show this help`

/**
 * Parse the argument list of `collectivus install`.
 *
 * @param {string[]} argv
 * @returns {InstallParseResult}
 */
export function parseInstallArgs(argv) {
  /** @type {InstallParseResult} */
  const r = { yes: false, no: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      r.help = true
      return r
    }
    if (arg === '--yes' || arg === '-y') { r.yes = true; continue }
    if (arg === '--no' || arg === '-n') { r.no = true; continue }
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  if (r.yes && r.no) {
    r.error = '--yes and --no are mutually exclusive'
  }
  return r
}

/**
 * Run `collectivus install`.
 *
 * Steps:
 *  1. Parse args; reject npx-resolved binary paths.
 *  2. Validate the config and resolve the proxy port.
 *  3. Install the LaunchAgent.
 *  4. Decide whether to attach Claude Code (--yes / --no / TTY prompt / non-TTY skip).
 *  5. Print final state.
 *
 * @param {string[]} argv
 * @param {InstallHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runInstall(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const binPath = hooks.binPath ?? process.argv[1] ?? ''
  const installFn = hooks.installLaunchAgent ?? installDaemon
  const attachFn = hooks.attach ?? defaultAttach
  const loadConfigFn = hooks.loadConfig ?? defaultLoadConfig
  const promptFn = hooks.prompt ?? defaultPrompt
  const logDir = hooks.logDir ?? defaultLogDir()
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()
  const isTTY = hooks.isTTY ?? Boolean(process.stdin.isTTY)

  const parsed = parseInstallArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  if (!parsed.configPath) {
    const fallback = resolveDefaultConfigPath(hooks.homeDir)
    if (fallback) {
      parsed.configPath = fallback
    } else {
      stderr.write(
        'error: --config is required\n' +
        `\nhint: run \`collectivus\` with no arguments for interactive setup\n\n${USAGE}\n`
      )
      return 2
    }
  }

  if (isNpxBinPath(binPath)) {
    stderr.write(
      'error: `ctvs install` requires a global install. ' +
      'Run `npm install -g collectivus` first, then `ctvs install`.\n'
    )
    return 1
  }

  /** @type {CollectivusConfig} */
  let config
  try {
    config = await loadConfigFn(parsed.configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`config error: ${err.message}\n`)
      return 1
    }
    throw err
  }

  /** @type {number | undefined} */
  let port
  if (config.proxy) {
    try {
      port = parseListenPort(config.proxy.listen)
    } catch (err) {
      stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  const version = hooks.version ?? readPackageVersion()

  try {
    await installFn({
      binPath,
      configPath: parsed.configPath,
      label: LAUNCH_AGENT_LABEL,
      logDir,
      ...hooks.plistDir !== undefined ? { plistDir: hooks.plistDir } : {},
    })
  } catch (err) {
    stderr.write(`error: failed to install daemon: ${formatError(err)}\n`)
    return 1
  }

  stdout.write(`✓ Daemon installed (${daemonKindLabel()})\n`)

  /** @type {boolean} */
  let shouldAttach
  if (port === undefined) {
    shouldAttach = false
  } else if (parsed.yes) {
    shouldAttach = true
  } else if (parsed.no) {
    shouldAttach = false
  } else if (isTTY) {
    const answer = await promptFn('Configure Claude Code to use this proxy? [Y/n] ')
    shouldAttach = answer === '' || /^y(es)?$/i.test(answer)
  } else {
    stderr.write(
      'warning: not a TTY and neither --yes nor --no provided; skipping Claude Code attach. ' +
      'Run `ctvs attach` later to opt in.\n'
    )
    shouldAttach = false
  }

  if (shouldAttach) {
    try {
      const result = await attachFn({ port, version, settingsPath, binPath })
      stdout.write(`✓ Claude Code attached (${settingsPath})\n`)
      if (result.prevValue !== undefined) {
        stdout.write(`  (previous ANTHROPIC_BASE_URL was ${result.prevValue})\n`)
      }
    } catch (err) {
      stderr.write(`error: failed to attach Claude Code: ${formatError(err)}\n`)
      return 1
    }
  } else if (port === undefined) {
    stdout.write('  Claude Code attach: skipped (no proxy configured)\n')
  } else {
    stdout.write('  Claude Code attach: skipped\n')
  }

  stdout.write(`Logs: ${logDir}/collectivus.log\n`)
  return 0
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
