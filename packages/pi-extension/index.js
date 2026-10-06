// HYPWARE_PI_EXTENSION v1
// @ts-check

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4322'
const LEASE = Symbol.for('hypaware.pi-extension.v1')
const MAX_BYTES = 512 * 1024
const QUEUE_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 4096
const MAX_SESSION_ENTRIES = 100000
const STALE_LEAF = Symbol('hypaware.pi-extension.stale-leaf')

/** Pi supplies the API at runtime; no Pi runtime dependency is installed. @param {any} pi */
export default function hypawarePi(pi) {
  const owner = {}
  const shared = /** @type {any} */ (globalThis)
  let leaf = null
  let nextEntry = 0
  let nextMessage = 0
  let enabled = false
  let stopping = false
  let endpoint = DEFAULT_ENDPOINT
  let queuedBytes = 0
  let dropped = 0
  let lastStatus = 'waiting for a persisted session'
  /** @type {{ body: string, bytes: number }[]} */
  const queue = []
  /** @type {Promise<void> | undefined} */
  let sending

  async function drain() {
    while (queue.length && !stopping) {
      const pending = queue.shift()
      if (!pending) continue
      const { body, bytes } = pending
      queuedBytes -= bytes
      try {
        const response = await fetch(`${endpoint}/entries`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
          signal: AbortSignal.timeout(1500),
        })
        await response.body?.cancel()
        lastStatus = response.ok ? 'connected' : `daemon returned ${response.status}; session recovery will retry`
        if (!response.ok) dropped++
      } catch {
        dropped++
        lastStatus = 'daemon unavailable; session recovery will retry'
      }
    }
  }

  /** @param {any} session @param {any[]} entries @param {string} mode @param {number[]} positions */
  function enqueue(session, entries, mode, positions) {
    if (!entries.length) return
    // Stop before walking payloads when the daemon cannot keep up. Encoding
    // also has a per-hook work budget, including entries too large to send.
    if (queuedBytes > QUEUE_BYTES - MAX_BYTES) { drop(); return }
    const budget = { remaining: QUEUE_BYTES - queuedBytes }
    const header = encodeJson(session, budget)
    if (!header) { drop(); return }
    const entrypoint = ['tui', 'print', 'json', 'rpc'].includes(mode) ? mode : 'unknown'
    const prefix = `{"version":2,"session":${header},"entrypoint":"${entrypoint}","entries":[`
    // Reserve enough for 64 INT32 positions and the parallel-array framing.
    const overhead = Buffer.byteLength(prefix) + 768
    let bytes = overhead
    /** @type {string[]} */
    let batch = []
    /** @type {number[]} */
    let batchPositions = []
    function flush() {
      if (!batch.length) return true
      if (queuedBytes + bytes > QUEUE_BYTES) { drop(); return false }
      const body = prefix + batch.join(',') + '],"message_indices":' + JSON.stringify(batchPositions) + '}'
      queue.push({ body, bytes })
      queuedBytes += bytes
      batch = []
      batchPositions = []
      bytes = overhead
      if (!sending) sending = drain().finally(() => { sending = undefined })
      return true
    }
    for (let index = 0; index < entries.length; index++) {
      if (budget.remaining <= 0 || queuedBytes > QUEUE_BYTES - MAX_BYTES) { drop(); break }
      const encoded = encodeJson(entries[index], budget)
      if (!encoded) { drop(); continue }
      const size = Buffer.byteLength(encoded)
      if (overhead + size > MAX_BYTES) { drop(); continue }
      if (batch.length && (batch.length >= 64 || bytes + size + 1 > MAX_BYTES)) {
        if (!flush()) return
      }
      bytes += size + (batch.length ? 1 : 0)
      batch.push(encoded)
      batchPositions.push(positions[index])
    }
    flush()
  }

  function drop() {
    dropped++
    lastStatus = 'capture encoding or queue limit; session recovery will retry'
  }

  /** @param {any} ctx @param {any[]} entries */
  function appended(ctx, entries) {
    const positions = entries.map(entry => {
      const index = nextMessage
      if (isPiMessageEntry(entry)) nextMessage++
      return index
    })
    nextEntry += entries.length
    if (nextEntry > MAX_SESSION_ENTRIES) {
      enabled = false
      lastStatus = 'session entry limit; live capture disabled'
      return
    }
    enqueue(ctx.sessionManager.getHeader(), entries, ctx.mode ?? 'unknown', positions)
  }

  // @ref LLP 0416#ordering: snapshots occur at startup/navigation, never each ordinary turn
  /** @param {any} ctx @param {boolean} deliver */
  function checkpoint(ctx, deliver) {
    const entries = ctx.sessionManager.getEntries()
    // This snapshot is what gets counted, so `leaf` may only stop a later
    // walk at an entry it holds. Pi can name a navigation summary as the leaf
    // before its entry list is rebuilt to hold it, and stopping there would
    // skip an entry nothing counted and shift every later position. A null
    // leaf over a non-empty snapshot is the same hazard: entries root at
    // parentId null, so a later walk would stop at the root and re-append the
    // whole counted chain. Only an empty snapshot may accept it.
    const head = ctx.sessionManager.getLeafId()
    leaf = (head == null && entries.length === 0) || holdsEntry(entries, head) ? head : STALE_LEAF
    if (entries.length > MAX_SESSION_ENTRIES || (deliver && entries.length < nextEntry)) {
      enabled = false
      lastStatus = 'session changed or exceeds entry limit; live capture disabled'
      return
    }
    if (deliver && entries.length - nextEntry <= MAX_ENTRIES) appended(ctx, entries.slice(nextEntry))
    else {
      if (deliver) drop()
      nextEntry = entries.length
      nextMessage = 0
      for (const entry of entries) if (isPiMessageEntry(entry)) nextMessage++
    }
  }

  // @ref LLP 0416#capture: only read IDs after Pi appended completed entries
  /** @param {any} _event @param {any} ctx */
  function capture(_event, ctx) {
    if (!enabled || stopping || shared[LEASE] !== owner) return
    if (leaf === STALE_LEAF) { checkpoint(ctx, true); return }
    const sm = ctx.sessionManager
    const head = sm.getLeafId()
    if (head === leaf) return
    const entries = []
    let id = head
    while (id && id !== leaf && entries.length < MAX_ENTRIES) {
      const entry = sm.getEntry(id)
      if (!entry) break
      entries.push(entry)
      id = entry.parentId
    }
    if (id !== leaf) {
      checkpoint(ctx, true)
      return
    }
    // Checkpoint only once this batch is actually deliverable. Advancing
    // `leaf` past entries `appended` never counted would leave the position
    // counters short and shift every later message index in the session.
    const session = sm.getHeader()
    if (!session || !sm.getSessionFile()) return
    leaf = head
    // Moving to an earlier branch is not new work. Entries still dedupe in
    // the daemon if a later traversal crosses an already-recorded branch.
    entries.reverse()
    appended(ctx, entries)
  }

  pi.on('session_start', (_event, ctx) => {
    if (shared[LEASE] && shared[LEASE] !== owner) return
    shared[LEASE] = owner
    stopping = false
    try {
      const url = new URL(process.env.HYP_PI_ENDPOINT ?? DEFAULT_ENDPOINT)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('not loopback')
      endpoint = url.origin
      enabled = Boolean(ctx.sessionManager.getSessionFile())
      lastStatus = enabled ? 'ready; waiting for completed entries' : 'ephemeral session; capture disabled'
    } catch {
      enabled = false
      lastStatus = 'invalid HYP_PI_ENDPOINT; expected http://127.0.0.1:port'
    }
    if (enabled) checkpoint(ctx, false)
  })
  for (const event of ['turn_end', 'agent_end', 'agent_settled', 'session_compact']) pi.on(event, capture)
  pi.on('session_before_tree', capture)
  pi.on('session_tree', (event, ctx) => {
    if (!enabled || stopping || shared[LEASE] !== owner) return
    checkpoint(ctx, true)
  })
  pi.on('session_shutdown', async (event, ctx) => {
    if (shared[LEASE] !== owner) return
    capture(event, ctx)
    if (sending) {
      let timer
      try { await Promise.race([sending, new Promise(resolve => { timer = setTimeout(resolve, 1800) })]) }
      finally { clearTimeout(timer) }
    }
    stopping = true
    enabled = false
    queue.length = 0
    queuedBytes = 0
    delete shared[LEASE]
  })
  pi.registerCommand('hypaware', {
    description: 'Show local HypAware capture status',
    handler: async (_args, ctx) => {
      ctx.ui.notify(`HypAware: ${lastStatus}. Capture drops: ${dropped}.`, 'info')
    },
  })
}

/** Newest first: a current snapshot holds the leaf it reports as its last entry. @param {any[]} entries @param {any} id */
function holdsEntry(entries, id) {
  for (let index = entries.length - 1; index >= 0; index--) if (entries[index]?.id === id) return true
  return false
}

/** Shared with recovery so metadata, invalid entries and pending output consume no position. @param {any} entry */
export function isPiMessageEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !entry.id.trim() ||
      typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) return false
  if (['compaction', 'branch_summary', 'custom_message'].includes(entry.type)) return true
  const message = entry.message
  return entry.type === 'message' && !!message && typeof message === 'object' && !Array.isArray(message) &&
    message.stopReason !== 'pending' && ['user', 'assistant', 'tool', 'system', 'toolResult', 'bashExecution'].includes(message.role)
}

/**
 * Bound traversal before stringify can allocate an arbitrarily large result.
 * Raw UTF-16 units bound visits and strings; JSON escaping can expand them by
 * at most six, then the exact UTF-8 check enforces the transport limit.
 * @param {any} value @param {{ remaining: number }} budget
 */
function encodeJson(value, budget) {
  let remaining = MAX_BYTES
  try {
    const encoded = JSON.stringify(value, (key, item) => {
      const cost = key.length + (typeof item === 'string' ? item.length : 1) + 4
      remaining -= cost
      budget.remaining -= cost
      if (remaining < 0 || budget.remaining < 0) throw new Error('encoding_budget')
      return item
    })
    return encoded && Buffer.byteLength(encoded) <= MAX_BYTES ? encoded : undefined
  } catch { return undefined }
}
