# LLP 0266: Four residuals in the local CA: time encoding, IP literals, constraint reuse, and legacy proxy reversal

**Type:** Decision
**Status:** Accepted
**Systems:** Core, Gateway, Config
**Author:** Phil / Claude
**Date:** 2026-08-19
**Related:** LLP 0232, LLP 0234, LLP 0237, LLP 0239
**Extends:** LLP 0235 (#minted-in-process: the encoding scope widens by one
tag, and gains a name-form rule), LLP 0238 (#ten-year-validity made the time
encoding reachable; #full-provider-constraints keeps its invariant under a
weaker reuse test)

> Four defects found by review of the hand-rolled X.509 minter and the local CA
> lifecycle, none of which changes what LLP 0235 or LLP 0238 decided. Two of
> them turn a working install into a permanently broken one with no user-visible
> cause: a ten-year CA whose `notAfter` crosses 2050 is born expired, and
> narrowing the configured upstream set strands the user's keychain trust grant.
> The other two are honesty defects: an IP-literal upstream mints a certificate
> nothing can accept while logging `interception_ready`, and a legacy detach
> reports the user's own corporate proxy settings as HypAware residue.

## Context

The X.509 encoder in `src/core/tls/x509.js` was written under LLP 0235, whose
scope paragraph reads "EC P-256 with ECDSA-SHA256, UTCTime only, and only the
extensions the interception path needs", and whose CA validity was one year.
LLP 0238 raised CA validity to ten years, because the CA became a keychain
trusted root (LLP 0237) and every re-mint costs the user a password dialog. It
also replaced the mint-from-routing-table constraint rule with a fixed static
provider list.

Neither change revisited the encoder's assumptions, and both invalidated one.
This document records the four corrections and the reasoning that fixes them
rather than the shape of any of them being novel design.

<a id="generalized-time-past-2049"></a>

## Validity dates past 2049 use GeneralizedTime

**A certificate date from 2050 on is encoded as GeneralizedTime, not
UTCTime.** UTCTime carries a two-digit year read against RFC 5280's sliding
window, which puts `50`-`99` in the 1900s: it cannot express 2050 at all. LLP
0235's "UTCTime only" was safe because nothing minted lived longer than a year,
and it stopped being safe when the CA's `notAfter` moved ten years out.

The failure is total and silent. Minting with `notBefore` in 2041 and the
shipped validity yields a certificate whose `validTo` parses back as
`Dec 30 1950`. `loadLocalCa` then reads a CA already inside the renewal window
and re-mints on **every** boot, and every intercepted handshake fails with
nothing naming the cause. A machine does not have to be in 2041 to get there: a
dead RTC battery or a VM restored with a skewed clock is enough, and the
renewal roll means real installs reach it from roughly 2040 onward.

RFC 5280 4.1.2.5 already settles which encoding applies at which date, so the
encoder follows it: UTCTime through 2049, GeneralizedTime from 2050. Years
outside 1950-9999 throw rather than encode something misleading. This widens LLP
0235's deliberate scope by exactly one tag, which is the smallest change that
makes a ten-year CA representable; the rest of that scope (one curve, one
signature algorithm, one extension set) is untouched.

<a id="ip-literals-are-refused"></a>

## IP-literal hosts are refused

**A certificate host must be a DNS name.** The ASCII guard in `x509.js`
rejected anything unencodable as an IA5String but accepted `10.0.0.5`, and
every host it accepts is encoded as a `dNSName`. No TLS client matches a
dNSName against a connection made to an IP address, and LLP 0235's
IP-exclusion puts the whole IPv4 and IPv6 space in `excludedSubtrees`, so such
a certificate could not chain even if a client did look. An operator
configuring `base_url = "https://10.0.0.5/v1"` therefore got a CA that minted
cleanly, an `aigw.interception_ready` log line, and handshake failures with no
stated cause.

Supporting IP literals is **not** what this decides. It would mean an
`iPAddress` SAN and a hole in the IP exclusion LLP 0235 put there deliberately,
which is a design change and needs its own document. What is decided is that
the impossible case is named instead of minted.

Because a refusal at mint time would take the whole install's interception down
over one bad upstream, the gateway makes the same judgement one step earlier:
an IP-literal upstream host is dropped from the host set before the CA is
requested and reported as `aigw.interception_host_unsupported`. Its traffic is
tunnelled blind and unrecorded, exactly as an unconfigured host's is, while
every other upstream keeps being captured.

<a id="stored-superset-is-reusable"></a>

## A stored superset is reusable

**A stored CA is reused when its permitted set *covers* the requested hosts,
not only when it equals them.** `loadLocalCa` required exact equality, while
the gateway asks for `INTERCEPT_PROVIDER_HOSTS` union the configured upstream
hosts. Bundled adapters all live inside the static list, so standard installs
never noticed. An install with one operator-configured upstream outside it
minted a wider CA and got keychain trust for it, and the day that upstream was
removed from config the next daemon boot saw a size mismatch and silently
re-minted.

That strands the one-time password-dialog trust grant which is the entire
reason LLP 0238 made the CA long-lived and made detach keep it, and every
proxied handshake fails until the user re-attaches and re-approves. Widening
genuinely needs a new CA; narrowing does not.

LLP 0238#full-provider-constraints keeps its invariant unchanged: the constraint
set can never lag the intercept set, because a CA that does not already permit
a requested host still regenerates. The migration it described also still
happens, because a CA minted under the old routing-table rule is a strict subset
of the static provider list every caller now asks for.

<a id="legacy-proxy-reversal-needs-a-damaged-record"></a>

## Legacy proxy reversal needs a damaged record

**The proxy-key reversal on the legacy detach branch runs only for a marker
whose undo record is damaged.** It was gated on the marker carrying a `port`,
which every genuine pre-record legacy marker does, so it ran on plain base-URL
legacy detaches too. Proxy mode did not exist when those markers were written,
so any `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS` sitting beside one is the user's
own: a corporate CA bundle, a corporate proxy. The reversal reported them as
HypAware residue of unknown provenance ("the undo record that would say whether
hypaware set it is unreadable"), which is a false claim about settings this
product never touched.

The gate becomes the condition the branch's own comment already describes: a
damaged **current**-shape marker, detected exactly as the rest of that branch
detects one. The case the reversal exists for is unaffected, and LLP
0232#detach-restores-any-managed-key still holds for it.

## Consequences

- Certificates minted from 2050 on are two bytes longer in each validity field
  and carry tag `0x18`. Nothing in this tree reads those fields by tag; the CA
  is read back through `crypto.X509Certificate`, which handles both.
- An operator who wants an IP-literal upstream captured now gets a named warning
  instead of silence, and their remedy (give the host a DNS name) is stated. The
  upstream still proxies; only its capture is lost.
- A CA whose permitted set is wider than this boot's request is now reused, so
  `hyp status` may report permitted hosts that no configured upstream names.
  That was already true for the static provider list under LLP 0238, and the
  informed-grant consequence recorded there covers it.
