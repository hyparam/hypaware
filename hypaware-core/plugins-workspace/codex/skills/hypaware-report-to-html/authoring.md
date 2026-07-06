# Authoring reports for the data-report renderer

**Audience: the report-GENERATING skills** (`hypaware-ai-adoption-report`,
`-spend-report`, `-security-report`, `-improvement-report`) — follow this while writing
the report Markdown. The renderer (`hypaware-report-to-html`) ships a stylesheet that
styles two kinds of content: standard Markdown (automatic) and a raw-HTML component
vocabulary (opt-in, catalog in [`components.md`](components.md)). A report written
without the patterns below renders as a plain text document; one written with them
renders as the intended data report. **The difference is authored here, in the Markdown —
the renderer cannot add it later.**

Raw-HTML rules (pandoc `gfm`): each HTML block must be **surrounded by blank lines**;
Markdown inside a block is NOT processed — write inner content as HTML
(`<strong>`, `<code>`, `<em>`); use the component classes verbatim, never invent new ones.

## 1. Page opening — required shape

The hero thesis is CSS-automatic but **only if the bold thesis paragraph is the first
thing after the `# ` title**. Do not put a `##` subtitle or `---` between them.

WRONG (kills the hero):

```markdown
# AI Improvement Review

## HYP_CENTRAL fleet · 2026-06-02 → 2026-07-02

---

**Make four changes — …**
```

RIGHT:

```markdown
<p class="eyebrow">HYP_CENTRAL fleet · 2026-06-02 → 2026-07-02</p>

# AI Improvement Review

**Make four changes — a read-before-Edit rule …, to erase ≈370 avoidable tool
failures … and let the whole team run a flow only phil has.**
```

The scope/date line becomes an `eyebrow` above the title. The thesis stays one bold
paragraph — the stylesheet turns it into the hero box.

## 2. "Key numbers" — metric grid, not a table

Every report's headline numbers section (the 2-column Metric/Readout table) becomes a
`metric-grid` of 3–6 cards. Color carries judgment: `is-crit` = problem, `is-warn` =
exposure, `is-good` = healthy/solved, no class = neutral. Keep any *detail* tables that
follow; only the headline strip converts.

```markdown
<p class="eyebrow">The numbers that set the agenda</p>

<div class="metric-grid">
  <div class="metric is-crit">
    <p class="label">Avoidable Edit failures</p>
    <div class="value">346</div>
    <p class="note">Edited a file never read this session — the #1 preventable error.</p>
  </div>
  <div class="metric is-good">
    <p class="label">Cache-read hygiene</p>
    <div class="value">99.8<small>%</small></div>
    <p class="note">Already excellent — stated so no one chases it.</p>
  </div>
</div>
```

Every card needs a `note` that says why the number matters — a bare number is not a
finding.

## 3. Findings index — rec cards, not `###` + link

On the one-pager, each finding/recommendation that links to a section page becomes an
`<a class="rec">` card (number badge, kind eyebrow, title, 1–2 sentence body, 2–3 stat
row, go-link). See the full snippet in `components.md`. The `###` heading + trailing
`<a href="…">section →</a>` pattern is replaced by the card — don't emit both.

Stat-row discipline: 2–3 stats per card, each `<b>value</b><span>label</span>`, color
class only when it carries judgment.

## 4. Section pages — one strong visual per section

Each section page opens with its own bold thesis directly under its `# ` title (hero
fires there too), then picks **at most one or two** visuals for the evidence:

- Composition (errors by type, tokens by contributor/tier) → `barchart`
  (widths = percent of the largest value, computed by you), or `stackbar` when parts
  sum to a whole.
- One rate that IS the story (27% fail rate, 82% share) → `gauge`.
- Risk / exposure / "already solved, don't chase it" → `callout` (`crit`/`warn`/`good`)
  with a short ALL-CAPS-ish tag word: Exposure, Risk, Solved, Caveat, Basis.
- Headline numbers for the section → small `metric-grid`.

Keep the source data table **in addition to** the chart when the exact numbers are the
record. Never add a chart that restates a two-row table; never more than one gauge per
page; no visual without a takeaway (`chart-foot` or surrounding sentence).

## 5. Caveats — callout on the one-pager, page for the detail

On the one-pager, render the caveat summary as a `callout warn` with tag `Caveat`,
keeping the link to the caveats page. The caveats page itself stays prose — honesty
sections don't need decoration.

## 6. Write for the surface — display copy is copywriting, not quotation

Component text is read at a glance; prose fragments pasted into cards read as clutter.
Rewrite for each surface (meaning must stay true to the source — wording should not stay
literal):

- **Metric label** — 2–4 words, title-free ("Avoidable Edit failures", not "Biggest
  fixable friction (one lever)").
- **Metric note** — one sentence with the *so what*, not a restatement of the number.
- **Stat labels** (`rec-stat span`) — 2–3 lowercase words ("dead turns / mo").
- **Tag words** — a single judgment noun: Exposure, Risk, Solved, Caveat, Basis.
- **Chart titles** — name the axis and scope ("Edit-tool errors by message · 30 days");
  **chart-foot** — the takeaway, one line.
- **Section headings** — replace scaffolding ("Key numbers", "What this shows") with
  headings that carry the message ("The numbers that set the agenda", "The four
  recommendations").

Conversion is the floor, not the bar: a page that preserves the Markdown's structure and
phrasing with components sprinkled in is a failed pass. The Markdown supplies facts,
numbers, links, and analysis prose; the report's structure, hierarchy, and display copy
are designed.

## 7. Self-check before finishing

- [ ] Eyebrow + `# title` + bold thesis, nothing between them — on the one-pager AND
      every section page.
- [ ] Headline numbers are a `metric-grid` with judgment colors and notes.
- [ ] Findings on the one-pager are `rec` cards with stat rows.
- [ ] Each section page has ≤2 purposeful visuals; source tables kept where numbers
      matter.
- [ ] Every headline number appears in a big-number surface (metric, gauge, stat row,
      chart) — not just bolded inline.
- [ ] Display copy (labels, notes, tags, chart titles) is written for the surface, not
      pasted from prose; scaffolding headings replaced.
- [ ] Every screenful has a visual anchor; no heading-paragraph-heading-paragraph runs.
- [ ] All raw-HTML blocks separated by blank lines; no Markdown syntax inside them.
- [ ] No invented class names, no inline CSS beyond the documented `--w`/`--p`/`--gc`/
      `width`/`background` hooks.
- [ ] Nothing copied from `example-enrichment.md` but shapes — every label, stat, tag
      word, and caption traces to THIS report's own text or tables.
