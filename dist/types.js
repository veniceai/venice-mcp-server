/** Canonical error wrapping for upstream failures. */
export class VeniceUpstreamError extends Error {
    status;
    body;
    headers;
    /** True when the upstream returned 402 Payment Required (x402). */
    isPaymentRequired;
    constructor(opts) {
        super(opts.message);
        this.name = 'VeniceUpstreamError';
        this.status = opts.status;
        this.body = opts.body;
        this.headers = opts.headers ?? {};
        this.isPaymentRequired = opts.status === 402;
    }
}
//# sourceMappingURL=types.js.map