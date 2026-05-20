import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { defaultServerDataDir } from '../server/config_registry.js'
import {
  defaultConfigPath,
  defaultPrompt,
  installGlobalCollectivus,
  isNpxBinPath,
  resolveGlobalCollectivusBinPath,
} from './common.js'
import { getInitPreset, isInitPreset, listInitPresets } from './init_presets/index.js'

/**
 * @import { CollectivusConfig, FileSinkConfig, ServerConfig, UploadConfig } from '../types.js'
 * @import { InitHooks, InstallHooks } from './types.d.ts'
 */

const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude API',
    baseUrl: 'https://api.anthropic.com',
    prefix: '/v1/messages',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    baseUrl: 'https://api.openai.com',
    prefix: '/v1',
  },
  {
    id: 'gemini',
    name: 'Google Gemini API',
    baseUrl: 'https://generativelanguage.googleapis.com',
    prefix: '/v1',
  },
]

const DEFAULT_REDACT = [
  'authorization',
  'x-api-key',
  'anthropic-api-key',
  'cookie',
  'set-cookie',
]

const SINGLE_PROXY_LISTEN = '127.0.0.1:8787'
const DEFAULT_OTEL_LISTEN = '127.0.0.1:4318'
const DEFAULT_CONTROL_PLANE_LISTEN = '0.0.0.0:8788'
const IDENTITY_SECRET_BYTES = 32

const DEFAULT_UPLOAD_REGION = 'us-east-1'
const DEFAULT_UPLOAD_PREFIX = 'collectivus'
const DEFAULT_UPLOAD_TIME = '00:10'
/** @type {readonly import('../types.js').UploadSignal[]} */
const ALLOWED_UPLOAD_SIGNALS = ['logs', 'traces', 'metrics', 'proxy']
const DEFAULT_UPLOAD_SIGNALS_INPUT = ALLOWED_UPLOAD_SIGNALS.join(',')
// DNS-compatible bucket name: 3–63 chars, lowercase, no underscores. The
// inner `{1,61}` plus the leading and trailing single-character classes
// produce the 3..63 length bound.
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

const BANNER = [
  '        ╱────────╲',
  '      ╱────────────╲',
  '    ╱────────────────╲',
  '   ┌──────────────────┐',
  '   │   COLLECTIVUS    │',
  '   └──────────────────┘',
  '     ║  ║  ║  ║  ║  ║',
  '     ║  ║  ║  ║  ║  ║',
  '  ══════════════════════',
  ' ════════════════════════',
].join('\n') + '\n'

/**
 * `~/.hyp/collectivus/` is the same tree the daemon writes logs into, so a
 * fresh install keeps everything (logs + recordings) rooted in a single
 * predictable directory. The collector creates per-signal subdirectories
 * inside it (`traces/<date>.jsonl`, `<id>/proxy/<date>.jsonl`, etc.).
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
function defaultSinkDir(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'collectivus')
}

/**
 * Run the no-arg interactive walkthrough. The default onboarding path builds a
 * Standalone local capture config, writes it to disk, and (on darwin/linux)
 * chains into `runInstall` to install the daemon and attach Claude Code when
 * Claude Code capture was selected.
 *
 * If a config already exists at the default save path, summarizes it first and
 * offers the user the choice to reuse it (skipping straight to the daemon
 * install offer) or to start fresh.
 *
 * @param {InitHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runInit(hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const prompt = hooks.prompt ?? defaultPrompt
  const writeFile = hooks.writeFile ?? defaultWriteFile
  const readConfig = hooks.readConfig ?? defaultReadConfig
  const platform = hooks.platform ?? process.platform
  const cwd = hooks.cwd ?? process.cwd()
  const binPath = hooks.binPath ?? process.argv[1] ?? ''
  const defaultCfgPath = hooks.defaultConfigPath ?? defaultConfigPath()
  const defaultSink = hooks.defaultSinkDir ?? defaultSinkDir()

  stdout.write('\n' + BANNER + '\nWelcome to collectivus.\n')

  const existing = readConfig(defaultCfgPath)
  if (existing) {
    stdout.write(`\nFound an existing config at ${defaultCfgPath}:\n`)
    printConfigSummary(stdout, existing)
    stdout.write('\n  1) Use existing config\n')
    stdout.write('  2) Create a new one\n\n')
    /** @type {'use' | 'new'} */
    let choice
    for (;;) {
      const raw = (await prompt('Choose [1]: ')).trim()
      const c = raw === '' ? '1' : raw
      if (c === '1') { choice = 'use'; break }
      if (c === '2') { choice = 'new'; break }
      stderr.write(`error: please choose 1 or 2 (got ${JSON.stringify(raw)})\n`)
    }
    if (choice === 'use') {
      return useExistingConfig({
        config: existing, configPath: defaultCfgPath,
        stdout, stderr, prompt, platform, binPath,
        installGlobal: hooks.installGlobal,
        resolveGlobalBinPath: hooks.resolveGlobalBinPath,
        runInstall: hooks.runInstall,
      })
    }
  }

  return runSingleUserFlow({
    stdout, stderr, prompt, writeFile, platform, binPath, cwd,
    defaultCfgPath, defaultSink,
    installGlobal: hooks.installGlobal,
    resolveGlobalBinPath: hooks.resolveGlobalBinPath,
    runInstall: hooks.runInstall,
    runGascityBackfill: hooks.runGascityBackfill,
    hasGcBinary: hooks.hasGcBinary,
  })
}

/**
 * Minimal standalone walkthrough. Lets the operator choose which local
 * capture sources to enable, then asks only the details those sources need.
 * Proxy defaults to 127.0.0.1:8787 forwarding to Anthropic; OTLP defaults to
 * 127.0.0.1:4318; gascity tries to discover city roots from the current
 * workspace before falling back to manual city/API entry.
 *
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   writeFile: (path: string, contents: string) => void,
 *   platform: NodeJS.Platform,
 *   binPath: string,
 *   cwd: string,
 *   defaultCfgPath: string,
 *   defaultSink: string,
 *   installGlobal?: () => Promise<boolean>,
 *   resolveGlobalBinPath?: () => Promise<string>,
 *   runInstall?: (args: string[], hooks?: InstallHooks) => Promise<number>,
 *   runGascityBackfill?: (args: string[], hooks?: { stdout?: { write: (s: string) => void }, stderr?: { write: (s: string) => void } }) => Promise<number>,
 *   hasGcBinary?: () => boolean | Promise<boolean>,
 * }} args
 * @returns {Promise<number>}
 */
async function runSingleUserFlow(args) {
  const { stdout, stderr, prompt, writeFile, platform, binPath, cwd, defaultCfgPath, defaultSink } = args

  stdout.write('\nStandalone mode.\n')
  const hasGc = await detectGcBinary(args.hasGcBinary)
  const sources = await askStandaloneSources(prompt, stdout, stderr, hasGc)
  const hasClaudeCode = sources.includes('proxy')
  const hasGascity = sources.includes('gascity')
  const hasOtel = sources.includes('otel')

  stdout.write('\nWhere should collectivus write recordings? Each signal lands in a\n')
  stdout.write('per-day JSONL file under <sink>/<id>/<signal>/ (e.g. <id>/proxy/<date>.jsonl).\n\n')
  const sinkAns = (await prompt(`Sink directory [${defaultSink}]: `)).trim()
  const sinkDir = sinkAns === '' ? defaultSink : sinkAns

  /** @type {CollectivusConfig} */
  const config = {
    version: 1,
    sink: { type: 'file', dir: sinkDir },
    query: { cache: { enabled: true } },
  }
  /** @type {import('../gascity/types.d.ts').GascityCityConfig[]} */
  let gascityCities = []

  if (hasClaudeCode) {
    stdout.write('\nProxy capture will listen on 127.0.0.1:8787 and forward LLM\n')
    stdout.write('traffic to Anthropic. Edit the config later to switch upstreams.\n\n')
    const provider = PROVIDERS[0]
    config.proxy = {
      listen: SINGLE_PROXY_LISTEN,
      upstreams: [
        {
          name: provider.id,
          base_url: provider.baseUrl,
          match: { path_prefix: provider.prefix },
        },
      ],
      redact_headers: DEFAULT_REDACT,
    }
  }

  if (hasGascity) {
    gascityCities = await askGascityCities({ stdout, stderr, prompt, cwd })
    config.gascity = gascityCities
  }

  if (hasOtel) {
    stdout.write('\nOTLP receiver listens for OpenTelemetry logs, traces, and metrics\n')
    stdout.write('over HTTP. Apps with OTLP exporters point to this address.\n\n')
    const listenAns = (await prompt(`OTLP listen [${DEFAULT_OTEL_LISTEN}]: `)).trim()
    config.otel = { listen: listenAns === '' ? DEFAULT_OTEL_LISTEN : listenAns }
  }

  stdout.write('\n')
  const cfgPathAns = (await prompt(`Save config to [${defaultCfgPath}]: `)).trim()
  const cfgPath = cfgPathAns === '' ? defaultCfgPath : path.resolve(cwd, cfgPathAns)

  const written = await confirmAndWrite({ stdout, stderr, writeFile, config, cfgPath })
  if (!written) return 1
  if (gascityCities.length > 0) {
    const backfillCode = await offerGascityBackfill({
      cities: gascityCities,
      configPath: cfgPath,
      stdout, stderr, prompt,
      runBackfill: args.runGascityBackfill,
    })
    if (backfillCode !== 0) return backfillCode
  }

  return offerDaemonInstall({
    configPath: cfgPath, wantDaemon: true,
    stdout, stderr, platform, binPath,
    installGlobal: args.installGlobal,
    resolveGlobalBinPath: args.resolveGlobalBinPath,
    runInstall: args.runInstall,
    offerClaudeCode: hasClaudeCode,
  })
}

/**
 * Offer an explicit historical backfill step for newly configured gascity
 * supervisors. This is intentionally opt-in because `--all` asks the supervisor
 * for recoverable sessions and then replays each transcript.
 *
 * @param {{
 *   cities: import('../gascity/types.d.ts').GascityCityConfig[],
 *   configPath: string,
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   runBackfill?: (args: string[], hooks?: { stdout?: { write: (s: string) => void }, stderr?: { write: (s: string) => void } }) => Promise<number>,
 * }} args
 * @returns {Promise<number>}
 */
async function offerGascityBackfill(args) {
  const { cities, configPath, stdout, stderr, prompt } = args
  stdout.write('\nBackfill gascity history now?\n')
  stdout.write('  Yes -> asks each supervisor for all recoverable sessions and replays transcripts.\n')
  stdout.write('         This can take a while for large cities.\n')
  stdout.write('  No  -> starts capturing new and active sessions only; run\n')
  stdout.write('         `ctvs gascity backfill <city> --all` later.\n\n')
  const ans = (await prompt('Backfill all recoverable gascity sessions? [y/N]: ')).trim()
  if (!/^y(es)?$/i.test(ans)) return 0

  const runBackfill = args.runBackfill ?? await loadRunGascityBackfill()
  for (const city of cities) {
    const code = await runBackfill([city.name, '--all', '--config', configPath], { stdout, stderr })
    if (code !== 0) return code
  }
  return 0
}

/**
 * @typedef {'proxy' | 'gascity' | 'otel'} StandaloneSource
 */

/**
 * @typedef {object} StandaloneSourceOption
 * @property {StandaloneSource} id
 * @property {string} number
 * @property {string} label
 * @property {string} description
 * @property {readonly string[]} aliases
 */

/**
 * @param {(q: string) => Promise<string>} prompt
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @param {boolean} hasGcBinary
 * @returns {Promise<StandaloneSource[]>}
 */
async function askStandaloneSources(prompt, stdout, stderr, hasGcBinary) {
  const options = standaloneSourceOptions(hasGcBinary)
  stdout.write('\nWhat do you want to collect?\n\n')
  for (const option of options) {
    stdout.write(`  ${option.number}) ${option.label}\n`)
    stdout.write(`     ${option.description}\n\n`)
  }

  for (;;) {
    const raw = (await prompt('Collect [all]: ')).trim()
    const parsed = parseStandaloneSources(raw, options)
    if (parsed) return parsed
    stderr.write(`error: choose all or a comma-separated subset of: ${options.map((o) => o.number).join(', ')}\n`)
  }
}

/**
 * @param {boolean} hasGcBinary
 * @returns {StandaloneSourceOption[]}
 */
function standaloneSourceOptions(hasGcBinary) {
  /** @type {StandaloneSourceOption[]} */
  const options = [
    {
      id: 'otel',
      number: '1',
      label: 'OTEL',
      description: 'OpenTelemetry logs, traces, and metrics over HTTP.',
      aliases: ['otel', 'otlp', 'opentelemetry'],
    },
    {
      id: 'proxy',
      number: '2',
      label: 'Claude Code',
      description: 'Claude Code traffic through a localhost proxy.',
      aliases: ['claude', 'claudecode', 'claude-code', 'proxy', 'llm'],
    },
  ]
  if (hasGcBinary) {
    options.push({
      id: 'gascity',
      number: '3',
      label: 'Gascity',
      description: 'Agent-attributed transcripts from a gascity supervisor.',
      aliases: ['gascity', 'gas', 'gc', 'supervisor'],
    })
  }
  return options
}

/**
 * @param {string} raw
 * @param {StandaloneSourceOption[]} options
 * @returns {StandaloneSource[] | undefined}
 */
function parseStandaloneSources(raw, options) {
  const input = raw.trim()
  if (input === '' || input.toLowerCase() === 'all') return options.map((option) => option.id)

  let chunks = input.split(',').map((s) => s.trim()).filter(Boolean)
  if (chunks.length === 1 && /^[0-9\s]+$/.test(input)) {
    chunks = input.split(/\s+/).map((s) => s.trim()).filter(Boolean)
  }

  /** @type {Set<StandaloneSource>} */
  const out = new Set()
  for (const chunk of chunks) {
    const normalized = chunk.toLowerCase().replace(/[\s_-]+/g, '')
    if (normalized === 'all') return options.map((option) => option.id)
    const option = options.find((o) => {
      return normalized === o.number || o.aliases.some((alias) => normalized === alias.replace(/[\s_-]+/g, ''))
    })
    if (!option) return undefined
    out.add(option.id)
  }
  return out.size > 0 ? Array.from(out) : undefined
}

/**
 * @param {(() => boolean | Promise<boolean>) | undefined} hasGcBinary
 * @returns {Promise<boolean>}
 */
async function detectGcBinary(hasGcBinary) {
  if (hasGcBinary) return Boolean(await hasGcBinary())
  return commandExistsOnPath('gc')
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function commandExistsOnPath(name) {
  const pathValue = process.env.PATH ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      try {
        fs.accessSync(path.join(dir, `${name}${ext}`), fs.constants.X_OK)
        return true
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return false
}

/**
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   cwd: string,
 * }} args
 * @returns {Promise<import('../gascity/types.d.ts').GascityCityConfig[]>}
 */
async function askGascityCities(args) {
  const { stdout, stderr, prompt, cwd } = args
  stdout.write('\nGas city supervisor capture\n')
  stdout.write('Enter a city root or a parent directory. Press Enter to scan the current directory.\n')
  const searchAns = (await prompt(`Gas city search path [${cwd}]: `)).trim()
  const searchRoot = searchAns === '' ? cwd : path.resolve(cwd, searchAns)
  const discovered = await discoverGascityCityEntries(searchRoot)
  if (discovered.length > 0) {
    stdout.write('\nDiscovered gas city supervisors:\n')
    for (const city of discovered) {
      stdout.write(`  - ${city.name} (${city.api_url})\n`)
    }
    const addAns = (await prompt(`Add ${discovered.length === 1 ? 'this city' : 'these cities'}? [Y/n]: `)).trim()
    if (isYes(addAns)) {
      return askManualGascityCities({
        stdout, stderr, prompt, cwd,
        defaultTarget: searchRoot,
        initial: discovered,
      })
    }
  } else {
    stdout.write('No gas city supervisors were discovered from that path.\n')
  }
  return askManualGascityCities({ stdout, stderr, prompt, cwd, defaultTarget: searchRoot, initial: [] })
}

/**
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   cwd: string,
 *   defaultTarget: string,
 *   initial: import('../gascity/types.d.ts').GascityCityConfig[],
 * }} args
 * @returns {Promise<import('../gascity/types.d.ts').GascityCityConfig[]>}
 */
async function askManualGascityCities(args) {
  const { stdout, stderr, prompt, cwd, defaultTarget } = args
  /** @type {import('../gascity/types.d.ts').GascityCityConfig[]} */
  const cities = dedupeGascityCities(args.initial)

  for (;;) {
    if (cities.length > 0) {
      const more = (await prompt('Add another gas city? [y/N]: ')).trim()
      if (!/^y(es)?$/i.test(more)) return cities
    }

    const targetDefault = cities.length === 0 ? defaultTarget : ''
    const question = targetDefault
      ? `Gas city directory or name [${targetDefault}]: `
      : 'Gas city directory or name: '
    const targetAns = (await prompt(question)).trim()
    const target = targetAns === '' ? targetDefault : targetAns
    if (!target) {
      stderr.write('  city directory or name is required\n')
      continue
    }

    const resolvedTarget = resolvePromptPath(cwd, target)
    let entry
    try {
      entry = await resolveGascityCityEntry(resolvedTarget, undefined)
    } catch (err) {
      stderr.write(`  ${formatError(err)}\n`)
      continue
    }

    upsertGascityCity(cities, entry)
    stdout.write(`  Added ${entry.name} via ${entry.api_url}\n`)
  }
}

/**
 * @param {string} root
 * @returns {Promise<import('../gascity/types.d.ts').GascityCityConfig[]>}
 */
async function discoverGascityCityEntries(root) {
  const dirs = discoverGascityCityDirs(root)
  /** @type {import('../gascity/types.d.ts').GascityCityConfig[]} */
  const entries = []
  for (const dir of dirs) {
    try {
      const entry = await resolveGascityCityEntry(dir, undefined)
      upsertGascityCity(entries, entry)
    } catch {
      // A city.toml without an API hint can still be added manually below.
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function discoverGascityCityDirs(root) {
  /** @type {string[]} */
  const dirs = []
  if (hasCityToml(root)) dirs.push(root)
  let children
  try {
    children = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return dirs
  }
  for (const child of children) {
    if (!child.isDirectory()) continue
    const childDir = path.join(root, child.name)
    if (hasCityToml(childDir)) dirs.push(childDir)
  }
  dirs.sort()
  return dirs
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasCityToml(dir) {
  try {
    return fs.statSync(path.join(dir, 'city.toml')).isFile()
  } catch {
    return false
  }
}

/**
 * @param {string} cwd
 * @param {string} target
 * @returns {string}
 */
function resolvePromptPath(cwd, target) {
  if (path.isAbsolute(target)) return target
  const maybePath = path.resolve(cwd, target)
  try {
    if (fs.statSync(maybePath).isDirectory()) return maybePath
  } catch {
    // Treat it as a city name.
  }
  return target
}

/**
 * @param {string} target
 * @param {string | undefined} apiUrl
 * @returns {Promise<import('../gascity/types.d.ts').GascityCityConfig>}
 */
async function resolveGascityCityEntry(target, apiUrl) {
  const { resolveCityEntry } = await import('./gascity.js')
  return resolveCityEntry(target, apiUrl)
}

/**
 * @param {import('../gascity/types.d.ts').GascityCityConfig[]} cities
 * @param {import('../gascity/types.d.ts').GascityCityConfig} entry
 */
function upsertGascityCity(cities, entry) {
  const idx = cities.findIndex((city) => city.name === entry.name)
  if (idx === -1) {
    cities.push(entry)
  } else {
    cities[idx] = entry
  }
}

/**
 * @param {import('../gascity/types.d.ts').GascityCityConfig[]} entries
 * @returns {import('../gascity/types.d.ts').GascityCityConfig[]}
 */
function dedupeGascityCities(entries) {
  /** @type {import('../gascity/types.d.ts').GascityCityConfig[]} */
  const out = []
  for (const entry of entries) upsertGascityCity(out, entry)
  return out
}

/**
 * Write the config file. Returns true on success, false on error.
 *
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   writeFile: (path: string, contents: string) => void,
 *   config: CollectivusConfig,
 *   cfgPath: string,
 * }} args
 * @returns {Promise<boolean>}
 */
async function confirmAndWrite(args) {
  const { stdout, stderr, writeFile, config, cfgPath } = args
  const json = JSON.stringify(config, null, 2)
  try {
    writeFile(cfgPath, json + '\n')
    stdout.write(`\n✓ Wrote ${cfgPath}\n`)
    if (config.upload) {
      stdout.write('ⓘ Upload uses AWS env credentials or an ECS task role.\n')
      stdout.write('  Daemon will fail fast at start if no credential source is available.\n')
    }
    return true
  } catch (err) {
    stderr.write(`error: failed to write config: ${formatError(err)}\n`)
    return false
  }
}

/**
 * Optional S3 upload step. Asks `[y/N]` first; on `y` collects bucket /
 * region / prefix / time / signals / endpoint with re-prompt loops on
 * validation failure. Returns `undefined` when the user declines, so the
 * caller can omit the `upload` block entirely.
 *
 * The walkthrough deliberately does not expose `catchupDays` (defaults to
 * 30 in the uploader). Keeps the prompt count manageable. Power users
 * edit the JSON.
 *
 * Credentials are never collected here; the daemon resolves them from
 * environment variables at startup.
 *
 * @param {(q: string) => Promise<string>} prompt
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<UploadConfig | undefined>}
 */
async function askUpload(prompt, stdout, stderr) {
  const ans = (await prompt('\nUpload daily snapshots to S3 as Parquet? [y/N]: ')).trim()
  if (!/^y(es)?$/i.test(ans)) return undefined

  stdout.write('\nLocal JSONL stays put; once a day collectivus drains the previous day\'s\n')
  stdout.write('files to your S3 bucket as Parquet partitions. Useful for long-term\n')
  stdout.write('retention and querying with Athena / DuckDB.\n\n')

  /** @type {string} */
  let bucket
  for (;;) {
    const a = (await prompt('  S3 bucket: ')).trim()
    if (a !== '' && BUCKET_PATTERN.test(a)) { bucket = a; break }
    stderr.write('  bucket name must be 3–63 chars, lowercase, no underscores\n')
  }

  const regionAns = (await prompt(`  S3 region [${DEFAULT_UPLOAD_REGION}]: `)).trim()
  const region = regionAns === '' ? DEFAULT_UPLOAD_REGION : regionAns

  const prefixAns = (await prompt(`  Object prefix [${DEFAULT_UPLOAD_PREFIX}]: `)).trim()
  // Strip surrounding `/` so the user pasting `/foo/` gets the same key
  // layout as a clean `foo`. An input of just `/` collapses to empty,
  // which falls back to the default rather than emitting an empty
  // string (the validator rejects that).
  const trimmedPrefix = prefixAns.replace(/^\/+|\/+$/g, '')
  const prefix = trimmedPrefix === '' ? DEFAULT_UPLOAD_PREFIX : trimmedPrefix

  /** @type {string} */
  let time
  for (;;) {
    const a = (await prompt(`  Daily upload time UTC [${DEFAULT_UPLOAD_TIME}]: `)).trim()
    const v = a === '' ? DEFAULT_UPLOAD_TIME : a
    if (TIME_PATTERN.test(v)) { time = v; break }
    stderr.write('  time must be HH:MM (24-hour, 00:00–23:59)\n')
  }

  /** @type {import('../types.js').UploadSignal[]} */
  let signals
  for (;;) {
    const a = (await prompt(`  Signals to upload [${DEFAULT_UPLOAD_SIGNALS_INPUT}]: `)).trim()
    const raw = a === '' ? DEFAULT_UPLOAD_SIGNALS_INPUT : a
    const list = raw.split(',').map(function(s) { return s.trim() }).filter(function(s) { return s !== '' })
    /** @type {import('../types.js').UploadSignal[]} */
    const narrowed = []
    let bad = false
    for (const s of list) {
      const matched = ALLOWED_UPLOAD_SIGNALS.find(function(allowed) { return allowed === s })
      if (matched === undefined) { bad = true; break }
      narrowed.push(matched)
    }
    if (!bad && narrowed.length > 0) { signals = narrowed; break }
    stderr.write('  signals must be a comma-separated subset of: logs, traces, metrics, proxy\n')
  }

  /** @type {string | undefined} */
  let endpoint
  for (;;) {
    const a = (await prompt('  Custom S3 endpoint (MinIO etc.) []: ')).trim()
    if (a === '') { endpoint = undefined; break }
    try {
      new URL(a)
      endpoint = a
      break
    } catch {
      stderr.write('  endpoint must be a valid URL (e.g. https://minio.example.com)\n')
    }
  }

  stdout.write('\nNote: upload uses AWS env credentials or an ECS task role when the\n')
  stdout.write('daemon runs. The walkthrough will not store credentials in the config\n')
  stdout.write('file.\n')

  /** @type {UploadConfig} */
  const upload = { bucket, region, prefix, time, signals }
  if (endpoint !== undefined) upload.endpoint = endpoint
  return upload
}

/**
 * Install the background daemon when the platform supports it and the config
 * has a long-running Standalone listener.
 * Otherwise prints next-step hints.
 *
 * When invoked through npx, bootstraps the daemon install through the global
 * package before chaining into `ctvs install`.
 *
 * @param {{
 *   configPath: string,
 *   wantDaemon: boolean,
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   platform: NodeJS.Platform,
 *   binPath: string,
 *   installGlobal?: () => Promise<boolean>,
 *   resolveGlobalBinPath?: () => Promise<string>,
 *   runInstall?: (args: string[], hooks?: InstallHooks) => Promise<number>,
 *   offerClaudeCode: boolean,
 * }} args
 * @returns {Promise<number>}
 */
async function offerDaemonInstall(args) {
  const { configPath, wantDaemon, stdout, stderr, platform, binPath, offerClaudeCode } = args
  const viaNpx = isNpxBinPath(binPath)
  if (wantDaemon && (platform === 'darwin' || platform === 'linux')) {
    const daemonKind = platform === 'darwin' ? 'launchd LaunchAgent' : 'systemd user unit'
    stdout.write(`\nInstalling ctvs as a background daemon (${daemonKind})...\n`)
    let installBinPath = binPath
    if (viaNpx) {
      const installGlobal = args.installGlobal ?? installGlobalCollectivus
      const resolveGlobalBinPath = args.resolveGlobalBinPath ?? resolveGlobalCollectivusBinPath
      stdout.write('Installing collectivus globally with npm...\n')
      let installed
      try {
        installed = await installGlobal()
      } catch (err) {
        stderr.write(`error: failed to install collectivus globally: ${formatError(err)}\n`)
        return 1
      }
      if (!installed) {
        stderr.write('error: npm install -g collectivus failed\n')
        return 1
      }
      try {
        installBinPath = await resolveGlobalBinPath()
      } catch (err) {
        stderr.write(`error: failed to locate globally installed collectivus: ${formatError(err)}\n`)
        return 1
      }
    }
    const installFlag = offerClaudeCode ? '--yes' : '--no'
    const installArgs = ['--config', configPath, installFlag]
    const runInstallFn = args.runInstall ?? await loadRunInstall()
    return runInstallFn(installArgs, { stdout, stderr, binPath: installBinPath })
  }

  stdout.write('\nNext steps:\n')
  if (viaNpx) {
    stdout.write(`  npx collectivus --config ${configPath}\n`)
  } else {
    stdout.write(`  ctvs --config ${configPath}\n`)
  }
  if (wantDaemon && (platform === 'darwin' || platform === 'linux')) {
    if (viaNpx) {
      stdout.write('\nTo set up the background daemon later, run the walkthrough again:\n')
      stdout.write('  npx collectivus\n')
    } else {
      stdout.write(`  ctvs install --config ${configPath}   (run as a background daemon)\n`)
    }
  }
  return 0
}

/**
 * Reuse-existing branch: the user accepted the config we found at the default
 * path. Skip the question flow and jump to the daemon install offer (or hint
 * when the platform / config doesn't qualify).
 *
 * @param {{
 *   config: CollectivusConfig,
 *   configPath: string,
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   platform: NodeJS.Platform,
 *   binPath: string,
 *   installGlobal?: () => Promise<boolean>,
 *   resolveGlobalBinPath?: () => Promise<string>,
 *   runInstall?: (args: string[], hooks?: InstallHooks) => Promise<number>,
 * }} args
 * @returns {Promise<number>}
 */
function useExistingConfig(args) {
  const wantProxy = args.config.proxy !== undefined
  const role = args.config.role ?? 'standalone'
  const wantDaemon = role === 'standalone' && (
    args.config.proxy !== undefined ||
    args.config.otel !== undefined ||
    args.config.gascity !== undefined
  )
  return offerDaemonInstall({
    configPath: args.configPath, wantDaemon,
    stdout: args.stdout, stderr: args.stderr, platform: args.platform,
    binPath: args.binPath,
    installGlobal: args.installGlobal,
    resolveGlobalBinPath: args.resolveGlobalBinPath,
    runInstall: args.runInstall,
    offerClaudeCode: wantProxy,
  })
}

/**
 * Print a short, human-readable summary of an existing config so the user can
 * decide whether to reuse it. Intentionally not the full JSON dump; that's
 * what `--print-config` is for.
 *
 * @param {{ write: (s: string) => void }} stdout
 * @param {CollectivusConfig} config
 */
function printConfigSummary(stdout, config) {
  if (config.proxy) {
    const upstreams = config.proxy.upstreams ?? []
    const detail = upstreams
      .map(function(u) {
        const prefix = u?.match?.path_prefix ?? ''
        return `${u?.name ?? ''} → ${u?.base_url ?? ''}${prefix}`
      })
      .join(', ')
    stdout.write(`  proxy:  ${config.proxy.listen}${detail ? `  (${detail})` : ''}\n`)
  }
  if (config.otel) {
    stdout.write(`  otel:   ${config.otel.listen}\n`)
  }
  if (config.gascity) {
    const cities = config.gascity.map((c) => c.name).join(', ')
    stdout.write(`  gascity:${cities ? ` ${cities}` : ' no cities attached'}\n`)
  }
  if (config.sink) {
    stdout.write(`  sink:   ${config.sink.dir}\n`)
  }
  if (config.upload) {
    const u = config.upload
    const prefix = u.prefix ?? DEFAULT_UPLOAD_PREFIX
    const time = u.time ?? DEFAULT_UPLOAD_TIME
    stdout.write(`  upload: s3://${u.bucket}/${prefix} daily at ${time} UTC\n`)
  }
  if (config.query?.cache) {
    const enabled = config.query.cache.enabled !== false
    stdout.write(`  query:  query cache ${enabled ? 'enabled' : 'disabled'}\n`)
  }
}

/**
 * Read and parse a config file. Returns undefined when the file is missing or
 * unparseable; the walkthrough treats both as "no usable existing config" and
 * falls through to the question flow.
 *
 * @param {string} p
 * @returns {CollectivusConfig | undefined}
 */
function defaultReadConfig(p) {
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return
  }
  try {
    return JSON.parse(raw)
  } catch { /* ignore, fall through to undefined */ }
}

/**
 * @returns {Promise<(args: string[], hooks?: InstallHooks) => Promise<number>>}
 */
async function loadRunInstall() {
  const mod = await import('./install.js')
  return function(args, hooks) { return mod.runInstall(args, hooks) }
}

/**
 * @returns {Promise<(args: string[], hooks?: { stdout?: { write: (s: string) => void }, stderr?: { write: (s: string) => void } }) => Promise<number>>}
 */
async function loadRunGascityBackfill() {
  const mod = await import('./gascity.js')
  return function(args, hooks) { return mod.runBackfill(args, hooks) }
}

/**
 * @param {string} p
 * @param {string} contents
 */
function defaultWriteFile(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
}

/**
 * Empty input is treated as "yes" so users can press Enter to accept the
 * default in `[Y/n]` prompts.
 *
 * @param {string} s
 * @returns {boolean}
 */
function isYes(s) {
  if (s === '') return true
  return /^y(es)?$/i.test(s)
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Walkthrough sub-flow for central server (`role: server`) deployments. The server vendors
 * per-gateway configs and accepts ingest. Operators do not point apps at this
 * binary directly (there is no proxy listener), so the daemon-install offer
 * is intentionally skipped.
 *
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   cwd: string,
 *   defaultCfgPath: string,
 *   writeFile: (p: string, contents: string) => void,
 * }} args
 * @returns {Promise<number>}
 */
async function runServerFlow(args) {
  const { stdout, stderr, prompt, cwd, defaultCfgPath, writeFile } = args

  stdout.write('\nCentral server mode.\n')
  stdout.write('This binary will run the central-server HTTP listener that\n')
  stdout.write('vendors per-gateway configs and accepts ingest from gateways.\n')

  stdout.write('\nWhere should the control plane listen? Gateways will reach this\n')
  stdout.write('address; 0.0.0.0 listens on all interfaces.\n\n')
  const listenAns = (await prompt(`Central server listen [${DEFAULT_CONTROL_PLANE_LISTEN}]: `)).trim()
  const controlPlaneListen = listenAns === '' ? DEFAULT_CONTROL_PLANE_LISTEN : listenAns

  const defaultPublicUrl = publicUrlDefault(controlPlaneListen)
  stdout.write('\nWhat URL will gateways use to reach this server? For ECS/Docker,\n')
  stdout.write('use the load balancer or service URL, not 0.0.0.0.\n\n')
  const publicUrl = await askUrlWithDefault({
    prompt,
    stderr,
    question: `Gateway-facing URL [${defaultPublicUrl}]: `,
    defaultValue: defaultPublicUrl,
  })

  // The data_dir prompt is the B.5 acceptance touchpoint: the registry stores
  // per-gateway configs under <data_dir>/configs/, and the bootstrap-token
  // store lives under it too unless overridden.
  const defaultDataDir = defaultServerDataDir()
  stdout.write('\nWhere should server-side state live? Per-gateway config files land\n')
  stdout.write('under <data_dir>/configs/ and the bootstrap-token store defaults to\n')
  stdout.write('<data_dir>/bootstrap.json.\n\n')
  const dataDirAns = (await prompt(`Server data directory [${defaultDataDir}]: `)).trim()
  const dataDir = dataDirAns === '' ? defaultDataDir : dataDirAns

  // 32-byte random secret is the validator floor (IDENTITY_SECRET_MIN_LENGTH).
  // Auto-generate by default; typing 64 hex chars at a prompt is a footgun.
  const generatedSecret = crypto.randomBytes(IDENTITY_SECRET_BYTES).toString('hex')
  stdout.write('\nThe server signs gateway JWTs with an HMAC secret. Pressing Enter\n')
  stdout.write('uses a freshly generated 32-byte random hex value (recommended); paste\n')
  stdout.write('an existing secret only if you are migrating from another host.\n\n')
  const secretAns = (await prompt('Identity-issuer secret []: ')).trim()
  /** @type {string} */
  let secret
  if (secretAns === '') {
    secret = generatedSecret
  } else if (secretAns.length < IDENTITY_SECRET_BYTES) {
    stderr.write(`warning: secret shorter than ${IDENTITY_SECRET_BYTES} chars; using generated value instead\n`)
    secret = generatedSecret
  } else {
    secret = secretAns
  }

  const bootstrapStorePath = path.join(dataDir, 'bootstrap.json')
  const sinkDir = path.join(dataDir, 'ingested')

  /** @type {ServerConfig} */
  const serverBlock = {
    control_plane_listen: controlPlaneListen,
    public_url: publicUrl,
    identity_issuer: { secret, bootstrap_store_path: bootstrapStorePath },
    data_dir: dataDir,
    sink_dir: sinkDir,
  }
  /** @type {CollectivusConfig} */
  const config = {
    version: 1,
    role: 'server',
    server: serverBlock,
    query: { cache: { enabled: true } },
  }

  // Optional upload. Central server mode drains the multi-tenant ingest spool to S3.
  const upload = await askUpload(prompt, stdout, stderr)
  if (upload) config.upload = upload

  stdout.write('\n')
  const cfgPath = await askSavePath(prompt, cwd, defaultCfgPath)
  if (!await confirmAndWrite({ stdout, stderr, cfgPath, config, writeFile })) return 1

  if (secretAns === '') {
    stdout.write('\nGenerated identity-issuer secret was written to the config file.\n')
    stdout.write(`Back up ${cfgPath} or copy the secret to a password manager;\n`)
    stdout.write('rotating it forces every gateway to re-bootstrap.\n')
  }

  stdout.write('\nStart the central server:\n')
  stdout.write(`  npx collectivus --config ${cfgPath}\n`)
  stdout.write(`  ctvs --config ${cfgPath}    (after npm install -g collectivus)\n`)
  stdout.write('  Docker/ECS: run the collectivus image with this config and data_dir mounted,\n')
  stdout.write('              then pass --config <container-config-path>.\n\n')
  stdout.write('Provision each gateway:\n')
  stdout.write(`  ctvs config bootstrap-token issue <gateway-id> --server-config ${cfgPath}\n`)
  stdout.write('     (prints a one-shot token and the one-line npx setup command)\n')
  stdout.write(`  npx collectivus --config-endpoint='${bootstrapConfigUrlTemplate(publicUrl)}'\n`)
  stdout.write(`  ctvs config set <gateway-id> --server-config ${cfgPath} --file <gateway-config.json>\n`)
  stdout.write('     (registers the per-gateway config the gateway will pull)\n')
  return 0
}

/**
 * @param {{
 *   prompt: (q: string) => Promise<string>,
 *   stderr: { write: (s: string) => void },
 *   question: string,
 *   defaultValue: string,
 * }} args
 * @returns {Promise<string>}
 */
async function askUrlWithDefault(args) {
  for (;;) {
    const raw = (await args.prompt(args.question)).trim()
    const value = normalizeUrl(raw === '' ? args.defaultValue : raw)
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
      return value
    } catch {
      args.stderr.write('  url must be an http(s) URL (e.g. https://collectivus.example.com:8788)\n')
    }
  }
}

/**
 * @param {string} listen
 * @returns {string}
 */
function publicUrlDefault(listen) {
  const { host, port } = parseListenAddress(listen)
  const publicHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host
  return `http://${formatUrlHost(publicHost)}:${port}`
}

/**
 * @param {string} publicUrl
 * @returns {string}
 */
function bootstrapConfigUrlTemplate(publicUrl) {
  return `${normalizeUrl(publicUrl)}/v1/bootstrap-config?token=<bootstrap-token>`
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeUrl(value) {
  return value.replace(/\/+$/, '')
}

/**
 * @param {string} value
 * @returns {{ host: string, port: number }}
 */
function parseListenAddress(value) {
  let host
  let portStr
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    host = close === -1 ? value : value.slice(1, close)
    portStr = close === -1 ? '' : value.slice(close + 2)
  } else {
    const colon = value.lastIndexOf(':')
    host = colon === -1 ? value : value.slice(0, colon)
    portStr = colon === -1 ? '' : value.slice(colon + 1)
  }
  const port = Number.parseInt(portStr, 10)
  return {
    host: host || 'localhost',
    port: Number.isInteger(port) ? port : 8788,
  }
}

/**
 * @param {string} host
 * @returns {string}
 */
function formatUrlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * Prompt for the save path. Returns the resolved absolute path.
 *
 * @param {(q: string) => Promise<string>} prompt
 * @param {string} cwd
 * @param {string} defaultPath
 * @returns {Promise<string>}
 */
async function askSavePath(prompt, cwd, defaultPath) {
  const ans = (await prompt(`Save config to [${defaultPath}]: `)).trim()
  return ans === '' ? defaultPath : path.resolve(cwd, ans)
}

/**
 * CLI subcommand entry point for `ctvs init [...args]`.
 *
 * Routing:
 * - `ctvs init server` → run the Central server walkthrough.
 * - `ctvs init <preset>` → dispatches to the named preset (e.g. gascity).
 * - `ctvs init` (no args) → runs the existing interactive walkthrough via `runInit`.
 * - `ctvs init --help` → prints subcommand usage including available presets.
 *
 * @param {string[]} argv
 * @param {InitHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runInitSubcommand(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const first = argv[0]

  if (first === '--help' || first === '-h') {
    stdout.write(initSubcommandUsage() + '\n')
    return 0
  }

  if (first === 'server') {
    return runServerFlow({
      stdout,
      stderr,
      prompt: hooks.prompt ?? defaultPrompt,
      cwd: hooks.cwd ?? process.cwd(),
      defaultCfgPath: hooks.defaultConfigPath ?? defaultConfigPath(),
      writeFile: hooks.writeFile ?? defaultWriteFile,
    })
  }

  if (first && !first.startsWith('-')) {
    if (!isInitPreset(first)) {
      stderr.write(`error: unknown init preset: ${first}\n\n${initSubcommandUsage()}\n`)
      return 2
    }
    const preset = getInitPreset(first)
    if (!preset) {
      stderr.write(`error: unknown init preset: ${first}\n`)
      return 2
    }
    return preset.run(argv.slice(1), hooks)
  }

  return runInit(hooks)
}

/**
 * @returns {string}
 */
function initSubcommandUsage() {
  const presets = listInitPresets()
    .map((p) => `  ${p.name.padEnd(12)} ${p.description}`)
    .join('\n')
  return `Usage:
  ctvs init                 Interactive Collectivus config walkthrough
  ctvs init server          Central server config walkthrough
  ctvs init <preset>        Run a named preset scaffolder
  ctvs init --help          Show this help

Presets:
${presets}`
}
