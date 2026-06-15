// @ts-check

/**
 * Model I/O for the two tiers. Both use a forced tool so the model returns
 * schema-shaped structured output (a `tool_use` block) rather than prose —
 * the structured-extraction channel of `hypaware.completion`.
 *
 * @import { CompletionRequest, CompletionResult } from '../../../../collectivus-plugin-kernel-types.d.ts'
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

const CURATE_DECISION_TOOL = {
  name: 'curate_decision',
  description: 'Decide what to do with a single prospect, given the existing graph neighborhood and source.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      decision: { type: 'string', enum: ['commit', 'merge', 'deepen', 'reject'] },
      item_type: { type: 'string', description: 'Final node type (for commit/deepen).' },
      item_key: { type: 'string', description: 'Final canonical key for the item (for commit/deepen). Reuse an existing key to converge.' },
      label: { type: 'string', description: 'Final human-readable label.' },
      summary: { type: 'string', description: 'Final one-sentence statement of the item.' },
      confidence: { type: 'number', description: '0..1 — final confidence after curation.' },
      merge_into: { type: 'string', description: 'Existing item key to merge into (for merge).' },
      note: { type: 'string', description: 'Short rationale.' },
    },
    required: ['decision'],
  },
}

const T2_SYSTEM =
  'You are a graph librarian curating proposed knowledge for a context graph. ' +
  'Given ONE prospect, the existing graph neighborhood, similar existing items, and the source excerpt, choose exactly one action: ' +
  '`commit` (it is real and new — give a final type, canonical key, label, summary, confidence), ' +
  '`merge` (it duplicates an existing item — give `merge_into`), ' +
  '`deepen` (real but should be corrected/enriched — give the improved fields), or ' +
  '`reject` (noise, trivial, or wrong). Prefer reusing existing keys so the same concept converges to one node. ' +
  'Respond by calling the `curate_decision` tool exactly once; do not answer in prose.'

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
    params: { tool_choice: { type: 'tool', name: 'emit_prospects' } },
  }
}

/**
 * @param {{ prospect: { type: string, label: string, summary?: string, confidence?: number }, recall: string, neighborhood: string, source: string, model: string, maxTokens: number }} args
 * @returns {CompletionRequest}
 */
export function buildCurateRequest({ prospect, recall, neighborhood, source, model, maxTokens }) {
  const user =
    `PROSPECT\n` +
    `type: ${prospect.type}\nlabel: ${prospect.label}\nsummary: ${prospect.summary ?? ''}\nconfidence: ${prospect.confidence ?? ''}\n\n` +
    `SIMILAR EXISTING ITEMS (recall)\n${recall || '(none)'}\n\n` +
    `GRAPH NEIGHBORHOOD (around the anchor)\n${neighborhood || '(none)'}\n\n` +
    `SOURCE EXCERPT\n${source || '(unavailable)'}\n`
  return {
    model,
    system: T2_SYSTEM,
    messages: [{ role: 'user', content: user }],
    max_tokens: maxTokens,
    tools: [CURATE_DECISION_TOOL],
    params: {
      // Adaptive thinking forbids forcing a tool (Anthropic returns 400 for
      // tool_choice:{type:'tool'} with thinking on), so we leave tool_choice
      // at the default `auto` and instruct the model to call curate_decision
      // exactly once. parseDecision treats a missing call as "no decision".
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    },
  }
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
 * @param {CompletionResult} result
 * @returns {{ decision: string, item_type?: string, item_key?: string, label?: string, summary?: string, confidence?: number, merge_into?: string, note?: string } | null}
 */
export function parseDecision(result) {
  const input = toolInput(result, 'curate_decision')
  if (!input) return null
  const decision = typeof input.decision === 'string' ? input.decision : ''
  if (!['commit', 'merge', 'deepen', 'reject'].includes(decision)) return null
  return {
    decision,
    item_type: typeof input.item_type === 'string' ? input.item_type : undefined,
    item_key: typeof input.item_key === 'string' ? input.item_key : undefined,
    label: typeof input.label === 'string' ? input.label : undefined,
    summary: typeof input.summary === 'string' ? input.summary : undefined,
    confidence: typeof input.confidence === 'number' ? input.confidence : undefined,
    merge_into: typeof input.merge_into === 'string' ? input.merge_into : undefined,
    note: typeof input.note === 'string' ? input.note : undefined,
  }
}
