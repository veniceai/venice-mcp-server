import type { Config } from './config.js';
export interface RequestInitJSON {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    /** Plain JSON body; will be stringified. */
    json?: unknown;
    /** Extra headers (merged on top of defaults). */
    headers?: Record<string, string>;
    /** Override request timeout for this call. */
    timeoutMs?: number;
    /** Override default API-key-first auth behavior for endpoint-specific requirements. */
    auth?: 'default' | 'apiKey' | 'siwx' | 'none';
    /** Observe response metadata without changing the existing body-only return type. */
    onResponse?: (metadata: ResponseMetadata) => void;
}
export interface ResponseMetadata {
    status: number;
    headers: Record<string, string>;
}
/**
 * Thin HTTP client over the Venice API.
 * - Adds `Authorization: Bearer` when API key is configured (preferred).
 * - Otherwise adds the canonical `SIGN-IN-WITH-X` when a SIWX token is configured.
 * - Surfaces 402 responses as `VeniceUpstreamError(isPaymentRequired)` so tools
 *   can format a helpful top-up message back to the MCP host.
 *
 * We deliberately never set a payment header. Payment submission belongs only
 * on `/x402/top-up`, and this client currently exposes discovery—not settlement.
 */
export declare class VeniceClient {
    private readonly cfg;
    constructor(cfg: Config);
    request<T = unknown>(path: string, init?: RequestInitJSON): Promise<T>;
    /** GET request returning JSON. */
    get<T = unknown>(path: string, headers?: Record<string, string>, opts?: Pick<RequestInitJSON, 'auth' | 'timeoutMs' | 'onResponse'>): Promise<T>;
    /** POST request with JSON body. */
    post<T = unknown>(path: string, json: unknown, headers?: Record<string, string>, opts?: Pick<RequestInitJSON, 'auth' | 'timeoutMs' | 'onResponse'>): Promise<T>;
    /**
     * POST a multipart/form-data body. Used by endpoints that require file upload
     * (image/edit, image/upscale, image/multi-edit, image/background-remove,
     * audio/transcriptions, audio/voices, augment/text-parser).
     *
     * Caller passes a pre-built `FormData` instance; this helper wires up auth
     * headers and surfaces the upstream response identically to `post`.
     */
    postMultipart<T = unknown>(path: string, form: FormData, opts?: {
        timeoutMs?: number;
    }): Promise<T>;
    /**
     * POST and return the raw response Buffer + content-type. Used for endpoints
     * that return binary image streams (image/edit, image/upscale, image/multi-edit,
     * image/background-remove). Caller decides what to do with the bytes
     * (typically: encode as base64 image content for MCP).
     */
    postBinary(path: string, init: RequestInitJSON | {
        form: FormData;
    }, opts?: {
        timeoutMs?: number;
    }): Promise<{
        buffer: Buffer;
        contentType: string;
    }>;
}
//# sourceMappingURL=venice-client.d.ts.map