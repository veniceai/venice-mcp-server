import { VeniceUpstreamError } from '../types.js'

const MINT_ATTEMPT_TTL_MS = 15 * 60 * 1000

export const WEB3_MINT_RECOVERY_MESSAGE =
  'Mint outcome is unknown. Do not retry venice_web3_key_mint — a live key may already exist and its secret cannot be recovered. Use an ADMIN API key with venice_list_api_keys to find and revoke any unexpected key, then request a new challenge only after revoking.'

type MintRecord = {
  status: 'in_flight' | 'succeeded' | 'unknown'
  expiresAt: number
  address: string
  signature: string
  response?: unknown
}

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
    return err.status === 408 || err.status === 429 || err.status >= 500
  }
  return true
}

function sameSigner(existing: MintRecord, address: string, signature: string): boolean {
  return existing.address === address && existing.signature === signature
}

export function getSucceededWeb3Mint(token: string, address: string, signature: string): unknown | undefined {
  pruneExpiredAttempts()
  const existing = attempts.get(token)
  if (existing?.status !== 'succeeded' || !sameSigner(existing, address, signature)) return undefined
  return existing.response
}

export function beginWeb3MintAttempt(
  token: string,
  address: string,
  signature: string,
): 'fresh' | MintRecord['status'] | 'mismatch' {
  pruneExpiredAttempts()
  const existing = attempts.get(token)
  if (existing) {
    if (!sameSigner(existing, address, signature)) return 'mismatch'
    return existing.status
  }
  attempts.set(token, { status: 'in_flight', expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS, address, signature })
  return 'fresh'
}

export function succeedWeb3MintAttempt(token: string, address: string, signature: string, response: unknown): void {
  attempts.set(token, {
    status: 'succeeded',
    expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS,
    address,
    signature,
    response,
  })
}

export function markUnknownWeb3MintAttempt(token: string, address: string, signature: string): void {
  attempts.set(token, { status: 'unknown', expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS, address, signature })
}

export function releaseWeb3MintAttempt(token: string): void {
  const existing = attempts.get(token)
  if (existing?.status === 'in_flight') attempts.delete(token)
}

export function web3MintBlockedMessage(status: 'in_flight' | 'unknown' | 'mismatch'): string {
  if (status === 'in_flight') {
    return 'A mint for this challenge token is already in progress. Wait for that attempt; do not start a second mint.'
  }
  if (status === 'mismatch') {
    return 'This challenge token is already bound to a different wallet or signature. Do not retry with a different signer.'
  }
  return WEB3_MINT_RECOVERY_MESSAGE
}
