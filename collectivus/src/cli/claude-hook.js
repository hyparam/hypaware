import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const USAGE = `Usage:
  ctvs claude-hook session-context --port <n>

Internal command used by Claude Code hooks installed by \`ctvs attach\`.`

/**
 * @param {string[]} argv
 * @param {{
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   fetch?: typeof fetch,
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function runClaudeHook(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const fetchFn = hooks.fetch ?? fetch
  const parsed = parseArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  const input = await readStdin(hooks.stdin ?? process.stdin)
  /** @type {Record<string, unknown>} */
  let event
  try {
    const parsedEvent = JSON.parse(input || '{}')
    event = parsedEvent && typeof parsedEvent === 'object'
      ? /** @type {Record<string, unknown>} */ (parsedEvent)
      : {}
  } catch {
    return 0
  }

  const sessionId = stringValue(event.session_id)
  const cwd = stringValue(event.new_cwd) ?? stringValue(event.cwd)
  if (!sessionId || !cwd) return 0
  const gitBranch = await currentGitBranch(cwd)

  try {
    await fetchFn(`http://127.0.0.1:${parsed.port}/_collectivus/session-context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        cwd,
        ...(gitBranch ? { git_branch: gitBranch } : {}),
      }),
    })
  } catch {
    // Hooks must never interrupt Claude Code; missing/stopped proxy just means
    // this turn won't have local context in the recording.
  }
  return 0
}

/**
 * @param {string[]} argv
 * @returns {{ help?: boolean, port?: number, error?: string }}
 */
export function parseArgs(argv) {
  /** @type {{ help?: boolean, port?: number, error?: string }} */
  const out = {}
  const command = argv[0]
  if (command === '--help' || command === '-h') return { help: true }
  if (command !== 'session-context') return { error: 'expected command: session-context' }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? argv[++i] : arg.slice('--port='.length)
      if (!value) return { error: '--port requires a number' }
      if (!/^\d+$/.test(value)) return { error: `--port: not a valid port (got "${value}")` }
      const port = Number.parseInt(value, 10)
      if (port < 1 || port > 65535) return { error: `--port: not a valid port (got "${value}")` }
      out.port = port
      continue
    }
    return { error: `unknown argument: ${arg}` }
  }
  if (out.port === undefined) return { error: '--port is required' }
  return out
}

/**
 * @param {NodeJS.ReadStream} stdin
 * @returns {Promise<string>}
 */
function readStdin(stdin) {
  stdin.setEncoding('utf8')
  return new Promise((resolve) => {
    let data = ''
    stdin.on('data', (chunk) => { data += chunk })
    stdin.on('end', () => resolve(data))
    stdin.on('error', () => resolve(''))
  })
}

/**
 * @param {string} cwd
 * @returns {Promise<string | undefined>}
 */
async function currentGitBranch(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 1000 })
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
  } catch {
    return undefined
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { timeout: 1000 })
    const commit = stdout.trim()
    return commit || undefined
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
