---
name: hypaware-report-to-html
description: Render the Markdown HypAware reports under hypaware-reports/ into a static HTML site: enrich the report Markdown with the data-report component vocabulary (metric cards, charts, callouts), run the repo's build.sh (pandoc), and regenerate the top-level landing page. Use when the user says "convert the reports to HTML", "build/render the report site", "rebuild the HTML", "publish the reports", "update the reports landing page / index", or wants to preview or GitHub-Pages the reports. Operates on the ~/hypaware-reports git repo only. Does NOT run any report skill, does NOT touch local HypAware recordings, and does NOT push to the remote unless the user explicitly asks.
---

# Render HypAware reports to HTML

The `~/hypaware-reports/` git repo holds the outputs of the HypAware report skills
(`hypaware-ai-adoption-report`, `-spend-report`, `-security-report`,
`-improvement-report`). Each report is a dated one-pager `<slug>.md` at the top level,
optionally with a sibling `<slug>/` folder of section `.md` files. This skill turns that
Markdown into a browsable static site and keeps the landing page in sync.

Two moving parts:

1. **`build.sh`** (in the repo, pandoc-based) converts each `<slug>.md` — plus any
   `<slug>/` sections — into a self-contained `html/<slug>/` folder: `index.html` for the
   one-pager, one `<section>.html` per section with a "← Back to the report" nav,
   `assets/style.css`, and a `.nojekyll`. It rewrites inter-file `.md` links to `.html`,
   flattens the one-pager's `<slug>/section.md` links to `section.html`, and rebuilds
   `html/` fresh every run (idempotent). A **flat** one-pager (no sibling `<slug>/` dir)
   builds just `html/<slug>/index.html`.
2. **The top-level `index.html`** is the landing page linking to each `html/<slug>/`.
   `build.sh` does **not** generate it — this skill regenerates it from whatever reports
   are present, so it never goes stale.

**The look is carried entirely by `assets/style.css` plus a small raw-HTML component
vocabulary the report Markdown opts into.** `build.sh` copies the repo-root
`assets/style.css` into every built page, so upgrading that one file restyles the whole
site — type, tables, code, callouts, and the auto-styled hero thesis line — with no
Markdown changes. The metric cards, charts, and callouts are raw `<div>` blocks that
pandoc's `gfm` reader passes through untouched; authors add them in the source `.md`.
Both are specified under **Visual system** below.

## Prerequisites

- **pandoc** must be installed (`command -v pandoc`; `brew install pandoc` if missing).
  `build.sh` hard-fails without it.
- Run from the repo root `~/hypaware-reports`. `assets/style.css` must exist and be the
  **canonical data-report stylesheet** shipped with this skill (see step 2 below) — it's
  the shared stylesheet every built page and the landing page reference.

## Procedure

Work relative to the repo root `~/hypaware-reports`.

1. **Check the state first.** `cd ~/hypaware-reports`, then `git status` and
   `ls *.md` (excluding `README.md`) so you can see which reports will render and which
   branch you're on. If the top level has **no** `<slug>.md` (only machinery), there's
   nothing to build — stop and tell the user (it was probably just archived; regenerate
   reports first). **If another process may be mid-cycle** (an unexpected fresh
   `archive/<timestamp>/` just appeared, or the tree is churning), pause and confirm with
   the user before building — see Notes.

2. **Install / refresh the shared stylesheet.** The repo-root `assets/style.css` must be
   the data-report stylesheet bundled with this skill. If it is missing, or is the old
   pandoc-default sheet (no `--display`/`Space Grotesk` variables, no `.metric`/`.callout`/
   `.barchart` rules), copy this skill's `assets/style.css` over it before building:
   ```bash
   cp "$SKILL_DIR/assets/style.css" assets/style.css   # $SKILL_DIR = this skill's folder
   ```
   Leave it in place if it already matches. This single file drives the entire visual
   system; do not hand-tune per-page CSS.

3. **Enrich the report Markdown (the step that makes it a data report).** For each
   top-level `<slug>.md`, check whether it already uses the component vocabulary:
   ```bash
   grep -L 'class="metric-grid"' *.md   # lists reports that still need enrichment
   ```
   For every listed report, work in **two phases — inventory first, markup second**:

   **Phase A — inventory.** Read the whole report (one-pager + all section files) and
   write down, from its text and tables only: (1) the 3–6 headline numbers with a
   judgment for each (crit / warn / good / neutral) and a one-line "why it matters";
   (2) each finding with its 2–3 strongest stats; (3) per section page, the one
   composition, share, or rate that best carries that section's story. Every item must
   quote a number that literally appears in the report. If a section has no strong
   number, it gets **no** visual — leave it prose.

   **Phase B — design, don't convert.** You are producing a designed data report that
   *uses* the Markdown as its content source — not a styled rendering of the document's
   existing structure. Apply the recipe in [`authoring.md`](authoring.md) using ONLY the
   Phase A inventory, with [`example-enrichment.md`](example-enrichment.md) as a *shape*
   reference — and take a designer's liberties:
   - **Restructure freely.** Reorder sections for narrative strength, merge or retitle
     weak headings, delete decorative `---` rules and boilerplate scaffolding
     ("Key numbers", "What this shows" → headings that say something). The document's
     source order is not sacred; its facts are.
   - **Rewrite for the surface.** Metric labels, card titles, stat labels, tag words,
     chart titles, and notes are *display copy* — write them fresh (2–4 word labels, one
     punchy "so what" note), never paste sentence fragments from the prose. Body
     paragraphs — the analysis itself — stay intact apart from trims where a visual now
     carries the point.
   - **Give every headline number the big treatment.** Any number the report leads with
     belongs in a `metric`, `gauge`, `rec-stat`, or chart — large, colored by judgment,
     with a note — not bolded inline in a sentence. After the pass, a number that matters
     should be visible from across the room.
   - Structural moves: subtitle → `eyebrow` above the `# ` title, thesis directly under
     it (triggers the hero); one-pager gets `metric-grid` + `rec` cards + `callout warn`
     for the caveat; each section page opens with its own thesis and gets the inventory
     (3) visual — `barchart` / `stackbar` / `gauge` / `callout`. Keep source data tables
     where the exact numbers are the record.

   **The design bar:** scroll the finished page — every screenful should have a visual
   anchor (a big number, a chart, a card row, a callout), no two adjacent blocks with the
   same treatment, and nothing that looks like a Markdown table wearing CSS. If a page
   reads top-to-bottom as heading-paragraph-heading-paragraph, it's a conversion, not a
   design — go back.

   ⚠ **The example file is from ONE specific report (the improvement review). Copy its
   markup shapes, never its words**: if a label, stat, card title, tag word, or chart
   caption from the example appears in a different report's enriched output, that's
   contamination — every label and number must trace to the Phase A inventory. Reports
   differ: an adoption profile has different headline numbers, different judgments, and
   maybe no "recommendations" at all (then rec cards don't apply — don't force them).

   **Hard rules:** every number, claim, and judgment must trace to the report's own text
   or tables — design changes presentation and display copy, it NEVER invents, recomputes,
   or reinterprets a finding; keep every link (cross-page links may move onto cards); keep
   raw-HTML blocks separated by blank lines; skip files that already contain component
   markup (the step is idempotent). These are source-file edits — include them in the
   commit at the end.

4. **Build the HTML.** Run the repo's own script — don't reimplement pandoc:
   ```bash
   ./build.sh
   ```
   It prints `Built html/ : N report(s) …`. `html/` is wiped and rebuilt, so deleted or
   renamed reports never leave stale HTML behind.

5. **Regenerate the top-level `index.html`.** List every built report and write a fresh
   landing page (template in [`components.md`](components.md) → *Landing-page template*).
   For each `html/<slug>/` (sorted newest-first — slugs are
   `YYYY-MM-DD-…`), pull the display title and a one-line scope from the source `<slug>.md`:
   - **Title** — the first `# ` heading.
   - **Scope/desc** — the report's scope line: the italic `*Source: … · Window: … *` line
     for adoption profiles, or the `## <server> · <window>` subtitle for the others. Trim
     it to a short human phrase.

   Link each report by its explicit `html/<slug>/index.html`, **not** a bare
   `html/<slug>/` directory URL. A trailing-slash directory link relies on server-side
   index resolution: it works on GitHub Pages but silently breaks when the page is opened
   from disk (`file://`). The explicit path works in both.

   List **every** built report, newest first, so nothing is orphaned. Keep the
   internal-data note — it's a standing warning on this repo.

6. **Verify.** Confirm each report built, links resolve, and the enrichment landed:
   ```bash
   ls html/                                   # one dir per report
   grep -o '<title>[^<]*</title>' html/*/index.html
   grep -rlo 'href="[^"]*\.md"' html/ || echo "no leftover .md links ✓"
   grep -L 'metric-grid' html/*/index.html   # should print nothing
   ```
   `href="….md"` in any built page means a link wasn't rewritten — investigate before
   publishing. A page missing `metric-grid` means step 3 was skipped for that report.
   Optionally open `index.html` (or `html/<slug>/index.html`) in a browser to
   eyeball it (check both light and dark — the stylesheet supports both).

7. **Publish — only when asked.** Publishing is outward-facing (this repo backs a
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

The stylesheet in `assets/style.css` is a self-contained **data-report** system (Space
Grotesk headings/numbers, semantic `--accent`/`--good`/`--warn`/`--crit` palette, tabular
figures, dark mode, print). **Two things are automatic**, no author markup: every page's
tables, code, blockquotes, and headings are restyled, and the **first bold paragraph
directly under the `# ` title becomes a hero thesis callout** (`h1 + p`). So write each
report's one-sentence thesis as the first paragraph, bold.

Everything else — metric grids, bar/stacked charts, gauges, callouts, recommendation
cards, the eyebrow kicker — is a small **raw-HTML component vocabulary** the report
Markdown opts into (pandoc `gfm` passes raw HTML through untouched, as long as each block
is surrounded by blank lines). **The full catalog, copy-paste snippets, a "when to use
what" guide, and the landing-page template live in [`components.md`](components.md) — read
it when authoring or restyling a report.** Reuse those classes verbatim; never invent new
class names or add per-report CSS.

**The vocabulary reaches the page two ways.** Ideally the report-GENERATING skills author
it directly — [`authoring.md`](authoring.md) is that authoring contract (required
page-opening shape, key-numbers → metric grid, findings → rec cards, one strong visual
per section page, self-check list), and it's worth adding this pointer to each
`hypaware-ai-*-report` skill:

> **Output format:** write the report Markdown following the authoring contract in
> `~/.claude/skills/hypaware-report-to-html/authoring.md` (hero thesis directly under the
> title, `metric-grid` for headline numbers, `rec` cards for findings, one purposeful
> chart/callout per section — component snippets in `components.md` next to it). The HTML
> renderer styles exactly that vocabulary; plain tables render as a plain document.

But **step 3 of this skill is the guarantee**: any report whose Markdown lacks the
vocabulary gets enriched in place before building, so the rendered site comes out right
even when the content skills produced plain Markdown.

## Notes & gotchas

- **This skill reformats and renders — it never generates report findings.** To create or
  refresh the underlying analysis, use the report skills (`hypaware-ai-*-report`). Step 3
  only re-expresses numbers already present in the Markdown as components; it must never
  add, recompute, or reinterpret a number.
- **The visual upgrade is the stylesheet + opt-in components.** An existing report with no
  component markup still looks dramatically better after step 2 (type, tables, code, and
  the auto hero thesis). Charts and metric cards are added report-by-report in the source
  `.md`; they are enrichments, not required.
- **Interplay with archiving.** `hypaware-archive-reports` moves the reports **and** the
  built `html/` and `index.html` into `archive/<timestamp>/`, then clears the top level.
  Normal cycle: archive old batch → generate new reports → **run this skill** to rebuild
  `html/` + `index.html` → commit. Don't run this skill *while* an archive is in progress.
- **Flat vs. sectioned reports both work.** `build.sh` builds a one-pager with no sibling
  `<slug>/` dir as a single `html/<slug>/index.html`; one with sections gets sibling
  `<section>.html` pages plus back-nav.
- **`index.html` is generated — don't hand-edit it and expect edits to survive.**
- **pandoc dialect.** `build.sh` uses `-f gfm` and sets only `pagetitle` (not `title`).
  `gfm` passes raw HTML blocks through, which is what makes the component vocabulary work —
  leave those flags alone. Keep raw HTML blocks separated from Markdown by blank lines.
- **Fonts need network.** The stylesheet `@import`s Space Grotesk from Google Fonts; it
  degrades to `system-ui` offline. If the Pages site must be fully self-hosted, vendor the
  font into `assets/` and swap the `@import` for a local `@font-face` — otherwise leave it.
- **Don't `rm` the source Markdown.** `build.sh` reads the top-level `<slug>.md` +
  `<slug>/` on every run; the HTML under `html/` is derived output.
