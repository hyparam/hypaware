// @ts-check
/**
 * The recommendation tool contracts the client shares with hypaware-server.
 *
 * Each entry names an MCP tool, its title, its description, its input
 * schema (hypaware-server LLP 0596#tools-shapes), its auth class and the
 * CLI command that does the same thing. The server loads this module
 * through its `internal('mcp/...')` shim, binds `operation` and `render`
 * to each entry by `tool` name, and registers the result as a verb. The
 * prompts, the instructions and the reference generator read the same
 * entries, so the name, summary and CLI equivalent have one home.
 *
 * Nothing here registers a tool. A host lists a tool only when a verb is
 * registered for it (LLP 0034#tool-exposure-emergent), so importing this
 * module changes no `tools/list` anywhere.
 */

import { RECOMMENDATION_STATES } from '../cli/command_args.js'

/**
 * @import { RemoteToolContract } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Freeze a plain object or array and everything it holds, so a reader that
 * binds a contract (the server, a test) cannot change it for the next one.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

/**
 * The read contracts. The write contract (`set_recommendation_status`,
 * scope `report-publish`) joins with the `write` auth class.
 *
 * @ref LLP 0494#remote-contracts [implements]: shape only, no operation; the server binds by name
 * @type {readonly RemoteToolContract[]}
 */
export const REMOTE_TOOL_CONTRACTS = freezeDeep(/** @type {RemoteToolContract[]} */ ([
  {
    tool: 'list_recommendations',
    title: 'List recommendations',
    summary: 'List the recommendations in your org\'s published reports, summary fields only (no evidence or history). '
      + '`status` defaults to open. `counts` counts the rows this call read, by state: it is not an org total. '
      + 'Pass the returned `next_before` as `before` for the next page. Read one in full with get_recommendation.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          description: 'States to include (default: open).',
          items: { type: 'string', enum: [...RECOMMENDATION_STATES] },
          default: ['open'],
        },
        kind: { type: 'string', description: 'Only recommendations from reports of this kind.' },
        period: { type: 'string', description: 'Only recommendations from reports for this period.' },
        limit: { type: 'integer', description: 'Most rows to return (1 to 100).', minimum: 1, maximum: 100, default: 20 },
        before: { type: 'string', description: 'Page cursor: the `next_before` a previous call returned.' },
      },
    },
    authClass: 'read',
    cli: 'hyp report list --recommendations',
  },
  {
    tool: 'get_recommendation',
    title: 'Read a recommendation',
    summary: 'Read one recommendation: its summary, status, status history and report. '
      + 'Set `include_evidence` for its evidence locators, basis queries, history reasons and links, and its page (capped at 64 KiB). '
      + 'Reading a cited turn is a separate session_evidence or query_sql call.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The recommendation id (hyprec- and 16 hex characters).' },
        include_evidence: { type: 'boolean', description: 'Add evidence, basis, history reasons and links, and the page.', default: false },
      },
      required: ['id'],
    },
    authClass: 'read',
    cli: 'hyp report get <rec-id>',
  },
]))
