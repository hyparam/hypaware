# LLP 0232: Claude Code attaches through an HTTPS proxy, not a repointed base URL

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Plugins, Gateway
**Author:** Phil / Claude
**Date:** 2026-08-14
**Related:** LLP 0044, LLP 0045, LLP 0086, LLP 0163, LLP 0206, LLP 0231
**Extended-by:** LLP 0237, LLP 0239 (on macOS, proxy-mode attach additionally
installs user-domain keychain trust and the launchd `NODE_USE_SYSTEM_CA`
environment, because the two-key attach alone breaks Remote Control inbound;
see LLP 0236); LLP 0247 (#attach-writes-https_proxy-not-a-base-url: the
gateway now serves absolute-form request-targets to registered hosts on
forward-proxy listeners, so the case against `HTTP_PROXY` rests on the
no-plaintext-traffic-worth-capturing rationale alone); LLP 0259
(#proxy-attach-preflight: this section says both "a missing CA is a refusal"
and "base-URL mode otherwise"; 0259 settles it in favour of the fallback,
which is what was built, and requires the CLI caller to name the downgrade
whenever config asked for a proxy)
**Superseded-by (in part):** LLP 0262, LLP 0258 (accepted 2026-08-17; attaching the `claude` client writes a telemetry `env` block instead of
`HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`; #mode-migration and the `prev_env`
undo record are what the third mode reuses unchanged)

> Attach stops writing `env.ANTHROPIC_BASE_URL` and writes `env.HTTPS_PROXY`
> plus `env.NODE_EXTRA_CA_CERTS` instead. The endpoint stays
> `api.anthropic.com`, so Remote Control keeps working and the two first-party
> override keys LLP 0045 had to set become unnecessary.

## Context

LLP 0045 settled the base-URL attach and, with it, two sub-decisions that exist
*only* because the base URL stopped being `api.anthropic.com`:
`ENABLE_TOOL_SEARCH` (or Claude Code sends every tool schema up front) and
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` (or the assumed context window is cut
to 200k). Both are workarounds for a predicate this change stops falsifying.

See LLP 0231 for why proxy mode at all, and what it costs.

## Decision

### Attach writes HTTPS_PROXY not a base URL

**Proxy-mode attach writes
`HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`, and nothing else.** The base URL is
left exactly as the user had it. `HTTP_PROXY` is deliberately not written: it
would hand the gateway plain-HTTP requests in absolute-form, which it does not
serve, and no traffic worth capturing is unencrypted. `NO_PROXY` is the user's
escape list and is never written.

Because the endpoint is genuinely first-party, neither `ENABLE_TOOL_SEARCH` nor
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` is written in proxy mode. The
standing duty to re-verify an undocumented key every release goes with them.

### Proxy-attach preflight

**Attach refuses unless a local CA is already
on disk.** This is the answer to the worst failure mode the change introduces.
A base-URL attach pointing at a dead gateway breaks model calls; a proxy attach
pointing at a dead gateway breaks *all* of Claude Code's HTTPS, authentication
and updates included. The gateway writes the CA only after proxy mode boots
successfully, which makes the CA file's existence the one preflight worth
having: it proves the mode is actually being served, not merely requested.
A missing CA is a refusal (`markActionRefused`), not a warning, and nothing is
written.

The mode is therefore read from what the daemon is *doing*, never from what
config *asks for*: attach uses proxy mode when a CA exists and base-URL mode
otherwise. Attach cannot promise a transport the gateway is not serving.

### Mode migration

**Attach releases keys the new mode no longer
manages.** Switching modes on an already-attached machine applies the detach
rule mid-attach: a managed key whose live value is still the one we wrote is
restored to its recorded prior (or removed); a key the user has since changed is
left alone with a notice. Without this, migrating to proxy mode would strand a
live `ANTHROPIC_BASE_URL` pointing at the gateway, which is precisely the
non-first-party host the change exists to stop sending, and the attach would
silently fail to deliver what it promised.

### Detach restores any managed key

**The undo record generalises from
one key to any key.** The marker gains `prev_env`, a per-key backup, and the core
disk-driven undo restores from it before falling back to `prev_base_url`.

This is not symmetry for its own sake. `ANTHROPIC_BASE_URL` was the only managed
key that ever displaced a user value, so a single `prev_base_url` sufficed and
every other managed key was add-only and safe to delete. `HTTPS_PROXY` breaks
that: a value already present is more likely to be a corporate egress proxy than
a leftover, so it must be backed up before being overridden and handed back on
detach, exactly as LLP 0044's back-up-and-override rule requires.

`prev_base_url` stays its own field rather than folding into `prev_env`, because
markers written by earlier versions carry it and the undo must keep reading
them.

## Consequences

- The marker records `mode`. Nothing else on disk distinguishes a proxy attach
  from a base-URL one, and the undo needs to know (LLP 0235 removes a CA only
  for a proxy marker).
- A displaced `HTTPS_PROXY` is warned about **on the run that displaced it
  only**. A re-attach carries the backup forward and has nothing new to say;
  repeating the notice every time would train the user to ignore it. This is the
  same rule LLP 0163 applies to `prev_malformed`.
- The warning names `upstream_proxy` as the remedy, so a user whose corporate
  proxy was displaced is told how to keep their egress working rather than just
  that something was moved.
- `hyp detach` and `hyp daemon uninstall` reverse proxy attaches through the
  same plugin-agnostic core routine as before (LLP 0045 Part 3); the marker is
  still the whole undo record.
- Codex is unaffected and stays on base-URL attach, so both mechanisms coexist.
