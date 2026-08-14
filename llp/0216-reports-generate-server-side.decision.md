# LLP 0216: Reports generate server-side; the local report skill is retired

**Type:** Decision
**Status:** Accepted
**Systems:** Reports, Plugins, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-12
**Related:** LLP 0196 (#one-skill-per-question: the six-skill surface this reduces), LLP 0197 (#t12-constraint-inventory: the guard that caught what this dropped), LLP 0155 (the report CLI, which stays), LLP 0208 (the in-process renderer, unaffected), LLP 0213 (the other reduction landing the same day)

> Report generation moves to the server. `hypaware-report` is removed from both
> client trees: eight shipped Markdown files, and the only home of eleven
> load-bearing constraints. `hyp report` stays. This records the removal, and
> hands the eleven constraints to the server with the harm statements that
> justified them, so the receiving side knows what it has inherited rather than
> rediscovering it from an outage.

## Context {#context}

[LLP 0196](./0196-skills-state-constraints-not-procedures.rfc.md) reorganised
the skill surface by the question a user asks, and
[LLP 0197 T12](./0197-skills-state-constraints-not-procedures.plan.md) executed
it: four report skills merged into one `hypaware-report` with a short router
`SKILL.md` and six stage files (`reviewing.md`, `rendering.md`, `publishing.md`,
`applying.md`, `authoring.md`, `components.md`, plus `example-enrichment.md`).
It was, by some distance, the largest thing the client trees shipped.

Generating a report is analysis over a fleet's whole recorded history. That is
work the server is better placed to do than a laptop: it holds the data already,
it does not pay a remote round-trip per query, and it is the one place a
fleet-wide answer is even well-defined. Once generation lives there, a client
skill teaching a model to generate one locally is documentation for a workflow
the product no longer wants.

**The skill surface is now three**, on a default install: `hypaware-query`,
`hypaware-reference`, `hypaware-privacy`. LLP 0196's table and LLP 0197's T12
both describe six. Three separate changes took it from six to three, and until
this document only two of them were recorded:
[LLP 0212](./0212-session-opt-out-is-a-cli-verb.decision.md) retired
`hypaware-ignore` / `hypaware-unignore` into CLI verbs,
[LLP 0213 #d2](./0213-graph-plugin-always-active.decision.md#d2) merged
`hypaware-graph` into `hypaware-query`, and this one removes `hypaware-report`.

## Decision {#decision}

### D1: `hypaware-report` is removed from both client trees {#d1}

All eight files, both hosts, plus the registrations in `@hypaware/claude` and
`@hypaware/codex` (`skills.register` and `contributes.skills`) and the plugin
descriptions that named it. A skill left registered but deleted from disk is not
a cosmetic inconsistency: `hyp skills install` fails on the missing `sourceDir`.

### D2: `hyp report` stays {#d2}

`render`, `publish`, `list`, `get`, and `delete` are unaffected, and
[LLP 0155](./0155-report-cli.decision.md) and
[LLP 0208](./0208-report-renderer-drops-pandoc.decision.md) stand. `render` remains
a local build step over a reports tree; what changes is who writes the Markdown
it consumes.

**This is a decision to defer, not a conclusion.** A local renderer whose input
is produced remotely is a seam worth revisiting once the server side is real; it
is kept now because removing it would strand existing reports trees for no
present gain.

<a id="no-skill-needed"></a>**No replacement skill is needed for it.**
`hyp report --help` already states the split it needs to: `render` is local and
takes no `--remote` or credential, the other four talk to the server's reports
plane, reads use the login session, and publish/delete need the publisher role.
That is the LLP 0196 #mechanics-as-code position holding up: the command
explains itself, so its retiring skill leaves no hole. The one thing the help
does not yet say is where the Markdown comes from now.

### D3: eleven constraints transfer to the server {#d3}

`hypaware-report` was the **only** home of eleven entries in
`test/fixtures/skill-constraints.json`. They are removed from the fixture in the
same commit that removes the skill, which is the rule
[LLP 0197 #t12-constraint-inventory](./0197-skills-state-constraints-not-procedures.plan.md#t12-constraint-inventory)
sets for a constraint that stops applying, and the guard behaved exactly as
designed: it failed loudly, eleven times, rather than letting the deletion pass
unnoticed. **The fixture went 17 to 10** (eleven removed, four graph
constraints added by [LLP 0213](./0213-graph-plugin-always-active.decision.md)
in the same change).

They are recorded here in full, because a harm statement is the expensive part.
Most were written after something went wrong, and a server that re-derives them
from first principles will re-derive them from the same incidents.

Each entry gives the fixture's `id`, its **`pattern`** (the guard's own phrasing
of the rule, and the actionable half: a harm statement says why, a pattern says
what to do), then the harm. Where the pattern is a `|`-separated alternation it
is reproduced verbatim, because those alternates are the wordings the rule
actually shipped under.

**Report authoring and publishing** (six, unambiguously the server's now):

- **numbers-trace-to-source** - pattern: `NEVER invents, recomputes, or reinterprets`. Rendering re-expresses numbers already in the report. A renderer that computes its own produces figures no analysis backs.
- **artifacts-verbatim** - pattern: `Ready-to-apply artifacts are verbatim`. Proposed diffs and full skill files are the deliverable, not display copy. Trimming or rewording them produces an artifact that does not apply cleanly.
- **no-person-rankings** - pattern: `never person-rankings|never to individuals|never as an output-per-person`. The report is a team improvement tool shared in the open. Person-ranking turns it into a monitoring tool, which is the stated non-goal.
- **tokens-never-dollars** - pattern: `Tokens, never dollars|Token volume, never dollars`. Capture is partial, so a dollar figure would be a fabricated precision on top of an incomplete denominator.
- **confirm-before-publish** - pattern: `Never auto-publish as a side effect|Confirm before publishing`. Publishing is org-visible and immutable. Without an explicit yes it can happen as a side effect of generating a report.
- **confirm-before-source-edit** - pattern: `it edits the user's source files|Confirm before this step`. Enrichment rewrites report `.md` files in place, so without this a model can rewrite a user's reports off a prompt that never asked for it.

**Query discipline** (five, and see [#accepted-risk](#accepted-risk)):

- **coalesce-token-sums** - pattern: `COALESCE every token sum`. A provider that never emits a field (`cache_write_tokens` on OpenAI) makes `sum()` return NULL, and NULL poisons every total built from it. Measured on a real install: 25,581,312 OpenAI cache-read tokens silently became 0. The report is confidently wrong with no error.
- **no-wide-column-scans** - pattern: `Never GROUP BY / DISTINCT / row-fetch wide content columns`. This query shape has 504'd and then OOM'd the production server. It is a denial of service against the fleet's own infrastructure, caused by a report run. The pattern alone does not say *which* columns are wide; the enforceable form lived only in the skill, and is preserved under [#recovered-rule-text](#recovered-rule-text) below.
- **one-remote-worker-at-a-time** - pattern: `strictly one at a time against a remote`. Concurrent remote queries 502 the production proxy.
- **ask-which-source-first** - pattern: `Don't assume which logs to read|ask first`. Querying the wrong source silently answers about a different fleet, or hits a production server the user did not intend to touch.
- **per-change-approval** - pattern: `per-change approval|explicit per-change selection`. Applying changes mutates this machine's skills, subagents, and AGENTS.md. Blanket approval of a mixed list is how unrelated content gets persisted.

<a id="recovered-rule-text"></a>**Two rules survived only in prose the deletion
takes with it.** A fixture entry is an id, a pattern, and a harm; neither of
these is expressible in that shape, and neither has another home. Recorded here
verbatim so the server does not have to rediscover them.

- **The wide-column list, from `hypaware-report/reviewing.md`.** The actionable
  form of `no-wide-column-scans`: "Never GROUP BY / DISTINCT / row-fetch wide
  content columns (`cwd`, `content_text`) on the messages table at scale: that
  query shape kills servers." Its companions in the same bullet: use
  `ai_gateway_messages` only for per-message measures (token sums, distinct
  part/session counts, timestamps and ordering, `is_sidechain`/`agent_id`,
  `is_error`/stop-reasons, content sampling); slice long windows into
  server-sized date ranges; capture stderr and check it even on success, since
  truncation and server-cap notices land there.
- <a id="never-rm-the-sources"></a>**"The source `.md` files are the record:
  never `rm` them", from `hypaware-report/rendering.md`.** This one guards a
  surface that is **not** leaving: [D2](#d2) keeps `hyp report render` local.
  Its context, also from that file: `index.html` and `html/` are generated, so
  do not hand-edit them and expect the edits to survive; an archive pass moves
  the reports, `html/`, and `index.html` into `archive/<timestamp>/` and clears
  the top level (normal cycle: archive, generate, render, commit, and never
  render mid-archive). Whatever ends up documenting `hyp report render`, this
  is the sentence it must carry: it is the difference between a regenerable
  artifact and an unrecoverable one.

### D4: the content-boundary list shrinks but is not empty-able {#d4}

`query-skill-content-boundary.test.js` checked the boundary in
`hypaware-query/SKILL.md`, `hypaware-report/applying.md`, and
`hypaware-report/reviewing.md`. Two of those are gone, so the list is one entry.

The rule it enforces does not weaken: **anything shipped that reads recorded
content back carries the boundary.** The list is a register of what qualifies
today, not a budget that shrinks as files are deleted. The test says so in a
comment, so the next deletion does not read "one left, nearly done".

## Accepted risk {#accepted-risk}

<a id="accepted-risk"></a>**Two of the five query-discipline constraints
describe queries `hypaware-query` still tells a model to write, and they no
longer ship to the machines writing them.** `no-wide-column-scans` and
`one-remote-worker-at-a-time` are the two with production outages behind them:
a 504-then-OOM of the fleet's own server, and a 502 of the production proxy.
Both were reachable from a *report* run, which is the context that is leaving;
both are also reachable from an ordinary `hyp query sql` or a `--remote` query,
which is not.

The alternative considered was restating those five in `hypaware-query`, which
keeps them shipping wherever the queries are written. **The maintainer chose to
delete all eleven** (2026-08-12), on the basis that the analytical query shapes
that caused both outages belong to fleet-wide reporting, which is now the
server's, and that `hypaware-query`'s local use is ad-hoc session lookup rather
than aggregate scans.

Recorded rather than argued: if either failure recurs from a local query, this
section is where to start, and restating the two in `hypaware-query` is the fix
that was on the table.

## Consequences {#consequences}

- **Forward-refs to add**: LLP 0196 #one-skill-per-question's table row for
  `hypaware-report`, and LLP 0197 T12's six-skill outcome line, both now
  describe a surface that does not ship. Each gets a `Superseded-by: LLP 0216`.
- **The skill surface is three**, and the three remaining are each a distinct
  question: get facts out of the recordings, understand the product, audit what
  was captured. That is LLP 0196 #one-skill-per-question's own test, passed more
  cleanly than when it had six.
- **`test/fixtures/skill-host-divergence.json` no longer tracks
  `hypaware-report`.** It tracked 3 claude-only / 2 codex-only lines there;
  removing the entry is not a loosening, because the files it measured are gone.
- **The server inherits an obligation it did not write.** Nothing in this repo
  can test that the server honours [D3](#d3). The list above is the handoff.

## References {#references}

- [LLP 0196: Skills state constraints, not procedures](./0196-skills-state-constraints-not-procedures.rfc.md)
- [LLP 0197: Skills state constraints, implementation plan](./0197-skills-state-constraints-not-procedures.plan.md)
- [LLP 0155: Report CLI](./0155-report-cli.decision.md)
- [LLP 0212: Session opt-out is a CLI verb](./0212-session-opt-out-is-a-cli-verb.decision.md)
- [LLP 0213: The graph plugin is always active](./0213-graph-plugin-always-active.decision.md)
- `test/fixtures/skill-constraints.json`, `test/plugins/skill-constraints-survive.test.js`, `test/plugins/query-skill-content-boundary.test.js`
