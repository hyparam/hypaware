# LLP 0259: attach repairs a stranded proxy install, and never downgrades in silence

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Plugins, Gateway, Daemon
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0031, LLP 0232, LLP 0235, LLP 0237, LLP 0238, LLP 0242,
LLP 0243, LLP 0244

> `proxy_mode: true` with no local CA on disk is a real state, not an
> impossible one: `hyp detach <client> --purge` produces it by design. Attach
> stops treating it as "nothing to do". It names the base-URL downgrade on
> every attach shape, offers the one repair that fixes it (a daemon restart,
> which re-mints the CA and writes no config), and `hyp status` reports the
> state as a warning instead of rendering nothing at all.

## Context

Three settled behaviours, each right on its own, compose into a dead end
(found on a real macOS install, 2026-08-17):

1. Attach reads the mode off the CA file, never off config (LLP 0232
   #proxy-attach-preflight). The adapter cannot see config and must not
   promise a transport the gateway is not serving.
2. `--purge` deletes the CA and leaves `proxy_mode` alone. Both halves are
   deliberate: purge is the zero-residue exit (LLP 0238 #ca-survives-detach),
   and nothing on the detach path has ever written config.
3. The LLP 0244 migration offer returns early on `proxy_mode: true`, because
   its own question is about *writing* that key.

So after `hyp detach claude --purge; hyp attach claude` the config asks for a
proxy, no CA exists, the daemon holds its already-loaded CA in memory and
never re-mints, attach writes a base-URL marker, and every surface reports
success. Remote Control inbound is dead and nothing says why.

The repair already exists and already works: `maybeOfferProxyModeMigration`
runs before the endpoint is resolved precisely so an accepted switch can
restart the daemon and let `attach()` find the fresh CA. This is not a missing
capability; it is an existing repair that declines to fire in the one state
that needs it.

### LLP 0232's preflight said two things

`#proxy-attach-preflight` states both "a missing CA is a refusal
(`markActionRefused`), not a warning, and nothing is written" and, a paragraph
later, "attach uses proxy mode when a CA exists and base-URL mode otherwise".
Only the second was ever built; the only `CA_MISSING` refusal in the adapter
sits behind proxy mode having already been selected, so it cannot fire here.

This decision settles the contradiction in favour of the fallback, and repairs
what made the fallback unsafe. Refusing outright would break the ordinary
base-URL install, which is most installs, and LLP 0243/0244 already have the
migration story. What was actually wrong was never the fallback; it was the
silence.

## Decision

### The gate reads config and the CA, not config alone {#gate-reads-both}

`proxy_mode: true` covers two states and only one is settled:

| Config | CA on disk | Meaning |
|---|---|---|
| `proxy_mode: true` | present | genuinely in proxy mode, nothing to do |
| `proxy_mode: true` | absent | config and machine disagree, repair needed |

The attach-time gate returns early only for the first. The second reaches the
branch below. This extends LLP 0244 #attach-offers, whose gate is keyed on the
config alone: that remains correct for the *migration* question (which is about
a config write), and the CA is what decides the second question (which is not).

### The downgrade is named on every attach shape {#never-silent}

Whatever else happens, an attach that is about to write base-URL mode on an
install whose config asks for a proxy says so first, on stderr, before any
question. Non-TTY, `--json` and `hyp attach all` included: those shapes may
not *act*, but LLP 0244 #non-interactive already owes every non-migrating
attach a line naming what was skipped, and this state is worse than the one
that rule was written for. A dry run stays the single silent shape; it changes
nothing and promises nothing.

The line names the repair. A user who reads only that line can fix the machine
by hand (`hyp daemon restart`, then re-attach).

### The repair is a restart, and it writes nothing {#repair-is-a-restart}

An interactive, single-client, wet-run attach offers to restart the daemon,
which makes the gateway re-mint the CA (`prepareInterception` mints whenever
`proxy_mode` is on), after which the attach below takes the proxy branch it
already has. The restart-and-wait steps are LLP 0244's own; only the config
write is skipped, because the key it would set is already there.

Three properties follow from writing nothing:

- **Fleet hosts are repaired too.** LLP 0244 #central-managed declines locally
  because a local write would be dropped by the LLP 0031 merge. A restart has
  nothing to collide with, so the central branch does not apply here.
- **It fixes the state however it was reached**, not only via `--purge`.
- **It is idempotent and cheap to decline**: nothing is backed up, nothing is
  rewritten, and the base-URL attach proceeds as the working fallback.

Consent is still asked, and automation is still never restarted mid-run: a
daemon restart is exactly the consequential side effect LLP 0244
#non-interactive keeps out of scripts, and on macOS the attach that follows
raises a keychain dialog that wants a human anyway. Where no daemon service is
installed a restart cannot help, and the flow names the existing
install-and-start ladder instead of claiming a repair.

Declining `--purge` as the fix site is deliberate. Re-minting during purge
contradicts what purge promises (a zero-residue exit), and clearing
`proxy_mode` during purge cannot work where it is most needed, because on a
fleet host that key is the central layer's (LLP 0031).

### `hyp status` names the state {#status-names-it}

`proxy_mode: true` with no certificate rendered as nothing at all: the trust
block is built from the CA, so with no CA the whole block disappears and the
install reports healthy. Status gains a `proxy_mode_ca_missing` warning
diagnostic naming the state and the repair.

This is the missing half of a pair. The inverse (proxy mode off, CA present)
has always been warned about by the gateway itself as
`aigw.proxy_mode_stale_ca`. Unlike the trust block it is platform-independent:
the keychain and launchd halves exist only on macOS, but a config asking for a
transport the machine cannot serve is the same defect everywhere.

Warning, not error, and not degrading: a freshly-configured install whose
daemon has not started yet is legitimately in this state for a few seconds,
and the repair is the same either way.

## Consequences

- `enableGatewayProxyMode` gains one outcome, `remint`: the config was already
  right, no write happened, and only the restart and the two waits ran. Its
  `already` outcome now means "config right *and* CA present".
- A machine can no longer report healthy while every attach it accepts lands
  in a mode the user did not choose.
- The adapter seam is unchanged. Attach still reads the mode off the CA and
  still cannot see config; the comparison between the two lives in the CLI
  caller, which can see both.
- The darwin half (keychain trust, the real dialog) is unprovable on Linux, so
  a release touching this path wants a `docs/ACCEPTANCE.md` pass on a real Mac.
