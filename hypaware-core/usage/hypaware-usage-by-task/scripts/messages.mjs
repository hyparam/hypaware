#!/usr/bin/env node
// Print every human-typed message in the sessions behind one task, oldest first, so the model can
// read how the work was steered and write one recommendation. Human messages only, never model output.
// usage: node messages.mjs --digest digest.json --slices "<id>,<id>" [--max 200] [--chars 300]
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const D = JSON.parse(readFileSync(opt("--digest", "digest.json"), "utf8"));
const want = new Set((opt("--slices", "") || "").split(",").map((x) => x.trim()).filter(Boolean));
const MAX = Number(opt("--max", 200)), CH = Number(opt("--chars", 300));
// A slice is one session on one day. Only those days are printed: a multi-day session is several slices, and a
// caller that asks for one of them must not get (or pay to re-read) the others.
const picked = D.slices.filter((s) => want.has(s.id) && /^[\w-]+$/.test(s.session_id));
const ids = [...new Set(picked.map((s) => s.session_id))], days = new Set(picked.map((s) => s.session_id + "|" + s.date));
if (!ids.length) { console.error("no slice ids from the digest matched --slices"); process.exit(1); }
// Codex's approval reviewer runs under the parent session id and is handed the transcript and the planned action
// as user text. Its turns carry the model "codex-auto-review"; nobody typed them, and on a machine with approvals on
// they outnumber typed messages a hundred to one.
const HUMAN = `(JSON_EXTRACT_STRING(attributes,'$.claude.origin.kind') = 'human'
 OR (JSON_EXTRACT_STRING(attributes,'$.codex.content_item_kinds') LIKE '%"user.text"%' AND (model IS NULL OR model <> 'codex-auto-review'))
 OR (conversation_source IN ('claude_code','claude','claude-desktop') AND JSON_EXTRACT_STRING(attributes,'$.claude.origin.kind') IS NULL AND JSON_EXTRACT_STRING(attributes,'$.claude.prompt_source') IS NULL
     AND COALESCE(is_sidechain,false) = false AND (agent_id IS NULL OR agent_id = '') AND (entrypoint IS NULL OR entrypoint <> 'sdk-cli')
     AND substr(content_text,1,1) NOT IN ('<','[') AND content_text NOT LIKE 'Base directory for this skill%' AND content_text NOT LIKE 'Tool loaded.%'
     AND content_text NOT LIKE 'Skill /%' AND content_text NOT LIKE 'This session is being continued%' AND content_text NOT LIKE 'Another Claude session sent%'))`;

const sql = `SELECT session_id, date, conversation_source, MIN(message_created_at) AS t, substr(content_text,1,${CH}) AS p, length(content_text) AS len FROM ai_gateway_messages
 WHERE date >= '${D.window.from}' AND date <= '${D.window.to}' AND conversation_source IN ('claude_code','claude','claude-desktop','codex') AND session_id IN (${ids.map((i) => `'${i}'`).join(",")}) AND role='user' AND part_type='text' AND ${HUMAN}
 GROUP BY session_id, date, conversation_source, substr(content_text,1,${CH}), length(content_text) ORDER BY t`;
const tmp = join(tmpdir(), `hyp-msgs-${process.pid}.json`);
const args = ["query", "sql", sql, "--format", "json", "--output", tmp]; if (D.remote) args.push("--remote", D.remote); if (D.remote && D.org) args.push("--org", D.org);
execFileSync("hyp", args, { stdio: ["ignore", "ignore", "inherit"] });
// A Claude Code session recorded on both lanes (proxy and transcript) holds each message twice: read the lane with
// more of them, which is the proxy unless it was attached part-way through the session.
const all = JSON.parse(readFileSync(tmp, "utf8")); unlinkSync(tmp);
const per = new Map(); for (const r of all) { const o = per.get(r.session_id) ?? per.set(r.session_id, {}).get(r.session_id); o[r.conversation_source] = (o[r.conversation_source] ?? 0) + 1; }
const LANES = ["claude_code", "claude", "claude-desktop"];
const lane = (sid) => { const o = per.get(sid); return LANES.reduce((best, l) => (o[l] ?? -1) > (o[best] ?? -1) ? l : best, LANES[0]); };
const rows = all.filter((r) => days.has(r.session_id + "|" + String(r.date).slice(0, 10)) && (r.conversation_source === "codex" || lane(r.session_id) === r.conversation_source));
const PFX = Math.max(8, ...picked.map((s) => s.id.indexOf("|")));
console.log(`${rows.length} human messages in ${ids.length} session${ids.length > 1 ? "s" : ""}${rows.length > MAX ? `; showing the first ${MAX}` : ""}`);
for (const r of rows.slice(0, MAX)) {
  const text = /^<send_user_message_question_reply>/.test(r.p) ? "(answered a question dialog)" : r.p.replace(/\s+/g, " ").trim();
  console.log(`${ids.length > 1 ? r.session_id.slice(0, PFX) + " " : ""}${r.t.slice(5, 16)} [${r.len}] ${text}${r.len > CH ? " …" : ""}`);
}
