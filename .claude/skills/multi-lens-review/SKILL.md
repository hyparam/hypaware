---
name: multi-lens-review
description: Review a diff, branch, or module with parallel finder agents,
  each holding ONE lens (reuse, simplification, efficiency, altitude/design,
  correctness), then adversarially verify each finding with independent
  voter agents before reporting. Use for pre-merge review, branch audits,
  or "find problems in X" asks that deserve more than one pass.
---

# Multi-lens review

One reviewer misses what a different lens catches; one finding presented
without verification wastes reviewer trust. Structure:

1. **Scope**: resolve the target to a concrete diff or file list
   (`git diff main...branch`, or the module's files). Paste the scope into
   every agent prompt; agents do not re-derive it.

2. **Finder fan-out**: one agent per lens, in parallel, each prompted with
   ONLY its lens:
   - *reuse*: duplicated logic, existing helpers not used
   - *simplification*: complexity that a smaller construct removes
   - *efficiency*: allocation, IO, algorithmic waste on hot paths
   - *altitude*: wrong layer / API-shape / naming-level concerns
   - *correctness*: inputs/state that produce wrong results

   Finders return findings as `file:line - claim - why it matters`.
   Worker model: Sonnet by default; Opus only for correctness on
   intricate logic.

3. **Adversarial voters**: for each finding, 3 parallel agents prompted to
   REFUTE it ("prove this is fine or intended; default to refuted if
   uncertain"). Keep findings with at least 2 non-refutes. Voters:
   Haiku/Sonnet.

4. **Report**: surviving findings ranked by severity, each with its
   file:line, the failure scenario, and which lens found it. No fixes
   unless asked.
