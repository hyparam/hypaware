const day = 86_400_000
export const quote = value => "'" + value.replaceAll("'", "''") + "'"
const isoDay = time => new Date(time).toISOString().slice(0, 10)
const maxSessions = 4
const windowRows = 80
const maxReplies = 3

// Search title terms literally. A compound such as "auto-update" can appear with a space.
function topicFilter(title) {
  const terms = (title.replace(/\([^()]*\)/g, ' ').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [])
    .filter(term => term.length >= 3 && /[a-z]/.test(term) && !['llp', 'the', 'for', 'and', 'with', 'add', 'fix', 'support', 'implement', 'update'].includes(term))
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
  add(turns.slice(1).find(t => t.role === 'user' && t.topic_hint), 'Related developer message')
  let replies = 0
  for (const [i, turn] of turns.entries()) {
    if (i === 0 || turn.role !== 'user' || !turn.choice_hint) continue
    const preceding = turns.slice(Math.max(0, i - 8), i).filter(t => t.role === 'assistant')
    add(preceding.findLast(t => t.proposal_hint) ?? preceding.at(-1), 'Earlier agent message')
    add(turn, 'Possible developer choice')
    add(turns.slice(i + 1, i + 5).find(t => t.role === 'assistant'), 'Agent follow-up')
    if (++replies === maxReplies) break
  }
  return turns.filter(turn => selected.has(turn.message_id)).map(turn => selected.get(turn.message_id))
}

export const rootText = `(is_sidechain is null or is_sidechain = false) and agent_id is null
  and (conversation_id is null or conversation_id = session_id)`

// Older recordings lack origin labels. Drop known injected text before it can
// be attributed to a developer, including tool echoes recorded with the user role.
const claudeOrigin = "json_extract_string(attributes, '$.claude.origin.kind')"
const codexKinds = "json_extract_string(attributes, '$.codex.content_item_kinds')"
const injected = ['<', '[', '{', '# agents.md', '# /loop', 'retained source order', 'base directory for this skill',
  'this session is being continued', 'message type:', 'tool loaded.', 'another claude session sent']
export const developerText = `(${claudeOrigin} = 'human' or ${codexKinds} like '%"user.text"%'
  or (${claudeOrigin} is null and ${codexKinds} is null and coalesce(user_type, 'user') in ('user','external')
  and coalesce(entrypoint, '') <> 'sdk-cli' and ${injected.map(prefix => 'lower(trim(content_text)) not like ' + quote(prefix + '%')).join(' and ')}))`

export function repoFilter(repo) {
  const remoteNames = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']
    .flatMap(prefix => ['', '.git'].map(suffix => quote(prefix + repo.toLowerCase() + suffix)))
  return `lower(git_remote) in (${remoteNames.join(', ')})`
}

// A Codex-created chat receives the assignment as a tool result. Only cite the
// original human command after both sides of that specific handoff agree.
async function handoffRequest(scope, child, ticket, query) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  const validId = new RegExp('^' + uuid + '$')
  if (!validId.test(child)) return
  const envelope = '^<codex_delegation>\r?\n *<source_thread_id>(' + uuid + ')</source_thread_id>'
  const links = await query(`select distinct regexp_extract(content_text, ${quote(envelope)}, 1) as parent,
    message_created_at as delivered_at from ai_gateway_messages where ${scope} and ${rootText}
    and session_id = ${quote(child)} and json_extract_string(attributes, '$.codex.thread_source') = 'agent_created_thread'
    and role = 'tool' and part_type = 'tool_result' and provider_type = 'function_call_output'
    and tool_name is null and tool_result_for = message_id and message_id like 'fco%'
    and regexp_like(content_text, ${quote(envelope)}) limit 2`)
  if (links.length !== 1) return
  const { parent, delivered_at } = links[0]
  if (!validId.test(parent) || parent === child) return
  const delivered = Date.parse(delivered_at)
  const before = ms => quote(new Date(delivered - ms).toISOString())
  const source = `${scope} and ${rootText} and session_id = ${quote(parent)}`
  const nearDelivery = `${source} and message_created_at between ${before(120_000)} and ${before(0)}`
  const receipts = await query(`select distinct tool_result_for from ai_gateway_messages where ${nearDelivery}
    and role = 'tool' and part_type = 'tool_result' and tool_result_for is not null and coalesce(is_error, false) = false
    and replace(content_text, chr(92), '') like ${quote('%"threadId":"' + child + '"%')} limit 2`)
  if (receipts.length !== 1) return
  const calls = await query(`select distinct tool_call_id from ai_gateway_messages where ${nearDelivery}
    and role = 'assistant' and part_type = 'tool_call' and tool_call_id = ${quote(receipts[0].tool_result_for)}
    and (tool_name = 'create_thread' or (tool_name = 'exec' and tool_args like '%mcp__codex_app__create_thread(%')) limit 1`)
  if (!calls.length) return
  // Inspect only the immediately preceding human message. An older matching
  // command could have started another task in the same source chat.
  const [last] = await query(`select distinct date, session_id, message_id, message_created_at, role,
    case when regexp_like(lower(trim(content_text)), '^/handoff[ \t]')
      and regexp_like(lower(content_text), ${quote('(^|[^a-z0-9-])' + ticket + '([^a-z0-9-]|$)')})
      and length(content_text) between 1 and 3000 then 1 else 0 end as is_request
    from ai_gateway_messages where ${source} and message_created_at between ${before(600_000)} and ${before(0)}
    and role = 'user' and part_type = 'text' and message_id is not null
    and ${codexKinds} = '["user.text"]' order by message_created_at desc, message_id desc limit 1`)
  if (last?.is_request) return { turn: last, label: 'Developer handoff request' }
}

export async function discover(pr, repo, query, now = Date.now()) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || pr.isCrossRepository || !pr.headRefName) throw new Error('Expected a same-repository PR and branch')
  const opened = Date.parse(pr.createdAt)
  const end = Math.min(pr.closedAt ? Date.parse(pr.closedAt) : now, opened + 2 * day)
  const from = isoDay(opened - 2 * day)
  const to = isoDay(end)
  const scope = `date between '${from}' and '${to}' and message_created_at <= ${quote(new Date(end).toISOString())}
    and ${repoFilter(repo)}`
  let sessions = await query(`select distinct session_id from ai_gateway_messages
    where ${scope} and git_branch = ${quote(pr.headRefName)} and session_id is not null
    order by session_id limit ${maxSessions + 1}`)
  // A separate worktree can push the PR branch while the recorder still sees master.
  // Accept only a single root shell session that pushed this exact ref just before opening.
  if (!sessions.length && /^[a-zA-Z0-9_./-]{1,255}$/.test(pr.headRefName)) {
    const literal = pr.headRefName.replaceAll('.', '[.]')
    const push = `(^|["';&|])[ ]*git push (-u |--set-upstream )?origin (HEAD:refs/heads/)?${literal}($|[ "';&|])`
    const pushes = await query(`select distinct session_id from ai_gateway_messages where ${scope} and ${rootText}
      and message_created_at between ${quote(new Date(opened - 3_600_000).toISOString())} and ${quote(pr.createdAt)}
      and part_type = 'tool_call' and tool_name in ('Bash', 'exec', 'exec_command') and session_id is not null
      and regexp_like(tool_args, ${quote(push)}) limit 2`)
    if (pushes.length === 1) sessions = pushes
  }
  /** @type {Array<{ candidates: ReturnType<typeof selectCandidates>, count: number, capped: boolean }>} */
  const previews = []
  const topic = topicFilter(pr.title)
  const tickets = [...new Set(pr.title.toLowerCase().match(/\b[a-z][a-z0-9]{1,9}-[1-9][0-9]*\b/g))]
  for (const { session_id } of sessions.slice(0, maxSessions)) {
    // The design request can predate the feature branch. Keep the repository and
    // session filters for the drill-down. Only root text has a root-session link.
    const root = `${scope} and session_id = ${quote(session_id)} and part_type = 'text'
      and ${rootText}`
    const [seed] = await query(`select message_id, message_created_at from ai_gateway_messages
      where ${root} and role = 'user' and ${developerText} and message_id is not null and length(content_text) between 1 and 3000 and (${topic})
      order by message_created_at, message_id limit 1`)
    if (!seed) {
      const command = tickets.length === 1 ? await handoffRequest(scope, session_id, tickets[0], query) : undefined
      previews.push({ candidates: command ? [command] : [], count: command ? 1 : 0, capped: false })
      continue
    }
    const rows = await query(`select distinct date, session_id, message_id, message_created_at, role,
      case when role = 'user' and (${topic}) then 1 else 0 end as topic_hint,
      case when role = 'user' and length(content_text) <= 200 and (${replyHint}) then 1 else 0 end as choice_hint,
      case when role = 'assistant' and (${proposalHint}) then 1 else 0 end as proposal_hint
      from ai_gateway_messages where ${root} and (role = 'assistant' or (role = 'user' and ${developerText})) and message_id is not null
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
