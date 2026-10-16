# LLP 0496: HypAware MCP, Phase 1 (client) - Plan

**Type:** Plan
**Status:** Draft
**Systems:** MCP, CLI, Plugins, Docs
**Author:** HypForge designer
**Date:** 2026-10-14
**Implements:** [LLP 0494](./0494-hypaware-mcp-phase-1.design.md) (design), for
[LLP 0493](./0493-hypaware-mcp-phase-1.spec.md) (request)
**Constrained-by:** [LLP 0034#tool-auth-class](./0034-mcp-host-intrinsic.decision.md#tool-auth-class)
(the `write` class; Phil), [LLP 0298#mint](./0298-ci-tokens-share-one-gateway.decision.md#mint)
(`--scope query`; Kenny)
**Related:** hypaware-server LLP 0603 (the server plan, provisional
number), LLP 0596 to 0599, LLP 0602; hypscope LLP 0106 (the recipe plan,
provisional number); all out of tree, on their own
`codex/hypaware-mcp-design` branches
**Integration branch:** `integration/hypaware-mcp-phase-1`

> Draft 2026-10-14. Nothing here is built. Written while the owner answers
> are outstanding, at the orchestrator's direction (PLAN-ASSIGNMENT.md in
> the mission record). T1 to T5 are ready to build now and need no owner
> answer. Every other task names the answer or landing it waits on and what
> happens if the answer is no.

@ref LLP 0494 [implements]: the client design this plan builds
@ref LLP 0034#tool-auth-class [constrained-by]: the `write` class (T6), on Phil's recorded yes (A1)
@ref LLP 0298#mint [constrained-by]: `--scope query` (T7), on Kenny's recorded yes (A2)

## How to read the tasks

The change-set slug is `hypaware-mcp-phase-1`, matching the design's file
name. Task branches are `codex/hypaware-mcp-phase-1/Tn` and integrate on
`integration/hypaware-mcp-phase-1`. This plan covers hypaware only; the
server tasks are hypaware-server LLP 0603 ("server T4" and the like below)
and the recipe is hypscope LLP 0105 (its plan, LLP 0106). `neutral ready` sees only this
repository's refs, so a task that waits on a server landing says so in its
line, and the orchestrator checks that landing in hypaware-server.

<a id="early"></a>**T1 to T5 may merge to master early**, each on its own
review, without waiting for the rest. Two reasons:

- Server T4 cannot pass the server's CI until T2 and T5 are on hypaware
  master: the server depends on `file:../hypaware`, and its CI and publish
  check out hypaware's default branch (hypaware-server LLP 0603#cross-repo).
  The same holds for T6 before server T6.
- None of them changes what a user can do without a server change. T2
  registers nothing. T5 adds titles and hints to `tools/list`. T3 and T4
  render `initialize` and `prompts/*` from the transport and the visible
  tool set (LLP 0494#instructions rule 6, #prompts). Over stdio that is
  the `hyp report` line. On `/v1/mcp` it is safe in each server state:
  before server R1 registers the reads there is no recommendation tool,
  so there is no recommendation line and `prompts/list` holds
  `check_team_history` alone; after R1 and before R2 a read principal gets
  the hand-off and no mark line. No `/v1/mcp` rendering names `hyp report`
  or a tool the server does not serve.

**A hypaware master merge reaches production `/v1/mcp` at the next server
deploy**, whatever this repository's release does. The reviewer of T3 and
T4 checks both `/v1/mcp` renderings the pins below hold (no recommendation
tool, which production serves until server R1; the reads only, until
server R2), and of T5 the hints on a read principal's `tools/list`.

<a id="gate"></a>**A1 to A3 are decision gates, not code.** Each carries
one status-only commit recording the owner's answer, relayed by the mayor
(name, date, message reference). A1 and A2 also confirm the Draft
forward-ref already on the design branch, or remove it on a no. A3 records
Hernan's copy OK in this plan's T9 detail. No seat contacts an owner. If an
answer is no, the dependent tasks drop and the named fallback applies.

## Tasks

- id: T1  branch: codex/hypaware-mcp-phase-1/T1  deps: []  complexity: 3  -- hypaware: HYP-134 neutral skills tree (hypaware-query, hypaware-report, hypaware-reference, hypaware-privacy, with #2588's reference files) registered by the pi, opencode, cursor and openclaw plugins; tests widened to six clients; divergence fixture; install test (LLP 0494#skills). Ready now; may merge early
- id: T2  branch: codex/hypaware-mcp-phase-1/T2  deps: []  complexity: 1  -- hypaware: `src/core/mcp/contracts.js` with the two read contracts (`list_recommendations`, `get_recommendation`); no registration (LLP 0494#remote-contracts). Ready now; may merge early; server T4 needs it on master
- id: T3  branch: codex/hypaware-mcp-phase-1/T3  deps: [T2]  complexity: 2  -- hypaware: HYP-132 `instructions.js`, `buildInstructions(visibleTools, transport)` once per assembly, the eight rules including "marking applied is expected", no recommendation line on `/v1/mcp` with no recommendation tool (LLP 0494#instructions). Ready now; may merge early
- id: T4  branch: codex/hypaware-mcp-phase-1/T4  deps: [T2, T3]  complexity: 3  -- hypaware: HYP-133 `prompts.js`, `prompts/list` and `prompts/get`, three prompts naming only visible tools and rendered by transport, no approval step, `check_team_history` alone on `/v1/mcp` with no recommendation tool (LLP 0494#prompts). Ready now; may merge early
- id: T5  branch: codex/hypaware-mcp-phase-1/T5  deps: []  complexity: 2  -- hypaware: HYP-141 client share, `title` and class-derived `annotations` in `toolEntry`, the `read` and `operator` rows, titles on the bundled verbs (LLP 0494#annotations). Ready now; may merge early; server T4 needs it on master
- id: A1  branch: codex/hypaware-mcp-phase-1/A1  deps: []  complexity: 1  -- hypaware: decision gate; Phil's recorded answer to (c), the `write` class against LLP 0034#tool-auth-class
- id: A2  branch: codex/hypaware-mcp-phase-1/A2  deps: []  complexity: 1  -- hypaware: decision gate; Kenny's recorded answer on `--scope query` against LLP 0298#mint (asked with hypaware-server LLP 0597)
- id: A3  branch: codex/hypaware-mcp-phase-1/A3  deps: []  complexity: 1  -- hypaware: decision gate; Hernan's copy OK on the HYP-136 and HYP-137 docs text
- id: T6  branch: codex/hypaware-mcp-phase-1/T6  deps: [A1, T2, T5]  complexity: 3  -- hypaware: the `write` auth class with `scope`, `allowScopes` on `createMcpServer`, the write contract `set_recommendation_status`, the `write` hint row (LLP 0494#write-class, #remote-contracts, #annotations). Also waits on hypaware-server LLP 0598 accepted (server A2); server T6 needs it on master
- id: T7  branch: codex/hypaware-mcp-phase-1/T7  deps: [A2]  complexity: 3  -- hypaware: HYP-130 mint half, `hyp remote mint --scope query [--label] [--expires-days]`, the refusal lines, `hyp remote tokens` and `hyp remote tokens revoke <jti>` (LLP 0494#cli-mint, #refusals, #cli-tokens). Also waits on hypaware-server LLP 0597 accepted (server A1)
- id: R1  branch: codex/hypaware-mcp-phase-1/R1  deps: [T1, T2, T3, T4, T5, T6, T7]  complexity: 1  -- hypaware: the client release carrying the mint and the write class, after server R1 is live in production; the release checklist in CLAUDE.md
- id: T8  branch: codex/hypaware-mcp-phase-1/T8  deps: [T3]  complexity: 1  -- hypaware: HYP-135 `docs/agents/devin-knowledge.md` and `docs/agents/droid-skill/SKILL.md` (LLP 0494#devin-droid); written now, merged with T10 and T11 under the same gate steps
- id: T9  branch: codex/hypaware-mcp-phase-1/T9  deps: [A3, R1]  complexity: 3  -- hypaware: HYP-136 and HYP-137, every agent marker and every read or act instruction names its MCP path, one new `hyp report list` marker (LLP 0494#docs-paths); merges after server R2 is live
- id: T10  branch: codex/hypaware-mcp-phase-1/T10  deps: [T7]  complexity: 3  -- hypaware: HYP-138 `docs/MCP.md` and its config test, no README row (LLP 0494#docs-mcp, #docs-order); merges after the three gate steps
- id: T11  branch: codex/hypaware-mcp-phase-1/T11  deps: [T2, T4, T5, T6]  complexity: 3  -- hypaware: HYP-139 `scripts/gen-mcp-reference.js`, `docs/MCP_REFERENCE.md` and the drift test, no README row (LLP 0494#docs-reference, #docs-order); merges after the three gate steps
- id: V1  branch: codex/hypaware-mcp-phase-1/V1  deps: [R1, T9, T10, T11]  complexity: 1  -- all: the human checks (HYP-133 four runs, HYP-134 one per client, HYP-138 each client config, HYP-132 on production), recorded; LLP status flips

The build order is the list order: the five ungated tasks first, then the
gated work as each answer arrives.

## Task detail and verification {#detail}

Every task runs `npm test` and `npm run typecheck`. Done-when quotes are
from LLP 0493 at the Linear revisions it cites. No seat holds a production
credential or a paid client account, so every human proof is a person's
step through the mayor; none is claimed by the hermetic suite.

### T1: skills for Pi, OpenCode, Cursor and OpenClaw {#t1}

Ready now.

- **Files:** a neutral tree holding `hypaware-query` (`SKILL.md` and its
  reference files `ai-messages`, `github`, `graph`, `openclaw`,
  `recommendations`, `remote`, `reports`, `search`, `sql`,
  `team-history`), `hypaware-report` (`SKILL.md`,
  `references/analyst-task.md`, `references/querying.md`,
  `references/report-contract.md`), `hypaware-reference` and
  `hypaware-privacy`; a `ctx.skills.register` call in the `register` hook
  of `hypaware-core/plugins-workspace/{pi,opencode,cursor,openclaw}/`;
  `test/plugins/client-skill-manifest-agreement.test.js`,
  `query-skill-description.test.js`, `query-skill-content-boundary.test.js`
  (`CLIENTS` widened to six); `test/fixtures/skill-host-divergence.json`;
  a new install test. Where the one tree lives so all four plugins reach
  it in the published package is the implementer's choice; `npm pack
  --dry-run` shows it is in the file set.
- **Realizes:** LLP 0494#skills.
- **Done-when:** HYP-134 "`hyp client skills install` places the skills
  for each attached client" (the install half).
- **Hermetic proof:** the install test places all four skills under each
  client's `skill_dir`, with `hypaware-query/reports.md` and
  `hypaware-report/references/*.md`, not only `SKILL.md`; no neutral file
  names `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `~/.claude/projects`,
  `~/.codex/sessions` or `hypaware-analyst`; the neutral `reports.md`
  names both `hyp report mark` and `set_recommendation_status`, the MCP
  tool only "when the connected MCP lists it"; the claude and codex trees
  are unchanged.
- **Ships ahead of the mark.** T1 merges early, so a routine hypaware
  release can carry skills that name `set_recommendation_status` while
  production `/v1/mcp` does not serve it (until server R2). The
  conditional wording above is what keeps that honest: an agent whose MCP
  does not list the tool uses `hyp report mark` or hands off.
- **Human proof:** "an agent in each uses them correctly": one run per
  client (Pi, OpenCode, Cursor, OpenClaw), in V1.
- **Gate:** none. **Fallback** if Hernan overrules confirmation 5 (the
  neutral tree): his literal change, the four clients added to the codex
  tree's lists with the Codex-only sentences moved behind "if this client
  is Codex". If the one shared tree cannot reach all four plugins in the
  package: a copy per plugin held equal by the parity test.
- **CPU and memory:** files on disk only; the install routine is
  unchanged.

### T2: the read contracts {#t2}

Ready now.

- **Files:** `src/core/mcp/contracts.js` (new; `REMOTE_TOOL_CONTRACTS`, a
  frozen array of the two read entries with `tool`, `title`, `summary`,
  `inputSchema`, `authClass: 'read'` and `cli`); its type in
  `hypaware-plugin-kernel-types.d.ts`; a new
  `test/core/mcp-contracts.test.js`.
- **Realizes:** LLP 0494#remote-contracts (the read rows).
- **Done-when:** HYP-131 (client share): the server binds these by name.
- **Hermetic proof:** the array is frozen, names are unique, each schema
  is a valid JSON Schema object matching hypaware-server
  LLP 0596#tools-shapes (`status` default `open`, `limit` bounds,
  `include_evidence` boolean), titles match LLP 0596#annotations; booting a
  stdio host registers no tool from the module.
- **Human proof:** none.
- **Gate:** none. The write entry waits for T6.
- **CPU and memory:** static data, loaded once.

### T3: instructions on `initialize` {#t3}

Ready now.

- **Files:** `src/core/mcp/instructions.js` (new,
  `buildInstructions(visibleTools, transport)`); `src/core/mcp/server.js`
  (call it once when the server is created, with `opts.transport`, and
  return it in the `initialize` result); `test/core/mcp-server.test.js` and a new
  `test/core/mcp-instructions.test.js`.
- **Realizes:** LLP 0494#instructions, all eight rules.
- **Done-when:** HYP-132 "initialize returns instructions on both stdio and
  /v1/mcp."
- **Hermetic proof:** `initialize` over `stdio.js` carries `instructions`
  with rule 6's stdio line and no line for a hidden tool;
  `createMcpServer({transport: 'http'})` with no recommendation tool (what
  production `/v1/mcp` serves until server R1) renders no recommendation
  line and no `hyp report`; `createMcpServer` as an HTTP read principal
  with `list_recommendations` and `get_recommendation` registered by
  their T2 contracts in the test renders the hand-off and no mark line;
  `buildInstructions` given a visible set that holds
  `set_recommendation_status` renders rule 5, "marking applied is
  expected", with the reason and link and no approval (the text is in the
  code now, even though no assembly shows the mark until T6 and server
  T6); the string stays under about 2 KB with every Phase 1 tool visible;
  it is built once per assembly, not per request.
- **Human proof:** `/v1/mcp` on production returns it after the next
  server deploy (V1).
- **Gate:** none.
- **CPU and memory:** one string per assembly, bounded by the visible tool
  count; one transport comparison per build, nothing per request.

### T4: prompts {#t4}

Ready now.

- **Files:** `src/core/mcp/prompts.js` (new; the three definitions and the
  renderer); `src/core/mcp/server.js` (`capabilities.prompts:
  {listChanged: false}`, `prompts/list`, `prompts/get`); a new
  `test/core/mcp-prompts.test.js`.
- **Realizes:** LLP 0494#prompts.
- **Done-when:** HYP-133 "the three commands appear in Claude Code and
  Cursor connected over stdio and over /v1/mcp."
- **Hermetic proof:** over stdio, and over HTTP with the two reads
  registered in the test, `prompts/list` returns `fix_recommendation`,
  `open_recommendations` and `check_team_history`; over
  `createMcpServer({transport: 'http'})` with no recommendation tool it
  returns `check_team_history` alone, `prompts/get fix_recommendation`
  returns `-32602`, and no rendering names `hyp report`; with a visible set
  holding the mark, `fix_recommendation` renders the four steps ending in
  `set_recommendation_status`, with no approval step and no `dismissed`;
  the read-principal rendering ends in the hand-off; the stdio rendering
  names `hyp report get` and ends in `hyp report mark`, and says to stop
  and hand off if `hyp` asks for a login; every rendering names only
  visible tools; an unknown name, a missing `id`, an `id` outside the
  hyprec grammar, a `task` over 500 characters and a `limit` outside 1 to
  50 each return `-32602`.
- **Human proof:** Claude Code and Cursor, each over stdio and over
  `/v1/mcp` (four runs, V1). The `/v1/mcp` runs that show the mark wait
  for server R2.
- **Gate:** none.
- **CPU and memory:** a fixed template per `prompts/get` with capped
  arguments; nothing cached or grown per call; no I/O.

### T5: titles and annotations {#t5}

Ready now.

- **Files:** `src/core/mcp/server.js` (`toolEntry` returns `title` and
  `annotations: {title, ...hints}`, hints by class);
  `src/core/registry/verbs.js` and `src/core/runtime/activation.js`
  (optional `title` on a verb registration and in the activation key list);
  `hypaware-plugin-kernel-types.d.ts` (`title?` on `VerbRegistration`);
  titles on `query_sql` (`src/core/query/verb.js`), `grep_search`
  (`grep/src/grep_verb.js`) and `graph_neighbors`
  (`context-graph/src/verb.js`), and on any verb that declares `authClass:
  'operator'` (none on master today); a new
  `test/core/mcp-annotations.test.js`; the LLP 0494#annotations sentence
  that says the operator class "holds" `graph_project` and
  `github_backfill` corrected to "will hold" in the same PR (guardian
  advisory B).
- **Realizes:** LLP 0494#annotations (the `read` and `operator` rows, the
  title pass-through).
- **Done-when:** HYP-141 "every tool on /v1/mcp and stdio carries a title
  and the right hint." (client share)
- **Hermetic proof:** a booted stdio host and `createMcpServer` with an
  HTTP read principal: every `tools/list` entry has a non-empty `title`;
  every `read` verb has `readOnlyHint: true`; an `operator` verb
  registered by the test has `destructiveHint: true` (no bundled verb is
  `operator` on master, so a pin over the bundled set would hold
  vacuously); a verb registered with no title falls back to its tool
  name.
- **Human proof:** the server's three tools are hypaware-server LLP 0603
  T4 and T6.
- **Gate:** none. The `write` row waits for T6.
- **CPU and memory:** one constant-size object per tool entry; a lookup by
  class.

### A1: Phil on the `write` class {#a1}

Records Phil's answer to (c) in this plan and confirms the Draft
forward-ref on LLP 0034#tool-auth-class (or removes it on a no).

- **Recorded:** Phil (c) yes, 2026-10-14T16:54:20Z ("c. yes", Slack
  1791996860.984029, relayed by the mayor). The LLP 0034 forward-ref
  records it. T6 still waits on T2, T5 and hypaware-server LLP 0598
  accepted (server A2).

- **Fallback on no:** T6 drops. The class-derived hints cannot describe
  the mark (a `read` class would claim `readOnlyHint: true`), so server T6
  waits and the shape goes back to Phil as a new question
  (hypaware-server LLP 0603#t6). The read tools and their annotations are
  unaffected.

### A2: Kenny on `--scope query` {#a2}

Records Kenny's answer on LLP 0298#mint and confirms or removes its Draft
forward-ref. It arrives with his answer on hypaware-server LLP 0597
(server A1); one does not stand without the other.

- **Recorded:** Kenny yes, 2026-10-15T18:00:18Z ("I approve", Slack
  1792087218.778909, relayed by the mayor), with server A1 (LLP 0597
  Accepted). The LLP 0298 forward-ref records it. His question on members
  deleting only their own reports is a follow-up, not a condition.

- **Fallback on no:** T7 drops. If server A1's fallback is the dedicated
  scope, T7 is rewritten to it (the stderr reminder says "read and mark"
  only) and the plain-words text goes back to Hernan. If the mint goes
  admin-only (Phil (a) no), `--scope query` is refused for a member by the
  server's 403 and the line says an org admin mints it; HYP-129's "a
  non-admin member can mint" is not met and goes back to Hernan.

### A3: Hernan's copy OK {#a3}

Records Hernan's OK on the T9 text, in plain text through the mayor, with
its date.

- **Fallback on no or no answer:** T9 waits and is held with T10 and T11
  under HYP-140.

### T6: the `write` class and the mark's contract {#t6}

- **Files:** `src/core/registry/verbs.js` (`authClass` accepts `write`; a
  `write` verb must name a non-empty `scope`, else registration throws);
  `hypaware-plugin-kernel-types.d.ts` (`VerbAuthClass` gains `'write'`,
  `scope?` on `VerbRegistration`); `src/core/runtime/activation.js` (the
  key list gains `scope`); `src/core/mcp/server.js` (`allowScopes`,
  default empty; a `write` verb is listed and dispatched only when its
  `scope` is admitted; the `write` hint row); `src/core/mcp/contracts.js`
  (the `set_recommendation_status` entry, scope `report-publish`); tests in
  `test/core/mcp-server.test.js`, `mcp-annotations.test.js`,
  `mcp-instructions.test.js` and `mcp-prompts.test.js`.
- **Realizes:** LLP 0494#write-class, #remote-contracts (the write row),
  #annotations (the `write` row).
- **Done-when:** HYP-131 (client share), HYP-141 (the mark's hints),
  HYP-132 and HYP-133 (the mark renderings over `createMcpServer`).
- **Hermetic proof:** a `write` verb with no `scope` is refused at
  registration; with `allowScopes: ['report-publish']` it is listed with
  `readOnlyHint: false, destructiveHint: false` and dispatched; with no
  scopes it is not listed and a direct call is refused; the stdio host
  registers no `write` verb; `initialize` over `createMcpServer` with
  `report-publish` renders rule 5, and `fix_recommendation` ends in
  `set_recommendation_status`.
- **Human proof:** an agent marks on production (server V1).
- **Gate:** A1, and hypaware-server LLP 0598 accepted (server A2, Phil
  (b), recorded as answered yes). **Fallback:** as A1; if server A2 is
  withdrawn, T6 drops with server T6 and the hand-off stays everywhere.
- **CPU and memory:** one membership check per write verb when the
  assembly is built; nothing per request.

### T7: `hyp remote mint --scope query` and `hyp remote tokens` {#t7}

- **Files:** `src/core/cli/remote_commands.js` (the `--scope query` branch
  posting to `<api base>/v1/org/tokens/mine` with the session's access
  JWT through `resolveAccessJwt`; the refusal lines; `hyp remote tokens`
  and `hyp remote tokens revoke <jti>`); `src/core/cli/command_args.js`
  (`--scope`; the 365-day default moves from the schema into the
  enrollment branch, the schema keeps the `minimum`);
  `test/core/remote-mint-command.test.js` and a new
  `test/core/remote-tokens-command.test.js`; `docs/CLI_REFERENCE.md`
  regenerated if the CLI consistency gate asks for it.
- **Realizes:** LLP 0494#cli-mint, #refusals, #cli-tokens.
- **Done-when:** HYP-130 "the CLI mints an agent token" (the mint half);
  HYP-129 "and revoke their own agent token" (the client share).
- **Hermetic proof:** against a fake server: path, bearer and body (`{}`,
  `ttl_seconds` only when `--expires-days` is given, `label` from
  `--label`); stdout is the token alone; the stderr reminder names read,
  mark, publish and delete and the revoke command; each refusal in the
  #refusals table maps to its line and exit 1; an unknown `--scope` exits
  2; a bare `hyp remote mint` still sends 365 days; `hyp remote tokens`
  prints jti, label, created, expires and revoked and never a value;
  `revoke` calls the DELETE; nothing is written to `HYP_HOME`.
- **Human proof:** a member mints, lists and revokes on production (server
  V1).
- **Gate:** A2, and hypaware-server LLP 0597 accepted (server A1). It may
  merge before server R1 is live (the `404` line covers an older server);
  it ships in R1. **Fallback:** as A2. If Hernan declines `hyp remote
  tokens` (confirmation 7), those two commands drop and the `429
  token_limit` line says to ask an org admin to revoke one on the
  dashboard's Tokens tab.
- **CPU and memory:** one request per command.

### R1: the client release {#r1}

A version release carrying T1 to T7, cut by the CLAUDE.md release
checklist, after hypaware-server R1 is live in production (LLP
0596#landing step 4). It does not touch the claude adapter, so
`claude_otel_shape_check` is not required; the skills change ships new
files only. If A1 or A2 is still open, the release may go without T6 or
T7 (they are the only gated tasks it carries); that is the orchestrator's
call, recorded in PROGRESS.md.

### T8: Devin and Droid text {#t8}

- **Files:** `docs/agents/devin-knowledge.md`,
  `docs/agents/droid-skill/SKILL.md` (both new).
- **Realizes:** LLP 0494#devin-droid.
- **Done-when:** HYP-135 "the HYP-75 pilot recipes include the
  instructions and the agent token." Deferred with HYP-75; this task
  writes the text only.
- **Hermetic proof:** both files exist; a check that each names
  `/v1/mcp`, the bearer header, rules 3, 4, 5 and 8, and the mark as the
  agent's only write.
- **Human proof:** none until HYP-75.
- **Gate:** written now; merges with T10 and T11 under #docs-order's three
  gate steps. **Fallback:** held on its branch with them.
- **CPU and memory:** none.

### T9: the MCP path in the published docs {#t9}

- **Files:** `docs/CLI.md`, `QUERYING.md`, `REPORTS.md`, `PRIVACY.md`,
  `TROUBLESHOOTING.md`, `TEAM_SETUP.md`, `CLIENTS.md`; a docs test over the
  `agent:` markers.
- **Realizes:** LLP 0494#docs-paths.
- **Done-when:** HYP-136 "every agent prompt names the MCP path, and `hyp
  report list` has a prompt."; HYP-137 "no read or act instruction in the
  docs is CLI-only."
- **Hermetic proof:** the docs test: every `agent:` marker (22 on master,
  Team setup holding 1, plus the new Reports one; the test counts the
  tree and hardcodes no total) names an MCP tool or says no MCP path
  exists; the LLP 0494#docs-paths count of 23 corrected in the same PR
  (guardian advisory C); Reports
  has a `report list` marker; no page links `MCP.md` or
  `MCP_REFERENCE.md`. HYP-137 is checked by reading against the list in
  #docs-paths.
- **Human proof:** Hernan's copy OK (A3).
- **Gate:** A3, R1, and hypaware-server R2 live (the copy names the mark
  and the agent token, which it must not describe before production
  serves them). **Fallback:** held with T10 and T11 under HYP-140.
- **CPU and memory:** none.

### T10: `docs/MCP.md` {#t10}

- **Files:** `docs/MCP.md` (new, no README row); a new
  `test/core/docs-mcp-configs.test.js`.
- **Realizes:** LLP 0494#docs-mcp, #docs-order.
- **Done-when:** HYP-138 "/docs/mcp is live and each client config is
  tested." "Live" is HYP-140's.
- **Hermetic proof:** the config test parses each client block (Claude
  Code, Cursor, VS Code, Claude Desktop, Codex, Devin), checks its keys
  against that client's documented schema, and runs the stdio form's
  `command` and `args` against `hyp mcp serve` through `initialize` and
  `tools/list`; the page states what the token can do in #cli-mint's plain
  words.
- **Human proof:** each client connects for real (V1).
- **Gate:** written now; merges after the three #docs-order gate steps:
  no published page links it; production serves the tools, the mark and
  the mint (server R2) and R1 has shipped; Hernan is told the page is
  public on GitHub. **Fallback:** held on its branch until HYP-140.
- **CPU and memory:** none at runtime.

### T11: `docs/MCP_REFERENCE.md`, generated {#t11}

- **Files:** `scripts/gen-mcp-reference.js` (new; the verbs from an
  injected kernel built as `test/core/cli-consistency-gate.test.js` builds
  one, `REMOTE_TOOL_CONTRACTS`, the prompt definitions);
  `docs/MCP_REFERENCE.md` (generated, no README row); a drift test in `npm
  test`.
- **Realizes:** LLP 0494#docs-reference, #docs-order.
- **Done-when:** HYP-139 "/docs/mcp-reference is live and regenerates on
  each docs build." "Live" and the site hook are HYP-140's; the drift test
  is the substitute.
- **Hermetic proof:** the drift test reruns the generator in memory and
  fails, naming the regenerate command, when the checked-in page differs;
  one entry per tool and prompt with title, schema table, auth class,
  scope, hints, exposure and CLI equivalent; the server-only tools under
  one hand-written heading.
- **Human proof:** none until HYP-140.
- **Gate:** as T10. **Fallback:** as T10. Merged unlinked is preferred so
  the drift test guards master (LLP 0494#docs-order).
- **CPU and memory:** tests and scripts only, never the daemon.

### V1: human checks and status {#v1}

Through the mayor, after R1, server R2 and the merges above:

1. Claude Code and Cursor each see the three prompts over stdio and over
   `/v1/mcp` (four runs; HYP-133).
2. One agent run per client in Pi, OpenCode, Cursor and OpenClaw using the
   installed skills (HYP-134).
3. Each `docs/MCP.md` config connects from its real client (HYP-138).
4. `/v1/mcp` in production returns the instructions, with rule 5 for an
   agent token (HYP-132).

The designer records each result, and on a pass moves LLP 0494 and this
plan to Active. A failure is fixed from evidence and the same run repeated.

## Risks and rollout {#rollout}

- **Client master reaches production through the server.** T3 to T6 change
  what `/v1/mcp` serves at the next server deploy after they merge here,
  with no client release in between. Each is built from the visible set,
  so it renders correctly for whatever the server shows; the reviewer
  checks the read-principal rendering.
- **The mint names a broad token.** T7 prints a token that can publish and
  delete reports for up to 90 days (Hernan's answer, hypaware-server LLP
  0596#scope). The stderr reminder and `docs/MCP.md` say so in plain
  words; the client does not narrow it.
- **Order:** T1 to T5 now; T6 and T7 as their gates clear; R1 after server
  R1 is live; T9 to T11 after server R2 is live and R1 has shipped; the
  hypscope recipe (LLP 0106) after that (LLP 0596#landing).
- **Rollback:** each task is one merge; a revert removes it. A released
  CLI keeps working against an older server through the `404` line.
