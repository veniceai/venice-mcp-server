import { VeniceUpstreamError } from '../types.js';
const MINT_ATTEMPT_TTL_MS = 15 * 60 * 1000;
export const WEB3_MINT_RECOVERY_MESSAGE = 'Mint outcome is unknown. Do not retry venice_web3_key_mint — a live key may already exist and its secret cannot be recovered. Use an ADMIN API key with venice_list_api_keys to find and revoke any unexpected key, then request a new challenge only after revoking.';
const attempts = new Map();
function pruneExpiredAttempts(now = Date.now()) {
    for (const [token, record] of attempts) {
        if (record.expiresAt <= now)
            attempts.delete(token);
    }
}
export function resetWeb3MintAttemptStore() {
    attempts.clear();
}
export function isUnknownMintOutcome(err) {
    if (err instanceof VeniceUpstreamError) {
        return err.status === 408 || err.status >= 500;
    }
    return true;
}
export function getSucceededWeb3Mint(token) {
    pruneExpiredAttempts();
    const existing = attempts.get(token);
    return existing?.status === 'succeeded' ? existing.response : undefined;
}
export function beginWeb3MintAttempt(token) {
    pruneExpiredAttempts();
    const existing = attempts.get(token);
    if (existing)
        return existing.status;
    attempts.set(token, { status: 'in_flight', expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS });
    return 'fresh';
}
export function succeedWeb3MintAttempt(token, response) {
    attempts.set(token, {
        status: 'succeeded',
        expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS,
        response,
    });
}
export function markUnknownWeb3MintAttempt(token) {
    attempts.set(token, { status: 'unknown', expiresAt: Date.now() + MINT_ATTEMPT_TTL_MS });
}
export function releaseWeb3MintAttempt(token) {
    const existing = attempts.get(token);
    if (existing?.status === 'in_flight')
        attempts.delete(token);
}
export function web3MintBlockedMessage(status) {
    if (status === 'in_flight') {
        return 'A mint for this challenge token is already in progress. Wait for that attempt; do not start a second mint.';
    }
    return WEB3_MINT_RECOVERY_MESSAGE;
}
//# sourceMappingURL=web3-key-mint.js.map