/** Canonical error wrapping for upstream failures. */
export declare class VeniceUpstreamError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly headers: Record<string, string>;
    /** True when the upstream returned 402 Payment Required (x402). */
    readonly isPaymentRequired: boolean;
    constructor(opts: {
        message: string;
        status: number;
        body: unknown;
        headers?: Record<string, string>;
    });
}
export interface VeniceMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
//# sourceMappingURL=types.d.ts.map