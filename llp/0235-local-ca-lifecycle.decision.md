# LLP 0235: The interception CA is minted in-process, name-constrained, and removed on detach

**Type:** Decision
**Status:** Accepted
**Systems:** Core, Gateway, Config, Daemon
**Author:** Phil / Claude
**Date:** 2026-08-14
**Related:** LLP 0016, LLP 0045, LLP 0114, LLP 0116, LLP 0206, LLP 0231
**Superseded-by (in part):** LLP 0237 (#client-scoped-trust), LLP 0238
(#detach-removes-the-ca, #ca-name-constraints mint-from-routing-table,
#ca-lifecycle one-year validity)
**Extended-by:** LLP 0262 (on acceptance of 0262 the `claude` client's
attach no longer depends on the CA; the CA lifecycle stands for any client
still routed through the proxy)

> The machine-local certificate authority is generated in-process with no
> `openssl` shell-out and no new dependency, constrained to the hosts it
> intercepts, trusted only by the attached client, and deleted when the client
> detaches.

## Context

Proxy-mode capture needs to present a certificate for `api.anthropic.com` that
Claude Code will accept. That means a local CA, which is the first secret-bearing
material this product has ever held and a direct qualification of LLP 0016 and
LLP 0116's "the gateway is a pure passthrough; no secret-bearing code".

Node can parse and verify certificates but cannot generate them.

## Options for minting

1. **Shell out to `openssl`.** Rejected: macOS ships LibreSSL rather than
   OpenSSL and their flag surfaces for extensions differ, Windows ships neither,
   and the failure would appear at attach time on a customer machine.
2. **Add a certificate library.** Rejected: a large dependency to audit for a
   package whose runtime dependency list is deliberately short, to do something
   narrow.
3. **Emit the DER directly**, signing with `node:crypto`. What is actually needed
   is one self-signed CA and one server leaf per intercepted host, both with a
   fixed extension set.

## Decision

### Minted in process

**Option 3.** Certificates are assembled as DER in
about two hundred lines and signed with `node:crypto`, scoped deliberately to EC
P-256 with ECDSA-SHA256, UTCTime only, and only the extensions the interception
path needs. This is not a general certificate authority and should not grow into
one.

### CA name constraints

*Superseded in part by
LLP 0238#full-provider-constraints: the permitted set is now the full static
provider list rather than minted from the routing table, so a trusted CA is
never regenerated when a provider is enabled. The encoding rules and the
IP-exclusion below carry forward unchanged.*

**The CA carries `nameConstraints` permitting
only the hosts it intercepts.** This is the containment property the design
rests on: a leaked CA key must not be a universal signing key for any client
that trusts it. The permitted set is minted from the routing table (LLP 0234),
and a stored CA that does not already permit a newly intercepted host is
regenerated rather than reused, so the constraint set can never silently lag the
intercept set.

Constraining dNSName alone is **not** sufficient, and this was got wrong first
time round. RFC 5280 §4.2.1.10 leaves any name form absent from
`permittedSubtrees` unrestricted, so a CA permitting only `api.anthropic.com`
will still sign a chain-valid leaf for an IP address, which a client connecting
by IP accepts. The whole IPv4 and IPv6 space is therefore in `excludedSubtrees`,
closing the one other name form a TLS client identifies a server by.

The encoding detail that makes or breaks this: `permittedSubtrees [0]` and
`excludedSubtrees [1]` are **implicit** tags, so each replaces the `SEQUENCE OF`
tag rather than wrapping it. Wrapping produces a structure OpenSSL cannot parse,
which silently voids the constraint and takes chain validation down with it. It
is asserted by a test that mints a leaf for another host and requires the
handshake to fail with `permitted subtree violation`.

### Constraints are read back structurally

**Reading the constraints
back is a DER walk, not a byte scan.** The stored constraint set decides whether
a CA can be reused, so it has to be read accurately. Scanning the certificate
for context-tag bytes also matches the two key-identifier hashes and the
signature: roughly one CA in seven hundred reported a phantom permitted host,
any name needing a long-form length read back as absent (regenerating the
machine's CA on every single boot), and excluded names could be reported as
permitted.

### Client-scoped trust

*Superseded in part by LLP 0237: on macOS,
attach now also installs the CA as a user-domain trusted root in the login
keychain, because file-scoped trust does not reach Claude Code's SSE
transport (LLP 0236#split-trust). Trust remains never machine-wide.*

**Trust is client-scoped, never system-wide.**
The CA is referenced by `NODE_EXTRA_CA_CERTS` in the attached client's own
settings file. Nothing installs it into the system trust store, so nothing else
on the machine is affected. This is a materially smaller ask than the
Zscaler-style system-wide trust enterprise TLS inspection normally requires, and
it is the reason proxy mode needs no privileged install step.

### CA lifecycle

*Extended by LLP 0238#ten-year-validity: CA
validity is now ten years, because an annual re-mint would strand the
keychain trust of LLP 0237 every year. The renewal roll and visibility
rules below stand.*

**Per-machine, 0600, never shipped, and visible.** The
key is generated locally at gateway start, written mode 0600 inside the state
root, and is never an export, a sink payload or a support-bundle file. Leaves
are minted per host in memory and never written to disk at all: they are cheap
to recreate, and every file holding a private key is one more thing to exclude
from exports and clean up. The CA rolls when it is within thirty days of expiry.
`hyp status` shows the fingerprint, expiry and intercepted hosts.

### Detach removes the CA

*Superseded by
LLP 0238#ca-survives-detach: detach keeps the CA and its keychain trust;
uninstall and `hyp detach --purge` remove them.*

**Detach deletes the CA.** A trusted signing
key that outlives the thing that installed it is the worst residue this feature
can leave, so removal runs in the same plugin-agnostic, disk-driven undo that
removes the trust pointer (LLP 0045 Part 3), keyed on the marker's `mode`. This
is also why the CA lives in core rather than in the gateway plugin: `hyp detach`
and `hyp daemon uninstall` must be able to delete it with the plugin unloaded,
so its removal cannot depend on a plugin being loadable.

Removal runs *after* the settings write. If it fails, the client is already
un-attached and safe, and the leftover key is reported rather than silently
retained.

## Consequences

- **LLP 0016 / 0116's passthrough claim is qualified, not discarded.** The
  gateway now holds key material, but it still adds no credential of its own to
  any request and remains byte-transparent to the upstream. That was the part of
  the claim that mattered.
- **LLP 0114 #interception-accepted is revisited by name and its conclusion
  holds.** The CA key is 0600 in the state root, so reading it requires the
  same-user access that section already conceded lets an attacker read the
  client's tokens directly. The security boundary has not moved; the blast
  radius within it has. Mutual authentication is still not added, per that
  section's explicit instruction not to add it as a drive-by hardening.
- **LLP 0206's reasoning extends.** Uninstall must cascade the detach not only
  because a dangling base URL breaks model calls, but because a dangling
  `HTTPS_PROXY` breaks all HTTPS and a dangling CA is trusted key material with
  no owner.
- Detach deletes the CA whenever a proxy marker is reversed. This is correct
  while Claude is the only proxy-mode client; a second one would need
  reference counting before it could be added. The state root is resolved from
  the caller's `homeDir`, not the ambient one: this undo is routinely pointed at
  a sandbox, and resolving the settings file from one home while resolving the
  CA from another deletes a different install's key material.
- A stored CA is reused only when its key still matches its certificate. The two
  are separate writes with no lock, so concurrent daemon starts can interleave
  and leave one process's key beside the other's certificate; the pair parses and
  the dates are fine, so without an explicit check it would be reused for its
  full lifetime while every handshake failed.
- The renewal window is deliberately longer than a leaf's lifetime. Leaves are
  minted against whatever CA the process loaded at start, so a daemon booting
  with less CA life left than a leaf lives would issue leaves that outlive their
  issuer - reachable for launchd and systemd daemons that run for months.
