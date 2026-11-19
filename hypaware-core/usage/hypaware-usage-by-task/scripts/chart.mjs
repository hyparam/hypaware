#!/usr/bin/env node
// Print the usage-by-task chart as text for the chat: digest.json (+ optional labels.json) -> stdout. Writes no files.
// usage: node chart.mjs --digest digest.json [--labels labels.json]
import { argv, opt, D, LAB, warn, CATS, LEGACY, MAX_THEMES, byId, NOPR, prs, fresh, addSlice, groups, assigned, ruleGroups, claimed, unclaimed, THEMED, shown, tok, esc, fmt, mc, cls, bar, prtag, prlink, sortedPrs, chip, T, prOut, ccOut, pct, f1, cut, ROWS_PER_THEME, themeRows, sections, LABEL_MAX, QS, ROW_FLOOR, THEME_MAX } from "./model.mjs";

// ---- the same chart as text, for the chat: themes, the pieces of work under each (bar = output tokens), their PRs ----
// Printed to stdout so the agent can show it in the terminal; the person need not open the page to see the shape of the week.
const TBAR = 16, tmax = Math.max(1, ...sections.flatMap((s) => s.rows).map((g) => g.out));
const tbar = (v) => { const n = Math.max(1, Math.round(v / tmax * TBAR)); return "█".repeat(n) + " ".repeat(TBAR - n); };
// A row names its first few PRs and counts the rest: a piece of work with seventeen PRs otherwise runs off the terminal.
const PRS_PER_ROW = 4;
const prList = (ids) => ids.length <= PRS_PER_ROW + 1 ? ids.map(prtag).join(", ") : ids.slice(0, PRS_PER_ROW).map(prtag).join(", ") + `, +${ids.length - PRS_PER_ROW} more`;
const tprs = (g) => g.prs.size ? "  " + prList(sortedPrs(g)) : "";
const span = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const lines = ["AI usage by task, " + span(D.window.from) + " to " + span(D.window.to),
  tok(T.tokens.output) + " output tokens, " + T.sessions + " sessions" + (NOPR ? "" : ", " + claimed.size + " PRs tied to sessions, " + pct(prOut, T.tokens.output) + "% of output in PR work"),
  "Bar = output tokens."];
for (const sec of sections) {
  lines.push("");
  if (sec.title) lines.push(cut(sec.title, LABEL_MAX + 2).padEnd(LABEL_MAX + 2 + TBAR + 2) + tok(sec.total.out).padStart(5) + "  " + pct(sec.total.out, T.tokens.output) + "%");
  for (const g of sec.rows) lines.push((sec.title ? "  " : "") + cut(g.label, LABEL_MAX).padEnd(LABEL_MAX + (sec.title ? 0 : 2)) + "  " + tbar(g.out) + tok(g.out).padStart(5) + tprs(g));
}
// Everything printed is the chart. The three questions are offered in a dialog, not here, and PRs no session is
// tied to are its last line, so the caller shows the output whole and trims nothing by hand.
if (unclaimed.length) lines.push("", "PRs with no recorded session: " + prList(unclaimed));
// An empty window is a finding, not a chart: say so in words so nobody reads three header lines as a result.
if (!T.sessions) lines.push("", "No Claude Code or Codex sessions are recorded in this window, so there is nothing to chart.");
console.log(lines.join("\n"));
