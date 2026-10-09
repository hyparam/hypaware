// Types for the fastask plugin's port of the server's graph snapshot
// contract (`hypaware.graph-snapshot/1`, server LLP 0554#contract).

/** What a served data file measures as: the manifest's per-file facts. */
export interface SnapshotFileFacts {
  rows: number
  bytes: number
  uncompressed_bytes: number
  sha256: string
  set_digest: string
}

/** Compressed bytes as served: one buffer, or a stream of chunks. */
export type CompressedSource = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>

export interface SetDigest {
  add(line: string | Uint8Array): void
  readonly rows: number
  hex(): string
}

export interface MeasuredFile {
  facts: SnapshotFileFacts
  problems: string[]
}

export interface SnapshotFiles {
  manifest: any
  nodes: CompressedSource
  edges: CompressedSource
}

export interface SnapshotVerification {
  ok: boolean
  problems: string[]
  observed: Partial<Record<'nodes' | 'edges', SnapshotFileFacts>>
}
