# Decision Disposition

When a decision crystallises during a grill, route it to the right place in the
LLP corpus. Work top-down; take the first branch that fits.

```
Does this decision change how the system is or should be built/understood?
│
├─ NO  → It's a passing implementation detail. Don't write anything.
│        (If it constrains code in a non-obvious way, plan an @ref to the
│         LLP that already explains the constraint, to add when code lands.)
│
└─ YES → Is it already covered by an Active LLP?
         │
         ├─ YES, and the decision REFINES/CLARIFIES it
         │     → Edit that LLP in place. Add or sharpen a section; keep anchors stable.
         │
         ├─ YES, and the decision OVERRIDES it
         │     → Update the LLP to the new decision.
         │       • Old framing still useful for migration? Mark it **Superseded**,
         │         write the replacement (new LLP or new section), cross-link.
         │       • Old framing now misleading and worthless? Just edit it out
         │         (git keeps history), or tombstone if it's a whole-doc retirement.
         │
         └─ NO existing LLP covers it
               → Is it a genuine, non-obvious decision a future agent could get wrong?
                 ├─ YES → Create a new LLP (next number, NNNN-slug.type.md, full header).
                 │         Choose Type deliberately:
                 │           Decision  — a settled choice + its rationale (ADR-like)
                 │           Spec      — normative "must/must not" the code follows
                 │           Principle — an "always/never" that guides many decisions
                 │           Plan      — execution steps (often tombstoned once done)
                 │         Tag **Systems:** with the existing vocabulary (or extend it
                 │         and update LLP 0000's map).
                 └─ NO  → It's obvious from the code and filename. Write nothing.
```

## The capture bar (lower than ADRs, but not zero)

LLP documents are *living* — editable, supersede-able, deletable — so you are
not making a permanent commitment the way an append-only ADR is. That lowers the
cost of capturing, but the **value** test is the same one from LLP 0000:

> Capture a decision when an agent might "simplify" the code in a way that
> breaks the design intent.

Strong candidates:

- **Cross-cutting invariants** — "sources never see sinks", "one source, one
  table". Code that violates these looks locally fine.
- **Deliberate deviations from the obvious path** — anything where a reasonable
  agent would assume the opposite and "fix" it.
- **Boundary and ownership decisions** — who owns this data/table/capability;
  the explicit no-s are as valuable as the yes-s.
- **Constraints not visible in code** — compliance, latency budgets, a contract
  with an upstream the code can't show.

Skip:

- The obvious ("we use the standard library here").
- Volatile, still-being-prototyped code — wait until the design stabilises.
- Restating what an existing LLP already says — link to it instead.

## After disposition

- Make sure each new section the plan will reference has a **stable heading
  anchor** (prefer slugs; avoid em dashes and punctuation that slugs differently
  across tools).
- Land the LLP edit with the motivating code change where possible.
- Run `/ref-check` to confirm anchors resolve and no `@ref` was orphaned.
