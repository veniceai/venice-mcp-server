import { VeniceUpstreamError } from '../types.js'

const MINT_ATTEMPT_TTL_MS = 15 * 60 * 1000

export const WEB3_MINT_RECOVERY_MESSAGE =
  'Mint outcome is unknown. Do not retry venice_web3_key_mint — a live key may already exist and its secret cannot be recovered. Use an ADMIN API key with venice_list_api_keys to find and revoke any unexpected key, then request a new challenge only after revoking.'

export const WEB3_MINT_UNREADABLE_RESPONSE_MESSAGE =
  'Venice accepted the submission but the response carried no readable API key, so the secret was never captured by this server.'

type MintRecord = {
  status: 'in_flight' | 'succeeded' | 'unknown'
  expiresAt: number
  address: string
  signature: string
  response?: unknown
}

/**
 * Process-wide on purpose. HTTP mode builds one server per session from the
 * same env credentials, and a client that times out usually reconnects with a
 * new session; a per-session store would let that retry mint a second key.
 */
const attempts = new Map<string, MintRecord>()

function pruneExpiredAttempts(now = Date.now()): void {
  for (const [token, record] of attempts) {
    if (record.expiresAt > now) continue
    if (record.status === 'in_flight') {
      // A request that never settled may still have minted a key upstream.
      attempts.set(token, { ...record, status: 'unknown', expiresAt: now + MINT_ATTEMPT_TTL_MS })
    } else {
      attempts.delete(token)
    }
  }
}

export function resetWeb3MintAttemptStore(): void {
  attempts.clear()
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * A 2xx alone does not prove the secret arrived: the shared client turns a
 * truncated or unreadable JSON body into `{}`. Only a success envelope that
 * still carries the one-time secret and its key ID may be cached as a success.
 */
export function isMintedKeyResponse(resp: unknown): boolean {
  if (typeof resp !== 'object' || resp === null || Array.isArray(resp)) return false
  const envelope = resp as { success?: unknown; data?: unknown }
  if (envelope.success === false) return false
  const data = envelope.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const { apiKey, id, apiKeyId } = data as { apiKey?: unknown; id?: unknown; apiKeyId?: unknown }
  return isNonEmptyString(apiKey) && (isNonEmptyString(id) || isNonEmptyString(apiKeyId))
}

export interface RequestedMintRestrictions {
  consumptionLimit: { usd?: number | null }
  limitPeriod: string
}

/**
 * The challenge signature does not bind key type or limits, so the minted key
 * is checked against what was asked for. Returns a problem description, or
 * undefined when the key matches. Optional response fields are only compared
 * when present.
 */
export function mintedKeyRestrictionProblem(resp: unknown, requested: RequestedMintRestrictions): string | undefined {
  const data = (resp as { data: Record<string, unknown> }).data
  if (data.apiKeyType !== 'INFERENCE') {
    return `key type is ${JSON.stringify(data.apiKeyType ?? null)}, not INFERENCE`
  }
  const limit = data.consumptionLimit
  if (limit !== undefined) {
    if (typeof limit !== 'object' || limit === null) return 'consumption limit is missing'
    for (const currency of ['usd'] as const) {
      const want = requested.consumptionLimit[currency] ?? null
      const got = (limit as Record<string, unknown>)[currency] ?? null
      if (want !== got) {
        return `${currency} consumption limit is ${JSON.stringify(got)}, requested ${JSON.stringify(want)}`
      }
    }
  }
  if (data.limitPeriod !== undefined && data.limitPeriod !== requested.limitPeriod) {
    return `limit period is ${JSON.stringify(data.limitPeriod)}, requested ${requested.limitPeriod}`
  }
  return undefined
}

export function mintedKeyId(resp: unknown): string {
  const data = (resp as { data: { id?: unknown; apiKeyId?: unknown } }).data
  return String(isNonEmptyString(data.id) ? data.id : data.apiKeyId)
}

export function web3MintRestrictionMismatchMessage(id: string, problem: string): string {
  return `Venice minted API key ${id}, but it does not match the requested restrictions: ${problem}. The secret is withheld. Revoke key ${id} now with an ADMIN API key (DELETE /api/v1/api_keys?id=${encodeURIComponent(id)}, or the Venice API settings page). Do not retry this challenge.`
}

export function isUnknownMintOutcome(err: unknown): boolean {
  if (err instanceof VeniceUpstreamError) {
    return err.status === 408 || err.status === 429 || err.status >= 500
  }
  return true
}

/** EVM addresses are case-insensitive, so a re-cased retry must not look like a different wallet. */
function walletKey(address: string): string {
  return address.startsWith('0x') ? address.toLowerCase() : address
}

function sameSigner(existing: MintRecord, address: string, signature: string): boolean {
  return existing.address === walletKey(address) && existing.signature === signature
}

export function getSucceededWeb3Mint(token: string, address: string, signature: string): unknown | undefined {
  pruneExpiredAttempts()
  const existing = attempts.get(token)
  if (existing?.status !== 'succeeded' || !sameSigner(existing, address, signature)) return undefined
  return existing.response
}

export function addressHasUnknownMint(address: string): boolean {
  pruneExpiredAttempts()
  const wallet = walletKey(address)
  for (const record of attempts.values()) {
    if (record.address === wallet && record.status === 'unknown') return true
  }
  return false
}

export function beginWeb3MintAttempt(
  token: string,
  address: string,
  signature: string,
): 'fresh' | MintRecord['status'] | 'mismatch' | 'wallet_unknown' {
  pruneExpiredAttempts()
  if (addressHasUnknownMint(address) && attempts.get(token)?.status !== 'unknown') {
    return 'wallet_unknown'
  }
  const existing = attempts.get(token)
  if (existing) {
    if (!sameSigner(existing, address, signature)) return 'mismatch'
    return existing.status
  }
  attempts.set(token, {
    status: 'in_flight',
    expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS,
    address: walletKey(address),
    signature,
  })
  return 'fresh'
}

export function succeedWeb3MintAttempt(token: string, address: string, signature: string, response: unknown): void {
  attempts.set(token, {
    status: 'succeeded',
    expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS,
    address: walletKey(address),
    signature,
    response,
  })
}

export function markUnknownWeb3MintAttempt(token: string, address: string, signature: string): void {
  attempts.set(token, {
    status: 'unknown',
    expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS,
    address: walletKey(address),
    signature,
  })
}

export function releaseWeb3MintAttempt(token: string): void {
  const existing = attempts.get(token)
  if (existing?.status === 'in_flight') attempts.delete(token)
}

export function web3MintBlockedMessage(status: 'in_flight' | 'unknown' | 'mismatch' | 'wallet_unknown'): string {
  if (status === 'in_flight') {
    return 'A mint for this challenge token is already in progress. Wait for that attempt; do not start a second mint.'
  }
  if (status === 'mismatch') {
    return 'This challenge token is already bound to a different wallet or signature. Do not retry with a different signer.'
  }
  if (status === 'wallet_unknown') {
    return `${WEB3_MINT_RECOVERY_MESSAGE} A new challenge will not mint another key for this wallet until that unknown attempt expires.`
  }
  return WEB3_MINT_RECOVERY_MESSAGE
}
