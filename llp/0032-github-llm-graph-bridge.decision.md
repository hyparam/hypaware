# LLP 0032: GitHub ↔ LLM session graph convergence bridge

**Type:** Decision
**Status:** Active
**Systems:** Graph, Sources
**Author:** Phil / Claude
**Date:** 2026-06-18
**Related:** LLP 0012, LLP 0023, LLP 0028, LLP 0030

> The context graph is a shared substrate for many sources (LLP 0023). When two
> sources describe the **same real-world entity**, they should land on **one
> node** — convergence. It is automatic given a shared natural key (ids are
> content-addressed, LLP 0023 §content-addressed-ids), so the only design act is
> agreeing the key. `@hypaware/github` (a separate repo) already mints
> `Repo`/`Commit`/`File` nodes with bridge-ready keys; this LLP records the
> host-side changes that make the **LLM-session** contract adopt the same keys
> so the join fires. The same re-key also makes one repo's files converge
> **across git worktrees**, which absolute-path keying never could.

## Convergence is local and key-driven

With many sources, most node-type pairs never overlap and correctly never
converge. Convergence is not a global feature; it is two contracts choosing the
**same normalized natural key** for one entity. GitHub ↔ LLM-sessions is a
high-overlap pair: a repo, a commit, and a touched file all appear in both a
GitHub capture and a recorded Claude/Codex session. This LLP agrees keys for
that overlap and asserts nothing about other sources.

The `@hypaware/github` plugin keys `Repo = owner/repo`, `Commit = sha`,
`File = owner/repo:relpath` (its LLP 0003/0004). It imports **this repo's** id
recipe (`context-graph/src/contract-kit.js`), so the id recipe is identical by
construction; the only thing that can break convergence is **key-normalization
drift** between the two sides. The cross-repo contract is enforced by digest
pins on both sides (host: `test/plugins/ai-gateway-graph-bridge.test.js`;
GitHub plugin: `test/graph-ids.test.js`).

## Shared key vocabulary

The host previously chose its graph keys ad hoc, per `toRow`. For sources to
converge without central coordination, a node type's key recipe needs one home —
and that home is **the plugin that mints the node type**, not the engine.
`hypaware-core/plugins-workspace/ai-gateway-graph/src/graph-keys.js` is that home
for `Repo`/`Commit`/`File`: it sits beside the contract (`graph_contract.js`)
that emits those nodes, so a contract derives a bridge key from the one recipe
instead of re-deriving (and risking divergence from) it per `toRow`.

**Why not the engine.** `@hypaware/context-graph` is a generic substrate: it
hardcodes no node type and its projection/compaction never name
`Repo`/`Commit`/`File`. Its kit exposes only the type-blind primitives
(`nodeId`, `edgeId`, `makeRowBuilders`). Hosting Repo/Commit/File-specific
recipes on `kit.keys` would have given those node types a privileged home the
engine ships — the wrong precedent for a substrate meant to carry many sources,
some unofficial, each of which must own its own node types symmetrically. It is
also unnecessary: cross-source convergence is enforced by **digest pins**, not
by shared engine code (the GitHub plugin is a separate repo that hand-syncs its
own `keys.js` and never imports the host's). The only in-repo consumer is this
one connector, which imports `keys` directly. Keeping the recipe in the connector
leaves the engine capability surface unchanged — no version bump, no
`kit.keys`-presence guard — and keeps the engine node-type-agnostic. (Should a
second host-side connector ever need the same recipe, it belongs in a small
shared module imported by both connectors in this repo — still not the engine.)

The `Repo`/`Commit`/`File` recipes there are **byte-identical** to
`github-hyp-plugin/src/keys.js` — owner/repo lowercased, sha full-40-hex
lowercased, relpath POSIX with no leading `./` or `/`. This connector is the
host-side twin of that GitHub `keys.js`. The host adds two reconciliation steps
the GitHub side does not need (it gets `owner/repo` and repo-relative paths from
the API): `ownerRepoFromRemote` (a git **remote URL** → `owner/repo`) and
`relativizePath` (an **absolute local path** → repo-relative, against the repo
root). These feed the verbatim recipes, so the resulting keys still converge.
The two `keys` modules are kept in sync **by hand** — the plugins are decoupled
(separate repos), so a shared module isn't an option; the digest pins are the
enforcement.

## Capture

`Repo`/`Commit`/`File` bridge keys need three facts the gateway did not capture:
the git **remote URL**, the full **HEAD sha**, and the **repo root** (the prefix
that relativizes a touched file's absolute path). They are not derivable from
`cwd` without running git, so they are captured, not inferred at projection
time, and ride the `ai_gateway_messages` row as three new nullable columns
`git_remote` / `head_sha` / `repo_root` (`schema_version` 7).

- **Claude** — the hook (`@hypaware/claude` `hook_command.js`) already shells
  `git` in the live cwd for the branch; it now also reads `remote.origin.url`,
  `rev-parse HEAD` (validated full-40-hex), and `rev-parse --show-toplevel`,
  writes them into the session-context record, and the projector stamps them
  like `cwd`/`git_branch`.
- **Codex** — the turn metadata (`x-codex-turn-metadata`) already carried
  `associated_remote_urls.origin` and `latest_git_commit_hash` (kept in
  `attributes.codex.*` for provenance); they are now promoted to the first-class
  columns, and the workspace path is the repo root. Backfill reads the same
  facts from the rollout's `session_meta.git` block.

The additions are **nullable** and additive, so no partition-label bump or cache
wipe is needed: a session outside a git repo simply leaves them null, and older
partitions predate the columns. So that a contract or query reading a new column
does not throw `ColumnNotFoundError` over a pre-v7 partition, the gateway data
source exposes its **declared** schema columns (padding absent physical columns
to null) — `createDataSource` / `withSchemaColumns` in `ai-gateway/dataset.js`.

## Remote redaction

A git remote can carry a credential in its userinfo —
`https://x-access-token:<token>@github.com/owner/repo.git` is exactly what `gh`
and CI checkouts write into `remote.origin.url`. Convergence needs only the
normalized `owner/repo` (`ownerRepoFromRemote` discards userinfo on the way to
the key), so the raw secret is **never** needed downstream. Each capture path
therefore strips URL userinfo at **ingress** — the moment it reads the remote,
before the value reaches any sink: the `git_remote` row column, the
`attributes.codex.git_origin_url` provenance mirror, the Claude session-context
sidecar, and (read back from the row at projection) the graph node/edge
`source_keys`. Redacting at ingress, not at one storage chokepoint, keeps the
secret out of *every* current and future sink by construction — the same
boundary-redaction discipline the gateway recorder already uses for headers.

Only the `scheme://user[:token]@host/…` URL form carries a secret; the scp-like
SSH form (`git@github.com:owner/repo.git`) authenticates by key, so its `git@`
user is left intact (and `ownerRepoFromRemote` parses both forms unchanged).
The capture plugins are decoupled, so the tiny redactor is duplicated per plugin
and pinned by a test on each path, exactly as the key recipes are. Rows written
before this guard still hold raw remotes; rewrite them with the same
drop-and-re-project migration the `File` re-key uses (below).

## Repo-Commit nodes

Two additive node types and their edges (no migration — purely new rows):

- **`Repo`** keyed `owner/repo` from `git_remote`, with `Session -in-> Repo`.
- **`Commit`** keyed on the full HEAD sha, with `Session -at-> Commit` and
  `Commit -in-> Repo`. The last is the **same** edge `@hypaware/github` mints,
  so the edge converges too, not just its endpoint nodes.

`in` is the shared membership verb (a Session ran *in* a repo; a Commit lives
*in* a repo), matching the GitHub side's `-in->` usage; `at` situates a session
at the HEAD it was sitting on. Each message-part row carries the same
exchange-level repo facts, so these rules mint many duplicate rows that dedup by
id exactly as `Session`/`App`/`Model` already do.

## File migration

The `File` node re-keys from the **absolute local path** to
`owner/repo:relpath`. This is the one **costly-to-reverse** change: ids are
content-addressed (LLP 0023), so re-keying **orphans every committed `File` node
and `touched` edge** that used the old absolute key — there is no retract path.
It is a deliberate **migration**, sequenced after capture lands.

**Fallback, not a hard cutover.** A file is re-keyed only when its absolute path
can be relativized against a captured repo: an in-repo path under a known github
remote gets `owner/repo:relpath`; a file **outside** the repo (`/tmp`,
`~/.claude`, another repo), a non-github remote, or a session with no captured
repo keeps its **absolute-path** key, exactly as before. So `File` keys are
heterogeneous by design, and the `touched` edge derives its `File` endpoint
through the same helper so it always lands on a node the `File` rule mints.

**Migration procedure (operational, on local graph data).** After this code
lands, committed graph rows still carry old absolute `File`/`touched` ids;
re-projection mints the new `owner/repo:relpath` ids alongside them (graph
compaction merges by id, so it will not collapse old-key and new-key twins). To
retire the stale rows, drop the `ai-gateway.t0` `File`/`touched` rows and
re-run `hyp graph project` (or rebuild the graph). This is the
costly-to-reverse step; do it once, deliberately.

### Worktree convergence

The migration is worth its cost even ignoring GitHub: absolute-path keying
splits **one logical file into many nodes** across git worktrees, because each
worktree checks the repo out at a different absolute path. `owner/repo:relpath`
collapses them — worktrees share the remote, and `rev-parse --show-toplevel`
gives each worktree its own root, so the same file relativizes to the same
relpath and the same key in every worktree.

## GitHub-only V1

V1 assumes **github.com**: `Repo = owner/repo`, no host segment, matching the
GitHub plugin's V1 (its LLP 0003 §multi-host). `ownerRepoFromRemote` returns
null for a non-github remote, so a GitLab/Bitbucket session mints no `Repo` and
its files keep absolute keys (no worktree convergence for non-github repos in
V1). Host-qualified keys (`host/owner/repo`) for other forges are a reserved
key-namespace migration, deliberately out of V1 so no one assumes the keys are
already host-safe.

## Abbreviated-sha guard

`commitKey` validates **full 40-hex** and returns null otherwise — stricter than
the GitHub side, which trusts the API for full shas. Codex's
`latest_git_commit_hash` may be abbreviated; an abbreviated key would never
converge with the GitHub full-sha node, so it must mint **no** `Commit` rather
than a distinct dangling one. The guard only gates *whether* a key is produced;
for a full sha the output is byte-identical to the GitHub side. The capture
column stays faithful (it records whatever git/Codex reports); the guard lives
at key-derivation time.

## Actor stays distinct (deferred to enrichment)

"Same person across GitHub and sessions" has **no deterministic T0 key** —
github `login` ≠ session `user_id` ≠ git author email. That is prune/merge
work for the T1/T2 curator (LLP 0028), so cross-actor identity is **not** part
of this bridge. The gateway contract mints no `Actor`; each side keys actors on
its own natural key and they stay distinct until enrichment merges them.
