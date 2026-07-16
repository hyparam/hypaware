# Visual system & component vocabulary

Reference for `hypaware-report-to-html`. The look of every rendered report is carried by
`assets/style.css` (a self-contained **data-report** system: system type, hairline rules,
ink-first color, tabular figures, `prefers-color-scheme` dark mode, and a print
stylesheet) plus the raw-HTML components below. No build-time tokens — just reference
the stylesheet.

**Branding:** every page opens with the `masthead` letterhead — the Hyperparam mark
(`brand-mark`, the hyperparam.app favicon rendered ink-colored via CSS mask), the
wordmark, and a `doc-label` saying what the document is and that it is generated
("Internal report · generated <report date> from HypAware data" on report pages,
"Internal reports · generated from HypAware data" on the landing page — the "generated
… from" wording is deliberate: it stops readers mistaking the pages for the HypAware
product interface). `build.sh` injects it on report pages; the landing template below
carries its own. It exists so a page is recognizably a Hyperparam internal report
rather than a generic dashboard or app — keep it to that one quiet row, never a logo
hero.

**Color discipline (user requirement 2026-07-16 — color only for a reason, never
decoration):** the page is ink and hairlines; links are ink with an underline (color
never signals "clickable"). `--good`/`--warn`/`--crit` are judgment colors — they appear
ONLY where a number or aside carries that judgment, never for identity, emphasis, or
variety. Chart identity (who/what a segment or bar is) uses the slate ramp
`--s1`..`--s4` (dark → light, assign in share order); in-bar text is legal only on
`--s1`/`--s2` segments (the darker two — lighter steps fail text contrast), everything
else is named in the legend. A judgment color may recolor a single bar/segment only
when the chart's point IS that judgment.

The register is a professional internal report, not a product page: color appears on
numbers, text, and thin rules rather than tinted backgrounds; charts are flat; there are
no webfonts, gradients, shadows, or hover animations. Since the 2026-07-16 restyle the
sheet is deliberately **list-like, dense**: key figures render as ruled label · value ·
note rows (values at text size, never poster numerals) and findings render as numbered
list entries, not tiles or cards. Keep that restraint when restyling.

**Two things are automatic**, no author markup needed:

- Every page's **tables, code blocks, blockquotes, and headings** are restyled by the sheet.
- The **first bold paragraph directly under the `# ` title becomes the lead thesis**
  (the CSS targets `h1 + p`). Write the report's one-sentence thesis as the first
  paragraph, bold — it is set as a slightly larger lead paragraph (a plain paragraph,
  deliberately not a box) with no extra markup.

## Authoring components (raw HTML in the Markdown)

Everything below is plain HTML dropped into the `.md`. In pandoc `gfm`, a raw HTML block
must be **surrounded by blank lines**, and pandoc will not process Markdown *inside* it —
write inner content as HTML. Reuse these classes verbatim; the stylesheet already styles
them for light, dark, and print. **Do not invent new class names or add per-report CSS.**

### Eyebrow — small-caps kicker above a heading

```html
<p class="eyebrow">HYP_CENTRAL fleet · 2026-06-02 → 2026-07-02</p>
```

### Metric grid — the headline numbers

Renders as ruled key-figure rows: label | right-aligned value | note, one hairline row
per metric. `is-crit` / `is-good` / `is-warn` recolor the value; omit for neutral.
`<small>` shrinks a trailing unit.

```html
<div class="metric-grid">
  <div class="metric is-crit">
    <p class="label">Avoidable Edit failures</p>
    <div class="value">346</div>
    <p class="note">Edited a file never read this session — the #1 preventable error.</p>
  </div>
  <div class="metric is-warn">
    <p class="label">Opus output tokens / mo</p>
    <div class="value">≈35<small>M</small></div>
    <p class="note">≈82% of fleet output; a mechanical tail is re-tierable.</p>
  </div>
  <div class="metric is-good">
    <p class="label">Cache-read hygiene</p>
    <div class="value">99.8<small>%</small></div>
    <p class="note">Already excellent — not a lever.</p>
  </div>
</div>
```

### Callout — a tagged aside

Base = accent; add `crit` / `good` / `warn`.

```html
<div class="callout crit">
  <span class="tag">Exposure</span>
  <p class="body"><strong>346 guaranteed-failure turns / 30d.</strong> Fleet-wide, byte-cheap to fix, zero downside.</p>
</div>
```

### Horizontal bar chart — div-based, no dependencies

Set each fill's width with `style="--w:<pct>%"` (percent of the largest bar). The default
fill is slate ink (`--s1`); modifiers `crit` / `good` / `warn` recolor a bar ONLY when
that bar carries the judgment, `muted` de-emphasizes. `chart-title` names the axis;
`chart-foot` states the takeaway.

```html
<div class="barchart">
  <p class="chart-title">Edit-tool errors by message · 30 days</p>
  <div class="bar-row">
    <div class="bar-label">File not read yet</div>
    <div class="bar-track"><div class="bar-fill crit" style="--w:100%"></div></div>
    <div class="bar-value">309</div>
  </div>
  <div class="bar-row">
    <div class="bar-label">String not found <small>stale old_string</small></div>
    <div class="bar-track"><div class="bar-fill muted" style="--w:38.8%"></div></div>
    <div class="bar-value">≈120</div>
  </div>
  <p class="chart-foot">309 + 37 = 346 failures are the two read-order rules.</p>
</div>
```

### Stacked share bar — one bar split by share, with legend

Set each segment's `width` and `background` inline. Identity = the `--s1`..`--s4` ramp in
share order (never `--good`/`--warn`/`--crit` — those say judgment, not who); a tail
bucket can use `color-mix(in srgb,var(--s4) 45%,var(--track))`. In-bar text only on
`--s1`/`--s2` segments wide enough to fit it; every segment goes in the legend.

```html
<div class="barchart">
  <p class="chart-title">Fleet output tokens by model tier · ≈43M / mo</p>
  <div class="stackbar">
    <span style="width:82%;background:var(--s1)">Opus — 82%</span>
    <span style="width:12%;background:var(--s2)">12%</span>
    <span style="width:3%;background:var(--s3)"></span>
    <span style="width:3%;background:var(--s4)"></span>
  </div>
  <div class="stack-legend">
    <span><i style="background:var(--s1)"></i>Opus · ≈35M</span>
    <span><i style="background:var(--s2)"></i>Fable-5 · ≈5.2M</span>
    <span><i style="background:var(--s3)"></i>Haiku-4.5 · ≈1.3M</span>
    <span><i style="background:var(--s4)"></i>gpt-5.5 · ≈1.0M</span>
  </div>
</div>
```

### Gauge — a single ring for a headline rate

`--p` is the percent filled (0–100), `--gc` its color.

```html
<div class="gauge">
  <div class="ring" style="--p:27;--gc:var(--crit)"><b>27%</b></div>
  <div class="g-body">
    <p class="g-head">47 of 173 query_sql calls failed</p>
    <p>The dangerous slice is the <strong>13 shared-daemon crashes</strong> — fleet-wide, not just the author.</p>
  </div>
</div>
```

### Recommendation entries — a linked numbered list of findings

Used on a report's own index page and on the landing page. Wrap in `<div class="rec-list">`;
each `<a class="rec">` may carry a `.num` badge, a `.rec-kind` eyebrow, an `h3`, body copy,
a `.rec-stats` row, and a `.rec-go` link. It renders as a numbered list item: "1. Bold
title" with the body, stats, and go-link flowing as one muted line, and the kind tag
small at the right margin.

```html
<div class="rec-list">
  <a class="rec" href="file-hygiene.html">
    <span class="num">1</span>
    <p class="rec-kind">Edit · AGENTS.md + CLAUDE.md</p>
    <h3>Read before you Edit</h3>
    <p>309 Edits rejected with <em>"File has not been read yet"</em> plus 37 "modified since read".</p>
    <div class="rec-stats">
      <div class="rec-stat crit"><b>346</b><span>dead turns / mo</span></div>
      <div class="rec-stat"><b>3 lines</b><span>to fix it</span></div>
    </div>
    <p class="rec-go">read-before-edit →</p>
  </a>
</div>
```

## When to use what — keep it honest, no chart slop

- **One or two headline numbers** → a `metric-grid`. Reserve `is-crit`/`is-warn` for
  problems and `is-good` for a solved/healthy metric, so color carries meaning.
- **A composition** (errors by type, tokens by tier) → a `barchart`, or a `stackbar` when
  the parts sum to a whole. Widths are percentages you compute; name the axis in
  `chart-title`, the takeaway in `chart-foot`.
- **A per-entity rollup** (one row per user/gateway, team, repo, or model) → always a
  `barchart` or `stackbar` alongside the table. By-user and by-team breakdowns are the
  charts readers come to a usage report for; don't leave them table-only.
- **A single rate that *is* the story** (fail %, share %) → a `gauge`.
- **A risk, caveat, or "already solved, don't chase it" aside** → a `callout`.
- Keep the detailed source table **as well** when the numbers matter — the chart is the
  at-a-glance, the table is the record. Don't add a chart that just restates a two-row
  table. One strong visual per section beats three weak ones.

## Landing-page (`index.html`) template

Regenerated from the report set on every run (SKILL.md step 4). Uses the shared stylesheet
and the `rec` entry vocabulary so it matches the reports. List **every** built report,
newest first; link each by explicit `html/<slug>/index.html` (a bare directory URL breaks
under `file://`).

The landing page is an **at-a-glance brief, not a table of contents**: each entry
carries the report's own headline numbers, hoisted from the top of that report's
`metric-grid`, with no summary prose. A reader should get the fleet's state (and its
trajectory, where a report states one) from the landing page alone, before opening
anything.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HypAware Reports</title>
<link rel="stylesheet" href="assets/style.css">
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
<link rel="icon" type="image/png" sizes="64x64" href="assets/favicon.png">
</head>
<body>
<header class="masthead">
<span class="brand"><span class="brand-mark"></span>Hyperparam</span>
<span class="doc-label">Internal reports · generated from HypAware data</span>
</header>

<p class="eyebrow">HypAware · fleet analyses</p>
<h1>HypAware Reports</h1>
<p>Fleet analyses generated from HypAware AI-gateway recordings. Each report is self-contained.</p>

<div class="rec-list">
  <!-- one entry per report, newest first -->
  <a class="rec" href="html/<slug>/index.html" style="padding-left:1.4rem">
    <p class="rec-kind">&lt;server · window, e.g. HYP_CENTRAL fleet · 30-day view&gt;</p>
    <h3>&lt;Title&gt;</h3>
    <div class="rec-stats">
      <!-- the report's top 3-4 metric-grid figures, re-rendered as stats -->
      <div class="rec-stat crit"><b>&lt;value&gt;</b><span>&lt;2-4 word label&gt;</span></div>
      <div class="rec-stat warn"><b>&lt;value&gt;</b><span>&lt;2-4 word label&gt;</span></div>
      <div class="rec-stat good"><b>&lt;value&gt;</b><span>&lt;2-4 word label&gt;</span></div>
    </div>
    <p class="rec-go">open report →</p>
  </a>
  <!-- companion entry, only for a report with a <slug>/proposed-changes.md page:
       placed directly below that report's entry -->
  <a class="rec" href="html/<slug>/proposed-changes.html" style="padding-left:1.4rem">
    <p class="rec-kind">&lt;same scope phrase&gt; · ranked changes</p>
    <h3>Proposed changes</h3>
    <div class="rec-stats">
      <div class="rec-stat"><b>&lt;N&gt;</b><span>changes, ranked</span></div>
      <!-- plus the 2-3 strongest stat-row figures from that page's rec cards -->
    </div>
    <p class="rec-go">open changes →</p>
  </a>
</div>

<div class="callout warn">
  <span class="tag">Internal</span>
  <p class="body">Contains gateway IDs, usernames, repo paths, and token volumes. Keep this repository private.</p>
</div>
</body>
</html>
```

Per-entry rules:

- **Stats come from the report's `metric-grid`** (step 3 guarantees every report has one).
  Take the first 3-4 figures in source order, keep each value and judgment exactly
  (`is-crit` → `crit`, `is-warn` → `warn`, `is-good` → `good`, neutral → no class),
  compress the label to 2-4 words, and drop the note. Never recompute or
  re-judge a number here; the entry is a projection of the report, not a new analysis.
- **No summary sentence.** The entry is kicker + title + stats + `rec-go` only. The scope
  line (`*Source: … · Window: …*` or the `## <server> · <window>` subtitle) becomes the
  `rec-kind` kicker, trimmed to a short phrase.
- **Proposed-changes companion entry** (user decision 2026-07-16): a report with a
  `<slug>/proposed-changes.md` section page gets a second entry directly below its
  report entry, linking `html/<slug>/proposed-changes.html`. Kicker = the report's scope
  phrase + `· ranked changes`; title "Proposed changes"; stats = the ranked-change count
  (from the page's thesis) as a neutral stat, then the 2-3 strongest stat-row figures
  from that page's `rec` cards, values and judgments unchanged; `rec-go` "open
  changes →". Reports without such a page get no companion entry.

`index.html` is generated and overwritten each run, so edits made directly to the file
won't survive.
