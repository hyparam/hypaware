# Worked example — enriching a plain report (before → after)

> ⚠ **This file demonstrates SHAPES, not content.** It is the enrichment of ONE specific
> report (the improvement review). When enriching any other report, take only the markup
> patterns — the class structure, where blocks go, how widths are computed. Every label,
> number, title, tag word, note, and caption in YOUR output must come from the report you
> are enriching (SKILL.md step 3, Phase A inventory). If any phrase from this file shows
> up in another report's output — "dead turns / mo", "The numbers that set the agenda",
> "Read before you Edit" — you copied content, not shape. Start that file over.

This is the actual transformation applied to the improvement-review one-pager. Use it as
the reference for SKILL.md step 3: same moves, same class names, numbers taken verbatim
from the plain version. Component reference: [`components.md`](components.md); rules:
[`authoring.md`](authoring.md).

## BEFORE — plain Markdown as the report skills emit it

```markdown
# AI Improvement Review

## HYP_CENTRAL fleet · 2026-06-02 → 2026-07-02

---

**Make four changes — a read-before-Edit rule and a model-selection rule in the shared
AGENTS.md, an OOM-safe-query section in the `hypaware-query-dev` skill, and promote
phil's PR review/release flow into the repo — to erase ≈370 avoidable tool failures,
stop log-queries crashing the shared daemon, right-size ≈35M Opus output tokens/mo, and
let the whole team run a flow only phil has.**

---

### Key numbers

| Metric | Readout |
| --- | --- |
| Improvements proposed | **4** (1 new, 3 edits to existing artifacts) |
| Basis | 3 contributors · 4 gateways · ≈760 real sessions · ≈30 repos |
| Biggest fixable friction | **346** avoidable Edit failures (edited a file never read) |
| Biggest token exposure (one lever) | ≈**35M** Opus output tokens/mo eligible for cheaper-tier routing |
| Shared-infra risk | **27%** of log-query calls fail; **13** crash the shared daemon |
| Cache-read hygiene | **99.8%** — already excellent, not a lever |

---

## What this shows

### 1. Read before you Edit — AGENTS.md/CLAUDE.md edit

The most common preventable tool failure fleet-wide: **309** Edit calls rejected with
*"File has not been read yet"* and **37** more with *"modified since read"* — 346 dead
turns that a three-line rule prevents. It's byte-cheap, zero-risk, hits
phil/kenny/brendan alike, and today's AGENTS.md has no such rule. Token prize is modest
(≈**0.4–0.8M output tokens/mo** of redo); the real win is friction and cleaner sessions.

[read-before-edit →](file-hygiene.md)

### 2. Right-size the model — AGENTS.md edit + subagent pins

… (same pattern) …

---

## Caveat

Token prizes are floors from partially-captured data; estimated savings are labeled
assumptions, and model re-tiering lowers cost per token, not token volume.

[caveats →](caveats.md)
```

## AFTER — enriched (what step 3 produces)

Every number below appears in the BEFORE text. Note what moved where:
subtitle → eyebrow; `---` deleted; key-numbers table → metric grid; each `###` finding +
link → one `rec` card (link target moves onto the card, `.md` stays — build.sh rewrites
it); caveat → `callout warn` keeping its link.

```markdown
<p class="eyebrow">HYP_CENTRAL fleet · 2026-06-02 → 2026-07-02</p>

# AI Improvement Review

**Make four changes — a read-before-Edit rule and a model-selection rule in the shared
AGENTS.md, an OOM-safe-query section in the `hypaware-query-dev` skill, and promote
phil's PR review/release flow into the repo — to erase ≈370 avoidable tool failures,
stop log-queries crashing the shared daemon, right-size ≈35M Opus output tokens/mo, and
let the whole team run a flow only phil has.**

<p class="eyebrow" style="margin-top:2.4rem">The numbers that set the agenda</p>

<div class="metric-grid">
  <div class="metric is-crit">
    <p class="label">Avoidable Edit failures</p>
    <div class="value">346</div>
    <p class="note">Edited a file never read this session — the #1 preventable tool error, fleet-wide.</p>
  </div>
  <div class="metric is-warn">
    <p class="label">Opus output tokens / mo</p>
    <div class="value">≈35<small>M</small></div>
    <p class="note">≈82% of fleet output. A mechanical tail is eligible for cheaper-tier routing.</p>
  </div>
  <div class="metric is-crit">
    <p class="label">Log-query calls that fail</p>
    <div class="value">27<small>%</small></div>
    <p class="note"><strong>13</strong> of them crash the shared daemon for every client, not just the author.</p>
  </div>
  <div class="metric is-good">
    <p class="label">Cache-read hygiene</p>
    <div class="value">99.8<small>%</small></div>
    <p class="note">Already excellent across every contributor — not a lever, stated so no one chases it.</p>
  </div>
</div>

<div class="callout">
  <span class="tag">Basis</span>
  <p class="body"><strong>4 changes</strong> proposed (1 new skill, 3 edits to existing artifacts), drawn from <strong>3 contributors · 4 gateways · ≈760 real sessions · ≈30 repos</strong> over 30 days. <a href="basis.md">See what this is built on →</a></p>
</div>

## The four recommendations

<div class="rec-list">
  <a class="rec" href="file-hygiene.md">
    <span class="num">1</span>
    <p class="rec-kind">Edit · AGENTS.md + CLAUDE.md</p>
    <h3>Read before you Edit</h3>
    <p>The most common preventable failure fleet-wide: <strong>309</strong> Edits rejected with <em>"File has not been read yet"</em> plus <strong>37</strong> "modified since read" — dead turns a three-line rule prevents. Byte-cheap, zero-risk, hits phil/kenny/brendan alike.</p>
    <div class="rec-stats">
      <div class="rec-stat crit"><b>346</b><span>dead turns / mo</span></div>
      <div class="rec-stat"><b>3 lines</b><span>to fix it</span></div>
      <div class="rec-stat"><b>zero</b><span>downside</span></div>
    </div>
    <p class="rec-go">read-before-edit →</p>
  </a>
  <!-- one card per finding, same shape -->
</div>

## Read the numbers honestly

<div class="callout warn">
  <span class="tag">Caveat</span>
  <p class="body">Token prizes are floors from partially-captured data; estimated savings are labeled assumptions, and model re-tiering lowers cost <em>per token</em>, not token volume. <a href="caveats.md">Full caveats →</a></p>
</div>
```

## Section-page example (abbreviated)

BEFORE (in `query-discipline.md`): title + thesis + prose containing
"**173 calls, 47 errors (27%)** … ≈30 are SQL-dialect misses … the dangerous **13** are
timeouts/socket-closes …" and a detail table.

AFTER adds, directly under the thesis, a gauge for the headline rate and a barchart for
the split — numbers copied from that prose; the detail table stays:

```markdown
<div class="gauge">
  <div class="ring" style="--p:27;--gc:var(--crit)"><b>27%</b></div>
  <div class="g-body">
    <p class="g-head">47 of 173 query_sql calls failed</p>
    <p>The dangerous slice is the <strong>13 shared-daemon OOM crashes</strong> — each a brief fleet-wide outage, not just the author's problem.</p>
  </div>
</div>

<div class="barchart">
  <p class="chart-title">Where the 47 failures come from · red = crashes the shared daemon</p>
  <div class="bar-row">
    <div class="bar-label">SQL dialect misses <small>already documented</small></div>
    <div class="bar-track"><div class="bar-fill muted" style="--w:100%"></div></div>
    <div class="bar-value">≈30</div>
  </div>
  <div class="bar-row">
    <div class="bar-label">Server OOM / infra <small>timeout, socket close</small></div>
    <div class="bar-track"><div class="bar-fill crit" style="--w:43%"></div></div>
    <div class="bar-value">13</div>
  </div>
  <p class="chart-foot">Two different problems, two different fixes — the dialect misses are a <em>reading</em> gap; the OOM crashes are an <em>undocumented</em> hazard.</p>
</div>
```

Bar widths: percent of the **largest** bar (30 → 100%, 13/30 ≈ 43%). Gauge `--p` is the
rate itself.
