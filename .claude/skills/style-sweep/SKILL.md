---
name: style-sweep
description: Run a mechanical, repo-wide text cleanup (character replacement,
  whitespace/style normalization) as a deterministic script instead of agent
  fan-out. Use whenever the ask is "remove/replace X across the repo" and the
  transformation needs no judgment. Verifies with git diff + a small-model
  spot check, never one agent per file.
---

# Style sweep

Mechanical text transformations are script work. NEVER fan out agents to edit
files one by one for a deterministic replacement: a script is faster, free,
and reviewable as a single diff.

1. **Express the transformation as a script.** Example (em dash to " - "):

   ```bash
   git ls-files '*.js' '*.ts' | xargs perl -CSD -pi -e 's/\x{2014}/ - /g'
   ```

   Scope with `git ls-files <globs>` so only tracked files change. For
   context-dependent rules (e.g. only inside comments), write the script with
   a proper parser (`ast-grep`, `codemod`): still a script, still one diff.

2. **Verify deterministically first**: `git diff --stat`, then re-grep for the
   target pattern (`git grep -P '\x{2014}' -- '*.js'` should return nothing).

3. **Spot-check with ONE small-model subagent** (not one per file): give a
   Haiku/Sonnet agent 10 random hunks from `git diff` and ask whether any
   replacement changed meaning (string literals, URLs, test fixtures).

4. Commit as a single sweep commit so review is one pass.
