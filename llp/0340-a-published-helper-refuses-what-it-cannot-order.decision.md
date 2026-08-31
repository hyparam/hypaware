# LLP 0340: A published helper refuses what it cannot order

**Type:** Decision
**Status:** Accepted
**Systems:** Core, Plugins
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Related:** LLP 0225 (#one-vocabulary: the other place this barrel settled one
policy across two helpers rather than letting each answer for itself),
hyparam/hypaware#1142, hyparam/hypaware#1145, hyparam/hypaware#1148

> `compareStrings` returned `0` for a non-string argument. Not an error and not
> a fallback: a stable tie, which sorts a mis-shaped row into a
> plausible-looking but arbitrary place and reports nothing. It was the only
> `@param {string}` helper on the published `hypaware/core/util` barrel that
> did anything of the sort. This settles the rule for the barrel as a whole and
> adds the guard.

## Context {#context}

[#1142](https://github.com/hyparam/hypaware/issues/1142) moved nineteen
comparators off `String.prototype.localeCompare`, several of them ordering what
`hyp status` and `hyp --help` print, onto one helper that answers from the
characters. `localeCompare` raises a `TypeError` when the receiver is
`undefined`. The comparison that replaced it does not: `<` and `>` are both
false in either direction for a non-string, so the ternary falls through to its
last arm and answers `0`.

The helper is exported from `src/core/util/index.js`, which is the published
`hypaware/core/util` barrel, so the answer is not an internal detail. Its
siblings there behave the other way: `escapeForDisplay(undefined)` and
`sha256Hex(undefined)` both raise, and `sanitizeLabel`, `errCode`,
`isPlainObject`, `parseMaybeJson` and `stringValue` all take `unknown`, check,
and return a documented fallback. One helper on the barrel quietly answered
from input it was never given.

[#1145](https://github.com/hyparam/hypaware/pull/1145) wrote the requirement
into the JSDoc instead of checking it, on one specific ground: a guard would
restore `localeCompare`'s crash-on-`undefined` at nineteen status-rendering
call sites, and that is a larger behaviour change than the one the PR was for.
That was the right call for that PR. It is not a resting place, because it
leaves the barrel holding two conventions and no statement of which is the
rule, which is how the asymmetry gets rediscovered on every pass
([#1148](https://github.com/hyparam/hypaware/issues/1148) item 1).

## A helper that declares a type refuses what does not have it {#refuse}

**A helper on the published barrel that declares a concrete parameter type
refuses an argument of another type. It never answers from one.** A helper that
declares `unknown` guards and returns its documented fallback. Those are the
same rule seen from two sides, and neither of them permits the third behaviour:
computing an answer out of an argument the signature says cannot arrive.

This is stated as a rule about the *signature* rather than about the
implementation because the barrel's current behaviour is an accident of its
bodies. `escapeForDisplay` raises because `undefined.replace` raises;
`sha256Hex` raises because Node's `Hash.update` refuses a non-`BinaryLike`.
Neither chose to. A comparison chooses nothing either, and what it happens to
do is return a tie, so `compareStrings` is where the rule has to be written out
rather than inherited from the language.

The failure it removes is the one this comparator was built to remove. The
whole of #1142 is an argument that an order which reads like an order and is
not - because it moved with the box that printed it - is worse than a loud one.
A `0` for `undefined` is the same wrong shape arriving through a different
door.

## The guard is free, and that is checkable rather than argued {#cost}

The objection #1145 recorded was that the guard costs a crash at nineteen live
sites. It does not, and the reason is not that the guard is cheap in the inner
loop (it is, but that was never the interesting half).

Every one of those sites sorts a name that cannot be a non-string by the time
it is sorted. The dataset, source, sink, backfill, verb and command registries
each validate the sorted field as a non-empty string at register or instantiate
time; the rest sort hardcoded lists, `Object.entries` or `readdir` keys, or a
value already through `String()`. `Array.prototype.sort` closes the remaining
shape on its own: it moves `undefined` elements and holes to the end of the
array without ever calling the comparator, so a sparse or gappy list is not a
way in either.

So the guard is not a behaviour change that has to be migrated for. It is a
statement that becomes reachable only from code that does not exist yet, and
from an untyped consumer of the published barrel, which is exactly the reader
the JSDoc cannot reach: `@ts-check` and the emitted declaration state the
requirement to every typed caller and to no one else.

## The refusal names types, never values {#not-values}

The `TypeError` says which types it got and stops. What these comparators sort
includes blob keys, file paths, session ids and sink instance names, and an
error message is a string that reaches a log, a status line, or a bug report.
A guard that printed the offending value to explain itself would be a capture
surface added by a helper whose whole job is to compare two things.

## Consequences {#consequences}

- `compareStrings` throws `TypeError` on a non-string argument, and
  `test/core/compare-strings.test.js` pins both the refusal and the
  `sort()`-never-passes-`undefined` fact that makes it free.
- The thirteen comparators elsewhere in the tree that wrote the comparison out
  inline now call the helper, so they inherit the rule rather than each
  answering for itself. A lint in the same file holds the tree to that, with an
  allowlist whose only entry is the definition.
- The rule is about the published barrel. A private helper inside a subsystem
  is free to take `unknown` and fall back, or to declare a type and trust its
  one caller; what it may not do is get onto `src/core/util/index.js` while
  answering from input its signature refuses.

## Alternatives {#alternatives}

**Leave the contract in the JSDoc.** The honest version of this is that the
barrel has no rule, only two habits, and that a `@param {string}` is a promise
to a type checker rather than to a caller. It is defensible and it is what
shipped. It was rejected because the one thing it does not do is answer the
question, and the asymmetry then costs a paragraph of re-derivation on every
review that notices it.

**Widen the parameter to `unknown` and fall back.** This is the other half of
the house rule and it fits helpers whose input genuinely arrives from JSON or a
row. It does not fit a comparator: there is no fallback order for a value that
has no order, and returning one is precisely the behaviour under discussion.

**Guard only the barrel re-export, leaving the internal helper bare.** Two
functions with one name and two behaviours, where which one you got depends on
how you imported it. That is worse than either behaviour on its own.
