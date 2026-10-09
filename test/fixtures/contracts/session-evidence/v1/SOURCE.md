# Pinned server contract: hypaware.session-evidence/1

These files are a byte-for-byte copy of the server's fixture directory.
Do not edit them here. A refresh is a deliberate commit: copy the directory
again from a named server commit, update this file, and the SHA-256 list
below must match (`test/plugins/fastask-contract.test.js` fails otherwise).
The server's `README.md` in this directory names server paths; they refer
to the server repository.

- Repository: `hyparam/hypaware-server`
- Branch: `integration/session-evidence-index`
- Commit: `6c4eccdace14e4b4da94d3ef09a162cb3329ecf2`
- Server path: `test/fixtures/contracts/session-evidence/v1/`
- Contract version: `hypaware.session-evidence/1`
- Contract prose: server LLP 0553 (#contract), with the wire shape of server LLP 0557 and the readings of server LLP 0558
- Pinned for: LLP 0481 T1 (HYP-111), 2026-10-09

The server checks these files with its own shape checker (`test/lib/session-evidence-contract.js`), which is not ported here. This repository's test checks the outer shape only; the evidence client task (LLP 0481 T7) tests its own handling against every case.

The branch is a HypForge integration branch, not yet merged to the server's
master. Before release (LLP 0481 T13), re-pin from the merged server commit
and check that nothing changed.

## SHA-256

```text
e35e8b64c3b22848deca77e2f3be516dd0e42fccc23301227ecab254790b29b5  01-ok-minimal.json
029055df2b5210863ef1c45a65471445a0aa5451bb2d48e506a0a6c5c41bd094  02-partial-page-1.json
fcb90d7717b7d69a47a458ba9a251b2704ee4d5726f62e4dce814e4df101aa72  03-partial-continuation.json
8335fcdac5b1e77fd4c470d2dac79077528fdfa3fd1619b778c3d8b45e11c1c3  04-deadline.json
201cdc91ecaffee6fd8287f5d9a860fc9ca10002f8c45550c872ad6047b1e451  05-not-found.json
b297745d98bf4cb10cfed49ce6984b4d89fb2175421f13a9dfd2f644ba593e93  06-invalid-cursor.json
a2ead520d5fd8fc235a90777a83c97f0adb877bf48d05dcf3be218f4fff71387  07-entry-error.json
b8f341824abc535821d6b3dcbfe89774285cfd1a5fe0073371a9c1e1504aa07e  08-text-truncated.json
83c9ae0cd0e9e32611883e4829b33abb7bf6a9411335f0febc697c4be60d0624  09-desc.json
0e5ff553108a4852038df25d80238b435cc0e570214cd50f8427cfd0468d4b29  10-message-ids.json
8311d0113e4e3f364382c0ff28ffde1e5dc3871bc0caed984300d39da8a78752  11-two-sessions.json
ffe567407c95478c912fd286cb1454454f87fb2af643f8253a48f5ab0c421a73  12-invalid-request.json
0cf125b5218e994c48fa926ea9a86fc6417bd93e793cf9c8eb5f05ce815b124d  13-unsupported-contract.json
1a38e036545816d0821163ed1e7f155192e11a249f94a028e065d86b67c1b73e  README.md
```
