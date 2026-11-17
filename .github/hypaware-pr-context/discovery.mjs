const day = 86_400_000
export const quote = value => "'" + value.replaceAll("'", "''") + "'"
const isoDay = time => new Date(time).toISOString().slice(0, 10)
const maxSessions = 4
const windowRows = 80
const maxReplies = 3

// Search title terms literally. A compound such as "auto-update" can appear with a space.
function topicFilter(title) {
  const terms = (title.replace(/\([^()]*\)/g, ' ').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [])
    .filter(term => term.length >= 3 && !['the', 'for', 'and', 'with', 'add', 'fix', 'support', 'implement', 'update'].includes(term))
  const compound = terms.find(term => term.includes('-'))
  const variants = compound ? [compound, compound.replaceAll('-', ' '), compound.replaceAll('-', '')] : terms.slice(0, 2)
  if (!variants.length) return '1 = 0'
  return variants.map(term => 'lower(content_text) like ' + quote('%' + term + '%')).join(' or ')
}

function containsAny(terms) {
  return terms.map(term => 'lower(content_text) like ' + quote('%' + term + '%')).join(' or ')
}

const replyHint = containsAny(['option ', 'instead', 'prefer', 'simpler', 'go with', 'let\'s use'])
const proposalHint = containsAny(['option', 'alternative', 'tradeoff', 'trade-off', '(b)', 'b)', '**b.', '**b:'])

export function selectCandidates(rows) {
  const turns = []
  const byId = new Map()
  for (const row of rows) {
    const seen = byId.get(row.message_id)
    if (seen) {
      seen.choice_hint ||= row.choice_hint
      seen.proposal_hint ||= row.proposal_hint
    } else {
      const turn = { ...row }
      turns.push(turn)
      byId.set(turn.message_id, turn)
    }
  }
  const selected = new Map()
  function add(turn, label) {
    if (turn && !selected.has(turn.message_id)) selected.set(turn.message_id, { turn, label })
  }
  add(turns[0], 'Possible request')
  let replies = 0
  for (const [i, turn] of turns.entries()) {
    if (i === 0 || turn.role !== 'user' || !turn.choice_hint) continue
    const preceding = turns.slice(Math.max(0, i - 8), i).filter(t => t.role === 'assistant')
    add(preceding.findLast(t => t.proposal_hint) ?? preceding.at(-1), 'Earlier agent message')
    add(turn, 'Possible developer choice')
    add(turns.slice(i + 1, i + 5).find(t => t.role === 'assistant'), 'Agent follow-up')
    if (++replies === maxReplies) break
  }
  return Array.from(selected.values()).sort((a, b) => a.turn.message_created_at.localeCompare(b.turn.message_created_at))
}

export const rootText = `(is_sidechain is null or is_sidechain = false) and agent_id is null
  and (conversation_id is null or conversation_id = session_id)`

export function repoFilter(repo) {
  const remoteNames = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']
    .flatMap(prefix => ['', '.git'].map(suffix => quote(prefix + repo.toLowerCase() + suffix)))
  return `lower(git_remote) in (${remoteNames.join(', ')})`
}

export async function discover(pr, repo, query, now = Date.now()) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || pr.isCrossRepository || !pr.headRefName) throw new Error('Expected a same-repository PR and branch')
  const opened = Date.parse(pr.createdAt)
  const end = Math.min(pr.closedAt ? Date.parse(pr.closedAt) : now, opened + 2 * day)
  const from = isoDay(opened - 2 * day)
  const to = isoDay(end)
  const scope = `date between '${from}' and '${to}' and message_created_at <= ${quote(new Date(end).toISOString())}
    and ${repoFilter(repo)}`
  const sessions = await query(`select distinct session_id from ai_gateway_messages
    where ${scope} and git_branch = ${quote(pr.headRefName)} and session_id is not null
    order by session_id limit ${maxSessions + 1}`)
  /** @type {Array<{ candidates: ReturnType<typeof selectCandidates>, count: number, capped: boolean }>} */
  const previews = []
  const topic = topicFilter(pr.title)
  for (const { session_id } of sessions.slice(0, maxSessions)) {
    // The design request can predate the feature branch. Keep the repository and
    // session filters for the drill-down. Only root text has a root-session link.
    const root = `${scope} and session_id = ${quote(session_id)} and part_type = 'text'
      and ${rootText}`
    const [seed] = await query(`select message_id, message_created_at from ai_gateway_messages
      where ${root} and role = 'user' and message_id is not null and length(content_text) between 1 and 3000 and (${topic})
      order by message_created_at, message_id limit 1`)
    if (!seed) {
      previews.push({ candidates: [], count: 0, capped: false })
      continue
    }
    const rows = await query(`select distinct date, session_id, message_id, message_created_at, role,
      case when role = 'user' and length(content_text) <= 200 and (${replyHint}) then 1 else 0 end as choice_hint,
      case when role = 'assistant' and (${proposalHint}) then 1 else 0 end as proposal_hint
      from ai_gateway_messages where ${root} and role in ('user','assistant') and message_id is not null
      and length(content_text) between 1 and 3000 and message_created_at >= ${quote(seed.message_created_at)}
      order by message_created_at, message_id limit ${windowRows + 1}`)
    const window = rows.slice(0, windowRows)
    const index = window.findIndex(row => row.message_id === seed.message_id)
    if (index < 0) throw new Error('Seed missing from bounded message window')
    const turns = window.slice(index)
    previews.push({ candidates: selectCandidates(turns), count: new Set(turns.map(row => row.message_id)).size, capped: rows.length > windowRows })
  }
  return { from, to, overflow: sessions.length > maxSessions, sessions: previews }
}

export function messageLink(turn) {
  const path = encodeURIComponent(turn.session_id).replaceAll('(', '%28').replaceAll(')', '%29')
  const url = new URL('https://app.hypaware.ai/sessions/' + path)
  url.searchParams.set('m', turn.message_id)
  url.searchParams.set('d', turn.date)
  return url.href
}

export function renderPreview(prNumber, result) {
  const lines = [`## Conversation sources for PR #${prNumber}`, '',
    `Search window: ${result.from} through ${result.to} UTC. Branch-matched sessions checked: ${result.sessions.length}.`]
  if (result.overflow) lines.push(`More than ${maxSessions} sessions matched. Only the first ${maxSessions} were checked.`)
  for (const [i, session] of result.sessions.entries()) {
    lines.push('', `### Session ${i + 1}`, '')
    if (!session.count) {
      lines.push('No matching request in this session.')
      continue
    }
    lines.push(`${session.count} distinct messages considered${session.capped ? ' (row limit reached)' : ''}. Inspect each exchange before citing it.`, '')
    for (const { turn, label } of session.candidates) {
      lines.push(`- [${label}](${messageLink(turn)})`)
    }
  }
  if (!result.sessions.length) lines.push('', 'No sessions matched this repository, branch, and window.')
  return lines.join('\n') + '\n'
}
