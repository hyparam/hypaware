# LLP 0350: A Substituted Codex Workspace Key as Capture Evidence

**Type:** RFC
**Status:** Draft
**Systems:** Plugins, Sources, Usage-Policy, Privacy
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-01
**Related:** LLP 0032, LLP 0049, LLP 0050, LLP 0069, LLP 0083, LLP 0121,
LLP 0151, LLP 0160;
hyparam/hypaware#1189, hyparam/hypaware#492, hyparam/hypaware#481,
hyparam/hypaware#476, PR #477, PR #1076, PR #1198;
hyparam/hypaware-server#413 (server LLP 0327, out of tree)

> The Codex live projector may stamp `git_remote` from a `workspaces` key it
> **guessed**, on a row whose `.hypignore` verdict was decided for a different
> directory. `@ref LLP 0083#workspace-key-ranks-last` settled that on purpose:
> the guessed key loses the `cwd` and keeps enrichment, and the resulting
> "ignored tree's identity on a clean row" case is named there and filed as
> hyparam/hypaware#492, still open and still awaiting a human call.
>
> What is changing is not the projector but the **proposed meaning of the
> field**. PR #1076 (open, unmerged, docs and tests only) would document
> `inventory = "session_repos"`: GitHub capture takes every repository
> appearing as `git_remote` on an admitted `ai_gateway_messages` row. That
> would promote `git_remote` from decoration to a capture-authorizing signal,
> under which a guessed value authorizes fetching a repository the user marked
> `ignore`.
>
> This document states the case, the verified evidence, the design tension, and
> the options. It decides nothing. Deciding it means changing what LLP 0083
> settled, which is not a change a bug fix may make on its own authority.

## Context {#context}

`.hypignore` is scoped by a session's `cwd`
([LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope)) and enforced in
the client adapter, the only place that resolves one
([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)). For Codex,
[LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md) ranks the sources of
that one `cwd`: **in-band, rollout, workspace key**.

The last of those is a guess. `selectCodexWorkspace`
(`hypaware-core/plugins-workspace/codex/src/exchange-projector.js`) looks for a
`workspaces` turn-metadata key equal to the request's `cwd` and, finding none,
substitutes **the first key in the object**:

```js
const workspacePath = workspacePaths.find((key) => pathsEqual(key, cwd)) ?? workspacePaths[0]
```

LLP 0083 took the `cwd` away from that guess and deliberately left it everything
else:

> The key keeps its enrichment role (`attributes.codex.workspace`, `git_remote`,
> `git_commit`, `has_changes`) and remains the **last resort** for the `cwd` on
> the subscription route.

and named this exact consequence, in the same bullet:

> Because the key keeps enriching, a row recorded where it used to drop (an
> ignored declared workspace outranked by a clean `cwd` [...]) carries that
> workspace's identity even though the directory it names is
> `.hypignore`-ignored: the gate is scoped by `cwd`
> ([LLP 0049](./0049-hypignore-usage-policy.spec.md#scope)), not by enrichment
> source (#481).

[LLP 0160](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md) later
narrowed which substitutions get *logged* and left enrichment alone: whether to
suppress enrichment from a key that resolves to `ignore` "is a privacy-relevant
default that this document does not take", and it "stays open under #492"
([§0160 not-decided](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md#not-decided)).
#492 is open, labelled `neutral:stuck`, and says of itself that it "is a
decision rather than a defect and needs a human call".

## What is changing: `git_remote` as capture-authorizing {#evidence-contract}

**Status of the premise.** PR #1076 is **open and unmerged**, and it is docs and
tests only: `session_repos` appears nowhere on `master`, and no
`@hypaware/github` source exists in this repository at all. It is standalone
([LLP 0121](./0121-hermes-plugin-bundled.decision.md)) and the shipped query
skills describe its nodes as "server-only and opt-in", so the repricing below is
**proposed, not shipped**. If #1076 lands, this document's motivation is live;
if it is closed unmerged, the question falls back to the price #492 has carried
since PR #477, and this document should be re-read for that.

With that caveat, PR #1076 would document the default inventory for the
`@hypaware/github` source:

> Local `inventory = "session_repos"` captures every repository that appears as
> `git_remote` on an admitted `ai_gateway_messages` row.

That is a different job for the field. When LLP 0083 traded the leak away,
`git_remote` was **identity on a row the user could already see**: it named a
repository, it did not reach out and fetch one. Under `session_repos` the same
byte string becomes the evidence that authorizes capturing that repository's
commits, pull requests, issues, and reviews, on whichever host runs the source
and, via hyparam/hypaware-server#413, on the server that consumes the evidence.

So the trade LLP 0083 recorded was priced when the leak was decoration. Nothing
about the projector has drifted; the buyer is changing.

## Verified behaviour {#evidence}

**This reproduction is pre-#1198 and no longer reproduces as written.** Option
(F) has since landed (see [§options](#options)), so on the shape below a
covering key is now selected and the row carries `acme/clean`. It reproduces
unchanged on the **subscription** route, where no in-band `cwd` is stated: see
the second bullet of the landing note in [§options](#options). Kept as written
because the argument this document makes rests on it and because the
subscription half is still live.

Reproduced against `origin/master` at `b70026f6` by executing the real projector
and the real shared matcher (`createUsagePolicyResolver`), with a governing
`.hypignore` (class `ignore`) at `/work/ignored`:

- request body `cwd`: `/work/clean/sub` (not ignored)
- `x-codex-turn-metadata` `workspaces`, in this key order:
  `/work/ignored/secret-proj` (carrying
  `associated_remote_urls.origin = https://github.com/acme/SECRET.git` and
  `latest_git_commit_hash`), then `/work/clean`

Neither key equals the request's `cwd`, so the substitution fires and takes the
first. The exchange is **admitted**, and the row is:

| field | value |
|---|---|
| `cwd` | `/work/clean/sub` |
| `git_remote` | `https://github.com/acme/SECRET.git` |
| `head_sha` | `deadbeef` |
| `attributes.codex.workspace` | `/work/ignored/secret-proj` |

The admission is correct under
[LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope): the session
really did run in a clean tree. Under `session_repos`, that row is nevertheless
the evidence authorizing GitHub capture of `acme/SECRET`.

Two details worth having before choosing an option:

- **The projector already knows the key is a guess here.** The same run emits
  `plugin.codex.usage_policy_workspace_cwd_refused`
  (`error_kind: workspace_cwd_mismatch`, paths hashed), because
  `workspaceCoversCwd` finds the key is not an ancestor of the `cwd`
  ([LLP 0160 §decision](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md#decision)).
  The signal that would gate enrichment is computed on this path already; it is
  simply not consulted for the `git_*` fields.
- **That signal does not cover the whole case.** A key outranked by the
  **rollout** is discarded silently, by LLP 0083's own statement of its three
  limits, so `refused_workspace_cwd` is `undefined` on the subscription-route
  half even though the key is just as much a guess there. Any option keyed on
  the existing refusal covers the in-band half only, unless the predicate is
  also evaluated against the rollout's `cwd`.

## The tension {#tension}

Three settled positions meet here and no two of them are in conflict on their
own terms:

- [LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope): the gate is
  scoped by `cwd`. A session in a clean tree is admitted. Correct.
- [LLP 0083 §workspace-key-ranks-last](./0083-codex-live-cwd-from-rollout.decision.md#workspace-key-ranks-last):
  a guessed key may not decide a verdict but may still enrich. Correct as
  priced.
- [LLP 0032 §capture](./0032-github-llm-graph-bridge.decision.md#capture): the
  repo identity on the row is what bridges sessions to code review, and
  `session_repos` makes it the bridge's authorization too. Correct.

The gap is that no document says what a **guessed** enrichment value is allowed
to authorize. LLP 0049 is silent on enrichment sources; LLP 0083 priced the leak
as identity; LLP 0032 consumes the field without asking how it was derived. That
gap is the whole of this document.

## Options {#options}

Not exclusive: (F) narrows the case every other option then has to price, (B)
or (C) and (E) compose, and (D) is available to the server half independently.

**A. Accept and document.** Keep the projector as it is; say plainly, where
users read about `.hypignore` and about GitHub capture, that a repository named
by a `workspaces` key can be captured even when its checkout is `ignore`d, and
point at the GitHub source's own `ignore` list as the repository-level control.
PR #1076 has already landed the documentation half of this on its own branch.
Cheapest, and it is the honest option if the answer is that `.hypignore` was
never a repository-level control. It leaves the surprise in place: the user's
mental model is "I marked that tree ignore", and the row does not say the remote
came from somewhere else.

**B. Suppress enrichment from a key that did not cover the resolved `cwd`.**
When `workspaceCoversCwd` fails, drop `git_remote` and `head_sha` and their
`attributes.codex.*` mirrors: `workspace`, `git_origin_url`, `git_commit`, and
`has_changes`. Only those four; the rest of the `codex` namespace
(`thread_id`, `session_id`, `parent_thread_id`, `turn_id`, `thread_source`,
`originator`, `window_id`, `sandbox`, `lineage_source`, `lineage_conflict`,
`turn_started_at_unix_ms`) is conversation identity, client provenance, and
lineage, not enrichment, and dropping the lineage members would break
[LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md).
The row and its `cwd` stay. Small, local, uses a predicate that already
exists, and fails in the safe direction. On top of (F) it costs enrichment only
on turns where **no** key covers the resolved `cwd`; without (F) it also costs
the common benign turn whose covering key merely sorts second. To cover the
subscription route it must also run the predicate against the rollout `cwd`,
which LLP 0083 currently leaves silent by choice.

**C. Policy-check the guessed key before it may enrich.** Resolve the key
through the shared matcher and withhold enrichment only when the key itself is
`ignore`d. Narrower than (B): it keeps enrichment for benign mismatches and
withholds exactly the opted-out identity. Costs a second usage-policy resolution
per exchange on the hot path
([LLP 0049 R6](./0049-hypignore-usage-policy.spec.md#requirements) is the budget
to check it against), and it inherits the matcher's non-canonicalizing symlink
behaviour, so it is a control with a known bypass.

**D. Fix it on the evidence side.** Leave the projector alone and make
`session_repos` refuse a `git_remote` whose row shows the workspace and the
`cwd` disagree. Keeps the row honest and moves the decision to the consumer that
actually acts on it, which is also where the server half lives
(hyparam/hypaware-server#413). Requires the evidence query to see the
disagreement, which today means reading `attributes.codex.workspace` against
`cwd` per row, or option (E).

**E. Record provenance, decide later.** Stamp on the row whether `git_remote`
came from a key that matched the resolved `cwd` or from a substitution, and let
every consumer choose. Adds a field, which
[the repo's own rule](../CLAUDE.md) says not to do lightly, and it decides
nothing by itself. Its merit is that it makes (A) survivable: an accepted leak
that is *labelled* is a different thing from a silent one.

**F. Prefer the nearest key that covers the `cwd`.** Selection and refusal do
not use the same path test. `selectCodexWorkspace` matches on **equality**
(`pathsEqual`), while `workspaceCoversCwd` refuses on
**equal-or-descendant** (`isEqualOrDescendant`, the one shared rule of
[LLP 0069 R8](./0069-local-only-dir-selection.spec.md#requirements)).
So a key that genuinely covers the `cwd` can still lose to the first key in
the object: in the reproduction above, `/work/clean` covers `/work/clean/sub`
and is passed over for `/work/ignored/secret-proj` purely because the
comparison is a byte match. Preferring a covering key changes one expression in
`selectCodexWorkspace`, reuses 0160's predicate, costs no second policy
resolution, and loses no enrichment.

It must prefer the **nearest** covering key, not merely the first one the
object happens to list. A `workspaces` declaring both `/work` and `/work/clean`
for a `cwd` of `/work/clean/sub` has two covering keys, and taking `/work`
would enrich from the wrong remote and, because `/work` does cover the `cwd`,
also silence `refused_workspace_cwd`, removing the only signal that anything
was substituted at all. Nearest-governs is already the rule the gate itself
applies ([LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope),
`matchDepth` in `src/core/usage-policy/matcher.js`), so this reuses that rule
rather than inventing a tie-break.

One implementation trap, since this is the option most likely to be written
quickly: `pathsEqual` guards its argument (`if (!wanted) return false`) and
`workspaceCoversCwd` does not, so the covering test must be reached behind a
`cwd &&`. `selectCodexWorkspace` is called with the in-band `cwd`, which is
absent on the whole subscription route, and an unguarded call would throw
inside the projector on every one of those turns that carries a `workspaces`
map.

It is the narrowest option and it is not a substitute for the others: it
removes the reproduction in this document and the whole class where a covering
key exists, and leaves untouched the case LLP 0083 actually priced, where no
key covers the `cwd` at all and the first is still substituted. Nor does it
disturb what LLP 0083 settled, which is the **rank** of the sources for the
`cwd` (in-band, rollout, key), not which key the last of them picks. It is
therefore plausibly a defect fix rather than a design change, and the human
answering this document should say whether it is: if it is, it can land ahead
of the choice among (A)-(E) and shrink what that choice has to cover.

**(F) has landed, and it left more than the paragraph above says.** It landed
as PR #1198 on the reading that it is a defect fix, the ground being
[LLP 0160 §context](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md#context)'s
record of what LLP 0083 did and did not settle: *"It named the signal and its
`error_kind`; it did not state the predicate, which lived only in the code"*.
The predicate is the only thing (F) changes. **Three** residuals survive it, and
all three are inside the (A)-(E) question rather than beside it:

- the one the paragraph above names, where **no** key covers the `cwd`, the
  first is still substituted, and it still enriches;
- **the whole ChatGPT-subscription route**, which is the larger half and which
  the paragraph above does not name at all. `selectCodexWorkspace` is called
  with the *in-band* `cwd`, which that route never states, so the `cwd &&` guard
  the paragraph above correctly insists on also means the covering test never
  runs there: the first key is selected even when a covering key is in the same
  map, the row is admitted on the **rollout** `cwd`, and it carries the first
  key's remote with **no** `refused_workspace_cwd`, because that signal is
  computed from the in-band value too. Verified against the merged projector,
  the real `createUsagePolicyResolver`, and a rollout resolver, on
  [§evidence](#evidence)'s own workspace map: `cwd = /work/clean/sub` from the
  rollout, `git_remote = https://github.com/acme/SECRET.git`,
  `attributes.codex.workspace = /work/ignored/secret-proj`, no warn. This is
  [§evidence](#evidence)'s second bullet arriving on the selection side: closing
  it means running the predicate against the rollout `cwd`, which is the half
  every option has to price separately;
- a key that **does** cover the `cwd` and yet itself resolves `ignore`. A
  covering key is an *ancestor* of the `cwd`, and nearest-governs is not
  monotone down that chain
  ([LLP 0160 §decision](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md#decision)),
  so an ancestor marked `ignore` with a nested loosening at or under the `cwd`
  still enriches the admitted row with its remote, and, because it covers, does
  so with **no** `refused_workspace_cwd` at all. This is the one shape in which
  (F) **widens** the leak rather than only de-randomising it. Where the ignored
  ancestor already sorted first, `master` produced the identical row; where a
  **non**-covering key sorted first, `master` enriched from that key and
  warned. Verified both ways (`ignore` at `/work/outer`, `local-only` at
  `/work/outer/proj`, `cwd = /work/outer/proj/sub`): with `/work/clean` listed
  first, `master` stamps `acme/clean` plus a `refused_workspace_cwd` warn and
  (F) stamps `acme/SECRET` with none. Withholding it is option (C), which costs
  the second usage-policy resolution
  ([LLP 0049 R6](./0049-hypignore-usage-policy.spec.md#requirements)) does not
  budget for, so (F) records the case and leaves it to this document rather
  than taking (C) by the back door.

So (F) removes the **in-band** half of the class where a covering key exists,
not the class, and in the third case above it moves one narrow shape the other
way. What (A)-(E) must price is "a **guessed or `ignore`-resolving** key
enriches, on a route where the covering test may never have run". This
paragraph records verified behaviour of the code and takes none of the options.

## What this document decides {#decides}

Nothing. It exists so the question is asked once, in the corpus, with the
evidence attached, rather than a third time in a PR review.

The call needed is a single choice among the options above, and it is the same
call #492 has been waiting on since PR #477, now with a changed price. Whoever
makes it should also say whether the answer is scoped to Codex or is a general
rule about guessed enrichment feeding capture decisions, because the Claude
adapter derives `git_remote` from a source it does not guess and would be
unaffected either way.

## Consequences {#consequences}

- Whichever option is taken, what LLP 0083 **settled** is not edited: it
  recorded the trade correctly for the price at the time. The decision that
  replaces its enrichment clause is a new Decision document, and the forward-ref
  goes on the **old** doc: an
  `Extended-by: LLP NNNN` line appended to
  [§workspace-key-ranks-last](./0083-codex-live-cwd-from-rollout.decision.md#workspace-key-ranks-last),
  pointing at the new one, the way
  [LLP 0160](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md) is
  already recorded there. This RFC claims no such extension, because it extends
  nothing yet: it adds `LLP 0350` to that document's `Related:` line and no
  more, so the corpus reaches the open question from the record it questions.
- Options (B), (C), (E), and (F) change what rows carry and are therefore
  pinned by tests in `test/plugins/codex-exchange-projector.test.js`, over the
  real shared matcher rather than a stub. (F) lands beside the existing #476
  cases. (B) does **not**: "a refused workspace substitution still enriches the
  row from the workspace key (#476)" asserts precisely the `git_remote` and
  `head_sha` that (B) drops, so (B) overturns an accepted, currently-passing
  case and whoever implements it must rewrite that test and say why.
- Option (D) is a change to the `@hypaware/github` source and to the server that
  consumes the same evidence, so it cannot land in this repository alone.
- No option changes a cache schema, a partition declaration, or an export
  driver. (E) alone adds a field, and only to `attributes`.
- hyparam/hypaware#1189 and hyparam/hypaware#492 are the same underlying
  question at two prices. Answering this document answers both.
