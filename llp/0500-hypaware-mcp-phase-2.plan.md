# LLP 0500: HypAware MCP, Phase 2 (distribution) - Plan

**Type:** Plan
**Status:** Draft
**Systems:** MCP, Plugins, Docs
**Author:** HypForge designer
**Date:** 2026-10-15
**Implements:** [LLP 0499](./0499-hypaware-mcp-phase-2.design.md) (design)
**Related:** [LLP 0496](./0496-hypaware-mcp-phase-1.plan.md) (the Phase 1
plan, whose R1, T6, T7 and T10 the gates below name); hypaware-server LLP
0603 (server T6, out of tree)

> Draft 2026-10-15. Nothing here is built. Guardian round 2 passed LLP 0499
> at `9802bcf05`; its three advisories are folded into 0499 (revision 3)
> and into T2 and A2 below. Decision owner: Hernan, through the mayor. No
> seat contacts a human directly. T1 is ready to build now. H1 needs no
> gate. Everything else waits on A1 to A3, the three gates in LLP
> 0499#staging.

@ref LLP 0499 [implements]: the distribution design this plan builds

## How to read the tasks

The change-set slug is `hypaware-mcp-phase-2`. There is one code task in
this repository (T1) and it merges to `master` on its own review, as
Phase 1's T1 to T5 did: `mcpName` is static package metadata and changes
nothing a user can do. There is no integration branch. The plugin repo's
contents live on the orphan branch `staging/hypaware-plugin` (T2) until
Kenny moves them (K1), and never touch `master`.

Task ids say who acts:

- **T** tasks are HypForge's.
- **A** tasks are decision gates. Each carries one status-only line in
  this plan recording what was checked, with the date and the evidence
  (a merge, a deploy, a release tag).
- **H** tasks are Hernan's, and **K1** is Kenny's. The mayor relays each
  ask and its answer. The plan records each answer with its name, date and
  message reference.

`neutral ready` sees only this repository's refs. A gate on a server
deploy or an npm release is checked by the orchestrator, who records it.

## Tasks

- id: T1  branch: codex/hypaware-mcp-phase-2/T1  deps: []  complexity: 1  -- hypaware: `"mcpName": "ai.hypaware/hypaware"` in `package.json` and one test pinning it (LLP 0499#mcpname). Ready now; merges to master on its own review; must ship in the release A1 records
- id: A1  branch: codex/hypaware-mcp-phase-2/A1  deps: [T1]  complexity: 1  -- hypaware: gate 1; the pin is a hypaware npm release carrying Phase 1 T7, the skills at `hypaware-core/skills/`, and T1 (LLP 0499#staging gate 1). Phase 1 R1 is the natural carrier
- id: A2  branch: codex/hypaware-mcp-phase-2/A2  deps: []  complexity: 1  -- hypaware: gate 2; production `/v1/mcp` serves `set_recommendation_status` (server T6 deployed; LLP 0499#staging gate 2)
- id: A3  branch: codex/hypaware-mcp-phase-2/A3  deps: []  complexity: 1  -- hypaware: gate 3; `docs/MCP.md` (Phase 1 T10) merged past Hernan's docs gate (LLP 0499#staging gate 3, LLP 0494#docs-order)
- id: H1  branch: codex/hypaware-mcp-phase-2/H1  deps: []  complexity: 1  -- human: Hernan generates the Ed25519 key on his Mac, keeps `key.pem`, and sends the one TXT line to the mayor (LLP 0499#dns). Already asked; needs no gate
- id: T2  branch: staging/hypaware-plugin  deps: [A1, A2, A3]  complexity: 3  -- hyparam/hypaware orphan branch: the whole plugin repo tree (LLP 0499#layout, #skills, #skills-sync, #registry, #ci), skills synced from the A1 pin, `validate.yml` green on push. Carries the authorization for HypForge's two pushes (#t2)
- id: K1  branch: none  deps: [T2, H1]  complexity: 1  -- human: the one Kenny ask; confirm the repo name, `gh repo create`, the bare push to `refs/heads/main`, the TXT record on `hypaware.ai` with H1's exact value (LLP 0499#staging step 3)
- id: T3  branch: staging/hypaware-plugin  deps: [K1]  complexity: 1  -- hyparam/hypaware: confirm the new repo's `main` equals the staging head with `git ls-remote`, then delete the staging branch (LLP 0499#staging step 4)
- id: H2  branch: none  deps: [K1, T3]  complexity: 1  -- human: Hernan installs `mcp-publisher`, runs `login dns` and `publish` from a fresh clone, and checks the registry search (LLP 0499#dns, #verification)
- id: H3  branch: none  deps: [H2]  complexity: 1  -- human: Hernan sends the GitHub request to partnerships@github.com from the draft in LLP 0499#github and confirms the date
- id: V1  branch: codex/hypaware-mcp-phase-2/V1  deps: [H2, H3]  complexity: 1  -- all: the human checks in LLP 0499#verification, recorded; LLP status flips

The build order is the list order. T1 and H1 go now. A2 and A3 may clear
in either order; A1 needs T1 on master first. T2 waits for all three
gates, and everything after T2 is one line: K1, T3, H2, H3, V1.

## Task detail and verification {#detail}

T1 runs `npm test` and `npm run typecheck`. T2 runs the plugin repo's own
`validate.yml`. No seat holds a production credential, the registry key or
a paid client account, so every human proof is a person's step through the
mayor; none is claimed by a hermetic check.

### T1: `mcpName` in hypaware {#t1}

Ready now.

- **Files:** `package.json` (one top-level line, `"mcpName":
  "ai.hypaware/hypaware"`); a new `test/core/package-mcpname.test.js`.
- **Realizes:** LLP 0499#mcpname.
- **Done-when:** the published `package.json` names the registry entry,
  so the registry accepts `packages[0]` at H2.
- **Hermetic proof:** the test reads the repository's `package.json` and
  asserts `mcpName` equals `ai.hypaware/hypaware`. `npm pack --dry-run`
  shows `package.json` in the file set, as it always is.
- **Human proof:** `npm view hypaware@<pin> mcpName` prints
  `ai.hypaware/hypaware` (V1).
- **Gate:** none. **Fallback:** none needed; if it misses the A1 release,
  A1 waits for the next release that carries it.
- **CPU and memory:** static package metadata; nothing at runtime.

### A1: gate 1, the pin {#a1}

Records the hypaware version that becomes the pin, after checking on npm
that the release carries all three:

- `hyp remote mint --scope query` and `hyp remote tokens` (Phase 1 T7);
- `package/hypaware-core/skills/hypaware-query/` and
  `package/hypaware-core/skills/hypaware-reference/` in the tarball
  (`npm pack hypaware@<version>` and a listing);
- `mcpName` (T1), by `npm view hypaware@<version> mcpName`.

`v1.42.0` cannot be the pin: the skills moved to `hypaware-core/skills/`
after it (LLP 0499#skills-sync). Phase 1's R1 (LLP 0496#r1) is the natural
carrier, so T1 should merge before R1 is cut.

- **Fallback:** if R1 ships without T1, the pin is the next release that
  carries T1. Nothing else changes.

### A2: gate 2, the mark is served {#a2}

Records that server T6 is deployed and production `/v1/mcp` lists
`set_recommendation_status` for an agent token (the orchestrator checks
the deploy record; no seat calls production with a credential).

- **Fallback** (folds guardian round 2, R2-A1): if Hernan chooses to move
  before server T6 is deployed, only the README and the H3 email change:
  both drop the mark. The skills need no change, because the shipped
  `hypaware-query` `reports.md` (line 102 on `master`) names
  `set_recommendation_status` only "when the connected MCP lists it", and
  the pin does not wait. That choice is Hernan's, through the mayor,
  recorded here.

### A3: gate 3, `docs/MCP.md` merged {#a3}

Records the merge of Phase 1 T10 (`docs/MCP.md`, LLP 0496#t10) past the
three #docs-order gate steps, since the README sends Cursor individuals,
`npx skills add` users and self-hosted users to it.

- **Fallback:** none. The README must not link a page that is not on
  `master`; T2 waits.

### H1: Hernan's key {#h1}

Hernan runs the five commands in LLP 0499#dns on his own Mac. He keeps
`~/.config/hypaware-registry/key.pem` and sends the printed line, `v=MCPv1;
k=ed25519; p=<44 base64 characters>`, to the mayor. The line is public;
the key never leaves his machine. HypForge never generates, sees or holds
the key (orchestrator, 2026-10-15T22:10Z).

- **Recorded:** the line as received, with the date and message reference.
  K1 carries it verbatim.
- **Fallback on no answer:** K1 waits. The repo half of K1 could go alone,
  but one Kenny ask is the design (LLP 0499#staging step 3), so it waits
  for the line.

### T2: the staging branch {#t2}

- **Authorization** (folds guardian round 2, R2-A3). The queue row that
  assigns T2 carries it, and it covers exactly two kinds of push to
  `hyparam/hypaware`, both on one ref:
  1. creating `staging/hypaware-plugin` as an orphan branch, and pushing
     fix-ups to that same branch until K1 moves it (a repo rename at K1 is
     one such fix-up);
  2. deleting it in T3.

  No other ref is pushed. No PR is opened from it. It never merges to
  `master`.
- **Files** (the future repo's root, LLP 0499#layout):
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  `.mcp.json`, `.cursor-plugin/plugin.json`,
  `.cursor-plugin/marketplace.json`, `mcp.json`,
  `skills/hypaware-query/`, `skills/hypaware-reference/` (written by
  `sync-skills.js <pin>`, never by hand), `registry/server.json`,
  `scripts/sync-skills.js`, `scripts/check.js`,
  `.github/workflows/validate.yml`, `README.md`, `LICENSE` (MIT, as
  hypaware), `.gitignore` (`*.pem`). No root `plugin.json`, no `hooks/`,
  `bin/`, `commands/` or `agents/`.
- **Realizes:** LLP 0499#layout, #token (the README's five steps and the
  plain words on what the token can do), #endpoint, #skills,
  #skills-sync, #registry, #ci.
- **Done-when:** one tree that Claude Code installs, Cursor imports and
  `npx skills add` lists, with a registry entry that validates, all
  carrying the A1 pin.
- **Hermetic proof:** `validate.yml` green on the staging push, all six
  steps of LLP 0499#ci. The same steps run locally first, recorded in the
  T2 report, with `HOME="$(mktemp -d)"` set before CI step 1 so the
  `marketplace add` and `install` never reach a real Claude Code config
  (folds guardian round 2, R2-A2). Every tool runs through `npx` at a
  pinned version. The drift step fails if a byte under `skills/` differs
  from the pin's tarball or a version field disagrees with the pin.
- **Human proof:** the installs in V1.
- **Gate:** A1, A2 and A3. The scripts and manifests may be drafted in a
  local worktree before the gates clear; nothing is pushed and
  `sync-skills.js` is not run for the record until all three hold.
  **Fallback:** if A2 is waived by Hernan, the README drops the mark
  (#a2).
- **CPU and memory:** CI and hand-run scripts only, over two skill trees
  and five small JSON files, once per push or pin bump.

### K1: the one Kenny ask {#k1}

The mayor sends Kenny one ask, in a new Kenny Phase 2 thread, with the
exact values from LLP 0499#staging step 3:

1. Confirm the repo name (`hyparam/hypaware-plugin` is the working name;
   LLP 0499#open-question).
2. Run the three commands: `gh repo create hyparam/hypaware-plugin
   --public`, the bare single-branch clone, and the push to
   `refs/heads/main`.
3. Add TXT record `hypaware.ai`, host `@`, value H1's line exactly.
   Existing apex TXT records stay.
4. Check with `dig +short TXT hypaware.ai`.

- **Recorded:** Kenny's answer, the repo URL, and the `dig` output, with
  the date and message reference.
- **Fallback on a different name:** T2 pushes one find-and-replace fix-up
  to the staging branch (every manifest, the README, `server.json`
  `repository.url`, the move command), CI goes green again, and the ask
  continues with the new name. The plugin's own `name` stays `hypaware`.
- **Fallback on no:** nothing moves; the staging branch stays until the
  orchestrator decides with Hernan.

### T3: confirm the move and delete the staging branch {#t3}

- **Steps:** `git ls-remote git@github.com:hyparam/hypaware-plugin.git
  main` shows the staging head; then `git push origin --delete
  staging/hypaware-plugin` (T2's authorization, push 2).
- **Hermetic proof:** the two `ls-remote` lines, the plugin repo's `main`
  and the last staging head, equal, recorded before the delete; then
  `git ls-remote origin staging/hypaware-plugin` prints nothing.
- **Gate:** K1. **Fallback:** if the heads differ, no delete; the
  orchestrator asks Kenny, through the mayor, to re-run the push.

### H2: Hernan's publish {#h2}

Through the mayor, after K1's `dig` shows the line and T3 has recorded the
move: Hernan runs the publish block in LLP 0499#dns (`brew install
mcp-publisher`, `login dns` with the key, `publish` from a fresh clone in
`mktemp -d`).

- **Recorded:** that `publish` succeeded, and that
  `https://registry.modelcontextprotocol.io/v0.1/servers?search=ai.hypaware/hypaware`
  lists the entry at the pin, with the date.
- **Fallback on a refused publish:** the error text comes back through the
  mayor. An `mcpName` refusal means A1's release does not carry T1; a DNS
  refusal means the record is missing or stale (LLP 0499#dns, rotation).
  Fix from the error and re-run.

### H3: the GitHub request {#h3}

Hernan sends the draft in LLP 0499#github to partnerships@github.com,
only after H2 and with A1 to A3 holding (or with the mark dropped under
A2's fallback).

- **Recorded:** Hernan's confirmation that the email went, with the date.
  GitHub's answer is not a gate; curation is manual.

### V1: human checks and status {#v1}

Through the mayor, after H2 and H3, the rows of LLP 0499#verification:

1. Claude Code: `/plugin marketplace add hyparam/hypaware-plugin`,
   `/plugin install hypaware@hypaware`, and a `query_sql` call with a real
   agent token.
2. Cursor: a team admin, named through the mayor, runs Import from Repo,
   sets `HYPAWARE_AGENT_TOKEN` under Configure, and calls `query_sql`; one
   individual follows the README's two steps and calls `query_sql`.
3. `npx skills add hyparam/hypaware-plugin` into one real agent installs
   both skills.
4. `npm view hypaware@<pin> mcpName` prints `ai.hypaware/hypaware`.
5. The registry search and `dig` results from H2 and K1.
6. H3's confirmation.

The designer records each result, and on a pass moves LLP 0499 and this
plan to Active. A failure is fixed from evidence and the same check
repeated.

## Risks and rollout {#rollout}

- **The plugin names a broad token.** The agent token reads history,
  marks recommendations, and publishes and deletes reports, for the
  server's default of 21 days (up to 90). The README says so in plain
  words next to the install line, as `docs/MCP.md` does (LLP 0499#token).
- **A second place skills must reach.** A skill change on `master`
  reaches plugin users only when someone bumps the pin after a release;
  the drift step keeps the copy honest in between (LLP
  0499#consequences).
- **A key on one laptop.** Every future publish needs Hernan's key.
  Losing it means a new key and a new record (LLP 0499#dns, rotation), not
  a lost namespace.
- **Order:** T1 and H1 now; A1 to A3 as Phase 1 lands; then T2, K1, T3,
  H2, H3 and V1 in one line.
- **Rollback:** T1 is one revert. Before K1, deleting the staging branch
  undoes T2. After the move, the plugin repo is Kenny's to archive, and
  the registry entry stays until Hernan changes it.
