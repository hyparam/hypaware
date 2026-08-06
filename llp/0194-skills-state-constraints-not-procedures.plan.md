# LLP 0194: Skills state constraints, not procedures, implementation plan

**Type:** plan
**Status:** Draft
**Systems:** Plugins, Reports, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-06
**Related:** LLP 0142, LLP 0155, LLP 0193

> [LLP 0193](./0193-skills-state-constraints-not-procedures.rfc.md) proposes
> shipping the report renderer as code, reorganising the skill surface by
> question rather than pipeline stage, splitting taste into three owned layers,
> and generating the codex tree. This turns that into a fourteen-task graph
> ordered so the RFC's unresolved open questions block as little work as
> possible.

## Sequencing principle

**The skill merge is what the complaint was about, and it comes last on
purpose.** Merging four 25 KB skills before removing their mechanical content
produces one 60 KB skill, which is the same problem with fewer files. Every
kilobyte the renderer stops narrating is a kilobyte the merged skill never has
to carry, so the mechanics move first and the merge becomes cheap.

The other ordering constraint is the RFC's open questions. Waves 1 to 3 are
correct under every resolution of all four, so they can start now. Only T12
is genuinely blocked, on the LLP 0142 gate decision
([LLP 0193 #gate-moves-to-the-command](./0193-skills-state-constraints-not-procedures.rfc.md#gate-moves-to-the-command)).

## What was verified against the tree, and what was not

Verified on 2026-08-06:

- **The renderer to be ported is 158 lines** at `~/hypaware-reports/build.sh`,
  untracked by this repo, and implements every mechanism the skill narrates.
- **Every asset it needs is already shipped** in
  `hypaware-core/plugins-workspace/claude/skills/hypaware-report-to-html/assets/`:
  `style.css`, `favicon.svg`, `favicon.png`, `copy-md.js`, `head.html`.
  `build.sh` is the only missing piece.
- **The command seam exists.** `src/core/cli/report_commands.js` is 505 lines
  with four `runReport*` exports; `src/core/cli/core_commands.js:552-600`
  registers the `report` group and its four subcommands.
- **There is already a test file to extend**,
  `test/core/report-commands.test.js`. Smoke flows are flat modules in
  `hypaware-core/smoke/flows/`.
- **The metric-grid is regular and machine-parseable**, which is what makes T4
  possible: `<div class="metric is-warn">` wrapping `<p class="label">`,
  `<div class="value">9.01<small>B</small></div>`, `<p class="note">`.
- **Portability blockers are two**: `sed -E -i ''` (BSD spelling, fails on GNU
  sed) and `sips` (macOS-only, used once to regenerate the PNG favicon).
- **pandoc is installed on this machine** (`/opt/homebrew/bin/pandoc`), so
  keeping it is not blocked locally. Whether CI has it is not verified.

Not verified, and therefore not assumed by any task below: which side of the
116-line `hypaware-privacy` claude/codex divergence is correct, where branding
strings should live in the config schema, and whether any existing smoke
depends on `build.sh` being absent from this repo.

## The task graph

### Wave 1 (deps `[]`), two-wide

- **T1, vendor the renderer and its assets.** Move `build.sh` and the five
  assets into this repo as the canonical copies, under a new
  `src/core/reports/`. No behaviour change and no porting yet: this only
  establishes that the repo owns the renderer, which every later task depends
  on. Complexity 1.
- **T2, hold the two skill trees together.** Independent of the entire report
  pipeline, so it does not wait.

  <a id="t2-premise-corrected"></a>**Correction, 2026-08-06: this task was
  scoped on a false premise and is rewritten here.** The original text called
  the claude/codex divergence "drift" and asked someone to "decide the correct
  side of each divergence". Reading all six diffs shows there is no wrong side.
  Essentially every diverging line is legitimate host-specific content:

  | Divergence | Why it is correct |
  | --- | --- |
  | `disable-model-invocation` on three report skills | No Codex equivalent (LLP 0142) |
  | Terse claude descriptions vs trigger-rich codex ones | Consequent to the above: a gated skill is chosen by a human from a menu, an ungated one has to be routed to by a model |
  | `@ref LLP 0142#user-invoked-only` comments | They annotate the frontmatter key only claude has |
  | `mcp__hypaware__*` vs generic MCP tool naming | Host MCP tool-naming conventions |
  | `AskUserQuestion` vs "reply with the numbers" | Host tool availability |
  | `/hypaware-ignore` cross-references | That skill is claude-only |
  | `claude --fork-session` vs `codex fork` | Different clients |
  | 90 codex-only lines in `hypaware-privacy` | Claude Code exposes `CLAUDE_CODE_SESSION_ID`; Codex does not, so the codex skill must resolve the session *container* from `~/.codex/sessions` rollouts with explicit refusal-on-ambiguity semantics. It cites issue #453 and is guarded by its own 132-line test, `test/plugins/codex-privacy-skill-session-id.test.js`. |

  **So the codex tree is not derivable from the claude tree.** It contains
  knowledge the claude tree does not have. A generator that emitted one from
  the other would delete tested privacy logic.

  **Update, same day: removing `disable-model-invocation` shrank this.** Once
  the gate went (LLP 0193 #gate-moves-to-the-command, decided by the
  maintainer), the terse-vs-trigger-rich description split went with it, since
  it existed only because the claude copies were gated. `hypaware-publish-report`
  and `hypaware-report-to-html` are now **byte-identical** across hosts, and
  `hypaware-apply-report-changes` fell from 6/3 diverging lines to 3/2 (just
  `AskUserQuestion` vs a numbered reply). Four of the eight shared skills now
  carry nothing host-specific, up from two, which is where "one source, two
  outputs" is straightforwardly true. `hypaware-privacy` (11/88) remains the
  one deliberate fork.

  **Revised scope, in three parts, order deliberate:**

  1. **A parity guard that records the host-specific surface** rather than
     eliminating it: per skill, the count and hash of lines unique to each
     side, checked against a committed fixture. New divergence fails the test
     and forces whoever added it to re-record, which is reviewable in the diff.
     This is correct under every option below, so it lands first and alone.
  2. **Dedup only what is genuinely shared.** The two byte-identical skills,
     and later the shared *bodies* of the small-divergence skills, whose
     differences are mostly frontmatter plus one to three body lines.
  3. **Leave `hypaware-privacy` forked, deliberately**, with a note in both
     copies saying why. Ninety lines of host-specific, separately-tested
     privacy logic is not duplication to be eliminated.

  **This does not reduce to one shipped tree.** `@hypaware/claude` and
  `@hypaware/codex` are separate plugin packages contributing different
  `skill_dir` values (`.claude/skills`, `.codex/skills`), so both trees must
  exist on disk at install time. T2 changes how many places a human *edits*.

  **Open: where any shared source lives**, and whether the generated tree is
  committed or built at pack time and gitignored. Pack-time generation leaves
  one copy in the repo and no decoy to edit by mistake. A host-neutral source
  directory is more honest than generating codex content from under `claude/`.
  Decide before writing a generator, not after.

  <a id="t2-part-2-waits-for-t12"></a>**Part 2 should follow T12, not precede
  it.** The gate removal doubled the deduplicable surface to ~80 KB, but every
  one of the four fully-shared skills is slated to stop existing in its current
  form: `hypaware-graph` merges into `hypaware-query`, and
  `hypaware-ai-usage-report`, `hypaware-publish-report`, and
  `hypaware-report-to-html` all merge into `hypaware-report` (the last after
  T10 cuts it to roughly 8 KB). A generator built now would target files that
  T12 deletes, and its host-specific transform table would be written against
  a file set about to change. Part 1's parity guard is what carries the value
  in the meantime: it makes drift visible without betting on the file layout.

  Complexity 2 for part 1, which is mechanical. Parts 2 and 3 are a design
  decision, not a coding task, and should not start until part 1 has run.

### Wave 2 (deps `[T1]`), two-wide

- **T3, port the renderer to Node. LANDED 2026-08-06.**
  `src/core/reports/render.js`, with `sips` dropped (the PNG ships prebuilt),
  the four BSD `sed` expressions replaced, and pandoc kept as a child process.
  Accepted by A/B against `build.sh` on the real reports tree: **byte-identical
  output across five reports**. The case table
  (`test/core/report-render-hrefs.test.js`, 18 cases) was written first and the
  port written against it. `build.sh` is frozen in place until T5 removes the
  skill's call to it. Two things the port fixed that the plan had not named: the
  shell copied four assets beside each page but `head.html` is inlined by
  pandoc's `-H` and was never one of them, and the shell interpolated `$slug`
  into a regex unescaped. Complexity 4 as estimated, and the risk was where
  predicted.
- **T4, generate the landing page. LANDED 2026-08-06.**
  `src/core/reports/landing.js`. Fully deterministic as predicted: stats come
  from each report's `metric-grid` in source order with values and judgments
  kept exactly, and label compression is dropped in favour of the metric's own
  label verbatim. Verified reproducible (two runs over unchanged reports emit
  identical HTML) and complete (all five reports listed, every link resolves).

  **One rule the plan did not anticipate: it must not invent.** The
  hand-written landing page carried stats for the proposed-changes companion
  cards, but those pages have no `metric-grid` and no `rec` cards at all, so
  those figures came from a model reading prose. A card whose page has no
  metrics now gets no stat row. That is the same constraint the report skills
  carry ("never invents, recomputes, or reinterprets"), applied to the command.

  Two bugs worth recording, both found by running it rather than by reading it.
  A lazy regex over `metric` blocks stopped at the nested `<div class="value">`
  and yielded one stat per card instead of four. And `extractTitle` originally
  ran the heading through the tag-stripper, which truncated a literal title like
  `Tokens & <Costs>` to `Tokens &`; headings are Markdown, so they are collapsed
  and escaped, never stripped. Complexity 3 as estimated.

### Wave 3 (deps `[T3, T4]`), two-wide

- **T5, wire up `hyp report render`. LANDED 2026-08-06.** `runReportRender` in
  `report_commands.js`, registered in `core_commands.js` beside its four
  siblings.

  **The asymmetry was resolved by joining the group and fixing its help.** LLP
  0155 built `report` around "there is no local reports plane; `--remote`
  selects a server", and `render` is the first member that is not a REST call.
  It joins anyway, because the user's workflow is render-then-publish and
  splitting those across two command namespaces would serve the implementation
  rather than the reader. The group help now separates the local build step
  from the four plane operations, so 0155's claim stays true of the commands it
  was written about.

  **The skill lost its prose renderer**, which was the point: 28,405 to 22,739
  bytes and 414 to 336 lines, with every `build.sh` reference gone. Steps 2, 4,
  and 6 collapse to "the command does this", and step 6 keeps only the checks a
  command cannot make (are the findings carded, does the landing page carry
  stats). `build.sh` is deleted, with a test asserting it does not come back.
- **T6, tests.** Traditional tests for the deterministic logic, which is
  exactly what `CLAUDE.md` asks for: a table-driven test over `rewrite_hrefs`
  covering own-section, cross-report one-pager, cross-report section, and
  fragment-bearing links in both index and section modes; metric-grid
  extraction; doc-label derivation from a slug. Extend
  `test/core/report-commands.test.js`. Add a hermetic smoke `report_render`
  building a fixture reports tree in a temp directory and asserting the
  verification contract (no leftover `.md` hrefs in built pages, a copy action
  on every page, one `full.md` per report, a back-link on every report).
  Complexity 3. ~~Blocks on a decision if CI lacks pandoc.~~ **Resolved:** CI
  is `ubuntu-latest`, so the smoke adds a one-line `apt-get install pandoc`
  step (LLP 0193 open question 1).

  **Pull the `rewrite_hrefs` table forward into T3.** The six-case table is
  the specification T3 ports against, not a check written afterwards, and the
  current script has no tests at all, so there is no existing coverage to port
  against instead. Writing it second is how the cases get lost.

### Wave 4 (deps `[T5]`), three-wide

- **T7, the theme layer. LANDED 2026-08-06.** `assets/theme.css` is created
  once with a commented stub naming the overridable custom properties, never
  written again, and linked from `head.html` after the base sheet on every page.
  The base stays command-owned and is refreshed every run, which is what
  removes the undecidable "customization or rot?" call.

  **T4 had left this half-done**: the theme was copied beside each page but
  linked only from the landing page, so a user theme would have styled the
  index and nothing else. The test now asserts the link on every built page and
  the cascade order, which is the assertion that would have caught it.
  Complexity 2.
- **T8, branding config.** Extract the hardcoded strings: the brand name in
  `masthead()`, the doc-label wording, and the landing page's title,
  standfirst, and confidentiality notice. Defaults preserve today's output
  exactly. Complexity 2, plus RFC open question 2 on where they live.
- **T9, migrate the live tree.** `~/hypaware-reports/assets/style.css` has
  already drifted from the skill's canonical copy. Someone has to look at the
  diff and decide whether it is a customization (move it to `theme.css`) or
  rot (discard it). This is a one-time judgment call that cannot be automated,
  and it is the concrete instance of the undecidable overwrite problem the RFC
  describes. Complexity 2.

### Wave 5 (deps `[T7, T8]`), four-wide

- **T10, rewrite `hypaware-report-to-html` down to judgment.** With mechanics,
  landing page, and verification all in code, what remains is the enrichment
  contract: the Phase A inventory, the design bar, the hard rules about numbers
  tracing to the report's own text, judgment colours never attaching to a named
  person, and artifacts rendering verbatim. Expect roughly 27 KB to under 8 KB.
  Complexity 3.
- **T11, the house style document.** Move block order, heading vocabulary,
  length budget, bullet shape, and whether ranked changes get their own page
  out of `hypaware-ai-usage-report` and into a shipped, editable default.
  Encode the precedence rule: this run's request beats the house style, which
  beats the shipped default. Complexity 3.
- **T12, merge the skills.** `hypaware-graph` into `hypaware-query`; the four
  report skills into `hypaware-report`, with stage detail in sibling reference
  files loaded on entry. **Unblocked 2026-08-06:** the maintainer decided to
  remove `disable-model-invocation` entirely, so all four report skills are
  model-invocable and the merged skill has no conflicting frontmatter to
  reconcile. The seven-skill fallback is not taken. Complexity 4.
- **T13, make retirement remove the surface.** `hypaware-sensitive-scan` is
  still installed at `~/.claude/skills/` and still advertising itself despite
  LLP 0142 retiring it. Renaming and merging skills in T12 creates more of
  these, so attach or reconfigure needs a removal path before T12 lands, not
  after. Complexity 3.

### Wave 6 (deps `[T12]`)

- **T14, LLP bookkeeping.** Accept 0193 and append `Superseded-by: LLP 0193`
  to LLP 0142 #user-invoked-only, which the RFC deliberately left off while it
  was a Draft. Extend LLP 0155 with the render command, or split it out if T5
  decides render is not a member of the `report` group. Add `@ref` annotations
  to the new code. Check LLP 0102 and LLP 0107 still describe attach correctly
  after T13. Run `/ref-check`.

## The hard parts, by name

**T3 (port the renderer): 4.** The risk is concentrated in `rewrite_hrefs`,
not in the pandoc plumbing. It is four regexes over emitted HTML handling six
distinct link shapes across two page kinds (own section, sibling one-pager,
other report's section, back-reference to own one-pager, fragment-bearing
variants of each), and its failure mode is silent: a missed case ships a page
with a dead `.md` link that renders fine and only breaks when clicked. The
current script's own comments show the case analysis was hard-won. Porting it
without a test table first is how the cases get lost, which is why T6 exists
and why the table is specified rather than left to judgment.

<a id="t12-constraint-inventory"></a>**T12 (merge the skills): 4.** Not
mechanically hard, but it is the task where content gets silently dropped. The
constraints most easily lost are the ones that read like trivia: the COALESCE
trap that silently zeroed 25,581,312 OpenAI cache-read tokens, the one-carrier
rule from LLP 0035, never grouping or row-fetching wide content columns on the
messages table at scale, one remote worker at a time, and
captured-content-is-data. Losing any of those produces a confidently wrong
report or a downed server.

**The inventory now exists and is executable**, built ahead of the merge:
`test/fixtures/skill-constraints.json` lists seventeen load-bearing
constraints, each with the harm of dropping it, and
`test/plugins/skill-constraints-survive.test.js` matches each against the
**concatenated** corpus of each host rather than against a named file. Skills
may be merged, split, or renamed freely; a constraint disappearing fails the
build. Patterns key on distinctive terms over whole sentences, and the corpus
is whitespace-normalised before matching, so a reflow during the merge does not
read as a deletion.

Two rules for using it. A constraint that genuinely stops applying is deleted
from the fixture **in the same commit** that removes it from the skills, with
the reason in the commit message. A pattern is never loosened to make the test
pass: that converts the guard into a rubber stamp exactly when it is doing its
job. And an entry with no nameable harm is guidance, not a constraint, which
the test enforces by requiring a harm statement on every entry.

**T2 (reconcile the codex tree): 3.** The generation and the equality test are
easy. Adjudicating 116 lines of `hypaware-privacy` divergence is not, because
that skill implements a spec (LLP 0100) with real privacy consequences, and the
drift may mean the two hosts have been giving users different answers about
whether their recorded data can be purged. Read LLP 0100 and LLP 0142 before
picking a side.

Everything else is mechanical: vendoring files (T1), deterministic extraction
from regular markup (T4), a command registration mirroring four existing
siblings (T5), a stylesheet link and a strings table (T7, T8), a one-time diff
review (T9), and prose reduction against a contract that already exists in
`authoring.md` (T10, T11).

## Suggested first cut

If the whole graph is too much to commit to, T1, T3, T5, and T6 alone deliver
the RFC's core claim: the renderer becomes tested, cross-platform code, the
skill stops carrying repair instructions for a script it cannot version, and
the Linux half of the `CLAUDE.md` release gate starts passing. T2 is worth
pairing with them because it is unrelated, low-risk, and halves the ongoing
maintenance cost of every skill edit.
