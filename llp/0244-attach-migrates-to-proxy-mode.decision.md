# LLP 0244: hyp attach claude migrates a base-URL install to proxy mode, behind consent

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Plugins, Gateway, Daemon
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0031, LLP 0174, LLP 0181, LLP 0232, LLP 0233, LLP 0242,
LLP 0243

> When `hyp attach claude` runs against an effective config whose gateway
> block lacks `proxy_mode: true`, and the client's row declares proxy attach,
> attach offers the switch: on a yes it sets the key in the local config,
> restarts the daemon, waits for the CA, and proceeds into the normal proxy
> attach. A no, a non-TTY, or a centrally-managed gateway block leaves the
> base-URL attach exactly as it is today, with one line saying what was
> skipped and why.

## Context

LLP 0243 fixes fresh installs. Every already-running install keeps a config
without the key, and per LLP 0233 the daemon must not infer it on upgrade.
Something user-driven has to write it once, and the natural verb already
exists: attach is where a user says "wire Claude to HypAware", it already
prompts to edit the local config and restart the daemon when the adapter
plugin is missing (LLP 0174), and it is already the repair the gateway's own
stale-CA warning names. One more consented config-write step in the same flow
is a smaller idea than a new migration command.

## Decision

### Attach offers the switch {#attach-offers}

Before resolving the gateway endpoint, attach checks whether the client's
picker row declares `gateway_proxy_mode` (LLP 0243) and whether the effective
gateway block already has `proxy_mode: true`. If the row declares it and the
config lacks it, an interactive attach asks one yes/no question, default no
(the confirmation posture every consequential verb here follows: anything
but an explicit yes is a no), that names what changes: capture switches from
a repointed base URL to a
local HTTPS proxy, the daemon restarts, and macOS will ask to trust the local
CA. Consent here covers the config write; the CA trust grant keeps its own
dialog (LLP 0237) and can still be refused independently.

### The enable machinery, one new write shape {#enable-write}

The accepted switch reuses LLP 0174's enable steps: guarded local write (LLP
0031 backup), daemon restart, bind wait, each reported per step. The write
differs from adapter enablement in one way: it sets a key on the *existing*
local `@hypaware/ai-gateway` entry rather than appending a missing plugin,
and it refuses (`no_gateway`) when no layer provides one - a config with no
gateway anywhere has a bigger problem than proxy mode, and inventing an
entry is not this verb's job. After the bind wait it
also waits for the CA file, because proxy attach preflights on the CA's
existence (LLP 0232 #proxy-attach-preflight), and attaching before the
gateway has minted it would silently produce another base-URL attach.

### Centrally managed gateways decline locally {#central-managed}

When the gateway block comes from the central layer, a local edit would be
dropped as a collision (LLP 0031 merge), so attach does not write one: it
reports that proxy mode is fleet-managed and where to enable it, and attaches
in whatever mode the fleet config yields. Same shape as LLP 0174
#non-interactive: the local CLI never fights the central layer.

### Non-interactive keeps today's behavior {#non-interactive}

A non-TTY attach (scripts, the daemon reconciler, `--json` pipelines) never
prompts and never migrates, and neither does `hyp attach all`, which never
asks questions mid-run. Each attaches exactly as today and emits one
warning naming the interactive command that migrates. A dry run is the one
silent shape: it changes nothing and promises nothing. Migration is a
one-time, human decision; burying it in automation is how a machine ends up
with a CA nobody remembers granting.

## Consequences

- The swap for an existing install is one command the user already knows,
  `hyp attach claude`, and it is idempotent: once the key is set the offer
  never appears again.
- Tests and smokes that exercise attach where a CA exists must never touch
  the host's real keychain or launchd environment. The `security` /
  `launchctl` seam gets the LLP 0181 treatment: refuse under the test
  runner, and hermetic smoke flows shim the binaries on PATH.
- `hyp status` already reports attach mode and trust (LLP 0237/0239 work);
  a base-URL attach on a proxy-capable install is now a state the status
  output can name as migratable.
