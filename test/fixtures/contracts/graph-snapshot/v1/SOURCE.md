# Pinned server contract: hypaware.graph-snapshot/1

These files are a byte-for-byte copy of the server's fixture directory.
Do not edit them here. A refresh is a deliberate commit: copy the directory
again from a named server commit, update this file, and the SHA-256 list
below must match (`test/plugins/fastask-contract.test.js` fails otherwise).
The server's `README.md` in this directory names server paths; they refer
to the server repository.

- Repository: `hyparam/hypaware-server`
- Branch: `integration/authorized-graph-snapshots`
- Commit: `63cba4771704c0af281f186c0ceefdeeecd646ea`
- Server path: `test/fixtures/contracts/graph-snapshot/v1/`
- Contract version: `hypaware.graph-snapshot/1`
- Contract prose: server LLP 0554 (#contract, #lease), with the readings settled by server LLP 0559
- Pinned for: LLP 0481 T1 (HYP-111), 2026-10-09

The reference verifier `src/graph/snapshot-contract.js` at the same commit is ported, function bodies unchanged, to `hypaware-core/plugins-workspace/fastask/src/contract.js`.

The branch is a HypForge integration branch, not yet merged to the server's
master. Before release (LLP 0481 T13), re-pin from the merged server commit
and check that nothing changed.

## SHA-256

```text
0032c71e5aceb44abc8945f098a4b169ba6b86c694bbc40221f34d885acc6294  README.md
6388e3db5a3276a1262661cece479d1e12f6e80c7779eed16854911344204762  edges.ndjson
61b26ee74d1de0a876672b0a5d3476d3a44e32d1b34fe0b2203a530540a90fa9  edges.ndjson.gz
5461bc2094b6666950e5ad19b9f4f17b1001ec050dddaddc8447512922860eb7  headers.json
b6411187fe3ffab6ca20ffc84455057c150a995183a522cd8d0d690b76851af5  manifest.json
5d73f2c18e230c0ac851accfa55e555a28cefe742e210149615253a323d987f4  nodes.ndjson
e52e795d0078dd18d94bcdd656ac5d904da5a91584314bfdf0b73205696dc082  nodes.ndjson.gz
bbde3355cb3218d8782acc02b493a82e12f44eb96635ba353ad586a1ca7578ee  responses/304-not-modified.json
508c4efe4f471f6fa93c75f2aba58576040f80018f4f45a5931c18240fe541d0  responses/400-snapshot_scope_unsupported.json
276ff7255f2b25c8da7f8a287b1a5014e611ceec10949858a23146f760fe6a68  responses/400-unsupported_protocol.json
19a578a0c717595f34127f683a13020db2813dbf61ee805ca53c465524142603  responses/401-token_revoked.json
5907332bf25169173575505b87620af899e75d17189a5a3236093953e8e5c6db  responses/401-unauthorized.json
6d9e25a31b92c0e9d9efeebe122b0b575e2d04bf1d5791429cb53c5431305b08  responses/403-snapshot_access_withdrawn.json
e900eaf515bf54f03a999f23347f08081965da7e81ff0857f742cdfd34253b78  responses/404-graph_snapshots_disabled.json
bbc6880efafedbbb74881d04e23e94574b5ec3644ffd47eb8ffd6d4bd1937d8e  responses/404-unknown_path.json
893b134bb7bdcd49ee1792a4a52bed560876ffd50f8d536a889619b371cdced6  responses/410-generation_expired.json
7a412673ee4733aedfc1ded0bffeaecc4afec476980552f8bb8955bb1b9393f2  responses/429-snapshot_download_capacity.json
3f84032eea9c491aeb6d355874e5f49270fdf05c2f2771b9a0f8c55b243d3ddf  responses/503-snapshot_pending.json
```
