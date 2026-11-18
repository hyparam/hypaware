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
const ids = [...new Set(D.slices.filter((s) => want.has(s.id)).map((s) => s.session_id))].filter((id) => /^[\w-]+$/.test(id));
if (!ids.length) { console.error("no slice ids from the digest matched --slices"); process.exit(1); }
const HUMAN = `(JSON_EXTRACT_STRING(attributes,'$.claude.origin.kind') = 'human'
 OR JSON_EXTRACT_STRING(attributes,'$.codex.content_item_kinds') LIKE '%"user.text"%'
 OR (conversation_source = 'claude_code' AND JSON_EXTRACT_STRING(attributes,'$.claude.origin.kind') IS NULL AND JSON_EXTRACT_STRING(attributes,'$.claude.prompt_source') IS NULL
     AND COALESCE(is_sidechain,false) = false AND (agent_id IS NULL OR agent_id = '') AND (entrypoint IS NULL OR entrypoint <> 'sdk-cli')
     AND substr(content_text,1,1) NOT IN ('<','[') AND content_text NOT LIKE 'Base directory for this skill%' AND content_text NOT LIKE 'Tool loaded.%'
     AND content_text NOT LIKE 'Skill /%' AND content_text NOT LIKE 'This session is being continued%' AND content_text NOT LIKE 'Another Claude session sent%'))`;

const sql = `SELECT session_id, MIN(message_created_at) AS t, substr(content_text,1,${CH}) AS p, length(content_text) AS len FROM ai_gateway_messages
 WHERE date >= '${D.window.from}' AND date <= '${D.window.to}' AND session_id IN (${ids.map((i) => `'${i}'`).join(",")}) AND role='user' AND part_type='text' AND ${HUMAN}
 GROUP BY session_id, substr(content_text,1,${CH}), length(content_text) ORDER BY t`;
const tmp = join(tmpdir(), `hyp-msgs-${process.pid}.json`);
const args = ["query", "sql", sql, "--format", "json", "--output", tmp]; if (D.remote) args.push("--remote", D.remote); if (D.remote && D.org) args.push("--org", D.org);
execFileSync("hyp", args, { stdio: ["ignore", "ignore", "inherit"] });
const rows = JSON.parse(readFileSync(tmp, "utf8")); unlinkSync(tmp);
console.log(`${rows.length} human messages in ${ids.length} session${ids.length > 1 ? "s" : ""}${rows.length > MAX ? `; showing the first ${MAX}` : ""}`);
for (const r of rows.slice(0, MAX)) {
  const text = /^<send_user_message_question_reply>/.test(r.p) ? "(answered a question dialog)" : r.p.replace(/\s+/g, " ").trim();
  console.log(`${ids.length > 1 ? r.session_id.slice(0, 8) + " " : ""}${r.t.slice(5, 16)} [${r.len}] ${text}${r.len > CH ? " …" : ""}`);
}
