/**
 * Tool registry. Each tool wraps one Venice API endpoint.
 *
 * Authentication coverage (verified against live Venice API):
 *   ✅ x402 + API key (dual-auth):
 *      - chat/completions, responses, embeddings
 *      - audio/speech, audio/transcriptions, audio/voices
 *      - audio/queue, audio/retrieve, audio/complete  (music)
 *      - image/generate, images/generations, image/edit, image/multi-edit,
 *        image/upscale, image/background-remove
 *      - video/queue, video/retrieve, video/complete, video/transcriptions
 *      - augment/text-parser, augment/scrape, augment/search
 *      - crypto/rpc/:network
 *   ⚠️  API key only (no x402):
 *      - characters (list, get, reviews)
 *      - api_keys/rate_limits and rate_limits/log (INFERENCE or ADMIN)
 *      - billing/* and api_keys list/get require an ADMIN key
 *      - support-bot
 *   🔓 Auth-free:
 *      - models, models/card, models/traits
 *      - image/styles
 *      - audio/quote, video/quote
 *      - x402/top-up requirement discovery
 *      - api_keys/generate_web3_key challenge + signed submission
 *      - tee/attestation, tee/signature
 *   👛 SIWX only:
 *      - x402/balance, x402/transactions
 */
import { z } from 'zod';
import type { VeniceClient } from '../venice-client.js';
import type { Config } from '../config.js';
type TextContent = {
    type: 'text';
    text: string;
};
type ImageContent = {
    type: 'image';
    data: string;
    mimeType: string;
};
type AudioContent = {
    type: 'audio';
    data: string;
    mimeType: string;
};
type ResourceLinkContent = {
    type: 'resource_link';
    uri: string;
    name: string;
    mimeType?: string;
    description?: string;
};
type ToolContent = TextContent | ImageContent | AudioContent | ResourceLinkContent;
export interface ToolResult {
    content: ToolContent[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
}
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
    name: string;
    title: string;
    description: string;
    inputSchema: S;
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>;
}
export declare function buildTools(client: VeniceClient, cfg: Config): ToolDef[];
export {};
//# sourceMappingURL=index.d.ts.map