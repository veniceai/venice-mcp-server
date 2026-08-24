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
import { formatToolError, truncate } from '../format.js';
import { fetchUploadSource } from './remote-fetch.js';
import { beginWeb3MintAttempt, getSucceededWeb3Mint, isUnknownMintOutcome, markUnknownWeb3MintAttempt, releaseWeb3MintAttempt, succeedWeb3MintAttempt, WEB3_MINT_RECOVERY_MESSAGE, web3MintBlockedMessage, } from './web3-key-mint.js';
/**
 * Sniff the MIME type of a base64-encoded image from its magic bytes.
 * Falls back to 'image/png' if the format is unrecognised.
 */
function detectBase64ImageMime(b64) {
    const header = b64.slice(0, 16);
    const bytes = Buffer.from(header, 'base64');
    // WebP: RIFF????WEBP
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image/webp';
    }
    // PNG: \x89PNG
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return 'image/png';
    }
    // JPEG: \xFF\xD8
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        return 'image/jpeg';
    }
    // GIF: GIF8
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    return 'image/png';
}
const ok = (text, structured) => ({
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
});
const fail = (text) => ({
    content: [{ type: 'text', text }],
    isError: true,
});
const X402_OK = ' Supports x402 wallet auth (no Venice account needed) and API key.';
const API_KEY_ONLY = ' API key required — this endpoint does not accept x402 wallet auth.';
const ADMIN_API_KEY_ONLY = ' ADMIN API key required — inference keys, including keys minted by venice_web3_key_mint, cannot call this endpoint. This endpoint does not accept x402 wallet auth.';
const NO_AUTH = ' No authentication required.';
const walletAddressSchema = z
    .string()
    .regex(/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, 'Must be an EVM (0x + 40 hex characters) or Solana base58 wallet address.');
const evmAddressSchema = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Web3 API-key minting currently requires an EVM wallet address.');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must use YYYY-MM-DD format.');
const utcTimestampSchema = z
    .string()
    .max(40)
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/, 'Must be an ISO 8601 UTC timestamp with a Z suffix.');
function normalizeExpiresAt(value) {
    if (!value)
        return undefined;
    const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/);
    if (!match || !match[2] || match[2].length === 3)
        return value;
    return `${match[1]}.${match[2].padEnd(3, '0').slice(0, 3)}Z`;
}
function normalizeWalletAddress(address) {
    return address.startsWith('0x') ? address.toLowerCase() : address;
}
function redactSecretFields(value) {
    if (Array.isArray(value))
        return value.map(redactSecretFields);
    if (typeof value !== 'object' || value === null)
        return value;
    const redacted = {};
    for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
        redacted[key] = ['apikey', 'signature', 'token', 'paymentsignature', 'authorization', 'secret'].includes(normalizedKey)
            ? '[REDACTED]'
            : redactSecretFields(child);
    }
    return redacted;
}
function safeJson(value) {
    return JSON.stringify(redactSecretFields(value), null, 2);
}
/**
 * Venice-specific extensions to the OpenAI body. `/responses` accepts a
 * narrower set than `/chat/completions` and silently strips the rest, so the
 * two endpoints get separate schemas rather than one shared superset.
 */
const sharedVeniceParameters = {
    enable_web_search: z
        .enum(['auto', 'on', 'off'])
        .optional()
        .describe('Web search. "on" forces it, "auto" leaves it to the model, "off" (default) disables it.'),
    enable_web_citations: z
        .boolean()
        .optional()
        .describe('Ask the model to cite web sources with ^1^ style superscripts. Only applies when web search ran.'),
    enable_web_scraping: z
        .boolean()
        .optional()
        .describe('Scrape URLs found in the latest user message and feed the contents to the model.'),
    include_venice_system_prompt: z
        .boolean()
        .optional()
        .describe('Keep Venice\'s default system prompt alongside your own. Defaults to true; set false for full control of behaviour.'),
    character_slug: z
        .string()
        .optional()
        .describe('Public ID of a Venice character to answer in. Discoverable via venice_list_characters.'),
};
const veniceParametersSchema = z
    .object({
    ...sharedVeniceParameters,
    enable_x_search: z
        .boolean()
        .optional()
        .describe('Native xAI web + X/Twitter search, on supported models such as Grok. Runs server-side instead of Venice search.'),
    strip_thinking_response: z
        .boolean()
        .optional()
        .describe('Remove <think></think> blocks from the response of a reasoning model.'),
    disable_thinking: z
        .boolean()
        .optional()
        .describe('Turn reasoning off entirely on supported models, and strip the <think></think> blocks.'),
})
    .optional()
    .describe('Venice-only options: web search, citations, system prompt control, reasoning control, characters.');
const responsesVeniceParametersSchema = z
    .object(sharedVeniceParameters)
    .optional()
    .describe('Venice-only options supported by /responses: web search, citations, scraping, system prompt control, characters.');
export function buildTools(client, cfg) {
    const nsfwNote = cfg.enableNsfw ? ' Uncensored: NSFW prompts allowed where the model permits.' : '';
    const tools = [
        // ========================================================================
        // CHAT / TEXT — x402 + API key
        // ========================================================================
        {
            name: 'venice_chat',
            title: 'Venice Chat (LLM)',
            description: `Run an OpenAI-compatible chat completion via Venice's uncensored LLM catalog (Claude, GPT-5, Llama, DeepSeek, Qwen, GLM, Kimi, Venice Uncensored 1.1, etc.). Use venice_parameters for live web search with citations, character personas, and system prompt or reasoning control.${nsfwNote}${X402_OK}`,
            inputSchema: {
                messages: z
                    .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }))
                    .min(1)
                    .describe('Chat messages, OpenAI format.'),
                model: z.string().optional().describe(`Model id. Defaults to ${cfg.defaultChatModel}.`),
                temperature: z.number().min(0).max(2).optional(),
                max_tokens: z.number().int().positive().max(32_000).optional(),
                top_p: z.number().min(0).max(1).optional(),
                stop: z.array(z.string()).max(8).optional(),
                verbosity: z.enum(['low', 'medium', 'high', 'auto']).optional().describe('How much text the model returns.'),
                venice_parameters: veniceParametersSchema,
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/chat/completions', {
                        model: args.model ?? cfg.defaultChatModel,
                        messages: args.messages,
                        temperature: args.temperature,
                        max_tokens: args.max_tokens,
                        top_p: args.top_p,
                        stop: args.stop,
                        verbosity: args.verbosity,
                        venice_parameters: args.venice_parameters,
                        stream: false,
                    });
                    const text = resp.choices?.[0]?.message?.content ?? '';
                    return ok(truncate(text), { usage: resp.usage });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_responses',
            title: 'Venice Responses API',
            description: `OpenAI-compatible Responses API. Single-turn or multi-turn with tool support.${nsfwNote}${X402_OK}`,
            inputSchema: {
                input: z
                    .union([
                    z.string(),
                    z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })),
                ])
                    .describe('Either a plain string or an array of role+content messages.'),
                model: z.string().optional(),
                max_output_tokens: z.number().int().positive().max(32_000).optional(),
                temperature: z.number().min(0).max(2).optional(),
                venice_parameters: responsesVeniceParametersSchema,
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/responses', { ...args, model: args.model ?? cfg.defaultChatModel });
                    const text = resp.output_text ?? JSON.stringify(resp.output ?? resp, null, 2);
                    return ok(truncate(text));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_embeddings',
            title: 'Venice Embeddings',
            description: `Compute embeddings for text input (OpenAI-compatible).${X402_OK}`,
            inputSchema: {
                input: z.union([z.string(), z.array(z.string())]).describe('Text or array of texts.'),
                model: z.string().optional().describe('Embedding model id.'),
                encoding_format: z.enum(['float', 'base64']).optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/embeddings', args);
                    const dim = Array.isArray(resp.data?.[0]?.embedding) ? resp.data[0].embedding.length : null;
                    return ok(JSON.stringify(resp, null, 2), {
                        count: resp.data?.length ?? 0,
                        dimensions: dim,
                    });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // IMAGE — x402 + API key
        // ========================================================================
        {
            name: 'venice_image_generate',
            title: 'Venice Image Generate',
            description: `Generate an image. Supports Flux 2 Pro/Max, Lustify SDXL, Anime (WAI), Qwen Image, GPT Image, Nano Banana Pro and others.${nsfwNote}${X402_OK}`,
            inputSchema: {
                prompt: z.string().min(1).max(4000),
                model: z.string().optional().describe(`Defaults to ${cfg.defaultImageModel}.`),
                width: z.number().int().min(256).max(2048).optional(),
                height: z.number().int().min(256).max(2048).optional(),
                steps: z.number().int().min(1).max(50).optional(),
                style_preset: z.string().optional().describe('See venice://styles.'),
                seed: z.number().int().optional(),
                safe_mode: z.boolean().optional(),
                negative_prompt: z.string().optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/image/generate', {
                        ...args,
                        model: args.model ?? cfg.defaultImageModel,
                        safe_mode: args.safe_mode ?? false,
                        return_binary: false,
                    });
                    // Default Venice response: { id, images: [<base64>] }
                    if (resp.images && resp.images.length > 0 && typeof resp.images[0] === 'string') {
                        const mimeType = detectBase64ImageMime(resp.images[0]);
                        return {
                            content: [{ type: 'image', data: resp.images[0], mimeType }],
                            structuredContent: { id: resp.id, count: resp.images.length },
                        };
                    }
                    // OpenAI-compat shape (rare): { data: [{ b64_json | url }] }
                    const first = resp.data?.[0];
                    if (first?.url) {
                        return {
                            content: [
                                { type: 'resource_link', uri: first.url, name: 'image', mimeType: 'image/png' },
                                { type: 'text', text: first.url },
                            ],
                            structuredContent: { url: first.url },
                        };
                    }
                    if (first?.b64_json) {
                        const mimeType = detectBase64ImageMime(first.b64_json);
                        return { content: [{ type: 'image', data: first.b64_json, mimeType }] };
                    }
                    return fail('Venice returned no usable image payload.');
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_image_edit',
            title: 'Venice Image Edit',
            description: `Edit an image with a prompt. Returns base64 PNG.${X402_OK}`,
            inputSchema: {
                image_url: z.string().url().describe('URL of the image to edit (will be passed through to the edit endpoint).'),
                prompt: z.string().min(1).max(32_000),
                model: z.string().optional().describe('Edit model id; defaults to firered-image-edit.'),
                aspect_ratio: z.string().optional().describe('Output aspect ratio, e.g. "1:1", "16:9", "9:16", "4:5". Supported values vary by model; the API validates.'),
                safe_mode: z.boolean().optional(),
            },
            handler: async (args) => {
                try {
                    const { buffer, contentType } = await client.postBinary('/v1/image/edit', {
                        method: 'POST',
                        json: {
                            image: args.image_url,
                            prompt: args.prompt,
                            model: args.model,
                            aspect_ratio: args.aspect_ratio,
                            safe_mode: args.safe_mode ?? false,
                        },
                    });
                    return {
                        content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
                    };
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_image_multi_edit',
            title: 'Venice Image Multi-Edit',
            description: `Edit multiple images together with a single prompt (multi-image composition / outpainting). Returns base64 PNG.${X402_OK}`,
            inputSchema: {
                image_urls: z.array(z.string().url()).min(1).max(8),
                prompt: z.string().min(1).max(32_000),
                model: z.string().optional(),
                aspect_ratio: z.string().optional().describe('Output aspect ratio, e.g. "1:1", "16:9", "9:16", "4:5". Supported values vary by model; the API validates.'),
            },
            handler: async (args) => {
                try {
                    // Multi-edit accepts multipart 'images' files or JSON 'images' array of base64/URL strings.
                    // We send JSON with URL strings for simplicity.
                    const { buffer, contentType } = await client.postBinary('/v1/image/multi-edit', {
                        method: 'POST',
                        json: {
                            images: args.image_urls,
                            prompt: args.prompt,
                            model: args.model,
                            aspect_ratio: args.aspect_ratio,
                        },
                    });
                    return {
                        content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
                    };
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_image_upscale',
            title: 'Venice Image Upscale',
            description: `Upscale an image (2-4× scale). Endpoint requires base64 image; this tool fetches the URL and uploads it. Returns base64 PNG.${X402_OK}`,
            inputSchema: {
                image_url: z.string().url(),
                scale: z.number().min(2).max(4).optional().describe('Upscale factor, 2 to 4. Defaults to 2. Large inputs are scaled down automatically to stay under the 4096x4096 output cap.'),
                creativity: z
                    .number()
                    .min(0)
                    .max(0.02)
                    .optional()
                    .describe('How much detail and texture the upscaler invents, 0 to 0.02. Defaults to 0.01. Higher stays further from the source.'),
            },
            handler: async (args) => {
                try {
                    const source = await fetchUploadSource(args.image_url, {
                        label: 'image_url',
                        fallbackContentType: 'image/png',
                        fallbackFilename: 'image.png',
                        timeoutMs: cfg.timeoutMs,
                        allowedContentTypes: ['image/'],
                    });
                    const form = new FormData();
                    form.set('image', new Blob([source.buffer], { type: source.contentType }), source.filename);
                    if (args.scale !== undefined)
                        form.set('scale', String(args.scale));
                    if (args.creativity !== undefined)
                        form.set('creativity', String(args.creativity));
                    const { buffer, contentType } = await client.postBinary('/v1/image/upscale', { form });
                    return {
                        content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
                    };
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_image_remove_bg',
            title: 'Venice Image Background Remove',
            description: `Remove image background; returns a transparent PNG (base64).${X402_OK}`,
            inputSchema: { image_url: z.string().url() },
            handler: async (args) => {
                try {
                    const { buffer, contentType } = await client.postBinary('/v1/image/background-remove', {
                        method: 'POST',
                        json: { image_url: args.image_url },
                    });
                    return {
                        content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
                    };
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // VIDEO — x402 + API key
        // Status flow: queue → retrieve (POST!) → complete (cleanup)
        // ========================================================================
        {
            name: 'venice_video_generate',
            title: 'Venice Video Queue',
            description: `Queue a video generation. Supports Sora 2, Veo 3.1, Kling, Wan, LTX 2, Seedance, Runway Gen-4, and others. Pick a specific id like "veo3.1-fast-text-to-video", "veo3.1-fast-image-to-video", "kling-2.6-pro-text-to-video", "wan-2.6-text-to-video", "seedance-2-0-r2v" etc.${nsfwNote}${X402_OK} Returns { model, queue_id }; poll with venice_video_status. NOTE: 'duration' is a string enum like '4s' / '6s' / '8s' (model-specific, see model card).`,
            inputSchema: {
                prompt: z.string().min(1).max(4096),
                model: z.string().describe('Required. Full model id, e.g. "veo3.1-fast-text-to-video".'),
                duration: z.string().optional().describe('Duration as model-specific string enum, e.g. "4s", "6s", "8s". See GET /v1/models/:id/card.'),
                aspect_ratio: z.string().optional().describe('Output aspect ratio, e.g. "16:9", "9:16", "1:1", "4:5", "9:21". Model-specific; see GET /v1/models/:id/card.'),
                seed: z.number().int().optional(),
                image_url: z.string().url().optional().describe('For image-to-video models: starting frame. URL or data URL.'),
                end_image_url: z.string().url().optional().describe('For models that support end frames or transitions. URL or data URL.'),
                video_url: z.string().url().optional().describe('For video-to-video models (e.g. seedance-2-0-r2v): input video. URL or data URL. Supported: MP4, MOV, WebM.'),
                audio_url: z.string().url().optional().describe('For models that support audio input: background music. URL or data URL. Supported: WAV, MP3. Max 30s, 15MB.'),
                reference_image_urls: z.array(z.string().url()).max(9).optional().describe('For models with reference image support: up to 9 images for character/style consistency. Each a URL or data URL.'),
                reference_video_urls: z.array(z.string().url()).max(3).optional().describe('For Seedance 2.0 R2V and similar: up to 3 reference video clips to inherit subject motion, camera movement, and style. Per-clip 2–15s, MP4/MOV, ≤50MB; aggregate ≤15s. Each a URL or data URL.'),
                reference_audio_urls: z.array(z.string().url()).max(3).optional().describe('For Seedance 2.0 R2V and similar: up to 3 reference audio clips for vocal timbre, narration, or sound effects. Per-clip 2–15s, WAV/MP3; aggregate ≤15s. Must be paired with at least one reference image or video. Each a URL or data URL.'),
                elements: z.array(z.object({
                    frontal_image_url: z.string().url().optional(),
                    reference_image_urls: z.array(z.string().url()).max(3).optional(),
                    video_url: z.string().url().optional(),
                })).max(4).optional().describe('For Kling O3 R2V and similar: up to 4 character/object elements. Reference in prompt as @Element1, @Element2, etc.'),
                scene_image_urls: z.array(z.string().url()).max(4).optional().describe('For models with advanced element support: up to 4 scene reference images. Reference in prompt as @Image1, @Image2, etc.'),
                negative_prompt: z.string().max(4096).optional().describe('Negative prompt (what to avoid). Supported by Seedance and other models.'),
                resolution: z.string().optional().describe('Output resolution, e.g. "720p", "1080p", "4k". Model-specific; see model card.'),
                upscale_factor: z.number().int().optional().describe('For upscale models only: 1 = quality enhance, 2 = double resolution, 4 = quadruple.'),
                audio: z.boolean().optional().describe('Enable or disable audio generation for models that support it. Defaults to true.'),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/video/queue', args);
                    const id = resp.queue_id;
                    if (!id)
                        return fail('No queue_id returned by Venice.');
                    return ok(`Queued: queue_id=${id}, model=${resp.model}\n` +
                        `Poll with venice_video_status({ queue_id: "${id}", model: "${resp.model}" })`, { queue_id: id, model: resp.model, download_url: resp.download_url });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_video_status',
            title: 'Venice Video Retrieve / Status',
            description: `Check status of a queued video job. Status enum: PROCESSING, COMPLETED. POST endpoint with body {model, queue_id}.${X402_OK}`,
            inputSchema: {
                queue_id: z.string().min(1).describe('Returned by venice_video_generate.'),
                model: z.string().min(1).describe('Same model id used to queue.'),
                delete_media_on_completion: z.boolean().optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/video/retrieve', args);
                    const url = resp.download_url ?? resp.url;
                    if (resp.status === 'COMPLETED' && url) {
                        return {
                            content: [
                                { type: 'resource_link', uri: url, name: 'video', mimeType: 'video/mp4' },
                                { type: 'text', text: `Done: ${url}` },
                            ],
                            structuredContent: { status: resp.status, url },
                        };
                    }
                    const eta = resp.average_execution_time ? `${Math.round(resp.average_execution_time / 1000)}s ETA` : '';
                    const dur = resp.execution_duration ? `${Math.round(resp.execution_duration / 1000)}s elapsed` : '';
                    return ok(`Status: ${resp.status ?? 'unknown'} ${dur} ${eta}`.trim(), { status: resp.status });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_video_complete',
            title: 'Venice Video Complete (cleanup)',
            description: `Mark a completed video as downloaded; deletes server-side media.${X402_OK}`,
            inputSchema: {
                queue_id: z.string().min(1),
                model: z.string().min(1),
            },
            handler: async (args) => {
                try {
                    await client.post('/v1/video/complete', args);
                    return ok(`Marked ${args.queue_id} complete; server-side media removed.`);
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_video_transcriptions',
            title: 'Venice Video Transcriptions',
            description: `Transcribe a YouTube video URL.${X402_OK}`,
            inputSchema: {
                url: z.string().url().describe('YouTube URL only (e.g. https://www.youtube.com/watch?v=...).'),
                response_format: z.enum(['json', 'text']).optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/video/transcriptions', args);
                    return ok(truncate(resp.transcript ?? resp.text ?? JSON.stringify(resp)), { lang: resp.lang });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // AUDIO (TTS / ASR / Voices) — x402 + API key
        // ========================================================================
        {
            name: 'venice_tts',
            title: 'Venice TTS (Speech)',
            description: `Convert text to speech. Supports cloned voices + emotion tags ([whispers], [sarcastically], etc.).${X402_OK}`,
            inputSchema: {
                input: z.string().min(1).max(4096).describe('Text to convert to speech (max 4096 chars).'),
                voice: z.string().optional().describe('Voice id; see venice://voices.'),
                model: z.string().optional(),
                speed: z.number().min(0.25).max(4).optional(),
                response_format: z.enum(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']).optional(),
            },
            handler: async (args) => {
                try {
                    const { buffer, contentType } = await client.postBinary('/v1/audio/speech', {
                        method: 'POST',
                        json: { ...args, model: args.model ?? cfg.defaultTtsModel },
                    });
                    return {
                        content: [{ type: 'audio', data: buffer.toString('base64'), mimeType: contentType }],
                    };
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_asr',
            title: 'Venice ASR (Speech-to-Text)',
            description: `Transcribe audio. Fetches the URL server-side and forwards as multipart/form-data file upload.${X402_OK}`,
            inputSchema: {
                audio_url: z.string().url(),
                model: z.string().optional(),
                language: z.string().optional(),
                response_format: z.enum(['json', 'text', 'srt', 'verbose_json', 'vtt']).optional(),
            },
            handler: async (args) => {
                try {
                    const source = await fetchUploadSource(args.audio_url, {
                        label: 'audio_url',
                        fallbackContentType: 'audio/wav',
                        fallbackFilename: 'audio',
                        timeoutMs: cfg.timeoutMs,
                        allowedContentTypes: ['audio/', 'video/'],
                    });
                    const form = new FormData();
                    form.set('file', new Blob([source.buffer], { type: source.contentType }), source.filename);
                    form.set('model', args.model ?? cfg.defaultAsrModel);
                    if (args.language)
                        form.set('language', args.language);
                    if (args.response_format)
                        form.set('response_format', args.response_format);
                    const resp = await client.postMultipart('/v1/audio/transcriptions', form);
                    return ok(truncate(resp.text ?? resp.transcription ?? JSON.stringify(resp)));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_voice_clone',
            title: 'Venice Voice Clone / List',
            description: `Manage TTS voices. Action 'list' returns the static catalog of built-in voices grouped by TTS model (Venice does not expose a list endpoint). Action 'create' clones a voice from a sample audio URL via multipart upload to /v1/audio/voices. ${X402_OK}`,
            inputSchema: {
                action: z.enum(['list', 'create']).describe('list = show built-in voices, create = clone from sample_url'),
                sample_url: z.string().url().optional().describe('Audio sample URL for action=create. WAV/MP3/M4A.'),
                model: z.string().optional().describe('Voice cloning model. Required for action=create. Examples: tts-chatterbox-hd, tts-minimax-speech-02-hd.'),
            },
            handler: async (args) => {
                try {
                    if (args.action === 'list') {
                        // Static reference — Venice doesn't expose GET /v1/audio/voices.
                        // Voice IDs come from each TTS model's hardcoded list. Group by model
                        // for clarity. Cloned voices use the `vv_<id>` handle returned by
                        // POST /v1/audio/voices.
                        const voices = {
                            note: 'Venice does not expose a list endpoint. These are the built-in voices available across TTS models. Cloned voices come back as `vv_<id>` from action=create.',
                            kokoro: {
                                description: 'Default model "tts-kokoro" — fast, multilingual, 70+ voices',
                                examples: ['af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck'],
                            },
                            orpheus: {
                                description: 'Model "tts-orpheus" — expressive, supports emotion tags',
                                voices: ['leah', 'jess', 'mia', 'zoe', 'leo', 'dan', 'zac', 'tara'],
                            },
                            other_models: ['tts-qwen3-0-6b', 'tts-qwen3-1-7b', 'tts-xai-v1', 'tts-inworld-1-5-max', 'tts-chatterbox-hd', 'tts-elevenlabs-turbo-v2-5', 'tts-minimax-speech-02-hd', 'tts-gemini-3-1-flash'],
                            voice_cloning_supported: ['tts-chatterbox-hd', 'tts-minimax-speech-02-hd'],
                            docs: 'https://docs.venice.ai/api-reference/api-spec/tts',
                        };
                        return ok(JSON.stringify(voices, null, 2));
                    }
                    // action === 'create'
                    if (!args.sample_url)
                        return fail('sample_url is required for action=create');
                    const source = await fetchUploadSource(args.sample_url, {
                        label: 'sample_url',
                        fallbackContentType: 'audio/mpeg',
                        fallbackFilename: 'sample',
                        timeoutMs: cfg.timeoutMs,
                        allowedContentTypes: ['audio/', 'video/'],
                    });
                    const form = new FormData();
                    form.set('file', new Blob([source.buffer], { type: source.contentType }), source.filename);
                    if (args.model)
                        form.set('model', args.model);
                    const resp = await client.postMultipart('/v1/audio/voices', form);
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // MUSIC (audio/queue, audio/retrieve, audio/complete) — x402 + API key
        // ========================================================================
        {
            name: 'venice_music_generate',
            title: 'Venice Music Queue',
            description: `Queue music generation. Available models: ace-step-15, elevenlabs-music, minimax-music-v2/v25/v26, stable-audio-25, mmaudio-v2-text-to-audio, elevenlabs-sound-effects-v2.${nsfwNote}${X402_OK} Returns { model, queue_id }; poll with venice_music_status.`,
            inputSchema: {
                prompt: z.string().min(1).max(4000),
                model: z.string().describe('Required. Music model id, e.g. "elevenlabs-music".'),
                duration_seconds: z.number().min(1).max(300).optional(),
                instrumental: z.boolean().optional(),
                lyrics: z.string().max(4096).optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/audio/queue', args);
                    const id = resp.queue_id;
                    if (!id)
                        return fail('No queue_id returned.');
                    return ok(`Queued: queue_id=${id}, model=${resp.model}\n` +
                        `Poll with venice_music_status({ queue_id: "${id}", model: "${resp.model}" })`, { queue_id: id, model: resp.model });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_music_status',
            title: 'Venice Music Retrieve / Status',
            description: `Check status of a queued music job (POST endpoint with body {model, queue_id}).${X402_OK}`,
            inputSchema: {
                queue_id: z.string().min(1),
                model: z.string().min(1),
                delete_media_on_completion: z.boolean().optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/audio/retrieve', args);
                    const url = resp.download_url ?? resp.url;
                    if (resp.status === 'COMPLETED' && url) {
                        return {
                            content: [
                                { type: 'resource_link', uri: url, name: 'music', mimeType: 'audio/mpeg' },
                                { type: 'text', text: url },
                            ],
                            structuredContent: { status: resp.status, url },
                        };
                    }
                    return ok(`Status: ${resp.status ?? 'unknown'}`, { status: resp.status });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_music_complete',
            title: 'Venice Music Complete (cleanup)',
            description: `Mark a completed music job as downloaded.${X402_OK}`,
            inputSchema: { queue_id: z.string().min(1), model: z.string().min(1) },
            handler: async (args) => {
                try {
                    await client.post('/v1/audio/complete', args);
                    return ok(`Marked music ${args.queue_id} complete.`);
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // AUGMENT (search / scrape / doc parsing) — x402 + API key
        // ========================================================================
        {
            name: 'venice_web_search',
            title: 'Venice Web Search',
            description: `Search the web (Firecrawl-backed). Returns ranked results with snippets.${X402_OK}`,
            inputSchema: {
                query: z.string().min(1).max(500),
                limit: z.number().int().min(1).max(20).optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/augment/search', args);
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_web_scrape',
            title: 'Venice Web Scrape',
            description: `Scrape one URL into markdown text.${X402_OK}`,
            inputSchema: {
                url: z.string().url(),
                format: z.enum(['markdown', 'html', 'text']).optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/augment/scrape', args);
                    return ok(truncate(resp.markdown ?? resp.content ?? JSON.stringify(resp)));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_text_parser',
            title: 'Venice Text Parser (PDF/DOCX/EPUB/PPTX/XLSX)',
            description: `Extract text from a document URL. Fetches the URL server-side and uploads the file as multipart/form-data.${X402_OK}`,
            inputSchema: {
                url: z.string().url(),
            },
            handler: async (args) => {
                try {
                    const source = await fetchUploadSource(args.url, {
                        label: 'url',
                        fallbackContentType: 'application/pdf',
                        fallbackFilename: 'document',
                        timeoutMs: cfg.timeoutMs,
                        allowedContentTypes: [
                            'application/pdf',
                            'application/msword',
                            'application/vnd.openxmlformats-officedocument.',
                            'application/vnd.ms-',
                            'application/epub+zip',
                            'text/',
                        ],
                    });
                    const form = new FormData();
                    form.set('file', new Blob([source.buffer], { type: source.contentType }), source.filename);
                    const resp = await client.postMultipart('/v1/augment/text-parser', form);
                    return ok(truncate(resp.text ?? JSON.stringify(resp)));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // CRYPTO RPC PROXY — x402 + API key
        // ========================================================================
        {
            name: 'venice_crypto_rpc',
            title: 'Venice Crypto RPC Proxy',
            description: `Proxy a JSON-RPC call to a supported blockchain network (eth_call, eth_blockNumber, etc.). Networks include "base-mainnet", "ethereum-mainnet", "polygon-mainnet", "arbitrum-mainnet", "optimism-mainnet", and others. List all via GET /api/v1/crypto/rpc/networks.${X402_OK}`,
            inputSchema: {
                network: z.string().min(1).describe('Full network id, e.g. "base-mainnet" (NOT just "base"), "ethereum-mainnet", "polygon-mainnet".'),
                rpc_method: z.string().min(1),
                rpc_params: z.array(z.unknown()).optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post(`/v1/crypto/rpc/${encodeURIComponent(args.network)}`, { jsonrpc: '2.0', method: args.rpc_method, params: args.rpc_params ?? [], id: 1 });
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // CATALOG — auth-free GETs (or API-key for characters)
        // ========================================================================
        {
            name: 'venice_list_models',
            title: 'Venice List Models',
            description: `List the live model catalog with capabilities and prices.${NO_AUTH}`,
            inputSchema: {
                type: z.enum(['text', 'image', 'video', 'audio', 'music', 'embedding', 'all']).optional(),
            },
            handler: async ({ type }) => {
                try {
                    const resp = await client.get('/v1/models');
                    const all = resp.data ?? resp.models ?? [];
                    const filtered = type && type !== 'all'
                        ? all.filter((m) => {
                            const obj = m;
                            const t = String(obj.type ?? obj.modelType ?? '').toLowerCase();
                            return t.includes(type);
                        })
                        : all;
                    return ok(JSON.stringify(filtered.slice(0, 80), null, 2), {
                        count: filtered.length,
                        total: all.length,
                    });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_image_styles',
            title: 'Venice Image Styles',
            description: `List image style presets available for venice_image_generate.${NO_AUTH}`,
            inputSchema: {},
            handler: async () => {
                try {
                    const resp = await client.get('/v1/image/styles');
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_audio_quote',
            title: 'Venice Music Cost Quote',
            description: `Get a price quote for a music generation BEFORE queuing. Useful for budgeting.${NO_AUTH}`,
            inputSchema: {
                model: z.string().min(1).describe('Music model id, e.g. "elevenlabs-music".'),
                duration_seconds: z.number().min(1).max(300).optional(),
                character_count: z.number().int().positive().optional().describe('Required for character-based pricing models.'),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/audio/quote', args);
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_video_quote',
            title: 'Venice Video Cost Quote',
            description: `Get a price quote for a video generation BEFORE queuing.${NO_AUTH}`,
            inputSchema: {
                model: z.string().min(1).describe('Video model id, e.g. "veo3.1-fast-text-to-video".'),
                duration: z.string().optional().describe('Duration as model-specific string enum, e.g. "4s", "6s", "8s".'),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/video/quote', args);
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // CHARACTERS — API KEY ONLY (no x402 support on these endpoints)
        // ========================================================================
        {
            name: 'venice_list_characters',
            title: 'Venice List Characters',
            description: `List public Venice characters.${API_KEY_ONLY}`,
            inputSchema: {
                search: z.string().optional(),
                tag: z.string().optional(),
                limit: z.number().int().min(1).max(50).optional(),
                offset: z.number().int().min(0).optional(),
            },
            handler: async (args) => {
                try {
                    const params = new URLSearchParams();
                    if (args.search)
                        params.set('search', args.search);
                    if (args.tag)
                        params.set('tag', args.tag);
                    if (args.limit !== undefined)
                        params.set('limit', String(args.limit));
                    if (args.offset !== undefined)
                        params.set('offset', String(args.offset));
                    const qs = params.toString();
                    const resp = await client.get(`/v1/characters${qs ? `?${qs}` : ''}`, undefined, { auth: 'apiKey' });
                    const list = resp.data ?? resp.characters ?? [];
                    return ok(JSON.stringify(list, null, 2), { count: list.length });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_chat_with_character',
            title: 'Venice Character Chat',
            description: `Chat with a Venice character by slug. Note: the character lookup itself is API-key-only, but the chat completion supports x402 — so x402 users may need to fetch character info via API key first.${nsfwNote}`,
            inputSchema: {
                character_slug: z.string().min(1),
                messages: z
                    .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }))
                    .min(1),
                model: z.string().optional(),
                temperature: z.number().min(0).max(2).optional(),
                max_tokens: z.number().int().positive().max(32_000).optional(),
            },
            handler: async (args) => {
                try {
                    const resp = await client.post('/v1/chat/completions', {
                        model: args.model ?? cfg.defaultChatModel,
                        messages: args.messages,
                        temperature: args.temperature,
                        max_tokens: args.max_tokens,
                        venice_parameters: { character_slug: args.character_slug },
                        stream: false,
                    });
                    const text = resp.choices?.[0]?.message?.content ?? '';
                    return ok(truncate(text), { usage: resp.usage });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // BILLING — ADMIN API KEY ONLY
        // ========================================================================
        {
            name: 'venice_billing_balance',
            title: 'Venice Billing Balance',
            description: `Get current USD, DIEM, and bundled-credit availability for the authenticated Venice account.${ADMIN_API_KEY_ONLY}`,
            inputSchema: {},
            handler: async () => {
                try {
                    const resp = await client.get('/v1/billing/balance', undefined, { auth: 'apiKey' });
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_billing_usage_analytics',
            title: 'Venice Billing Usage Analytics',
            description: `Get beta aggregated usage by date, model, and API key. Data is cached for 10 minutes. Choose either lookback or a complete start/end date range.${ADMIN_API_KEY_ONLY}`,
            inputSchema: {
                lookback: z
                    .string()
                    .regex(/^[1-9]\d*d$/, 'Must be a number of days such as 7d or 30d.')
                    .optional()
                    .describe('Relative lookback from 1d through 90d. Cannot be combined with start_date/end_date.'),
                start_date: dateSchema.optional().describe('Inclusive custom range start in YYYY-MM-DD format. Requires end_date.'),
                end_date: dateSchema.optional().describe('Custom range end in YYYY-MM-DD format. Requires start_date.'),
            },
            handler: async (args) => {
                try {
                    if (args.lookback && (args.start_date || args.end_date)) {
                        return fail('Choose either lookback or start_date/end_date, not both.');
                    }
                    if ((args.start_date && !args.end_date) || (!args.start_date && args.end_date)) {
                        return fail('start_date and end_date must be provided together.');
                    }
                    if (args.lookback && Number(args.lookback.slice(0, -1)) > 90) {
                        return fail('lookback cannot exceed 90d.');
                    }
                    const params = new URLSearchParams();
                    if (args.lookback)
                        params.set('lookback', args.lookback);
                    if (args.start_date)
                        params.set('startDate', args.start_date);
                    if (args.end_date)
                        params.set('endDate', args.end_date);
                    const query = params.toString();
                    const resp = await client.get(`/v1/billing/usage-analytics${query ? `?${query}` : ''}`, undefined, { auth: 'apiKey' });
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_billing_usage_history',
            title: 'Venice Billing Usage History',
            description: `Walk detailed billing usage in ascending timestamp order using cursor pagination. Supports JSON or upstream CSV. On continuation, send cursor without the original filters; CSV nextCursor values already encode format=csv so a cursor-only follow-up stays on text/csv. This uses /billing/usage-history, never deprecated /billing/usage.${ADMIN_API_KEY_ONLY}`,
            inputSchema: {
                currency: z.enum(['USD', 'DIEM', 'BUNDLED_CREDITS']).optional(),
                cursor: z
                    .string()
                    .min(1)
                    .max(516)
                    .regex(/^(csv:)?[A-Za-z0-9_-]+$/)
                    .optional()
                    .describe('Opaque nextCursor from the previous page. CSV pages return a csv: prefix so continuation stays on text/csv. Cannot be combined with filters or page_size.'),
                start_timestamp: utcTimestampSchema
                    .optional()
                    .describe('Inclusive first-page lower bound, ISO 8601 UTC with Z suffix.'),
                end_timestamp: utcTimestampSchema
                    .optional()
                    .describe('Exclusive first-page upper bound, ISO 8601 UTC with Z suffix.'),
                page_size: z.number().int().min(10).max(1000).optional(),
                format: z.enum(['json', 'csv']).optional().describe('Defaults to json. Optional on continuation; CSV nextCursor values already stay on CSV.'),
            },
            handler: async (args) => {
                try {
                    if (args.cursor &&
                        (args.currency || args.start_timestamp || args.end_timestamp || args.page_size !== undefined)) {
                        return fail('cursor must be sent without currency, timestamps, or page_size. format may be resent.');
                    }
                    if (args.start_timestamp &&
                        args.end_timestamp &&
                        Date.parse(args.start_timestamp) >= Date.parse(args.end_timestamp)) {
                        return fail('end_timestamp must be later than start_timestamp.');
                    }
                    const CSV_CURSOR_PREFIX = 'csv:';
                    const rawCursor = args.cursor?.startsWith(CSV_CURSOR_PREFIX)
                        ? args.cursor.slice(CSV_CURSOR_PREFIX.length)
                        : args.cursor;
                    if (args.cursor?.startsWith(CSV_CURSOR_PREFIX) && args.format === 'json') {
                        return fail('csv-prefixed cursor cannot be combined with format=json.');
                    }
                    const wantCsv = args.format === 'csv' || Boolean(args.cursor?.startsWith(CSV_CURSOR_PREFIX));
                    const params = new URLSearchParams();
                    if (rawCursor)
                        params.set('cursor', rawCursor);
                    if (args.currency)
                        params.set('currency', args.currency);
                    if (args.start_timestamp)
                        params.set('startTimestamp', args.start_timestamp);
                    if (args.end_timestamp)
                        params.set('endTimestamp', args.end_timestamp);
                    if (args.page_size !== undefined)
                        params.set('pageSize', String(args.page_size));
                    const query = params.toString();
                    const path = `/v1/billing/usage-history${query ? `?${query}` : ''}`;
                    if (wantCsv) {
                        let nextCursor;
                        const csv = await client.get(path, { Accept: 'text/csv' }, {
                            auth: 'apiKey',
                            onResponse: ({ headers }) => {
                                nextCursor = headers['x-next-cursor'];
                            },
                        });
                        return ok(csv, {
                            format: 'csv',
                            nextCursor: nextCursor ? `${CSV_CURSOR_PREFIX}${nextCursor}` : null,
                        });
                    }
                    const resp = await client.get(path, undefined, { auth: 'apiKey' });
                    return ok(JSON.stringify(resp, null, 2), {
                        format: 'json',
                        count: resp.data?.length ?? 0,
                        nextCursor: resp.nextCursor ?? null,
                    });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // API KEYS — safe reads + unauthenticated Web3 mint flow
        // ========================================================================
        {
            name: 'venice_list_api_keys',
            title: 'Venice List API Keys',
            description: `List active API-key metadata, including only the documented last six characters—not full key secrets.${ADMIN_API_KEY_ONLY}`,
            inputSchema: {},
            handler: async () => {
                try {
                    const resp = await client.get('/v1/api_keys', undefined, { auth: 'apiKey' });
                    return ok(safeJson(resp), { count: resp.data?.length ?? 0 });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_get_api_key',
            title: 'Venice Get API Key Details',
            description: `Get metadata, usage, balances, and rate-limit details for one API-key ID. The documented response does not reveal the full key secret.${ADMIN_API_KEY_ONLY}`,
            inputSchema: {
                id: z.string().min(1).max(256).describe('API-key ID, not the key secret.'),
            },
            handler: async ({ id }) => {
                try {
                    const resp = await client.get(`/v1/api_keys/${encodeURIComponent(id)}`, undefined, { auth: 'apiKey' });
                    return ok(safeJson(resp));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_api_key_rate_limits',
            title: 'Venice API Key Rate Limits',
            description: `Get the current key's balances, access status, tier, expiration, and model-specific rate limits.${API_KEY_ONLY}`,
            inputSchema: {},
            handler: async () => {
                try {
                    const resp = await client.get('/v1/api_keys/rate_limits', undefined, { auth: 'apiKey' });
                    return ok(safeJson(resp));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_api_key_rate_limit_logs',
            title: 'Venice API Key Rate Limit Logs',
            description: `Get the last 50 exceeded rate-limit events for the account. This read-only endpoint is experimental.${API_KEY_ONLY}`,
            inputSchema: {},
            handler: async () => {
                try {
                    const resp = await client.get('/v1/api_keys/rate_limits/log', undefined, { auth: 'apiKey' });
                    return ok(safeJson(resp), { count: resp.data?.length ?? 0 });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_web3_key_challenge',
            title: 'Venice Web3 API Key Challenge',
            description: `Get the unauthenticated, short-lived token for autonomous API-key minting. Sign the raw token outside this server with an EVM wallet holding staked VVV; this server never accepts a private key.${NO_AUTH}`,
            inputSchema: {},
            handler: async () => {
                try {
                    const resp = await client.get('/v1/api_keys/generate_web3_key', undefined, { auth: 'none' });
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_web3_key_mint',
            title: 'Venice Web3 API Key Mint',
            description: `Submit an externally signed Web3 challenge to mint an INFERENCE API key for an EVM wallet with staked VVV on Base. ADMIN keys are not mintable through MCP. A positive consumption_limit is required because the wallet signature covers only the challenge token. limit_period defaults to LIFETIME so a dollar cap is a permanent cap, not a daily reset. Never provide a private key. The returned apiKey is shown once—store it securely. If minting times out or the response is lost, do not retry: revoke any unexpected key with an ADMIN key first.${NO_AUTH}`,
            inputSchema: {
                address: evmAddressSchema,
                signature: z.string().min(1).max(4096).describe('Signature created by the caller wallet over the raw challenge token.'),
                token: z.string().min(1).max(8192).describe('Unmodified token returned by venice_web3_key_challenge.'),
                api_key_type: z
                    .literal('INFERENCE')
                    .optional()
                    .describe('Only INFERENCE keys can be minted through MCP. ADMIN is rejected.'),
                description: z.string().max(64).optional().describe('Optional API-key description (max 64 characters).'),
                expires_at: z
                    .union([dateSchema, utcTimestampSchema])
                    .optional()
                    .describe('Optional YYYY-MM-DD or ISO 8601 UTC expiration.'),
                consumption_limit: z
                    .object({
                    usd: z.number().min(0).max(9_999_999_999).nullable().optional(),
                    diem: z.number().min(0).max(9_999_999_999).nullable().optional(),
                    vcu: z.number().min(0).max(9_999_999_999).nullable().optional(),
                })
                    .refine((limit) => [limit.usd, limit.diem, limit.vcu].some((value) => typeof value === 'number' && value > 0), 'At least one positive consumption limit (usd, diem, or vcu) is required.')
                    .describe('Required spend cap. The challenge signature does not bind key type or limits.'),
                limit_period: z
                    .enum(['EPOCH', 'MONTH', 'LIFETIME'])
                    .optional()
                    .describe('Reset window for consumption_limit. Defaults to LIFETIME (permanent cap). EPOCH resets every UTC day; MONTH resets on the 1st UTC day of the month.'),
            },
            handler: async (args) => {
                const cached = getSucceededWeb3Mint(args.token);
                if (cached !== undefined) {
                    return ok(`Store the newly minted API key securely; it is shown only once.\n${JSON.stringify(cached, null, 2)}`);
                }
                const attempt = beginWeb3MintAttempt(args.token);
                if (attempt !== 'fresh') {
                    return fail(web3MintBlockedMessage(attempt === 'succeeded' ? 'unknown' : attempt));
                }
                try {
                    const resp = await client.post('/v1/api_keys/generate_web3_key', {
                        address: args.address,
                        signature: args.signature,
                        token: args.token,
                        apiKeyType: 'INFERENCE',
                        description: args.description,
                        expiresAt: normalizeExpiresAt(args.expires_at),
                        consumptionLimit: args.consumption_limit,
                        limitPeriod: args.limit_period ?? 'LIFETIME',
                    }, undefined, { auth: 'none' });
                    succeedWeb3MintAttempt(args.token, resp);
                    // The secret must reach the caller, but it is never written to server logs
                    // or duplicated in structuredContent.
                    return ok(`Store the newly minted API key securely; it is shown only once.\n${JSON.stringify(resp, null, 2)}`);
                }
                catch (err) {
                    if (isUnknownMintOutcome(err)) {
                        markUnknownWeb3MintAttempt(args.token);
                        return fail(`${WEB3_MINT_RECOVERY_MESSAGE} ${formatToolError(err)}`);
                    }
                    releaseWeb3MintAttempt(args.token);
                    return fail(formatToolError(err));
                }
            },
        },
        // ========================================================================
        // x402 wallet helpers — SIWX reads + auth-free top-up discovery
        // ========================================================================
        {
            name: 'venice_x402_balance',
            title: 'Venice x402 Wallet Balance',
            description: `Check the prepaid x402 credit balance for an EVM or Solana wallet address. SIWX-ONLY: this endpoint rejects API key auth and requires SIGN-IN-WITH-X (forwarded from VENICE_SIWX_TOKEN). The wallet in the path must match the SIWX-authenticated wallet.`,
            inputSchema: {
                wallet_address: walletAddressSchema,
            },
            handler: async ({ wallet_address }) => {
                try {
                    const resp = await client.get(`/v1/x402/balance/${encodeURIComponent(normalizeWalletAddress(wallet_address))}`, undefined, { auth: 'siwx' });
                    return ok(JSON.stringify(resp, null, 2), { balance: resp });
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_x402_top_up_info',
            title: 'Venice x402 Top-up Requirements',
            description: `Fetch step-1 Base and Solana USDC top-up requirements for an EVM or Solana wallet. The API accepts an empty POST; the address is validated locally for the caller's intended wallet. Signing and PAYMENT-SIGNATURE submission happen OUTSIDE this MCP server.`,
            inputSchema: {
                wallet_address: walletAddressSchema,
            },
            handler: async () => {
                try {
                    await client.post('/v1/x402/top-up', {}, undefined, { auth: 'none' });
                    return ok('Unexpected non-402 response. Top-up may already be processed.');
                }
                catch (err) {
                    if (err instanceof Error && err.status === 402) {
                        return ok(formatToolError(err));
                    }
                    return fail(formatToolError(err));
                }
            },
        },
        {
            name: 'venice_x402_transactions',
            title: 'Venice x402 Transaction History',
            description: `List recent x402 top-up + debit transactions for an EVM or Solana wallet. SIWX-ONLY: rejects API key, requires SIGN-IN-WITH-X (VENICE_SIWX_TOKEN). The wallet in the path must match the SIWX-authenticated wallet.`,
            inputSchema: {
                wallet_address: walletAddressSchema,
                limit: z.number().int().min(1).max(100).optional(),
            },
            handler: async ({ wallet_address, limit }) => {
                try {
                    const qs = limit ? `?limit=${limit}` : '';
                    const resp = await client.get(`/v1/x402/transactions/${encodeURIComponent(normalizeWalletAddress(wallet_address))}${qs}`, undefined, { auth: 'siwx' });
                    return ok(JSON.stringify(resp, null, 2));
                }
                catch (err) {
                    return fail(formatToolError(err));
                }
            },
        },
    ];
    return tools;
}
//# sourceMappingURL=index.js.map