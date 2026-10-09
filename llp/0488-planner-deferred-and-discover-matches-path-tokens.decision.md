# LLP 0488: The Planner Is Deferred, and Discover Matches Path Tokens

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Graph, Query, Clients
**Author:** HypForge designer
**Date:** 2026-10-09
**Extends:** [LLP 0487](./0487-fastask-teaches-agent-directed-exploration.decision.md) (#decision items 1 and 2: the planner's place; what `discover` matches), [LLP 0480](./0480-fastask.design.md) (#command, #enablement, #discovery, #index), [LLP 0479#outcome](./0479-fastask.spec.md#outcome) (what ships first) and [LLP 0481](./0481-fastask.plan.md) tasks T13, T14 and T15
**Related:** LLP 0484 (discovery walks `touched`; build bounds), LLP 0485 and LLP 0486 (CPU and memory bounds)

> Two directions from Phil on October 9, 2026. First, ship the
> agent-directed capability and defer the deterministic planner until it is
> better. Second, `discover` must find what the tested prototype found: an
> operator replay of the current discovery code against the frozen graph
> missed the tested decision even with the successful agent's own terms,
> because terms only matched exact file basenames and stems.

## Provenance {#provenance}

- Defer the planner: Phil, 2026-10-09T07:01:20Z ("I think we don't need
  fastask until it's better"), in reply to whether the design matched the
  prototype; relayed by the operator and verified by the mayor
  (`fastask-defer-planner-20261009`).
- Discovery relevance: an operator replay of unmodified `index_builder.js`,
  `discovery.js` and the work-budget helper from `integration/fastask`
  `191fcb43` against the frozen graph (142,766 nodes, 462,042 edges), relayed
  by the mayor (`fastask-discovery-relevance-20261009`). The tested question
  missed at 8 and 40 leads (10 sessions considered); the earlier successful
  agent's own terms missed in the top 40; only a seeded `--file` hit. Anchors
  landed on unrelated files across many repositories.

HYP-111's text opens with "Ship `hyp fastask ...`". For the initial ship, this
direction supersedes that wording: what ships is the agent-directed
capability, under the same plugin and mission name.

## The planner is deferred {#planner-deferred}

- `hyp fastask "<question>"` is **not part of the initial shipped and enabled
  surface**. It is unregistered now, on `integration/fastask` (owner's
  mechanics, 2026-10-09 07:11Z): removed from the plugin's `index.js`
  registration, its manifest command entry and the client's product-telemetry
  `COMMANDS`. No skill text mentions, recommends or depends on it. Plugin commands `query team-graph discover`,
  `query team-graph neighbors`, `query team-graph search` and the verb
  `query evidence` are the shipped surface (LLP 0487), with `graph replica
  status|refresh`.
- **The code is kept** (`commands.js` `runFastask`, `output.js`) with its unit
  tests, for a later, separately validated evaluation that calls it directly.
  The T10 `fastask_query` hermetic smoke becomes an agent-path smoke that
  chains `query team-graph discover`, `neighbors`, `search` and `query
  evidence`.
- The server receiver keeps admitting the name `fastask` (vocabulary entries are
  never removed); an unused admitted name costs nothing.
- The plugin, the mission and the `fastask/1` JSON contract name stay.

## Discover matches path tokens {#path-tokens}

Replaces LLP 0480#discovery step 2's basename-and-stem matching for terms
(`--file` anchors keep exact and suffix resolution).

**Tokens.** Each File node's key is split into lowercase tokens: on `/`,
`-`, `_`, `.`, whitespace and camelCase boundaries. For a bridged key
(`owner/repo:relpath`) the tokens come from the relative path; for an
absolute key, from the path. Directory segments and basename parts are both
tokens; each token records whether it came from the basename. Example: a
file `docs/onboarding/0042-quick-setup-flow.decision.md` has directory tokens
`docs`, `onboarding` and basename tokens `0042`, `quick`, `setup`, `flow`,
`decision`, `md`. (A neutral example: the evaluation's target file is not
named in design text, so selection is never tuned to it.)

**Matching.** A term matches a token when they are equal, or, for terms of
four or more characters, when the token starts with the term (`onboard`
matches `onboarding`; `walkthrough` matches `walkthroughs`). Terms shorter
than three characters are dropped. Matching is never substring-anywhere, so
`setup` does not match `setuptools`. A term that itself contains separators
(`work_budget`, `parseRetryAfter`, `login.js`) is split by the same rule; a
file matches it only when every part of three or more characters matches one
of the file's tokens (order and adjacency not required), and it counts as one
term for ranking, weighted by its rarest part.

**Ranking.** A file's score counts the distinct terms it matches, weighting a
basename-token match above a directory-token match and an exact token above a
prefix, and weighting rarer tokens above common ones (inverse of the token's
file count). Files in the caller's repository rank first (bridged key with the
caller's `owner/repo`, or an absolute path under the caller's repository root);
files elsewhere are kept as candidates, ranked below, and marked unproven like
suffix matches. Ties prefer the more recently touched file. The 50 best files
become anchors (LLP 0480#discovery), grouped by the term set they matched for
the ambiguity rule.

**Bounds (how LLP 0484 applies).**
- *Index.* A token dictionary (token to integer) and a sorted token array for
  prefix lookup, plus per-token postings of File node indexes in typed arrays
  with a basename flag. They replace the basename and stem maps for term
  matching. Their bytes count in the build's running estimate and in the
  up-front estimate (LLP 0484#build-memory: `BYTES_PER_ROW` is re-fitted by
  T15's measurement; `MAX_INDEX_BYTES` stays 256 MB; the 1x index stays within
  its 128 MB target). Tokenizing runs inside the build's existing budgeted
  loops (LLP 0485).
- *Query.* Postings are read rarest term first. A token whose postings exceed
  5,000 files only scores candidates found through rarer terms, never seeds
  them alone. At most 60,000 postings are examined per call; reaching that
  sets `anchors_truncated`. The `touched` walk keeps its 20,000-visit budget.
  Warm discovery keeps the under-100 ms p95 target (LLP 0480#discovery).

## T13 acceptance case {#acceptance-case}

T13 (LLP 0481) adds the tested question as an acceptance case for the
agent-directed path: in fresh Codex and Claude chats with the shipped skill
text, an agent must reach the original decision through its own choice of
`query team-graph discover`, `neighbors`, `search` and `query evidence`, given
only the natural-language question: no file path, session ID or message ID.
The ground-truth session and message IDs stay out of candidate-selection
code, tests that tune selection, and skill text (HYP-111); they are used only
to grade. The case is also replayed deterministically: `discover` with the
successful agent's own terms must rank a session that touched the decision
document within the top 40 leads, with no `--file`. The deferred planner's
result on the same question is reported separately and is not a gate.

## Plan scope (LLP 0481) {#plan}

- **T15** implements LLP 0487 item 1 with
  this matching rule, reproduces the
  replay miss at `191fcb43` and the hit after the change (using the operator's
  harness without copying private run content into the repository), and
  re-fits `BYTES_PER_ROW`.
- **T13**: the acceptance case above; the agent-directed path is the primary
  condition; the planner is a separate, non-gating report.
- **T14**: ships the four operations and the agent-directed skill text; the
  planner is already unregistered.
- **T10's** `fastask_query` smoke is rewritten as the agent-path smoke (owner
  dispatch).

## Consequences {#consequences}

- One question remains for Phil, which does not block this decision: see the
  hand-back in the HypForge mission record.
- CPU and memory: index grows by the token postings (bounded as above);
  per-query work is bounded by 60,000 postings and the existing visit budget.
