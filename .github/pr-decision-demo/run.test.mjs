import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hash, originalBody, prependContext, sourceLink, evidenceQuery, verifiedEvidence, renderSection, main } from './run.mjs'

const manifest = JSON.parse(await readFile(new URL('./evidence.json', import.meta.url), 'utf8'))
const rows = manifest.sources.map(source => ({ session_id: manifest.session_id, conversation_id: source.conversation_id, agent_id: source.agent_id, message_id: source.message_id, part_id: source.part_id, date: source.date, content_text: source.reviewed_text }))
const result = { why: { text: 'An upstream alert identified duplicate capture and a risk to OpenCode privacy settings.', sources: ['S0', 'S3'] }, claims: [{ text: 'The launch marker identifies ownership before the first turn.', sources: ['S4', 'S5'] }] }
const section = renderSection(result, manifest, 'https://github.com/hyparam/hypaware/actions/runs/1', 'https://github.com/hyparam/hypaware/blob/example/.github/pr-decision-demo/evidence.json')
const START = '<!-- hypaware-decision-demo:start -->'
const END = '<!-- hypaware-decision-demo:end -->'

test('only exact reviewed text, message identity, chain and day are admitted', () => {
  assert.deepEqual(verifiedEvidence(manifest, rows), manifest.sources.map(source => ({ id: source.id, title: source.title, text: source.reviewed_text })))
  for (const key of ['content_text', 'session_id', 'message_id', 'part_id', 'conversation_id', 'agent_id', 'date']) {
    assert.throws(() => verifiedEvidence(manifest, [{ ...rows[0], [key]: 'other' }, ...rows.slice(1)]), /unapproved_evidence/)
  }
  assert.throws(() => verifiedEvidence(manifest, rows.slice(1)), /evidence_count/)
  assert.throws(() => verifiedEvidence(manifest, [rows[0], ...rows.slice(0, -1)]), /unapproved_evidence/)
})

test('header reruns and legacy footer migration preserve authored bytes', () => {
  for (const body of ['', 'Human description', 'Human description\n', '\nHuman description\n\n']) {
    const top = prependContext(body, section)
    assert.equal(originalBody(top), body)
    assert.equal(prependContext(top, section), top)
    if (body) {
      const footer = `${body}\n\n${section}`
      assert.equal(originalBody(footer), body)
      assert.equal(prependContext(footer, section), top)
    }
  }
})

test('ambiguous or malformed markers are rejected without dropping authored text', () => {
  for (const body of [END, START, END + START, START + START + END, START + END + END, START + END + 'later human text', 'before\n\n' + section + '\n\nafter', 'before' + section]) {
    assert.throws(() => originalBody(body))
  }
})

test('message links encode identities, select the chain and include the recorded UTC day', () => {
  const source = { conversation_id: 'main/chain', agent_id: 'agent/chain', message_id: 'msg?value=#', date: '2026-11-05' }
  const root = { session_id: 'session/id' }
  assert.equal(sourceLink(root, source), 'https://app.hypaware.ai/sessions/session%2Fid/agent%2Fchain?m=msg%3Fvalue%3D%23&d=2026-11-05')
  assert.match(sourceLink(root, { ...source, agent_id: null }), /session%2Fid\/main%2Fchain\?m=/)
  assert.match(sourceLink(root, { ...source, agent_id: null, conversation_id: null }), /session%2Fid\?m=/)
})

test('query fetches the short approved origin slice rather than the full trigger message', () => {
  const sql = evidenceQuery(manifest)
  assert.match(sql, /SUBSTR\(content_text,146,140\)/)
  assert.match(sql, /conversation_id, agent_id, message_id, part_id, date/)
  assert.match(sql, /LIMIT 7$/)
  assert.match(evidenceQuery({ ...manifest, session_id: "session'quote" }), /session''quote/)
  for (const start_char of [0, -1, 1.1, '1']) assert.throws(() => evidenceQuery({ ...manifest, sources: [{ ...manifest.sources[0], start_char }] }), /invalid_evidence_slice/)
  for (const char_count of [0, 4001, '140']) assert.throws(() => evidenceQuery({ ...manifest, sources: [{ ...manifest.sources[0], char_count }] }), /invalid_evidence_slice/)
  assert.throws(() => evidenceQuery({ ...manifest, sources: [] }), /invalid_evidence_count/)
})

test('why comes first, cites the initiating request, and every source is clickable', () => {
  assert.ok(section.indexOf('**Why this PR exists.**') < section.indexOf('- The launch marker'))
  for (const id of ['S0', 'S3', 'S4', 'S5']) {
    const source = manifest.sources.find(item => item.id === id)
    assert.ok(section.includes(`[${id}](${sourceLink(manifest, source)})`))
    assert.ok(section.includes(`[${id} · ${source.title}](${sourceLink(manifest, source)})`))
  }
  assert.ok(section.includes('organization access'))
  assert.ok(section.includes('[reviewed excerpts](https://github.com/'))
  assert.throws(() => renderSection({ ...result, why: { text: 'No origin evidence', sources: ['S3'] } }, manifest, 'run', 'evidence'), /missing_origin_citation/)
})

test('why and decision claims both require known citations and safe bounded text', () => {
  for (const claim of [undefined, { text: 'Why', sources: [] }, { text: 'Why', sources: ['invented'] }, { text: '<!-- marker -->', sources: ['S0'] }, { text: 'a'.repeat(1001), sources: ['S0'] }, { text: '', sources: ['S0'] }]) {
    assert.throws(() => renderSection({ ...result, why: claim }, manifest, 'run', 'evidence'))
    assert.throws(() => renderSection({ ...result, claims: [claim] }, manifest, 'run', 'evidence'))
  }
  for (const claims of [[], Array(4).fill(result.claims[0])]) assert.throws(() => renderSection({ ...result, claims }, manifest, 'run', 'evidence'), /invalid_claim_count/)
})

test('complete action fetches reviewed evidence once and replaces the header after one inference', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'hyp-pr-demo-test-'))
  const authored = 'Human description\n\n'
  const before = prependContext(authored, section)
  const fixture = { ...manifest, original_body_sha256: hash(authored) }
  let body = before
  let writes = 0
  let modelCalls = 0
  let evidenceCalls = 0
  const env = { GITHUB_REPOSITORY: manifest.repository, GITHUB_RUN_ID: 'fixture', GITHUB_SHA: 'b'.repeat(40), GITHUB_TOKEN: 'test-github', HYP_PR_DEMO_QUERY_TOKEN: 'test-query', HYP_PR_DEMO_OPENAI_KEY: 'test-model', RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: join(temp, 'summary.md') }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value
    await rm(temp, { recursive: true, force: true })
  })
  const json = data => Response.json(data)
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    assert.equal(options.redirect, 'error')
    if (url === 'https://api.hypaware.ai/v1/mcp') {
      const rpc = JSON.parse(options.body)
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (rpc.method === 'initialize') return json({ jsonrpc: '2.0', id: rpc.id, result: {} })
      assert.equal(rpc.method, 'tools/call')
      assert.equal(rpc.params.name, 'query_sql')
      assert.equal(rpc.params.arguments.sql, evidenceQuery(fixture))
      evidenceCalls++
      return json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { rows, truncated: false } } })
    }
    if (url === 'https://api.openai.com/v1/responses') {
      modelCalls++
      const request = JSON.parse(options.body)
      const input = JSON.parse(request.input)
      assert.equal(input.description, authored)
      assert.equal(input.evidence.length, 6)
      assert.deepEqual(request.text.format.schema.required, ['why', 'claims'])
      return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }], usage: { input_tokens: 100, output_tokens: 100 } })
    }
    const api = `https://api.github.com/repos/${manifest.repository}/pulls/${manifest.pr_number}`
    if (url === `${api}/files?per_page=100`) return json([{ filename: 'example.js', patch: '+example' }])
    assert.equal(url, api)
    if (options.method === 'PATCH') {
      writes++
      body = JSON.parse(options.body).body
    }
    return json({ head: { sha: manifest.head_sha }, body, changed_files: 1, title: 'Example', html_url: `https://github.com/${manifest.repository}/pull/${manifest.pr_number}` })
  })
  await main(fixture)
  assert.equal(evidenceCalls, 1)
  assert.equal(modelCalls, 1)
  assert.equal(writes, 1)
  assert.ok(body.startsWith(START))
  assert.equal(body.split(START).length, 2)
  assert.equal(originalBody(body), authored)
  assert.equal(await readFile(join(temp, 'pr-context-before.md'), 'utf8'), before)
  assert.equal(await readFile(join(temp, 'pr-context-after.md'), 'utf8'), body)
  assert.match(await readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), /Generated section at the top/)
})
