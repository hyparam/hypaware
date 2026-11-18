#!/usr/bin/env node
// Build digest.json: one record per session-day slice from HypAware recordings, plus the PRs the user opened.
// usage: node digest.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--remote TARGET] [--org LABEL] [--gateways gw-a,gw-b]
//                         [--logins a,b] [--owner ORG] [--no-gh] [--prs none] [--out digest.json] [--attrib-window-min 15]
// PRs and the session-to-PR links come from HypAware's GitHub events and graph; gh only adds titles (and is the PR
// source where GitHub capture has nothing). --gateways picks one person's machines; --org reads another org (operators).
// Deterministic. Prints timings to stderr.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const iso = (d) => d.toISOString().slice(0, 10);
const D1 = opt("--to", iso(new Date()));
const D0 = opt("--from", iso(new Date(Date.parse(D1) - 6 * 864e5)));
const REMOTE = opt("--remote", null);
// operator only: read another org on the remote by label; every read is recorded in that org's audit trail
const ORG = opt("--org", null);
const WIN_MIN = Number(opt("--attrib-window-min", 15));
const OUT = opt("--out", "digest.json");
const T0 = performance.now(); let last = T0;
const lap = (n) => { const t = performance.now(); process.stderr.write(`  ${((t - last) / 1000).toFixed(2).padStart(6)}s  ${n}\n`); last = t; };

// graphIds: the graph tables hide natural_key (the session id, the PR "owner/repo#n") on rows recorded only on this
// machine unless --include-local-only is passed, and then no session matches. Those reads return ids only, never
// conversation text, and the flag applies to the local cache, so it is added for local graph reads and nowhere else.
function hypSql(sql, graphIds = false) {
  const path = join(tmpdir(), `hyp-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const args = ["query", "sql", sql, "--format", "json", "--output", path];
  if (REMOTE) args.push("--remote", REMOTE); else if (graphIds) args.push("--include-local-only");
  if (REMOTE && ORG) args.push("--org", ORG);
  execFileSync("hyp", args, { stdio: ["ignore", "ignore", "inherit"] });
  const data = JSON.parse(readFileSync(path, "utf8")); unlinkSync(path); return data;
}
const GW = (opt('--gateways', '') || '').split(',').filter((g) => /^[\w-]+$/.test(g));
const OWNER = opt('--owner', null);
const WHERE = `date >= '${D0}' AND date <= '${D1}' AND conversation_source IN ('claude_code','codex')` + (GW.length ? ` AND gateway_id IN (${GW.map((g) => `'${g}'`).join(',')})` : '');
const USAGE = `JSON_EXTRACT(attributes,'$.usage') IS NOT NULL`;
const tsum = (f) => `SUM(COALESCE(CAST(JSON_EXTRACT(attributes,'$.usage.${f}') AS BIGINT),0)) AS ${f}`;
// Human-typed turns: the 1.48+ label, or, for rows recorded before the label existed, the text heuristic from hypaware-query/sql.md.
const HUMAN = `(JSON_EXTRACT_STRING(attributes,'$.claude.origin.kind') = 'human'
 OR JSON_EXTRACT_STRING(attributes,'$.codex.content_item_kinds') LIKE '%"user.text"%'
 OR (conversation_source = 'claude_code' AND JSON_EXTRACT_STRING(attributes,'$.claude.origin.kind') IS NULL AND JSON_EXTRACT_STRING(attributes,'$.claude.prompt_source') IS NULL
     AND COALESCE(is_sidechain,false) = false AND (agent_id IS NULL OR agent_id = '') AND (entrypoint IS NULL OR entrypoint <> 'sdk-cli')
     AND substr(content_text,1,1) NOT IN ('<','[') AND content_text NOT LIKE 'Base directory for this skill%' AND content_text NOT LIKE 'Tool loaded.%'
     AND content_text NOT LIKE 'Skill /%' AND content_text NOT LIKE 'This session is being continued%' AND content_text NOT LIKE 'Another Claude session sent%'))`;
const PR_RE = `github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+`;

// 1. tokens per session-day-model, with repo/branch samples
const rows = hypSql(`SELECT session_id, date, conversation_source, model, COUNT(*) AS msgs,
 ${tsum("input_tokens")}, ${tsum("output_tokens")}, ${tsum("cache_read_tokens")}, ${tsum("cache_write_tokens")},
 MIN(message_created_at) AS first_at, MAX(message_created_at) AS last_at,
 MIN(COALESCE(repo_root, cwd)) AS repo_a, MAX(COALESCE(repo_root, cwd)) AS repo_b, MIN(git_branch) AS branch_a, MAX(git_branch) AS branch_b
 FROM ai_gateway_messages WHERE ${WHERE} AND ${USAGE}
 GROUP BY session_id, date, conversation_source, model`);
lap("sql: token aggregates");

// 2. first three and last human-typed prompts per session-day
const prompts = hypSql(`SELECT session_id, date, rn, rd, substr(content_text,1,240) AS prompt FROM (
 SELECT session_id, date, content_text,
  ROW_NUMBER() OVER (PARTITION BY session_id, date ORDER BY message_created_at) AS rn,
  ROW_NUMBER() OVER (PARTITION BY session_id, date ORDER BY message_created_at DESC) AS rd
 FROM ai_gateway_messages WHERE ${WHERE} AND role='user' AND part_type='text' AND ${HUMAN}) t
 WHERE rn <= 3 OR rd = 1 ORDER BY session_id, date, rn`);
lap("sql: human prompts");

// 3. PR links per session with first mention
const mentions = hypSql(`SELECT session_id, regexp_extract(content_text, '${PR_RE}') AS pr, MIN(message_created_at) AS first_at
 FROM ai_gateway_messages WHERE ${WHERE} AND content_text LIKE '%github.com/%/pull/%'
 GROUP BY session_id, regexp_extract(content_text, '${PR_RE}')`).filter((m) => m.pr);
lap("sql: PR mentions");

// 4. top tool names per session-day (cheap signal: what kind of work it was)
const tools = hypSql(`SELECT session_id, date, tool_name, COUNT(*) AS n FROM ai_gateway_messages
 WHERE ${WHERE} AND part_type='tool_call' AND tool_name IS NOT NULL GROUP BY session_id, date, tool_name`);
lap("sql: tool counts");

// 5. Pull requests. HypAware's own GitHub events and graph come first: they work for any org, need no
// GitHub login, and record which session was at a commit that a PR contains. gh adds titles (the events
// carry none) and is the PR source only where GitHub capture has nothing. --prs none skips all of it;
// --no-gh skips gh only.
const pkey = (repo, n) => `github.com/${repo}/pull/${n}`;
const chunk = (xs, n) => { const o = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const lit = (xs) => xs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(",");
let prs = {}; const graphLinks = []; const sources = []; let ghLogins = null;
if (opt("--prs", "auto") !== "none") {
  try {
    const ev = hypSql(`SELECT repo, number, actor_login, state, MIN(created_at) AS created_at FROM github_events
 WHERE event_type='pull_request' AND created_at >= '${D0}' AND created_at <= '${D1}T23:59:59.999Z' GROUP BY repo, number, actor_login, state`);
    const rank = { merged: 3, closed: 2, open: 1 };
    for (const e of ev) {
      if (!e.repo || e.number == null) continue;
      const k = pkey(e.repo, e.number), short = e.repo.split("/")[1] ?? e.repo;
      const cur = prs[k] ?? (prs[k] = { id: `${short}#${e.number}`, repo: short, number: Number(e.number), author: e.actor_login ?? null, title: "", state: "OPEN", createdAt: e.created_at, url: `https://${k}`, _r: 0 });
      if ((rank[e.state] ?? 0) > cur._r) { cur._r = rank[e.state]; cur.state = String(e.state).toUpperCase(); }
      if (e.created_at < cur.createdAt) cur.createdAt = e.created_at;
    }
    for (const p of Object.values(prs)) delete p._r;
    lap(`sql: pull requests from HypAware GitHub events (${Object.keys(prs).length})`);
    if (Object.keys(prs).length) sources.push("hypaware");
  } catch (e) { process.stderr.write("  no GitHub events readable here; PRs will come from gh if it is available\n"); }
  if (sources.length) try {
    // Session -at-> Commit <-references- PullRequest, resolved in steps with literal ids (the planner is slow on the self-join)
    const sids = [...new Set(rows.map((r) => r.session_id))].filter((x) => /^[\w-]+$/.test(x));
    const sn = chunk(sids, 300).flatMap((c) => hypSql(`SELECT node_id, natural_key FROM node WHERE node_type='Session' AND natural_key IN (${lit(c)})`, true));
    const sOf = new Map(sn.map((r) => [r.node_id, r.natural_key]));
    const at = chunk([...sOf.keys()], 300).flatMap((c) => hypSql(`SELECT src_id, dst_id FROM edge WHERE edge_type='at' AND src_id IN (${lit(c)})`, true));
    const refs = chunk([...new Set(at.map((r) => r.dst_id))], 300).flatMap((c) => hypSql(`SELECT src_id, dst_id FROM edge WHERE edge_type='references' AND dst_id IN (${lit(c)})`, true));
    const pn = chunk([...new Set(refs.map((r) => r.src_id))], 300).flatMap((c) => hypSql(`SELECT node_id, natural_key FROM node WHERE node_type='PullRequest' AND node_id IN (${lit(c)})`, true));
    const prOf = new Map(pn.map((r) => [r.node_id, r.natural_key])); // "owner/repo#123"
    const byCommit = new Map(); for (const r of refs) (byCommit.get(r.dst_id) ?? byCommit.set(r.dst_id, []).get(r.dst_id)).push(r.src_id);
    const seen = new Set();
    for (const a of at) for (const p of byCommit.get(a.dst_id) ?? []) {
      const m = /^(.+)#(\d+)$/.exec(prOf.get(p) ?? ""); if (!m) continue;
      const k = pkey(m[1], m[2]), sid = sOf.get(a.src_id);
      if (prs[k] && !seen.has(sid + k)) { seen.add(sid + k); graphLinks.push({ session_id: sid, pr: k }); }
    }
    lap(`sql: session to PR links from the graph (${sn.length} sessions, ${at.length} commits seen, ${graphLinks.length} links)`);
  } catch (e) { process.stderr.write("  graph not readable here; PR links fall back to the link-timing rule\n"); }
  // gh: titles, plus any PR the events have not caught up with. Never for another org: its name would go to GitHub.
  if (!has("--no-gh") && !ORG) try {
    const found = JSON.parse(execFileSync("gh", ["search", "prs", ...(OWNER ? ["--owner", OWNER] : ["--author", "@me"]), "--created", `${D0}..${D1}`, "--limit", "500",
      "--json", "number,title,state,createdAt,url,repository,author"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    for (const pr of found) {
      const full = pr.repository.nameWithOwner, k = pkey(full, pr.number);
      prs[k] = { ...(prs[k] ?? { id: `${full.split("/")[1]}#${pr.number}`, repo: full.split("/")[1], number: pr.number, createdAt: pr.createdAt, url: pr.url }),
        author: pr.author?.login ?? prs[k]?.author ?? null, title: pr.title, state: pr.state.toUpperCase() };
    }
    if (!OWNER) ghLogins = [...new Set(found.map((p) => p.author?.login).filter(Boolean))];
    sources.push("gh");
    lap(`gh: titles and PRs (${found.length} found)`);
  } catch (e) { process.stderr.write(sources.length ? "  gh unavailable; PRs are shown without titles\n" : "  gh unavailable or failed; continuing without PR data\n"); }
}

// assemble slices
const CL = { claude_code: "Claude Code", codex: "Codex" };
const key = (s, d) => `${s.slice(0, 8)}|${d}`;
const slices = new Map();
const short = (p) => p ? p.replace(/^\/Users\/[^/]+\//, "~/") : null;
for (const r of rows) {
  const k = key(r.session_id, r.date);
  const s = slices.get(k) ?? slices.set(k, { id: k, session_id: r.session_id, date: r.date, client: CL[r.conversation_source], models: {}, repos: new Set(), branches: new Set(),
    first_at: r.first_at, last_at: r.last_at, msgs: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, prompts: [], last_prompt: null, tools: {}, prs_seen: [], prs_rule: [], prs_graph: [] }).get(k);
  s.models[r.model] = (s.models[r.model] ?? 0) + r.output_tokens;
  for (const p of [r.repo_a, r.repo_b]) if (p && !/\/private\/tmp\/|scratchpad|\.claude\/projects/.test(p)) s.repos.add(short(p));
  for (const b of [r.branch_a, r.branch_b]) if (b) s.branches.add(b);
  if (r.first_at < s.first_at) s.first_at = r.first_at; if (r.last_at > s.last_at) s.last_at = r.last_at;
  s.msgs += r.msgs; s.tokens.input += r.input_tokens; s.tokens.output += r.output_tokens; s.tokens.cache_read += r.cache_read_tokens; s.tokens.cache_write += r.cache_write_tokens;
}
for (const p of prompts) {
  const s = slices.get(key(p.session_id, p.date)); if (!s) continue;
  const text = p.prompt.replace(/\s+/g, " ").trim();
  if (p.rn <= 3) s.prompts.push(text);
  if (p.rd === 1 && p.rn > 3) s.last_prompt = text;
}
for (const t of tools) { const s = slices.get(key(t.session_id, t.date)); if (s) s.tools[t.tool_name] = (s.tools[t.tool_name] ?? 0) + t.n; }
// A graph link counts only if the PR was opened while the session was alive (or shortly after): a session
// sitting on a commit that some older PR contains did not open that PR.
const span = new Map(); for (const r of rows) { const e = span.get(r.session_id) ?? span.set(r.session_id, { a: r.first_at, b: r.last_at }).get(r.session_id); if (r.first_at < e.a) e.a = r.first_at; if (r.last_at > e.b) e.b = r.last_at; }
const okLink = (l) => { const p = prs[l.pr], s = span.get(l.session_id); if (!p || !s) return false; const t = Date.parse(p.createdAt); return t >= Date.parse(s.a) - 10 * 60e3 && t <= Date.parse(s.b) + 6 * 3600e3; };
const links = graphLinks.filter(okLink);
// Whose PRs these are: --logins if given, else the account gh searched as, else the login behind most of
// the PRs this person's sessions are linked to (by the graph, or by a PR link appearing right after it opened).
let keep = opt("--logins", null) ? opt("--logins").split(",") : ghLogins?.length ? ghLogins : null;
if (!keep) {
  const votes = {};
  for (const l of links) { const a = prs[l.pr].author; if (a) votes[a] = (votes[a] ?? 0) + 1; }
  for (const m of mentions) { const pr = prs[m.pr]; if (!pr?.author) continue; const mins = (Date.parse(m.first_at) - Date.parse(pr.createdAt)) / 60e3; if (mins >= 0 && mins <= WIN_MIN && slices.has(key(m.session_id, m.first_at.slice(0, 10)))) votes[pr.author] = (votes[pr.author] ?? 0) + 1; }
  const login = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (Object.keys(prs).length) process.stderr.write(`  inferred GitHub login: ${login} (${JSON.stringify(votes)})\n`);
  keep = login ? [login] : [];
}
prs = Object.fromEntries(Object.entries(prs).filter(([, p]) => keep.includes(p.author)));
for (const l of links) {
  const p = prs[l.pr]; if (!p) continue;
  const day = p.createdAt.slice(0, 10), mine = [...slices.values()].filter((s) => s.session_id === l.session_id).sort((a, b) => a.date.localeCompare(b.date));
  const s = mine.find((x) => x.date === day) ?? [...mine].reverse().find((x) => x.date <= day) ?? mine[0];
  if (s) { s.prs_rule.push(p.id); s.prs_graph.push(p.id); }
}
for (const m of mentions) {
  const day = m.first_at.slice(0, 10); const s = slices.get(key(m.session_id, day)); if (!s) continue;
  const pr = prs[m.pr]; const mins = pr ? Math.round((Date.parse(m.first_at) - Date.parse(pr.createdAt)) / 60e3) : null;
  if (pr) s.prs_seen.push({ pr: pr.id, minutes_after_created: mins });
  if (pr && mins !== null && mins >= 0 && mins <= WIN_MIN) s.prs_rule.push(pr.id);
}
const out = [...slices.values()].sort((a, b) => b.tokens.output - a.tokens.output).map((s) => ({
  ...s, models: Object.fromEntries(Object.entries(s.models).sort((a, b) => b[1] - a[1])), repos: [...s.repos], branches: [...s.branches],
  tools: Object.fromEntries(Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 5)), prs_rule: [...new Set(s.prs_rule)], prs_graph: [...new Set(s.prs_graph)],
}));
const claimed = new Set(out.flatMap((s) => s.prs_rule));
const digest = {
  window: { from: D0, to: D1 }, remote: REMOTE, org: ORG, pr_source: sources.join("+") || "none", generated_at: new Date().toISOString(), attrib_window_min: WIN_MIN,
  totals: out.reduce((t, s) => { t.msgs += s.msgs; for (const f in s.tokens) t.tokens[f] += s.tokens[f]; return t; }, { sessions: new Set(out.map((s) => s.session_id)).size, slices: out.length, msgs: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }),
  prs: Object.fromEntries(Object.values(prs).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((p) => [p.id, { ...p, claimed_by_rule: claimed.has(p.id) }])),
  slices: out,
};
mkdirSync(dirname(OUT) || ".", { recursive: true });
writeFileSync(OUT, JSON.stringify(digest, null, 1));
process.stderr.write(`  ${((performance.now() - T0) / 1000).toFixed(2).padStart(6)}s  total → ${OUT} (${out.length} slices, ${Object.keys(prs).length} PRs)\n`);
