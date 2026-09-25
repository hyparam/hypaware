# LLP 0412: The compact sign-in line drops the lookup pointer

**Type:** Decision
**Status:** Superseded
**Superseded-by:** [LLP 0435](./0435-wizard-screen-model.rfc.md) (#recap: the compact sign-in prints no forwarding line; the wizard's recap states what syncs)
**Systems:** CLI, Onboarding, Usage-Policy
**Generated-by:** neutral
**Author:** Kenny / Claude
**Date:** 2026-09-16
**Extends:** [LLP 0100](./0100-enrollment-privacy-review.spec.md)
(#requirements R1a: the compact join lane's forwarding line no longer
carries the `hyp remote list` lookup, so the lookup clause is relaxed for
that lane); [LLP 0387](./0387-compact-join-r1a-is-satisfied-by-an-adjacent-pair.decision.md)
(#adjacency: the adjacent pair now carries R1a's name and no-URL clauses,
not its lookup clause)
**Related:** LLP 0407 (#plain-words: the same PR's plain-language pass on
the onboarding screens), LLP 0131 (#attended-only: the compact lane is
still reachable only from the attended wizard), hyparam/hypaware#1774

> The wizard join lane's compact sign-in line reads
> `✓ Logs will sync to the '<name>' server`. It no longer appends
> `(run 'hyp remote list' to see its URL)`.

## Decision {#compact-lookup-dropped}

The compact enrolling-login lane does not print the `hyp remote list`
lookup pointer. Its forwarding line names the server by its configured
target name and prints no URL, and nothing in the compact lane names the
command that maps the name back to a URL.

This is a product call by the maintainer (platypii), made on PR #1774
after neutral restored the pointer there (commit 98ec24b9) and the triage
rung upheld the restore. The maintainer's stated reason: users don't care
about the pointer on this line. The call is theirs to make on their own
onboarding copy, and this doc records it so the tree and its Accepted
spec stop pointing in opposite directions.

## Scope {#scope}

Compact lane only. The wide lane is untouched: `hyp remote login` outside
the wizard still prints the lookup on its own line under the forwarding
line, and its privacy block still names `hyp remote list`, exactly as
LLP 0100 R1a requires of it. `hyp sync`'s plan output keeps its own lookup
string, and the connected-elsewhere error paths keep their bare origins
(R1a binds the success surfaces only). Only the compact sign-in line
changed.

## Consequence {#consequence}

In the compact lane a user sees a server name that may be one they never
typed (a bare login resolves its target from `effectiveDefaultRemote`),
with neither the server's URL nor an in-lane way to resolve the name to
one. That resolvability is the auditability property R1a was written to
protect, and the compact lane no longer provides it. `hyp remote list`
still exists and still answers the question; the lane just does not name
it.

LLP 0387's #adjacency reading narrows accordingly: the forwarding line
and the deadline line are still one surface, and the pair still carries
the server name and the no-URL rule, but it no longer carries the lookup.
The adjacency constraint itself (the two lines stay consecutive, the
forwarding line keeps the name) still binds; only the lookup half is
gone.

## What would reverse this {#reversal}

The maintainer deciding the pointer earns its place after all, or the
compact lane becoming reachable outside the attended wizard (the case
LLP 0387 #scope already names as expiring its reading), which would
reopen the question of what the lane must carry on its own. Either would
be a new LLP extending this one.
