# LLP 0237: Attach installs the CA as a user-domain trusted root, and degrades politely when refused

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Plugins, Daemon
**Author:** Phil / Claude
**Date:** 2026-08-15
**Related:** LLP 0044, LLP 0232, LLP 0235, LLP 0236, LLP 0238, LLP 0239
**Extended-by:** LLP 0262 (accepted 2026-08-17; attaching the `claude`
client asks for no keychain trust at all; this decision governs the clients
still proxied, and `detach --purge` stays the removal path for a grant a
migrated machine already made)

> On macOS, proxy-mode attach installs the interception CA into the user's
> login keychain as a user-domain trusted root, via `security
> add-trusted-cert` with no `sudo`. macOS raises its own native password
> dialog; that dialog is the consent step. If the user declines, attach
> completes anyway and says exactly what will not work.

## Context

LLP 0235#client-scoped-trust ruled that trust is client-scoped and nothing
installs the CA into a trust store. LLP 0236 then established that this is
insufficient: Claude Code's SSE transport reads only the keychain-backed
default store, so file-scoped trust silently breaks Remote Control's inbound
channel. Keychain trust is a requirement of the feature working as promised,
not an escalation to be avoided. The question is how to install it with the
smallest ask.

## Options

1. **System keychain, admin domain** (`sudo security add-trusted-cert -d
   ... System.keychain`). Works (proven live), but requires admin rights and
   either a terminal `sudo` or an osascript administrator prompt, and trusts
   the CA machine-wide for every user.
2. **Login keychain, user domain** (same command, no `-d`, no `sudo`,
   `~/Library/Keychains/login.keychain-db`). Also proven live end to end:
   the bundled Bun's keychain merge honours user-domain trust settings
   (LLP 0236#user-domain-suffices). Scoped to the enrolling user, removable
   without privilege, and macOS itself raises the password dialog.
3. **Instruct the user to run the command.** Zero writes by HypAware, but
   turns onboarding into copy-pasting a `security` incantation, which is the
   exact experience this decision exists to remove.

## Decision

### User-domain trust

**Option 2.** Attach runs
`security add-trusted-cert -r trustRoot -k <login keychain> <ca-cert>` as a
child process when the CA is not already trusted. No `sudo`, no admin
rights, no shell for the user. The native macOS dialog ("you are making
changes to your Certificate Trust Settings") is the consent moment: the OS
states what is being changed and demands the user's password, which is a
stronger, better-worded consent than anything attach could print.

### Trust preflight is idempotent

**The trust step is idempotent and
checked read-only first.** Attach probes with `security verify-cert -c
<ca-cert> -p ssl` (exit 0 means already trusted) and runs the install only
when the probe fails, so a re-attach on a trusted machine shows no dialog and
writes nothing. With the long-lived CA of LLP 0238 this makes the password
dialog a once-per-machine event.

### Attach anyway on refusal

**Refusal degrades; it does not
block.** If the user cancels the dialog (or the install fails), attach
completes the rest of the attach and prints precisely what is degraded:
capture works, Remote Control's inbound channel will not, and re-running
`hyp attach claude` retries the trust step. Capture is the product's core
promise and works without keychain trust; holding it hostage to a secondary
feature would be the wrong trade. This deliberately mirrors
LLP 0232#proxy-attach-preflight in the opposite direction: a missing CA
refuses because attach cannot promise a transport the gateway is not
serving, but missing trust only narrows what is promised, so it warns.

### Darwin only

**This decision is macOS-only.** `security`,
trust domains and the keychain merge are Darwin facts. On other platforms
attach behaves as before (LLP 0232) and states that Remote Control inbound
is not supported under proxy mode there yet; a Linux equivalent (the OpenSSL
system store) is future work and must not be cargo-culted from this design.

## Consequences

- LLP 0235#client-scoped-trust is superseded in part: trust is now
  user-scoped rather than file-scoped on macOS. It remains never
  machine-wide, and the CA's name constraints (carried forward and widened
  by LLP 0238) bound what the trust can vouch for regardless of store.
- Attach gains its first interactive OS prompt. Non-interactive contexts
  (CI, scripts) hit the refusal path by construction and get the degraded
  attach plus warning, which is the correct outcome there.
- The agent-facing caveat, observed repeatedly: an AI coding agent cannot
  run `security add-trusted-cert` itself (permission classifiers block
  trust-store mutation). The flow must always work when the human runs
  `hyp attach` directly.
- `hyp status` should report the trust state alongside the CA fingerprint,
  so "dialog was cancelled last month" is diagnosable without re-running
  attach.
