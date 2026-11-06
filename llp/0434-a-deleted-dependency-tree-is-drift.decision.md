# LLP 0434: A deleted dependency tree is drift

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Daemon, Clients
**Author:** Neutral / Claude
**Date:** 2026-09-25
**Related:** LLP 0404 (#install-policy, extended here), LLP 0045 (client attach), issue #1607, issue #1619, issue #1624

> The staleness test a recorded CLI path is judged by gains one arm: a
> recorded command whose outermost `node_modules` is no longer on disk
> is drift, so `hyp client attach claude` reaches the adapter instead of
> reporting "already attached". A recorded path that merely stopped
> resolving is untouched.

<a id="rule"></a>**The tree decides, not the bin.** LLP 0404's
project-tree predicate answers "is this copy of the CLI temporary?" by
asking whose `node_modules` it sits in: a project's carries a manifest
beside it, a package manager's own global root does not. That question
is exactly right for an entrypoint the current process is running from,
because nothing can be running out of a tree that is not there. It is
wrong for a path written down earlier. The manifest that proved the tree
was a project's is deleted with the project, so the recorded command
reads durable again in the one end state where it is certainly dead, and
the repair lane issue #1607 opened is closed on the machine it exists for
(issue #1624).

So the recorded form of the predicate answers "ephemeral" in one more
case: the outermost `node_modules` on the recorded path is gone. That
tree is package-manager-owned by construction, and its absence is not
ambiguous, because a package manager is the only thing that puts a CLI
under one.

<a id="fence"></a>**A path that merely stopped resolving is not drift.**
The rule is deliberately not "the recorded bin is gone from disk". A CLI
moves for ordinary reasons - a node version switch, an `npm config set
prefix` - and a missing file cannot tell those apart from a deletion.
Both of those reasons also leave the old install exactly where it was
and only stop resolving it on `$PATH`, so the global roots they move
between keep their `node_modules` and go on answering durable. A
recorded path carrying no `node_modules` at all is never judged by
existence, however little of it is still there.

<a id="cost"></a>**What a wrong answer costs.** A false "drift" costs one
re-attach that rewrites the same settings file with the same values;
`markerFormatStale` is read only by a CLI-initiated `hyp client attach`,
so nothing reconciles on a timer. A false "durable" costs silent capture
loss, because the hook contract is exit-0-and-be-silent. The arm is
therefore added to the recorded predicate only, and the live-entrypoint
predicate LLP 0404 settled keeps the answer it has: an unreadable
manifest stays "durable" there, and no warning is invented on a machine
with nothing wrong with it.
