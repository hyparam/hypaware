# Review of LLP 0022: Remote Config and Join Flow

**Reviewer:** Claude (Fable 5)
**Date:** 2026-06-12
**Round:** 1
**LLP Status at review time:** Draft

## Overall assessment

This is a good design and a notably complete one for a Draft: the join flow
is coherent end-to-end, the hard decisions (process-level restart, kernel
apply engine, bundled-plugin pin semantics, probation signal) are made
explicitly with rationale rather than left to the implementer, and the spec
is honest about what it defers. The strongest property is that several
mechanisms collapse into single primitives — convergence reporting, probation
clearing, and rollback visibility are all the same `GET /v1/config` request;
rollback is the same staged restart as apply. That economy is what makes the
"one remembered bad etag, no denylist" simplicity credible.

The main weakness is at the seams the restart creates: the spec decides *who
owns* probation state (kernel) but not *who watches the clock* or how the
plugin's successful poll reaches the kernel, and it doesn't say what happens
when the applied config crashes the daemon faster than probation can be
evaluated. These are not flaws in the design — they are consequences of the
(correct) restart decision that the spec hasn't finished chasing down.

## Strengths

- **The probation signal choice is genuinely elegant.** Clearing on the first
  authenticated poll makes client-side health and server-side convergence the
  same observable event, and the explicit rejection of ingest-POST as the
  signal (idle gateways must clear probation) shows the edge case was
  actually considered.
- **The ESM-module-cache argument for process restart** is the right kind of
  rationale: it converts a style preference ("restarts are cleaner") into a
  correctness requirement (in-process re-activation would execute code other
  than the hash-verified artifact). A future agent cannot "optimize" this
  away without confronting a stated invariant.
- **Seed-as-ordinary-config** keeps faith with LLP 0010#no-mode-field — no
  seed file format, no kernel seed state — and gets crash-safety for free:
  rollback from the first apply lands on the seed, which the spec correctly
  identifies as a legitimate steady state rather than a special case.
- **The bundled-plugin trust-boundary argument** (hash-checking code that
  ships in the same npm package as the verifier buys nothing) is correct and
  prevents the always-mismatching-hash failure mode that a naive uniform rule
  would have shipped.
- **The kernel/plugin split for apply** is justified on the right grounds:
  rollback state must survive the restart, and rollback is exactly the code
  path that must be testable without HTTP.
- The open questions section records *why* the bundled-pin strictness was
  deferred and what the considered alternative was — that's the difference
  between a deferral and a hole.

## Concerns

1. **[Definite, trivial] The join sequence still says "kernel reload."**
   Step 4 reads "Apply (persist + kernel reload)" — stale wording from before
   the staged-restart decision; the apply section below contradicts it. Fix:
   "Apply (persist + staged restart)".

2. **[Definite] The probation watchdog's owner and evaluation point are
   unspecified.** The marker is kernel state and "the kernel rolls back," but
   the clearing event is observed by the *central plugin* (its poll), and the
   window can expire while the plugin is wedged — wrong-but-present URL is
   exactly the residue case the server guarantees don't cover. Two things
   must be stated: (a) the kernel owns the probation timer and rollback
   decision *independently of the central plugin functioning*; (b) probation
   expiry is also evaluated **at boot, before plugin activation** — otherwise
   a kernel-killing-but-valid config that crashloops under the service
   manager's relaunch policy may never stay alive long enough for a running
   timer to fire, and the gateway never rolls back. Boot-time evaluation
   closes the crashloop case. Resolve by adding both sentences to
   #post-apply-probation.

3. **[Possible] The plugin→kernel "poll succeeded" signal path is
   unspecified.** The facade shape is deliberately TBD, but this particular
   signal is load-bearing for rollback correctness, and its absence invites
   an implementer to have the plugin clear the marker file directly —
   violating the state-ownership rule the spec itself establishes. One line
   ("the facade includes a confirmation call; the plugin never touches
   probation state") would pin it without designing the API.

4. **[Possible] The etag sidecar's update timing now crosses the ownership
   boundary.** The sidecar is plugin-owned wire bookkeeping, but apply is
   kernel-owned, and the sidecar must come to reflect the new etag exactly
   when the new config becomes the running one (during probation the new
   config *is* running, so presenting the new etag mid-probation is correct —
   and rollback must revert the sidecar too, or the gateway will present a
   converged etag while running last-known-good). Who writes it, and when, in
   both the apply and rollback directions? This is the one place where
   "kernel owns apply" and "plugin owns the sidecar" genuinely collide;
   resolve by specifying the handoff (simplest: the facade passes the etag
   with the document, the kernel stages both, and the plugin re-reads the
   sidecar at boot).

5. **[Minor] Rollback leaves orphaned installs.** A failed config may have
   hash-verified and installed plugins before validation or probation failed;
   rollback restores the config but the spec says nothing about the installed
   trees or lock-file entries. Probably correct to leave them (the lock file
   records installs, not the active set, and re-apply after a fixed config
   becomes cheaper) — but say so, or the lock file's meaning quietly shifts.

6. **[Minor] `hypaware join <url> <token>` puts a credential in argv** —
   shell history and process listings on the very MDM-scripted machines this
   targets. Policy tokens are multi-use and fleet-wide, which raises the
   blast radius. Suggest the command also accept `--token-file` / stdin and
   the spec recommend that form for MDM scripts.

## Suggestions

Prioritized:

1. Fix concern 1 (one line) and add the two probation sentences from
   concern 2 — these are the only changes I'd block on.
2. Pin the confirmation-signal ownership (concern 3) and the sidecar handoff
   (concern 4) in a sentence each.
3. **Add an operator-visibility line:** probation state, last rollback, and
   the remembered bad etag should surface in `hypaware status` (LLP 0009
   core-rendered status). "Rollback diagnosis stays in client logs for V1" is
   fine for the server side, but the operator standing at the machine
   shouldn't need log spelunking to learn the gateway rejected a config —
   and this spec's own log-driven-development culture argues for it.
4. **Consider A/B config slots as the implementation idiom** for
   "file swap": write configs to content-addressed or alternating paths and
   flip an atomic pointer (symlink or one-line file). Same semantics the spec
   already requires, but it makes "persist last-known-good" crash-safe by
   construction — there is no moment where a crash between persist and
   restart leaves an ambiguous operative config. Non-standard for config
   files, standard for OTA updates, and this *is* an OTA update scheme.
5. The "chained apply" case is worth one sentence: a probation-clearing poll
   may itself return 200 with a newer revision, triggering an immediate
   second apply. This is correct behavior (each apply gets its own
   probation), but stating it prevents an implementer from "helpfully"
   serializing or suppressing it.

## Open questions

Beyond the three the spec already records (all appropriately deferred):

- Where does probation rollback report *to*? The server sees non-convergence
  via etag, but cannot distinguish "rolled back" from "never applied." If the
  `gateways` dataset later wants a rollback column, the client needs to have
  been recording the reason from day one — cheap now, annoying to retrofit.
- Does the lock file distinguish "installed and in the active config" from
  "installed, orphaned by rollback"? (Falls out of concern 5.)
- Is there a maximum config document size the client will accept? A
  wholesale-replace model means a malformed-but-authenticated 200 of
  arbitrary size goes straight into memory and onto disk; a stated cap is
  one line of defense-in-depth.

## Recommended next step

Stay `Draft` for one more pass: address concerns 1–2 (small, mechanical) and
decide on 3–4 (a sentence each). After that this is ready to move to
`Review` — the design itself is sound, the decisions are well-argued, and
nothing here is wrongheaded. Note that a single AI review is not sufficient
for acceptance; this round came from a reviewer who participated in the
grilling session that shaped the document, so an independent model's review
(and human judgment) should follow once the Draft revisions land.
