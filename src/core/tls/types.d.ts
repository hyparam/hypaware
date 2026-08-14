import type { KeyObject } from 'node:crypto'

/**
 * A loaded machine-local certificate authority, including its private key.
 * Only the gateway's interception path holds one of these.
 */
export interface LocalCa {
  /** Absolute path to the PEM certificate; this is what a client trusts. */
  certPath: string
  /** Absolute path to the 0600 private key. Never exported or forwarded. */
  keyPath: string
  certPem: string
  privateKey: KeyObject
  /** subjectKeyIdentifier, used as each leaf's authorityKeyIdentifier. */
  keyId: Buffer
  /** Hosts this CA's nameConstraints permit. */
  hosts: string[]
  /** SHA-256 fingerprint, colon-separated uppercase hex. */
  fingerprint: string
  notAfter: Date
  /** True when this call generated the CA rather than loading it. */
  created: boolean
}

/**
 * The public half of an installed CA: what `hyp status` can show without
 * touching the private key.
 */
export interface LocalCaInfo {
  certPath: string
  fingerprint: string
  notAfter: Date
  hosts: string[]
}
