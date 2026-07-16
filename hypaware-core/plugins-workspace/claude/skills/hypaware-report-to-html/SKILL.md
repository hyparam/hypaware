---
name: hypaware-report-to-html
description: Render the Markdown HypAware reports under hypaware-reports/ into a static HTML site: enrich the report Markdown with the data-report component vocabulary (metric cards, charts, callouts), run the repo's build.sh (pandoc), and regenerate the top-level landing page. Use when the user says "convert the reports to HTML", "build/render the report site", "rebuild the HTML", "publish the reports", "update the reports landing page / index", or wants to preview or GitHub-Pages the reports. Operates on the ~/hypaware-reports git repo only. Does NOT run any report skill, does NOT touch local HypAware recordings, and does NOT push to the remote unless the user explicitly asks.
---

# Render HypAware reports to HTML

The `~/hypaware-reports/` git repo holds the outputs of the HypAware report skills:
`hypaware-ai-usage-report` (the merged team review — since 2026-07-15 it also carries
the former adoption / spend / improvement content; since 2026-07-16 its ranked changes
live on a `proposed-changes.md` section page and the one-pager's Proposed changes block
is a short pointer to it) and `hypaware-ai-security-report`; archives may hold adoption / spend /
improvement one-pagers from the superseded skills. Each report is a dated one-pager
`<slug>.md` at the top level,
optionally with a sibling `<slug>/` folder of section `.md` files. This skill turns that
Markdown into a browsable static site and keeps the landing page in sync.

Two moving parts:

1. **`build.sh`** (in the repo, pandoc-based) converts each `<slug>.md` — plus any
   `<slug>/` sections — into a self-contained `html/<slug>/` folder: `index.html` for the
   one-pager with a "← All reports" nav back to the top-level landing page
   (`../../index.html`), one `<section>.html` per section with a "← Back to the report"
   nav, `assets/style.css`, and a `.nojekyll`. It rewrites inter-file `.md` links to `.html`
   on the **emitted HTML** (`href` attributes), which catches Markdown-syntax links and
   links inside raw-HTML components (`rec` cards, callouts) in one pass: it flattens the
   one-pager's `<slug>/section.md` links to `section.html` and maps cross-report links
   (`../<other-slug>.md` → `../<other-slug>/index.html`, `../<other-slug>/sec.md` →
   `../<other-slug>/sec.html`). `html/` is rebuilt fresh every run (idempotent). A
   **flat** one-pager (no sibling `<slug>/` dir) builds just `html/<slug>/index.html`.
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
   the data-report stylesheet bundled with this skill. If it is missing, or is an older
   sheet (a Google Fonts `@import`, `box-shadow` on cards, or no `.metric`/`.callout`/
   `.barchart` rules), copy this skill's `assets/style.css` over it before building:
   ```bash
   cp "$SKILL_DIR/assets/style.css" assets/style.css   # $SKILL_DIR = this skill's folder
   ```
   Leave it in place if it already matches. This single file drives the entire visual
   system; do not hand-tune per-page CSS.

3. **Enrich the report Markdown (the step that makes it a data report).** For each
   top-level `<slug>.md`, check whether it already uses the component vocabulary:
   ```bash
   grep -L 'class="rec"' *.md           # reports whose findings/changes are still prose-only
   grep -L 'class="metric-grid"' *.md   # reports with no headline metric strip (see below)
   ```
   `rec` entries are required wherever the source carries a findings or changes list. A
   `metric-grid` is required **only where the source has a headline-numbers section**
   (the usage and security reviews' "Key metrics"). **Follow the source's layout —
   enrichment never moves content between pages:**
   - **Usage review, 2026-07-16+ (two-page shape):** the one-pager has a Key metrics
     strip and ONE entry list (Key findings); its **Proposed changes block is a 1-2 line
     pointer** (count + top change + link to the proposed-changes page) — leave it as
     prose, never re-inflate the list there. The full ranked list lives on the
     **`proposed-changes.md` section page** — the one section page that carries a
     `rec-list`: each numbered change becomes one `rec` entry (bold what = entry title,
     why-sentence = body, evidence numbers = stat line, and the entry links its
     `change-<slug>.md` artifact page). That page also keeps its opening thesis line.
   - **Usage review, 2026-07-15 (predates the split):** the numbered Proposed changes
     list sits on the one-pager — card it there, after Key findings.
   - **Legacy standalone improvement review:** no metric strip — its change list leads,
     and none is added above or instead of it.
   A one-pager with a metric-grid but no `rec` entries is **half-done, not done** —
   finish the entries rather than skipping it.

   For every report needing work, proceed in **two phases — inventory first, markup
   second**:

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
   - **Restructure within the approved skeleton.** Merge or retitle weak headings inside
     sections, delete decorative `---` rules — but the one-pager's top-level block order
     is **user-approved structure, not scaffolding**: keep the source report's order
     exactly (the merged usage review runs Headline → Key metrics → Key findings →
     Proposed changes → Data limitations → Supporting analysis; since 2026-07-16 the
     Proposed changes block is a short pointer to the proposed-changes section page —
     keep it that size; a legacy improvement review leads with its change list and
     takes no metric strip). Never split a
     change's evidence back out into a separate findings section, and keep the standard
     heading vocabulary (Key metrics / Key findings / Proposed changes / Data
     limitations / Supporting analysis) — retitle only headings that aren't part of
     that skeleton.
   - **Rewrite for the surface.** Metric labels, card titles, stat labels, tag words,
     chart titles, and notes are *display copy* — write them fresh (2–4 word labels, one
     plain "so what" note), never paste sentence fragments from the prose. Display copy
     obeys the report-language rules: literal words, no metaphors or coined shorthand
     (write "sessions open across days", never compress to a coinage like "marathon
     sessions"), no pipeline vocabulary, absolute dates. It also keeps the usage
     review's improvement-not-evaluation stance: cards, chart titles, and judgment
     colors attach to patterns and defaults, never to a named person (no "top spender"
     leaderboards, no crit/warn coloring on a person's name) — enrichment must not
     re-frame a neutral allocation table into a person-ranking visual. Body
     paragraphs — the analysis itself — stay intact apart from trims where a visual
     now carries the point.
   - **Ready-to-apply artifacts are verbatim.** Proposed diffs, full skill/subagent file
     drafts, tool-description text, and source→destination move tables render as the
     code blocks / tables they are — never trimmed, carded, summarized, or reworded. They
     are the deliverable, not display copy.
   - **Give every headline number the big treatment.** Any number the report leads with
     belongs in a `metric`, `gauge`, `rec-stat`, or chart — large, colored by judgment,
     with a note — not bolded inline in a sentence. After the pass, a number that matters
     should be visible from across the room.
   - Structural moves: subtitle → `eyebrow` above the `# ` title, thesis directly under
     it (triggers the hero); one-pager gets `metric-grid` + `rec` cards + `callout warn`
     for the caveat; each section page opens with its own thesis and gets the inventory
     (3) visual — `barchart` / `stackbar` / `gauge` / `callout`. Keep source data tables
     where the exact numbers are the record.
   - **A one-pager finding never stays heading + paragraph + trailing link.** Every
     numbered finding on the one-pager becomes a `rec` card: its 2–3 strongest numbers
     (from the Phase A inventory) move onto the card's stat row, the analysis trims to
     1–2 sentences of body copy, and the section link becomes the card itself. A
     qualitative finding with no strong numbers still becomes a card — it just carries a
     lighter stat row (or none) rather than invented figures.

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
   maybe no "recommendations" at all — but `rec` cards are the treatment for *findings*
   of any kind, not just recommendations, so a descriptive report's numbered findings
   still become cards; what you don't force is the stat row where no real numbers exist.

   **Hard rules:** every number, claim, and judgment must trace to the report's own text
   or tables — design changes presentation and display copy, it NEVER invents, recomputes,
   or reinterprets a finding; keep every link (cross-page links may move onto cards); keep
   raw-HTML blocks separated by blank lines; skip only files that already satisfy the
   full contract (metric-grid **and** carded findings on a one-pager, thesis + visuals on
   a section page) — the presence of one component does not make a file done. These are
   source-file edits — include them in the commit at the end.

4. **Build the HTML.** Run the repo's own script — don't reimplement pandoc:
   ```bash
   ./build.sh
   ```
   It prints `Built html/ : N report(s) …`. `html/` is wiped and rebuilt, so deleted or
   renamed reports never leave stale HTML behind.

   **Every report page must carry the Hyperparam masthead and a way back to the landing
   page.** `build.sh` is responsible for both: it prepends a `masthead` header (brand
   mark + "Hyperparam" + a doc label — "Internal report · generated <date> from HypAware
   data", the date from the slug — + the back-nav) to every page before
   pandoc runs, passes `-H assets/head.html` (the favicon `<link>`), and copies
   `assets/favicon.svg` (the hyperparam.app mark; the in-page `brand-mark` renders it
   ink-colored via CSS mask) into each output's `assets/`. If the repo's `build.sh`
   predates this (no `masthead` string in it — `grep -q masthead build.sh`), add the
   injection where each page is built, then re-run it:
   ```bash
   masthead() { # $1 = nav html for the right-hand slot, $2 = doc label
     printf '<header class="masthead">\n<span class="brand"><span class="brand-mark"></span>Hyperparam</span>\n<span class="doc-label">%s</span>\n<nav class="topnav">%s</nav>\n</header>\n\n' "$2" "$1"
   }
   doc_label() { # $1 = slug — says the page is a generated static report, not the HypAware app
     case "$1" in
       [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*) printf 'Internal report · generated %s from HypAware data' "${1:0:10}" ;;
       *) printf 'Internal report · generated from HypAware data' ;;
     esac
   }
   {
     masthead '<a href="../../index.html">&#8592; All reports</a>' "$(doc_label "$slug")"   # sections: 'index.html' / 'Back to the report'
     cat "$src"
   } | pandoc -f gfm -t html5 -s \
     --css assets/style.css \
     -H assets/head.html \
     --metadata pagetitle="$(page_title "$src" "$slug")" \
     -o "$out/index.html"
   ```
   (i.e. pipe the masthead + source into pandoc instead of passing `"$src"` as the input
   file; `assets/head.html` is two `<link rel="icon">` lines — the SVG
   (`type="image/svg+xml"`) plus a **PNG fallback** (`type="image/png" sizes="64x64"
   href="assets/favicon.png"`), because **Safari doesn't render SVG favicons** — and
   build.sh regenerates it if missing. build.sh copies both `favicon.svg` and
   `favicon.png` into each output's `assets/`, and regenerates the PNG if absent:
   `sips -s format png -z 64 64 assets/favicon.svg --out assets/favicon.png`. If
   `assets/favicon.svg` is missing, restore it from this skill's `assets/` — prefer that
   over re-downloading `https://hyperparam.app/favicon.svg`: the site's SVG is filled
   solid white (`fill="#fff"`, invisible on a light browser tab); the skill's copy
   replaces that with an embedded theme-aware style
   (`path{fill:#33465c}` + `@media (prefers-color-scheme:dark){path{fill:#aec2d6}}` —
   the stylesheet's slate ink values). If you must re-download, re-apply that edit and
   regenerate the PNG. The in-page `brand-mark` is unaffected either way — CSS masks it
   to the page's ink color. Don't expect a favicon at all on pages opened via `file://`:
   Chrome doesn't load favicons from local files — check on the served site or a local
   `python3 -m http.server`.) Section pages chain back:
   "← Back to the report" → one-pager → "← All reports" → landing page. The masthead
   goes in **build.sh, not the source `.md`** — the Markdown must stay renderer-agnostic.

   **Every page also carries a "Copy … as Markdown" masthead action** (user request
   2026-07-16: readers paste reports into an agent). build.sh implements it:
   - It copies each page's raw Markdown next to the built HTML — `index.md` (the
     one-pager), one `<section>.md` per section — and concatenates `full.md` (one-pager
     + every section, `---`-separated, file order). These raw files keep their `.md`
     links untouched (they're source for agents, `rewrite_hrefs` never touches them).
   - It writes `assets/copy-md.js` if missing (fetch the `data-src` file → clipboard;
     button text flips to "Copied" for 1.5s; on any failure — e.g. `file://`, where
     fetch is blocked — it falls back to navigating to the raw `.md`), copies it into
     each output's `assets/`, and `assets/head.html` gains a third line:
     `<script defer src="assets/copy-md.js"></script>`. The script MUST use the
     `ClipboardItem`-with-a-promise pattern (`navigator.clipboard.write([new
     ClipboardItem({'text/plain': fetchPromise.then(t => new Blob([t]))})])`), with
     plain `writeText` only as a secondary attempt: Safari revokes the click's
     clipboard permission across an `await`, so fetch-then-`writeText` silently drops
     to the open-the-raw-md fallback on Safari.
   - The masthead nav gets the button after the back link: the one-pager's is
     `<a href="#" class="copy-md" data-src="full.md">Copy report as Markdown</a>`,
     each section page's is the same with `data-src="<section>.md"` and the label
     "Copy page as Markdown". **`data-src`, never `href`** — `rewrite_hrefs` and the
     leftover-`.md` check must not see these as document links.
   If the repo's build.sh predates this (`grep -q copy-md build.sh` fails), add the
   three pieces above and re-run. Canonical copies of `copy-md.js` and `head.html` ship
   in this skill's `assets/` — restore from there rather than re-deriving the script
   from this description.

5. **Regenerate the top-level `index.html` as an at-a-glance dashboard, not a table of
   contents.** Write a fresh landing page (template in [`components.md`](components.md) →
   *Landing-page template*). One card per built report, newest first (slugs are
   `YYYY-MM-DD-…`), and each card carries the report's own headline numbers instead of a
   summary sentence. For each `html/<slug>/`, pull from the source `<slug>.md`:
   - **Title** - the first `# ` heading.
   - **Kicker** - the report's scope line (the italic `*Source: … · Window: … *` line for
     adoption profiles, or the `## <server> · <window>` subtitle for the others), trimmed
     to a short phrase, as the card's `rec-kind` eyebrow.
   - **Stats** - the report's top 3-4 headline numbers as `rec-stat`s on the card: from
     its `metric-grid` tiles where it has one, otherwise (legacy change-list reports
     like the standalone improvement review) from the `rec` cards' stat rows — same values, same
     crit/warn/good judgments, labels compressed to 2-4 plain words (no coined
     shorthand), notes dropped. Rules in components.md. This hoists each report's key
     results and progress onto the landing page, so a reader gets the fleet's state
     without opening a report.

   **Proposed-changes companion card** (user decision 2026-07-16): when a report has a
   `<slug>/proposed-changes.md` section page, the landing page gets a **second card
   directly below that report's card**, linking `html/<slug>/proposed-changes.html` —
   the ranked changes are a first-class landing-page destination, not reachable only
   through the report. Title "Proposed changes"; kicker = the report's scope phrase with
   `· ranked changes` appended; stats = the change count (from the page's thesis) plus
   that page's 2-3 strongest stat-row figures hoisted from its `rec` cards — same
   values, same judgments, labels compressed to 2-4 plain words; `rec-go` reads
   "open changes →". Snippet in components.md.

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
   grep -rlo --include='*.html' 'href="[^"]*\.md"' html/ || echo "no leftover .md links ✓"
   # (--include='*.html' matters: the raw index.md/full.md/<section>.md shipped next to
   # each page keep their .md links on purpose — only built pages must be clean)
   grep -L 'class="copy-md"' html/*/*.html    # should print nothing: every page has its copy action
   ls html/*/full.md                          # one per report: the copy-report payload exists
   grep -L 'class="rec"' html/*/index.html   # should print nothing: findings/changes are carded
   grep -c 'rec-stat' index.html             # ≥ number of reports: landing cards carry stats
   grep -L 'All reports' html/*/index.html   # should print nothing: every report links back
   grep -o 'href="html/[^"]*proposed-changes.html"' index.html  # one hit per report that has a proposed-changes page
   ```
   `href="….md"` in any built page means a link wasn't rewritten — remember links live
   both in Markdown syntax **and** inside raw-HTML components (`rec` card and callout
   `href`s), and may point across reports; investigate before publishing. A page missing
   `rec` cards means step 3 was skipped or stopped halfway; a `metric-grid` is only
   expected where the source report has a headline-numbers section (do NOT add one to a
   change-list report to satisfy a check); a landing page without `rec-stat`s means
   step 5 produced a bare link list.
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

The stylesheet in `assets/style.css` is a self-contained **data-report** system with a
restrained, internal-report look: system type, hairline rules, small flat charts, a
semantic `--accent`/`--good`/`--warn`/`--crit` palette reserved for judgment, tabular
figures, dark mode, print. Deliberately absent: webfonts, gradients, card shadows, hover
motion, rounded-card chrome; keep it that way when restyling. **Two things are
automatic**, no author markup: every page's
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
- **Fully self-contained.** The stylesheet uses system fonts only: no webfont `@import`,
  no external assets, so pages render identically offline, on GitHub Pages, and from
  `file://`. Don't reintroduce a webfont.
- **Don't `rm` the source Markdown.** `build.sh` reads the top-level `<slug>.md` +
  `<slug>/` on every run; the HTML under `html/` is derived output.
