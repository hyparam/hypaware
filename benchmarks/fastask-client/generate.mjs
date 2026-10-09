// @ts-check

// Synthetic team graph generations for the fastask client benchmarks
// (LLP 0481 T6 and T11): snapshot-shaped gzipped NDJSON in contract column
// order, at the measured graph's shape, and a manifest measured with the
// contract module so a client verifies it like a served generation.
// Synthetic data only: no organization data, paths or credentials.

import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

import { EDGE_COLUMNS, NODE_COLUMNS, encodeLine, measureFile } from '../../hypaware-core/plugins-workspace/graph-cache/src/contract.js'

/** The measured graph (LLP 0480#index). */
export const MEASURED_NODES = 142_766
export const MEASURED_EDGES = 462_042

/**
 * Deterministic PRNG (mulberry32).
 *
 * @param {number} seed
 */
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const COMMON = ['index.js', 'README.md', 'utils.ts', 'package.json', 'config.js', 'main.go', 'test.js', 'types.d.ts', 'login.js', 'server.js']
const WORDS = ['auth', 'login', 'session', 'parser', 'budget', 'cache', 'query', 'graph', 'sync', 'replica', 'token', 'retry', 'export', 'sink', 'source', 'daemon', 'status', 'evidence', 'index', 'build']
const DIRS = ['src', 'lib', 'test', 'docs', 'scripts', 'src/core', 'src/util', 'src/cli', 'pkg', 'internal']
const EXTS = ['js', 'ts', 'md', 'go', 'py', 'json']

/**
 * Writes a snapshot-shaped generation (gzipped NDJSON in contract column
 * order) plus a set of discovery questions over it. Shape follows the
 * measured graph: about 6% Sessions with full props, 43% Files (bridged
 * `owner/repo:path` keys, a fifth absolute paths), the rest Commits,
 * Programs, Tools, Repos and so on; about two thirds of edges are `touched`
 * with a skewed popularity, the rest the other session edges. A small share
 * of edges point at absent nodes.
 *
 * @param {string} dir
 * @param {number} nodeCount
 * @param {number} edgeCount
 * @param {number} [seed] a different seed gives a different generation of the same size
 */
export async function generate(dir, nodeCount, edgeCount, seed = nodeCount) {
  fs.mkdirSync(dir, { recursive: true })
  const rand = prng(seed)
  const pick = (/** @type {any[]} */ list) => list[Math.floor(rand() * list.length)]
  const sessions = Math.round(nodeCount * 0.042)
  const files = Math.round(nodeCount * 0.427)
  const repos = Math.max(50, Math.round(nodeCount / 476))
  const users = Math.max(10, Math.round(sessions / 60))
  const others = nodeCount - sessions - files - repos
  const t0 = Date.UTC(2025, 9, 1)
  const span = 365 * 86_400_000

  /** @type {string[]} */
  const fileKeys = []
  /** @type {Array<{ q: string, repo: string | null }>} */
  const askable = []

  async function* nodeLines() {
    for (let r = 0; r < repos; r++) {
      yield line({ node_id: `repo${r}`, node_type: 'Repo', natural_key: `org${r % 97}/repo${r}`, label: `org${r % 97}/repo${r}`, props: null, first_seen: t0, source_dataset: 'ai_gateway_messages', source_keys: { git_remote: `https://github.com/org${r % 97}/repo${r}.git` }, projector: 'ai-gateway.t0', projector_version: 3 }, NODE_COLUMNS)
    }
    for (let s = 0; s < sessions; s++) {
      const r = Math.floor(rand() * repos)
      yield line({
        node_id: `s${s}`, node_type: 'Session', natural_key: `session-${s.toString(16).padStart(8, '0')}-4c1e-9a2b-${(s * 7919).toString(16).padStart(12, '0')}`, label: `session ${s}`,
        props: { cwd: `/home/user${s % users}/work/repo${r}`, git_branch: pick(['main', 'dev', `feature/${pick(WORDS)}`]), client_name: pick(['claude-code', 'codex', 'cursor']), user_id: `user-${s % users}` },
        first_seen: t0 + Math.floor(rand() * span), source_dataset: 'ai_gateway_messages', source_keys: { session_id: `s${s}` }, projector: 'ai-gateway.t0', projector_version: 3,
      }, NODE_COLUMNS)
    }
    for (let f = 0; f < files; f++) {
      const r = Math.floor(rand() * repos)
      const name = rand() < 0.15 ? pick(COMMON) : `${pick(WORDS)}_${pick(WORDS)}${f % 13}.${pick(EXTS)}`
      const rel = `${pick(DIRS)}/${rand() < 0.5 ? `${pick(WORDS)}/` : ''}${name}`
      const key = rand() < 0.2 ? `/home/user${f % users}/work/repo${r}/${rel}` : `org${r % 97}/repo${r}:${rel}`
      fileKeys.push(key)
      if (askable.length < 400 && rand() < 0.02) askable.push({ q: `why is ${name} shaped this way in the ${pick(WORDS)} code`, repo: rand() < 0.5 ? `org${r % 97}/repo${r}` : null })
      yield line({ node_id: `f${f}`, node_type: 'File', natural_key: key, label: name, props: {}, first_seen: t0 + Math.floor(rand() * span), source_dataset: 'ai_gateway_messages', source_keys: { file_path: `/home/u/${rel}` }, projector: 'ai-gateway.t0', projector_version: 3 }, NODE_COLUMNS)
    }
    const kinds = ['Commit', 'Program', 'Tool', 'Skill', 'App', 'Model', 'PullRequest']
    for (let o = 0; o < others; o++) {
      const type = o < others * 0.55 ? 'Commit' : o < others * 0.85 ? 'Program' : pick(kinds)
      const key = type === 'Commit' ? (o * 2654435761 >>> 0).toString(16).padStart(40, 'a') : `${type.toLowerCase()}-${o}`
      yield line({ node_id: `o${o}`, node_type: type, natural_key: key, label: type === 'Commit' ? key.slice(0, 12) : key, props: null, first_seen: t0 + Math.floor(rand() * span), source_dataset: 'ai_gateway_messages', source_keys: null, projector: 'ai-gateway.t0', projector_version: 3 }, NODE_COLUMNS)
    }
  }

  async function* edgeLines() {
    const touched = Math.round(edgeCount * 0.66)
    for (let e = 0; e < edgeCount; e++) {
      const s = Math.floor(rand() * sessions)
      const at = t0 + Math.floor(rand() * span)
      // A small share of edges name a session the node file does not carry.
      const src = rand() < 0.002 ? `missing-s${e}` : `s${s}`
      if (e < touched) {
        // Skewed popularity: a few files are touched by many sessions.
        const f = Math.floor(files * rand() ** 3)
        yield line({ edge_id: `e${e}`, edge_type: 'touched', src_id: src, dst_id: `f${f}`, src_type: 'Session', dst_type: 'File', props: null, first_seen: at, source_dataset: 'ai_gateway_messages', source_keys: rand() < 0.1 ? { session_id: `s${s}`, message_id: `msg-${e}` } : { session_id: `s${s}`, file_path: `/home/u/${fileKeys[f]}` }, projector: 'ai-gateway.t0', projector_version: 3 }, EDGE_COLUMNS)
      } else {
        const type = pick(['used', 'in', 'at', 'invoked', 'via', 'used_model', 'ran'])
        const dst = type === 'in' ? `repo${Math.floor(rand() * repos)}` : `o${Math.floor(rand() * others)}`
        yield line({ edge_id: `e${e}`, edge_type: type, src_id: src, dst_id: dst, src_type: 'Session', dst_type: type === 'in' ? 'Repo' : 'Commit', props: null, first_seen: at, source_dataset: 'ai_gateway_messages', source_keys: { session_id: `s${s}` }, projector: 'ai-gateway.t0', projector_version: 3 }, EDGE_COLUMNS)
      }
    }
  }

  await pipeline(() => batched(nodeLines()), createGzip(), fs.createWriteStream(path.join(dir, 'nodes.ndjson.gz')))
  await pipeline(() => batched(edgeLines()), createGzip(), fs.createWriteStream(path.join(dir, 'edges.ndjson.gz')))
  const words = askable.length ? askable : [{ q: 'login', repo: null }]
  const questions = words.map(({ q, repo }) => ({ question: q, repo }))
  fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(questions))
  const manifest = { files: { nodes: { rows: nodeCount }, edges: { rows: edgeCount } } }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  const gzBytes = fs.statSync(path.join(dir, 'nodes.ndjson.gz')).size + fs.statSync(path.join(dir, 'edges.ndjson.gz')).size
  return { gzBytes }
}

/**
 * Joins lines into writes of about 64 KB.
 *
 * @param {AsyncIterable<string>} lines
 */
async function* batched(lines) {
  let buffer = ''
  for await (const text of lines) {
    buffer += text
    if (buffer.length >= 65_536) {
      yield buffer
      buffer = ''
    }
  }
  if (buffer) yield buffer
}

/**
 * @param {Record<string, unknown>} row
 * @param {ReadonlyArray<string>} columns
 */
function line(row, columns) {
  return `${encodeLine(row, columns)}\n`
}

/**
 * The manifest a server would publish for the generation in `dir`: the
 * pinned manifest's shape with this generation's id and measured file facts.
 *
 * @param {string} dir
 * @param {string} generation
 * @param {string} pinnedManifestPath
 */
export async function manifestFor(dir, generation, pinnedManifestPath) {
  const manifest = JSON.parse(fs.readFileSync(pinnedManifestPath, 'utf8'))
  manifest.generation = generation
  manifest.published_at = new Date().toISOString()
  manifest.projection.watermark = manifest.published_at
  for (const name of /** @type {const} */ (['nodes', 'edges'])) {
    const { facts } = await measureFile(fs.createReadStream(path.join(dir, `${name}.ndjson.gz`)))
    manifest.files[name] = { path: `generations/${generation}/${name}.ndjson.gz`, ...facts }
  }
  manifest.unresolved = { edges: 0, endpoint_ids: 0 }
  return manifest
}
