# LLP 0524: Setup refuses a config that would strand a still-proxying client attach

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Plugins, Gateway
**Author:** Phil / Claude
**Date:** 2026-10-17
**Related:** LLP 0031, LLP 0045, LLP 0185, LLP 0233
**Extends:** LLP 0243 (#user-key-wins: a non-interactive re-init still
composes from scratch, but `--force` no longer covers dropping a proxy a
client still depends on), LLP 0244 (#central-managed: the same central-layer
rule decides here), LLP 0262 (#migration: `hyp client attach claude` is the
repair this refusal names)
**Tracker:** hyparam/hypaware#960

> Before `hyp setup` writes a config over an existing one, it reads each
> client's attach marker. If a client's marker says it is attached through the
> gateway proxy (`mode: "proxy"`), and the config about to be written does not
> turn the proxy on, setup refuses: it writes nothing, names the client, and
> names the two commands that fix it. `--force` does not override this.

## Context

Since LLP 0262 the Claude row no longer declares `compose.gateway_proxy_mode`,
so no setup path composes `proxy_mode: true` any more. A machine set up before
LLP 0262 can still have Claude attached through the proxy: the
`~/.claude/settings.json` marker says `mode: "proxy"` and the managed env sets
`HTTPS_PROXY` to the local gateway.

LLP 0243 #user-key-wins says the interactive lane carries an existing gateway
entry's `proxy_mode` forward, while a non-interactive re-init (`--yes`, a
preset, `--from-file`) composes from scratch behind `--force`. On that machine
`hyp setup --yes --force` therefore writes a gateway with no `proxy_mode`. The
gateway then tunnels Claude's traffic without reading it, capture drops to
zero, and the only sign is the gateway's `aigw.proxy_mode_stale_ca` log line
(issue #960, from #923 finding 1).

`--force` is consent to replace the file. It is not consent to change how an
attached client's traffic is carried.

## Decision

### The check {#check}

One read-only check runs before every setup write of a whole local config:
the wizard commit (interactive, non-interactive and `--dry-run` alike),
`--from-file`, and the `hyp setup claude-and-otel-local` preset. In the
wizard it runs before the folder-ask write as well, so a refused run writes
nothing at all.

It refuses when all of these hold:

1. A config already exists at the target path. A fresh install has nothing to
   strand, so it is not checked.
2. The config about to be written has no enabled `@hypaware/ai-gateway` entry
   with `proxy_mode: true`.
3. The central layer does not name `@hypaware/ai-gateway`.
4. Some client's attach marker records `mode: "proxy"`.

Only clients whose attach probe is a JSON marker are read, because that is the
only marker that records a mode. The read is the same descriptor-driven probe
`hyp status` uses (LLP 0045): one bounded settings-file read per such client,
no history scan, no polling.

The evidence is the marker, never the config. An absent `proxy_mode` key does
not mean a client is proxy-attached, and a CA on disk does not either. A
marker in `otel` or `base_url` mode is already off the proxy, so setup proceeds.

### The refusal {#refusal}

The refusal is the same in every mode: one `hyp setup:` line on stderr, exit
1, and a `wizard.pick.write_config` span with `status: aborted` and
`hyp_reason: legacy_proxy_attachment`. It names the client and the two fixes:
`hyp client attach <client>` (for Claude this is LLP 0262's migration to the
OTEL attach) or `hyp client detach <client>`. Setup does not run either one,
and it offers no new migration prompt. Moving a client off the proxy changes
its settings and its trust, which a setup run was not asked to do.

A dry run gives the same refusal and exit code, so it shows what the real run
would do.

### When the marker cannot be read {#unreadable}

If a client's settings file exists but cannot be read or parsed, and
conditions 1 to 3 hold, setup cannot tell whether that client still needs the
proxy. It refuses with `hyp_reason: attach_state_unreadable`, naming the
client and its settings path. It does not quote the parse error, because the
file can hold credentials. A missing settings file means not attached, as
everywhere else.

### Central and explicit settings {#central}

When the central layer names the gateway plugin, the LLP 0031 merge drops the
local gateway entry, so a local write cannot change the proxy either way. The
check passes and says nothing, the same rule as LLP 0244 #central-managed.

An explicit `proxy_mode: true` that the interactive lane carries forward
passes the check. An explicit `false` with a proxy-attached client is refused
like an absent key, because the client still depends on a proxy the config
turns off.

## Consequences

- A legacy proxy-attached machine has to move the client first
  (`hyp client attach claude`), then re-run setup. After the move the marker
  reads `otel` and setup proceeds.
- On the team pathway, enrollment happens before the config commit, as it did
  before. A refusal at the commit point narrates the enrolled state the same
  way the existing overwrite refusal does.
- A malformed `~/.claude/settings.json` now blocks a setup that would replace
  an existing config without a proxy. Claude Code itself rejects that file, so
  fixing it comes first either way.
