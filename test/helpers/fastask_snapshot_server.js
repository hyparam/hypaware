// @ts-check

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { EDGE_COLUMNS, NODE_COLUMNS, encodeLine, measureFile } from '../../hypaware-core/plugins-workspace/fastask/src/contract.js'

/**
 * @import { AddressInfo } from 'node:net'
 */

/**
 * A loopback stand-in for a server's `/v1/graph/snapshot` routes, built from
 * the pinned `hypaware.graph-snapshot/1` fixtures (LLP 0481 T1): the pinned
 * generation, its headers and its error bodies, plus generated generations
 * for replacement tests. Tests steer it through `answer` (what the manifest
 * route says next) and `onData` (a per-request override for data files),
 * and read `requests` to see what the client sent.
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'contracts', 'graph-snapshot', 'v1')

/** @param {string} name */
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name))
}

/** @param {string} name */
export function fixtureJson(name) {
  return JSON.parse(fixture(name).toString('utf8'))
}

/**
 * The pinned generation exactly as the server published it.
 *
 * @returns {{ manifest: any, files: { nodes: Buffer, edges: Buffer } }}
 */
export function pinnedGeneration() {
  return { manifest: fixtureJson('manifest.json'), files: { nodes: fixture('nodes.ndjson.gz'), edges: fixture('edges.ndjson.gz') } }
}

/**
 * A synthetic generation in the pinned manifest's shape, encoded and measured
 * with the contract module. `nodeCount`/`edgeCount` pick its size.
 *
 * @param {{ generation: string, nodeCount?: number, edgeCount?: number, watermark?: string }} args
 * @returns {Promise<{ manifest: any, files: { nodes: Buffer, edges: Buffer } }>}
 */
export async function generatedGeneration({ generation, nodeCount = 3, edgeCount = 2, watermark = '2026-10-09T03:00:00.000Z' }) {
  const id = (/** @type {string} */ prefix, /** @type {number} */ i) => `${prefix}${i.toString(16).padStart(22, '0')}`
  /** @type {string[]} */
  const nodeLines = []
  for (let i = 0; i < nodeCount; i++) {
    nodeLines.push(encodeLine({
      node_id: id('a1', i), node_type: i % 2 ? 'File' : 'Session', natural_key: `fx-${generation}-${i}`, label: `node ${i}`,
      props: { n: i }, first_seen: 1760000000000 + i, source_dataset: 'ai_gateway_messages',
      source_keys: { session_id: `fx-session-${i}` }, projector: 'ai-gateway.t0', projector_version: 2,
    }, NODE_COLUMNS))
  }
  /** @type {string[]} */
  const edgeLines = []
  for (let i = 0; i < edgeCount; i++) {
    edgeLines.push(encodeLine({
      edge_id: id('e1', i), edge_type: 'EDITED', src_id: id('a1', i % Math.max(nodeCount, 1)), dst_id: id('a1', (i + 1) % Math.max(nodeCount, 1)),
      src_type: 'Session', dst_type: 'File', props: null, first_seen: 1760000000000 + i, source_dataset: 'ai_gateway_messages',
      source_keys: null, projector: 'ai-gateway.t0', projector_version: 2,
    }, EDGE_COLUMNS))
  }
  const files = {
    nodes: gzipSync(nodeLines.map((l) => `${l}\n`).join('')),
    edges: gzipSync(edgeLines.map((l) => `${l}\n`).join('')),
  }
  const manifest = fixtureJson('manifest.json')
  manifest.generation = generation
  manifest.published_at = watermark
  manifest.projection.watermark = watermark
  for (const name of /** @type {const} */ (['nodes', 'edges'])) {
    const { facts } = await measureFile(files[name])
    manifest.files[name] = { path: `generations/${generation}/${name}.ndjson.gz`, ...facts }
  }
  manifest.unresolved = { edges: 0, endpoint_ids: 0 }
  return { manifest, files }
}

/**
 * @param {{ token?: string }} [opts] the bearer the server accepts
 */
export async function startSnapshotServer(opts = {}) {
  const token = opts.token ?? 'tok'
  const headers = fixtureJson('headers.json')
  /** @type {Map<string, { manifest: any, files: { nodes: Buffer, edges: Buffer } }>} */
  const generations = new Map()
  /** @type {Array<{ method: string, url: string, ifNoneMatch: string | null, authorization: string | null }>} */
  const requests = []

  const state = {
    /** The generation the manifest route advertises, or null for none. */
    current: /** @type {string | null} */ (null),
    /**
     * What the manifest route answers next: `'ok'` (200/304 per If-None-Match),
     * or the name of a pinned response fixture (`'403-snapshot_access_withdrawn'`),
     * or `{ status, body, headers }`. A function is called per request.
     * @type {string | { status: number, body?: any, headers?: Record<string, string> } | (() => string | { status: number, body?: any, headers?: Record<string, string> })}
     */
    answer: 'ok',
    /** Lease seconds sent in `hyp-snapshot-lease`, or null to omit the header. */
    leaseHeader: /** @type {string | null} */ (headers.manifest_200['hyp-snapshot-lease']),
    /**
     * Per-request override for data files; return true when it answered.
     * @type {((req: http.IncomingMessage, res: http.ServerResponse, info: { generation: string, name: 'nodes' | 'edges', bytes: Buffer }) => boolean) | null}
     */
    onData: null,
    acceptedToken: token,
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push({
      method: req.method ?? '',
      url: `${url.pathname}${url.search}`,
      ifNoneMatch: /** @type {string | undefined} */ (req.headers['if-none-match']) ?? null,
      authorization: req.headers.authorization ?? null,
    })
    if (req.headers.authorization !== `Bearer ${state.acceptedToken}`) return sendFixture(res, '401-unauthorized')

    if (url.pathname === '/v1/graph/snapshot') {
      const answer = typeof state.answer === 'function' ? state.answer() : state.answer
      if (answer !== 'ok') {
        if (typeof answer === 'string') return sendFixture(res, answer)
        return send(res, answer.status, answer.body ?? null, answer.headers ?? {})
      }
      const gen = state.current ? generations.get(state.current) : undefined
      if (!gen) return sendFixture(res, '503-snapshot_pending')
      /** @type {Record<string, string>} */
      const authorized = { etag: `"${gen.manifest.generation}"`, 'cache-control': 'private, no-cache', 'hyp-snapshot-poll': headers.manifest_200['hyp-snapshot-poll'] }
      if (state.leaseHeader !== null) authorized['hyp-snapshot-lease'] = state.leaseHeader
      if (req.headers['if-none-match'] === authorized.etag) return send(res, 304, null, authorized)
      return send(res, 200, gen.manifest, authorized)
    }

    const match = url.pathname.match(/^\/v1\/graph\/snapshot\/generations\/([^/]+)\/(nodes|edges)\.ndjson\.gz$/)
    if (match) {
      const gen = generations.get(decodeURIComponent(match[1]))
      if (!gen) return sendFixture(res, '410-generation_expired')
      const name = /** @type {'nodes' | 'edges'} */ (match[2])
      const bytes = gen.files[name]
      if (state.onData?.(req, res, { generation: gen.manifest.generation, name, bytes })) return
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(bytes.length) })
      res.end(bytes)
      return
    }
    sendFixture(res, '404-unknown_path')
  })

  /**
   * @param {http.ServerResponse} res
   * @param {string} name pinned response fixture, e.g. `403-snapshot_access_withdrawn`
   */
  function sendFixture(res, name) {
    const { status, headers: fixtureHeaders, body } = fixtureJson(`responses/${name}.json`)
    send(res, status, body, fixtureHeaders)
  }

  /**
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {any} body
   * @param {Record<string, string>} extra
   */
  function send(res, status, body, extra) {
    const text = body === null ? '' : JSON.stringify(body)
    /** @type {Record<string, string>} */
    const out = { ...extra }
    if (body !== null) {
      out['content-type'] = 'application/json'
      out['content-length'] = String(Buffer.byteLength(text))
    }
    res.writeHead(status, out)
    res.end(text)
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {AddressInfo} */ (server.address())

  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    requests,
    /**
     * Publishes a generation and makes it current.
     * @param {{ manifest: any, files: { nodes: Buffer, edges: Buffer } }} gen
     */
    publish(gen) {
      generations.set(gen.manifest.generation, gen)
      state.current = gen.manifest.generation
    },
    /** @param {string} generation */
    retire(generation) {
      generations.delete(generation)
    },
    /** Requests for data files so far. */
    dataRequests() {
      return requests.filter((r) => r.url.includes('/generations/'))
    },
    close() {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}
