# LLP 0578: An organization can turn off the first-sync review hold

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Sinks, Privacy
**Author:** Kenny / Claude
**Date:** 2026-11-04
**Related:** LLP 0101, LLP 0031, LLP 0309

> Browser sign-in pauses a machine's first upload until end of day so the person
> can review what was recorded. An organization that deploys HypAware through its
> MDM may want data right away, or may want the review kept, and that choice
> belongs to the organization. A new central config key decides it.

## Decision

`first_sync_hold` is a top-level boolean, defaulting to the current behavior when
absent. `false` turns the hold off for the organization's machines.

<a id="org-owned"></a>**Only the central layer counts.** Unlike `auto_update`, a local
value is ignored when merging. The hold protects the person from the organization's
upload, and this key is how the organization takes responsibility for removing it.
Anyone who wants to send early on their own machine already has `hyp sync`.

<a id="marker-cleared"></a>**The setting clears the marker.** Sign-in writes the hold
marker before the org's config arrives, and status, `hyp sync` and setup all read that
marker. So the sink driver removes it on its first run under a config that turns the
hold off, and no reader needs to know about the key. A machine stays held until then,
which is the safe direction: nothing uploads before the config that permits it. A marker
that can't be removed doesn't block uploads, and the next run tries again.

## Consequences

- `hyp status` can show a hold for up to a minute after the config applies.
- The server validates saved org configs with this package's schema, so it has to
  depend on a release containing this key before an org can save it.
