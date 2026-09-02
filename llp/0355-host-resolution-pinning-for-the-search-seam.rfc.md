# LLP 0355: Host resolution-pinning for the `grep_search` seam

**Type:** rfc
**Status:** Draft
**Systems:** Query, MCP, Plugins
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-02
**Related:** LLP 0314, LLP 0353, LLP 0303, LLP 0293, LLP 0264, LLP 0302;
hyparam/hypaware#1215, PR #1213

> LLP 0353#refusals settled `GrepQueryError` as the one refusal channel a
> host-supplied `grep_search` backend raises and the verb translates. The
> translation is `err instanceof GrepQueryError`, and `instanceof` is
> nominal: it asks whether the thrown object's prototype chain contains
> the prototype of *this copy* of the class. A host whose `node_modules`
> carries two `hypaware` installs constructs the refusal from the second
> copy, the check is false, and a usage refusal reaches the caller as a
> failed search.
>
> This document is the request for the decision two review rounds and the
> triage of PR #1213 all deferred to it: how an injecting host pins its
> `hypaware` resolution so class identity holds across the seam, or what
> the kernel does instead. It states the failure precisely, carries a
> reproduction, and puts the options up with their costs. It decides
> nothing, and it reopens nothing LLP 0314 or LLP 0353 settled.

## Context {#context}

[LLP 0314](./0314-grep-search-one-registration-injected-backend.rfc.md)
(Accepted) removed the registration collision between the kernel's
`grep_search` verb and a server's own by making the data plane injectable:
`VerbOperationContext` gains an optional `search` backend and the one
registered verb calls it.
[LLP 0353](./0353-grep-search-injected-backend.design.md) (Active) is the
technical design that binds it to the tree, and PR #1213 is the
implementation, merged to `master` as `01a6c661`.

The seam is a package boundary. The kernel and the injecting host are two
repositories: the backend is written in `hypaware-server`, the verb that
calls it is in `hypaware`, and everything they must agree on travels
through the published `hypaware/core/search` entry. Values agree by value
(`SEARCHABLE_COLUMNS`) and shapes agree structurally (`GrepSearchResult`).
Exactly one thing on that surface agrees by *identity*: the class the
refusal channel is built on.

## What breaks, and for whom {#failure}

`src/core/search/grep_verb.js:162` on `master` (unchanged from PR #1213's
head `5ea0a56c`):

```
if (err instanceof GrepQueryError) throw new VerbUsageError(err.message)
throw err
```

`src/core/cli/verb_command.js:164-178` is where the kernel states the
distinction: a `VerbUsageError` writes the message, then a `usage:` line,
and returns **2**. Anything else writes the message and returns **1**. That
is the rule, not the failing path. `runVerbCommand` builds its own operation
context through `buildOperationContext`, which returns a seven-field literal
and never carries a caller's `search`, and `verb_command.js:174` is the only
place in this repository that reads `VerbUsageError` for an exit code. So the
one in-tree surface that maps the two classes to exit codes is also the one
surface an injected backend can never reach; the failure needs a host that
does both, and that host is out of tree (condition 1 below).

The install topology that breaks it, stated exactly:

1. A host builds its own `VerbOperationContext` and sets `search`. No
   in-tree host does this: `buildOperationContext`
   (`src/core/cli/verb_command.js:212-222`) sets seven fields and never
   `search`, and `hyp mcp serve` uses that same builder. The only reachable
   caller today is out of tree.
2. That host's backend refuses an argument the way LLP 0353#backend-contract
   requires (regex gated to the operator, `includeLocalOnly` unsupported,
   a malformed pattern), constructing `GrepQueryError` from
   `hypaware/core/search`.
3. The host's dependency graph resolves `hypaware` to **two** installs, so
   the specifier the backend module resolves and the specifier the running
   kernel resolved are different files. Node keys the ESM module cache by
   resolved URL, so the two copies define two distinct class objects.

Then the refusal is a plain failed search: exit 1, no usage line, in
whatever that host's own equivalent of `verb_command.js:164-178` is. The
**message still surfaces** (any mapping of this shape writes it before it
branches on the class, as `verb_command.js:166` does), so the operator is
told what is wrong; only the exit class, which is what a script reads, is
wrong.

Three facts bound the blast radius, and a decision should not overstate it:

- **MCP is unaffected.** `src/core/mcp/server.js:143-148` maps every throw
  from a tool to `isError: true` with the message. A `VerbUsageError` and
  a bare `Error` are already indistinguishable there, so the degradation is
  CLI-exit-code-only.
- **Nothing in this repository can reach it**, now that PR #1213 has landed,
  because no in-tree host injects. It is a contract defect at a
  seam whose only consumer is out of tree, which is why triage classified
  it a preference rather than a blocker.
- **No injecting host is named that has exit codes at all.** LLP 0314#decision
  names exactly one injection site: "The server then supplies the backend in
  the operation context it already builds per org (`buildMcpAssembly`)". That
  is an MCP assembly, and the first bullet says the distinction is already
  flat there. So the failure needs a host that injects `ctx.search` *and*
  maps `VerbUsageError` to an exit code itself, and no such host is named in
  this repository, in LLP 0314, or in LLP 0353. A decision has to weigh that
  either way: it is an argument that the defect has no observer today, and it
  is equally an argument for settling a published contract before the host
  that would trip on it is written. This document does not choose between
  those readings.

Nothing *declares* the single-copy requirement, and the lever that would
enforce it is not this repository's to pull. npm's own default hoisting
already resolves to one copy whenever the requested ranges are compatible, so
the topology takes more than an ordinary install; the rest of this paragraph
is what that "more" is. `hypaware` declares no `peerDependencies` today, but
adding one would not help: a package's `peerDependencies` constrains what
*its own* consumers must supply, and has no bearing on whether that package
is itself deduplicated in a consumer's tree. Only a package that depends on
`hypaware` can declare it a peer, and only the root project can force one
copy through `overrides`. Both are host-side. Meanwhile `hypaware` is
depended on as an ordinary dependency, and two dependents wanting
incompatible ranges is the ordinary way npm produces a nested install, just
as a `file:`/`link:` checkout beside a registry install is the ordinary way
a developer produces one by hand.

## Reproduction {#evidence}

Two installs of one package, a host that imports the class from its nested
copy, a probe that imports it from the hoisted one:

```
node_modules/hypaware/src/core/search/index.js          (copy A)
node_modules/host/node_modules/hypaware/...             (copy B)
node_modules/host/index.js   imports GrepQueryError, throws it
probe.mjs                    imports GrepQueryError, catches it
```

Output:

```
kernel class === host class: false
err.name: GrepQueryError
err instanceof GrepQueryError: false
```

The class bodies are byte-identical and the version strings match. Nothing
about the two copies is wrong except that there are two of them.

## What is already settled, and stays settled {#settled}

This request does not reopen any of the following. They are the constraints
a decision has to work inside.

- **The refusal channel is `GrepQueryError`.** LLP 0353#refusals:
  "A supplied backend refusing an argument ... throws `GrepQueryError` ...
  No new error type, no verb change beyond what section 2 already makes."
  A decision here may change how the verb *recognises* that class. It may
  not replace the class with a second error type or a result-shaped
  refusal.
- **A refusal is exit 2 at every surface that has exit codes.**
  LLP 0293#one-contract settles the rule (a caller's argument mistake is
  exit 2, not exit 1 through a downstream failure); LLP 0302#usage-exit and
  LLP 0303#query-refusal-exit apply it to this verb. That is the property
  the split identity breaks, so it is the property a decision must restore
  or explicitly give up.
- **The seam args carry caller intent only.** LLP 0353#seam rejected the
  RFC's literal `ctx.search ?? executeGrepSearch` sketch precisely so host
  wiring stays out of the backend signature. Handing the backend a
  constructor, a factory, or an error namespace through its arguments is
  the thing that decision refused, and this document does not propose it.
- **`--remote` routing is out of scope.** LLP 0353#unchanged. The second
  residual filed on #1215 (the malformed-result guard covering `operation`
  and not `--remote`) is a different defect on a different path, pre-existing
  on master, and is not opened here.

## Why the wiring check LLP 0353 already mandates does not catch this {#allowlist-blind}

LLP 0353#summary-drift puts one check in the injecting host: "at wiring ...
compare the host's own allowlist against the `SEARCHABLE_COLUMNS` it imports
from `hypaware/core/search`, and fail that wiring loudly".

Round 2 of PR #1213's review established that this check is blind to the
topology above, and the reason matters for the option space: it compares
sets **by value**, and two copies of the same release carry identical
values. The check is doing its job (it detects a diverged allowlist, which
is what it was designed for) and a duplicate install is not divergence. Any
answer here needs its own mechanism; extending the allowlist assertion is
not one of the options.

## Options {#options}

Not exhaustive, and not ranked. Costs are stated so a decision can be made
against them rather than around them.

### Option 1: accept and document the single-resolution requirement

State on `GrepSearchBackend`'s doc comment (and in an extension to LLP 0353)
that a host injecting `ctx.search` MUST resolve `hypaware` to exactly one
install, and that the refusal channel is identity-based. No code change.

- Cheapest, and true to what the design already assumes.
- Nothing enforces it. The failure stays silent and stays a wrong exit code
  that only a script notices, at a host that has no reason to suspect its
  own `node_modules` layout.
- Documents a requirement in the kernel that only the host can satisfy, in
  a file the host reads only if it goes looking.

### Option 2: brand the class with a `Symbol.for` key and recognise the brand

`GrepQueryError` sets a well-known registered symbol on itself; the verb
checks the brand instead of, or in addition to, `instanceof`. The symbol
registry is per-thread, not per-module and not per-realm, so two copies
loaded in one thread agree.

- Fixes the reported case with a few lines and no new dependency.
- Changes the recognition mechanism on a published class: the brand becomes
  part of the cross-repo contract. An older `hypaware` copy constructs an
  unbranded instance a newer verb does not recognise, but that sub-case is
  not a regression: an older copy is a distinct copy and already fails
  `instanceof` today. The cost here is the contract, not the skew.
- Weaker than `instanceof` against forgery, though not as weak as a name
  check: a foreign module has to reach for the registered symbol on purpose
  rather than merely name a class `GrepQueryError`. Whether "on purpose" is
  the right bar is the decision.
- Thread-scoped, not process-scoped: a `worker_threads` worker is a separate
  isolate with its own registry, and a value crossing that boundary is
  structured-cloned, which drops symbol-keyed properties anyway. A `vm`
  context is a separate realm but *shares* the thread's registry (its
  `Symbol` is a different constructor, yet `Symbol.for(k)` returns the same
  symbol), so a brand does carry there. It fixes duplicate *installs* within
  a thread, not duplicate *threads*.

### Option 3: the kernel exports a type-guard predicate it owns

Publish `isGrepQueryError(err)` from `hypaware/core/search` and have the
verb use it.

- Puts the recognition rule in one place the kernel controls, so a later
  change to the rule is one edit rather than a contract renegotiation.
- On its own it fixes nothing: a predicate imported from copy A still closes
  over copy A's class. It is only a fix in combination with option 2 or 4,
  and its real value is that it makes those changeable later.

### Option 4: an assertable identity token, checked at wiring

The kernel exposes the identity a host must match (the class itself, or a
token object reachable from the assembly the host boots), and the host
asserts at wiring that the `hypaware/core/search` it imports is the one the
kernel it registered against is running, failing loudly with both resolved
paths.

- Turns a silent wrong exit code into a loud boot failure naming the actual
  cause, which is the diagnosis nobody currently gets.
- Symmetric with the check LLP 0353#summary-drift already puts at the same
  place in the same host function, so it costs the host one more assertion
  rather than a new integration point.
- Needs a new exported thing on the kernel surface whose only purpose is to
  be compared, and needs the host to have something to compare it against,
  which today it does not: nothing the kernel hands out carries the class.
  What that thing is, is most of this option's design work.
- Enforced only in hosts that run the assertion. It is advice with a
  failure mode, not an invariant.

### Option 5: keep `instanceof`, make the miss legible

Leave the exit class alone and add a diagnostic: an error that is not a
`GrepQueryError` by identity but claims the name is still exit 1, and the
verb writes one line saying a refusal-shaped error arrived from a different
`hypaware` copy.

- Accepts no forgery, because the name never changes what the caller gets,
  only what the caller is told.
- Smallest possible change to a settled channel, and it is the only option
  that improves the *diagnosis* without touching the contract.
- Does not fix the reported problem. Exit 1 stays wrong; the operator is
  merely told why.

### Option 6: reject and document

Record that the degradation is accepted permanently, that a duplicate
install is a host packaging defect, and close the question.

- Honest, and consistent with triage's own classification.
- Leaves a documented silent wrong answer at a seam this repo built on
  purpose for an out-of-tree consumer that has not yet been written against
  it, which is the moment when changing it is cheapest.

## What a decision needs to say {#decision-needs}

1. Whether the exit-2 property survives a duplicate install, or is
   explicitly given up for that topology.
2. If recognition changes: what the new mechanism is, what it costs against
   forgery, and what happens on version skew between the two copies (a
   backend from an older `hypaware` refusing against a newer verb).
3. Where enforcement lives. The kernel cannot observe the host's wiring
   (LLP 0353#summary-drift already says so for the allowlist check, and the
   same is true here), so anything assertable is asserted by the host, and
   the decision has to say what the kernel hands the host to assert with.
4. Whether the requirement is stated as a packaging constraint in the
   injecting host's manifest, a documented contract line, a runtime
   assertion, or some combination. `#failure` bounds the packaging option:
   the constraint is `overrides` when the injecting host is the root project,
   and a `peerDependencies` declaration only when that host is itself a
   library its own consumer installs. Neither has any effect stated in this
   repository's manifest.
5. Whether it extends LLP 0353 or supersedes `#refusals`. LLP 0353 is
   Active, so the answer lands as a new document with a forward-ref on
   0353, not as an edit to it.

## What this document does not open {#not-opened}

- The seam's argument shape, the local adapter closure, the limit clamp
  placement, or the completeness-fact guard. All settled by LLP 0353 and
  verified at PR #1213's head by two review rounds.
- The `--remote` shape check (#1215 item 2). Out of scope per
  LLP 0353#unchanged, on a path the seam never reaches.
- Whether `grep_search` should have one registration. Settled by LLP 0314,
  Accepted.
- The registry, `unregister`, and the LLP 0264#verb displacement rule, which
  LLP 0314#sequencing keeps in force.

## References {#references}

- LLP 0314 `#decision`, `#backend`, `#sequencing`: the accepted request.
- LLP 0353 `#refusals`, `#backend-contract`, `#summary-drift`, `#unchanged`:
  the technical design this extends.
- LLP 0293 `#one-contract`: the rule that a caller's argument mistake is
  exit 2, which is what the failure breaks. LLP 0302 `#usage-exit` and
  LLP 0303 `#query-refusal-exit` apply that rule to this verb.
- LLP 0303 `#completeness-signals`: `truncated` and `exhausted` as two
  independent facts, which is what the seam's result guard checks for and
  is not itself an exit-class rule.
- LLP 0264 `#shared`: why the refusal kind lives in the shared module at all.
- PR #1213, review round 1 and round 2 comments and the triage note: the
  three deferrals and their reasoning.
- hyparam/hypaware#1215: the follow-up issue this document answers, item 1.
