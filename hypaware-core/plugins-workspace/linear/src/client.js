// @ts-check

import { linearAuthorization } from './auth.js'
import { linearGraphql, linearError } from './http.js'
import { linearIdentity, uuid } from './oauth.js'

/** @import { LinearClient, LinearConfig, LinearWork, LinearPage, RequestOptions } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

const ISSUE_FIELDS = 'id identifier createdAt updatedAt team { id key } state { id type } assignee { id } creator { id }'
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
const TEAMS_QUERY = `query HypAwareTeams($after: String) {
  organization { id }
  teams(first: 50, after: $after) { nodes { id key name } ${PAGE_INFO} }
}`
export const ISSUES_QUERY = `query HypAwareIssues($filter: IssueFilter!, $after: String) {
  organization { id }
  issues(first: 50, after: $after, orderBy: createdAt, includeArchived: true, filter: $filter) {
    nodes { ${ISSUE_FIELDS} } ${PAGE_INFO}
  }
}`
export const ATTACHMENTS_QUERY = `query HypAwareAttachments($filter: AttachmentFilter!, $after: String) {
  organization { id }
  attachments(first: 50, after: $after, orderBy: createdAt, includeArchived: true, filter: $filter) {
    nodes { id url createdAt updatedAt issue { ${ISSUE_FIELDS} } } ${PAGE_INFO}
  }
}`

/**
 * @param {{ config: LinearConfig, stateDir: string, env: NodeJS.ProcessEnv } & RequestOptions} opts
 * @param {string} workspace
 * @returns {Promise<Array<{ id: string, key: string, name: string }>>}
 */
// @ref LLP 0608#team-scope [implements]: discovery is bounded and team metadata stays out of capture
export async function listLinearTeams(opts, workspace) {
  const teams = new Map()
  const cursors = new Set()
  /** @type {string | null} */
  let after = null
  for (let page = 0; page < 20; page++) {
    const data = await linearGraphql(await linearAuthorization(opts.stateDir, opts.config, opts.env, opts), TEAMS_QUERY, { after }, opts)
    if (data.organization?.id !== workspace) throw linearError('workspace_changed', 'workspace changed during setup; retry')
    const { nodes, pageInfo } = data.teams ?? {}
    if (!Array.isArray(nodes) || nodes.length > 50 || typeof pageInfo?.hasNextPage !== 'boolean') {
      throw linearError('response', 'invalid team list')
    }
    for (const team of nodes) {
      if (!uuid(team?.id) || typeof team.key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(team.key) || typeof team.name !== 'string') {
        throw linearError('response', 'invalid team in API response')
      }
      teams.set(team.id.toLowerCase(), { id: team.id.toLowerCase(), key: team.key, name: team.name.slice(0, 120) })
    }
    if (!pageInfo.hasNextPage) return [...teams.values()]
    const next = pageInfo.endCursor
    if (typeof next !== 'string' || !next || next.length > 4096 || cursors.has(next)) {
      throw linearError('response', 'invalid team pagination cursor')
    }
    cursors.add(next)
    after = next
  }
  throw linearError('team_limit', 'team discovery exceeded 20 pages; re-run with --team <key>')
}

/** @param {unknown} value @returns {value is string} */
export function validTime(value) { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) }

/** @param {any} value */
function validIssue(value) {
  return uuid(value?.id) && typeof value.identifier === 'string' && /^[a-z0-9]+-\d+$/i.test(value.identifier) && value.identifier.length <= 100 &&
    uuid(value.team?.id) && typeof value.team?.key === 'string' && /^[a-z0-9]{1,64}$/i.test(value.team.key) &&
    uuid(value.state?.id) && typeof value.state?.type === 'string' && value.state.type.length <= 64 &&
    validTime(value.createdAt) && validTime(value.updatedAt) &&
    (value.assignee == null || uuid(value.assignee.id)) && (value.creator == null || uuid(value.creator.id))
}

/**
 * @param {{ config: LinearConfig, stateDir: string, env: NodeJS.ProcessEnv } & RequestOptions} opts
 * @returns {LinearClient}
 */
// @ref LLP 0592#scope [implements]: attachments are paged independently of issue updates; only structural parent fields are requested
export function createLinearClient(opts) {
  const authorization = () => linearAuthorization(opts.stateDir, opts.config, opts.env, opts)
  return {
    async identity() { return linearIdentity(await authorization(), opts) },
    async page(stream, work, workspace) {
      const dates = { ...(work.since ? { gte: work.since } : {}), lte: work.until }
      const filter = stream === 'issues'
        ? { updatedAt: dates, or: opts.config.teams.map(team => uuid(team) ? { team: { id: { eq: team } } } : { team: { key: { eqIgnoreCase: team } } }) }
        : { updatedAt: dates, or: [{ url: { startsWith: 'https://github.com/' } }, { url: { startsWith: 'https://www.github.com/' } }] }
      const data = await linearGraphql(await authorization(), stream === 'issues' ? ISSUES_QUERY : ATTACHMENTS_QUERY,
        { filter, after: work.after }, opts)
      if (data.organization?.id !== workspace) throw linearError('workspace_changed', 'workspace changed during capture; retry')
      const page = /** @type {LinearPage} */ (data[stream])
      if (!page || !Array.isArray(page.nodes) || page.nodes.length > 50 || typeof page.pageInfo?.hasNextPage !== 'boolean' ||
          (page.pageInfo.endCursor !== null && (typeof page.pageInfo.endCursor !== 'string' || page.pageInfo.endCursor.length > 4096)) ||
          (page.pageInfo.hasNextPage && (!page.pageInfo.endCursor || page.pageInfo.endCursor === work.after))) {
        throw linearError('response', 'invalid pagination response')
      }
      for (const row of page.nodes) {
        const valid = stream === 'issues' ? validIssue(row) :
          uuid(row.id) && validTime(row.createdAt) && validTime(row.updatedAt) &&
          'url' in row && typeof row.url === 'string' && row.url.length <= 4096 && validIssue(row.issue)
        if (!valid) throw linearError('response', 'invalid structural record in API response')
      }
      return page
    },
  }
}
