// Shared model for the usage-by-task views: reads digest.json (+ optional labels.json) and works out the groups,
// themes and chart rows. Numbers come only from the digest. chart.mjs (text) and the page's
// render.mjs (HTML) both import this, so the two views always agree.
import { compareStrings as cmp } from "../../../../src/core/util/compare_strings.js";
import { readFileSync } from "node:fs";

export const argv = process.argv.slice(2);
export const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
export const D = JSON.parse(readFileSync(opt("--digest", "digest.json"), "utf8"));
export const LAB = opt("--labels", null) ? JSON.parse(readFileSync(opt("--labels"), "utf8")) : null;
export const warn = (m) => process.stderr.write(`warning: ${m}\n`);

// four kinds of work; the older, finer names are still accepted and folded into these
export const CATS = ["feature", "fix", "investigate", "other"];
export const LEGACY = { question: "investigate", query: "investigate", report: "other", ops: "other" };
export const MAX_THEMES = 8;
export const byId = new Map(D.slices.map((s) => [s.id, s]));
// no PR data at all (gh missing, not signed in, or --no-gh): the page is the task list alone, with no PR wording
export const NOPR = Object.keys(D.prs ?? {}).length === 0;
// ISO dates and times order as plain strings, the same on every machine: the CLI's own comparison.
export { cmp };
export const prs = D.prs;

// ---- groups: from labels.json when given, otherwise from the attribution rule ----
export const fresh = (label, category, auto) => ({ label, category, auto, slices: [], prs: new Set(), out: 0, cr: 0, inp: 0, cw: 0, msgs: 0, clients: {} });
export const addSlice = (g, s) => { g.slices.push(s); g.out += s.tokens.output; g.cr += s.tokens.cache_read; g.inp += s.tokens.input; g.cw += s.tokens.cache_write; g.msgs += s.msgs; g.clients[s.client] = (g.clients[s.client] ?? 0) + s.tokens.output; };
export const groups = []; export const assigned = new Set();
if (LAB) {
  for (const g of LAB.groups ?? []) {
    const ids = (g.slices ?? []).filter((id) => { if (!byId.has(id)) { warn(`labels.json references unknown slice ${id}`); return false; } if (assigned.has(id)) { warn(`slice ${id} assigned twice; keeping first`); return false; } return true; });
    if (!ids.length) continue;
    const c0 = LEGACY[g.category] ?? g.category;
    const cat = CATS.includes(c0) ? c0 : (warn(`unknown category "${g.category}" on "${g.label}", using other`), "other");
    const G = fresh(String(g.label ?? "").slice(0, 90) || "(unlabelled)", cat, false);
    if (G.label.length > 44) warn(`label is ${G.label.length} characters and will be cut off in the chart (limit 44): "${G.label}"`);
    if (g.theme && String(g.theme).length > 42) warn(`theme is ${String(g.theme).length} characters and will be cut off in the chart (limit 42): "${g.theme}"`);
    G.theme = g.theme ? String(g.theme).slice(0, 90) : null;
    for (const id of ids) { addSlice(G, byId.get(id)); assigned.add(id); }
    for (const p of g.prs ?? []) { if (prs[p]) G.prs.add(p); else if (!NOPR) warn(`labels.json references unknown PR ${p}`); }
    groups.push(G);
  }
}
// rule-based fallback for anything not labelled
export const ruleGroups = new Map();
for (const s of D.slices) {
  if (assigned.has(s.id)) continue;
  const k = s.prs_rule.length ? "pr|" + [...s.prs_rule].sort().join(",") : "slice|" + s.id;
  if (!ruleGroups.has(k)) {
    const label = s.prs_rule.length ? prs[[...s.prs_rule].sort((a, b) => cmp(prs[a].createdAt, prs[b].createdAt))[0]].title + (s.prs_rule.length > 1 ? ` (+${s.prs_rule.length - 1} more PR${s.prs_rule.length > 2 ? "s" : ""})` : "")
      : (s.prompts[0] ?? `Session ${s.id.split("|")[0]} (no human prompt recorded)`);
    ruleGroups.set(k, fresh(label, s.prs_rule.length ? "feature" : "other", true));
  }
  const G = ruleGroups.get(k); addSlice(G, s); for (const p of s.prs_rule) G.prs.add(p);
}
groups.push(...ruleGroups.values());
groups.sort((a, b) => b.out - a.out);
export const claimed = new Set(groups.flatMap((g) => [...g.prs]));
export const unclaimed = Object.keys(prs).filter((p) => !claimed.has(p));

// collapse the long tail of PR-less auto rows so the table stays readable
export const THEMED = groups.some((g) => g.theme);
export let shown;
if (THEMED) {
  // roll the pieces of work up into themes for the ranked table. PR share and the per-PR detail
  // stay at the piece level, so a theme that mixes PR and non-PR work does not inflate "PR work".
  const tm = new Map(); const rest = [];
  // sessions nobody labelled that still opened a PR (dependency bumps, releases): one row, not one theme each
  const smallPr = groups.filter((g) => g.auto && g.prs.size);
  const small = smallPr.length > 2 ? fresh(`Smaller sessions that opened a PR (${smallPr.length})`, "other", true) : null;
  if (small) for (const g of smallPr) { for (const x of g.slices) addSlice(small, x); for (const q of g.prs) small.prs.add(q); }
  for (const g of small ? [...groups.filter((g) => !smallPr.includes(g)), small] : groups) {
    if (g.auto && !g.prs.size) { rest.push(g); continue; }
    const k = g.theme ?? g.label;
    if (!tm.has(k)) { const t = fresh(k, g.category, false); t.parts = 0; t.catOut = {}; t.groups = []; tm.set(k, t); }
    const t = tm.get(k); for (const s of g.slices) addSlice(t, s); for (const p of g.prs) t.prs.add(p);
    t.parts++; t.groups.push(g); t.catOut[g.category] = (t.catOut[g.category] ?? 0) + g.out;
  }
  for (const t of tm.values()) t.category = Object.entries(t.catOut).sort((a, b) => b[1] - a[1])[0][0];
  shown = [...tm.values()];
  if (shown.length > MAX_THEMES) warn(`${shown.length} rows in the ranked table; aim for ${MAX_THEMES} or fewer by giving more groups a shared "theme"`);
  if (rest.length) { const o = fresh(`Other sessions (${rest.length})`, "other", true); for (const g of rest) for (const s of g.slices) addSlice(o, s); shown.push(o); }
} else {
  const TOPN = 10; shown = groups.filter((g) => g.prs.size || !g.auto); const tail = groups.filter((g) => !g.prs.size && g.auto);
  shown = shown.concat(tail.slice(0, Math.max(0, TOPN - shown.filter((g) => !g.prs.size).length)));
  const rest = tail.filter((g) => !shown.includes(g));
  if (rest.length) { const o = fresh(`Other sessions (${rest.length})`, "other", true); for (const g of rest) for (const s of g.slices) addSlice(o, s); shown.push(o); }
}
shown.sort((a, b) => b.out - a.out);

// ---- helpers ----
export const tok = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[c]));
export const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const mc = (g) => Object.entries(g.clients).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "Claude Code";
export const cls = (g) => mc(g) === "Claude Code" ? "s1" : "s2";
export const bar = (v, vmax, c, lbl, title) => `<div class="bar" title="${esc(title)}"><div class="fill ${c}" style="width:${vmax ? Math.max(1.5, Math.round(v / vmax * 7600) / 100) : 1.5}%"></div><span class="val">${lbl}</span></div>`;
export const prtag = (p) => prs[p] ? `${p}${prs[p].state === "MERGED" ? "" : ` (${prs[p].state.toLowerCase()})`}` : p;
export const prlink = (p) => prs[p] ? `<a href="${esc(prs[p].url)}">${esc(prtag(p))}</a>` : esc(p);
export const sortedPrs = (g) => [...g.prs].sort((a, b) => cmp(prs[a].createdAt, prs[b].createdAt));
export const chip = (c) => `<span class="chip">${c}</span>`;

// ---- sections ----
export const T = D.totals; export const prOut = groups.filter((g) => g.prs.size).reduce((s, g) => s + g.out, 0);
export const ccOut = D.slices.filter((s) => s.client === "Claude Code").reduce((s, x) => s + x.tokens.output, 0);
export const pct = (a, b) => Math.round(a / Math.max(b, 1) * 100);
export const f1 = (x) => x.toFixed(1);
export const cut = (t, n) => t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;

// ---- the one chart: themes > pieces of work (bar = output tokens) > the PRs each one touched ----
// solid link = the work opened the PR; dashed link = the PR's link only showed up in the session later
// At most three named rows per theme, and none under 2% of the period's output unless it is the theme's
// largest: the rest fold into one "smaller pieces" row. This is display only; PR share is still per piece.
export const ROWS_PER_THEME = 3, ROW_FLOOR = 0.02;
export const themeRows = (t) => { const all = [...t.groups].sort((x, y) => y.out - x.out);
  const keep = all.filter((g, i) => i === 0 || (i < ROWS_PER_THEME && g.out >= ROW_FLOOR * T.tokens.output)), rest = all.filter((g) => !keep.includes(g));
  if (rest.length < 2) return all;
  const f = fresh(`${rest.length} smaller pieces of work`, "other", false); f.theme = t.label; f.folded = rest.length;
  for (const g of rest) { for (const x of g.slices) addSlice(f, x); for (const q of g.prs) f.prs.add(q); }
  return [...keep, f]; };
export const sections = THEMED ? shown.map((t) => t.groups && !(t.groups.length === 1 && t.groups[0].label === t.label) ? { title: t.label, total: t, rows: themeRows(t) } : { title: null, rows: [t] }) : [{ title: null, rows: shown }];
// label column first: a task name gets about 44 characters before it is cut
export const LABEL_MAX = 44, THEME_MAX = 42;
// three follow-up questions the model wrote from the chart (labels.json "questions"); each is meant to be asked as is
export const QS = (LAB?.questions ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, 3);
if (LAB && (LAB.questions ?? []).length > 3) warn("labels.json has more than three questions; showing the first three");
for (const q of QS) if (!/hypaware/i.test(q)) warn(`question does not mention HypAware, so the agent may not use the recordings: "${q.slice(0, 60)}..."`);
for (const q of QS) if (q.length > 240) warn(`question is ${q.length} characters; keep it under 240: "${q.slice(0, 60)}..."`);
