# LLP 0073: graph Skill & Program nodes — bounded facets from `tool_args`

**Type:** design
**Status:** Active
**Systems:** Plugins, Sources
**Generated-by:** neutral
**Date:** 2026-07-06
**Related:** LLP 0023, LLP 0030, LLP 0032, LLP 0074, LLP 0075, LLP 0076, LLP 0077, LLP 0078

> Buildable design for two new graph node types and their Session-rooted edges:
> **`Session -ran-> Skill`** and **`Session -invoked-> Program`**. Both are the
> same root move — extract a *bounded* facet from `tool_args` (or a
> skill-activation surface) and make it first-class in the activity graph —
> applied to the two questions the graph cannot answer today.
>
> Implements [issue #229](https://github.com/hyparam/hypaware/issues/229) —
> query the activity graph by skill: a `Skill` node keyed on skill name,
> reached by a `ran` edge, with a per-surface `dispatch_source`.
> Implements [issue #230](https://github.com/hyparam/hypaware/issues/230) —
> tool nodes stop at the tool name: a `Program` node keyed on
> `basename(argv[0])`, reached by an `invoked` edge.
>
> @ref LLP 0023#contract-contribution [constrained-by] — the new node/edge
> types arrive as contract rules in the `@hypaware/ai-gateway-graph` connector;
> the engine and kit stay central and node-type-agnostic (one additive kit
> widening, see §edge-props-kit).
> @ref LLP 0030#decision [constrained-by] — both new edges root on the
> `Session` node keyed on `session_id` (the always-present session container).
> @ref LLP 0032#repo-commit-nodes — the additive node-type pattern these
> mirror: purely new rows, no migration; and the same fall-back-rather-than-
> mis-key discipline (a value that can't be derived cleanly mints nothing).
> @ref LLP 0074 [constrained-by] — Claude skill-activation signal: strict
> three-surface union (marker + Skill tool + slash) with a built-in exclusion
> list; loose matching rejected.
> @ref LLP 0075 [constrained-by] — Codex skill activation: path-pattern match
> on the `exec_command` SKILL.md read; cannot share the Claude rule.
> @ref LLP 0076 [constrained-by] — derive at projection time now; a
> capture-side `skill_activated` event is the recorded future fix.
> @ref LLP 0077 [constrained-by] — Program facet: validity-gated
> `basename(argv[0])` of the first command; subcommands and pipeline tails
> deferred.
> @ref LLP 0078 [constrained-by] — `dispatch_source` as per-surface boolean
> edge props, unioned deterministically by `mergeRow`.

## Overview

The graph already does exactly this once: `Read`/`Edit`/`Write` tool calls
don't collapse into a "Read" blob — the contract pulls `file_path` out of
`tool_args` and mints `File` nodes (`fileTargetFrom` in
[`graph_contract.js`](../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js)).
This design applies that established pattern to the two facets issues #229/#230
need — skill names and program names — as **contract rules in the existing
connector**, not a parallel mechanism. Four change surfaces:

1. **Contract rules** (`ai-gateway-graph/src/graph_contract.js`): node + edge
   rules for `Skill`/`ran` (four derivation surfaces) and `Program`/`invoked`
   (two source tools). New rules are appended to the same `rules` array, so
   they ride the existing aux-exchange filter (LLP 0026 tag-don't-drop) for
   free.
2. **Facet extraction helpers** in a new module
   `ai-gateway-graph/src/tool_facets.js`, beside `graph-keys.js` but distinct
   from it: `graph-keys.js` is the *bridge* vocabulary kept byte-identical to
   the GitHub plugin (LLP 0032 §shared-key-vocabulary) and must not accrete
   host-only recipes; skill/program facets have no cross-repo twin.
3. **One additive kit widening** (`context-graph/src/contract-kit.js`):
   `buildEdge` learns optional `props`, mirroring `buildNode`
   (§edge-props-kit).
4. **Tests** (§test-plan). No CLI change: the query surface is already
   type-agnostic (§query-surface).

## Node and edge declarations {#node-edge-declarations}

| kind | type | natural key | label | props |
|---|---|---|---|---|
| node | `Skill` | skill name, verbatim (validity-gated, §skill-key) | the name | — |
| node | `Program` | `basename(argv[0])`, lowercased (validity-gated, LLP 0077) | the key | — |
| edge | `ran` | `Session -> Skill` | — | dispatch flags (§dispatch-source) |
| edge | `invoked` | `Session -> Program` | — | — |

- **Distinct edge types** `ran` vs `invoked`, exactly as both issues specify,
  so skills and programs never collide under one `edge_type` filter.
- Both edges use `srcType: 'Session'` keyed on `session_id`
  (@ref LLP 0030#decision), like every existing Session-rooted edge.
- Each derivation surface mints **both** its node and its edge from the same
  match, so an edge never dangles (the same node-and-edge-share-the-helper
  discipline `File`/`touched` uses).
- Ids are content-addressed (LLP 0023 §content-addressed-ids): every sighting
  of one (session, skill) or (session, program) pair collapses to one edge; the
  many-duplicate-rows-dedup-by-id behavior is identical to
  `Session`/`App`/`Model`.

### Skill key {#skill-key}

The `Skill` natural key is the **bare skill name** (`hypaware-query`,
`hypaware-ai-improvement-report`), preserved verbatim (no lowercasing — skill
directory names are the identity and are conventionally already lowercase;
plugin-namespaced names like `plugin:skill` keep the namespace). This makes the
node **cross-client convergent by construction**: the same skill installed in
`~/.claude/skills/` and `~/.codex/skills/` lands on one node, which is what
lets #229's "which repos does this skill run against" join work across clients.
Names must pass `SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/`; anything
else mints nothing (fail-closed, §boundedness-contract).

## Claude skill derivation {#claude-skill-derivation}

Per LLP 0074, Claude activation is the **union of three surfaces**, each with a
strict filter, each minting the `Skill` node + `ran` edge with its own dispatch
flag. All three false-positive filters follow the issue's measurement: only
`role='user'`/`part_type='text'` with a **leading anchor** is clean; loose
matching pulls ~23% false positives.

**Surface 1 — `Skill` tool call** (`dispatch_tool: true`):

```sql
SELECT session_id, tool_args, message_created_at FROM ai_gateway_messages
  WHERE part_type = 'tool_call' AND tool_name = 'Skill'
```

`toRow` parses `tool_args` with the existing `parseMaybeJson` discipline and
takes `tool_args.skill` (the issue-confirmed identifier), gated by
`SKILL_NAME_RE`.

**Surface 2 — SKILL.md injection marker** (`dispatch_marker: true`):

```sql
SELECT session_id, content_text, message_created_at FROM ai_gateway_messages
  WHERE role = 'user' AND part_type = 'text'
    AND content_text LIKE 'Base directory for this skill: %'
```

The prefix-`LIKE` is the leading anchor in SQL; `toRow` re-verifies it at
**offset 0** with `/^Base directory for this skill: (\S+)/` (defense in depth —
the anchor is the whole false-positive defense, so it is enforced twice). The
skill name is the `basename` of the captured path after trimming a trailing
slash; if the basename is `SKILL.md` (a file rather than a base directory), the
parent directory's basename is used. A marker that appears mid-message
(assistant quoting, query output echoes, pasted transcripts) fails the offset-0
anchor and mints nothing.

**Surface 3 — slash command** (`dispatch_slash: true`):

```sql
SELECT session_id, content_text, message_created_at FROM ai_gateway_messages
  WHERE role = 'user' AND part_type = 'text'
    AND content_text LIKE '<command-name>%'
```

`toRow` matches `/^<command-name>\s*\/?([A-Za-z0-9:_-]+)\s*<\/command-name>/`
at offset 0, strips the optional leading `/`, and **drops the name when it is
in `CLAUDE_BUILTIN_COMMANDS`** — the static exclusion list LLP 0074
§builtin-exclusion settles (`model`, `compact`, `clear`, `help`, `config`,
`cost`, `doctor`, `init`, `login`, `logout`, `memory`, `status`, `review`,
`resume`, `agents`, `bug`, `mcp`, `permissions`, `hooks`, `ide`, `vim`,
`terminal-setup`, `add-dir`, `bashes`, `context`, `export`, `exit`, `quit`,
`rewind`, `statusline`, `todos`, `upgrade`, `output-style`, `plugins`,
`privacy-settings`, `release-notes`, `pr-comments`, `install-github-app`,
`migrate-installer`). Every real skill invocation via slash *also* injects the
surface-2 marker, so a built-in that drifts past this list is the only spurious
mint this surface can produce — the accepted residual LLP 0074 records.

**What deliberately does not count** (all cited from LLP 0074): assistant-role
text mentioning skills; `grep`/`cat`/`Read` of a SKILL.md in a Claude session
(that is inspection, not activation — note the asymmetry with Codex, where the
shell read *is* the activation signal, LLP 0075); markers not at offset 0. A
hand-pasted SKILL.md at offset 0 of a user message remains indistinguishable
from a real activation — accepted until the capture-side signal (LLP 0076).

## Codex skill derivation {#codex-skill-derivation}

Per LLP 0075, Codex shares zero signal with Claude (no marker, no `Skill` tool,
tool results are `role='tool'`), so it gets its own rule pair
(`dispatch_shell_read: true`):

```sql
SELECT session_id, tool_args, message_created_at FROM ai_gateway_messages
  WHERE part_type = 'tool_call' AND tool_name = 'exec_command'
```

`toRow` reads the command string from `tool_args.cmd` (the wire shape this
repo's own Codex fixtures pin: `{"cmd":"ls"}` in
`test/plugins/codex-exchange-projector.test.js`), falling back to
`tool_args.command`, and applies the path pattern

```
/[\/~]\.codex\/skills\/([^\/\s'"]+)\/SKILL\.md/
```

The captured `<name>` (first match, `SKILL_NAME_RE`-gated) is the skill. The
pattern requires the `.codex/skills/<name>/SKILL.md` shape specifically, so a
Codex session inspecting some *other* repo's `.claude/skills/...` tree or an
arbitrary SKILL.md does not mint. Reading-for-inspection vs activation is
otherwise indistinguishable — the accepted trade LLP 0075 records, which is why
the flag is the distinct `dispatch_shell_read` (consumers can weight it).

## Program derivation {#program-derivation}

Per LLP 0077, the `Program` facet is the **validity-gated
`basename(argv[0])` of the first command**, from both busy shell tools:

```sql
SELECT session_id, tool_name, tool_args, message_created_at FROM ai_gateway_messages
  WHERE part_type = 'tool_call' AND tool_name IN ('Bash', 'exec_command')
```

`tool_facets.js` provides two pure functions:

- **`commandStringFrom(toolName, toolArgs)`** — `Bash` → `tool_args.command`;
  `exec_command` → `tool_args.cmd ?? tool_args.command`. Null when absent or
  non-string.
- **`programFrom(command)`** — deterministic, fail-closed extraction:
  1. Cut the string at the first `|`, `&&`, `||`, `;`, or newline and keep the
     **first segment** only. This split is quote-blind, and that is safe *for
     this facet*: only the head of the first segment is consumed, so a
     connector inside quotes can only truncate the discarded tail, never
     corrupt `argv[0]`.
  2. Trim leading whitespace and leading `(` (subshell).
  3. Tokenize on whitespace; skip leading `KEY=VAL` env assignments
     (`/^[A-Za-z_][A-Za-z0-9_]*=/`).
  4. Unwrap known wrappers (static set: `sudo`, `env`, `nohup`, `nice`,
     `time`, `command`, `stdbuf`, `timeout`): drop the wrapper, then skip its
     flags (`-…`), further `KEY=VAL`s, and bare numerics (timeout durations),
     and take the next token.
  5. Unwrap `shell -c`: when the head is `bash`/`sh`/`zsh`/`dash`/`ksh` and a
     following flag cluster contains `c`, recurse into the next non-flag
     token's content (strip one layer of matching quotes), depth-capped at 2.
     This matters because Codex frequently runs `bash -lc "<real command>"`.
     A `bash script.sh` with no `-c` keeps `bash` as the program.
  6. `basename()` the token and lowercase it (path-invoked and bare
     invocations converge: `/opt/homebrew/bin/duckdb` ≡ `duckdb`).
  7. Gate with `PROGRAM_RE = /^[a-z0-9][a-z0-9._+-]{0,63}$/` and reject
     all-numeric tokens. Anything failing any step returns null and **mints
     nothing** — fall back rather than mis-key, the LLP 0032 discipline.

**First-command-only is deliberate** (LLP 0077): it is the facet the issue
measured (1,568 Codex `exec_command` calls → 29 distinct `argv[0]` programs),
and a contract rule's `toRow` emits at most one row per source row, so
per-pipeline-stage extraction would need a `toRow → rows[]` engine change —
deferred, recorded in LLP 0077, not smuggled in here. Subcommand nodes
(`git commit`, `hyp query`) are likewise deferred behind a dispatcher
whitelist (LLP 0077 §deferred).

## Boundedness contract {#boundedness-contract}

The guardrail issue #230 proposes, adopted here as the rule for this connector
and the precedent for future facets: a `tool_args`-derived value may become a
graph **node key** only if it is

1. a **pure deterministic function of the single source row** — no
   data-window-dependent thresholds, no cross-row state — so projection stays
   content-addressed and idempotent (LLP 0023 §content-addressed-ids); and
2. a projection into a domain **bounded by syntax and observed usage**,
   enforced by an explicit validity gate (`SKILL_NAME_RE`, `PROGRAM_RE`): the
   gates cap pathological tokens from mis-parses and, in the fleet observed so
   far, skill names track installed skill directories and program basenames
   track installed binaries (~29 observed for Codex) — not a syntactic
   guarantee, since a hashed or generated basename (`foo.test`,
   `tool-4f8e2a1b9c0d`) still passes the gate and mints its own node.

Anything unbounded — raw command strings, arbitrary path fragments — stays
queryable in `ai_gateway_messages`, or at most rides as an **edge prop** for
drill-in. Never a node.

## dispatch_source {#dispatch-source}

Per LLP 0078, `ran` edges carry **per-surface boolean props** instead of a
single enum: `dispatch_tool` (model chose the skill via the `Skill` tool),
`dispatch_slash` (the user typed `/x`), `dispatch_marker` (SKILL.md injection
seen; when it is the *only* flag, the activation was prompt-driven or
otherwise ambiguous), `dispatch_shell_read` (Codex exec read). Each surface's
rule stamps only its own flag; because edge ids hash `(src, type, dst)` only,
all surfaces' rows collapse onto one edge and `mergeRow`'s props-key union
combines the flags **order-independently** — a single enum prop would instead
resolve by earliest-wins and silently drop "both slash and tool" truth.

**Known accepted limitation:** the pre-write dedup (LLP 0023 §pre-write-dedup)
drops later sightings of an already-committed edge, so a flag whose first
sighting lands *after* the edge is committed does not reach the stored row.
This is exactly the behavior committed node props already have; acceptable for
an eventually-fresh activity graph, and self-healing on any full re-projection.

## Kit change: edge props {#edge-props-kit}

`contract-kit.js buildEdge` currently hardcodes `props: null`; `EdgeSpec` has
no props field. The change is the minimal additive widening:

- `EdgeSpec` gains `props?: Record<string, unknown>` in
  `context-graph/src/types.d.ts` **and** its structural twin in
  `ai-gateway-graph/src/types.d.ts` (the connector re-declares capability
  shapes rather than importing provider internals).
- `buildEdge` sets `props: spec.props && Object.keys(spec.props).length > 0 ?
  spec.props : null` — byte-for-byte the `buildNode` treatment.

Ids do not hash props, so **every existing edge id is unchanged**; contracts
that pass no props behave identically; the `edge` dataset already has the
`props` column and `mergeRow` already merges props generically. The
`hypaware.context-graph` capability stays at `1.0.0` — the widening is
backward- and forward-compatible (a provider without it simply yields
`props: null`, which the contract must tolerate anyway on old graphs). The
engine (`project.js`) is untouched, keeping the LLP 0023 ownership split
intact.

## Projector version and migration posture {#additive-no-migration}

`PROJECTOR_VERSION` bumps `1 → 2` as **provenance only** (LLP 0023
§inline-provenance: it marks which projector generation minted a row and
triggers nothing). Every change here is a purely additive rule — the LLP 0032
§repo-commit-nodes posture: existing rows and ids are untouched, there is no
re-key and therefore **no migration**; a `hyp graph project` run over an
existing cache mints only the new `Skill`/`Program` nodes and `ran`/`invoked`
edges.

## Query surface {#query-surface}

Zero CLI change. `resolveSeed`/`traverse` (`context-graph/src/query.js`) treat
node and edge types as opaque strings, so

```sh
hyp graph neighbors <session-id> --edge-type ran --type Skill
hyp graph neighbors hypaware-query --type Skill --direction in
hyp graph neighbors <session-id> --edge-type invoked --type Program
```

work as soon as the rows exist, and the SQL recipes in issues #229/#230
(sessions-per-skill, which-sessions-ran-git, skill→repo joins) run unchanged
over the `node`/`edge` datasets. The change set adds **tests proving those
headline queries**, not new surface.

## @ref annotations the code will carry {#code-refs}

- `graph_contract.js`, above the Claude skill rules:
  `// @ref LLP 0073#claude-skill-derivation [implements] — three-surface union; strict role/part_type/offset-0 filters (LLP 0074)`
- `graph_contract.js`, above the Codex skill rule:
  `// @ref LLP 0073#codex-skill-derivation [implements] — path-pattern on the exec_command SKILL.md read; Codex shares no Claude signal (LLP 0075)`
- `graph_contract.js`, above the Program rules:
  `// @ref LLP 0077#decision [implements] — Program = validity-gated basename(argv[0]) of the first command; fail-closed`
- `tool_facets.js`, above `programFrom`:
  `// @ref LLP 0073#program-derivation [implements] — first-segment argv[0] extraction; quote-blind split is safe because only the segment head is consumed`
- `tool_facets.js`, above the validity gates:
  `// @ref LLP 0073#boundedness-contract [constrained-by] — a tool_args facet may key a node only if deterministically bounded; fail closed`
- `tool_facets.js`, above `CLAUDE_BUILTIN_COMMANDS`:
  `// @ref LLP 0074#builtin-exclusion [constrained-by] — <command-name> conflates built-ins with skills; static list, drift accepted until the capture-side signal (LLP 0076)`
- `contract-kit.js`, above the `buildEdge` props handling:
  `// @ref LLP 0078#decision [implements] — additive edge props; dispatch flags union via mergeRow, ids unaffected`

## Test plan {#test-plan}

Traditional tests (tier 1, deterministic — the house rule home for contract
and transform logic):

- **`test/plugins/ai-gateway-graph-facets.test.js`** (new) — table-driven unit
  tests for `tool_facets.js`: env prefixes, each wrapper, `bash -lc` unwrap
  (incl. nested depth cap), pipelines/connectors take-first, quoted-connector
  head safety, subshell parens, path basenames, lowercasing, `PROGRAM_RE` /
  `SKILL_NAME_RE` fail-closed cases (spaces, quotes, all-numeric, over-long);
  marker parsing (offset-0 anchor, trailing slash, `SKILL.md` basename,
  mid-text rejection); `<command-name>` parsing (leading `/`, namespaced
  names, built-in exclusion); Codex path pattern (match, non-`.codex` paths
  rejected, quoting variants).
- **`test/plugins/ai-gateway-graph-contract.test.js`** (extend) — the new
  rules exist with the declared SQL filters; node/edge ids, labels, props, and
  `source_keys` for each surface; each surface stamps only its own dispatch
  flag; aux-tagged rows (`attributes.claude.aux_kind`) mint nothing through
  the new rules; `PROJECTOR_VERSION === 2`.
- **`test/plugins/context-graph-contract.test.js`** (extend) — `buildEdge`
  props passthrough (present, empty → null, absent → null) and edge-id
  stability with and without props.
- **`test/plugins/context-graph-project-e2e.test.js`** (extend) — fixture rows
  covering all four skill surfaces + Bash/exec_command programs projected
  through `projectGraph`: `Skill`/`Program` nodes and `ran`/`invoked` edges
  materialize; a session sighted via marker *and* slash yields one `ran` edge
  with both flags (the `mergeRow` union); re-projection writes zero rows
  (idempotence); the issue #229/#230 headline SQL (sessions-per-skill,
  which-sessions-ran-git) and `traverse` with `--edge-type ran --type Skill`
  return the fixtures' truth.

No hermetic smoke is added: `hyp graph project` has no daemon involvement
(LLP 0023 §on-demand-projection) and the e2e projection test already exercises
the full engine path.
