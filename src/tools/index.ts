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
 *      - billing/* (balance, cost, usage, usage-analytics)
 *      - api_keys/*, support-bot
 *   🔓 Auth-free:
 *      - models, models/card, models/traits
 *      - crypto/rpc/networks
 *      - image/styles
 *      - audio/quote, video/quote
 *      - x402/balance, x402/top-up, x402/transactions
 *      - tee/attestation, tee/signature
 */
import { z } from 'zod'
import type { VeniceClient } from '../venice-client.js'
import type { Config } from '../config.js'
import { formatToolError, truncate } from '../format.js'
import { fetchUploadSource } from './remote-fetch.js'

/**
 * Sniff the MIME type of a base64-encoded image from its magic bytes.
 * Falls back to 'image/png' if the format is unrecognised.
 */
function detectBase64ImageMime(b64: string): string {
  const header = b64.slice(0, 16)
  const bytes = Buffer.from(header, 'base64')
  // WebP: RIFF????WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  // PNG: \x89PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  // JPEG: \xFF\xD8
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg'
  }
  // GIF: GIF8
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  return 'image/png'
}

type TextContent = { type: 'text'; text: string }
type ImageContent = { type: 'image'; data: string; mimeType: string }
type AudioContent = { type: 'audio'; data: string; mimeType: string }
type ResourceLinkContent = {
  type: 'resource_link'
  uri: string
  name: string
  mimeType?: string
  description?: string
}
type ToolContent = TextContent | ImageContent | AudioContent | ResourceLinkContent

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  title: string
  description: string
  inputSchema: S
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>
}

const ok = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
})
const fail = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
})

const X402_OK = ' Supports x402 wallet auth (no Venice account needed) and API key.'
const API_KEY_ONLY = ' API key required — this endpoint does not accept x402 wallet auth.'
const NO_AUTH = ' No authentication required.'

const cryptoRpcIdSchema = z.union([z.string(), z.number().int()])
const cryptoRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0').optional().describe('JSON-RPC version. Defaults to "2.0" when using rpc_method.'),
  method: z.string().min(1).describe('JSON-RPC method name.'),
  params: z.array(z.unknown()).optional().describe('Method parameters.'),
  id: cryptoRpcIdSchema.optional().describe('Caller-supplied request ID. May be omitted for a single notification.'),
})
const cryptoRpcBatchRequestSchema = cryptoRpcRequestSchema.extend({
  id: cryptoRpcIdSchema.describe('Required request ID used to correlate this batch item with its response.'),
})

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
}

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
  .describe('Venice-only options: web search, citations, system prompt control, reasoning control, characters.')

const responsesVeniceParametersSchema = z
  .object(sharedVeniceParameters)
  .optional()
  .describe('Venice-only options supported by /responses: web search, citations, scraping, system prompt control, characters.')

export function buildTools(client: VeniceClient, cfg: Config): ToolDef[] {
  const nsfwNote = cfg.enableNsfw ? ' Uncensored: NSFW prompts allowed where the model permits.' : ''
  const requireCharacterApiKey = (): ToolResult | undefined =>
    cfg.apiKey
      ? undefined
      : fail('VENICE_API_KEY is required for character discovery; x402 wallet authentication is not supported.')

  const tools: ToolDef[] = [
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
          const resp = await client.post<{
            choices?: Array<{ message?: { content?: string } }>
            usage?: Record<string, number>
          }>('/v1/chat/completions', {
            model: args.model ?? cfg.defaultChatModel,
            messages: args.messages,
            temperature: args.temperature,
            max_tokens: args.max_tokens,
            top_p: args.top_p,
            stop: args.stop,
            verbosity: args.verbosity,
            venice_parameters: args.venice_parameters,
            stream: false,
          })
          const text = resp.choices?.[0]?.message?.content ?? ''
          return ok(truncate(text), { usage: resp.usage })
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{ output_text?: string; output?: unknown[] }>(
            '/v1/responses',
            { ...args, model: args.model ?? cfg.defaultChatModel }
          )
          const text = resp.output_text ?? JSON.stringify(resp.output ?? resp, null, 2)
          return ok(truncate(text))
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{
            data?: Array<{ embedding?: number[] | string; index?: number }>
          }>('/v1/embeddings', args)
          const dim = Array.isArray(resp.data?.[0]?.embedding) ? (resp.data![0].embedding as number[]).length : null
          return ok(JSON.stringify(resp, null, 2), {
            count: resp.data?.length ?? 0,
            dimensions: dim,
          })
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{
            id?: string
            images?: string[] // base64 strings (default response shape)
            data?: Array<{ url?: string; b64_json?: string }>
          }>('/v1/image/generate', {
            ...args,
            model: args.model ?? cfg.defaultImageModel,
            safe_mode: args.safe_mode ?? false,
            return_binary: false,
          })
          // Default Venice response: { id, images: [<base64>] }
          if (resp.images && resp.images.length > 0 && typeof resp.images[0] === 'string') {
            const mimeType = detectBase64ImageMime(resp.images[0])
            return {
              content: [{ type: 'image', data: resp.images[0], mimeType }],
              structuredContent: { id: resp.id, count: resp.images.length },
            }
          }
          // OpenAI-compat shape (rare): { data: [{ b64_json | url }] }
          const first = resp.data?.[0]
          if (first?.url) {
            return {
              content: [
                { type: 'resource_link', uri: first.url, name: 'image', mimeType: 'image/png' } as ResourceLinkContent,
                { type: 'text', text: first.url },
              ],
              structuredContent: { url: first.url },
            }
          }
          if (first?.b64_json) {
            const mimeType = detectBase64ImageMime(first.b64_json)
            return { content: [{ type: 'image', data: first.b64_json, mimeType }] }
          }
          return fail('Venice returned no usable image payload.')
        } catch (err) {
          return fail(formatToolError(err))
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
          })
          return {
            content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
          }
        } catch (err) {
          return fail(formatToolError(err))
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
          })
          return {
            content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
          }
        } catch (err) {
          return fail(formatToolError(err))
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
          })
          const form = new FormData()
          form.set('image', new Blob([source.buffer], { type: source.contentType }), source.filename)
          if (args.scale !== undefined) form.set('scale', String(args.scale))
          if (args.creativity !== undefined) form.set('creativity', String(args.creativity))
          const { buffer, contentType } = await client.postBinary('/v1/image/upscale', { form })
          return {
            content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
          }
        } catch (err) {
          return fail(formatToolError(err))
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
          })
          return {
            content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
          }
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{ model?: string; queue_id?: string; download_url?: string }>(
            '/v1/video/queue',
            args
          )
          const id = resp.queue_id
          if (!id) return fail('No queue_id returned by Venice.')
          return ok(
            `Queued: queue_id=${id}, model=${resp.model}\n` +
              `Poll with venice_video_status({ queue_id: "${id}", model: "${resp.model}" })`,
            { queue_id: id, model: resp.model, download_url: resp.download_url }
          )
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{
            status?: 'PROCESSING' | 'COMPLETED'
            download_url?: string
            url?: string
            average_execution_time?: number
            execution_duration?: number
          }>('/v1/video/retrieve', args)
          const url = resp.download_url ?? resp.url
          if (resp.status === 'COMPLETED' && url) {
            return {
              content: [
                { type: 'resource_link', uri: url, name: 'video', mimeType: 'video/mp4' },
                { type: 'text', text: `Done: ${url}` },
              ],
              structuredContent: { status: resp.status, url },
            }
          }
          const eta = resp.average_execution_time ? `${Math.round(resp.average_execution_time / 1000)}s ETA` : ''
          const dur = resp.execution_duration ? `${Math.round(resp.execution_duration / 1000)}s elapsed` : ''
          return ok(`Status: ${resp.status ?? 'unknown'} ${dur} ${eta}`.trim(), { status: resp.status })
        } catch (err) {
          return fail(formatToolError(err))
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
          await client.post('/v1/video/complete', args)
          return ok(`Marked ${args.queue_id} complete; server-side media removed.`)
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{ transcript?: string; lang?: string; text?: string }>(
            '/v1/video/transcriptions',
            args
          )
          return ok(truncate(resp.transcript ?? resp.text ?? JSON.stringify(resp)), { lang: resp.lang })
        } catch (err) {
          return fail(formatToolError(err))
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
          })
          return {
            content: [{ type: 'audio', data: buffer.toString('base64'), mimeType: contentType }],
          }
        } catch (err) {
          return fail(formatToolError(err))
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
          })
          const form = new FormData()
          form.set('file', new Blob([source.buffer], { type: source.contentType }), source.filename)
          form.set('model', args.model ?? cfg.defaultAsrModel)
          if (args.language) form.set('language', args.language)
          if (args.response_format) form.set('response_format', args.response_format)
          const resp = await client.postMultipart<{ text?: string; transcription?: string }>(
            '/v1/audio/transcriptions',
            form,
          )
          return ok(truncate(resp.text ?? resp.transcription ?? JSON.stringify(resp)))
        } catch (err) {
          return fail(formatToolError(err))
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
            }
            return ok(JSON.stringify(voices, null, 2))
          }
          // action === 'create'
          if (!args.sample_url) return fail('sample_url is required for action=create')
          const source = await fetchUploadSource(args.sample_url, {
            label: 'sample_url',
            fallbackContentType: 'audio/mpeg',
            fallbackFilename: 'sample',
            timeoutMs: cfg.timeoutMs,
            allowedContentTypes: ['audio/', 'video/'],
          })
          const form = new FormData()
          form.set('file', new Blob([source.buffer], { type: source.contentType }), source.filename)
          if (args.model) form.set('model', args.model)
          const resp = await client.postMultipart<unknown>('/v1/audio/voices', form)
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{ model?: string; queue_id?: string }>(
            '/v1/audio/queue',
            args
          )
          const id = resp.queue_id
          if (!id) return fail('No queue_id returned.')
          return ok(
            `Queued: queue_id=${id}, model=${resp.model}\n` +
              `Poll with venice_music_status({ queue_id: "${id}", model: "${resp.model}" })`,
            { queue_id: id, model: resp.model }
          )
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{
            status?: 'PROCESSING' | 'COMPLETED'
            download_url?: string
            url?: string
            average_execution_time?: number
          }>('/v1/audio/retrieve', args)
          const url = resp.download_url ?? resp.url
          if (resp.status === 'COMPLETED' && url) {
            return {
              content: [
                { type: 'resource_link', uri: url, name: 'music', mimeType: 'audio/mpeg' },
                { type: 'text', text: url },
              ],
              structuredContent: { status: resp.status, url },
            }
          }
          return ok(`Status: ${resp.status ?? 'unknown'}`, { status: resp.status })
        } catch (err) {
          return fail(formatToolError(err))
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
          await client.post('/v1/audio/complete', args)
          return ok(`Marked music ${args.queue_id} complete.`)
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<unknown>('/v1/augment/search', args)
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{ content?: string; markdown?: string }>(
            '/v1/augment/scrape',
            args
          )
          return ok(truncate(resp.markdown ?? resp.content ?? JSON.stringify(resp)))
        } catch (err) {
          return fail(formatToolError(err))
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
          })
          const form = new FormData()
          form.set('file', new Blob([source.buffer], { type: source.contentType }), source.filename)
          const resp = await client.postMultipart<{ text?: string }>('/v1/augment/text-parser', form)
          return ok(truncate(resp.text ?? JSON.stringify(resp)))
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    // ========================================================================
    // CRYPTO RPC PROXY — x402 + API key
    // ========================================================================

    {
      name: 'venice_crypto_networks',
      title: 'Venice Crypto RPC Networks',
      description: `List the live, authoritative network slugs accepted by venice_crypto_rpc.${NO_AUTH}`,
      inputSchema: {},
      handler: async () => {
        try {
          const resp = await client.get<{ networks?: string[] }>(
            '/v1/crypto/rpc/networks',
            undefined,
            { auth: 'none' },
          )
          const networks = resp.networks ?? []
          return ok(JSON.stringify(networks, null, 2), { networks, count: networks.length })
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_crypto_rpc',
      title: 'Venice Crypto RPC Proxy',
      description: `Proxy one JSON-RPC request or a batch of up to 100 requests to a supported blockchain network. Use venice_crypto_networks for the live network list. For a simple call, pass rpc_method/rpc_params; for complete request IDs or batches, pass request.${X402_OK}`,
      inputSchema: {
        network: z.string().min(1).describe('Network slug returned by venice_crypto_networks.'),
        request: z
          .union([cryptoRpcRequestSchema, z.array(cryptoRpcBatchRequestSchema).min(1).max(100)])
          .optional()
          .describe('A single JSON-RPC request object (ID optional) or a non-empty batch of at most 100 request objects (ID required per item).'),
        rpc_method: z.string().min(1).optional().describe('Convenience form for a single request. Do not combine with request.'),
        rpc_params: z.array(z.unknown()).optional().describe('Parameters for rpc_method.'),
      },
      handler: async (args) => {
        try {
          if (args.request !== undefined && args.rpc_method !== undefined) {
            return fail('Pass either request or rpc_method/rpc_params, not both.')
          }
          if (args.request === undefined && args.rpc_method === undefined) {
            return fail('Either request or rpc_method is required.')
          }
          if (args.request !== undefined && args.rpc_params !== undefined) {
            return fail('rpc_params can only be used with rpc_method.')
          }
          const body = args.request ?? {
            jsonrpc: '2.0' as const,
            method: args.rpc_method!,
            params: args.rpc_params ?? [],
            id: 1,
          }
          const resp = await client.post<unknown>(
            `/v1/crypto/rpc/${encodeURIComponent(args.network)}`,
            body,
          )
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.get<{ data?: unknown[]; models?: unknown[] }>('/v1/models')
          const all = resp.data ?? resp.models ?? []
          const filtered =
            type && type !== 'all'
              ? all.filter((m: unknown) => {
                  const obj = m as Record<string, unknown>
                  const t = String(obj.type ?? obj.modelType ?? '').toLowerCase()
                  return t.includes(type)
                })
              : all
          return ok(JSON.stringify(filtered.slice(0, 80), null, 2), {
            count: filtered.length,
            total: all.length,
          })
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.get<unknown>('/v1/image/styles')
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<unknown>('/v1/audio/quote', args)
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<unknown>('/v1/video/quote', args)
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
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
        tag: z.string().optional().describe('Legacy singular tag filter. Prefer tags for multiple values.'),
        tags: z.array(z.string().max(100)).max(20).optional(),
        categories: z.array(z.string().max(100)).max(20).optional(),
        isAdult: z.boolean().optional(),
        isPro: z.boolean().optional(),
        isWebEnabled: z.boolean().optional(),
        modelId: z.array(z.string().max(200)).max(20).optional(),
        sortBy: z
          .enum(['featured', 'highestRating', 'highlyRated', 'highlyRatedAndRecent', 'imports', 'mostRecent', 'ratingCount'])
          .optional(),
        sortOrder: z.enum(['asc', 'desc']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      handler: async (args) => {
        const authError = requireCharacterApiKey()
        if (authError) return authError
        try {
          const params = new URLSearchParams()
          if (args.search) params.set('search', args.search)
          if (args.tag) params.set('tag', args.tag)
          for (const tag of args.tags ?? []) params.append('tags', tag)
          for (const category of args.categories ?? []) params.append('categories', category)
          if (args.isAdult !== undefined) params.set('isAdult', String(args.isAdult))
          if (args.isPro !== undefined) params.set('isPro', String(args.isPro))
          if (args.isWebEnabled !== undefined) params.set('isWebEnabled', String(args.isWebEnabled))
          for (const modelId of args.modelId ?? []) params.append('modelId', modelId)
          if (args.sortBy) params.set('sortBy', args.sortBy)
          if (args.sortOrder) params.set('sortOrder', args.sortOrder)
          if (args.limit !== undefined) params.set('limit', String(args.limit))
          if (args.offset !== undefined) params.set('offset', String(args.offset))
          const qs = params.toString()
          const resp = await client.get<{ data?: unknown[]; characters?: unknown[] }>(
            `/v1/characters${qs ? `?${qs}` : ''}`,
            undefined,
            { auth: 'apiKey' },
          )
          const list = resp.data ?? resp.characters ?? []
          return ok(JSON.stringify(list, null, 2), { count: list.length })
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_get_character',
      title: 'Venice Get Character',
      description: `Get one public Venice character by slug.${API_KEY_ONLY}`,
      inputSchema: {
        slug: z.string().min(1).describe('Public character slug.'),
      },
      handler: async ({ slug }) => {
        const authError = requireCharacterApiKey()
        if (authError) return authError
        try {
          const resp = await client.get<unknown>(
            `/v1/characters/${encodeURIComponent(slug)}`,
            undefined,
            { auth: 'apiKey' },
          )
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_character_reviews',
      title: 'Venice Character Reviews',
      description: `List paginated public reviews for a Venice character.${API_KEY_ONLY}`,
      inputSchema: {
        slug: z.string().min(1).describe('Public character slug.'),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      },
      handler: async ({ slug, page, pageSize }) => {
        const authError = requireCharacterApiKey()
        if (authError) return authError
        try {
          const params = new URLSearchParams()
          if (page !== undefined) params.set('page', String(page))
          if (pageSize !== undefined) params.set('pageSize', String(pageSize))
          const qs = params.toString()
          const resp = await client.get<unknown>(
            `/v1/characters/${encodeURIComponent(slug)}/reviews${qs ? `?${qs}` : ''}`,
            undefined,
            { auth: 'apiKey' },
          )
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.post<{
            choices?: Array<{ message?: { content?: string } }>
            usage?: Record<string, number>
          }>('/v1/chat/completions', {
            model: args.model ?? cfg.defaultChatModel,
            messages: args.messages,
            temperature: args.temperature,
            max_tokens: args.max_tokens,
            venice_parameters: { character_slug: args.character_slug },
            stream: false,
          })
          const text = resp.choices?.[0]?.message?.content ?? ''
          return ok(truncate(text), { usage: resp.usage })
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    // ========================================================================
    // x402 wallet helpers — auth-free
    // ========================================================================

    {
      name: 'venice_x402_balance',
      title: 'Venice x402 Wallet Balance',
      description:
        `Check the prepaid x402 credit balance for a wallet address. SIWX-ONLY: this endpoint rejects API key auth and requires X-Sign-In-With-X (forwarded from VENICE_SIWX_TOKEN). The wallet in the path must match the SIWX-authenticated wallet.`,
      inputSchema: {
        wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      },
      handler: async ({ wallet_address }) => {
        try {
          const resp = await client.get<unknown>(
            `/v1/x402/balance/${encodeURIComponent(wallet_address.toLowerCase())}`,
            undefined,
            { auth: 'siwx' },
          )
          return ok(JSON.stringify(resp, null, 2), { balance: resp })
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_x402_top_up_info',
      title: 'Venice x402 Top-up Requirements',
      description:
        `Fetch step-1 top-up requirements for a wallet. The API accepts an empty POST; the address is validated locally for the caller's intended wallet. Signing and payment-header submission happen OUTSIDE this MCP server.`,
      inputSchema: {
        wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      },
      handler: async () => {
        try {
          await client.post('/v1/x402/top-up', {}, undefined, { auth: 'none' })
          return ok('Unexpected non-402 response. Top-up may already be processed.')
        } catch (err) {
          if (err instanceof Error && (err as { status?: number }).status === 402) {
            return ok(formatToolError(err))
          }
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_x402_transactions',
      title: 'Venice x402 Transaction History',
      description: `List recent x402 top-up + debit transactions for a wallet. SIWX-ONLY: rejects API key, requires X-Sign-In-With-X (VENICE_SIWX_TOKEN). The wallet in the path must match the SIWX-authenticated wallet.`,
      inputSchema: {
        wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        limit: z.number().int().min(1).max(100).optional(),
      },
      handler: async ({ wallet_address, limit }) => {
        try {
          const qs = limit ? `?limit=${limit}` : ''
          const resp = await client.get<unknown>(
            `/v1/x402/transactions/${encodeURIComponent(wallet_address.toLowerCase())}${qs}`,
            undefined,
            { auth: 'siwx' },
          )
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },
  ]

  return tools
}
