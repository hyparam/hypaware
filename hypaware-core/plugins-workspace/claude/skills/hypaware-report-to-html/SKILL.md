---
name: hypaware-report-to-html
description: Render the Markdown HypAware reports under hypaware-reports/ into a static HTML site: enrich the report Markdown with the data-report component vocabulary (metric cards, charts, callouts), run `hyp report render`, and regenerate the top-level landing page. Use when the user says "convert the reports to HTML", "build/render the report site", "rebuild the HTML", "publish the reports", "update the reports landing page / index", or wants to preview or GitHub-Pages the reports. Operates on the ~/hypaware-reports git repo only. Does NOT run any report skill, does NOT touch local HypAware recordings, and does NOT push to the remote unless the user explicitly asks.
---

# Render HypAware reports to HTML

<!-- @ref LLP 0193#gate-moves-to-the-command [implements]: model-invocable on purpose; the control is the confirmation before step 3 edits report sources, not the skill being hard to reach -->
<!-- @ref LLP 0193#constraints-not-layout [constrained-by]: this skill carries the judgment half of rendering; every mechanical step is `hyp report render` -->

`~/hypaware-reports/` holds the outputs of the report skills: a dated one-pager
`<slug>.md` per report, optionally with a sibling `<slug>/` folder of section files.

**`hyp report render` does the rendering.** It builds `html/<slug>/` for every report,
rewrites `.md` links to `.html`, installs assets, and regenerates the top-level
`index.html` landing page from the reports themselves. It is tested code in the hypaware
repo (`src/core/reports/`), not something to describe or re-derive here. If rendering
misbehaves, the fix belongs there.

**Your job is the half a command cannot do: deciding what the pages should say.** A
report written as plain prose renders as a plain document. Enrichment turns it into a
data report by expressing the numbers it already contains as components. That is
judgment, and it is what this skill is for.

## Prerequisites

- **pandoc** (`brew install pandoc`, or `sudo apt-get install pandoc`).
- **A `hyp` with `report render`.** An older one predates this skill.

## Procedure

1. **Check the state first.** `cd ~/hypaware-reports`, then `git status` and `ls *.md`
   (excluding `README.md`) so you can see which reports will render and which branch you
   are on. If there is no top-level `<slug>.md`, there is nothing to build: stop and say
   so (the reports were probably just archived; regenerate them first). If another
   process may be mid-cycle (a fresh `archive/<timestamp>/` just appeared, the tree is
   churning), pause and confirm before building.

2. **Restyling is `assets/theme.css`.** The command owns `assets/style.css` and
   overwrites it every run, so edits there are lost. `theme.css` is the user's: created
   once, never touched again, linked after the base sheet on every page. Most restyling
   is a few custom properties (`--accent`, `--fg`, the `--good`/`--warn`/`--crit`
   judgment colours, the `--s1`..`--s4` chart ramp, the type stacks, `--max`), and the
   file ships with them listed. Never hand-tune per-page CSS.

3. **Enrich the report Markdown. This is the whole skill.**

   ⚠ **Confirm first: it edits the user's source files.** Enrichment rewrites the report
   `.md` files in place, which is a source edit, not derived output like `html/`. Name
   the files you would change and get an explicit yes before the first edit. This skill
   is model-invocable, so it can be reached from a prompt that never asked for a
   rewrite; the confirmation, not the invocation, is what makes the edit deliberate.
   Steps 4 to 6 touch only generated output and need no confirmation; step 7 has its own.

   Find what needs work:
   ```bash
   grep -L 'class="rec"' *.md           # findings/changes still prose-only
   grep -L 'class="metric-grid"' *.md   # no headline metric strip
   ```
   `rec` entries belong wherever a report carries a findings or changes list. A
   `metric-grid` belongs **only where the report has a headline-numbers section**: never
   add one to a report that does not, just to satisfy a check. A one-pager with a
   metric-grid but no `rec` entries is half-done, not done.

   **Follow the source's own layout.** Its block order is user-approved structure, not
   scaffolding: keep it exactly, and never move content between pages (never re-inflate
   a one-pager's pointer into the full list it points at, never split a change's
   evidence back out into a separate section). Standard heading vocabulary stays as it
   is; retitle only headings outside it. The per-report shapes and the component recipe
   are in [`authoring.md`](authoring.md).

   Work in **two phases, inventory before markup**:

   **Phase A: inventory.** Read the whole report (one-pager plus every section) and
   write down, from its text and tables only: (1) the 3-6 headline numbers, each with a
   judgment (crit / warn / good / neutral) and a one-line "why it matters"; (2) each
   finding with its 2-3 strongest stats; (3) per section page, the one composition,
   share, or rate that best carries that section's story. Every item must quote a number
   that literally appears in the report. A section with no strong number gets **no**
   visual: leave it prose.

   **Phase B: design, do not convert.** You are producing a designed data report that
   *uses* the Markdown as its source, not a styled rendering of the document's existing
   structure. Use ONLY the Phase A inventory, with
   [`example-enrichment.md`](example-enrichment.md) as a *shape* reference, and take a
   designer's liberties:

   - **Give every headline number the big treatment.** Any number the report leads with
     belongs in a `metric`, `gauge`, `rec-stat`, or chart: large, coloured by judgment,
     with a note. Not bolded inline in a sentence. After the pass, a number that matters
     should be visible from across the room.
   - **A finding never stays heading + paragraph + trailing link.** Every numbered
     finding on the one-pager becomes a `rec` card: its 2-3 strongest numbers move to
     the card's stat row, the analysis trims to 1-2 sentences, and the section link
     becomes the card itself. A qualitative finding still becomes a card, with a lighter
     stat row or none, rather than invented figures.
   - **Rewrite for the surface.** Metric labels, card titles, stat labels, tag words,
     chart titles, and notes are *display copy*: write them fresh (2-4 word labels, one
     plain "so what" note), never paste sentence fragments from the prose. Display copy
     obeys the report's own language rules: literal words, no metaphors or coined
     shorthand, no pipeline vocabulary, absolute dates. Body paragraphs stay intact apart
     from trims where a visual now carries the point.
   - **Judgment attaches to patterns, never to people.** Cards, chart titles, and
     crit/warn/good colouring describe defaults and workflows. Never colour a person's
     name, never build a leaderboard, and never re-frame a neutral allocation table into
     a person-ranking visual.
   - **Ready-to-apply artifacts are verbatim.** Proposed diffs, full skill or subagent
     files, tool-description text, and source-to-destination move tables render as the
     code blocks and tables they are. Never trimmed, carded, summarised, or reworded:
     they are the deliverable, not display copy.
   - Structural moves: subtitle becomes an `eyebrow` above the `# ` title, thesis
     directly under it (this triggers the hero); the one-pager gets `metric-grid` plus
     `rec` cards plus a `callout warn` for the caveat; each section page opens with its
     own thesis and carries its inventory (3) visual. Keep source data tables where the
     exact numbers are the record.

   **The design bar:** scroll the finished page. Every screenful should have a visual
   anchor, no two adjacent blocks should share a treatment, and nothing should look like
   a Markdown table wearing CSS. If it reads heading-paragraph-heading-paragraph, it is
   a conversion, not a design: go back.

   ⚠ **`example-enrichment.md` is from ONE specific report. Copy its markup shapes,
   never its words.** A label, stat, card title, tag word, or chart caption from the
   example appearing in a different report's output is contamination: every label and
   number must trace to that report's own Phase A inventory. Reports differ, and a
   descriptive report with no recommendations still gets `rec` cards for its findings,
   because that is the treatment for findings of any kind.

   **Hard rules.** Every number, claim, and judgment traces to the report's own text or
   tables. Design changes presentation and display copy; it NEVER invents, recomputes, or
   reinterprets a finding. Keep every link (cross-page links may move onto cards). Keep
   raw-HTML blocks separated by blank lines. Skip only files that already satisfy the
   full contract; the presence of one component does not make a file done. These are
   source-file edits: include them in the commit at the end.

4. **Build.**
   ```bash
   hyp report render                  # defaults to ~/hypaware-reports
   hyp report render <dir>            # or an explicit tree
   ```
   It prints `Built html/ : N report(s) ...`. `html/` is wiped and rebuilt, so deleted or
   renamed reports leave no stale HTML, and it refuses without touching anything if the
   tree holds no reports.

5. **The landing page builds itself.** The same command regenerates `index.html`: one
   card per report newest-first, each carrying that report's headline numbers hoisted
   from its `metric-grid` with values and judgments kept exactly, plus a companion card
   for any report with a `proposed-changes.md` page. Hand-edits do not survive. A report
   with no `metric-grid` gets a card with no figures rather than invented ones, so a bare
   card means that report needs enriching in step 3. Card stat labels are the report's
   own metric labels verbatim: to change what a card says, change the metric.

6. **Verify what the command cannot.** The renderer already enforces the structural
   contract (every page built, no leftover `.md` links, a copy action and back-link on
   every page, a `full.md` per report) and fails if any of it breaks. What is left is
   the judgment half:
   ```bash
   grep -L 'class="rec"' html/*/index.html   # nothing: findings/changes are carded
   grep -c 'rec-stat' index.html             # >= number of reports: cards carry stats
   ```
   A page missing `rec` cards means step 3 was skipped or stopped halfway. A landing page
   without `rec-stat`s means the reports have no metric grids to hoist from. Optionally
   open `index.html` in a browser and check both light and dark.

7. **Publish: only when asked.** This repo backs a **public GitHub Pages** site and holds
   internal fleet data, so do not push on your own. Offer to commit; push **only** on an
   explicit go-ahead, and confirm which branch should carry the published site rather
   than assuming.
   ```bash
   git add -A
   git commit -m "render: enrich markdown + rebuild html + landing page"
   # git push   # ONLY if the user explicitly asks
   ```

## The component vocabulary

**Two things are automatic**, with no author markup: every page's tables, code,
blockquotes, and headings are styled, and the **first bold paragraph directly under the
`# ` title becomes a hero thesis**. So write each report's one-sentence thesis as the
first paragraph, bold.

Everything else (metric grids, bar and stacked charts, gauges, callouts, `rec` cards, the
eyebrow kicker) is a small raw-HTML vocabulary the Markdown opts into, and each block
must be surrounded by blank lines. **The full catalog, copy-paste snippets, and a "when
to use what" guide are in [`components.md`](components.md).** Reuse those classes
verbatim; never invent class names or add per-report CSS.

The look is deliberately restrained: system type, hairline rules, small flat charts, a
`--accent`/`--good`/`--warn`/`--crit` palette reserved for judgment, dark mode, print. No
webfonts, gradients, card shadows, or hover motion, and pages are fully self-contained so
they render identically offline, on GitHub Pages, and from `file://`.

**The generating skills should author this vocabulary directly**, per
[`authoring.md`](authoring.md), so enrichment has less to do. Step 3 is the guarantee
that a report still comes out right when they did not.

## Notes

- **This skill never generates findings.** To create or refresh the analysis, use the
  report skills. Step 3 only re-expresses numbers already in the Markdown.
- **Interplay with archiving.** An archive pass moves the reports, `html/`, and
  `index.html` into `archive/<timestamp>/` and clears the top level. Normal cycle:
  archive, generate new reports, render, commit. Do not render mid-archive.
- **`index.html` and `html/` are generated.** Do not hand-edit them and expect the edits
  to survive. The source `.md` files are the record: never `rm` them.
