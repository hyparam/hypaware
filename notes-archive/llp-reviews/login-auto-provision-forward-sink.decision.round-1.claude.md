# Review of LLP 0063: Login-initiated enrollment — auto-provision the central sink

**Reviewer:** Claude (Fable 5)
**Date:** 2026-07-04
**Round:** 1
**LLP Status at review time:** Draft

*Disclosure: this reviewer participated in the grilling session that produced
D1–D6. This round deliberately hunts for what that session missed rather than
re-approving what it decided.*

## Overall assessment

The decision is sound and unusually well-grounded: it closes a real contradiction
(LLP 0061 promised "forward immediately" and shipped a dead-end note), and it does
so by reusing three Accepted decision chains (join's seed block, LLP 0025's pull
loop, LLP 0036/0037/0044's consent doctrine) instead of inventing parallel
machinery. The honest reframing — this is *enrollment*, not "add a sink" — is the
document's best property; D2's "fully enabled means the whole cascade,
deliberately" paragraph is exactly the sentence a future agent needs to not
"simplify" the feature into a broken forward-only mode.

That said, the grilling session resolved the *policy* questions and left several
*mechanism* seams under-specified. Two of them (the D4×`--no-forward` interaction,
and the post-enrollment config-pull round trip) are internally inconsistent or
rest on an unverified server-side assumption, and should be resolved in the doc
before implementation starts.

## Strengths

- **The connection-levels ladder (§connection-levels)** is the strongest single
  addition. It converts a confusing verb sprawl into four symmetric pairs, states
  the one deliberate asymmetry (`login` can create level-3 state) instead of
  hiding it, and correctly assigns `leave` the only cross-level (downward)
  cascade. Publishing it in the README is the right call.
- **D1's backward-compatibility argument is by construction, not by promise**: no
  `gateway_*` fields → the entire path is inert. That is checkable in one line of
  code and testable with today's servers.
- **D3 invents the right consent primitive.** The pre-auth warning is genuinely
  better than both alternatives it rejects: unlike a y/n prompt it doesn't block
  piped flows, and unlike a post-hoc announcement the user is informed *before*
  the accepting act (the auth). "Completing the auth is the accepting act" is a
  clean, defensible line.
- **D4's scope paragraph does real work**: keying the rejection on the machine's
  connection rather than the session store preserves LLP 0033/0058/0062's
  multi-target query design with a one-sentence refinement instead of a
  supersede, and correctly identifies the browser login as the only path that can
  re-enroll.
- **Prerequisites are named, not hand-waved.** Calling out that `hyp leave`
  appears in four LLPs with zero implementation — and scoping the minimal version
  — prevents the classic failure of shipping a rejection message that names a
  nonexistent command.

## Concerns

1. **[Definite — internal inconsistency] D4 rejects what D3 says is harmless:
   `hyp remote login <B> --no-forward` while connected to A.** D4's rationale
   for the gate is "the browser login [is] the only path that could re-enroll."
   But D3 defines `--no-forward` as discarding the gateway credential unseeded —
   a `--no-forward` login *cannot* re-enroll, by the doc's own mechanics. As
   written, D4 rejects it anyway ("rejected up front — before the browser
   opens"), which means a consultant enrolled to org A cannot browser-login to
   org B even for queries, while the *same access* via a static token is
   explicitly allowed. Either: (a) the gate exempts `--no-forward` (consistent
   with D4's own rationale — recommended), or (b) the gate is intentionally
   total, in which case D4's "the only path that could re-enroll" justification
   must be replaced with the real one (e.g. "keep the mental model simple: one
   server per machine, period") and the rejection message should mention the
   static-token escape. Resolve explicitly; an implementer can currently read
   the doc either way.

2. **[Possible — unverified server-side assumption] The enrollment only survives
   if the pulled org config re-includes the central sink.** D2 notes "a later
   real central-config pull supersedes a seed cleanly." LLP 0025's apply
   semantics mean the pulled config *replaces* the central layer — so if the
   operator's org config does not itself name the `@hypaware/central` sink (or
   names it with a `bootstrap_token` the login-enrolled machine never had), the
   first successful pull could silently disable forwarding or wedge identity.
   Join-enrolled fleets presumably already author configs that include the sink,
   but login-enrolled machines arrive *without the operator provisioning them
   individually* — that's the feature — so the assumption deserves verification
   against hypaware-server (does `GET /v1/config` guarantee the central sink
   block for login-origin gateways?). If not guaranteed, this doc needs either a
   client-side invariant (the seed's sink survives the merge; LLP 0031 layering
   may already give this — verify and cite) or a server-side obligation recorded
   in the out-of-tree LLP.

3. **[Possible — sharpest privacy edge, currently implicit] BYOD: a personal
   laptop enrolls into corporate fleet management because an email domain
   matched.** D3 handles this formally (the warning names attach + backfill +
   service install), but the doc never says the words "personal machine." The
   combination that deserves explicit acknowledgment: LLP 0037 backfill is
   default-on with **no local opt-out post-enrollment**, so one login on a
   personal machine can ship pre-existing local history to the employer's
   server, and the only moment the user could decline is the pre-auth notice.
   That may be acceptable — but it should be a stated consequence, not an
   emergent one, and it strengthens the case for the notice being loud and
   specific rather than one conditional line.

4. **[Minor — race] Two concurrent first logins (A and B) both pass the D4 gate.**
   Both provision; last write wins the single seed slot; the loser's org silently
   believes it enrolled the machine. The existing credentials lock (LLP 0065)
   covers the session store but nothing serializes seed-writes. A cheap fix:
   re-check the gate under the same cross-process lock the credential write
   already takes, and treat "seed appeared since pre-auth check" as a D4
   rejection at seed time.

5. **[Minor — lifecycle gap] A revoked/expired login-minted gateway leaves a
   machine that is locally "enrolled" but cannot forward or pull.** The doc
   inherits LLP 0061's refresh/401 path but doesn't say what the steady-state
   surface is when refresh permanently fails (operator revoked the gateway,
   server LLP 0020 D5). `hyp status` should distinguish "enrolled, forwarding"
   from "enrolled, credential dead — re-run `hyp remote login`" — otherwise the
   #126-style silent gap returns in a new costume.

## Suggestions

*In priority order.*

1. Resolve Concern 1 in D4's text (one paragraph). Recommendation: exempt
   `--no-forward`.
2. Add a short "Post-enrollment lifecycle" subsection covering Concerns 2 and 5:
   what the first config pull is guaranteed to contain (with the server-side
   citation once verified), and what `hyp status` shows when the gateway
   credential dies.
3. Name BYOD in Consequences (Concern 3), and consider one server-side follow-up
   hook: the org policy could carry a `login_enrollment: warn | off` knob so a
   tenant can disable login-enrollment for unmanaged machines without giving up
   bootstrap-token joins. That keeps the client simple (it just honors the
   absence of `gateway_*`) and puts the policy where the entitlement already
   lives. Non-standard but cheap: it's server chunk work, zero client change.
4. Specify the pre-auth notice's exact copy in the implementation PR and test it
   verbatim — this notice is load-bearing for the whole consent story (D3), so
   it should be pinned by a test the way the dead-end note currently is.
5. The `--no-forward` help text must say it declines *enrollment* (config pull,
   attach cascade, service install), not merely forwarding — the flag name
   undersells its new scope by design, so the help text has to carry the load.

## Open questions

- Concern 1's choice: is the D4 gate total, or does `--no-forward` pass it?
- Does hypaware-server guarantee the pulled org config includes the central sink
  for login-origin gateways (Concern 2)? Needs a check against server LLP
  0009/0020 before implementation.
- What does `hyp leave` do about the server-side gateway row — best-effort revoke
  call, or local-only teardown? The Prerequisites scope is local-only; a leave
  that leaves a live credential server-side is defensible (it expires) but worth
  one sentence.

## Recommended next step

**Stay `Draft` for one focused revision** addressing Concerns 1–3 (the first is a
genuine internal inconsistency; the second is an assumption that could invalidate
D2's cascade story; the third is a one-paragraph consequence). None threaten the
core decision — the shape (enrollment, default-on, pre-auth warning, exclusive
connection, join parity) survives this review intact. After that revision, move
to `Review` and get a second model's eyes on it, particularly on the D3 consent
mechanics; this reviewer helped author them and should not be the only reviewer.
