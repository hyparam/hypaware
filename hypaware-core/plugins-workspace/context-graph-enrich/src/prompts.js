// @ts-check

/**
 * Model I/O for the two tiers. Both use a forced tool so the model returns
 * schema-shaped structured output (a `tool_use` block) rather than prose —
 * the structured-extraction channel of `hypaware.completion`.
 *
 * @import { CompletionRequest, CompletionResult } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { CurateDecision } from './types.d.ts'
 */

/** Enrichment node types the proposer may emit. Small + closed for v1. */
export const PROSPECT_TYPES = Object.freeze(['Decision', 'Concept', 'Fact', 'Constraint', 'Question'])

const EMIT_PROSPECTS_TOOL = {
  name: 'emit_prospects',
  description: 'Emit candidate knowledge items extracted from the text.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      prospects: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: [...PROSPECT_TYPES] },
            label: { type: 'string', description: 'A short canonical name for the item (used as its key).' },
            summary: { type: 'string', description: 'One sentence stating the item.' },
            confidence: { type: 'number', description: '0..1 — your confidence this is a real, useful item.' },
            evidence: { type: 'string', description: 'A short quote from the text supporting it.' },
          },
          required: ['type', 'label'],
        },
      },
    },
    required: ['prospects'],
  },
}

const T1_SYSTEM =
  'You extract candidate knowledge (decisions, concepts, facts, constraints, open questions) from a work session transcript. ' +
  'OVER-PROPOSE: favor recall over precision — a later curation step prunes. Emit many small, specific candidates rather than few broad ones. ' +
  'Each candidate gets a short canonical `label` (its key), a one-sentence `summary`, a `confidence` in 0..1, and a supporting `evidence` quote.'

const CURATE_DECISIONS_TOOL = {
  name: 'curate_decisions',
  description: 'Decide what to do with EACH listed prospect, given the shared graph neighborhood and source.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      decisions: {
        type: 'array',
        description: 'One entry per prospect, referenced by its 1-based index. Include every prospect.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer', description: '1-based index of the prospect this decision applies to.' },
            decision: { type: 'string', enum: ['commit', 'merge', 'deepen', 'reject'] },
            item_type: { type: 'string', description: 'Final node type (for commit/deepen).' },
            item_key: { type: 'string', description: 'Final canonical key (for commit/deepen). Reuse an existing key to converge.' },
            label: { type: 'string', description: 'Final human-readable label.' },
            summary: { type: 'string', description: 'Final one-sentence statement of the item.' },
            confidence: { type: 'number', description: '0..1 — final confidence after curation.' },
            merge_into: { type: 'string', description: 'Existing item key to merge into (for merge).' },
            note: { type: 'string', description: 'Short rationale.' },
          },
          required: ['index', 'decision'],
        },
      },
    },
    required: ['decisions'],
  },
}

const T2_SYSTEM =
  'You are a graph librarian curating proposed knowledge for a context graph. ' +
  'You are given SEVERAL prospects from the same work session, plus the shared graph neighborhood, ' +
  'per-prospect similar existing items, and the shared source excerpt. For EACH prospect choose exactly one action: ' +
  '`commit` (real and new — give a final type, canonical key, label, summary, confidence), ' +
  '`merge` (duplicates an existing item — give `merge_into`), ' +
  '`deepen` (real but should be corrected/enriched — give the improved fields), or ' +
  '`reject` (noise, trivial, or wrong). Prefer reusing existing keys so the same concept converges to one node. ' +
  'Respond by calling the `curate_decisions` tool exactly once, with one entry per prospect referenced by its `index`.'

/**
 * @param {{ text: string, model: string, maxTokens: number, maxCandidates: number }} args
 * @returns {CompletionRequest}
 */
export function buildProposeRequest({ text, model, maxTokens, maxCandidates }) {
  return {
    model,
    system: `${T1_SYSTEM} Emit at most ${maxCandidates} candidates.`,
    messages: [{ role: 'user', content: text }],
    max_tokens: maxTokens,
    tools: [EMIT_PROSPECTS_TOOL],
    // Provider-neutral forced tool: each provider translates `toolChoice` to
    // its native shape, so the proposer is portable across Anthropic and
    // OpenAI-compatible providers (Ollama, LM Studio, …).
    toolChoice: { name: 'emit_prospects' },
  }
}

/**
 * Build ONE curate request for a batch of prospects that share an anchor
 * (session). The graph neighborhood and source excerpt are read once and
 * shared across the batch, so the same session source isn't re-sent per
 * prospect — the win over a per-prospect call. The model returns one
 * decision per prospect, keyed by 1-based index.
 *
 * The request is provider-aware: on Anthropic, adaptive thinking + high
 * effort buy curation quality but forbid forcing a tool (the API returns 400
 * for `tool_choice:{type:'tool'}` with thinking on), so the tool choice stays
 * `auto` and the system prompt requires one `curate_decisions` call. On other
 * providers (OpenAI-compatible) there is no such restriction and no portable
 * thinking knob, so the tool is forced for reliable structured output.
 * `parseDecisions` treats a missing call as "no decisions" either way.
 *
 * @param {{ prospects: Array<{ type: string, label: string, summary?: string, confidence?: number, recall?: string }>, neighborhood: string, source: string, model: string, maxTokens: number, provider: string }} args
 * @returns {CompletionRequest}
 */
export function buildCurateBatchRequest({ prospects, neighborhood, source, model, maxTokens, provider }) {
  const lines = prospects
    .map((p, i) =>
      `[${i + 1}] type: ${p.type} | label: ${p.label} | confidence: ${p.confidence ?? ''}\n` +
      `    summary: ${p.summary ?? ''}\n` +
      `    similar existing items: ${p.recall || '(none)'}`
    )
    .join('\n\n')
  const user =
    `SHARED GRAPH NEIGHBORHOOD (around the session anchor)\n${neighborhood || '(none)'}\n\n` +
    `SHARED SOURCE EXCERPT\n${source || '(unavailable)'}\n\n` +
    `PROSPECTS — decide on each by index:\n${lines}\n`
  /** @type {CompletionRequest} */
  const req = {
    model,
    system: T2_SYSTEM,
    messages: [{ role: 'user', content: user }],
    max_tokens: maxTokens,
    tools: [CURATE_DECISIONS_TOOL],
  }
  if (provider === 'anthropic') {
    req.params = { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
  } else {
    req.toolChoice = { name: 'curate_decisions' }
  }
  return req
}

/**
 * Pull the first `tool_use` block's input from a completion result, or null
 * if the model refused / returned no tool call.
 *
 * @param {CompletionResult} result
 * @param {string} toolName
 * @returns {Record<string, unknown> | null}
 */
export function toolInput(result, toolName) {
  if (result.stopReason === 'refusal') return null
  if (!Array.isArray(result.message.content)) return null
  for (const block of result.message.content) {
    if (block.type === 'tool_use' && block.name === toolName && block.input) {
      return /** @type {Record<string, unknown>} */ (block.input)
    }
  }
  return null
}

/**
 * @param {CompletionResult} result
 * @returns {Array<{ type: string, label: string, summary?: string, confidence?: number, evidence?: string }>}
 */
export function parseProspects(result) {
  const input = toolInput(result, 'emit_prospects')
  const list = input && Array.isArray(input.prospects) ? input.prospects : []
  /** @type {Array<{ type: string, label: string, summary?: string, confidence?: number, evidence?: string }>} */
  const out = []
  for (const raw of list) {
    const p = /** @type {Record<string, unknown>} */ (raw ?? {})
    const type = typeof p.type === 'string' ? p.type : ''
    const label = typeof p.label === 'string' ? p.label : ''
    if (!type || !label || !PROSPECT_TYPES.includes(type)) continue
    out.push({
      type,
      label,
      summary: typeof p.summary === 'string' ? p.summary : undefined,
      confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
      evidence: typeof p.evidence === 'string' ? p.evidence : undefined,
    })
  }
  return out
}

/**
 * Parse the batched `curate_decisions` tool call into per-prospect decisions
 * (keyed by 1-based `index`). Invalid/unknown-decision entries are dropped;
 * an empty array means the model refused or returned no tool call.
 *
 * @param {CompletionResult} result
 * @returns {CurateDecision[]}
 */
export function parseDecisions(result) {
  const input = toolInput(result, 'curate_decisions')
  const list = input && Array.isArray(input.decisions) ? input.decisions : []
  /** @type {CurateDecision[]} */
  const out = []
  for (const raw of list) {
    const d = /** @type {Record<string, unknown>} */ (raw ?? {})
    const index = typeof d.index === 'number' ? d.index : NaN
    const decision = typeof d.decision === 'string' ? d.decision : ''
    if (!Number.isInteger(index) || index < 1) continue
    if (!['commit', 'merge', 'deepen', 'reject'].includes(decision)) continue
    out.push({
      index,
      decision,
      item_type: typeof d.item_type === 'string' ? d.item_type : undefined,
      item_key: typeof d.item_key === 'string' ? d.item_key : undefined,
      label: typeof d.label === 'string' ? d.label : undefined,
      summary: typeof d.summary === 'string' ? d.summary : undefined,
      confidence: typeof d.confidence === 'number' ? d.confidence : undefined,
      merge_into: typeof d.merge_into === 'string' ? d.merge_into : undefined,
      note: typeof d.note === 'string' ? d.note : undefined,
    })
  }
  return out
}
