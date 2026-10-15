// @ts-check

// docs/MCP.md hands each client a copy-paste config block. A block that fails
// to parse, uses a key its client does not read, or names a command `hyp` does
// not serve fails silently in the client: the server just never shows up.
// These parse every marked block, check its keys against what that client
// documents, and run the stdio form's command through `initialize` and
// `tools/list` against the real CLI. A connection from each real client stays
// a human check.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = path.join(REPO_ROOT, 'bin', 'hypaware.js')
const PAGE = readFileSync(path.join(REPO_ROOT, 'docs', 'MCP.md'), 'utf8')

const REMOTE_URL = 'https://api.hypaware.ai/v1/mcp'
const STDIO_ARGS = ['mcp', 'serve']

/**
 * Each client's documented keys: the top-level container, the keys a server
 * entry may carry for each transport, and the ones the block must set.
 * Sources: Claude Code `.mcp.json`, Cursor `mcp.json`, VS Code `mcp.json`,
 * Claude Desktop `claude_desktop_config.json`, Codex `config.toml`
 * `[mcp_servers.<name>]`, Devin's custom MCP settings.
 *
 * @type {Record<string, { container: string|null, stdio?: { allowed: string[], required: string[] }, remote?: { allowed: string[], required: string[] } }>}
 */
const SCHEMAS = {
  'claude-code': {
    container: 'mcpServers',
    stdio: { allowed: ['type', 'command', 'args', 'env'], required: ['command', 'args'] },
    remote: { allowed: ['type', 'url', 'headers'], required: ['type', 'url', 'headers'] },
  },
  cursor: {
    container: 'mcpServers',
    stdio: { allowed: ['type', 'command', 'args', 'env', 'envFile'], required: ['command', 'args'] },
    remote: { allowed: ['url', 'headers', 'auth'], required: ['url', 'headers'] },
  },
  vscode: {
    container: 'servers',
    stdio: { allowed: ['type', 'command', 'args', 'env', 'envFile'], required: ['type', 'command', 'args'] },
    remote: { allowed: ['type', 'url', 'headers'], required: ['type', 'url', 'headers'] },
  },
  'claude-desktop': {
    container: 'mcpServers',
    stdio: { allowed: ['command', 'args', 'env'], required: ['command', 'args'] },
  },
  codex: {
    container: 'mcp_servers',
    stdio: { allowed: ['command', 'args', 'env', 'env_vars', 'cwd'], required: ['command', 'args'] },
    remote: {
      allowed: ['url', 'bearer_token_env_var', 'http_headers', 'env_http_headers'],
      required: ['url', 'bearer_token_env_var'],
    },
  },
  devin: {
    container: null,
    remote: { allowed: ['transport', 'url', 'auth_method', 'headers'], required: ['transport', 'url', 'auth_method', 'headers'] },
  },
}

/**
 * Every `<!-- mcp-config: <client> <stdio|remote> -->` marker and the fenced
 * block right below it.
 *
 * @returns {{ client: string, kind: 'stdio'|'remote', lang: string, body: string }[]}
 */
function markedBlocks() {
  const re = /<!-- mcp-config: ([a-z-]+) (stdio|remote) -->\n```(json|toml)\n([\s\S]*?)\n```/g
  const out = []
  for (const m of PAGE.matchAll(re)) {
    out.push({ client: m[1], kind: /** @type {'stdio'|'remote'} */ (m[2]), lang: m[3], body: m[4] })
  }
  return out
}

/**
 * The TOML the Codex blocks use: `[a.b]` tables of `key = <JSON-compatible
 * value>` lines. Anything else fails the test rather than being skipped.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseTomlSubset(text) {
  /** @type {Record<string, any>} */
  const root = {}
  /** @type {Record<string, any>|null} */
  let table = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const header = line.match(/^\[([A-Za-z0-9_.-]+)\]$/)
    if (header) {
      /** @type {Record<string, any>} */
      let at = root
      for (const part of header[1].split('.')) at = at[part] ??= {}
      table = at
      continue
    }
    const pair = line.match(/^([A-Za-z0-9_-]+) = (.+)$/)
    assert.ok(pair && table, `unparseable TOML line: ${line}`)
    table[pair[1]] = JSON.parse(pair[2])
  }
  return root
}

/**
 * The single server entry a block defines, unwrapped from its container.
 *
 * @param {{ client: string, lang: string, body: string }} block
 * @returns {Record<string, any>}
 */
function serverEntry(block) {
  const doc = block.lang === 'toml' ? parseTomlSubset(block.body) : JSON.parse(block.body)
  const container = SCHEMAS[block.client].container
  if (container === null) return doc
  assert.ok(doc[container], `${block.client}: block has no top-level '${container}'`)
  const names = Object.keys(doc[container])
  assert.deepEqual(names, ['hypaware'], `${block.client}: one server named 'hypaware'`)
  return doc[container].hypaware
}

// @ref LLP 0494#docs-mcp [tests]: one block per client, keys checked against that client's documented schema
test('docs/MCP.md has a config block for each client named in the design', () => {
  const seen = new Set(markedBlocks().map((b) => b.client))
  assert.deepEqual([...seen].sort(), Object.keys(SCHEMAS).sort())
  for (const [client, schema] of Object.entries(SCHEMAS)) {
    for (const kind of /** @type {const} */ (['stdio', 'remote'])) {
      const has = markedBlocks().some((b) => b.client === client && b.kind === kind)
      assert.equal(has, Boolean(schema[kind]), `${client} ${kind} block`)
    }
  }
})

test('every config block parses and uses only its client\'s documented keys', () => {
  for (const block of markedBlocks()) {
    const schema = SCHEMAS[block.client][block.kind]
    assert.ok(schema, `${block.client} documents no ${block.kind} form`)
    const entry = serverEntry(block)
    const label = `${block.client} ${block.kind}`
    for (const key of Object.keys(entry)) {
      assert.ok(schema.allowed.includes(key), `${label}: '${key}' is not a documented key`)
    }
    for (const key of schema.required) {
      assert.ok(key in entry, `${label}: missing '${key}'`)
    }
    if (block.kind === 'stdio') {
      assert.equal(entry.command, 'hyp', `${label}: command`)
      assert.deepEqual(entry.args, STDIO_ARGS, `${label}: args`)
      if ('type' in entry) assert.equal(entry.type, 'stdio', `${label}: type`)
    } else {
      assert.equal(entry.url, REMOTE_URL, `${label}: url`)
      if (entry.headers) {
        assert.deepEqual(Object.keys(entry.headers), ['Authorization'], `${label}: headers`)
        assert.match(entry.headers.Authorization, /^Bearer \S/, `${label}: bearer header`)
      }
    }
  }
})

test('client-specific remote forms match what each client reads', () => {
  /** @param {string} client */
  const remote = (client) => serverEntry(/** @type {any} */ (markedBlocks().find((b) => b.client === client && b.kind === 'remote')))
  assert.equal(remote('claude-code').type, 'http')
  assert.equal(remote('claude-code').headers.Authorization, 'Bearer ${HYPAWARE_AGENT_TOKEN}')
  assert.equal(remote('cursor').headers.Authorization, 'Bearer ${env:HYPAWARE_AGENT_TOKEN}')
  assert.equal(remote('codex').bearer_token_env_var, 'HYPAWARE_AGENT_TOKEN')
  assert.deepEqual(
    { transport: remote('devin').transport, auth_method: remote('devin').auth_method },
    { transport: 'HTTP', auth_method: 'auth_header' },
  )

  // VS Code resolves `${input:<id>}` against the same file's `inputs`.
  const vsBlock = markedBlocks().find((b) => b.client === 'vscode' && b.kind === 'remote')
  const vsDoc = JSON.parse(/** @type {any} */ (vsBlock).body)
  const ref = remote('vscode').headers.Authorization.match(/\$\{input:([^}]+)\}/)
  assert.ok(ref, 'vscode remote header reads an input')
  const input = vsDoc.inputs.find((/** @type {any} */ i) => i.id === ref[1])
  assert.deepEqual({ type: input?.type, password: input?.password }, { type: 'promptString', password: true })
})

// @ref LLP 0494#cli-mint [tests]: the page states the token's reach in the mint reminder's plain words, as the minter
test('the page names the mint, the token\'s reach, and the mark tool as not yet live', () => {
  assert.match(PAGE, /hyp remote mint --scope query --label /)
  assert.match(PAGE, /hyp remote tokens revoke <jti>/)
  assert.match(PAGE, /acts \*\*as you\*\*, the person who minted it/)
  for (const can of ['mark a recommendation\'s status', 'publish reports', 'delete any report']) {
    assert.ok(PAGE.includes(can), `token can: ${can}`)
  }
  // The mark tool ships with a later server release; the page must not call it live.
  assert.match(PAGE, /`set_recommendation_status` tool, which comes with an\s+upcoming server release/)
})

// @ref LLP 0494#docs-order [tests]: gate step 1, no published page links MCP.md before the README row lands
test('no published docs page links MCP.md yet', async () => {
  const docsDir = path.join(REPO_ROOT, 'docs')
  for (const name of await fs.readdir(docsDir)) {
    if (!name.endsWith('.md') || name === 'MCP.md') continue
    const text = await fs.readFile(path.join(docsDir, name), 'utf8')
    assert.ok(!/\(\.?\/?MCP\.md[)#]/.test(text), `docs/${name} links MCP.md`)
  }
})

/**
 * Speak newline-delimited JSON-RPC to `hyp mcp serve` in a bare HYP_HOME, as a
 * client would: initialize, the initialized notification, then tools/list.
 *
 * @param {string} hypHome
 * @param {string[]} args
 * @returns {Promise<{ init: any, list: any }>}
 */
function handshake(hypHome, args) {
  /** @type {Record<string, string|undefined>} */
  const env = { ...process.env, HYP_HOME: hypHome }
  delete env.HYP_CONFIG
  delete env.HYP_DEV_TELEMETRY
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete env.DEV_RUN_ID
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  /** @type {Map<number, any>} */
  const replies = new Map()
  let buf = ''
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`no tools/list reply within 20s; stderr: ${stderr}`))
    }, 20000)
    child.on('exit', (code) => {
      if (replies.has(2)) return
      clearTimeout(timer)
      reject(new Error(`hyp ${args.join(' ')} exited ${code} before tools/list; stderr: ${stderr}`))
    })
    child.stdout.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        replies.set(msg.id, msg)
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
        } else if (msg.id === 2) {
          clearTimeout(timer)
          child.stdin.end()
          child.kill()
          resolve({ init: replies.get(1), list: msg })
        }
      }
    })
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'docs-mcp-configs-test', version: '0' },
      },
    }) + '\n')
  })
}

// @ref LLP 0494#docs-mcp [tests]: the stdio form's command/args run against hyp mcp serve through initialize and tools/list
test('the stdio command every block names answers initialize and tools/list', async () => {
  const forms = new Set(markedBlocks().filter((b) => b.kind === 'stdio').map((b) => JSON.stringify(serverEntry(b).args)))
  assert.deepEqual([...forms], [JSON.stringify(STDIO_ARGS)])

  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-docs-mcp-'))
  try {
    const { init, list } = await handshake(hypHome, STDIO_ARGS)
    assert.equal(init.result?.serverInfo?.name, 'hypaware', JSON.stringify(init))
    const names = (list.result?.tools ?? []).map((/** @type {any} */ t) => t.name)
    assert.ok(names.includes('query_sql'), `tools/list: ${names.join(', ')}`)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
