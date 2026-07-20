# LLP 0117: @hypaware/claude-account owns the Anthropic credential; the kind is a fleet-policy switch

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Config, CLI
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0061, LLP 0063, LLP 0099, LLP 0115, LLP 0116

> LLP 0116 decides that Desktop presents a credential obtained from a local
> helper. This decision records where that credential comes from: a
> dedicated `@hypaware/claude-account` plugin that owns Anthropic credential
> provisioning, with the credential kind selected by fleet policy - a static
> org key, or a per-user subscription sign-in.

## Context

Two real populations want Desktop capture:

- **Org-key fleets**: a static Anthropic API key, API-billed. Zero per-user
  state; an admin can configure it once, centrally, and it is genuinely
  set-and-forget.
- **Subscription fleets**: each person's own Max/Pro account. Subscription
  economics, but inherently per-user: someone has to sign in on each
  machine, so it can never be fully admin-set-and-forget.

The prototype that proved the routing relayed the Claude CLI's own
subscription token out of the macOS keychain. As a product mechanism that
is the wrong substrate: it requires the user to be logged into the CLI,
trips a keychain consent prompt, silently breaks if the CLI logs out or
changes its storage, and freeloads on the CLI's token refresh.

Prior art: LLP 0099 already routes Codex by auth kind at attach time;
LLP 0061/0063 already maintain a long-lived stored credential with
single-flight refresh (the central sink's gateway identity). Both patterns
recur here.

## Options

1. **Reuse the CLI's keychain token** - the prototype. Fragile coupling to
   another app's private storage (see Context); rejected as product
   mechanism.
2. **Org key only** - robust and simple, but abandons subscription
   economics entirely, which the fleet explicitly wants as an option.
3. **A credential plugin with a fleet-policy mode switch** - one owner for
   provisioning, storage, refresh, and the helper surface; the kind is
   config: `org_key` or `subscription`.

## Decision

<a id="credential-plugin"></a>**Option 3.** `@hypaware/claude-account` is
the single owner of the Anthropic credential. It contributes the
`claude_account` config section, provides the `hypaware.anthropic-credential`
capability for other plugins (the Desktop profile renderer consumes it),
and registers the `claude-account` CLI commands: `credential` (the LLP 0116
helper surface), `login` / `logout` (subscription mode), and `status`.

<a id="mode-is-fleet-policy"></a>**The mode is a fleet-policy switch.**
`claude_account.mode` selects `org_key` or `subscription`. Because plugin
config merges under the central-wins layering (LLP 0031), a fleet config
that names the section locks the mode: the choice between API billing and
subscription economics is the org's, made once, centrally. `org_key` mode
reads the key from config (`api_key`) or an environment variable
(`api_key_env`), so fleets can push the name of a variable instead of the
secret itself.

<a id="subscription-signin"></a>**Subscription mode is HypAware's own
one-time sign-in.** `hyp claude-account login` runs a browser OAuth flow
("Sign in with your Claude account") and stores the resulting token pair
itself; it never reads another app's credential storage. The UX target:
company-key mode means nobody logs in, it is just there; subscription mode
means each person clicks sign in once.

<a id="store-discipline"></a>**The store follows the existing credential
discipline.** One JSON file under the plugin state dir, `0600` with `0700`
dir, atomic tmp+rename writes, kind-discriminated records, single-flight
refresh ahead of expiry, and fingerprints (never values) in logs and
diagnostics - the same rules as `remote-credentials.json` and the central
sink's `identity.json` (LLP 0061).

<a id="tos-open-question"></a>**Subscription-token handling is recorded as
unsupported, not prohibited - and that framing is deliberate.** Forwarding
a user's own subscription traffic to Anthropic through the local gateway is
the same posture the CLI and Codex attach have today. Operating an OAuth
sign-in and token store outside Anthropic's first-party apps is not a
published, supported integration surface, so it may break without notice
and its terms-of-service standing has not been verified against the actual
Consumer Terms. Until someone does that verification, org-key mode is the
recommended fleet default and subscription mode is an informed opt-in. This
paragraph must not be hardened into "prohibited" (or softened into
"supported") without citing verified terms text.

## Consequences

- Desktop's two credential modes ride one mechanism and one helper
  (LLP 0116); adding a future mode (e.g. a server-side subscription
  broker) is a new record kind behind the same capability, not a new
  surface.
- The plugin is bundled but excluded from default activation, following
  the established precedent that secret-bearing / spend-capable plugins
  are explicit `plugins[]` decisions, never defaults.
- Subscription mode's refresh keeps working only while the stored refresh
  token is honored upstream; a revocation shows up as a helper failure and
  a `status` diagnostic, not a silent capture gap (Desktop re-runs the
  helper on 401 and surfaces the error).
- Per-machine subscription sign-in composes with the non-user-reversible
  managed profile: the profile (org-pushed) never changes per user; only
  the locally resolved credential differs.
