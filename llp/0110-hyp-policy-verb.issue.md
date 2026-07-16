# LLP 0110: `hyp ignore --sync` is a misnomer; mint `hyp policy` as the class-neutral marking verb

**Type:** Issue
**Status:** Accepted
**Systems:** CLI, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-16
**Related:** LLP 0049, LLP 0071, LLP 0100, LLP 0103, LLP 0106

> Marking a folder as explicitly synced is spelled `hyp ignore --sync <path>`:
> the user asks the `ignore` verb to do the opposite of ignoring. The verb no
> longer names the action, it names the store the flag writes to, and the
> removal path (`hyp unignore`) compounds it with a double negative. Replace
> the machine-local marking surface with a class-neutral `hyp policy` verb;
> keep `hyp ignore`/`hyp unignore` for their honest dotfile meaning and as
> compatibility aliases.

## Observed

During the 2026-07-16 live test of the enrollment privacy flow
([LLP 0100](./0100-enrollment-privacy-review.spec.md)), the classify-cwd hook
([LLP 0106](./0106-session-start-classification-hook.decision.md)) injected
its instruction into a real session and the sync option read:

```
- sync: this folder's sessions upload to the shared server (the current default)
    hyp ignore --sync /Users/phil/workspace/hypaware
```

Running "ignore" to opt a folder INTO syncing is exactly backwards of what a
user (or an agent following the hook text) expects the words to mean. The
same inversion sits in the `hypaware-privacy` skill instructions, which teach
the marking verbs during the most consent-sensitive conversation the product
has.

## Why it happened

[LLP 0103](./0103-machine-local-policy-classes.decision.md) settled the
three-class machine-local store and deliberately kept `hyp ignore <path>` for
its settled [LLP 0049 §cli](./0049-hypignore-usage-policy.spec.md#cli) dotfile
meaning, putting machine-local writes behind "flags on the same verb". It
left "an explicit-sync marking whose spelling the design doc picks" open, and
the implementation resolved that open spelling to the path of least
resistance: `--sync` on `ignore`. The class taxonomy is right; only the verb
surface is wrong. This issue extends LLP 0103's CLI paragraph; the store
format, resolver, and class lattice are untouched.

## Direction (settled with the author, 2026-07-16)

A `policy` verb, matching the subsystem's own name (Usage-Policy):

```
hyp policy set <path> sync|local-only|ignore   # write a machine-local marking
hyp policy show <path>                         # replaces hyp ignore --check
hyp policy unset <path>                        # remove the marking (back to default)
hyp policy list                                # enumerate machine-local entries
```

Considered and passed over: `hyp mark`/`hyp unmark` (closest to the corpus's
"marking verbs" prose but less discoverable and does not extend to
show/list), `hyp classify` (property-flavored, conjugates badly), one verb
per class (`share`/`keep`/`ignore`, bloats the top-level command list).

Boundaries:

- `hyp ignore <path>` keeps its dotfile meaning unchanged (LLP 0049 stands).
- `--local-only`, `--private`, `--sync`, `--check` survive as deprecated
  aliases that forward to the `policy` forms; no breaking release.
- Touch points beyond the CLI: the classify-cwd hook's injected command text,
  the `hypaware-privacy` skill bodies (claude and codex), `hyp status` help
  wording, and the LLP 0103 forward-ref this issue carries.

## Exit criteria

The hook and the privacy skill never print an `ignore`-spelled command for a
non-ignore class; `hyp policy set/show/unset/list` cover the machine-local
surface; the alias forms still pass their existing tests.
