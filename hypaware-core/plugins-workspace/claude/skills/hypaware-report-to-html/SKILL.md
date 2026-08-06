---
name: hypaware-report-to-html
description: Render the Markdown HypAware reports under hypaware-reports/ into a static HTML site: enrich the report Markdown with the data-report component vocabulary (metric cards, charts, callouts), run `hyp report render`, and regenerate the top-level landing page. Use when the user says "convert the reports to HTML", "build/render the report site", "rebuild the HTML", "publish the reports", "update the reports landing page / index", or wants to preview or GitHub-Pages the reports. Operates on the ~/hypaware-reports git repo only. Does NOT run any report skill, does NOT touch local HypAware recordings, and does NOT push to the remote unless the user explicitly asks.
---

# Render HypAware reports to HTML

<!-- @ref LLP 0193#gate-moves-to-the-command [implements]: model-invocable on purpose; the control is the confirmation before step 3 edits report sources, not the skill being hard to reach -->

The `~/hypaware-reports/` git repo holds the outputs of the HypAware report skills:
`hypaware-ai-usage-report` (the merged team review, since 2026-07-15 it also carries
the former adoption / spend / improvement content; since 2026-07-16 its ranked changes
live on a `proposed-changes.md` section page and the one-pager's Proposed changes block
is a short pointer to it); archives may hold adoption / spend /
improvement one-pagers from the superseded skills. Each report is a dated one-pager
`<slug>.md` at the top level,
optionally with a sibling `<slug>/` folder of section `.md` files. This skill turns that
Markdown into a browsable static site and keeps the landing page in sync.

Two moving parts:

1. **`hyp report render`** converts each `<slug>.md`, plus any `<slug>/` sections, into a
   self-contained `html/<slug>/` folder, and rewrites inter-file `.md` links to `.html`.
   `html/` is rebuilt fresh every run. A **flat** one-pager (no sibling `<slug>/` dir)
   builds just `html/<slug>/index.html`. You do not need to know how it does any of
   this: it is tested code in the hypaware repo under `src/core/reports/`, and its
   behaviour is not this skill's to describe or re-derive.
2. **The top-level `index.html`** is the landing page linking to each `html/<slug>/`.
   `hyp report render` does **not** generate it: this skill regenerates it from whatever
   reports are present, so it never goes stale.

**The look is carried entirely by `assets/style.css` plus a small raw-HTML component
vocabulary the report Markdown opts into.** The renderer copies that stylesheet into
every built page, so upgrading it restyles the whole site (type, tables, code, callouts,
and the auto-styled hero thesis line) with no Markdown changes. A user's own
`assets/theme.css`, layered after it and never overwritten, is the supported way to
restyle one tree. The metric cards, charts, and callouts are raw `<div>` blocks that the
`gfm` reader passes through untouched; authors add them in the source `.md`. Both are
specified under **Visual system** below.

## Prerequisites

- **pandoc** must be installed (`brew install pandoc`, or
  `sudo apt-get install pandoc`). `hyp report render` names it and exits 1 if missing.
- **A recent `hyp`.** Rendering moved into the CLI; a `hyp` without
  `report render` predates this skill.
- The reports tree, `~/hypaware-reports` by default. `hyp report render <dir>` takes an
  explicit one.

> **Where the renderer lives.** `hyp report render` and this skill's `assets/` are owned
> by the hypaware repo at `src/core/reports/`, with the bundled asset copies here held
> byte-identical to it by a test. Edit the canonical copy, never these. If rendering
> misbehaves, the fix belongs in `src/core/reports/render.js` and its tests, not in
> prose here (LLP 0193, LLP 0194).

## Procedure

Work relative to the repo root `~/hypaware-reports`.

1. **Check the state first.** `cd ~/hypaware-reports`, then `git status` and
   `ls *.md` (excluding `README.md`) so you can see which reports will render and which
   branch you're on. If the top level has **no** `<slug>.md` (only machinery), there's
   nothing to build: stop and tell the user (it was probably just archived; regenerate
   reports first). **If another process may be mid-cycle** (an unexpected fresh
   `archive/<timestamp>/` just appeared, or the tree is churning), pause and confirm with
   the user before building: see Notes.

2. **Assets are the command's job now.** `hyp report render` installs and refreshes the
   base stylesheet and favicons itself. Do not hand-copy them, and do not hand-tune
   per-page CSS: `assets/style.css` is overwritten on every run, so an edit there is
   lost.

   **To restyle a tree, edit `assets/theme.css`.** The command creates it once, never
   touches it again, and links it after the base sheet on every page, so anything set
   there wins. Most restyling is a few custom properties (`--accent`, `--fg`, the
   `--good`/`--warn`/`--crit` judgment colours, the `--s1`..`--s4` chart ramp, the type
   stacks, `--max`); the file ships with them listed. That split is deliberate: the base
   sheet is HypAware's and the theme is the user's, so neither has to guess whether a
   change to the other was a customization or something stale.

3. **Enrich the report Markdown (the step that makes it a data report).**

   ⚠ **Confirm before this step: it edits the user's source files.** Enrichment
   rewrites the report `.md` files in place, which is a source edit, not derived
   output like `html/`. Name the files you would change and get an explicit yes
   before the first edit. This skill is model-invocable, so it can be reached from a
   prompt that never asked for a rewrite; the confirmation, not the invocation, is
   what makes the edit deliberate (@ref LLP 0193#gate-moves-to-the-command). Building
   (step 4), the landing page (step 5), and verification (step 6) touch only generated
   output and need no confirmation; publishing (step 7) has its own.

   For each top-level `<slug>.md`, check whether it already uses the component
   vocabulary:
   ```bash
   grep -L 'class="rec"' *.md           # reports whose findings/changes are still prose-only
   grep -L 'class="metric-grid"' *.md   # reports with no headline metric strip (see below)
   ```
   `rec` entries are required wherever the source carries a findings or changes list. A
   `metric-grid` is required **only where the source has a headline-numbers section**
   (the usage and security reviews' "Key metrics"). **Follow the source's layout,
   enrichment never moves content between pages:**
   - **Usage review, 2026-07-16+ (two-page shape):** the one-pager has a Key metrics
     strip and ONE entry list (Key findings); its **Proposed changes block is a 1-2 line
     pointer** (count + top change + link to the proposed-changes page), leave it as
     prose, never re-inflate the list there. The full ranked list lives on the
     **`proposed-changes.md` section page**, the one section page that carries a
     `rec-list`: each numbered change becomes one `rec` entry (bold what = entry title,
     why-sentence = body, evidence numbers = stat line, and the entry links its
     `change-<slug>.md` artifact page). That page also keeps its opening thesis line.
   - **Usage review, 2026-07-15 (predates the split):** the numbered Proposed changes
     list sits on the one-pager, card it there, after Key findings.
   - **Legacy standalone improvement review:** no metric strip, its change list leads,
     and none is added above or instead of it.
   A one-pager with a metric-grid but no `rec` entries is **half-done, not done**:
   finish the entries rather than skipping it.

   For every report needing work, proceed in **two phases: inventory first, markup
   second**:

   **Phase A: inventory.** Read the whole report (one-pager + all section files) and
   write down, from its text and tables only: (1) the 3–6 headline numbers with a
   judgment for each (crit / warn / good / neutral) and a one-line "why it matters";
   (2) each finding with its 2–3 strongest stats; (3) per section page, the one
   composition, share, or rate that best carries that section's story. Every item must
   quote a number that literally appears in the report. If a section has no strong
   number, it gets **no** visual: leave it prose.

   **Phase B: design, don't convert.** You are producing a designed data report that
   *uses* the Markdown as its content source, not a styled rendering of the document's
   existing structure. Apply the recipe in [`authoring.md`](authoring.md) using ONLY the
   Phase A inventory, with [`example-enrichment.md`](example-enrichment.md) as a *shape*
   reference, and take a designer's liberties:
   - **Restructure within the approved skeleton.** Merge or retitle weak headings inside
     sections, delete decorative `---` rules, but the one-pager's top-level block order
     is **user-approved structure, not scaffolding**: keep the source report's order
     exactly (the merged usage review runs Headline → Key metrics → Key findings →
     Proposed changes → Data limitations → Supporting analysis; since 2026-07-16 the
     Proposed changes block is a short pointer to the proposed-changes section page,
     keep it that size; a legacy improvement review leads with its change list and
     takes no metric strip). Never split a
     change's evidence back out into a separate findings section, and keep the standard
     heading vocabulary (Key metrics / Key findings / Proposed changes / Data
     limitations / Supporting analysis): retitle only headings that aren't part of
     that skeleton.
   - **Rewrite for the surface.** Metric labels, card titles, stat labels, tag words,
     chart titles, and notes are *display copy*: write them fresh (2–4 word labels, one
     plain "so what" note), never paste sentence fragments from the prose. Display copy
     obeys the report-language rules: literal words, no metaphors or coined shorthand
     (write "sessions open across days", never compress to a coinage like "marathon
     sessions"), no pipeline vocabulary, absolute dates. It also keeps the usage
     review's improvement-not-evaluation stance: cards, chart titles, and judgment
     colors attach to patterns and defaults, never to a named person (no "top spender"
     leaderboards, no crit/warn coloring on a person's name), enrichment must not
     re-frame a neutral allocation table into a person-ranking visual. Body
     paragraphs, the analysis itself, stay intact apart from trims where a visual
     now carries the point.
   - **Ready-to-apply artifacts are verbatim.** Proposed diffs, full skill/subagent file
     drafts, tool-description text, and source→destination move tables render as the
     code blocks / tables they are, never trimmed, carded, summarized, or reworded. They
     are the deliverable, not display copy.
   - **Give every headline number the big treatment.** Any number the report leads with
     belongs in a `metric`, `gauge`, `rec-stat`, or chart, large, colored by judgment,
     with a note, not bolded inline in a sentence. After the pass, a number that matters
     should be visible from across the room.
   - Structural moves: subtitle → `eyebrow` above the `# ` title, thesis directly under
     it (triggers the hero); one-pager gets `metric-grid` + `rec` cards + `callout warn`
     for the caveat; each section page opens with its own thesis and gets the inventory
     (3) visual, `barchart` / `stackbar` / `gauge` / `callout`. Keep source data tables
     where the exact numbers are the record.
   - **A one-pager finding never stays heading + paragraph + trailing link.** Every
     numbered finding on the one-pager becomes a `rec` card: its 2–3 strongest numbers
     (from the Phase A inventory) move onto the card's stat row, the analysis trims to
     1–2 sentences of body copy, and the section link becomes the card itself. A
     qualitative finding with no strong numbers still becomes a card: it just carries a
     lighter stat row (or none) rather than invented figures.

   **The design bar:** scroll the finished page, every screenful should have a visual
   anchor (a big number, a chart, a card row, a callout), no two adjacent blocks with the
   same treatment, and nothing that looks like a Markdown table wearing CSS. If a page
   reads top-to-bottom as heading-paragraph-heading-paragraph, it's a conversion, not a
   design: go back.

   ⚠ **The example file is from ONE specific report (the improvement review). Copy its
   markup shapes, never its words**: if a label, stat, card title, tag word, or chart
   caption from the example appears in a different report's enriched output, that's
   contamination, every label and number must trace to the Phase A inventory. Reports
   differ: an adoption profile has different headline numbers, different judgments, and
   maybe no "recommendations" at all, but `rec` cards are the treatment for *findings*
   of any kind, not just recommendations, so a descriptive report's numbered findings
   still become cards; what you don't force is the stat row where no real numbers exist.

   **Hard rules:** every number, claim, and judgment must trace to the report's own text
   or tables, design changes presentation and display copy, it NEVER invents, recomputes,
   or reinterprets a finding; keep every link (cross-page links may move onto cards); keep
   raw-HTML blocks separated by blank lines; skip only files that already satisfy the
   full contract (metric-grid **and** carded findings on a one-pager, thesis + visuals on
   a section page), the presence of one component does not make a file done. These are
   source-file edits: include them in the commit at the end.

4. **Build the HTML.**
   ```bash
   hyp report render                  # defaults to ~/hypaware-reports
   hyp report render <dir>            # or an explicit tree
   ```
   It prints `Built html/ : N report(s) ...`. `html/` is wiped and rebuilt, so deleted or
   renamed reports never leave stale HTML behind, and it refuses without touching
   anything if the tree holds no reports.

   The command owns every mechanical detail that used to be described here: pandoc
   invocation, the Hyperparam masthead and dated doc label, the back-nav chain
   ("&#8592; Back to the report" on a section, "&#8592; All reports" on a one-pager),
   the favicon with its PNG fallback (Safari does not render SVG favicons), the
   "Copy as Markdown" action with its `index.md` / `<section>.md` / `full.md` sidecars,
   and rewriting `.md` links to `.html` on the emitted HTML so Markdown links and
   raw-HTML component links are both caught. None of that is your responsibility, and
   none of it should be re-derived here: it is code, with tests, in
   `src/core/reports/`.

5. **The landing page builds itself.** `hyp report render` regenerates the top-level
   `index.html` from the report set on every run: one card per report newest-first, each
   carrying that report's own headline numbers hoisted from its `metric-grid` with the
   values and crit/warn/good judgments kept exactly, plus a companion card for any report
   with a `proposed-changes.md` page. You do not write it, and hand-edits do not survive.

   Two consequences worth knowing. A report with no `metric-grid` gets a card with no
   figures rather than invented ones, so if a card looks bare the fix is to enrich that
   report in step 3, not to edit the landing page. And the card's stat labels are the
   report's own metric labels verbatim: to change what a card says, change the metric.

6. **Verify what the command cannot.** `hyp report render` already enforces the
   structural contract (every page built, no leftover `.md` links, a copy action and
   back-link on every page, a `full.md` per report) and fails if any of it breaks. What
   is left is the judgment half, which only you can check:
   ```bash
   grep -L 'class="rec"' html/*/index.html   # should print nothing: findings/changes are carded
   grep -c 'rec-stat' index.html             # >= number of reports: landing cards carry stats
   grep -o 'href="html/[^"]*proposed-changes.html"' index.html  # one hit per report with a proposed-changes page
   ```
   A page missing `rec` cards means step 3 was skipped or stopped halfway; a
   `metric-grid` is only expected where the source report has a headline-numbers section
   (do NOT add one to a change-list report to satisfy a check); a landing page without
   `rec-stat`s means step 5 produced a bare link list.
   Optionally open `index.html` (or `html/<slug>/index.html`) in a browser to
   eyeball it (check both light and dark: the stylesheet supports both).

7. **Publish: only when asked.** Publishing is outward-facing (this repo backs a
   **public GitHub Pages** site and holds internal fleet data), so don't push on your own.
   Offer to commit; push **only** on the user's explicit go-ahead. Match the repo's
   manual-commit convention:
   ```bash
   git add -A
   git commit -m "render: enrich markdown + rebuild html + landing page"
   # git push   # ONLY if the user explicitly asks
   ```
   Note the current branch when you offer (the repo uses `main` and `dev`); confirm which
   branch should carry the published site rather than assuming.

## Visual system

The stylesheet in `assets/style.css` is a self-contained **data-report** system with a
restrained, internal-report look: system type, hairline rules, small flat charts, a
semantic `--accent`/`--good`/`--warn`/`--crit` palette reserved for judgment, tabular
figures, dark mode, print. Deliberately absent: webfonts, gradients, card shadows, hover
motion, rounded-card chrome; keep it that way when restyling. **Two things are
automatic**, no author markup: every page's
tables, code, blockquotes, and headings are restyled, and the **first bold paragraph
directly under the `# ` title becomes a hero thesis callout** (`h1 + p`). So write each
report's one-sentence thesis as the first paragraph, bold.

Everything else, metric grids, bar/stacked charts, gauges, callouts, recommendation
cards, the eyebrow kicker, is a small **raw-HTML component vocabulary** the report
Markdown opts into (pandoc `gfm` passes raw HTML through untouched, as long as each block
is surrounded by blank lines). **The full catalog, copy-paste snippets, a "when to use
what" guide, and the landing-page template live in [`components.md`](components.md): read
it when authoring or restyling a report.** Reuse those classes verbatim; never invent new
class names or add per-report CSS.

**The vocabulary reaches the page two ways.** Ideally the report-GENERATING skills author
it directly: [`authoring.md`](authoring.md) is that authoring contract (required
page-opening shape, key-numbers → metric grid, findings → rec cards, one strong visual
per section page, self-check list), and it's worth adding this pointer to each
`hypaware-ai-*-report` skill:

> **Output format:** write the report Markdown following the authoring contract in
> `~/.claude/skills/hypaware-report-to-html/authoring.md` (hero thesis directly under the
> title, `metric-grid` for headline numbers, `rec` cards for findings, one purposeful
> chart/callout per section; component snippets in `components.md` next to it). The HTML
> renderer styles exactly that vocabulary; plain tables render as a plain document.

But **step 3 of this skill is the guarantee**: any report whose Markdown lacks the
vocabulary gets enriched in place before building, so the rendered site comes out right
even when the content skills produced plain Markdown.

## Notes & gotchas

- **This skill reformats and renders: it never generates report findings.** To create or
  refresh the underlying analysis, use the report skills (`hypaware-ai-*-report`). Step 3
  only re-expresses numbers already present in the Markdown as components; it must never
  add, recompute, or reinterpret a number.
- **The visual upgrade is the stylesheet + opt-in components.** An existing report with no
  component markup still looks dramatically better after step 2 (type, tables, code, and
  the auto hero thesis). Charts and metric cards are added report-by-report in the source
  `.md`; they are enrichments, not required.
- **Interplay with archiving.** An archive pass moves the reports **and** the
  built `html/` and `index.html` into `archive/<timestamp>/`, then clears the top level.
  Normal cycle: archive old batch → generate new reports → **run this skill** to rebuild
  `html/` + `index.html` → commit. Don't run this skill *while* an archive is in progress.
- **Flat vs. sectioned reports both work.** The renderer builds a one-pager with no sibling
  `<slug>/` dir as a single `html/<slug>/index.html`; one with sections gets sibling
  `<section>.html` pages plus back-nav.
- **`index.html` is generated: don't hand-edit it and expect edits to survive.**
- **pandoc dialect.** The renderer uses `-f gfm` and sets only `pagetitle` (not `title`).
  `gfm` passes raw HTML blocks through, which is what makes the component vocabulary work:
  leave those flags alone. Keep raw HTML blocks separated from Markdown by blank lines.
- **Fully self-contained.** The stylesheet uses system fonts only: no webfont `@import`,
  no external assets, so pages render identically offline, on GitHub Pages, and from
  `file://`. Don't reintroduce a webfont.
- **Don't `rm` the source Markdown.** The renderer reads the top-level `<slug>.md` +
  `<slug>/` on every run; the HTML under `html/` is derived output.
