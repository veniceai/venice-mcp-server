export declare const WEB3_MINT_RECOVERY_MESSAGE = "Mint outcome is unknown. Do not retry venice_web3_key_mint \u2014 a live key may already exist and its secret cannot be recovered. Use an ADMIN API key with venice_list_api_keys to find and revoke any unexpected key, then request a new challenge only after revoking.";
type MintRecord = {
    status: 'in_flight';
    expiresAt: number;
} | {
    status: 'succeeded';
    expiresAt: number;
    response: unknown;
} | {
    status: 'unknown';
    expiresAt: number;
};
export declare function resetWeb3MintAttemptStore(): void;
export declare function isUnknownMintOutcome(err: unknown): boolean;
export declare function getSucceededWeb3Mint(token: string): unknown | undefined;
export declare function beginWeb3MintAttempt(token: string): 'fresh' | MintRecord['status'];
export declare function succeedWeb3MintAttempt(token: string, response: unknown): void;
export declare function markUnknownWeb3MintAttempt(token: string): void;
export declare function releaseWeb3MintAttempt(token: string): void;
export declare function web3MintBlockedMessage(status: 'in_flight' | 'unknown'): string;
export {};
//# sourceMappingURL=web3-key-mint.d.ts.map