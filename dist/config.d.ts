/**
 * Configuration loaded from env vars.
 *
 * Auth modes (mutually exclusive at request time; key beats SIWX when both set):
 *   - VENICE_API_KEY        → forwarded as `Authorization: Bearer`.
 *   - VENICE_SIWX_TOKEN     → forwarded as `X-Sign-In-With-X` (SIWE-proof token,
 *                              base64-encoded JSON SIWE message).
 *                              Pre-generate this with the Venice x402 SDK or
 *                              `wallet.signMessage()` over a SIWE message.
 *
 * x402 reality check
 * ──────────────────
 * Venice's x402 is a *prepaid balance* model, not per-call HTTP-402 settlement:
 *
 *   1. Client signs a SIWE message (Sign-In-With-X) once → SIWX token.
 *   2. Client tops up balance via `POST /api/v1/x402/top-up` with the
 *      `X-402-Payment` header (signed USDC authorization).
 *   3. Subsequent inference calls send `X-Sign-In-With-X` (NOT `X-402-Payment`).
 *      Venice debits the credit account on success.
 *
 * Therefore this MCP server NEVER sends `X-402-Payment` on inference routes —
 * Venice rejects that header on anything except `/x402/top-up`.
 */
export interface Config {
    /** Base URL of the Venice API. */
    baseUrl: string;
    /** Optional API key used for all upstream calls (forwarded as Bearer). */
    apiKey: string | undefined;
    /**
     * Optional pre-signed SIWX token (`X-Sign-In-With-X` header value).
     * Authenticates a wallet against an existing X402CreditAccount with prepaid balance.
     */
    siwxToken: string | undefined;
    /** Default model for chat completions when caller does not specify. */
    defaultChatModel: string;
    /** Default model for image generation when caller does not specify. */
    defaultImageModel: string;
    /** Default TTS model. */
    defaultTtsModel: string;
    /** Default ASR model. */
    defaultAsrModel: string;
    /** Request timeout (ms) for non-streaming calls. */
    timeoutMs: number;
    /** Whether to advertise NSFW capability in tool descriptions. */
    enableNsfw: boolean;
    /** Server name advertised to MCP clients. */
    serverName: string;
    /** Server version advertised. */
    serverVersion: string;
}
export declare function loadConfig(env?: NodeJS.ProcessEnv): Config;
//# sourceMappingURL=config.d.ts.map