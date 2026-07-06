# Visual system & component vocabulary

Reference for `hypaware-report-to-html`. The look of every rendered report is carried by
`assets/style.css` (a self-contained **data-report** system: Space Grotesk for headings and
numbers, a warm-neutral palette with `--accent`/`--good`/`--warn`/`--crit` semantic colors,
tabular figures, `prefers-color-scheme` dark mode, and a print stylesheet) plus the raw-HTML
components below. No build-time tokens — just reference the stylesheet.

**Two things are automatic**, no author markup needed:

- Every page's **tables, code blocks, blockquotes, and headings** are restyled by the sheet.
- The **first bold paragraph directly under the `# ` title becomes a hero thesis callout**
  (the CSS targets `h1 + p`). Write the report's one-sentence thesis as the first
  paragraph, bold — it becomes the hero box with no extra markup.

## Authoring components (raw HTML in the Markdown)

Everything below is plain HTML dropped into the `.md`. In pandoc `gfm`, a raw HTML block
must be **surrounded by blank lines**, and pandoc will not process Markdown *inside* it —
write inner content as HTML. Reuse these classes verbatim; the stylesheet already styles
them for light, dark, and print. **Do not invent new class names or add per-report CSS.**

### Eyebrow — mono kicker above a heading

```html
<p class="eyebrow">HYP_CENTRAL fleet · 2026-06-02 → 2026-07-02</p>
```

### Metric grid — the headline numbers

`is-crit` / `is-good` / `is-warn` recolor the value and left rule; omit for neutral accent.
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

Set each fill's width with `style="--w:<pct>%"` (percent of the largest bar). Fill
modifiers: `crit` / `good` / `warn` / `muted`. `chart-title` names the axis; `chart-foot`
states the takeaway.

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

Set each segment's `width` and `background` inline (use palette vars); label only segments
wide enough to fit text.

```html
<div class="barchart">
  <p class="chart-title">Fleet output tokens by model tier · ≈43M / mo</p>
  <div class="stackbar">
    <span style="width:82%;background:var(--warn)">Opus — 82%</span>
    <span style="width:12%;background:var(--accent)">12%</span>
    <span style="width:3%;background:var(--good)"></span>
    <span style="width:3%;background:color-mix(in srgb,var(--muted) 55%,var(--track))"></span>
  </div>
  <div class="stack-legend">
    <span><i style="background:var(--warn)"></i>Opus · ≈35M</span>
    <span><i style="background:var(--accent)"></i>Fable-5 · ≈5.2M</span>
    <span><i style="background:var(--good)"></i>Haiku-4.5 · ≈1.3M</span>
    <span><i style="background:color-mix(in srgb,var(--muted) 55%,var(--track))"></i>gpt-5.5 · ≈1.0M</span>
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

### Recommendation cards — a linked list of findings

Used on a report's own index page and on the landing page. Wrap in `<div class="rec-list">`;
each `<a class="rec">` may carry a `.num` badge, a `.rec-kind` eyebrow, an `h3`, body copy,
a `.rec-stats` row, and a `.rec-go` call to action.

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
- **A single rate that *is* the story** (fail %, share %) → a `gauge`.
- **A risk, caveat, or "already solved, don't chase it" aside** → a `callout`.
- Keep the detailed source table **as well** when the numbers matter — the chart is the
  at-a-glance, the table is the record. Don't add a chart that just restates a two-row
  table. One strong visual per section beats three weak ones.

## Landing-page (`index.html`) template

Regenerated from the report set on every run (SKILL.md step 4). Uses the shared stylesheet
and the `rec` card vocabulary so it matches the reports. List **every** built report,
newest first; link each by explicit `html/<slug>/index.html` (a bare directory URL breaks
under `file://`).

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HypAware Reports</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<p class="eyebrow">HypAware · fleet analyses</p>
<h1>HypAware Reports</h1>
<p>Fleet analyses generated from HypAware AI-gateway recordings. Each report is self-contained.</p>

<div class="rec-list">
  <!-- one card per report, newest first -->
  <a class="rec" href="html/<slug>/index.html" style="padding-left:1.4rem">
    <h3>&lt;Title&gt;</h3>
    <p>&lt;short scope / one-line summary&gt;</p>
    <p class="rec-go">open report →</p>
  </a>
</div>

<div class="callout warn">
  <span class="tag">Internal</span>
  <p class="body">Contains gateway IDs, usernames, repo paths, and token volumes. Keep this repository private.</p>
</div>
</body>
</html>
```

Curate the per-report scope wording here — `index.html` is generated and overwritten each
run, so edits made directly to the file won't survive.
