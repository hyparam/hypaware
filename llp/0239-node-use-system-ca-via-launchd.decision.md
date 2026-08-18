# LLP 0239: `NODE_USE_SYSTEM_CA=1` is delivered through the launchd user environment

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Plugins, Daemon
**Author:** Phil / Claude
**Date:** 2026-08-15
**Related:** LLP 0232, LLP 0236, LLP 0237, LLP 0238
**Extended-by:** LLP 0262, LLP 0258 (on acceptance of 0262 the OTEL attach
delivers its environment through the settings `env` block, which reaches
every session with no launchd write and no terminal restart, so this
delivery mechanism is not used for the `claude` client)

> Proxy-mode attach sets `NODE_USE_SYSTEM_CA=1` with `launchctl setenv` and
> installs a LaunchAgent that re-applies it at login, because the variable
> must be present in the real process environment when Claude Code boots and
> no config file - HypAware's, Node's, Bun's, or Claude Code's own - can put
> it there (LLP 0236#boot-time-env, #cert-store-setting).

## Context

The keychain trust of LLP 0237 is only half the fix; Bun merges the keychain
into its default store only when `NODE_USE_SYSTEM_CA=1` is set at process
boot. Settings-file delivery is proven too late, so attach must reach the
launch environment itself. The candidates:

1. **Shell profile edit.** Attach detects the login shell and writes an
   export (fish could use a universal variable). Rejected as brittle: it is
   per-shell, invisible to GUI-launched processes, fragile across shell
   switches and dotfile managers, and dotfile edits by tools are exactly what
   users resent.
2. **A `claude` wrapper shim on PATH.** Tightest scope, but PATH shims fight
   the binary's own installer and self-updater, and break the moment the
   user invokes the real path directly.
3. **`launchctl setenv` + a LaunchAgent.** The launchd user environment is
   macOS's actual mechanism for session-wide environment: shell-agnostic, no
   dotfiles, inherited by new terminal windows and GUI apps alike. It does
   not survive reboot alone, so a small LaunchAgent re-applies it at login.
   HypAware already owns launchd plist install/uninstall machinery for the
   daemon, so this adds a managed artifact of a kind the product already
   manages.

## Decision

### Launchctl setenv

**Option 3.** Attach runs
`launchctl setenv NODE_USE_SYSTEM_CA 1` (effective immediately for
subsequently launched processes) and installs a user LaunchAgent whose only
job is to run the same command at login. Detach reverses both:
`launchctl unsetenv` and LaunchAgent removal. Unlike the CA and its trust
(LLP 0238#ca-survives-detach), the variable is re-appliable silently with no
user interaction, so it follows the attach rather than the machine: managed
artifacts that can be recreated for free are removed on detach, per
LLP 0232's release-what-you-no-longer-manage rule.

### Terminals predating attach

**Already-open terminals are told,
not fixed.** `launchctl setenv` cannot reach shells that already exist, so a
`claude` launched from a pre-attach terminal window still misses the
variable. Attach prints this: new terminal windows and GUI launches are
covered; existing windows need a new window (or an inline
`NODE_USE_SYSTEM_CA=1` prefix). `hyp status` reports whether the variable is
present in the launchd environment (`launchctl getenv`).

**Correction (2026-08-14, run G acceptance test):** the "new window"
half of the claim above is wrong. A new window of an already-running
terminal app is spawned by that app's existing process and inherits the
app's environment from before the `setenv`, so it never sees the variable;
terminal apps are single-process (ghostty, iTerm2, Terminal.app alike).
Only processes launchd starts after the `setenv` are covered: GUI apps, and
a terminal app fully quit and reopened. Attach's message now says exactly
that, printed as the final line of the attach output. The trap is
invisible to `launchctl getenv`, which reads launchd's table rather than
the shell's environment; the inline `NODE_USE_SYSTEM_CA=1` prefix remains
the per-shell workaround. The decision itself (launchctl setenv + login
LaunchAgent) is unchanged.

### Session-wide scope accepted

**Session-wide scope is accepted
deliberately.** Every process in the login session sees the variable, not
just Claude Code. Its only effect is to add the OS keychain - certificates
the operating system already trusts, plus whatever the user has explicitly
trusted - to Node's and Bun's default TLS stores, which is standard practice
in managed corporate environments and strictly widens trust toward what the
OS already believes. A per-process delivery with this reliability does not
exist (LLP 0236#boot-time-env).

## Consequences

- Attach on macOS now manages three artifact classes: settings keys plus
  hooks (LLP 0232), a keychain trust entry (LLP 0237), and a launchd
  environment variable with its LaunchAgent. The marker records all of them;
  the disk-driven undo (LLP 0045 Part 3) reverses the launchd pieces on
  detach and uninstall.
- The LaunchAgent is inert configuration (one `launchctl setenv` at login),
  installed under the user's `~/Library/LaunchAgents`, no daemon privileges
  involved.
- Non-macOS platforms skip this entirely, consistent with
  LLP 0237#darwin-only.
- If Claude Code ships builds against a Bun where the variable's behaviour
  changes (LLP 0236's canary caveat), this delivery mechanism is unaffected;
  the failure would be in what the variable does, not how it arrives.
