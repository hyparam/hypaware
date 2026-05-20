import type { BootstrapStore } from './identity.js'
import type { ServerConfig } from '../types.js'

export interface EnrollmentStore {
  /** Path to the JSON file containing enrollment records. */
  path: string
  /** Millisecond clock used for expiry checks. */
  now(): number
}

export interface EnrollmentRecord {
  /** SHA-256 hex of the plaintext short join key. */
  joinCodeHash: string
  /** Gateway ID for single-use invites, or gateway ID prefix for reusable invites. */
  gatewayId: string
  /** Maximum successful enrollments allowed for this key. */
  maxUses: number
  /** Count of successful enrollments already issued. */
  usedCount: number
  /** Expiration, seconds since the unix epoch. */
  expiresAt: number
  /** Creation time, seconds since the unix epoch. */
  createdAt: number
  /** Optional operator-facing display metadata. */
  displayName?: string
}

export type EnrollmentIssueResult =
  | { ok: true, token: string, gatewayId: string, expiresAt: number }
  | { ok: false, reason: 'unknown_key' | 'expired' | 'exhausted' }

export interface RegisterEnrollmentInput {
  joinCodeHash: string
  gatewayId: string
  ttlSeconds: number
  maxUses: number
  displayName?: string
}

export interface IssueEnrollmentInput {
  joinCode: string
  enrollmentStore: EnrollmentStore
  bootstrapStore: BootstrapStore
}

export declare function createEnrollmentStore(opts: { path: string, now?: () => number }): EnrollmentStore
export declare function resolveEnrollmentStorePath(config: ServerConfig, opts?: { homeDir?: string }): string
export declare function generateEnrollmentCode(length?: number): string
export declare function registerEnrollment(store: EnrollmentStore, input: RegisterEnrollmentInput): EnrollmentRecord
export declare function deleteEnrollment(store: EnrollmentStore, joinCodeHash: string): boolean
export declare function issueEnrollmentBootstrap(input: IssueEnrollmentInput): EnrollmentIssueResult
