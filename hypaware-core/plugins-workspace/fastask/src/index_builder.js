// @ts-check

import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { createWorkBudget } from '../../../../src/core/util/work_budget.js'
import { EDGE_COLUMNS, NODE_COLUMNS } from './contract.js'

/**
 * @import { CompressedSource, Exemplar, GraphEdgeRow, GraphIndex, GraphNodeRow, IndexBuilder, IndexBuilderOptions, SessionProps, SnapshotIndexInput, WorkTicker } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

/**
 * The warm index over one graph generation (LLP 0480#index): a dense node
 * table, typed-array CSR adjacency in both directions, a sparse exemplar map
 * and the File lookups discovery needs, built from the snapshot's two gzipped
 * NDJSON files (or from rows a local loader hands over) in work-budget
 * slices, under a hard byte ceiling.
 *
 * Pure apart from `node:zlib` and the work budget: no IO beyond the sources
 * it is given, no kernel registration.
 */

/** Hard ceiling on the index's estimated resident bytes (LLP 0484#build-memory, was 512 MB in LLP 0480#index). */
export const MAX_INDEX_BYTES = 256 * 1024 * 1024

/**
 * Bytes per manifest row the up-front check assumes (LLP 0484#build-memory,
 * re-fitted for path tokens by LLP 0488#path-tokens): the index measured 99.3
 * estimated bytes per row on the real 1x team graph and 84.6 on the synthetic
 * one (LLP 0481 T15), so 110 leaves about 10 percent.
 */
export const BYTES_PER_ROW = 110

/** `nodeFlags` bit: the node was minted for an edge endpoint absent from the node file. */
export const PLACEHOLDER = 1

// Estimate of V8 resident cost, calibrated against measured heap by
// benchmarks/fastask-client (it reports both). Conservative on purpose: the
// estimate refuses before the heap grows, never after.
const STRING_BYTES = 24 // header plus alignment; one byte per character on top
const MAP_ENTRY_BYTES = 40 // hash table slot, chain link and load-factor slack
const ARRAY_SLOT_BYTES = 8 // one pointer in a JS array
const OBJECT_BYTES = 56 // a small object with four in-object fields
const NODE_TYPED_BYTES = 1 + 1 + 8 // type, flags, first seen
const EDGE_TYPED_BYTES = 4 + 4 + 1 + 8 // src, dst, type, first seen
const CSR_EDGE_BYTES = 4 + 4 // one slot in each direction
const CSR_NODE_BYTES = 4 + 4 // one offset in each direction
const POSTING_BUILD_BYTES = 4 + 4 // token id and packed node during the build
const POSTING_BYTES = 4 // packed node and basename flag, once built
const TOKEN_BYTES = MAP_ENTRY_BYTES + STRING_BYTES + 2 * ARRAY_SLOT_BYTES + 4 + 4 // dictionary entry, name, sorted id, offset
/** Path tokens shorter than this are not indexed: shorter terms are dropped (LLP 0488#path-tokens). */
export const MIN_TOKEN = 3
// Interned type names fit a Uint8: 254 named slots, then one shared slot.
export const MAX_TYPES = 255
export const OTHER_TYPE = '(other)'

/** A build refused or failed; `code` is stable, the message is display text. */
export class IndexBuildError extends Error {
  /**
   * @param {'replica_too_large' | 'invalid_line' | 'schema_violation'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'IndexBuildError'
    this.code = code
  }
}

/**
 * What each contract column may hold (server LLP 0554#data-files, nullability
 * as the context-graph datasets declare it): a string, a string or null, a
 * parsed JSON object or array or null (never a string holding JSON), an
 * ISO-8601 UTC timestamp with milliseconds or null, or an integer.
 *
 * @type {Record<string, 'string' | 'string?' | 'json?' | 'time?' | 'int'>}
 */
const COLUMN_KINDS = {
  node_id: 'string', node_type: 'string', natural_key: 'string', label: 'string?',
  edge_id: 'string', edge_type: 'string', src_id: 'string', dst_id: 'string', src_type: 'string', dst_type: 'string',
  props: 'json?', first_seen: 'time?', source_dataset: 'string', source_keys: 'json?',
  projector: 'string', projector_version: 'int',
}
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Checks one parsed line against the contract: exactly `columns`, in order,
 * each holding what its kind allows. Returns the first problem, or null.
 * Walks the row's own keys in place: no allocation, at most one comparison
 * and one type check per column (plus one regex test for `first_seen`).
 *
 * @ref LLP 0483#accepted [implements]: the per-line column check is the index builder's, so a mismatch fails the build and the old generation stays active
 * @param {Record<string, unknown>} row
 * @param {ReadonlyArray<string>} columns
 * @returns {string | null}
 */
export function rowProblem(row, columns) {
  let i = 0
  for (const key in row) {
    if (i === columns.length) return `extra column ${JSON.stringify(key)}`
    const want = columns[i]
    if (key !== want) return `column ${i + 1} is ${JSON.stringify(key)}, expected ${want}`
    const value = row[key]
    const kind = COLUMN_KINDS[want]
    const ok = kind === 'string' ? typeof value === 'string'
      : kind === 'string?' ? value === null || typeof value === 'string'
        : kind === 'json?' ? value === null || typeof value === 'object'
          : kind === 'time?' ? value === null || (typeof value === 'string' && ISO_MILLIS.test(value))
            : Number.isInteger(value)
    if (!ok) return `${want} holds ${value === null ? 'null' : typeof value}, not ${kind.replace('?', ' or null')}`
    i++
  }
  return i === columns.length ? null : `missing column ${columns[i]}`
}

/**
 * Refuses a generation from its manifest alone, before it is downloaded or
 * parsed: its row counts times `BYTES_PER_ROW` must fit `maxBytes`. A build
 * peaks at several times its index, so this keeps an oversized graph from
 * growing the process on the way to a refusal; the running estimate during
 * the build stays as the second check. A manifest without row counts passes
 * here and is held by the running estimate alone.
 *
 * @ref LLP 0484#build-memory [implements]: (nodes.rows + edges.rows) x BYTES_PER_ROW past MAX_INDEX_BYTES is refused before download
 * @param {any} manifest
 * @param {number} [maxBytes]
 */
export function assertManifestFits(manifest, maxBytes = MAX_INDEX_BYTES) {
  const nodes = rowsOf(manifest, 'nodes') ?? 0
  const edges = rowsOf(manifest, 'edges') ?? 0
  const bytes = (nodes + edges) * BYTES_PER_ROW
  if (bytes > maxBytes) {
    throw new IndexBuildError('replica_too_large',
      `team graph index would exceed ${maxBytes} bytes (${nodes} nodes and ${edges} edges at ${BYTES_PER_ROW} bytes per row is ${bytes})`)
  }
}

/**
 * An incremental builder. `addNode` and `addEdge` take rows in any order:
 * an edge whose endpoint has not been seen mints a placeholder node, and a
 * node that arrives later fills that placeholder in, so a local loader that
 * interleaves the two datasets gets the same index as the snapshot's
 * nodes-then-edges order. Each call checks the running estimate and throws
 * `replica_too_large` the moment it passes `maxBytes`.
 *
 * @param {IndexBuilderOptions} [opts]
 * @returns {IndexBuilder}
 */
export function createIndexBuilder(opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_INDEX_BYTES
  let nodeCap = Math.max(16, opts.expectedNodes ?? 0)
  let edgeCap = Math.max(16, opts.expectedEdges ?? 0)

  /** @type {Map<string, number>} */
  const nodeIds = new Map()
  /** @type {string[]} the node id of each dense index, so results can name nodes */
  const nodeIdOf = []
  /** @type {string[]} */
  const nodeTypes = []
  /** @type {number[]} real (non-placeholder) nodes per interned type */
  const nodeTypeCounts = []
  /** @type {Map<string, number>} */
  const nodeTypeIndex = new Map()
  let nodeType = new Uint8Array(nodeCap)
  let nodeFlags = new Uint8Array(nodeCap)
  let nodeFirstSeen = new Float64Array(nodeCap)
  /** @type {Array<string | null>} */
  const naturalKey = []
  /** @type {Array<string | null>} */
  const label = []
  /** @type {Map<number, SessionProps>} */
  const sessionProps = new Map()
  // Session props repeat heavily (one cwd, branch, client and user across
  // many sessions); one copy of each distinct value is kept.
  /** @type {Map<string, string>} */
  const interned = new Map()

  /** @type {string[]} */
  const edgeTypes = []
  /** @type {number[]} edges per interned type */
  const edgeTypeCounts = []
  /** @type {Map<string, number>} */
  const edgeTypeIndex = new Map()
  let edgeType = new Uint8Array(edgeCap)
  let edgeSrc = new Uint32Array(edgeCap)
  let edgeDst = new Uint32Array(edgeCap)
  let edgeFirstSeen = new Float64Array(edgeCap)
  /** @type {Map<number, Exemplar>} */
  const exemplars = new Map()

  /** @type {Map<string, number | number[]>} */
  const fileByBasename = new Map()
  // Path tokens (LLP 0488#path-tokens): a dictionary, and postings collected
  // as (token, node * 2 + basename flag) pairs, grouped by token at finish.
  /** @type {Map<string, number>} */
  const tokenIds = new Map()
  /** @type {string[]} */
  const tokenNames = []
  let postCap = Math.max(64, Math.ceil((opts.expectedNodes ?? 0) * 2))
  let postTok = new Uint32Array(postCap)
  let postPacked = new Uint32Array(postCap)
  let postCount = 0
  /** @type {Map<string, number>} reused per file: token to basename flag */
  const fileTokens = new Map()
  /** @type {Map<string, number | number[]>} */
  const fileByRepo = new Map()
  /** @type {Map<string, number | number[]>} */
  const fileBySuffix = new Map()

  let nodeCount = 0
  let edgeCount = 0
  let placeholderCount = 0
  // Variable-size costs; the typed arrays are counted from their capacity.
  let heapBytes = 0

  // The adjacency `finish` allocates is counted from the first row, so an
  // over-ceiling graph is refused while it parses, not after.
  function estimate() {
    return heapBytes + nodeCap * NODE_TYPED_BYTES + edgeCap * EDGE_TYPED_BYTES +
      (nodeCount + 1) * CSR_NODE_BYTES + edgeCount * CSR_EDGE_BYTES +
      postCap * POSTING_BUILD_BYTES + postCount * POSTING_BYTES
  }

  /** @param {number} extra bytes about to be allocated beyond the estimate */
  function check(extra = 0) {
    const bytes = estimate() + extra
    if (bytes > maxBytes) {
      throw new IndexBuildError('replica_too_large',
        `team graph index would exceed ${maxBytes} bytes (estimated ${bytes} at ${nodeCount} nodes and ${edgeCount} edges)`)
    }
  }

  /**
   * A type's small integer in one table. The first `MAX_TYPES - 1` distinct
   * names get their own slot; the next creates the shared `OTHER_TYPE` slot
   * in the last position, and every name after that maps to it. Bounded: at
   * most `MAX_TYPES` entries, one map lookup or two per call, no recursion.
   *
   * @param {string[]} names
   * @param {Map<string, number>} index
   * @param {number[]} counts
   * @param {string} name
   */
  function internType(names, index, counts, name) {
    let t = index.get(name)
    if (t !== undefined) return t
    if (names.length >= MAX_TYPES - 1) {
      t = index.get(OTHER_TYPE)
      if (t !== undefined) return t
      name = OTHER_TYPE
    }
    t = names.length
    names.push(name)
    counts.push(0)
    index.set(name, t)
    heapBytes += MAP_ENTRY_BYTES + STRING_BYTES + name.length
    return t
  }

  /** @param {string} name */
  function internNodeType(name) {
    return internType(nodeTypes, nodeTypeIndex, nodeTypeCounts, name)
  }

  /** @param {string} name */
  function internEdgeType(name) {
    return internType(edgeTypes, edgeTypeIndex, edgeTypeCounts, name)
  }

  /** @param {string | null} value */
  function intern(value) {
    if (value === null) return null
    const seen = interned.get(value)
    if (seen !== undefined) return seen
    interned.set(value, value)
    heapBytes += MAP_ENTRY_BYTES + STRING_BYTES + value.length
    return value
  }

  function growNodes() {
    nodeCap *= 2
    check()
    nodeType = grown(nodeType, new Uint8Array(nodeCap))
    nodeFlags = grown(nodeFlags, new Uint8Array(nodeCap))
    nodeFirstSeen = grown(nodeFirstSeen, new Float64Array(nodeCap))
  }

  function growEdges() {
    edgeCap *= 2
    check()
    edgeType = grown(edgeType, new Uint8Array(edgeCap))
    edgeSrc = grown(edgeSrc, new Uint32Array(edgeCap))
    edgeDst = grown(edgeDst, new Uint32Array(edgeCap))
    edgeFirstSeen = grown(edgeFirstSeen, new Float64Array(edgeCap))
  }

  /**
   * @param {string} id
   * @param {string} type
   * @returns {number}
   */
  function mint(id, type) {
    if (nodeCount === nodeCap) growNodes()
    const i = nodeCount++
    nodeIds.set(id, i)
    nodeIdOf.push(id)
    nodeType[i] = internNodeType(type)
    nodeFirstSeen[i] = NaN
    naturalKey.push(null)
    label.push(null)
    heapBytes += MAP_ENTRY_BYTES + STRING_BYTES + id.length + 3 * ARRAY_SLOT_BYTES
    return i
  }

  /**
   * @param {unknown} id
   * @param {unknown} type
   * @returns {number} the node index, or -1 when the edge names no endpoint
   */
  function endpoint(id, type) {
    const key = str(id)
    if (!key) return -1
    const known = nodeIds.get(key)
    if (known !== undefined) return known
    // @ref LLP 0480#index [implements]: an edge to an absent node gets a placeholder, counted, never dropped
    const i = mint(key, str(type) ?? 'Unknown')
    nodeFlags[i] = PLACEHOLDER
    placeholderCount++
    return i
  }

  /**
   * @param {string} key
   * @param {number} i
   */
  function indexFile(key, i) {
    const repo = repoOfKey(key)
    const rel = repo === null ? key : key.slice(repo.length + 1)
    indexTokens(rel, i)
    const base = basenameOf(rel).toLowerCase()
    if (!base) return
    heapBytes += addTo(fileByBasename, base, i)
    if (repo !== null) {
      heapBytes += addTo(fileByRepo, repo, i)
    } else if (isAbsolute(key)) {
      const suffix = lastSegments(key, 3)
      if (suffix !== null) heapBytes += addTo(fileBySuffix, suffix.toLowerCase(), i)
    }
  }

  /**
   * One posting per distinct token of the path, flagged when the token comes
   * from the basename.
   *
   * @ref LLP 0488#path-tokens [implements]: directory segments and basename parts are tokens; each records whether it came from the basename
   * @param {string} filePath the relative path of a bridged key, else the path
   * @param {number} i
   */
  function indexTokens(filePath, i) {
    fileTokens.clear()
    const norm = filePath.replace(/\\/g, '/')
    const slash = norm.lastIndexOf('/')
    for (const t of splitTokens(slash === -1 ? '' : norm.slice(0, slash))) if (t.length >= MIN_TOKEN) fileTokens.set(t, 0)
    for (const t of splitTokens(norm.slice(slash + 1))) if (t.length >= MIN_TOKEN) fileTokens.set(t, 1)
    for (const [token, base] of fileTokens) {
      let id = tokenIds.get(token)
      if (id === undefined) {
        id = tokenNames.length
        tokenNames.push(token)
        tokenIds.set(token, id)
        heapBytes += TOKEN_BYTES + token.length
      }
      if (postCount === postCap) {
        postCap *= 2
        check()
        postTok = grown(postTok, new Uint32Array(postCap))
        postPacked = grown(postPacked, new Uint32Array(postCap))
      }
      postTok[postCount] = id
      postPacked[postCount] = i * 2 + base
      postCount++
    }
  }

  return {
    addNode(row) {
      const id = str(row.node_id)
      if (!id) return
      const type = str(row.node_type) ?? 'Unknown'
      let i = nodeIds.get(id)
      if (i === undefined) {
        i = mint(id, type)
      } else if (nodeFlags[i] & PLACEHOLDER) {
        nodeFlags[i] &= ~PLACEHOLDER
        placeholderCount--
        nodeType[i] = internNodeType(type)
      } else {
        return // a node id appears once per file; a repeat adds nothing
      }
      nodeTypeCounts[nodeType[i]]++
      const key = str(row.natural_key)
      const text = str(row.label)
      naturalKey[i] = key
      label[i] = text === key ? null : text
      heapBytes += (key ? STRING_BYTES + key.length : 0) + (label[i] ? STRING_BYTES + /** @type {string} */ (label[i]).length : 0)
      nodeFirstSeen[i] = millis(row.first_seen)
      if (type === 'Session') {
        const props = objectOf(row.props)
        sessionProps.set(i, {
          cwd: intern(str(props?.cwd)),
          git_branch: intern(str(props?.git_branch)),
          client_name: intern(str(props?.client_name)),
          user_id: intern(str(props?.user_id)),
        })
        heapBytes += MAP_ENTRY_BYTES + OBJECT_BYTES
      } else if (type === 'File' && key) {
        indexFile(key, i)
      }
      check()
    },

    addEdge(row) {
      const src = endpoint(row.src_id, row.src_type)
      const dst = endpoint(row.dst_id, row.dst_type)
      if (src === -1 || dst === -1) return
      if (edgeCount === edgeCap) growEdges()
      const e = edgeCount++
      edgeSrc[e] = src
      edgeDst[e] = dst
      edgeType[e] = internEdgeType(str(row.edge_type) ?? 'unknown')
      // @ref LLP 0484#edge-kinds [implements]: a count per edge type, so a generation without the walked kind is flagged, not silently empty
      edgeTypeCounts[edgeType[e]]++
      edgeFirstSeen[e] = millis(row.first_seen)
      const exemplar = exemplarOf(row.source_keys)
      if (exemplar) {
        exemplars.set(e, exemplar)
        heapBytes += MAP_ENTRY_BYTES + OBJECT_BYTES +
          (exemplar.message_id ? STRING_BYTES + exemplar.message_id.length : 0) +
          (exemplar.part_id ? STRING_BYTES + exemplar.part_id.length : 0)
      }
      check()
    },

    get estimatedBytes() { return estimate() },

    async finish(budget) {
      // Release capacity slack before the adjacency is allocated, so the
      // build's peak is the index plus one cursor array, not twice the edges.
      if (nodeCap > nodeCount) {
        nodeType = nodeType.slice(0, nodeCount)
        nodeFlags = nodeFlags.slice(0, nodeCount)
        nodeFirstSeen = nodeFirstSeen.slice(0, nodeCount)
        nodeCap = nodeCount
      }
      if (edgeCap > edgeCount) {
        edgeType = edgeType.slice(0, edgeCount)
        edgeSrc = edgeSrc.slice(0, edgeCount)
        edgeDst = edgeDst.slice(0, edgeCount)
        edgeFirstSeen = edgeFirstSeen.slice(0, edgeCount)
        edgeCap = edgeCount
      }
      // The adjacency is already in the estimate; its fill cursor is not.
      check(nodeCount * 4)

      let unresolvedEdges = 0
      for (let e = 0; e < edgeCount; e++) {
        if ((nodeFlags[edgeSrc[e]] | nodeFlags[edgeDst[e]]) & PLACEHOLDER) unresolvedEdges++
        const wait = budget?.tick(1)
        if (wait) await wait
      }

      const out = await adjacency(edgeSrc, nodeCount, edgeFirstSeen, budget)
      const into = await adjacency(edgeDst, nodeCount, edgeFirstSeen, budget)
      const tokens = await tokenPostings(tokenNames, postTok, postPacked, postCount, budget)
      postTok = new Uint32Array(0)
      postPacked = new Uint32Array(0)
      postCap = 0

      return {
        nodeCount,
        edgeCount,
        placeholderCount,
        unresolvedEdges,
        bytes: estimate(),
        nodeIds,
        nodeIdOf,
        nodeTypes,
        nodeTypeCounts,
        nodeType,
        nodeFlags,
        naturalKey,
        label,
        nodeFirstSeen,
        sessionProps,
        edgeTypes,
        edgeTypeCounts,
        edgeType,
        edgeSrc,
        edgeDst,
        edgeFirstSeen,
        exemplars,
        outOffsets: out.offsets,
        outEdges: out.edges,
        inOffsets: into.offsets,
        inEdges: into.edges,
        fileByBasename,
        fileByRepo,
        fileBySuffix,
        tokenIds,
        tokenNames,
        tokenOffsets: tokens.offsets,
        tokenPostings: tokens.postings,
        sortedTokenIds: tokens.sorted,
      }
    },
  }
}

/**
 * Groups the build's (token, packed node) pairs by token: postings of token t
 * are `postings[offsets[t] .. offsets[t + 1])`, each `node * 2 + basename`,
 * ascending, so membership is a binary search. Also the token ids in token
 * order, for prefix lookup by binary search.
 *
 * @param {string[]} names
 * @param {Uint32Array} tok
 * @param {Uint32Array} packed
 * @param {number} count
 * @param {WorkTicker | undefined} budget
 */
async function tokenPostings(names, tok, packed, count, budget) {
  const offsets = new Uint32Array(names.length + 1)
  for (let p = 0; p < count; p++) offsets[tok[p] + 1]++
  for (let t = 0; t < names.length; t++) offsets[t + 1] += offsets[t]
  const cursor = offsets.slice(0, names.length)
  const postings = new Uint32Array(count)
  for (let p = 0; p < count; p++) {
    postings[cursor[tok[p]]++] = packed[p]
    const wait = budget?.tick(1)
    if (wait) await wait
  }
  for (let t = 0; t < names.length; t++) {
    const start = offsets[t]
    const end = offsets[t + 1]
    if (end - start > 1) postings.subarray(start, end).sort()
    const wait = budget?.tick(end - start + 1)
    if (wait) await wait
  }
  const order = Array.from({ length: names.length }, (_, t) => t)
  order.sort((a, b) => (names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : 0))
  return { offsets, postings, sorted: Uint32Array.from(order) }
}

/**
 * Lowercase tokens of a path or a term: split on '/', '-', '_', '.',
 * whitespace and camelCase boundaries (LLP 0488#path-tokens).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitTokens(text) {
  /** @type {string[]} */
  const out = []
  for (const piece of text.split(/[\\/\-_.\s]+/)) {
    if (!piece) continue
    for (const part of piece.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      if (part) out.push(part.toLowerCase())
    }
  }
  return out
}

/**
 * CSR over one endpoint column: `edges[offsets[i] .. offsets[i + 1])` are the
 * ordinals of edges whose endpoint is node i, newest `first_seen` first, so a
 * walk that stops at its visit budget keeps the most recent touches.
 *
 * @param {Uint32Array} endpoints
 * @param {number} nodeCount
 * @param {Float64Array} firstSeen
 * @param {WorkTicker | undefined} budget
 * @returns {Promise<{ offsets: Uint32Array, edges: Uint32Array }>}
 */
async function adjacency(endpoints, nodeCount, firstSeen, budget) {
  const edgeCount = endpoints.length
  const offsets = new Uint32Array(nodeCount + 1)
  for (let e = 0; e < edgeCount; e++) {
    offsets[endpoints[e] + 1]++
    const wait = budget?.tick(1)
    if (wait) await wait
  }
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] += offsets[i]
  const cursor = offsets.slice(0, nodeCount)
  const edges = new Uint32Array(edgeCount)
  for (let e = 0; e < edgeCount; e++) {
    edges[cursor[endpoints[e]]++] = e
    const wait = budget?.tick(1)
    if (wait) await wait
  }
  /** @param {number} a @param {number} b */
  const newestFirst = (a, b) => {
    const x = firstSeen[a]
    const y = firstSeen[b]
    if (x === y) return a - b
    if (x !== x) return 1 // absent times sort last
    if (y !== y) return -1
    return y - x
  }
  for (let i = 0; i < nodeCount; i++) {
    const start = offsets[i]
    const end = offsets[i + 1]
    if (end - start > 1) edges.subarray(start, end).sort(newestFirst)
    const wait = budget?.tick(end - start + 1)
    if (wait) await wait
  }
  return { offsets, edges }
}

/**
 * Builds the index for one verified generation by streaming each gzipped
 * file through decompression and line parsing, nodes first, in work-budget
 * slices. The manifest's row counts size the arrays and refuse an
 * over-ceiling generation before anything is decompressed (the sync loop
 * calls `assertManifestFits` itself before downloading). Abort is observed
 * at slice boundaries and surfaces as the signal's reason.
 *
 * @ref LLP 0480#cooperative [implements]: decompress, parse and both CSR passes tick one budget; the cold path passes duty 1
 * @param {SnapshotIndexInput} input
 * @returns {Promise<GraphIndex>}
 */
export async function buildIndexFromSnapshot(input) {
  const maxBytes = input.maxBytes ?? MAX_INDEX_BYTES
  const expectedNodes = rowsOf(input.manifest, 'nodes')
  const expectedEdges = rowsOf(input.manifest, 'edges')
  // @ref LLP 0480#index [implements]: a generation past MAX_INDEX_BYTES is refused with replica_too_large instead of growing
  assertManifestFits(input.manifest, maxBytes)
  const { signal } = input
  const budget = createWorkBudget({ duty: input.duty, signal, cpuNow: input.cpuNow })
  const builder = createIndexBuilder({ maxBytes, expectedNodes, expectedEdges })
  try {
    await forEachLine(input.nodes, 'nodes', NODE_COLUMNS, (row) => builder.addNode(row), builder, maxBytes, budget, signal)
    await forEachLine(input.edges, 'edges', EDGE_COLUMNS, (row) => builder.addEdge(row), builder, maxBytes, budget, signal)
    return await builder.finish(budget)
  } catch (err) {
    if (signal?.aborted) throw signal.reason
    throw err
  }
}

/**
 * Decompresses one file and hands each parsed line to `onRow`, ticking the
 * budget per line. Memory is one chunk plus one partial line, and the partial
 * line counts against the ceiling so a single enormous line cannot grow past it.
 * Every line is checked against the contract's columns in the same pass; the
 * first violation fails the build with `schema_violation`.
 *
 * @param {CompressedSource} source
 * @param {'nodes' | 'edges'} name
 * @param {ReadonlyArray<string>} columns
 * @param {(row: any) => void} onRow
 * @param {IndexBuilder} builder
 * @param {number} maxBytes
 * @param {WorkTicker} budget
 * @param {AbortSignal | undefined} signal
 */
async function forEachLine(source, name, columns, onRow, builder, maxBytes, budget, signal) {
  let lineNo = 0
  /** @type {Buffer[]} */
  let pending = []
  let pendingBytes = 0

  /** @param {string} text */
  function parse(text) {
    lineNo++
    let row
    try {
      row = JSON.parse(text)
    } catch {
      throw new IndexBuildError('invalid_line', `${name} line ${lineNo} is not JSON`)
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new IndexBuildError('invalid_line', `${name} line ${lineNo} is not an object`)
    const problem = rowProblem(row, columns)
    if (problem) throw new IndexBuildError('schema_violation', `${name} line ${lineNo}: ${problem}`)
    onRow(row)
  }

  /** @param {AsyncIterable<Buffer>} chunks */
  async function lines(chunks) {
    for await (const chunk of chunks) {
      let start = 0
      let newline
      while ((newline = chunk.indexOf(0x0a, start)) !== -1) {
        if (pending.length === 0) {
          if (newline > start) parse(chunk.toString('utf8', start, newline))
        } else {
          pending.push(chunk.subarray(start, newline))
          parse(Buffer.concat(pending).toString('utf8'))
          pending = []
          pendingBytes = 0
        }
        start = newline + 1
        const wait = budget.tick(1)
        if (wait) await wait
      }
      if (start < chunk.byteLength) {
        pending.push(chunk.subarray(start))
        pendingBytes += chunk.byteLength - start
        if (builder.estimatedBytes + pendingBytes > maxBytes) {
          throw new IndexBuildError('replica_too_large', `${name} line ${lineNo + 1} passes the ${maxBytes}-byte index ceiling`)
        }
      }
    }
    if (pendingBytes > 0) parse(Buffer.concat(pending).toString('utf8'))
  }

  await pipeline(asIterable(source), createGunzip(), lines, { signal })
}

/**
 * @param {CompressedSource} source
 * @returns {AsyncIterable<Uint8Array>}
 */
async function* asIterable(source) {
  if (source instanceof Uint8Array) {
    yield source
    return
  }
  yield* source
}

/**
 * @template {Uint8Array | Uint32Array | Float64Array} T
 * @param {T} from
 * @param {T} to
 * @returns {T}
 */
function grown(from, to) {
  to.set(/** @type {any} */ (from))
  return to
}

/**
 * Adds `i` under `key`; a single index stays a number, a second one makes an
 * array, so the common unique key costs one map entry and nothing more.
 *
 * @param {Map<string, number | number[]>} map
 * @param {string} key
 * @param {number} i
 * @returns {number} estimated bytes added
 */
function addTo(map, key, i) {
  const current = map.get(key)
  if (current === undefined) {
    map.set(key, i)
    return MAP_ENTRY_BYTES + STRING_BYTES + key.length
  }
  if (typeof current === 'number') {
    map.set(key, [current, i])
    return OBJECT_BYTES + 2 * ARRAY_SLOT_BYTES
  }
  current.push(i)
  return ARRAY_SLOT_BYTES
}

/**
 * The `owner/repo` half of a bridged `owner/repo:path` File key, or null for
 * an absolute-path key (LLP 0032's bridge-key vocabulary).
 *
 * @param {string} key
 * @returns {string | null}
 */
export function repoOfKey(key) {
  const colon = key.indexOf(':')
  if (colon <= 0) return null
  const repo = key.slice(0, colon)
  const slash = repo.indexOf('/')
  if (slash <= 0 || slash === repo.length - 1 || repo.indexOf('/', slash + 1) !== -1) return null
  return repo
}

/**
 * @param {string} path
 * @returns {string}
 */
export function basenameOf(path) {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isAbsolute(path) {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * The last `n` path segments joined with `/`, or null when the path has fewer.
 *
 * @param {string} path
 * @param {number} n
 * @returns {string | null}
 */
export function lastSegments(path, n) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length >= n ? parts.slice(-n).join('/') : null
}

/**
 * @param {any} manifest
 * @param {'nodes' | 'edges'} name
 * @returns {number | undefined}
 */
function rowsOf(manifest, name) {
  const rows = manifest?.files?.[name]?.rows
  return Number.isSafeInteger(rows) && rows >= 0 ? rows : undefined
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function millis(value) {
  if (typeof value === 'string') return Date.parse(value)
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  return NaN
}

/**
 * A JSON column as an object: parsed already (a contract line), or a stored
 * JSON string (a local row).
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function objectOf(value) {
  if (typeof value === 'string' && value.startsWith('{')) {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null
}

/**
 * The exemplar an edge's `source_keys` names, when it carries one. Most
 * `touched` edges carry only `session_id`; action-derived rules may add a
 * `message_id` or `part_id`.
 *
 * @param {unknown} sourceKeys
 * @returns {Exemplar | null}
 */
function exemplarOf(sourceKeys) {
  const keys = objectOf(sourceKeys)
  if (!keys) return null
  const message = str(keys.message_id)
  const part = str(keys.part_id)
  return message || part ? { message_id: message, part_id: part } : null
}
