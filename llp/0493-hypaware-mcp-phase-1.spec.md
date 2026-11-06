# LLP 0493: HypAware MCP, Phase 1 (client)

**Type:** Spec
**Status:** Draft
**Systems:** MCP, CLI, Plugins, Docs
**Author:** HypForge designer
**Date:** 2026-10-13
**Source:** [HYP-128 "HypAware MCP: close the agent access gap"](https://linear.app/hyperparam/issue/HYP-128/hypaware-mcp-close-the-agent-access-gap),
Phase 1, description at revision 2026-10-13T20:15:30.957Z; client sub-issues
HYP-130 and HYP-132 to HYP-139 (HYP-130 at 2026-10-13T20:15:10.417Z, HYP-133
at 20:15:32.122Z, HYP-135 at 20:15:26.536Z, HYP-138 at 20:15:24.334Z, the
rest unchanged since 2026-10-11), and the client share of HYP-141 (revision
2026-10-13T20:15:33.449Z); Hernan's direction change of
2026-10-13T20:21:14Z (Slack, relayed by the mayor) and his scope answer of
2026-10-13T20:50Z (relayed by the orchestrator)
**Related:** LLP 0494 (design), LLP 0034 (MCP hosting), LLP 0298 (the CI
mint), LLP 0107 (skills ride attach), LLP 0197 (skills state constraints),
LLP 0491 (team history guidance); hypaware-server LLP 0602 and 0596 to 0599
(the server half, out of tree); hypscope LLP 0105 (the cloud-agent recipe,
out of tree)

> Draft 2026-10-13, design revision 3 (Hernan's direction change: the loop
> runs with no human in it). Decision owner: Hernan Alvarez, through the
> mayor. Phase 1 is approved, and HYP-141 (tool annotations) is admitted
> into it by Hernan's instruction; the rest of Phase 2 and Phase 3 are held
> until a recorded sync with Hernan. HYP-140 (the hypaware.ai pages) is held
> until Phil grants the hyparam/hypaware.ai route. HYP-135 is designed
> without HYP-75, which is not in this mission. This document covers the
> client half of Phase 1. The parent issue text and the server sub-issues
> (HYP-129, HYP-131, HYP-141) are quoted in hypaware-server LLP
> 0602#request.

## Request {#request}

Each sub-issue body below is quoted from Linear in full, at the revision
above, read through the Linear tool. The quotes are reflowed to fit; the
words are Linear's.

**HYP-130, "MCP 1.2: `hyp remote mint --scope query` and agent token in the
cloud-agent recipe":**

> Phase 1, hypaware client and HypScope.
>
> Expose the agent token (MCP 1.1, read plus recommendation status) from
> the CLI as `hyp remote mint --scope query`, and include it in the
> HypScope "Connect a cloud agent" setup recipe from HYP-116, so a cloud
> agent can read team history, act on recommendations and mark them
> applied, not only be recorded.
>
> Done when: the CLI mints an agent token, and the HYP-116 recipe places it
> in the environment's secret store alongside the enrollment token.

**HYP-132, "MCP 1.4: MCP server instructions block":**

> Phase 1, hypaware client (src/core/mcp/server.js, which the server
> reuses).
>
> Our MCP server sends no `instructions` today; it answers initialize, tools
> and resources only. Add an instructions block that tells any agent when to
> use the HypAware tools and the summary-first rule, so clients without our
> skill still know how to use them.
>
> Done when: initialize returns instructions on both stdio and /v1/mcp.

**HYP-133, "MCP 1.5: Agent commands as MCP prompts":**

> Phase 1, hypaware client (src/core/mcp/server.js, prompts capability,
> which the server reuses).
>
> Add MCP prompts that appear as commands in the agent (slash commands in
> Claude Code), each the counterpart of a CLI command:
>
> * fix a recommendation by id and mark it applied when done
>   (`hyp report fix`), runnable by an unattended agent with no human
>   approval step
> * list open recommendations for this repo (`hyp report list`)
> * check team history before starting a task (`hyp ask`)
>
> The server has no prompts/list or prompts/get today.
>
> Done when: the three commands appear in Claude Code and Cursor connected
> over stdio and over /v1/mcp.

**HYP-134, "MCP 1.6: Ship existing skills to Pi, OpenCode, Cursor and
OpenClaw":**

> Phase 1, hypaware client.
>
> Skills (hypaware-query, -reference, -privacy, -report) target only
> `claude` and `codex` in their plugin manifests. Pi, OpenCode, Cursor and
> OpenClaw already declare a skill_dir, so the installer can place skills
> there; nothing lists them.
>
> Change: add those clients to each skill's client list, and check the
> skill content works in each (LLP 0491 retrieval method names both CLI and
> MCP surfaces).
>
> Done when: `hyp client skills install` places the skills for each attached
> client and an agent in each uses them correctly.

**HYP-135, "MCP 1.7: Skill or knowledge entry for Devin and Factory
Droid":**

> Phase 1, with the HYP-75 software-factory recipes.
>
> Devin and Droid can run the CLI and Devin takes a remote MCP org-wide
> (bearer header or OAuth), but neither gets our skill. Write the equivalent
> instructions in each vendor's format (Devin knowledge, Droid skill) so the
> agent knows when to read team history and act on recommendations.
>
> Done when: the HYP-75 pilot recipes include the instructions and the agent
> token.

**HYP-136, "MCP 1.8: Docs agent prompts work through the MCP, plus a prompt
for `hyp report list`":**

> Phase 1 docs, hypaware/docs (Reports, Querying, Team setup). Copy agent.
>
> Docs release hyparam/hypaware#2570 added a CLI/agent switch on 22 command
> blocks with a copyable "Prompt for your agent." Those prompts tell the
> agent to run `hyp`, so they assume a shell and the CLI. Extend each so it
> works through the HypAware MCP tools when the agent has no `hyp`. Add the
> missing agent prompt for `hyp report list`.
>
> Done when: every agent prompt names the MCP path, and `hyp report list`
> has a prompt.

**HYP-137, "MCP 1.9: Full docs pass, add the MCP path beside every CLI
instruction":**

> Phase 1 docs, hypaware/docs. Copy agent.
>
> Wherever a page says to run `hyp` for reading history or acting on
> recommendations, add the MCP path beside it: Querying, Reports, Team
> setup, Clients, Troubleshooting. Today MCP is covered by four stdio-only
> lines in Querying and the generated /docs/cli-reference/serve-mcp-tools
> page.
>
> Done when: no read or act instruction in the docs is CLI-only.

**HYP-138, "MCP 1.10: New page /docs/mcp (connect the MCP)":**

> Phase 1 docs. New file hypaware/docs/MCP.md, published at /docs/mcp by
> the site's build-docs.mjs. Copy agent.
>
> Content:
>
> * copy-paste config for Claude Code, Cursor, VS Code, Claude Desktop,
>   Codex and Devin
> * stdio (`hyp mcp serve`) and remote (Cloud /v1/mcp with a bearer agent
>   token) options
> * how to get an agent token (`hyp remote mint --scope query`)
> * replaces the four MCP setup lines in Querying
>
> Build requirements: add a docs/README.md table row and an `llms.txt`
> line, or the site build fails. Follow the docs redesign.
>
> Done when: /docs/mcp is live and each client config is tested.

**HYP-139, "MCP 1.11: New page /docs/mcp-reference, generated from tool
definitions":**

> Phase 1 docs, hypaware/docs plus a generator in the docs build. Coding
> agent.
>
> One entry per MCP tool and agent command (prompt), with its CLI equivalent
> side by side. Generate from the tool and prompt definitions so it can't
> drift from the code. Needs a docs/README.md row and an `llms.txt` line.
>
> Done when: /docs/mcp-reference is live and regenerates on each docs build.

**HYP-141, "MCP 2.1: Tool annotations on every MCP tool"** (client share;
the full text is quoted in hypaware-server LLP 0602#request):

> Phase 2, hypaware-server MCP tools (and the client tools the server
> reuses).
>
> Anthropic's directory requires every tool to have a `title` plus
> `readOnlyHint` or `destructiveHint`. The portal flags missing
> annotations. set_recommendation_status is the only write and gets
> destructiveHint false with a clear title, so clients and directories
> treat it as an intended, non-destructive write that unattended agents can
> call.
>
> Done when: every tool on /v1/mcp and stdio carries a title and the right
> hint.

Hernan's direction for the client items, verbatim from his answer of
20:21Z (the full text is the mission's `HERNAN-ANSWERS-20261013.md`):

> 4. HYP-132 Instructions block (client src/core/mcp/server.js, reused by
>    the server)
>    initialize returns instructions: when to use the HypAware tools,
>    summary-first rule, and that marking applied is expected at the end of
>    a fix.
>
> 5. HYP-133 Agent commands as MCP prompts (same file; add prompts/list and
>    prompts/get)
>    - fix a recommendation by id and mark it applied when done
>      (counterpart of `hyp report fix`); must work for an unattended agent
>      with no human approval step
>    - list open recommendations for this repo (`hyp report list`)
>    - check team history before starting a task (`hyp ask`)
>    Done: commands appear in Claude Code and Cursor over stdio and
>    /v1/mcp.
>
> 6. HYP-134 Ship existing skills to Pi, OpenCode, Cursor, OpenClaw
>    Add those clients to each skill's client list in the claude and codex
>    plugin manifests (skill_dir already declared for each). Check content
>    works per client.
>
> 7. HYP-141 Tool annotations
>    Every MCP tool gets a title plus readOnlyHint or destructiveHint.
>    set_recommendation_status: write, destructiveHint false.
>
> CONSTRAINTS
> - No capture over MCP. Collection stays with the CLI and daemon.
> - The agent token never grants config changes or ingest.

## What this request reaches that it does not own {#reach}

- **The server.** HYP-132 and HYP-133 change `src/core/mcp/server.js`,
  which hypaware-server loads for `/v1/mcp`. A client merge reaches
  production on the next server deploy. The recommendation tools those
  prompts name are hypaware-server LLP 0596; the agent token
  `--scope query` mints is hypaware-server LLP 0597.
- **The token's reach.** Hernan answered the scope question at 20:50Z:
  the agent token keeps the literal `read report-publish`, with no
  restriction for now. So a token any member can mint can also publish
  reports and delete the org's reports over REST, for up to 90 days; his
  answer of 2026-10-14T02:48Z keeps delete (hypaware-server LLP
  0596#scope, #scope-delete). The client does not narrow it. It says so
  in plain words where the token is minted and documented
  (LLP 0494#cli-mint, #docs-mcp).
- **The mark.** HYP-133's "fix a recommendation" ends in a status mark. On
  `/v1/mcp` the mark is the one admitted write (hypaware-server LLP 0598),
  no longer conditional. The client's share is the `write` auth class
  (LLP 0494#write-class).
- **The recurrence.** The next pass checking "whether they stayed fixed"
  is the server's reopen on recurrence (hypaware-server LLP 0599). The
  client's share is the instructions line that tells an agent what to do
  with a recommendation that recurs (LLP 0494#instructions).
- **The annotations.** HYP-141 covers both surfaces. The client's tools
  and the kernel's `tools/list` entry are this repository's
  (LLP 0494#annotations); the server's own tools are hypaware-server
  LLP 0596#annotations.
- **The site.** HYP-138 and HYP-139 need a hypaware.ai `llms.txt` line and a
  site build change. Those are HYP-140's, which is held.
- **HYP-75.** HYP-135's Done-when names its pilot recipes. HYP-75 is not in
  this mission.

## Who connects {#who-connects}

Hernan's framing (2026-10-13T23:04Z, relayed by the orchestrator): the MCP
serves people connecting their own clients (Claude Desktop, Cursor, Claude
Code and the like) as well as unattended agents. The instructions, prompts,
annotations, skills and docs in this document are written for both: a
person in a chat client sees the same tools, prompts and text an
unattended agent does, and reads each step.

Phase 1 mints the agent token from the CLI only (Hernan: "It's fine for
phase one"). Phase 3 OAuth is the path for a person with no CLI and no
collector, and nothing in the client half closes it off: the docs give the
bearer header form now (LLP 0494#docs-mcp), and an OAuth client form joins
it when the server's `/v1/mcp` auth starts the flow (hypaware-server LLP
0596#token-gate-oauth).

## Out of scope {#out-of-scope}

- Phase 2 apart from HYP-141, Phase 3, HYP-140, HYP-142 and HYP-75. They
  appear only as seams in LLP 0494#seams.
- Recommendation tools served by the local stdio host. The recommendations
  live on the server; a local agent with `hyp` reaches them through the CLI
  or the remote proxy.
- Registry metadata and publishing where agents look (Phase 2).
- Any write on the client's local stdio host. The mark lives on the server.
