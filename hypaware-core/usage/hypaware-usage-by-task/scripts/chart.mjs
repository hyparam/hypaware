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
// The PRs go on their own lines under the row, from the bar column, so a row with PRs still fits 80 columns. A line
// holds at most PRS_PER_LINE tags and breaks sooner rather than run past the width; the count of the rest goes last.
const WIDTH = 80, BAR_COL = LABEL_MAX + 4, PRS_PER_LINE = 4;
const prLines = (g) => {
  const ids = sortedPrs(g), more = ids.length > PRS_PER_ROW + 1, rows = [];
  for (const tag of (more ? ids.slice(0, PRS_PER_ROW) : ids).map(prtag).concat(more ? [`+${ids.length - PRS_PER_ROW} more`] : [])) {
    const last = rows.at(-1), fits = last && BAR_COL + [...last, tag].join(", ").length + 1 < WIDTH;
    if (fits && (last.length < PRS_PER_LINE || tag.startsWith("+"))) last.push(tag); else rows.push([tag]);
  }
  return rows.map((r, i) => " ".repeat(BAR_COL) + r.join(", ") + (i < rows.length - 1 ? "," : ""));
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const span = (d) => MONTHS[Number(d.slice(5, 7)) - 1] + " " + Number(d.slice(8, 10));
const lines = ["AI usage by task, " + span(D.window.from) + " to " + span(D.window.to),
  tok(T.tokens.output) + " output tokens, " + T.sessions + " sessions" + (NOPR ? "" : ", " + claimed.size + " PRs tied to sessions,"),
  ...(NOPR ? [] : [pct(prOut, T.tokens.output) + "% of output in work tied to a PR"]),
  "Bar = output tokens."];
for (const sec of sections) {
  lines.push("");
  if (sec.title) lines.push(cut(sec.title, LABEL_MAX + 2).padEnd(LABEL_MAX + 2 + TBAR + 2) + tok(sec.total.out).padStart(5) + "  " + pct(sec.total.out, T.tokens.output) + "%");
  for (const g of sec.rows) lines.push((sec.title ? "  " : "") + cut(g.label, LABEL_MAX).padEnd(LABEL_MAX + (sec.title ? 0 : 2)) + "  " + tbar(g.out) + tok(g.out).padStart(5), ...prLines(g));
}
// Everything printed is the chart. The three questions are offered in a dialog, not here, and PRs no session is
// tied to are its last line, so the caller shows the output whole and trims nothing by hand.
if (unclaimed.length) lines.push("", "PRs with no recorded session: " + prList(unclaimed));
// An empty window is a finding, not a chart: say so in words so nobody reads three header lines as a result.
if (!T.sessions) lines.push("", "No Claude Code or Codex sessions are recorded in this window, so there is nothing to chart.");
console.log(lines.join("\n"));
