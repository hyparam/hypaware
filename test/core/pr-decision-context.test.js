import assert from 'node:assert/strict'
import test from 'node:test'
import { collect, executeSql } from 'squirreling'
import { discover, renderPreview, selectCandidates } from '../../.github/hypaware-pr-context/discovery.mjs'

import { describe, generate, readMessages, renderDraft, updateBody, codeChanges, changeScope } from '../../.github/hypaware-pr-context/describe.mjs'

const pr = { title: 'Widget sync', headRefName: 'work/widget', isCrossRepository: false, createdAt: '2026-08-25T05:00:00Z', closedAt: '2026-08-25T22:00:00Z' }
function turn(id, role, minute, hints = {}) {
  return { session_id: 'session', message_id: id, role, message_created_at: `2026-08-25T10:${String(minute).padStart(2, '0')}:00Z`,
    date: '2026-08-25', choice_hint: 0, proposal_hint: 0, ...hints }
}

test('pairs a short choice with an earlier options message across an intervening turn', () => {
  const request = turn('request', 'user', 0)
  const options = turn('options', 'assistant', 1, { proposal_hint: 1 })
  const filler = turn('filler', 'assistant', 2)
  const choice = turn('choice', 'user', 3, { choice_hint: 1 })
  const follow = turn('follow', 'assistant', 4)
  const selected = selectCandidates([request, options, filler, choice, { ...choice }, follow])
  assert.deepEqual(selected.map(c => c.turn.message_id), ['request', 'options', 'choice', 'follow'])
})

test('rejects fork branches before querying organization data', async () => {
  await assert.rejects(discover({ ...pr, isCrossRepository: true }, 'org/repo', assert.fail), /same-repository/)
})

test('scope includes pre-branch request and renders capped searches and empty sessions explicitly', async () => {
  const seed = turn('start', 'user', 0)
  const window = [seed, ...Array.from({ length: 80 }, (_, i) => turn('other-' + i, 'assistant', 1))]
  const responses = [[{ session_id: 'x' }, { session_id: 'y' }], [], [], [], [seed], window]
  const queries = []
  const result = await discover({ ...pr, headRefName: "dev/o'brien" }, 'org/repo', async sql => {
    queries.push(sql)
    return responses.shift()
  })
  assert.equal(queries.length, 6)
  assert.match(queries[0], /git_branch = 'dev\/o''brien'/)
  for (const sql of queries) {
    assert.match(sql, /date between '2026-08-23' and '2026-08-25'/)
    assert.match(sql, /lower\(git_remote\) in/)
  }
  assert.doesNotMatch(queries[1], /git_branch/)
  const preview = renderPreview(123, result)
  assert.match(preview, /No matching request/)
  assert.match(preview, /row limit reached/)
  assert.match(preview, /sessions\/session\?m=start&d=2026-08-25/)
})

test('only validated link structure and static labels reach the summary', () => {
  const message = turn('id) raw text &', 'user', 0, { session_id: 'a)b', content_text: 'private excerpt' })
  const preview = renderPreview(10, { from: message.date, to: message.date, sessions: [{ count: 1, candidates: selectCandidates([message]) }] })
  assert.match(preview, /a%29b\?m=id%29\+raw\+text\+%26/)
  assert.doesNotMatch(preview, /private excerpt/)
})

const apiPR = {
  title: 'Widget sync', head: { sha: 'head', repo: { full_name: 'contributor/project' }, ref: 'widget' },
  base: { sha: 'base', repo: { full_name: 'team/project' } }, body: 'Author text\r\n',
  state: 'open', created_at: new Date().toISOString(), changed_files: 1,
}
const patchFile = { filename: 'widget.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }

test('updates a fork PR using its own sources and the latest author text, once per distinct result', async () => {
  const request = turn('request', 'user', 0)
  const options = turn('options', 'assistant', 1, { proposal_hint: 1 })
  const reply = turn('reply', 'user', 2, { choice_hint: 1 })
  const turns = [request, options, reply]
  let body = apiPR.body
  let reads = 0
  let writes = 0
  const github = async (path, method, payload) => {
    if (method === 'PATCH') {
      body = payload.body
      writes++
      return { body }
    }
    if (path) return [patchFile]
    if (++reads === 2) body += 'Edited while the model ran.\n'
    return { ...apiPR, body }
  }
  const query = async sql => {
    assert.match(sql, /contributor\/project/)
    assert.doesNotMatch(sql, /team\/project/)
    if (sql.includes('git_branch =')) return [{ session_id: 'session' }]
    if (sql.includes('length(tool_args)')) return []
    if (sql.includes('select message_id, message_created_at')) return [request]
    if (sql.includes('choice_hint')) return turns
    return turns.map(t => ({ ...t, part_index: 0, chars: t.message_id.length, text_part: t.message_id }))
  }
  const draft = async (title, messages, patches) => {
    assert.deepEqual(messages.map(m => m.text), ['request', 'options', 'reply'])
    assert.equal(title, apiPR.title)
    assert.equal(patches[0].patch, patchFile.patch)
    return { why: { text: 'Keep widgets in sync.', sources: ['M1'] }, decisions: [
      { label: 'Reuse the timer', text: 'The developer chose the existing timer.', sources: ['M2', 'M3'] },
    ] }
  }
  await describe(apiPR, { github, query, draft })
  await describe(apiPR, { github, query, draft })
  assert.equal(writes, 1)
  assert.match(body, /Agent message 2.*Developer message 3/)
  assert.equal(updateBody(body, ''), 'Author text\r\nEdited while the model ran.\n')
})

test('leaves a new PR untouched without evidence, removes stale generated context, ignores stale revisions', async () => {
  let body = apiPR.body
  let writes = 0
  const github = async (path, method, payload) => {
    assert.equal(path, '')
    if (method === 'PATCH') {
      body = payload.body
      writes++
    }
    return { ...apiPR, body }
  }
  const deps = { github, query: async () => [], draft: assert.fail }
  await describe(apiPR, deps)
  assert.equal(writes, 0)
  body = updateBody(body, 'stale')
  await describe(apiPR, deps)
  assert.equal(writes, 1)
  assert.equal(body, apiPR.body)
  await describe({ ...apiPR, head: { ...apiPR.head, sha: 'old' } }, { ...deps, query: assert.fail })
  assert.equal(writes, 1)
})

test('stops on incomplete patches, conversation parts, unknown citations, and ambiguous body markers', async () => {
  assert.throws(() => codeChanges([{ ...patchFile, additions: 2 }], 1), /incomplete patch/)
  const edited = updateBody('Author text', 'draft').replaceAll('\n', '\r\n')
  assert.equal(updateBody(edited, ''), 'Author text')
  assert.throws(() => updateBody('author\n<!-- hypaware-pr-context:start -->', 'new'), /misplaced/)
  assert.throws(() => renderDraft({ why: { text: 'Widget context', sources: ['M9'] }, decisions: [] }, []), /citation/)
  const request = turn('request', 'user', 0)
  const session = { candidates: [{ turn: request }] }
  await assert.rejects(readMessages({ sessions: [session] }, 'team/project', async () =>
    [{ ...request, part_index: 0, text_part: 'short', chars: 99 }]), /incomplete/)
})

test('recovers a detached worktree only from one exact branch push just before opening', async () => {
  const queries = []
  const request = turn('request', 'user', 0)
  const clarification = turn('clarification', 'user', 1, { topic_hint: 1 })
  const replies = [[], [{ session_id: 'pusher' }], [], [request], [request, clarification]]
  const result = await discover({ ...pr, headRefName: 'fix/v1.2' }, 'org/repo', async sql => {
    queries.push(sql)
    return replies.shift()
  })
  assert.match(queries[1], /2026-08-25T04:00:00.000Z/)
  assert.match(queries[1], /tool_name in/)
  assert.match(queries[1], /fix\/v1\[\.\]2/)
  assert.match(queries[1], /limit 2/)
  assert.match(queries[3], /claude\.origin\.kind/)
  assert.match(queries[3], /lower\(trim\(content_text\)\) not like '\{%'/)
  assert.deepEqual(result.sessions[0].candidates.map(c => c.turn.message_id), ['request', 'clarification'])

  const ambiguous = [[], [{ session_id: 'one' }, { session_id: 'two' }]]
  const missed = await discover(pr, 'org/repo', async () => ambiguous.shift())
  assert.equal(missed.sessions.length, 0)
})

test('a numbered design title searches the subject words', async () => {
  const queries = []
  const replies = [[{ session_id: 'session' }], [], []]
  await discover({ ...pr, title: 'LLP 1000-1001: widget sync' }, 'org/repo', async sql => {
    queries.push(sql)
    return replies.shift()
  })
  assert.match(queries[2], /like '%widget%'/)
  assert.doesNotMatch(queries[2], /like '%1000-1001%'/)
})


test('states the actual scope of test and design-only changes, including both sides of renames', () => {
  const docs = { filename: 'llp/0090-projection.md' }
  const tests = { filename: 'test/core/legacy-grep.test.js' }
  const mixed = { filename: 'lib/grep.js' }
  assert.equal(changeScope([docs]), 'This PR changes documentation only.')
  assert.equal(changeScope([tests]), 'This PR changes tests only.')
  assert.equal(changeScope([docs, tests]), 'This PR changes only tests and documentation.')
  assert.equal(changeScope([tests, mixed]), '')
  assert.equal(changeScope([{ ...docs, previous_filename: mixed.filename }]), '')
  const rendered = renderDraft({ why: { text: 'The developer wanted old caches to stay searchable.', sources: ['M1'] }, decisions: [] },
    [{ id: 'M1', role: 'user', link: 'https://app.hypaware.ai/sessions/one?m=one' }], changeScope([tests]))
  assert.match(rendered, /Why this PR exists\.\*\* This PR changes tests only\. The developer wanted/)
  const repeated = renderDraft({ why: { text: 'Old caches needed coverage. This PR changes tests only.', sources: ['M1'] }, decisions: [] },
    [{ id: 'M1', role: 'user', link: 'https://app.hypaware.ai/sessions/one?m=one' }], changeScope([tests]))
  assert.equal(repeated.split(changeScope([tests])).length, 2)
  assert.equal(renderDraft({ why: null, decisions: [] }, [], changeScope([docs])), '')
})

test('an automatic run retries empty discovery and cites the source chat of a delegated docs PR', async () => {
  const parent = '10000000-0000-7000-9000-000000000001'
  const child = '10000000-0000-7000-9000-000000000002'
  const created = '2026-08-25T10:05:00Z'
  const event = { ...apiPR, title: 'Write the widget guide (DOC-326)', created_at: created, changed_files: 2 }
  const request = { ...turn('request', 'user', 0), session_id: parent }
  const files = [{ ...patchFile, filename: 'docs/widget.md' },
    { filename: 'docs/images/widget.png', status: 'added', additions: 0, deletions: 0 }]
  let body = event.body
  let retries = 0
  const logs = []
  const github = async (path, method, payload) => {
    if (path) return files
    if (method === 'PATCH') body = payload.body
    return { ...event, body }
  }
  const query = async sql => {
    assert.match(sql, /contributor\/project/)
    if (sql.includes('git_branch =')) return []
    if (sql.includes('length(tool_args)')) return []
    if (sql.includes('regexp_like(tool_args')) return retries ? [{ session_id: child }] : []
    if (sql.includes('agent_created_thread')) return [{ parent, delivered_at: created }]
    if (sql.includes('select distinct tool_result_for')) return [{ tool_result_for: 'call_123' }]
    if (sql.includes('tool_call_id =')) return [{ tool_call_id: 'call_123' }]
    if (sql.includes('order by message_created_at desc')) return [{ ...request, is_request: 1 }]
    if (sql.includes('as text_part')) return [{ ...request, part_index: 0, chars: 6, text_part: 'widget' }]
    return []
  }
  const result = await describe(event, { github, query, retryDiscovery: true, pause: async () => { retries++ },
    log: line => logs.push(line), draft: async (title, messages, patches, env, scope) => {
      assert.equal(messages.length, 1)
      assert.match(messages[0].link, new RegExp(parent))
      assert.equal(scope, 'This PR changes documentation only.')
      return { why: { text: 'The developer wanted a widget guide.', sources: ['M1'] }, decisions: [] }
    } })
  assert.equal(retries, 1)
  assert.match(result, /Cited context/)
  assert.match(body, /Developer message 1/)
  assert.ok(body.endsWith(event.body))
  assert.match(logs.join('\n'), /0 session/)
  assert.doesNotMatch(logs.join('\n'), /handoff DOC-326/)
})

test('a documentation screenshot can accompany a guide without hiding incomplete code patches', () => {
  const docs = { ...patchFile, filename: 'docs/guide.md' }
  const image = { filename: 'docs/images/setup.png', status: 'added', additions: 0, deletions: 0 }
  assert.equal(changeScope([docs, image]), 'This PR changes documentation only.')
  assert.doesNotThrow(() => codeChanges([docs, image], 2))
  assert.throws(() => codeChanges([docs, image], 3), /incomplete file list/)
  assert.throws(() => codeChanges([image, { ...patchFile, additions: 2 }], 2), /incomplete patch/)
  assert.throws(() => codeChanges([{ ...image, filename: 'src/runtime.png' }], 1), /incomplete patch/)
})

test('a delegated chat requires a reciprocal creation receipt and the latest matching human command', async () => {
  const child = '10000000-0000-7000-9000-000000000002'
  const link = { parent: '10000000-0000-7000-9000-000000000001', delivered_at: pr.createdAt }
  const receipt = { tool_result_for: 'call_123' }
  const call = { tool_call_id: receipt.tool_result_for }
  const unrelated = { ...turn('other', 'user', 0), is_request: 0 }
  for (const responses of [
    [[], []], // No handoff envelope.
    [[], [link, link]], // Ambiguous source.
    [[], [link], []], // No receipt for this child.
    [[], [link], [receipt], []], // The receipt did not come from creating a chat.
    [[], [link], [receipt], [call], [unrelated]],
  ]) {
    const remaining = [[{ session_id: child }], [], ...responses]
    const result = await discover({ ...pr, title: 'A widget guide (DOC-326)' }, 'team/project', async sql => {
      assert.match(sql, /team\/project/)
      assert.ok(remaining.length)
      return remaining.shift()
    })
    assert.equal(result.sessions[0].candidates.length, 0)
    assert.equal(remaining.length, 0)
  }
})

test('a synchronization or merge during the upload wait stops rediscovery and writeback', async () => {
  let closed = false
  let queries = 0
  const status = await describe(apiPR, { retryDiscovery: true, pause: async () => { closed = true },
    github: async (path, method) => {
      assert.equal(method, undefined)
      return { ...apiPR, state: closed ? 'closed' : 'open' }
    }, query: async () => {
      assert.equal(closed, false)
      queries++
      return []
    }, draft: assert.fail })
  assert.equal(queries, 2)
  assert.match(status, /superseded/)
})

test('matches the quiet push used on PRs 3030 and 3031 while requiring the exact ref', async () => {
  let push
  await discover({ ...pr, headRefName: 'docs-guide' }, 'org/repo', async sql => {
    if (sql.includes('regexp_like(tool_args')) {
      const literal = sql.match(/regexp_like\(tool_args, '(.+)'\)/)[1].replaceAll("''", "'")
      push = new RegExp(literal)
    }
    return []
  })
  assert.match('cd work && git push -q -u origin docs-guide 2>&1', push)
  assert.doesNotMatch('git push -q -u origin docs-guide-other', push)
})

test('recognizes a connector-created branch only for the exact repository, branch and full head SHA', async () => {
  const sha = 'abc123'.repeat(6) + '1234'
  let connector
  await discover({ ...pr, headSha: sha }, 'org/repo', async sql => {
    const match = sql.match(/tool_name = 'exec' and regexp_like\(tool_args, '(.+?)'\)\)/)
    if (match) connector = new RegExp(match[1].replaceAll("''", "'"))
    return []
  })
  const call = `tools.mcp__codex_apps__github_create_branch({repository_full_name:"org/repo",branch_name:"work/widget",sha:"${sha}"})`
  assert.ok(connector)
  assert.match(call, connector)
  for (const wrong of [call.replace(sha, '0'.repeat(40)), call.replace('org/repo', 'another/repo'), call.replace('work/widget', 'work/widget-two')]) {
    assert.doesNotMatch(wrong, connector)
  }
})

test('a crowded branch spends its session budget on recent work', async () => {
  const seen = []
  await discover(pr, 'org/repo', async sql => {
    seen.push(sql)
    return []
  })
  assert.match(seen[0], /group by session_id\s+order by max\(message_created_at\) desc, session_id/)
})

test('a session that worked on two PRs seeds each one on its own request (#3051)', async () => {
  // The real queries run over one recorded session: task A's request, its PR,
  // then task B's request, whose wording shares a title word with task A's.
  const at = (/** @type {string} */ time) => new Date(`2026-11-20T${time}:00Z`)
  const row = (/** @type {string} */ id, /** @type {string} */ role, /** @type {string} */ time, /** @type {string} */ branch, /** @type {string} */ text) => ({
    session_id: 'one-session', message_id: id, role, message_created_at: at(time), date: '2026-11-20', part_type: 'text',
    is_sidechain: false, agent_id: null, conversation_id: null, git_remote: 'https://github.com/org/repo', git_branch: branch,
    attributes: '{"claude":{"origin":{"kind":"human"}}}', user_type: 'user', entrypoint: 'cli', content_text: text,
    tool_name: null, tool_args: null })
  const rows = [
    row('a-request', 'user', '09:00', 'work/picks', 'Apply the wording picks to the codex setup page'),
    row('a-reply', 'assistant', '09:05', 'work/picks', 'The picks are applied.'),
    row('b-request', 'user', '12:00', 'work/compaction', 'Give each codex compaction call a usage row of its own'),
    row('b-reply', 'assistant', '12:05', 'work/compaction', 'Each compaction call now gets its own row.'),
  ]
  const query = async (/** @type {string} */ sql) => (await collect(executeSql({ query: sql, tables: { ai_gateway_messages: rows } })))
    .map(found => Object.fromEntries(Object.entries(found).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])))
  const now = Date.parse('2026-11-20T14:00:00Z')
  const request = async (/** @type {object} */ target) => {
    const { sessions } = await discover({ ...pr, closedAt: undefined, ...target }, 'org/repo', query, now)
    return sessions[0].candidates.find(({ label }) => label === 'Possible request')?.turn.message_id
  }
  assert.equal(await request({ title: 'Codex setup wording picks', headRefName: 'work/picks', createdAt: '2026-11-20T10:00:00Z' }), 'a-request')
  assert.equal(await request({ title: 'Codex compaction usage rows', headRefName: 'work/compaction', createdAt: '2026-11-20T13:00:00Z' }), 'b-request')
  // A PR opened before any request still finds the earliest one after it.
  assert.equal(await request({ title: 'Codex setup wording picks', headRefName: 'work/picks', createdAt: '2026-11-20T08:00:00Z' }), 'a-request')
})

// One recorded seat session for the #3051 tests: task A, its PR and a review
// round, then task B. Each task's request, options and pick come before its
// first push.
const at = (/** @type {string} */ time) => new Date(`2026-11-20T${time}:00Z`)
const fields = { session_id: 'seat', date: '2026-11-20', is_sidechain: false, agent_id: null, conversation_id: null,
  git_remote: 'https://github.com/org/repo', git_branch: 'seat', attributes: '{"claude":{"origin":{"kind":"human"}}}', user_type: 'user', entrypoint: 'cli' }
const text = (/** @type {string} */ id, /** @type {string} */ role, /** @type {string} */ time, /** @type {string} */ content) =>
  ({ ...fields, part_type: 'text', message_id: id, role, message_created_at: at(time), content_text: content, tool_name: null, tool_args: null })
const push = (/** @type {string} */ id, /** @type {string} */ time, /** @type {string} */ ref, command = `git push -q -u origin ${ref} 2>&1 | tail -2`) =>
  ({ ...fields, part_type: 'tool_call', message_id: id, role: 'assistant', message_created_at: at(time), content_text: null, tool_name: 'Bash', tool_args: JSON.stringify({ command }) })

const taskA = [
  text('a-request', 'user', '09:00', 'Apply the wording picks to the codex setup page'),
  text('a-options', 'assistant', '09:05', 'Two options for the label: option a or option b.'),
  text('a-pick', 'user', '09:10', 'go with option a'),
  text('a-follow-up', 'assistant', '09:12', 'Option a is in.'),
  push('a-push', '09:30', 'work/picks'),
  text('a-round', 'user', '10:30', 'go with option b instead'),
  text('a-round-reply', 'assistant', '10:32', 'Option b is in and pushed.'),
  push('a-push-2', '10:40', 'work/picks'),
]
const taskB = (/** @type {string} */ request) => [
  text('b-request', 'user', '12:00', request),
  text('b-options', 'assistant', '12:05', 'Option one or option two for the row.'),
  text('b-pick', 'user', '12:10', 'go with option two'),
  push('b-push', '12:30', 'work/compaction'),
]
const ids = async (/** @type {any[]} */ rows, /** @type {object} */ target) => {
  const query = async (/** @type {string} */ sql) => (await collect(executeSql({ query: sql, tables: { ai_gateway_messages: rows } })))
    .map(found => Object.fromEntries(Object.entries(found).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])))
  const { sessions } = await discover({ ...pr, closedAt: undefined, ...target }, 'org/repo', query, Date.parse('2026-11-20T14:00:00Z'))
  return sessions[0].candidates.map(({ turn }) => turn.message_id)
}
const prA = { title: 'Codex setup wording picks', headRefName: 'work/picks', createdAt: '2026-11-20T10:00:00Z' }
const prB = { title: 'Codex compaction usage rows', headRefName: 'work/compaction', createdAt: '2026-11-20T13:00:00Z' }

test('a push of another branch bounds where a PR\'s context starts and ends (#3051)', async () => {
  // The earlier PR keeps its own review round and ends there: task B's
  // request, options and pick are not shown for it.
  const both = [...taskA, ...taskB('Give each codex compaction call a usage row of its own')]
  assert.deepEqual(await ids(both, prA), ['a-request', 'a-options', 'a-pick', 'a-follow-up', 'a-round', 'a-round-reply'])
  assert.deepEqual(await ids(both, prB), ['b-request', 'b-options', 'b-pick'])
  // A later PR whose own request names no title word does not fall back to
  // the earlier task's: there is no seed, so nothing is cited.
  assert.deepEqual(await ids([...taskA, ...taskB('Take the next row and open the PR')], prB), [])
  // Alone in its session, a task reads as it did before these bounds.
  assert.deepEqual(await ids(taskA, prA), ['a-request', 'a-options', 'a-pick', 'a-follow-up', 'a-round', 'a-round-reply'])
})

test('every push form the seats use bounds the context, and a push it cannot read cites nothing (#3051)', async () => {
  const later = (/** @type {string} */ command) => [...taskB('Give each codex compaction call a usage row of its own').slice(0, 3),
    push('b-push', '12:30', 'work/compaction', command)]
  const ownOnly = ['a-request', 'a-options', 'a-pick', 'a-follow-up', 'a-round', 'a-round-reply']
  for (const command of [
    'git push origin HEAD:work/compaction',
    'git -C /work/seat/tasks/compaction push -q -u origin work/compaction',
    'git push --force-with-lease=work/compaction:abc123 origin work/compaction',
    'git push origin 0123456789abcdef0123456789abcdef01234567:refs/heads/work/compaction',
    'git push origin fix-local:work/compaction',
    'cd /work && git status && git push --no-verify -f origin work/compaction',
  ]) assert.deepEqual(await ids([...taskA, ...later(command)], prA), ownOnly, command)
  // A push it cannot read could be the next task's, so the session is not cited.
  for (const command of [
    'git push https://github.com/org/repo work/compaction',
    'git push',
    'git push -u origin HEAD',
    'git push upstream work/compaction',
    'git push origin work/compaction && git push other work/compaction',
  ]) assert.deepEqual(await ids([...taskA, ...later(command)], prA), [], command)
})

test('a push is read from the command text a call ran, and one that cannot be read cites nothing (#3051)', async () => {
  const later = (/** @type {object} */ call) => [...taskB('Give each codex compaction call a usage row of its own').slice(0, 3), { ...push('b-push', '12:30', 'work/compaction'), ...call }]
  const ran = (/** @type {string} */ command) => later({ tool_args: JSON.stringify({ command, description: 'Push the branch' }) })
  const ownOnly = ['a-request', 'a-options', 'a-pick', 'a-follow-up', 'a-round', 'a-round-reply']
  // Read: task B's push bounds PR A in each of these.
  for (const command of [
    'cd /work/seat/tasks/compaction\ngit push -q -u origin work/compaction 2>&1 | tail -2',
    'GIT_SSH_COMMAND=ssh git push origin work/compaction',
    '(cd /work && git push origin work/compaction)',
    'out=$(git push origin work/compaction 2>&1); echo "$out"',
    'echo `git push origin work/compaction`',
    'git -c credential.helper= push origin work/compaction',
    'git -C "$PWD" push -u origin work/compaction',
    'git push \\\n  --force-with-lease origin \\\n  work/compaction',
  ]) assert.deepEqual(await ids([...taskA, ...ran(command)], prA), ownOnly, command)
  // A commit message that names a push is not one; the push after it is read.
  assert.deepEqual(await ids([...taskA, ...ran('git commit -m "make git push work" && git push origin work/compaction')], prA), ownOnly)
  // Not read: a push it finds but cannot read, or arguments that do not parse.
  for (const call of [
    { tool_args: JSON.stringify({ command: 'cd /work\ngit push origin "$BRANCH"' }) },
    { tool_args: JSON.stringify({ command: 'FOO=1 git push upstream work/compaction' }) },
    { tool_args: JSON.stringify({ command: 'cd /work\ngit push' }) },
    { tool_args: '{"command":"cd /work && git push origin work/compaction"' },
  ]) assert.deepEqual(await ids([...taskA, ...later(call)], prA), [], call.tool_args)
})

test('a push inside a quoted command is read, and a long run of git options reads at once (#3051)', async () => {
  const later = (/** @type {string} */ command) => [...taskB('Give each codex compaction call a usage row of its own').slice(0, 3),
    push('b-push', '12:30', 'work/compaction', command)]
  const ownOnly = ['a-request', 'a-options', 'a-pick', 'a-follow-up', 'a-round', 'a-round-reply']
  for (const command of [
    'bash -c "git push origin work/compaction"',
    "sh -c 'git push -u origin work/compaction'",
    'eval "git push origin work/compaction"',
    'bash <<< "git push origin work/compaction"',
  ]) assert.deepEqual(await ids([...taskA, ...later(command)], prA), ownOnly, command)
  // `-c` and `-C` take a value that can start with `-`; many of them in a row
  // must not make the match backtrack.
  // A command that is not a push, with 24 of them, beside the real push.
  const options = 'echo git ' + '-c -x '.repeat(24) + 'pull origin master\ngit push origin work/compaction'
  const started = Date.now()
  assert.deepEqual(await ids([...taskA, ...later(options)], prA), ownOnly)
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`)
})

test('a quoted mention of this PR\'s branch is not its first push (#3051)', async () => {
  // Task B's own request names no title word, so only the push bounds can
  // keep task A's request out. An early echo of B's branch must not anchor B.
  const mention = push('b-mention', '09:10', 'work/compaction', 'echo "git push origin work/compaction"')
  const rows = [...taskA, mention, ...taskB('Take the next row and open the PR')]
  assert.deepEqual(await ids(rows, prB), [])
})

test('release and compound titles retain the human wording found on the original PRs', async () => {
  for (const [title, phrases] of [
    ['Publish v2.0.0', ['publish', '[$prepare-release]']],
    ['Shorten the CLI: top-level commands', ['cli', 'top-level', 'top level']],
  ]) {
    let seedQuery
    await discover({ ...pr, title }, 'org/repo', async sql => {
      if (sql.includes('git_branch =')) return [{ session_id: 'work' }]
      seedQuery = sql
      return []
    })
    for (const phrase of phrases) assert.ok(seedQuery.includes(`like '%${phrase}%'`))
  }
})

test('records the model input, visible reply and usage under the GitHub run attempt', async t => {
  const draft = { why: { text: 'Document widgets.', sources: ['M1'] }, decisions: [] }
  const usage = { input_tokens: 48, output_tokens: 14 }
  const env = { OPENAI_API_KEY: 'provider-credential', HYP_PR_CONTEXT_RECORDING_TOKEN: 'enrollment-credential',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }
  const messages = [{ id: 'M1', role: 'user', text: 'Explain widgets.' }]
  const visible = { type: 'message', role: 'assistant', id: 'msg-1',
    content: [{ type: 'output_text', text: JSON.stringify(draft) }] }
  let input
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push(url)
    const body = JSON.parse(opts.body)
    if (url === 'https://api.openai.com/v1/responses') {
      input = body
      assert.equal(opts.headers.authorization, 'Bearer provider-credential')
      return Response.json({ status: 'completed', id: 'response-1', usage,
        output: [{ type: 'reasoning', encrypted_content: 'internal-only' }, visible] })
    }
    if (url.endsWith('/identity/bootstrap')) {
      assert.deepEqual(body, { bootstrap_token: env.HYP_PR_CONTEXT_RECORDING_TOKEN })
      assert.equal(opts.headers.authorization, undefined)
      return Response.json({ jwt: 'recording-credential' })
    }
    assert.equal(url, 'https://api.hypaware.ai/v1/intake?format=openai-responses')
    assert.equal(opts.headers.authorization, 'Bearer recording-credential')
    assert.deepEqual(body.request, input)
    assert.deepEqual(JSON.parse(body.request.input), { title: 'Widgets', messages, changes: [patchFile] })
    assert.deepEqual(body.response.output, [visible])
    assert.deepEqual(body.response.usage, usage)
    assert.equal(body.client_name, 'hypaware-pr-context')
    assert.equal(body.session_id, 'pr-context-123-2')
    assert.doesNotMatch(opts.body, /internal-only|-credential/)
    return Response.json({}, { status: 202 })
  })
  const logs = t.mock.method(console, 'info', () => {})
  const warnings = t.mock.method(console, 'warn', () => {})
  assert.deepEqual(await generate('Widgets', messages, [patchFile], env, ''), draft)
  assert.equal(calls.length, 3)
  assert.equal(warnings.mock.callCount(), 0)
  assert.match(String(logs.mock.calls[0].arguments[0]), /sessions\/pr-context-123-2/)
})

test('recording is optional, and an upload failure preserves the provider result or error', async t => {
  const draft = { why: null, decisions: [] }
  const env = { OPENAI_API_KEY: 'provider', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' }
  let calls = 0
  let failProvider = false
  const warnings = t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async url => {
    calls++
    if (url.endsWith('/identity/bootstrap')) return Response.json({ jwt: 'gateway' })
    if (url.includes('/intake?')) return new Response('untrusted server detail', { status: 503 })
    if (failProvider) return new Response('sensitive error', { status: 429 })
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(draft) }] }] })
  })
  assert.deepEqual(await generate('PR', [], [], env, ''), draft)
  assert.equal(calls, 1)
  const recording = { ...env, HYP_PR_CONTEXT_RECORDING_TOKEN: 'enrollment' }
  assert.deepEqual(await generate('PR', [], [], recording, ''), draft)
  failProvider = true
  await assert.rejects(generate('PR', [], [], recording, ''), /OpenAI returned HTTP 429/)
  assert.equal(warnings.mock.callCount(), 2)
  assert.doesNotMatch(JSON.stringify(warnings.mock.calls.map(c => c.arguments)), /untrusted|sensitive/)
})
