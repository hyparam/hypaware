---
name: hypaware-ai-security-report
description: Security & Risk Review for a HypAware server: audits gateway logs for risky autonomous activity (destructive commands, remote-exec, privilege escalation, secret reads, network egress, package installs), severity-ranks findings, and recommends guardrails. Saves a dated report under hypaware-reports/; first asks which HypAware source to query (local logs or a remote server) via the hypaware-query skill. Audits recorded logs, NOT pending code; for a code diff use a dedicated code-review tool.
---

# Security & Risk Review

Turn a window of central AI-gateway logs into a severity-ranked picture of **what agents did
unsupervised that carries risk**, and the guardrails to contain it. This audits *recorded
activity*, not pending code (for a diff, use a dedicated code-review tool). Be
proportionate: separate "ran a risky command" from "caused harm".

IMPORTANT: Don't assume which logs to read: **ask first.** Start by listing the data sources
and let the user choose which to query: **local logs** (this machine's own recordings,
`hyp query sql …`, no `--remote`) and **each remote HypAware server** (every target from
`hyp remote list`, plus any hypaware MCP server already available to you as MCP tools (a
`query_sql` / `graph_neighbors` tool in your toolset); the same server can appear both ways,
list it once). Present the options,
ask which one (or more) to audit, then proceed against the chosen source.

**REDACT everything.** Never echo a secret, token, key, or credential value in the report,
even one you found in `tool_args`; a raw secret appearing in args is itself a capture finding
(flag it, don't reproduce it). Query mechanics live in the **hypaware-query** skill; read it first.

## Risk classes (match over the FULL command text, not just the first token)
| Class | Match signals | Why it matters |
| --- | --- | --- |
| Destructive | `rm -rf`, `git reset --hard`, `git push --force`, `drop`/`truncate`, `dd`, `mkfs` | irreversible data/history loss |
| Remote-exec | `curl`/`wget … \| sh`/`bash`, piped installers | runs unreviewed remote code |
| Privilege | `sudo`, `su`, `chmod 777`, writing system paths | escalation beyond the workspace |
| Secret read | `.env`, `id_rsa`, `.ssh`, `.aws`, `.netrc`, `AWS_*`, `*token*`, `credentials` | credential exposure |
| Network egress | outbound `curl`/`scp`/`nc` POSTs to external hosts | potential exfiltration |
| Package install | `npm i`, `pip install`, `brew install`, `apt` | supply-chain surface |

Risk is **amplified by autonomy**: weight anything that ran under `bypassPermissions` higher
than the same command in a gated session.

## Procedure
1. **Coverage + autonomy baseline.** Window; coverage of `tool_args` on Bash calls and of
   `permission_mode` (bound the read if sparse); distinct `gateway_id` (the unit; `user_id` is
   ~always null). Total tool calls, % Bash, % conversations in `bypassPermissions`. State N; if
   it's a dogfood window, say so.
2. **Scan + rank.** Histogram the first token of each Bash command (top 30 = the normal), then
   match the full text against each risk class: count, ONE redacted example, and the
   `gateway_id`/`git_branch` where it ran. Rank by frequency × blast radius × autonomy; keep
   "ran" vs "caused harm" distinct, and note anything that ran in a *gated* (non-bypass) session.
3. **Guardrails.** For each top risk, a concrete control + estimated coverage: a tool-exec
   **guardrail** (a pre-exec hook or approval policy, deny/allow), a **permission / allowlist
   policy**, an **agent-instructions rule** (AGENTS.md / CLAUDE.md), or a **gateway redaction**
   fix for any secret seen in args.

## Output - SAVE A SHORT MAIN FILE + ONE FILE PER SECTION
A **progressively-disclosed one-pager** is the deliverable: a reader can stop after the thesis
sentence, glance the key-numbers table, skim the findings, or follow any link into a detail
**section**, and each section is its own markdown file. Build the one-pager top-to-bottom so each
layer is shorter and more glanceable than the one it summarizes. **All examples redacted in every file.**

- **Main one-pager:** `hypaware-reports/<YYYY-MM-DD>-security-review.md` (create the dir if
  needed). Dated so reports accumulate. Lay it out in exactly these blocks, separated by `---` rules:
  1. **Title + scope** - `# Security & Risk Review`, then a `## <server/fleet> · <window>` subtitle.
  2. **Thesis** - ONE **bold** sentence: the posture - how autonomous the fleet is
     (% `bypassPermissions`) and whether anything needs urgent attention.
  3. **`### Key numbers`** - a small metric→readout table, ~4-6 rows, each one glanceable fact with
     no link and all redacted (% `bypassPermissions`, count of HIGH findings, the top risk class,
     total tool calls + % Bash, coverage of `tool_args` / `permission_mode`). This is the ONLY
     table on the one-pager.
  4. **`## What this shows`** - 3-5 numbered findings, highest-severity first; each is a
     `### N. <headline>` followed by 2-3 plain-language sentences with **bold** severities (redacted),
     then a single `[<section> →](<dir>/<file>.md)` link on its own line (autonomy posture, the top
     risk findings, the single most important guardrail).
  5. **`## Caveat`** - the standing capture caveat in plain language + a `[capture caveats →]` link.
  6. **`## Report details`** - a one-line footer linking **every** section file written this run
     (not just the cited ones), so nothing is orphaned - e.g.
     `[autonomy baseline](<dir>/autonomy-baseline.md) · [command profile](<dir>/command-profile.md) · [risk findings](<dir>/risk-findings.md) · [guardrails](<dir>/guardrails.md) · [trends](<dir>/trends.md) · [capture caveats](<dir>/capture-caveats.md)`.
- **Section files are analysis, not inventory.** Each detail section is its own `<dir>/<file>.md`, held to the same standard as the one-pager: it argues one claim, opens with that takeaway, and ties every number to what it means for the reader. A section file that is only a stat table has failed - fold it back into the one-pager rather than shipping it as a page. Cut table narration ("how to read the table") and standing bookkeeping prose; compress source/window/method to a few lines.
- **No scope apologies (in any file).** Scope rules (what routes to which report) are authoring guidance, never report copy. Don't write "descriptive only", "no recommendations here", or routing disclaimers in the one-pager or any section file (redaction still applies); state findings plainly, and where a sibling report owns the action a plain cross-link is enough.
- **Capture-health note:** if raw credentials appear in `tool_args`, the standing #1 finding is
  "gateway must redact secrets in tool_args", put it in Capture caveats without reproducing it.
