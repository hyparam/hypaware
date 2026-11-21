const day = 86_400_000
export const quote = value => "'" + value.replaceAll("'", "''") + "'"
const isoDay = time => new Date(time).toISOString().slice(0, 10)
const maxSessions = 4
const windowRows = 80
const maxReplies = 3
// Push commands read per session, and the longest tool call read for them. A
// session past either is not cited: its task boundaries could not all be read.
const maxPushes = 200
const maxPushArgs = 20_000
// A git push anywhere in a piece of a command: `git`, then its own options
// (`-C <dir>`, quoted or not, `-c <key=value>`, flags), then `push`. The
// alternatives cannot match the same text, so a long run of options stays
// linear: a quoted value only as quoted, `-c` and `-C` only with their value.
const gitOptions = String.raw`(?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|[^\s"']\S*)|-c\s+\S+|-(?![cC](?:\s|$))\S+))*`
// `git` starts a command, or a quoted one (`bash -c "git push ..."`, `eval`).
const gitPush = new RegExp(String.raw`(?:^|[\s"'])git${gitOptions}\s+push(?=[\s"']|$)`)
// The subcommand of a piece that starts with git, after any VAR= prefixes.
const gitSubcommand = new RegExp(String.raw`^git${gitOptions}\s+(\S+)`)
// What splits one command from the next: a line, `;`, `&&`, `||`, a pipe,
// `&`, a subshell, a backtick or `$(`.
const commandBreak = /\n|;|&&|\|\||\||&|\(|\)|`|\$\(/
// A branch name a push can name. `HEAD`, `$VAR` or a pattern is not one.
const branchName = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/

/**
 * The text a tool call ran: every string in its parsed arguments except a
 * description, or null when they do not parse.
 * @param {string} args
 */
function commandText(args) {
  let parsed
  try {
    parsed = JSON.parse(args)
  } catch {
    return null
  }
  /** @type {string[]} */
  const texts = []
  /** @param {unknown} value @param {string} key */
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (key !== 'description') texts.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, key)
    } else if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) walk(item, name)
    }
  }
  walk(parsed, '')
  return texts.join('\n')
}

/**
 * The branches one push command names on origin, or null when it names
 * another remote, none, or one that cannot be read. Flags anywhere, and the
 * destination of `<src>:<dst>` (`HEAD:<branch>`, `<sha>:refs/heads/<branch>`).
 * @param {string} rest what follows `push`
 */
function pushedTo(rest) {
  const words = []
  for (const raw of rest.trim().split(/\s+/)) {
    // A redirection ends the command's own words; the quote that closes a
    // `bash -c "..."` is not part of the last one.
    if (/[<>]/.test(raw)) break
    const word = raw.replace(/^["']+|["']+$/g, '')
    if (word && !word.startsWith('-')) words.push(word)
  }
  const [remote, ...refspecs] = words
  if (remote !== 'origin' || refspecs.length === 0) return null
  const branches = []
  for (const refspec of refspecs) {
    const branch = (refspec.replace(/^\+/, '').split(':').at(-1) ?? '').replace(/^refs\/heads\//, '')
    if (!branchName.test(branch) || branch === 'HEAD') return null
    branches.push(branch)
  }
  return branches
}

/**
 * The branches a session pushed, in time order, or null when any push in it
 * cannot be read: another remote, a bare push, `HEAD`, a `$VAR`, arguments
 * that do not parse, a call too long to read.
 * @param {Array<{ message_created_at: string, tool_args: string | null }>} calls
 */
function pushedBranches(calls) {
  const pushes = []
  for (const call of calls) {
    if (typeof call.tool_args !== 'string') return null
    const text = commandText(call.tool_args)
    if (text === null) return null
    const at = Date.parse(call.message_created_at)
    // A backslash at a line's end continues the command on the next line.
    for (const piece of text.replace(/\\\r?\n/g, ' ').split(commandBreak)) {
      // A push named inside another git command's words (a commit message,
      // a log search) is not a push.
      const own = gitSubcommand.exec(piece.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, ''))
      if (own && own[1] !== 'push') continue
      const found = gitPush.exec(piece)
      if (!found) continue
      const branches = pushedTo(piece.slice(found.index + found[0].length))
      if (!branches) return null
      for (const ref of branches) pushes.push({ at, ref })
    }
  }
  return pushes
}

// Search title terms literally. A compound such as "auto-update" can appear with a space.
function topicFilter(title) {
  const terms = (title.replace(/\([^()]*\)/g, ' ').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [])
    .filter(term => term.length >= 3 && /[a-z]/.test(term) && !['llp', 'the', 'for', 'and', 'with', 'add', 'fix', 'support', 'implement', 'update'].includes(term))
  const compound = terms.find(term => term.includes('-'))
  const variants = new Set(terms.slice(0, 2))
  if (compound) {
    variants.add(compound)
    variants.add(compound.replaceAll('-', ' '))
    variants.add(compound.replaceAll('-', ''))
  }
  // An explicit release skill invocation can be the entire human request.
  if (/^publish v[0-9]+\.[0-9]+\.[0-9]+$/i.test(title)) variants.add('[$prepare-release]')
  if (!variants.size) return '1 = 0'
  return [...variants].map(term => 'lower(content_text) like ' + quote('%' + term + '%')).join(' or ')
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
  let sessions = await query(`select session_id from ai_gateway_messages
    where ${scope} and git_branch = ${quote(pr.headRefName)} and session_id is not null
    group by session_id order by max(message_created_at) desc, session_id limit ${maxSessions + 1}`)
  // A separate worktree can push the PR branch while the recorder still sees master.
  // Accept one root session that pushed or created this exact ref shortly before opening.
  if (!sessions.length && /^[a-zA-Z0-9_./-]{1,255}$/.test(pr.headRefName)) {
    const literal = pr.headRefName.replaceAll('.', '[.]')
    const push = `(^|["';&|])[ ]*git push ((-q|--quiet|-u|--set-upstream) )*origin (HEAD:refs/heads/)?${literal}($|[ "';&|])`
    const creation = [`regexp_like(tool_args, ${quote(push)})`]
    if (/^[0-9a-f]{40}$/.test(pr.headSha ?? '')) {
      // Codex can create the ref through GitHub without a local push. Bind all
      // three literal parameters to GitHub's PR metadata, including the commit.
      const args = [['repository_full_name', repo.replaceAll('.', '[.]')], ['branch_name', literal], ['sha', pr.headSha]]
        .map(([key, value]) => `${key} *: *["']${value}["']`).join(' *, *')
      const create = 'tools[.]mcp__codex_apps__github_create_branch[(] *[{] *' + args + ' *[}] *[)]'
      creation.push(`(tool_name = 'exec' and regexp_like(tool_args, ${quote(create)}))`)
    }
    const pushes = await query(`select distinct session_id from ai_gateway_messages where ${scope} and ${rootText}
      and message_created_at between ${quote(new Date(opened - 3_600_000).toISOString())} and ${quote(pr.createdAt)}
      and part_type = 'tool_call' and tool_name in ('Bash', 'exec', 'exec_command') and session_id is not null
      and (${creation.join(' or ')}) limit 2`)
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
    // One session can carry several tasks, and an earlier one can share a title
    // word. Seed on the latest matching request made before the PR opened, and
    // only without one on the earliest made after it (#3051).
    const beforeOpen = `message_created_at <= ${quote(pr.createdAt)}`
    // A push of another branch marks where the session moved to other work, so
    // no seed comes from before the last one ahead of this PR's first push.
    // A push it cannot read could be the other task's, so it cites nothing.
    const calls = await query(`select distinct message_created_at,
      case when length(tool_args) <= ${maxPushArgs} then tool_args end as tool_args
      from ai_gateway_messages where ${scope} and ${rootText} and session_id = ${quote(session_id)} and part_type = 'tool_call'
      and tool_name in ('Bash', 'exec', 'exec_command') and tool_args like '%git%push%'
      order by message_created_at limit ${maxPushes + 1}`)
    const pushes = calls.length > maxPushes ? null : pushedBranches(calls)
    if (!pushes) {
      previews.push({ candidates: [], count: 0, capped: true })
      continue
    }
    const other = pushes.filter(push => push.ref !== pr.headRefName).map(push => push.at)
    const ownFirst = pushes.find(push => push.ref === pr.headRefName && push.at <= opened)
    const anchor = ownFirst ? ownFirst.at : opened
    const movedOn = other.filter(at => at < anchor).at(-1)
    const [seed] = await query(`select message_id, message_created_at from ai_gateway_messages
      where ${root} and role = 'user' and ${developerText} and message_id is not null and length(content_text) between 1 and 3000 and (${topic})
      ${movedOn === undefined ? '' : `and message_created_at > ${quote(new Date(movedOn).toISOString())}`}
      order by case when ${beforeOpen} then 0 else 1 end, case when ${beforeOpen} then message_created_at end desc,
      message_created_at, message_id limit 1`)
    if (!seed) {
      const command = tickets.length === 1 ? await handoffRequest(scope, session_id, tickets[0], query) : undefined
      previews.push({ candidates: command ? [command] : [], count: command ? 1 : 0, capped: false })
      continue
    }
    // The next task's request and its choices come before its push, so the
    // window ends at this PR's last push ahead of that push, or at the opening
    // if later. Without a push of its own seen, it ends at that push.
    const seeded = Date.parse(seed.message_created_at)
    const next = other.find(at => at > seeded)
    const own = pushes.filter(push => push.ref === pr.headRefName).map(push => push.at)
      .filter(at => at > seeded && (next === undefined || at < next)).at(-1)
    const until = next === undefined ? undefined : own === undefined ? next : Math.max(own, Math.min(opened, next))
    const rows = await query(`select distinct date, session_id, message_id, message_created_at, role,
      case when role = 'user' and (${topic}) then 1 else 0 end as topic_hint,
      case when role = 'user' and length(content_text) <= 200 and (${replyHint}) then 1 else 0 end as choice_hint,
      case when role = 'assistant' and (${proposalHint}) then 1 else 0 end as proposal_hint
      from ai_gateway_messages where ${root} and (role = 'assistant' or (role = 'user' and ${developerText})) and message_id is not null
      and length(content_text) between 1 and 3000 and message_created_at >= ${quote(seed.message_created_at)}
      ${until === undefined ? '' : `and message_created_at <= ${quote(new Date(until).toISOString())}`}
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
