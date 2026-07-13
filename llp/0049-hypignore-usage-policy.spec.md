# LLP 0049: hypignore usage policy

**Type:** Spec
**Status:** Accepted
**Systems:** Sources, Gateway, CLI
**Author:** Phil / Claude
**Date:** 2026-06-29
**Related:** LLP 0000, LLP 0009, LLP 0012, LLP 0016, LLP 0050, LLP 0051, LLP 0083

> A folder-scoped data-usage policy for HypAware capture. A `.hypignore` file
> (gitignore-style, ancestor-walked) maps a directory subtree to a usage
> **class**. V1 ships exactly one class — `ignore` (never recorded). Managed by
> a `hyp ignore` / `hyp unignore` CLI. The *where* of enforcement is
> [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md); deferred classes
> (`local-only`) and the ephemeral session opt-out are
> [LLP 0051](./0051-usage-policy-future-extensions.decision.md).

## Motivation

Today the `@hypaware/claude` `hypaware-ignore` / `hypaware-unignore` skills
*describe* two opt-out mechanisms — a per-session in-memory drop
(`POST /_hypaware/ignore/session`) and a committable `.hypignore` ancestor file —
but **neither is implemented**: the endpoint route does not exist and no code
reads a `.hypignore`. Users have no working way to tell HypAware "do not record
work done in this directory."

This spec defines the missing mechanism, and deliberately frames it as more than
a binary toggle: a `.hypignore` declares *how* data from a directory subtree is
used, so the same file format can carry richer classes (e.g. record-locally-but-
never-export) later without a repaint.

## The model: scope → class

The mechanism is a single function: resolve a **scope** to a **usage class**.

- A **scope** is a directory subtree.
- A **class** says how exchanges originating in that subtree are used.
- Everything else — the file format, the CLI, the matcher — is authored once;
  only *enforcement* differs per class.

This unifies "a `.hypignore`" and "a local-only flag" into one feature with one
authoring surface and a small, extensible class set, rather than two unrelated
features that happen to ship together.

## Scope and matching {#scope}

A captured exchange is matched to a scope by its **`cwd`** (and, equivalently,
its `repo_root`). HypAware already associates these with every Claude/Codex
exchange — the client hook records `cwd`/`repo_root`/`git_remote` into
`session-context.jsonl` and the exchange projector stamps them onto each row
(`claude/src/projector.js`).

Resolution is **gitignore-style ancestor walk**: from the exchange's `cwd`, walk
up the directory tree; the **nearest** ancestor containing a `.hypignore`
governs. Because V1 has only `ignore` and no "un-ignore" directive
(see [File format](#file-format)), this collapses to a simple rule:

> **any `.hypignore` found walking up from an exchange's `cwd` ⇒ the exchange is
> ignored.**

`repo_root` is the natural place to drop one file to cover a whole repo, but the
mechanism is not repo-bound: a `.hypignore` anywhere in the ancestor chain
(including outside any git repo) governs its subtree.

## Classes {#classes}

| Class | V1 | Meaning |
|-------|----|---------|
| `ignore` | **shipped** | Exchange is never written to the cache. |
| `local-only` | reserved | Recorded to the local cache, never exported/forwarded. See [LLP 0051](./0051-usage-policy-future-extensions.decision.md). |
| `full` | implicit default | No `.hypignore` governs → recorded and eligible for export. |

The class set is **extensible**: adding `local-only` (or future classes like
`redact`) is additive to this spec and the file format, not a rewrite.

**Extended-by: [LLP 0103](./0103-machine-local-policy-classes.decision.md)** -
the `ignore` class gains a second authoring source, an entry in the
machine-local list (private, per-machine, no repo dotfile), and an explicit
`full` ("asked; syncs") entry becomes representable there. The `.hypignore`
dotfile semantics in this spec are unchanged.

## File format {#file-format}

A `.hypignore` is a small text file:

- `#` comments and blank lines are ignored.
- An optional **class token** on its own line names the class. V1 recognizes
  `ignore`.
- An **empty or comment-only** file means `ignore` — preserving the existing
  skill notes' promise that *"an empty `.hypignore` at the top of the repo"*
  opts the tree out.
- **Reserved, parsed-but-not-invented in V1:** in-file *path patterns*
  (scope-narrowing within a subtree, e.g. ignore only `secrets/`) and additional
  class tokens. V1 ignores anything beyond a recognized class token.

### Fail-safe for unimplemented classes {#fail-safe}

If a `.hypignore` names a class the running version does **not** implement (most
importantly `local-only` before it ships, but any unknown token), the file
resolves to **`ignore`** — the most restrictive class — and a warning is logged.

This is a privacy invariant, not a convenience: the safe failure for a privacy
control is "suppress more," never "record-and-export something the user flagged."
A corollary the design relies on:

> **Upgrading HypAware can only ever expose *less* than before for a given
> `.hypignore`.** When `local-only` ships, a file that said `local-only` moves
> from fully-suppressed to locally-recorded — a loosening the user already asked
> for in writing — never the reverse.

## Enforcement points {#enforcement}

The class determines *where* it is enforced, riding HypAware's core seam —
*"sources write only to the cache; the export pipeline reads the cache and pushes
to sinks"* ([LLP 0000](./0000-hypaware.explainer.md#cross-cutting-invariants)):

- **`ignore` → capture seam.** The row never enters the cache.
- **`local-only` → export seam** (future): the row enters the cache but the
  export driver skips it.

V1 implements only the capture seam, so it touches **no** cache schema, export
driver, [LLP 0029](./0029-additive-cache-schema-evolution.decision.md), or
[LLP 0030](./0030-session-id-partition-key.decision.md). The *mechanics* of
capture-seam enforcement (which plugin, how the drop happens) are
[LLP 0050](./0050-ignore-enforced-in-adapters.decision.md).

## CLI surface {#cli}

A kernel verb ([LLP 0009](./0009-cli-registry.spec.md)), since hand-authoring a
dotfile should not be the only path:

- `hyp ignore [path]` — write a self-documenting `.hypignore` (comment header +
  `ignore` token) at the git **repo root** if `path`/cwd is in a repo, else at
  cwd. An explicit `path` overrides.
- `hyp unignore [path]` — remove the governing `.hypignore`.
- `hyp ignore --check [path]` — report whether a path is currently ignored, which
  `.hypignore` governs, and how many already-cached rows from the scope remain
  (see [prospective-only](#prospective-only)). Keeps the rule debuggable, per the
  repo's log-driven ethos.

## Non-goals (V1) {#non-goals}

1. **Raw-proxy / OTEL sources are folder-blind.** Folder matching needs a `cwd`,
   which only the Claude/Codex pathways supply; the `raw-anthropic` / `raw-openai`
   proxy ([LLP 0012](./0012-sources.spec.md#source-kinds)) and OTEL receiver have
   none, so a folder rule is a no-op for them. This is structural, not a policy
   choice — see [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md). A
   future caller-supplied scope (e.g. an `X-Hyp-Cwd` header) is not precluded.
   **Extended-by: [LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md)** —
   the ChatGPT-subscription Codex route (`provider='chatgpt'`) is *not* in this
   folder-blind set: it is a first-class adapter pathway whose `cwd` is recoverable
   from the local session rollout, so the Codex live projector now enriches it and
   R1 coverage is client-independent for Codex.
2. **Prospective-only; no purge.** {#prospective-only} `.hypignore` gates *future*
   live recording and *future* backfills. Rows already in the cache from before
   the file existed are left untouched; retroactive deletion is a separate,
   destructive capability out of V1 scope. `--check` surfaces the residual count.
   **Extended-by: [LLP 0104](./0104-hyp-purge.decision.md)** - the deferred
   destructive capability ships as a standalone `hyp purge` verb; the marking
   verbs here stay non-destructive, exactly as this non-goal holds.
3. **No central/config interaction.** A `.hypignore` is a local repo dotfile,
   honored whenever found. It is not merged with layered config
   ([LLP 0031](./0031-layered-config.decision.md)) or pushed by central
   ([LLP 0036](./0036-central-config-driven-client-actions.decision.md)).
   Org-forced policy is a future concern tied to `local-only`.
4. **Ephemeral per-session opt-out** is a separate mechanism, not part of this
   folder spec. It is specced in [LLP 0066](./0066-session-opt-out.spec.md)
   (session-scoped, in-memory, keyed on `session_id`), promoted from the deferred
   sketch in [LLP 0051](./0051-usage-policy-future-extensions.decision.md#session-opt-out).

## Requirements {#requirements}

- **R1.** An exchange whose resolved `cwd` has any ancestor `.hypignore`
  resolving to `ignore` MUST NOT be written to the cache, for both live capture
  and backfill. (**Extended-by:
  [LLP 0085](./0085-settlement-may-drop-late-ignore.decision.md)** — when `cwd`
  was *unknown at capture* (the Claude session-start race projected the row with
  `cwd = null`), the guarantee is honored at the capture seam **or** by a
  flush-time settlement-drop, before partition write and before export. The
  literal "never written to the cache" relaxes to "never persisted past flush or
  forwarded" for that race case; a fail-closed hold is rejected because it would
  drop legitimate SDK/headless traffic that never gets a hook record.)
- **R2.** `ignore` MUST NOT alter the live LLM call — the gateway is pass-through;
  only persistence is suppressed.
- **R3.** A `.hypignore` naming an unimplemented class MUST resolve to `ignore`
  (the [fail-safe](#fail-safe)) and SHOULD warn.
- **R4.** Matching MUST be performed by a single shared resolver, not
  reimplemented per pathway (see
  [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)).
- **R5.** `hyp ignore` / `hyp unignore` MUST be idempotent: ignoring an
  already-ignored path or unignoring an unignored path succeeds without error.
- **R6.** Resolution MUST NOT add unbounded filesystem work to the capture hot
  path — the resolver caches per-cwd results.
