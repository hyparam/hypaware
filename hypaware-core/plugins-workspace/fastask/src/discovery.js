// @ts-check

import { MIN_TOKEN, PLACEHOLDER, basenameOf, isAbsolute, lastSegments, repoOfKey, splitTokens } from './index_builder.js'

/**
 * @import { Anchor, AnchorMatch, DiscoveryGroup, DiscoveryInput, DiscoveryResult, GraphIndex, Lead, LeadReason, Neighbor, NeighborNode, NeighborsInput, NeighborsResult, NeighborsStart, Term, VocabularyMismatch } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

/**
 * Discovery over the warm index (LLP 0480#discovery): question terms become
 * File anchors through the index's lookup maps, sessions that touched those
 * anchors are scored, and the best become leads. Pure in-memory work, no
 * model call, bounded by the anchor and visit budgets. The graph ranks; it
 * never excludes, and a question no File matches says so (`no_anchor`) so
 * the caller widens to text search.
 */

export const MAX_TERMS = 12
/** Postings one discover call examines at most (LLP 0488#path-tokens). */
export const MAX_POSTINGS = 60_000
/** A token in more files than this only scores candidates found through rarer tokens. */
export const SEED_MAX_FILES = 5_000
/** Terms this long or longer also match tokens that start with them. */
const PREFIX_MIN = 4
/** Term parts one call matches; parts past this are dropped. */
const MAX_PAIRS = 24
/** Tokens one prefix expands to. */
const MAX_PREFIX_TOKENS = 5_000
export const MAX_ANCHORS = 50
export const MAX_VISITS = 20_000
export const DEFAULT_LEADS = 8
export const MAX_LEADS = 40
export const DEFAULT_NEIGHBORS = 50
export const MAX_NEIGHBORS = 500
/** Start nodes one neighbors call takes. */
export const MAX_STARTS = 50

/** The edge discovery walks from a File back to its sessions. */
const TOUCH_EDGE = 'touched'
const SESSION_TYPE = 'Session'
const MIN_WORD = 3

// Short on purpose: a word that survives and matches nothing costs one map lookup.
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been',
  'before', 'being', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'each',
  'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me',
  'more', 'most', 'my', 'no', 'not', 'now', 'of', 'on', 'or', 'our', 'out', 'over', 'should', 'so',
  'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'to', 'too', 'under', 'up', 'us', 'was', 'way', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

// Anchor weights for scoring: the caller's repository counts most, then a
// proven identity anywhere, then a candidate (suffix or absolute path).
const WEIGHT_IN_REPO = 4
const WEIGHT_PROVEN = 2
const WEIGHT_CANDIDATE = 1
const WEIGHT_TERM = 2

/**
 * Whether this generation can answer discovery at all: it has File nodes but
 * no `touched` edges when a projector renamed the edge kind discovery walks.
 * Returns the edge types it does carry, so the status line, the span and the
 * `team_server` fallback can say why; null when the graph is usable (or has
 * no Files, where an empty answer is honest).
 *
 * @ref LLP 0484#edge-kinds [implements]: File nodes without touched edges is vocabulary_mismatch, answered through team_server, never silent empty discovery
 * @param {GraphIndex} index
 * @returns {VocabularyMismatch | null}
 */
export function vocabularyMismatch(index) {
  const file = index.nodeTypes.indexOf('File')
  if (file === -1 || index.nodeTypeCounts[file] === 0) return null
  const touched = index.edgeTypes.indexOf(TOUCH_EDGE)
  if (touched !== -1 && index.edgeTypeCounts[touched] > 0) return null
  /** @type {Record<string, number>} */
  const edgeTypes = {}
  index.edgeTypes.forEach((type, t) => { edgeTypes[type] = index.edgeTypeCounts[t] })
  return { error_kind: 'vocabulary_mismatch', edge_types: edgeTypes }
}

/**
 * Up to `max` terms from a question: path-like tokens and filenames as
 * written, then compound identifiers as written, then words (identifier parts
 * split on camelCase, snake_case and punctuation, and plain words) minus
 * stopwords. Deduplicated case-insensitively, in that order.
 *
 * @param {string} question
 * @param {number} [max]
 * @returns {Term[]}
 */
export function extractTerms(question, max = MAX_TERMS) {
  /** @type {Term[]} */
  const paths = []
  /** @type {Term[]} */
  const identifiers = []
  /** @type {Term[]} */
  const words = []
  for (const raw of question.split(/\s+/)) {
    const token = raw.replace(/^[\s"'`([{<]+|[\s"'`)\]}>,;:!?.]+$/g, '')
    if (!token) continue
    if (isPathLike(token)) {
      paths.push({ text: token, kind: 'path' })
      continue
    }
    const parts = token.split(/[^A-Za-z0-9]+/).flatMap(splitCamel).filter(Boolean)
    if (parts.length > 1 && /^[A-Za-z_$][\w$-]*$/.test(token)) identifiers.push({ text: token, kind: 'identifier' })
    for (const part of parts) {
      const word = part.toLowerCase()
      if (word.length >= MIN_WORD && !STOPWORDS.has(word) && !/^\d+$/.test(word)) words.push({ text: word, kind: 'word' })
    }
  }
  /** @type {Term[]} */
  const terms = []
  const seen = new Set()
  for (const term of [...paths, ...identifiers, ...words]) {
    const key = term.text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length === max) break
  }
  return terms
}

/**
 * Terms an agent chose, used as written: no splitting and no stopwords, only
 * trimmed, deduplicated case-insensitively and capped at `max`. A path-like
 * term resolves like a relative `--file`; any other matches basenames and
 * stems.
 *
 * @param {string[]} given
 * @param {number} [max]
 * @returns {Term[]}
 */
export function explicitTerms(given, max = MAX_TERMS) {
  /** @type {Term[]} */
  const terms = []
  const seen = new Set()
  for (const raw of given) {
    const text = raw.trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    terms.push({ text, kind: isPathLike(text) ? 'path' : 'word' })
    if (terms.length === max) break
  }
  return terms
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isPathLike(token) {
  return /[\\/]/.test(token) || /^\S*\.[\p{L}\p{N}]{1,8}$/u.test(token)
}

/**
 * @param {string} part
 * @returns {string[]}
 */
function splitCamel(part) {
  return part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
}

/**
 * Discovers leads for one question. Bounded: at most `maxAnchors` anchors
 * (shared fairly across terms), at most `maxVisits` adjacency slots read
 * (shared fairly across anchors, newest touches first), and lead selection
 * over the sessions those visits met.
 *
 * @param {GraphIndex} index
 * @param {DiscoveryInput} input
 * @returns {DiscoveryResult}
 */
export function discover(index, input) {
  const leadsWanted = Math.min(Math.max(1, input.leads ?? DEFAULT_LEADS), MAX_LEADS)
  const maxAnchors = input.maxAnchors ?? MAX_ANCHORS
  const maxVisits = input.maxVisits ?? MAX_VISITS
  const repo = input.repo ? input.repo.toLowerCase() : null
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  // @ref LLP 0487#decision [implements]: agent-directed discover takes the agent's own terms, used as written
  const terms = input.terms ? explicitTerms(input.terms) : extractTerms(input.question)

  // `--file` anchors resolve exactly or by suffix; terms match path tokens
  // (LLP 0488#path-tokens). Each anchor records which terms (or which --file)
  // it covers, for scoring sessions by distinct terms.
  /** @type {Array<{ text: string, candidates: Anchor[][], overflow: number }>} */
  const sources = []
  for (const file of input.files ?? []) {
    sources.push(fileCandidates(index, file, repo, input.repoRoot ?? null, maxAnchors))
  }
  const fileSide = pickAnchors(sources, maxAnchors)
  const fileIndex = new Map(sources.map((src, n) => [src.text, terms.length + n]))
  const tokenSide = tokenAnchors(index, terms, repo, input.repoRoot ?? null, maxAnchors - fileSide.anchors.length, new Set(fileSide.anchors.map((a) => a.node)), Math.min(input.maxPostings ?? MAX_POSTINGS, MAX_POSTINGS))
  const anchors = [...fileSide.anchors, ...tokenSide.anchors]
  /** @type {number[][]} */
  const anchorTerms = [...fileSide.anchors.map((a) => [/** @type {number} */ (fileIndex.get(a.term))]), ...tokenSide.terms]
  const dropped = fileSide.dropped + tokenSide.dropped

  // Anchors still resolve (they say what the question named); the walk would
  // find nothing, so the caller is told to ask the team server instead.
  const mismatch = vocabularyMismatch(index)
  if (mismatch) {
    return {
      terms,
      anchors,
      leads: [],
      ambiguous: false,
      groups: [],
      no_anchor: anchors.length === 0,
      fallback: { reason: mismatch.error_kind, edge_types: mismatch.edge_types },
      page: { offset, limit: leadsWanted, next_offset: null },
      coverage: { visits: 0, truncated: false, anchors_truncated: dropped, unresolved_edges_met: 0, sessions_considered: 0, postings_examined: tokenSide.examined },
    }
  }

  // @ref LLP 0480#discovery [implements]: walk touched edges into each anchor within a 20,000-visit budget, sharing it fairly across anchors
  const touched = index.edgeTypes.indexOf(TOUCH_EDGE)
  const sessionType = index.nodeTypes.indexOf(SESSION_TYPE)
  /** @type {Map<number, { score: number, sources: number[], reasons: Array<{ anchor: number, edge: number }>, latest: number, exemplarEdge: number }>} */
  const sessions = new Map()
  let visits = 0
  let truncated = false
  let unresolvedMet = 0
  for (let a = 0; a < anchors.length; a++) {
    const anchor = anchors[a]
    const share = Math.ceil((maxVisits - visits) / (anchors.length - a))
    const start = index.inOffsets[anchor.node]
    const end = index.inOffsets[anchor.node + 1]
    if (end - start > share) truncated = true
    const stop = Math.min(end, start + share)
    for (let p = start; p < stop; p++) {
      visits++
      const e = index.inEdges[p]
      if (index.edgeType[e] !== touched) continue
      const s = index.edgeSrc[e]
      if (index.nodeType[s] !== sessionType) continue
      if (index.nodeFlags[s] & PLACEHOLDER) {
        unresolvedMet++
        continue
      }
      let rec = sessions.get(s)
      if (!rec) {
        rec = { score: 0, sources: [], reasons: [], latest: NaN, exemplarEdge: -1 }
        sessions.set(s, rec)
      }
      rec.reasons.push({ anchor: a, edge: e })
      rec.score += weightOf(anchor)
      for (const n of anchorTerms[a]) {
        if (rec.sources.includes(n)) continue
        rec.sources.push(n)
        rec.score += WEIGHT_TERM
      }
      const at = index.edgeFirstSeen[e]
      if (newer(at, rec.latest) > 0) rec.latest = at
      if (index.exemplars.has(e) && (rec.exemplarEdge === -1 || newer(at, index.edgeFirstSeen[rec.exemplarEdge]) > 0)) rec.exemplarEdge = e
    }
  }

  // @ref LLP 0480#discovery [implements]: competing files for one term stay separate groups, never one confident lead
  const { groups, groupOf, ambiguous } = groupAnchors(anchors, sessions)

  const ranked = [...sessions.entries()].sort(([s1, r1], [s2, r2]) =>
    r2.score - r1.score || newer(r2.latest, r1.latest) || compareKeys(index.naturalKey[s1], index.naturalKey[s2]))
  // A page is the same ordering cut at `offset`: the round-robin over
  // competing groups is computed through the page's end, then sliced.
  const through = offset + leadsWanted
  const ordered = ambiguous ? roundRobin(ranked, (entry) => primaryGroup(entry[1], anchors, groupOf), groups, through) : ranked.slice(0, through)
  const chosen = ordered.slice(offset)

  /** @type {Lead[]} */
  const leads = chosen.map(([s, rec], n) => toLead(index, anchors, s, rec, offset + n + 1, groups[primaryGroup(rec, anchors, groupOf)].key))
  const nextOffset = offset + chosen.length

  return {
    terms,
    anchors,
    leads,
    ambiguous,
    groups,
    no_anchor: anchors.length === 0,
    fallback: null,
    page: { offset, limit: leadsWanted, next_offset: nextOffset < sessions.size ? nextOffset : null },
    coverage: {
      visits,
      truncated,
      anchors_truncated: dropped,
      unresolved_edges_met: unresolvedMet,
      sessions_considered: sessions.size,
      postings_examined: tokenSide.examined,
    },
  }
}

/**
 * @param {Anchor} anchor
 * @returns {number}
 */
function weightOf(anchor) {
  return anchor.in_repo ? WEIGHT_IN_REPO : anchor.proven ? WEIGHT_PROVEN : WEIGHT_CANDIDATE
}

/**
 * Preference tier of an anchor: 0 in the caller's repository, 1 proven
 * elsewhere, 2 a candidate only.
 *
 * @param {Anchor} anchor
 * @returns {number}
 */
function tierOf(anchor) {
  return anchor.in_repo ? 0 : anchor.proven ? 1 : 2
}

/**
 * Candidate anchors for one `--file`: exactly (`owner/repo:relpath` when the
 * repository is known, else the absolute path), else by suffix.
 *
 * @param {GraphIndex} index
 * @param {string} file
 * @param {string | null} repo
 * @param {string | null} repoRoot
 * @param {number} cap
 */
function fileCandidates(index, file, repo, repoRoot, cap) {
  const source = newSource(file)
  const path = file.replace(/\\/g, '/')
  const absolute = isAbsolute(file)
  const rel = absolute ? relativeTo(repoRoot, path) : normalizeRel(path)
  const base = basenameOf(path).toLowerCase()
  const named = all(index.fileByBasename.get(base))

  /** @type {Array<{ key: string, match: AnchorMatch }>} */
  const exact = []
  if (repo && rel) exact.push({ key: `${repo}:${rel}`, match: 'exact' })
  if (absolute) exact.push({ key: path, match: 'absolute' })
  for (const want of exact) {
    for (const node of named) {
      if (index.naturalKey[node] === want.key) add(source, anchorFor(index, node, file, want.match, repo), cap)
    }
  }
  if (count(source) > 0) return source

  // An absolute path from another checkout only shares its tail with ours.
  // @ref LLP 0480#discovery [implements]: suffix matches are candidates, not proven identity
  const suffix = rel ?? (absolute ? lastSegments(path, 3) ?? normalizeRel(path) : normalizeRel(path))
  if (!suffix) return source
  const last3 = lastSegments(suffix, 3)
  /** @type {Set<number>} */
  const pool = new Set(last3 === null ? [] : all(index.fileBySuffix.get(last3.toLowerCase())))
  for (const node of named) pool.add(node)
  const tail = suffix.toLowerCase()
  for (const node of pool) {
    const key = /** @type {string} */ (index.naturalKey[node]).toLowerCase()
    if (key === tail || key.endsWith(`/${tail}`) || key.endsWith(`:${tail}`)) {
      add(source, anchorFor(index, node, file, 'suffix', repo), cap)
    }
  }
  return source
}

/**
 * Anchors for the question's terms by path tokens (LLP 0488#path-tokens).
 * Each term is tokenized by the index's own rule; parts under 3 characters
 * are dropped, and a term matches a file only when every part matches one of
 * its tokens (equal, or a prefix for parts of 4 or more characters). Postings
 * are read rarest token first, at most `MAX_POSTINGS` of them; a token in more
 * than `SEED_MAX_FILES` files never seeds a candidate, only scores the ones
 * rarer tokens found (a binary search in its sorted postings). Files rank by
 * the caller's repository first, then distinct terms matched, then a weight
 * (basename over directory, exact over prefix, rarer over common; a compound
 * term counts once and takes its rarest part's rarity), then the most recent
 * touch. Files elsewhere stay as candidates, ranked below, unproven.
 *
 * Work per call: at most `MAX_POSTINGS` postings plus one binary search per
 * candidate and common token; memory, two small arrays per candidate.
 *
 * @ref LLP 0488#path-tokens [implements]: terms match path tokens (equal, or prefix from 4 characters), rarest first, bounded postings, common tokens only score, caller repository first
 * @param {GraphIndex} index
 * @param {Term[]} terms
 * @param {string | null} repo lowercased `owner/repo`
 * @param {string | null} repoRoot
 * @param {number} max anchors wanted
 * @param {Set<number>} taken nodes already anchored by `--file`
 * @param {number} maxPostings
 * @returns {{ anchors: Anchor[], terms: number[][], dropped: number, examined: number }}
 */
function tokenAnchors(index, terms, repo, repoRoot, max, taken, maxPostings) {
  /** @type {Array<{ term: number, part: string }>} */
  const pairs = []
  /** @type {number[][]} */
  const pairsOf = terms.map(() => [])
  terms.forEach((term, t) => {
    for (const part of new Set(splitTokens(term.text).filter((p) => p.length >= MIN_TOKEN))) {
      if (pairs.length === MAX_PAIRS) break
      pairsOf[t].push(pairs.length)
      pairs.push({ term: t, part })
    }
  })
  const P = pairs.length
  if (P === 0 || max <= 0) return { anchors: [], terms: [], dropped: 0, examined: 0 }
  const fileType = index.nodeTypes.indexOf('File')
  const fileTotal = Math.max(1, fileType === -1 ? 0 : index.nodeTypeCounts[fileType])

  /** @type {Array<{ pair: number, tok: number, exact: boolean, count: number }>} */
  const seeds = []
  /** @type {Array<Array<{ tok: number, exact: boolean, count: number }>>} */
  const common = pairs.map(() => [])
  pairs.forEach(({ part }, k) => {
    for (const tok of matchingTokens(index, part)) {
      const count = index.tokenOffsets[tok + 1] - index.tokenOffsets[tok]
      const entry = { tok, exact: index.tokenNames[tok] === part, count }
      if (count > SEED_MAX_FILES) common[k].push(entry)
      else seeds.push({ pair: k, ...entry })
    }
  })
  seeds.sort((a, b) => a.count - b.count)

  /** @type {Map<number, number>} */
  const ordOf = new Map()
  /** @type {number[]} */
  const nodes = []
  let grades = new Uint8Array(64 * P)
  let weights = new Float32Array(64 * P)
  /** @param {number} node */
  const ordFor = (node) => {
    let ord = ordOf.get(node)
    if (ord !== undefined) return ord
    ord = nodes.length
    nodes.push(node)
    ordOf.set(node, ord)
    if ((ord + 1) * P > grades.length) {
      const g = new Uint8Array(grades.length * 2)
      g.set(grades)
      grades = g
      const w = new Float32Array(weights.length * 2)
      w.set(weights)
      weights = w
    }
    return ord
  }
  /** @param {number} idx @param {number} base @param {boolean} exact @param {number} count */
  const record = (idx, base, exact, count) => {
    const grade = base ? (exact ? 4 : 3) : (exact ? 2 : 1)
    const weight = Math.log(1 + fileTotal / count)
    if (grade > grades[idx] || (grade === grades[idx] && weight > weights[idx])) {
      grades[idx] = grade
      weights[idx] = weight
    }
  }

  let examined = 0
  let truncated = false
  seed: for (const entry of seeds) {
    for (let q = index.tokenOffsets[entry.tok]; q < index.tokenOffsets[entry.tok + 1]; q++) {
      if (examined === maxPostings) {
        truncated = true
        break seed
      }
      examined++
      const packed = index.tokenPostings[q]
      record(ordFor(packed >>> 1) * P + entry.pair, packed & 1, entry.exact, entry.count)
    }
  }
  for (let ord = 0; ord < nodes.length; ord++) {
    for (let k = 0; k < P; k++) {
      for (const entry of common[k]) {
        const base = member(index, entry.tok, nodes[ord])
        if (base !== -1) record(ord * P + k, base, entry.exact, entry.count)
      }
    }
  }

  /** @type {Array<{ node: number, inRepo: boolean, matched: number[], weight: number, allExact: boolean, recent: number }>} */
  const ranked = []
  const root = repoRoot ? repoRoot.replace(/\\/g, '/').replace(/\/+$/, '') : null
  for (let ord = 0; ord < nodes.length; ord++) {
    const node = nodes[ord]
    if (taken.has(node)) continue
    /** @type {number[]} */
    const matched = []
    let weight = 0
    let allExact = true
    for (let t = 0; t < terms.length; t++) {
      const ks = pairsOf[t]
      if (ks.length === 0) continue
      let grade = 4
      let rarity = 0
      for (const k of ks) {
        const g = grades[ord * P + k]
        if (g < grade) grade = g
        if (weights[ord * P + k] > rarity) rarity = weights[ord * P + k]
        if (g === 1 || g === 3) allExact = false
      }
      if (grade === 0) continue
      matched.push(t)
      weight += grade * rarity
    }
    if (matched.length === 0) continue
    const key = /** @type {string} */ (index.naturalKey[node])
    const keyRepo = repoOfKey(key)
    const inRepo = keyRepo !== null ? repo !== null && keyRepo.toLowerCase() === repo : root !== null && key.replace(/\\/g, '/').startsWith(`${root}/`)
    const first = index.inOffsets[node]
    const recent = first < index.inOffsets[node + 1] ? index.edgeFirstSeen[index.inEdges[first]] : NaN
    ranked.push({ node, inRepo, matched, weight, allExact, recent })
  }
  ranked.sort((a, b) => Number(b.inRepo) - Number(a.inRepo) || b.matched.length - a.matched.length || b.weight - a.weight
    || newer(b.recent, a.recent) || compareKeys(index.naturalKey[a.node], index.naturalKey[b.node]))
  const kept = ranked.slice(0, max)
  return {
    anchors: kept.map((r) => ({
      node: r.node,
      node_id: index.nodeIdOf[r.node],
      key: /** @type {string} */ (index.naturalKey[r.node]),
      term: r.matched.map((t) => terms[t].text).join(' + '),
      match: r.allExact ? 'token' : 'token_prefix',
      proven: r.inRepo,
      in_repo: r.inRepo,
    })),
    terms: kept.map((r) => r.matched),
    dropped: ranked.length - kept.length + (truncated && ranked.length <= kept.length ? 1 : 0),
    examined,
  }
}

/**
 * The tokens a term part matches: itself, and for parts of `PREFIX_MIN` or
 * more characters every token that starts with it (a range of the sorted
 * token list), at most `MAX_PREFIX_TOKENS`.
 *
 * @param {GraphIndex} index
 * @param {string} part
 * @returns {number[]}
 */
function matchingTokens(index, part) {
  if (part.length < PREFIX_MIN) {
    const exact = index.tokenIds.get(part)
    return exact === undefined ? [] : [exact]
  }
  const sorted = index.sortedTokenIds
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (index.tokenNames[sorted[mid]] < part) lo = mid + 1
    else hi = mid
  }
  /** @type {number[]} */
  const out = []
  for (let i = lo; i < sorted.length && out.length < MAX_PREFIX_TOKENS && index.tokenNames[sorted[i]].startsWith(part); i++) out.push(sorted[i])
  return out
}

/**
 * Whether `node` carries token `tok`: -1 if not, else 1 when the token is in
 * its basename and 0 when only in a directory. A binary search in the
 * token's ascending postings.
 *
 * @param {GraphIndex} index
 * @param {number} tok
 * @param {number} node
 * @returns {number}
 */
function member(index, tok, node) {
  let lo = index.tokenOffsets[tok]
  let hi = index.tokenOffsets[tok + 1]
  const want = node * 2
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (index.tokenPostings[mid] < want) lo = mid + 1
    else hi = mid
  }
  const packed = lo < index.tokenOffsets[tok + 1] ? index.tokenPostings[lo] : -1
  return packed !== -1 && packed >>> 1 === node ? packed & 1 : -1
}

/**
 * @param {string} text
 * @returns {{ text: string, candidates: Anchor[][], overflow: number }}
 */
function newSource(text) {
  return { text, candidates: [[], [], []], overflow: 0 }
}

/**
 * Keeps at most `cap` candidates per tier, counting the rest, so a term that
 * names ten thousand `index.js` files allocates no more than a rare one.
 *
 * @param {{ candidates: Anchor[][], overflow: number }} source
 * @param {Anchor} anchor
 * @param {number} cap
 */
function add(source, anchor, cap) {
  const tier = source.candidates[tierOf(anchor)]
  if (tier.length < cap) tier.push(anchor)
  else source.overflow++
}

/**
 * @param {{ candidates: Anchor[][] }} source
 * @returns {number}
 */
function count(source) {
  return source.candidates[0].length + source.candidates[1].length + source.candidates[2].length
}

/**
 * @param {GraphIndex} index
 * @param {number} node
 * @param {string} term
 * @param {AnchorMatch} match
 * @param {string | null} repo
 * @returns {Anchor}
 */
function anchorFor(index, node, term, match, repo) {
  const key = /** @type {string} */ (index.naturalKey[node])
  const keyRepo = repoOfKey(key)
  return {
    node,
    node_id: index.nodeIdOf[node],
    key,
    term,
    match,
    proven: keyRepo !== null && match !== 'suffix',
    in_repo: keyRepo !== null && repo !== null && keyRepo.toLowerCase() === repo,
  }
}

/**
 * Takes up to `max` anchors round-robin across sources, each source's best
 * tier first, so one common term cannot crowd out the rest.
 *
 * @param {Array<{ text: string, candidates: Anchor[][], overflow: number }>} sources
 * @param {number} max
 * @returns {{ anchors: Anchor[], dropped: number }}
 */
function pickAnchors(sources, max) {
  const queues = sources.map((s) => s.candidates.flat())
  /** @type {Anchor[]} */
  const anchors = []
  const taken = new Set()
  let total = sources.reduce((sum, s) => sum + s.overflow, 0)
  for (const q of queues) total += q.length
  for (let round = 0; anchors.length < max; round++) {
    let any = false
    for (const q of queues) {
      if (round >= q.length) continue
      any = true
      const anchor = q[round]
      // A file two terms both name is walked once, under the first term.
      if (taken.has(anchor.node)) {
        total--
        continue
      }
      taken.add(anchor.node)
      anchors.push(anchor)
      if (anchors.length === max) break
    }
    if (!any) break
  }
  return { anchors, dropped: total - anchors.length }
}

/**
 * Groups anchors by the term or `--file` that matched them. A source whose
 * best tier reached sessions through two or more files is ambiguous: each of
 * those files becomes its own competing group.
 *
 * @param {Anchor[]} anchors
 * @param {Map<number, { reasons: Array<{ anchor: number, edge: number }> }>} sessions
 * @returns {{ groups: DiscoveryGroup[], groupOf: number[], ambiguous: boolean }}
 */
function groupAnchors(anchors, sessions) {
  /** @type {Map<number, number>} anchor -> sessions reached */
  const reached = new Map()
  for (const rec of sessions.values()) {
    for (const reason of rec.reasons) reached.set(reason.anchor, (reached.get(reason.anchor) ?? 0) + 1)
  }
  /** @type {Map<string, number[]>} */
  const byTerm = new Map()
  anchors.forEach((anchor, a) => {
    const list = byTerm.get(anchor.term)
    if (list) list.push(a)
    else byTerm.set(anchor.term, [a])
  })

  /** @type {DiscoveryGroup[]} */
  const groups = []
  const groupOf = new Array(anchors.length).fill(-1)
  let ambiguous = false
  for (const [term, list] of byTerm) {
    const live = list.filter((a) => reached.has(a))
    const best = live.length ? Math.min(...live.map((a) => tierOf(anchors[a]))) : 0
    const competing = live.filter((a) => tierOf(anchors[a]) === best)
    if (competing.length > 1) {
      ambiguous = true
      for (const a of competing) {
        groupOf[a] = groups.length
        groups.push({ key: anchors[a].key, term, files: [anchors[a].key], sessions: /** @type {number} */ (reached.get(a)) })
      }
    }
    const rest = list.filter((a) => groupOf[a] === -1)
    if (rest.length) {
      const g = groups.length
      for (const a of rest) groupOf[a] = g
      groups.push({ key: term, term, files: rest.map((a) => anchors[a].key), sessions: rest.reduce((n, a) => n + (reached.get(a) ?? 0), 0) })
    }
  }
  return { groups, groupOf, ambiguous }
}

/**
 * The group of a session's strongest reason (ties: the earliest anchor).
 *
 * @param {{ reasons: Array<{ anchor: number }> }} rec
 * @param {Anchor[]} anchors
 * @param {number[]} groupOf
 * @returns {number}
 */
function primaryGroup(rec, anchors, groupOf) {
  let best = rec.reasons[0].anchor
  for (const { anchor } of rec.reasons) {
    if (weightOf(anchors[anchor]) > weightOf(anchors[best])) best = anchor
  }
  return groupOf[best]
}

/**
 * Takes leads one group at a time (groups ordered by their best session), so
 * every competing file is represented before any group gets a second lead.
 *
 * @template T
 * @param {T[]} ranked
 * @param {(entry: T) => number} groupFor
 * @param {DiscoveryGroup[]} groups
 * @param {number} wanted
 * @returns {T[]}
 */
function roundRobin(ranked, groupFor, groups, wanted) {
  /** @type {T[][]} */
  const queues = groups.map(() => [])
  /** @type {number[]} */
  const order = []
  for (const entry of ranked) {
    const g = groupFor(entry)
    if (queues[g].length === 0) order.push(g)
    queues[g].push(entry)
  }
  /** @type {T[]} */
  const chosen = []
  for (let round = 0; chosen.length < wanted; round++) {
    let any = false
    for (const g of order) {
      if (round >= queues[g].length) continue
      any = true
      chosen.push(queues[g][round])
      if (chosen.length === wanted) break
    }
    if (!any) break
  }
  return chosen
}

/**
 * @param {GraphIndex} index
 * @param {Anchor[]} anchors
 * @param {number} s
 * @param {{ score: number, reasons: Array<{ anchor: number, edge: number }>, latest: number, exemplarEdge: number }} rec
 * @param {number} rank
 * @param {string} group
 * @returns {Lead}
 */
function toLead(index, anchors, s, rec, rank, group) {
  const reasons = [...rec.reasons].sort((x, y) =>
    weightOf(anchors[y.anchor]) - weightOf(anchors[x.anchor]) || newer(index.edgeFirstSeen[y.edge], index.edgeFirstSeen[x.edge]))
  /** @type {LeadReason[]} */
  const why = reasons.map(({ anchor: a, edge }) => {
    const anchor = anchors[a]
    return {
      anchor: { type: 'File', node_id: anchor.node_id, key: anchor.key, match: anchor.match, proven: anchor.proven, in_repo: anchor.in_repo },
      term: anchor.term,
      edge: index.edgeTypes[index.edgeType[edge]],
      touched_at: iso(index.edgeFirstSeen[edge]),
    }
  })
  const props = index.sessionProps.get(s)
  return {
    session_id: /** @type {string} */ (index.naturalKey[s]),
    node_id: index.nodeIdOf[s],
    rank,
    score: rec.score,
    group,
    why,
    touched_at: iso(rec.latest),
    exemplar: rec.exemplarEdge === -1 ? null : index.exemplars.get(rec.exemplarEdge) ?? null,
    session: {
      first_seen: iso(index.nodeFirstSeen[s]),
      cwd: props?.cwd ?? null,
      git_branch: props?.git_branch ?? null,
      client_name: props?.client_name ?? null,
      user_id: props?.user_id ?? null,
    },
  }
}

/**
 * Descending by time with absent (NaN) times last.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function newer(a, b) {
  if (a === b) return 0
  if (a !== a) return -1
  if (b !== b) return 1
  return a - b
}

/**
 * @param {string | null} a
 * @param {string | null} b
 * @returns {number}
 */
function compareKeys(a, b) {
  return (a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0
}

/**
 * @param {number} ms
 * @returns {string | null}
 */
function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * @param {number | number[] | undefined} value
 * @returns {number[]}
 */
function all(value) {
  return value === undefined ? [] : typeof value === 'number' ? [value] : value
}

/**
 * A repository-relative POSIX path: no leading `./` or `/`.
 *
 * @param {string} path
 * @returns {string | null}
 */
function normalizeRel(path) {
  let p = path
  while (p.startsWith('./')) p = p.slice(2)
  while (p.startsWith('/')) p = p.slice(1)
  return p || null
}

/**
 * @param {string | null} root
 * @param {string} path
 * @returns {string | null}
 */
function relativeTo(root, path) {
  if (!root) return null
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return path.startsWith(`${r}/`) ? normalizeRel(path.slice(r.length + 1)) : null
}

/**
 * One hop from the given nodes (LLP 0487#decision `neighbors`): their edges
 * in the chosen direction, newest first, optionally only some edge types.
 * Bounded like discovery: at most `MAX_STARTS` start nodes, a visit budget
 * (20,000) shared fairly across them, and at most `limit` neighbors returned;
 * both truncations are reported. Keys resolve in one pass over the node table
 * however many are asked for. Placeholder neighbors are returned and counted,
 * not dropped.
 *
 * @ref LLP 0487#decision [implements]: neighbors walks the index's CSR adjacency within the same 20,000-visit budget
 * @param {GraphIndex} index
 * @param {NeighborsInput} input
 * @returns {NeighborsResult}
 */
export function neighbors(index, input) {
  const direction = input.direction ?? 'both'
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DEFAULT_NEIGHBORS)), MAX_NEIGHBORS)
  const maxVisits = Math.min(Math.max(1, Math.floor(input.maxVisits ?? MAX_VISITS)), MAX_VISITS)
  const wanted = input.edgeTypes?.length ? new Set(input.edgeTypes.map((t) => index.edgeTypes.indexOf(t)).filter((t) => t !== -1)) : null

  /** @type {NeighborsStart[]} */
  const starts = []
  /** @type {number[]} */
  const nodes = []
  const asked = [...(input.ids ?? []).map((v) => ({ input: v, by: /** @type {const} */ ('id') })), ...(input.keys ?? []).map((v) => ({ input: v, by: /** @type {const} */ ('key') }))]
  const startsDropped = Math.max(0, asked.length - MAX_STARTS)
  const kept = asked.slice(0, MAX_STARTS)
  /** @type {Map<string, number[]>} */
  const byKey = new Map(kept.filter((a) => a.by === 'key').map((a) => [a.input, []]))
  if (byKey.size > 0) {
    for (let i = 0; i < index.nodeCount; i++) {
      const key = index.naturalKey[i]
      if (key !== null) byKey.get(key)?.push(i)
    }
  }
  for (const a of kept) {
    const found = a.by === 'id' ? (index.nodeIds.has(a.input) ? [/** @type {number} */ (index.nodeIds.get(a.input))] : []) : /** @type {number[]} */ (byKey.get(a.input))
    if (found.length === 0) starts.push({ input: a.input, by: a.by, found: false, node_id: null, type: null, key: null })
    for (const n of found) {
      starts.push({ input: a.input, by: a.by, found: true, node_id: index.nodeIdOf[n], type: index.nodeTypes[index.nodeType[n]], key: index.naturalKey[n] })
      nodes.push(n)
    }
  }

  /** @type {Neighbor[]} */
  const out = []
  let visits = 0
  let truncated = false
  let resultsTruncated = false
  let unresolved = 0
  const directions = direction === 'both' ? /** @type {const} */ (['out', 'in']) : [direction]
  walk: for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k]
    let share = Math.ceil((maxVisits - visits) / (nodes.length - k))
    for (const dir of directions) {
      const offsets = dir === 'out' ? index.outOffsets : index.inOffsets
      const edges = dir === 'out' ? index.outEdges : index.inEdges
      for (let p = offsets[n]; p < offsets[n + 1]; p++) {
        if (share === 0) {
          truncated = true
          break
        }
        share--
        visits++
        const e = edges[p]
        if (wanted && !wanted.has(index.edgeType[e])) continue
        if (out.length === limit) {
          resultsTruncated = true
          break walk
        }
        const other = dir === 'out' ? index.edgeDst[e] : index.edgeSrc[e]
        const node = neighborNode(index, other)
        if (node.placeholder) unresolved++
        out.push({
          from: index.nodeIdOf[n],
          direction: dir,
          edge_type: index.edgeTypes[index.edgeType[e]],
          first_seen: iso(index.edgeFirstSeen[e]),
          exemplar: index.exemplars.get(e) ?? null,
          node,
        })
      }
    }
  }
  return {
    starts,
    neighbors: out,
    coverage: { visits, truncated, results_truncated: resultsTruncated, unresolved_met: unresolved, starts_dropped: startsDropped },
  }
}

/**
 * @param {GraphIndex} index
 * @param {number} n
 * @returns {NeighborNode}
 */
function neighborNode(index, n) {
  const placeholder = (index.nodeFlags[n] & PLACEHOLDER) !== 0
  const key = index.naturalKey[n]
  /** @type {NeighborNode} */
  const node = { node_id: index.nodeIdOf[n], type: index.nodeTypes[index.nodeType[n]], key, label: index.label[n] ?? key, placeholder }
  const props = index.sessionProps.get(n)
  if (props) node.session = { first_seen: iso(index.nodeFirstSeen[n]), ...props }
  return node
}
