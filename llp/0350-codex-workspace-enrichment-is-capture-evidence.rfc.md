# LLP 0350: A Substituted Codex Workspace Key as Capture Evidence

**Type:** RFC
**Status:** Draft
**Systems:** Plugins, Sources, Usage-Policy, Privacy
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-01
**Related:** LLP 0032, LLP 0049, LLP 0050, LLP 0083, LLP 0160;
hyparam/hypaware#1189, hyparam/hypaware#492, hyparam/hypaware#481,
hyparam/hypaware#476, PR #477, PR #1076;
hyparam/hypaware-server#413 (server LLP 0327, out of tree)

> The Codex live projector may stamp `git_remote` from a `workspaces` key it
> **guessed**, on a row whose `.hypignore` verdict was decided for a different
> directory. `@ref LLP 0083#workspace-key-ranks-last` settled that on purpose:
> the guessed key loses the `cwd` and keeps enrichment, and the resulting
> "ignored tree's identity on a clean row" case is named there and filed as
> hyparam/hypaware#492, still open and still awaiting a human call.
>
> What has changed since is not the projector but the **meaning of the field**.
> PR #1076 documents `inventory = "session_repos"`: local GitHub capture takes
> every repository appearing as `git_remote` on an admitted
> `ai_gateway_messages` row. That promotes `git_remote` from decoration to a
> capture-authorizing signal, so a guessed value now authorizes fetching a
> repository the user marked `ignore`.
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
narrowed which substitutions get *logged*, and explicitly "leaves the enrichment
question open under #492". #492 is open, labelled `neutral:stuck`, and says of
itself that it "is a decision rather than a defect and needs a human call".

## What changed: `git_remote` is now capture-authorizing {#evidence-contract}

PR #1076 documents the default local inventory for the optional
`@hypaware/github` source:

> Local `inventory = "session_repos"` captures every repository that appears as
> `git_remote` on an admitted `ai_gateway_messages` row.

That is a different job for the field. When LLP 0083 traded the leak away,
`git_remote` was **identity on a row the user could already see**: it named a
repository, it did not reach out and fetch one. Under `session_repos` the same
byte string is the evidence that authorizes capturing that repository's commits,
pull requests, issues, and reviews, on this machine and, via
hyparam/hypaware-server#413, on the server that consumes the evidence.

So the trade LLP 0083 recorded was priced when the leak was decoration. Nothing
about the projector has drifted; the buyer changed.

## Verified behaviour {#evidence}

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

Not exclusive: (B) or (C) and (E) compose, and (D) is available to the server
half independently.

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
When `workspaceCoversCwd` fails, drop `git_remote`, `head_sha`, `has_changes`,
and the `attributes.codex.*` mirrors, keeping the row and its `cwd`. Small,
local, uses a predicate that already exists, and fails in the safe direction.
Costs enrichment on every genuinely multi-workspace turn, including the common
benign one where the first key is simply a sibling of a clean tree. To cover the
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

- Whichever option is taken, LLP 0083 is **not** edited: it recorded the trade
  correctly for the price at the time. The decision that replaces its enrichment
  clause is a new Decision document carrying an
  `Extended-by:` forward-ref back to
  [§workspace-key-ranks-last](./0083-codex-live-cwd-from-rollout.decision.md#workspace-key-ranks-last).
  This RFC claims no such extension, because it extends nothing yet: it adds
  `LLP 0350` to that document's `Related:` line and no more, so the corpus
  reaches the open question from the record it questions.
- Options (B), (C), and (E) change what rows carry and are therefore pinned by
  tests in `test/plugins/codex-exchange-projector.test.js`, beside the existing
  #476 cases, over the real shared matcher rather than a stub.
- Option (D) is a change to the `@hypaware/github` source and to the server that
  consumes the same evidence, so it cannot land in this repository alone.
- No option changes a cache schema, a partition declaration, or an export
  driver. (E) alone adds a field, and only to `attributes`.
- hyparam/hypaware#1189 and hyparam/hypaware#492 are the same underlying
  question at two prices. Answering this document answers both.
