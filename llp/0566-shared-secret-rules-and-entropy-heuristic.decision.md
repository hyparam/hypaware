# LLP 0566: Shared secret rules and a random-token heuristic

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Privacy
**Date:** 2026-11-01
**Related:** LLP 0503

Extends [LLP 0503](0503-export-content-redaction.decision.md) (#export-seam:
the built-in set it names grows by three formats and one heuristic).

## Shared rules {#shared-rules}

The built-in credential rules live in one module, `src/core/secret_rules.js`.
Export redaction calls it for every exported string. Recording-time redaction
is to import the same module rather than keep its own copy, so a rule added
once applies at both times. Sensitive-file and credential-key matching move
there too. Custom patterns stay with the export worker (LLP 0503
#custom-regex).

## Added formats {#formats}

The built-ins also mask:

- Google API keys: `AIza` and 35 base64url characters.
- Stripe live secret keys: `sk_live_` and at least 24 alphanumerics.
- JWTs: three base64url segments, the first starting `eyJ` (the encoding of
  `{"`), with or without a `Bearer` prefix. An empty signature segment still
  counts. A match starts only where a run of base64url characters starts; a
  word-boundary start retries inside a long run and is quadratic in it.

## Entropy heuristic {#entropy-heuristic}

A secret with no recognizable prefix is caught only by its shape. A candidate
is a whole run of `[A-Za-z0-9_-]` of 32 to 128 characters. It is masked only
if every test below passes, so each test can only narrow what is masked:

- The run is not part of a path, URL, base64 blob, hostname or dotted name: no
  `/` or `+` on either side (after trailing `=` padding), and no `.` joining
  it to another token.
- It is not padded standard base64: a run with no `-` or `_` whose `=`
  padding brings it to a multiple of four characters is an encoded digest or
  public key. Padded base64url (a Fernet key, say) is still tested.
- It mixes uppercase, lowercase and digits. Hex lacks one of these, so commit
  SHAs, digests and UUIDs are never masked.
- At least 0.42 of adjacent characters change class. camelCase and snake_case
  names stay under 0.4.
- At least 0.06 of adjacent pairs are ones an identifier rarely has: two
  capitals, a capital then a digit, or a digit then a lowercase letter.
  PascalCase names with digits between words have none.
- Its Shannon entropy is within 0.5 bits of what a uniform draw from 62
  characters of that length is expected to have.
- It is not base64 of 7-bit text. Encoded ASCII leaves the same three bits
  clear in every 4-character group, which a random token does in about one
  group in eight.
- It does not start with a provider identifier prefix such as `chatcmpl-`,
  `msg_`, `toolu_`, `call_` or `sha512-`. Those IDs look random but are
  recorded routinely.
- It is not labelled as a digest or public key: no `h1:`, `SHA256:`,
  `sha-256=` or similar, and no `ssh-ed25519` or other SSH key type, directly
  before it.
- It is not inside a PEM block, from a whole `-----BEGIN ...-----` line to
  its `-----END ...-----` line. Private-key blocks are masked whole before
  the heuristic runs; certificates and public keys are left alone. A bare
  `-----BEGIN ` in code, or a block that no END line closes, shields nothing.
  A BEGIN line pairs with the next END line whatever lies between, so text
  between an unclosed block and a later one, or between whole armor lines
  written as code literals, is shielded too.

The heuristic is on by default with the other built-ins. There is no switch
for it, as LLP 0503 #config has none for any built-in.

## Limits {#limits}

This trades a small chance of masking a non-secret for catching unknown
formats. Over a seeded corpus of commit SHAs, SHA-256 digests, UUIDs, ULIDs,
camelCase, PascalCase and snake_case names, paths, long base64 and base64url
blobs, padded standard base64 (also after a JSON `\n` escape or a Windows path
backslash), go.sum hashes,
digest headers, SSH fingerprints and public keys, PEM certificates, data URLs,
npm integrity strings, provider IDs and base64 prose, it masks none. It still can:

- Mask a random-looking public value: a long identifier dense with acronyms
  and digits, a document or video ID, a base58 address, a nonce, or a line of
  wrapped base64 outside a PEM block. These have the same statistics as a
  random token.
- Miss a secret shorter than 32 or longer than 128 characters, a hex-only or
  single-case secret, one inside a path or URL, most secrets in standard
  base64 (which usually hold a `+` or `/`, or are padded), a padded key that
  happens to have no `-` or `_` (about a quarter of Fernet keys), or about 3%
  of random 32-character tokens (about 1% at 40, fewer beyond).
- Miss a JWT joined to a preceding letter, digit, `-` or `_`, or one whose
  header JSON starts with a space (`eyAi...`).

Explicit formats and custom patterns remain the way to cover a known secret.

## Cost {#cost}

Each rule is compiled at load. The added formats are linear in the string:
each match attempt starts at most once per run and reads it once. The
heuristic is one left-to-right scan; a run is read again only if it is 32 to
128 characters or padded with `=`, a bounded constant number of times, and PEM blocks are located
once, moving forward, so cost stays linear in the string. It allocates only
when it masks something, plus a short slice per candidate that passes the
statistical tests.
