import { VeniceUpstreamError } from '../types.js'

const MINT_ATTEMPT_TTL_MS = 15 * 60 * 1000

export const WEB3_MINT_RECOVERY_MESSAGE =
  'Mint outcome is unknown. Do not retry venice_web3_key_mint — a live key may already exist and its secret cannot be recovered. Use an ADMIN API key with venice_list_api_keys to find and revoke any unexpected key, then request a new challenge only after revoking.'

type MintRecord =
  | { status: 'in_flight'; expiresAt: number }
  | { status: 'succeeded'; expiresAt: number; response: unknown }
  | { status: 'unknown'; expiresAt: number }

const attempts = new Map<string, MintRecord>()

function pruneExpiredAttempts(now = Date.now()): void {
  for (const [token, record] of attempts) {
    if (record.expiresAt <= now) attempts.delete(token)
  }
}

export function resetWeb3MintAttemptStore(): void {
  attempts.clear()
}

export function isUnknownMintOutcome(err: unknown): boolean {
  if (err instanceof VeniceUpstreamError) {
    return err.status === 408 || err.status >= 500
  }
  return true
}

export function getSucceededWeb3Mint(token: string): unknown | undefined {
  pruneExpiredAttempts()
  const existing = attempts.get(token)
  return existing?.status === 'succeeded' ? existing.response : undefined
}

export function beginWeb3MintAttempt(token: string): 'fresh' | MintRecord['status'] {
  pruneExpiredAttempts()
  const existing = attempts.get(token)
  if (existing) return existing.status
  attempts.set(token, { status: 'in_flight', expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS })
  return 'fresh'
}

export function succeedWeb3MintAttempt(token: string, response: unknown): void {
  attempts.set(token, {
    status: 'succeeded',
    expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS,
    response,
  })
}

export function markUnknownWeb3MintAttempt(token: string): void {
  attempts.set(token, { status: 'unknown', expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS })
}

export function releaseWeb3MintAttempt(token: string): void {
  const existing = attempts.get(token)
  if (existing?.status === 'in_flight') attempts.delete(token)
}

export function web3MintBlockedMessage(status: 'in_flight' | 'unknown'): string {
  if (status === 'in_flight') {
    return 'A mint for this challenge token is already in progress. Wait for that attempt; do not start a second mint.'
  }
  return WEB3_MINT_RECOVERY_MESSAGE
}
