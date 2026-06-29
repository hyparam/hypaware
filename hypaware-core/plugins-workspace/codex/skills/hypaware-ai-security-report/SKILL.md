---
name: hypaware-ai-security-report
description: Security & Risk Review for a HypAware server — audits gateway logs for risky autonomous activity (destructive commands, remote-exec, privilege escalation, secret reads, network egress, package installs), severity-ranks findings, and recommends guardrails. Saves a dated report under hypaware-reports/; first asks which HypAware source to query (local logs or a remote server) via the hypaware-query skill. Audits recorded logs, NOT pending code — for a code diff use a dedicated code-review tool.
---

# Security & Risk Review

Turn a window of central AI-gateway logs into a severity-ranked picture of **what agents did
unsupervised that carries risk**, and the guardrails to contain it. This audits *recorded
activity*, not pending code (for a diff, use a dedicated code-review tool). Be
proportionate: separate "ran a risky command" from "caused harm".

IMPORTANT: Don't assume which source to read — **ask first.** Enumerate every HypAware source
available — local logs, remote servers, and any attached hypaware MCP tools; the same server can
be attached more than one way, so list it once (see **hypaware-query** for how to discover them).
Present the options, ask which one (or more) to audit, then proceed against the chosen source.

**REDACT everything** — never echo a secret, token, key, or credential value in the report,
even one you found in captured tool arguments; a raw secret appearing in args is itself a capture finding
(flag it, don't reproduce it). Query mechanics — plus the column/schema reference (which columns
exist, the Claude-vs-Codex differences, and what transcript backfill does and doesn't populate) —
live in the **hypaware-query** skill; read it first and don't assume a column is present or
provider-agnostic.

## Risk classes (match over the FULL command text, not just the first token)
| Class | Match signals | Why it matters |
| --- | --- | --- |
| Destructive | `rm -rf`, `git reset --hard`, `git push --force`, `drop`/`truncate`, `dd`, `mkfs` | irreversible data/history loss |
| Remote-exec | `curl`/`wget … \| sh`/`bash`, piped installers | runs unreviewed remote code |
| Privilege | `sudo`, `su`, `chmod 777`, writing system paths | escalation beyond the workspace |
| Secret read | `.env`, `id_rsa`, `.ssh`, `.aws`, `.netrc`, `AWS_*`, `*token*`, `credentials` | credential exposure |
| Network egress | outbound `curl`/`scp`/`nc` POSTs to external hosts | potential exfiltration |
| Package install | `npm i`, `pip install`, `brew install`, `apt` | supply-chain surface |

Risk is **amplified by autonomy** — weight anything that ran in bypass-permission (autonomous)
mode higher than the same command in a gated session.

## Procedure
1. **Coverage + autonomy baseline.** Window; coverage of tool arguments on Bash calls and of
   permission mode (bound the read if sparse — see **hypaware-query**); distinct gateways (the
   unit; user-level isn't available). Total tool calls, % Bash, % conversations in
   bypass-permission (autonomous) mode. State N; if it's a dogfood window, say so.
2. **Scan + rank.** Histogram the first token of each Bash command (top 30 = the normal), then
   match the full text against each risk class: count, ONE redacted example, and the
   gateway / branch where it ran. Rank by frequency × blast radius × autonomy; keep
   "ran" vs "caused harm" distinct, and note anything that ran in a *gated* (non-bypass) session.
3. **Guardrails.** For each top risk, a concrete control + estimated coverage: a tool-exec
   **guardrail** (a pre-exec hook or approval policy, deny/allow), a **permission / allowlist
   policy**, an **agent-instructions rule** (AGENTS.md / CLAUDE.md), or a **gateway redaction**
   fix for any secret seen in args.

## Output — SAVE A SHORT MAIN FILE + ONE FILE PER SECTION
A **progressively-disclosed one-pager** is the deliverable: a reader can stop after the
overview, skim what we found, or follow any link into a detail
**section** — and each section is its own markdown file. Build the one-pager top-to-bottom so each
layer is shorter and more glanceable than the one it summarizes. **All examples redacted in every file.**

- **Main one-pager:** `hypaware-reports/<YYYY-MM-DD>-security-review.md` (create the dir if
  needed). Dated so reports accumulate. Lay it out in exactly these blocks, separated by `---` rules:
  1. **Title + scope** — `# Security & Risk Review`, then a `## <server> · <window>` subtitle.
  2. **`## Overview`** — a heading (never open the page with a bare sentence), then ONE **bold**,
     plain-English sentence: the posture — how much ran without human approval (the share of
     sessions in bypass-permission mode) and whether anything needs urgent attention. No jargon —
     see the plain-language rule below.
  3. **`## What we found`** — 3–5 numbered findings, highest-severity first, all redacted, with
     **no separate key-numbers table** (fold each headline number into the finding it belongs to).
     Each is a `### N. <plain headline>` followed by 1–2 plain-language sentences with the **bold**
     severity/number inline, then a single `[<section> →](<dir>/<file>.md)` link on its own line
     (how much ran unsupervised, the top risk findings, the single most important guardrail). Don't
     repeat the same `[… →]` link across findings — if several share a section file, group them
     under one `### <subsection>` heading with a single link.
  4. **`## Caveat`** — the standing capture caveat in plain language + a `[capture caveats →]` link.
  5. **`## Report details`** — a one-line footer linking **every** section file written this run (not
     just the cited ones), so nothing is orphaned — e.g.
     `[autonomy baseline](<dir>/autonomy-baseline.md) · [command profile](<dir>/command-profile.md) · [risk findings](<dir>/risk-findings.md) · [guardrails](<dir>/guardrails.md) · [capture caveats](<dir>/capture-caveats.md)`.
- **Section files:** one markdown file per detail section, under a per-report folder
  `hypaware-reports/<YYYY-MM-DD>-security-review/` (e.g. `autonomy-baseline.md`,
  `command-profile.md`, `risk-findings.md`, `guardrails.md`, `trends.md`, `capture-caveats.md`).
  Write only the sections this run actually has findings for, and link each from the relevant bullet.
  - **`risk-findings.md` (severity-ranked table):** one row per finding — **risk class** ·
    **severity** (high / med / low) · **count** · **example (redacted)** · **guardrail** ·
    **where it ran**. Highest severity first.
  - Other sections, each its own file: **Autonomy baseline · Command profile · Risk findings ·
    Guardrails · Trends · Capture caveats**.
- **Formatting — write for a human, not an LLM.** The one-pager stays a ~30-second read: thesis,
  then a short numbered list of findings with the key number inline — **no tables**. **Ban internal
  jargon** a non-engineer wouldn't follow (raw "bypassPermissions", "sidechain", "fleet"); say what
  you mean ("ran without approval", "the whole team"). Push every table into the section files; open
  each section file with its takeaway; **bold** severities; the severity-ranked findings table is the
  centerpiece of `risk-findings.md`.
- **Capture-health note:** if raw credentials appear in captured tool arguments, the standing #1
  finding is "gateway must redact secrets in captured tool arguments" — surface it on the
  one-pager and put it in `capture-caveats.md`, without reproducing the secret.
