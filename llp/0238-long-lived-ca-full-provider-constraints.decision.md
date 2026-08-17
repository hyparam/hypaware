# LLP 0238: The CA is long-lived, survives detach, and is constrained to the full provider set

**Type:** Decision
**Status:** Accepted
**Systems:** Core, Gateway, Config, Daemon
**Author:** Phil / Claude
**Date:** 2026-08-15
**Related:** LLP 0234, LLP 0235, LLP 0236, LLP 0237
**Extended-by:** LLP 0245 (on acceptance of 0245 the long-lived CA is not
part of capturing the `claude` client; it remains the credential for any
client still routed through the proxy)

> The interception CA becomes a per-machine, ten-year credential whose name
> constraints permit every provider host HypAware can ever intercept, so the
> keychain trust of LLP 0237 is granted once per machine and stays valid
> across detach/re-attach cycles and across enabling new providers. Detach
> keeps the CA and its trust; only uninstall (or an explicit purge) removes
> them.

## Context

LLP 0235 made two rulings that keychain trust breaks:

- **#detach-removes-the-ca**: detach deletes the CA, and re-attach mints a
  fresh one. Under keychain trust every cycle strands a stale trusted root
  in the keychain and demands a new password dialog for the replacement.
  This happened three times in two evenings of live testing; it is not an
  edge case.
- **#ca-name-constraints**: the permitted set is minted from the routing
  table, and a stored CA that does not permit a newly intercepted host is
  regenerated. Under keychain trust, enabling Codex capture later would
  regenerate the CA and demand a second trust dialog - two certs' worth of
  ceremony for one product.

Both rulings were correct for file-scoped trust, where the CA was free to
recreate. A trusted root has installation cost, so its lifecycle must
amortise that cost.

## Decision

### CA survives detach

**Detach keeps the CA and its keychain
trust.** `hyp detach claude` reverses the client attach (settings keys,
hooks, launchd environment per LLP 0239) but leaves `tls/` and the keychain
entry in place, so a later re-attach is silent: the verify-cert probe of
LLP 0237#trust-preflight-is-idempotent finds the trust already granted and
shows no dialog. `hyp daemon uninstall` removes both, and a new
`hyp detach claude --purge` does the same for a user who wants zero residue
without uninstalling. Trust removal is `security delete-certificate -c
"HypAware Local CA" -t` against the login keychain - no privilege needed,
mirroring the install.

This supersedes LLP 0235#detach-removes-the-ca. Its rationale ("a trusted
signing key that outlives the thing that installed it is the worst residue")
is answered rather than dismissed: the key still never outlives the
*install* - uninstall removes it - and what outlives the *attach* is a
name-constrained credential whose scope is exactly the hosts this product
intercepts, kept precisely so the user is not re-asked for consent they
already gave.

### Ten-year validity

**CA validity becomes ten years.** LLP 0235's
one-year validity with a thirty-day renewal roll re-mints the CA annually,
which under keychain trust means an annual stale root and password dialog.
Roots are not subject to the leaf lifetime limits browsers enforce; leaves
stay short-lived and minted in memory per host. The renewal roll is kept for
the eventual expiry, and renewal must be surfaced as a re-trust prompt, not
a silent swap.

### Full-provider constraints

**Name constraints permit the full
static provider set, not the configured subset.** The permitted
`dNSName` set is the product-level list of hosts HypAware's client adapters
can intercept - today `api.anthropic.com`, `api.openai.com`, `chatgpt.com` -
independent of which providers this install has configured. All IP space
stays excluded (LLP 0235's encoding rules and tests carry forward
unchanged). Enabling Codex capture later therefore reuses the same CA and
the same trust grant: one certificate, one dialog, every provider.

This supersedes the mint-from-routing-table rule of
LLP 0235#ca-name-constraints while keeping its invariant: the constraint set
can never lag the intercept set, now because it is a superset fixed at mint
time rather than because regeneration chases config. The list is a reviewed
constant in core; widening it (a new provider) is a real change that goes
through a doc, and only takes effect for users when their CA is next minted
or they purge and re-trust.

## Consequences

- The containment property weakens by exactly two hosts: a leaked CA key can
  now also impersonate `api.openai.com` and `chatgpt.com` to a client that
  trusts it. These are the hosts the product exists to intercept, the key
  remains 0600 in the state root, and LLP 0235's blast-radius argument
  (same-user access already reads the client's tokens) is unchanged.
- A user who trusts the CA but never enables Codex carries a trust grant for
  OpenAI hosts they do not use. The dialog and `hyp status` must name all
  permitted hosts, so the grant is informed.
- Reference counting across proxy-mode clients (flagged as future work in
  LLP 0235) becomes unnecessary for the CA itself - it is no longer deleted
  per-client - and reduces to the settings-file undo each client already
  owns.
- The concurrent-mint interleaving check and key-matches-certificate check
  of LLP 0235 remain; a ten-year CA makes silent key/cert mismatch strictly
  worse to leave undetected.
