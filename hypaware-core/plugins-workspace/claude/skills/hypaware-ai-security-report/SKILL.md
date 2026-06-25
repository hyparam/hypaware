---
name: hypaware-ai-security-report
description: Security & Risk Review for a HypAware server — audits gateway logs for risky autonomous activity (destructive commands, remote-exec, privilege escalation, secret reads, network egress, package installs), severity-ranks findings, and recommends guardrails. Saves a dated report under docs/security-reviews/; queries the server via the hypaware-query skill. Audits recorded logs, NOT pending code — for a code diff use the built-in /security-review.
---

# Security & Risk Review

Turn a window of central AI-gateway logs into a severity-ranked picture of **what agents did
unsupervised that carries risk**, and the guardrails to contain it. This audits *recorded
activity*, not pending code (for a diff, use the built-in `/security-review`). Be
proportionate: separate "ran a risky command" from "caused harm".

IMPORTANT: Query the server, not local logs. **REDACT everything** — never echo a secret,
token, key, or credential value in the report, even one you found in `tool_args`; a raw secret
appearing in args is itself a capture finding (flag it, don't reproduce it). Query mechanics
live in the **hypaware-query** skill; read it first.

## Risk classes (match over the FULL command text, not just the first token)
| Class | Match signals | Why it matters |
| --- | --- | --- |
| Destructive | `rm -rf`, `git reset --hard`, `git push --force`, `drop`/`truncate`, `dd`, `mkfs` | irreversible data/history loss |
| Remote-exec | `curl`/`wget … \| sh`/`bash`, piped installers | runs unreviewed remote code |
| Privilege | `sudo`, `su`, `chmod 777`, writing system paths | escalation beyond the workspace |
| Secret read | `.env`, `id_rsa`, `.ssh`, `.aws`, `.netrc`, `AWS_*`, `*token*`, `credentials` | credential exposure |
| Network egress | outbound `curl`/`scp`/`nc` POSTs to external hosts | potential exfiltration |
| Package install | `npm i`, `pip install`, `brew install`, `apt` | supply-chain surface |

Risk is **amplified by autonomy** — weight anything that ran under `bypassPermissions` higher
than the same command in a gated session.

## Procedure
1. **Coverage + autonomy baseline.** Window; coverage of `tool_args` on Bash calls and of
   `permission_mode` (bound the read if sparse); distinct `gateway_id` (the unit — `user_id` is
   ~always null). Total tool calls, % Bash, % conversations in `bypassPermissions`. State N; if
   it's a dogfood window, say so.
2. **Scan + rank.** Histogram the first token of each Bash command (top 30 = the normal), then
   match the full text against each risk class: count, ONE redacted example, and the
   `gateway_id`/`git_branch` where it ran. Rank by frequency × blast radius × autonomy; keep
   "ran" vs "caused harm" distinct, and note anything that ran in a *gated* (non-bypass) session.
3. **Guardrails.** For each top risk, a concrete control + estimated coverage: a PreToolUse
   **hook** (deny/allow), a **permission policy / allowlist**, a **CLAUDE.md** rule, or a
   **gateway redaction** fix for any secret seen in args.

## Output — SAVE A MARKDOWN FILE
- **Path:** `docs/security-reviews/<YYYY-MM-DD>-security-review.md` (create the dir if needed).
  Dated so reports accumulate.
- **Bottom line (1 sentence):** the posture — how autonomous the fleet is (% `bypassPermissions`)
  and whether anything needs urgent attention.
- **Findings (severity-ranked table):** one row per finding — **risk class** · **severity**
  (high / med / low) · **count** · **example (redacted)** · **guardrail** · **where it ran**.
  Highest severity first.
- **Then the detail**, in these sections: **Autonomy baseline · Command profile · Risk findings
  · Guardrails · Trends · Capture caveats** — plus every query you ran. **All examples redacted.**
- **Formatting (human-readable):** open each section with its takeaway; **bold** severities; one
  severity-ranked findings table as the centerpiece; keep the bottom line + table a ~1-minute read.
- **Capture-health note:** if raw credentials appear in `tool_args`, the standing #1 finding is
  "gateway must redact secrets in tool_args" — put it in Capture caveats without reproducing it.
