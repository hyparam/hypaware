# LLP 0196: Skills state constraints, not procedures

**Type:** RFC
**Status:** Accepted
**Systems:** Plugins, Reports, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-06
**Related:** LLP 0074, LLP 0075, LLP 0102, LLP 0107, LLP 0142, LLP 0155
**Planned-by:** LLP 0197
**Superseded-in-part-by:** LLP 0208 (open question 1's keep-pandoc resolution)

> The bundled skill surface has grown to 18 `SKILL.md` files across two
> hand-synced trees, ~290 KB of prose, with the two largest skills at 25 KB
> and 27 KB each. This proposes a smaller surface organised by the question a
> user asks rather than by pipeline stage, with deterministic mechanics moved
> out of prose and into shipped code, and report layout moved out of the skill
> and into a user-editable house style.

## Motivation

Two complaints, measured, with one shared cause.

**Too many skills.** The claude tree ships 10 skills, the codex tree 8. Four
of the ten are stages of a single workflow: generate
(`hypaware-ai-usage-report`), render (`hypaware-report-to-html`), publish
(`hypaware-publish-report`), apply (`hypaware-apply-report-changes`). A user
does not arrive with a stage in mind; they arrive with "how is the team using
AI" or "put last month's review on the server". The stage boundaries are ours,
not theirs, and they are the boundaries most likely to be crossed in a single
request.

**Skills are too long, and long in the wrong way.** `hypaware-report-to-html`
is 27 KB of `SKILL.md`. Roughly 110 of its 399 lines are not judgment at all:
they are a prose reconstruction of a shell script. The skill explains how to
write a `masthead()` function, how to derive a doc label from a slug, which
`sips` invocation regenerates a PNG favicon, why `writeText` loses Safari's
clipboard permission across an `await`, and which `grep` commands verify the
output. It ships canonical copies of `style.css`, `copy-md.js`, `head.html`,
and both favicons in its own `assets/` directory, and then describes in
English how a script should consume them.

The cause is visible in that last sentence. `build.sh` is the one artifact the
skill does **not** ship: it lives only in the user's `~/hypaware-reports`
working tree, untracked by this repo. Because the script is not versioned with
the skill, the skill cannot call it and trust it. So it carries the script's
logic as prose, plus conditional repair instructions for the case where the
user's copy predates a feature (`grep -q masthead build.sh`,
`grep -q copy-md build.sh`). Prose is the fallback for code we failed to ship.

Three consequences of not shipping it are already visible on this machine, as
of 2026-08-06:

- **The prose describes a script that already does the job.** The live
  `build.sh` is 158 lines and implements the masthead, doc label, favicon
  chain with PNG fallback, `copy-md.js`, the raw `.md` sidecars, and
  `rewrite_hrefs` in full. Most of the skill's mechanical prose is not
  instructing the model to build something missing; it is a second, prose copy
  of code that exists, kept only because the skill has no way to know which
  version of the script it will meet.
- **The shipped assets have already drifted.** The skill's canonical
  `assets/style.css` and the copy in the live reports tree now differ, which is
  exactly the failure the "install / refresh the shared stylesheet" step exists
  to prevent and did not.
- **The script is macOS-only.** `sed -E -i ''` is the BSD spelling and fails on
  GNU sed, and the PNG favicon is regenerated with `sips`. `CLAUDE.md`'s
  release gate asks for a macOS host and a Linux host; rendering would fail the
  Linux half today, and nothing catches it because the script has no tests.

**Duplication is already decaying.** The claude and codex copies were
hand-synced and have drifted: `hypaware-privacy` differs by 116 lines,
`hypaware-apply-report-changes` by 11, and four more by 2 to 6. Two skills are
still byte-identical, which is the exception. Every future edit is two edits,
and the drift says we are not reliably making both.

**Retired skills survive in the field.** LLP 0142 retired
`hypaware-sensitive-scan`, and it is gone from the workspace. A copy is still
installed at `~/.claude/skills/hypaware-sensitive-scan` and still advertises
itself, still contradicting `hypaware-privacy` about purge. Retirement removed
the source without removing the surface.

**The layout is over-specified for a subjective artifact.**
`hypaware-ai-usage-report` fixes the exact block order, the exact heading
vocabulary, the ~40-line budget for the brief, and the bullet shape ("bold
topic line + 2-3 short sub-bullets", "multi-sentence prose bullets are hard to
scan and not allowed"). None of that is a correctness property. It is one
reader's taste, frozen into the skill, in a domain where every team has an
opinion about what a report should look like. A user who wants a different
shape has to argue with the skill.

<a id="the-cause"></a>**The shared cause: the skills encode a procedure.**
They tell the model the steps to take rather than the constraints to respect.
Procedures are long (every branch must be written out), brittle (they drift
from the code they narrate), and rigid (deviating reads as disobedience). The
same knowledge stated as constraints is a fraction of the size, survives
implementation changes, and leaves the shape of the work to the model and the
user.

## Design

### 1. Deterministic mechanics ship as code

<a id="mechanics-as-code"></a>**If a step is deterministic, it is a command,
not a paragraph.** [LLP 0155 #core-group](./0155-report-cli.decision.md)
already made this argument for publishing: "a skill cannot refresh an OIDC
session or share the 0600 store safely; it should call the CLI instead", and
`hyp report publish|list|get|delete` replaced the skill's ad-hoc `curl`. A
skill also cannot reliably reconstruct a 7 KB shell script from a description
of it. Rendering deserves the same treatment.

Proposed: `hyp report render [<dir>]` becomes a real command, absorbing
`build.sh` and its `assets/` into this repo. Three things change, in
increasing order of value.

**It takes over what `build.sh` already does**, ported off BSD-only `sed` and
`sips` so it runs on both release-gate platforms: discover each top-level
`<slug>.md` plus its optional `<slug>/` section directory, install the
stylesheet and favicons, render each page through pandoc with the masthead and
doc label prepended, chain the back-nav, write the raw `.md` sidecars and
`full.md` that the copy buttons serve, and rewrite `.md` hrefs to `.html` on
the emitted HTML so Markdown links and raw-HTML component links are caught in
one pass. Shipping it means the skill stops carrying repair instructions for
old copies, because the installed version is the version.

**It takes over the landing page**, which `build.sh` deliberately does not
build. Its own header comment defers that to the skill, so today the model
transcribes a 50-line HTML template out of `components.md` on every run. Card
order (slugs are `YYYY-MM-DD-`, newest first), the explicit
`html/<slug>/index.html` link that survives `file://`, and the companion card
for any report with a `proposed-changes.md` are all deterministic. Only the
per-card stat selection is a judgment call, and that is an input the command
can take rather than a reason to hand-write the whole page. Hand-transcription
is also why the landing page is not reproducible run to run today, which is
the wrong axis to be variable on: see
[#the-inversion](#the-inversion).

**It takes over verification**, turning the skill's list of `grep` checks into
the command's own exit status: no leftover `.md` hrefs in built pages, a copy
action on every page, a `full.md` per report, a back-link on every report. A
check that lives in the command runs every time and can be tested hermetically
in a temp directory, which is what the smoke tiers in `CLAUDE.md` ask for. A
check that lives in a skill runs when the model remembers it.

The skill's remaining share of rendering is one line: run it, then look at the
result. That is roughly a 40% cut to `hypaware-report-to-html` before a single
sentence is edited for style.

<a id="render-is-not-enrichment"></a>**What the command must not absorb.** The
enrichment pass (step 3 of the current skill) stays a model task and stays in
the skill. Deciding which three to six numbers a report leads with, what
judgment colour each carries, which finding becomes a card, and what its
display copy says is reading comprehension over a specific document. It is
also where the safety-relevant constraints live: every number traces to the
report's own text, judgment colours never attach to a named person, and
ready-to-apply artifacts render verbatim. The boundary is clean: the model
decides what the page says, the command decides how the page is built.

<a id="division-of-labour"></a>**Render is the last step, not an intermediate
one.** Its output is the finished, styled, browsable site; nothing runs after
it. The confusion worth heading off is that "deterministic" means "generic
output". It does not. The command's logic is identical for every user, and the
variation arrives through the inputs it reads:

1. The model queries, analyses, and writes the report Markdown, following the
   house style and the user's stated preferences for this run.
2. The model enriches that Markdown with the component vocabulary, which is
   the judgment described above.
3. `hyp report render` reads the Markdown, the base `style.css` it owns, the
   user's `theme.css` if present, and the branding strings, and emits the
   styled HTML, the raw `.md` sidecars, the landing page, and a pass or fail.

So the styling **is** applied by render. What render never does is decide what
the styling should be, or what the content should say.

### 2. One skill per question, not per pipeline stage

<a id="one-skill-per-question"></a>Skills are named for what a user wants,
and a skill covers a whole want end to end. Proposed surface, 10 to 6:

| Skill | Absorbs | Why one |
| --- | --- | --- |
| `hypaware-query` | `hypaware-graph` | Both answer "get me facts out of the recordings". The routing between them (graph for entities and connections, messages for per-message measures) is a paragraph inside one skill, not a boundary between two. `hypaware-ai-usage-report` already has to teach that routing itself, which is the tell. |
| `hypaware-report` | `hypaware-ai-usage-report`, `hypaware-report-to-html`, `hypaware-publish-report`, `hypaware-apply-report-changes` | One workflow with four verbs. The model enters at the stage the user's request implies and can carry on to the next without a handoff. **Superseded-by: LLP 0216** (report generation moved server-side 2026-08-12; the merged skill is removed and no client skill replaces it). |
| `hypaware-privacy` | (unchanged) | Already the single privacy surface per LLP 0142 #one-privacy-surface. |
| `hypaware-reference` | (unchanged) | Product orientation. |
| `hypaware-ignore` | (unchanged) | Protected by LLP 0142 #user-invoked-only. **Superseded-by: LLP 0212** (retired 2026-08-12; `hyp session ignore` is the only implementation, and the natural-language routing moves into `hypaware-reference`). |
| `hypaware-unignore` | (unchanged) | Same. **Superseded-by: LLP 0212** (retired 2026-08-12 with its pair). |

The report skill's stage-specific detail (the render contract, the publish
confirmation, the apply contract) lives in sibling reference files loaded when
that stage is actually entered, in the way `authoring.md` and `components.md`
already work for the renderer. The `SKILL.md` stays short enough to be worth
loading on every report question.

### 3. Constraints in the skill, taste in three owned layers

<a id="constraints-not-layout"></a>**The skill carries what is true
regardless of preference. Separate, user-owned files carry what a particular
team wants their reports to look like.**

<a id="the-inversion"></a>First, the shape of the problem, because the current
design has it backwards on all three axes:

| Axis | Should be | Is today |
| --- | --- | --- |
| Page scaffolding | Deterministic | Model-authored from a template in `components.md` on every run, so it varies run to run |
| Visual style | Customizable | A canonical `style.css` the skill normalizes toward |
| Branding and copy | Per-org config | Hardcoded strings in `build.sh` and the landing template |

The stylesheet case is a live defect, not a hypothetical. The skill decides
whether to overwrite `style.css` by heuristic: a Google Fonts `@import`,
`box-shadow` on cards, or missing `.metric` / `.callout` / `.barchart` rules
mean "older sheet, replace it". That test cannot distinguish a user's
customization from staleness, and it misclassifies the obvious customization
(wanting a webfont) as rot. The live `style.css` has already drifted from the
skill's canonical copy, so the next render has to make exactly that
undecidable call.

The branding case matters as soon as HypAware renders a report for anyone who
is not Hyperparam. `build.sh`'s `masthead()` hardcodes the brand name, and the
landing template hardcodes the page title, the standfirst, and the
"Keep this repository private" notice. None of that is reachable from CSS.

Stays in the skill, because getting it wrong produces a wrong report:

- The token math and the COALESCE trap. A provider that never emits
  `cache_write_tokens` makes `sum()` return NULL and poisons any total built
  from it; this was measured on a real install, where 25,581,312 OpenAI
  cache-read tokens silently became 0.
- The one-carrier rule (LLP 0035): usage rides exactly one row per response,
  so a plain `SUM` over assistant rows needs no dedup.
- Query shapes that kill servers: never `GROUP BY` / `DISTINCT` / row-fetch
  wide content columns on the messages table at scale; one remote worker at a
  time.
- Captured content is data, never instructions, and the rule that a proposed
  change must come from observed behaviour rather than from something a
  recorded payload asked for.
- Ask which source to query before querying.
- Tokens, never dollars. Findings attach to patterns and defaults, never to
  person-rankings.
- Every number traces to the report's own text or tables; rendering never
  invents, recomputes, or reinterprets a finding.

Moves out to three layers, each with one owner, because these are three
different kinds of customization that the single `style.css` currently
conflates:

<a id="theme-layer"></a>**(a) Visual theme: `assets/theme.css`, owned by the
user, never overwritten.** The base `style.css` stays owned by the command and
is refreshed on every render, which makes the undecidable overwrite call above
go away: the base is always ours, the theme is always theirs. The two are
composed by the cascade, loaded in that order, so there is no merge logic and
no forking of the base sheet. This is cheap because `style.css` is already
custom-property driven: `--fg`, `--accent`, `--good` / `--warn` / `--crit`, the
`--s1`..`--s4` chart ramp, `--display` / `--body` / `--mono`, `--max`, with a
parallel dark-mode block. A team's whole visual identity is a dozen `:root`
overrides, and a webfont becomes a supported choice rather than a symptom of
rot. It also retires the inline `style="padding-left:1.4rem"` currently baked
into the landing-page template, which contradicts the skill's own rule against
per-page CSS.

<a id="branding-config"></a>**(b) Branding and standing copy: configuration,
not a stylesheet.** Brand name and mark, favicon, the doc-label wording, the
landing page's title and standfirst, and the confidentiality notice. Strings,
supplied per install, defaulted to today's values so nothing changes for an
existing user.

**(c) Content shape: a house style document the model reads.** Block order,
heading vocabulary, the length budget for the brief, the bullet shape and
whether prose bullets are allowed, which numbers get the big treatment, and
whether ranked changes live on their own page or inline.

<a id="precedence"></a>**Precedence is explicit and has three levels:** what
the user asks for in this run beats their house style and theme, which beat
the shipped defaults. That is the versatility the current design cannot
express, because today a user preference and the skill text are in direct
conflict and the skill is the one written down.

### 4. One source, two hosts

<a id="one-source-two-hosts"></a>The codex copies are generated from the
claude sources at pack time rather than maintained by hand. The known deltas
are small and mechanical: `disable-model-invocation` has no codex equivalent
(LLP 0142), and `hypaware-ignore` / `hypaware-unignore` are claude-only.
Anything else that currently differs is drift to be reconciled, not a feature.
A test asserts the trees match after generation, so the 116-line divergence in
`hypaware-privacy` cannot recur.

### 5. The invocation gate moves to the command

<a id="gate-moves-to-the-command"></a>This supersedes
[LLP 0142 #user-invoked-only](./0142-privacy-surface-and-skill-discoverability.decision.md#user-invoked-only)
for the three report skills, and it is the part of this RFC that needs the
most scrutiny.

> **Decided 2026-08-06 (maintainer):** remove `disable-model-invocation` from
> the three report skills. The product is moving toward reports being asked
> for in the user's own words rather than by invoking a skill by name, and a
> skill the model cannot reach cannot serve that. The fallback below is not
> taken.
>
> **One precondition found while implementing it.** The claim "each is a step
> a user takes on purpose" holds for publishing and applying, which both
> confirm explicitly today. It did **not** hold for rendering:
> `hypaware-report-to-html` confirms before *pushing*, but its enrichment step
> edits the report source Markdown in place with no confirmation at all, and
> those are source-file edits, not derived output. Ungating it as it stood
> would have let a model rewrite a user's reports off an unrelated prompt.
> The gate is therefore removed *with* a confirmation added to the step that
> mutates sources, which is precisely the "the gate belongs on the act" claim
> being honoured rather than asserted. LLP 0197 T3 and T5 move that check into
> `hyp report render`, where it can be tested.

LLP 0142 marked render, publish, and apply `disable-model-invocation` because
each "is itself a consequential act the user should choose deliberately".
Under this RFC they are no longer separate skills, so the key has nothing to
attach to; a merged `hypaware-report` that is gated cannot answer "how is the
team using AI", which is the whole point of making it model-invocable.

The proposal is that **the gate belongs on the act, not on the skill's
discoverability.** Each consequential step already confirms: publishing
requires an explicit yes and never happens as a side effect of generating,
applying is per-item and never blanket, rendering rewrites a git tree and can
require a clean-tree check plus confirmation. Those confirmations are the real
control, they live in the command where they can be tested, and LLP 0142
itself concedes the frontmatter key "is a discoverability preference, not a
safety control", which is exactly why the codex copies were allowed to stay
model-invocable.

Note the asymmetry this removes: today a codex user can already reach all
three of these skills by model invocation, so the gate only ever applied to
half the fleet.

The stated rationale is also weaker than it reads. LLP 0142 gates rendering
because it "rewrites a git working tree", but on this machine as of 2026-08-06
`~/hypaware-reports` is not a git repository at all, so the skill's step 7
(`git add -A`, `git commit`, choose between `main` and `dev`) would fail
outright. The consequential act being gated is conditional on a setup the
skill assumes and does not check. A `hyp report render` that checks for a repo
and reports what it found is a better control than a frontmatter key that
assumes one.

**If this part is rejected**, the fallback is a 7-skill surface: merge
generate and render into `hypaware-report` (both model-invocable, since
rendering is the natural continuation of generating) and keep a gated
`hypaware-report-publish` covering publish and apply, which are the two
genuinely outward or config-mutating acts. That still retires four skills and
keeps LLP 0142's stance intact for the acts it most cared about.

### 6. Retirement removes the surface

<a id="retirement-removes-the-surface"></a>Retiring a skill includes removing
installed copies, not only workspace sources. `hypaware-sensitive-scan` is the
existing case: it needs a removal path on attach or reconfigure so a machine
that installed it before LLP 0142 stops advertising it.

## Options considered

1. **Merge `hypaware-report-to-html` into `hypaware-ai-usage-report` only**
   (the question that started this). Rejected as insufficient and slightly
   wrong: the renderer is many-to-one. `~/hypaware-reports` currently holds a
   neutral-agent review and a server-performance review alongside the usage
   reviews, and the renderer also serves archived reports from the superseded
   adoption / spend / improvement skills. Folding it into one generator
   strands the others. It also concatenates two 25 KB skills without
   addressing why either is 25 KB.
2. **Shorten the skills in place, keep all ten.** Rejected as the smaller half
   of the fix. Length and count share the cause in [#the-cause](#the-cause);
   editing prose for concision without moving mechanics into code means the
   prose grows back the next time `build.sh` gains a feature.
3. **This RFC: ship mechanics as code, organise by question, split constraints
   from taste, generate the codex tree.**

## Consequences

- `build.sh` and its assets become repo artifacts with tests, and gain a `hyp
  report render` entry point. This is the largest piece of new work and the
  prerequisite for the rest.
- Four skills retire into `hypaware-report`; `hypaware-graph` retires into
  `hypaware-query`. Their content survives as stage reference files and a
  default house style, not as deletions.
- LLP 0142 #user-invoked-only is superseded in part (see
  [#gate-moves-to-the-command](#gate-moves-to-the-command)). On acceptance,
  append `Superseded-by: LLP 0196` to that section. It is deliberately not
  appended while this document is a Draft, so an Accepted decision is not
  marked superseded by an unaccepted proposal.
- LLP 0155 is still a Draft; the render command extends it rather than needing
  a separate decision.
- LLP 0102 (skill replaces enrollment picker) and LLP 0107 (skills ride
  attach) need a check that renaming and removing skills flows through attach
  and reconfigure correctly. That path is also what
  [#retirement-removes-the-surface](#retirement-removes-the-surface) needs.
- A generation step plus an equality test replace hand-syncing the codex tree.
- Expected size: roughly 290 KB of skill prose across 18 files down to under
  100 KB across 6 sources, with the mechanical content relocated to code
  rather than deleted.

## Open questions

1. **Superseded-by: LLP 0208** (2026-08-10: the renderer converts in process via
   `marked`; server-side generation made the binary dependency and its blocking
   subprocess a problem, exactly the escape hatch named below).
   **Resolved 2026-08-06: keep pandoc, and install it in CI.** The question was
   whether `hyp report render` should keep pandoc as a hard dependency or
   render Markdown in-process. `.github/workflows/ci.yml` runs on
   `ubuntu-latest` (Node 22 and 24), so adding pandoc is a one-line
   `apt-get` step, and nothing currently forces the larger change. The only
   pandoc property the component vocabulary relies on is `gfm` passing raw
   HTML through untouched, so in-process rendering stays available if the
   dependency ever becomes a problem.

   **Checking this made T3 more urgent, not less.** CI is Linux-only and the
   renderer is macOS-only (`sed -E -i ''`, `sips`). The renderer therefore has
   **no automated coverage today and cannot have any until T3 lands**. The
   framing elsewhere in these documents, that the port fixes the Linux half of
   the release gate, understates it: until the port lands, any test written
   against the renderer is unrunnable on the only platform CI has.
2. Where do the three customization layers live? `theme.css` clearly belongs
   next to the reports it styles, in `~/hypaware-reports/assets/`. The house
   style document and the branding strings could go either there (travels with
   the reports, survives a re-clone, easy to hand-edit) or in HypAware config
   (one place, applies to every reports tree on the machine). Splitting them
   across both locations would be the worst outcome.
3. Is the fallback in [#gate-moves-to-the-command](#gate-moves-to-the-command)
   (7 skills, publish and apply stay gated) actually preferable? It costs one
   skill and keeps LLP 0142 mostly intact.
4. Should `hypaware-privacy` also split constraints from procedure? It is
   13-21 KB depending on which drifted copy you read, and LLP 0100 specs its
   flow tightly, so it may be spec-bound in a way the report skills are not.
