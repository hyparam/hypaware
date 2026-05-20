export interface RendezvousStore {
  /** Filesystem root for rendezvous state. */
  dataDir: string
  /** Directory containing one `<sha256(join_code)>.json` invite per active/expired join code. */
  invitesDir: string
  /** Millisecond clock used for expiry checks. */
  now(): number
}

export interface RendezvousInviteRecord {
  /** Invite behavior. Enterprise enrollment keys mint per-use bootstrap tokens in Central. */
  kind: 'one_time_gateway' | 'enterprise_enrollment'
  /** SHA-256 hex of the plaintext join code. The plaintext join code is never stored. */
  join_code_hash: string
  /** Gateway-reachable Central server base URL. */
  connect_url: string
  /** Gateway identity or reusable gateway ID prefix associated with this invite. */
  gateway_id: string
  /** Invite expiration as an ISO-8601 timestamp. */
  expires_at: string
  /** Invite creation timestamp as ISO-8601. */
  created_at: string
  /** Maximum successful enrollments allowed for this invite. */
  max_uses?: number
  /** Optional operator-facing display metadata. */
  display_name?: string
}

export interface RegisterInviteInput {
  kind?: 'one_time_gateway' | 'enterprise_enrollment'
  join_code_hash: string
  connect_url: string
  gateway_id: string
  expires_at: string
  max_uses?: number
  display_name?: string
}

export type RendezvousStoreErrorCode =
  | 'duplicate_active'
  | 'expired'
  | 'invalid_connect_url'
  | 'invalid_display_name'
  | 'invalid_expires_at'
  | 'invalid_gateway_id'
  | 'invalid_join_code'
  | 'invalid_join_code_hash'
  | 'invalid_kind'
  | 'invalid_max_uses'
  | 'invalid_record'
  | 'unknown_join_code'
