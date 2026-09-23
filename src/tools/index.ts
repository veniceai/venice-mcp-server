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
 *      - image/styles
 *      - audio/quote, video/quote
 *      - x402/balance, x402/top-up, x402/transactions
 *      - tee/attestation, tee/signature
 */
import { z } from 'zod'
import type { VeniceClient } from '../venice-client.js'
import { VeniceResponseTooLargeError } from '../venice-client.js'
import type { Config } from '../config.js'
import { VeniceUpstreamError } from '../types.js'
import { formatToolError, truncate } from '../format.js'
import { fetchUploadSource } from './remote-fetch.js'
import { MediaStore, type MediaKind } from '../media/store.js'
import { readLocalUploadSource, resolveMediaInput, resolveMediaInputs } from '../media/inputs.js'
import type { Toolset } from '../config.js'

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
type EmbeddedResourceContent = {
  type: 'resource'
  resource: {
    uri: string
    mimeType?: string
    blob: string
  }
}
type ToolContent = TextContent | ImageContent | AudioContent | ResourceLinkContent | EmbeddedResourceContent

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

const TOOL_PREFIX_TOOLSET: Array<[prefix: string, toolset: Toolset]> = [
  ['venice_chat', 'chat'],
  ['venice_responses', 'chat'],
  ['venice_embeddings', 'chat'],
  ['venice_list_characters', 'chat'],
  ['venice_image_styles', 'catalog'],
  ['venice_image_', 'image'],
  ['venice_video_quote', 'catalog'],
  ['venice_video_transcriptions', 'augment'],
  ['venice_video_', 'video'],
  ['venice_audio_quote', 'catalog'],
  ['venice_tts', 'audio'],
  ['venice_asr', 'audio'],
  ['venice_voice_clone', 'audio'],
  ['venice_music_', 'music'],
  ['venice_web_', 'augment'],
  ['venice_text_parser', 'augment'],
  ['venice_list_models', 'catalog'],
  ['venice_crypto_', 'crypto'],
  ['venice_x402_', 'x402'],
]

export function toolsetFor(name: string): Toolset {
  const match = TOOL_PREFIX_TOOLSET.find(([prefix]) => name.startsWith(prefix))
  if (!match) throw new Error(`No toolset mapping for tool ${name}`)
  return match[1]
}

interface MediaResultInput {
  kind: MediaKind
  buffer: Buffer
  mimeType: string
  label?: string
  metadata: Record<string, unknown>
  /** Inline content returned when no media dir is configured. */
  inline: () => ToolContent
  /** Small preview attached alongside the file link (images only). */
  preview?: ToolContent
  /**
   * Runs once the bytes are safely on disk (or buffered, when no store is
   * configured). Used for server-side cleanup that must not precede persistence.
   */
  afterSave?: () => Promise<{ deleted: boolean; cleanupNote: string }>
  extraText?: string
  structured?: Record<string, unknown>
}

/**
 * Either persist the media to VENICE_MEDIA_DIR and return a file link, or
 * fall back to the tool's inline representation.
 */
async function mediaResult(store: MediaStore | undefined, input: MediaResultInput): Promise<ToolResult> {
  if (!store) {
    const after = input.afterSave ? await input.afterSave() : undefined
    const note = `${input.extraText ?? ''}${after?.cleanupNote ?? ''}`.trim()
    return {
      content: [
        input.inline(),
        ...(note ? [{ type: 'text' as const, text: note }] : []),
      ],
      structuredContent: {
        ...input.structured,
        mime_type: input.mimeType,
        byte_length: input.buffer.length,
        ...(after ? { server_media_deleted: after.deleted } : {}),
      },
    }
  }
  const saved = await store.save({
    kind: input.kind,
    buffer: input.buffer,
    mimeType: input.mimeType,
    label: input.label,
    metadata: input.metadata,
  })
  const after = input.afterSave ? await input.afterSave() : undefined
  const note = `${input.extraText ? ` ${input.extraText}` : ''}${after?.cleanupNote ?? ''}`
  return {
    content: [
      { type: 'resource_link', uri: saved.fileUrl, name: `${input.kind}-file`, mimeType: saved.mimeType },
      ...(input.preview ? [input.preview] : []),
      { type: 'text', text: `Saved ${input.kind} to ${saved.path} (${saved.bytes} bytes, ${saved.mimeType}). Metadata: ${saved.sidecarPath}.${note}` },
    ],
    structuredContent: {
      ...input.structured,
      path: saved.path,
      file_url: saved.fileUrl,
      sidecar_path: saved.sidecarPath,
      mime_type: saved.mimeType,
      byte_length: saved.bytes,
      representation: 'local file',
      ...(after ? { server_media_deleted: after.deleted } : {}),
    },
  }
}

/** Download a completed-media URL that Venice handed back (download_url flow). */
async function downloadVeniceUrl(url: string, maxBytes: number): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download of completed media failed: HTTP ${res.status} from ${url}`)
  const contentType = res.headers.get('content-type')?.split(';', 1)[0].trim() || 'video/mp4'
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new VeniceResponseTooLargeError(url, maxBytes)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > maxBytes) throw new VeniceResponseTooLargeError(url, maxBytes)
  return { buffer, contentType }
}

const PREVIEW_MAX_BYTES = 256 * 1024

/** Attach a small inline image next to the file link so the host can see the result. */
function imagePreview(buffer: Buffer, mimeType: string): ToolContent | undefined {
  if (buffer.length > PREVIEW_MAX_BYTES) return undefined
  return { type: 'image', data: buffer.toString('base64'), mimeType }
}

interface PollOptions {
  timeoutMs: number
  initialDelayMs: number
  maxDelayMs: number
  sleep: (ms: number) => Promise<void>
}

/**
 * Poll `attempt` until it returns a non-PROCESSING result or the deadline
 * passes. Elapsed time counts both request time and the sleeps we scheduled,
 * so an injected no-op `sleep` still honours the timeout.
 */
async function pollUntilDone(
  attempt: () => Promise<ToolResult>,
  opts: PollOptions,
): Promise<{ result: ToolResult; timedOut: boolean; elapsedMs: number }> {
  const start = Date.now()
  let sleptMs = 0
  let delay = opts.initialDelayMs
  const elapsed = () => Math.max(Date.now() - start, sleptMs)
  for (;;) {
    const result = await attempt()
    const status = (result.structuredContent as { status?: string } | undefined)?.status
    if (result.isError || status !== 'PROCESSING') {
      return { result, timedOut: false, elapsedMs: elapsed() }
    }
    if (elapsed() + delay > opts.timeoutMs) {
      return { result, timedOut: true, elapsedMs: elapsed() }
    }
    await opts.sleep(delay)
    sleptMs += delay
    delay = Math.min(Math.round(delay * 1.5), opts.maxDelayMs)
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const ok = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
})
const fail = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
  ...(structured ? { structuredContent: structured } : {}),
})

const QUEUE_DOWNLOAD_URL_TTL_MS = 24 * 60 * 60 * 1000
const QUEUE_DOWNLOAD_URL_MAX_ENTRIES = 1000
const queueDownloadUrls = new Map<string, { url: string; expiresAt: number }>()

function pruneQueueDownloadUrls(now = Date.now()): void {
  for (const [queueId, entry] of queueDownloadUrls) {
    if (entry.expiresAt <= now) queueDownloadUrls.delete(queueId)
  }
}

function rememberQueueDownloadUrl(queueId: string, url: string | undefined): void {
  const trusted = trustedQueueDownloadUrl(url)
  if (!trusted) return
  pruneQueueDownloadUrls()
  // Map iteration is insertion-ordered, so the oldest surviving entry is dropped first.
  while (queueDownloadUrls.size >= QUEUE_DOWNLOAD_URL_MAX_ENTRIES) {
    const oldest = queueDownloadUrls.keys().next()
    if (oldest.done) break
    queueDownloadUrls.delete(oldest.value)
  }
  queueDownloadUrls.set(queueId, { url: trusted, expiresAt: Date.now() + QUEUE_DOWNLOAD_URL_TTL_MS })
}

function rememberedQueueDownloadUrl(queueId: string): string | undefined {
  pruneQueueDownloadUrls()
  return queueDownloadUrls.get(queueId)?.url
}

/**
 * Generation parameters remembered per queue id so the completed file's
 * sidecar can record what produced it. Same bounds as the download URL cache.
 */
interface QueueRequestRecord {
  tool: string
  model: string
  prompt: string
  params: Record<string, unknown>
  estimated_cost_usd?: number
  queued_at: string
}
const queueRequests = new Map<string, { record: QueueRequestRecord; expiresAt: number }>()

function rememberQueueRequest(queueId: string, record: Omit<QueueRequestRecord, 'queued_at'>): void {
  const now = Date.now()
  for (const [id, entry] of queueRequests) {
    if (entry.expiresAt <= now) queueRequests.delete(id)
  }
  while (queueRequests.size >= QUEUE_DOWNLOAD_URL_MAX_ENTRIES) {
    const oldest = queueRequests.keys().next()
    if (oldest.done) break
    queueRequests.delete(oldest.value)
  }
  queueRequests.set(queueId, {
    record: { ...record, queued_at: new Date(now).toISOString() },
    expiresAt: now + QUEUE_DOWNLOAD_URL_TTL_MS,
  })
}

function rememberedQueueRequest(queueId: string): QueueRequestRecord | undefined {
  const entry = queueRequests.get(queueId)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    queueRequests.delete(queueId)
    return undefined
  }
  return entry.record
}

/** Replace inline media payloads (data URLs) with placeholders before persisting params to a sidecar. */
function sanitizeParams(args: Record<string, unknown>): Record<string, unknown> {
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') return value.startsWith('data:') ? `<data url, ${value.length} chars>` : value
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, clean(v)]),
      )
    }
    return value
  }
  return clean(args) as Record<string, unknown>
}

function quoteValue(resp: unknown): number | undefined {
  const quote = (resp as { quote?: unknown } | undefined)?.quote
  return typeof quote === 'number' && Number.isFinite(quote) ? quote : undefined
}

/** Best-effort pre-queue estimate. Quote failures never block generation. */
async function estimateVideoCost(client: VeniceClient, body: Record<string, unknown>): Promise<number | undefined> {
  try {
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
    return quoteValue(await client.post<unknown>('/v1/video/quote', clean))
  } catch {
    return undefined
  }
}

async function estimateMusicCost(client: VeniceClient, body: Record<string, unknown>): Promise<number | undefined> {
  try {
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
    return quoteValue(await client.post<unknown>('/v1/audio/quote', clean))
  } catch {
    return undefined
  }
}

/** Caller-supplied queue URLs must be Venice HTTPS hosts. Retrieve URLs come from Venice and are not re-checked here. */
function trustedQueueDownloadUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:') return undefined
    if (host === 'venice.ai' || host.endsWith('.venice.ai')) return parsed.href
  } catch {
    return undefined
  }
  return undefined
}

function decodeEnhancedPrompt(headers: Record<string, string>): string | undefined {
  const encoded = headers['x-venice-enhanced-prompt']
  if (!encoded) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

interface NeedsConsentBody {
  error?: { code?: string; message?: string }
  consent_flow?: string
  face_media_roles?: string[]
  consent?: { consent_version?: string; policy_text?: string }
  docs_url?: string
}

function needsConsentDetails(err: unknown): NeedsConsentBody | undefined {
  if (!(err instanceof VeniceUpstreamError) || err.status !== 409) return undefined
  const body = err.body as NeedsConsentBody
  return body?.error?.code === 'needs_consent' ? body : undefined
}

const X402_OK = ' Supports x402 wallet auth (no Venice account needed) and API key.'
const API_KEY_ONLY = ' API key required — this endpoint does not accept x402 wallet auth.'
const NO_AUTH = ' No authentication required.'

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

export interface BuildToolsOptions {
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

export function buildTools(client: VeniceClient, cfg: Config, opts: BuildToolsOptions = {}): ToolDef[] {
  const nsfwNote = cfg.enableNsfw ? ' Uncensored: NSFW prompts allowed where the model permits.' : ''
  const store = cfg.mediaDir ? new MediaStore(cfg.mediaDir) : undefined
  const sleep = opts.sleep ?? defaultSleep
  const localInput = (label: string) => ({ label, maxBytes: cfg.maxLocalInputBytes })
  const mediaDirNote = store
    ? ` Output is saved under ${store.rootDir} and returned as a file:// link with a JSON sidecar; import that path into your editor.`
    : ''
  const localPathNote = ' Local absolute file paths are accepted anywhere a URL is (they are inlined as data: URLs).'

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
      description: `Generate an image. Supports Flux 2 Pro/Max, Lustify SDXL, Anime (WAI), Qwen Image, GPT Image, Nano Banana Pro and others.${nsfwNote}${X402_OK}${mediaDirNote}`,
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
        quality: z.enum(['low', 'medium', 'high']).optional().describe('Model-specific quality tier; may change pricing.'),
        enhance_prompt: z.boolean().optional().describe('Rewrite the prompt before generation. Adds up to ~30 seconds and a charge when applied.'),
        style_references: z.array(z.object({
          image: z.string().min(1).describe('Style image URL, data URI, or raw base64 (under 8MB).'),
          strength: z.number().min(0.1).max(1).optional(),
        }).strict()).optional().describe('Model-specific style references. Check the model maxStyleReferences capability.'),
        aspect_ratio: z.string().optional().describe('Model-specific aspect ratio such as "1:1" or "16:9"; the API validates supported values.'),
        resolution: z.string().optional().describe('Model-specific resolution tier such as "1K", "2K", or "4K"; the API validates supported values.'),
        enable_web_search: z.boolean().optional().describe('Allow supported models to use web search; additional credits may apply.'),
        disable_prompt_optimization_thinking: z.boolean().optional().describe('Skip prompt-optimization thinking on supported models.'),
        variants: z.number().int().min(1).max(4).optional().describe('Number of images. Only supported with non-binary responses.'),
        format: z.enum(['jpeg', 'png', 'webp']).optional(),
      },
      handler: async (args) => {
        try {
          const { data: resp, headers } = await client.postWithMetadata<{
            id?: string
            images?: string[] // base64 strings (default response shape)
            data?: Array<{ url?: string; b64_json?: string }>
          }>('/v1/image/generate', {
            ...args,
            model: args.model ?? cfg.defaultImageModel,
            safe_mode: args.safe_mode ?? false,
            return_binary: false,
          })
          const enhancedPrompt = decodeEnhancedPrompt(headers)
          // Default Venice response: { id, images: [<base64>, ...] }
          const images = resp.images?.filter((image): image is string =>
            typeof image === 'string' && image.length > 0
          ) ?? []
          if (images.length > 0) {
            if (store) {
              const model = args.model ?? cfg.defaultImageModel
              const params = sanitizeParams(args)
              const buffers = images.map((data) => Buffer.from(data, 'base64'))
              const saved = await Promise.all(buffers.map((buffer, index) => store.save({
                kind: 'image',
                buffer,
                mimeType: detectBase64ImageMime(images[index]),
                label: args.prompt,
                metadata: { tool: 'venice_image_generate', model, request_id: resp.id, enhanced_prompt: enhancedPrompt, params },
              })))
              const content: ToolContent[] = []
              saved.forEach((file, index) => {
                content.push({ type: 'resource_link', uri: file.fileUrl, name: `image-${index + 1}`, mimeType: file.mimeType })
                const preview = imagePreview(buffers[index], file.mimeType)
                if (preview) content.push(preview)
              })
              const lines = saved.map((file) => `Saved image to ${file.path} (${file.bytes} bytes). Metadata: ${file.sidecarPath}`)
              if (enhancedPrompt) lines.push(`Enhanced prompt: ${enhancedPrompt}`)
              content.push({ type: 'text', text: lines.join('\n') })
              return {
                content,
                structuredContent: {
                  id: resp.id,
                  count: saved.length,
                  enhanced_prompt: enhancedPrompt,
                  representation: 'local file',
                  files: saved.map((file) => ({ path: file.path, sidecar_path: file.sidecarPath, mime_type: file.mimeType, byte_length: file.bytes })),
                },
              }
            }
            const content: ToolContent[] = images.map((data) => ({
              type: 'image',
              data,
              mimeType: detectBase64ImageMime(data),
            }))
            if (enhancedPrompt) content.push({ type: 'text', text: `Enhanced prompt: ${enhancedPrompt}` })
            return {
              content,
              structuredContent: { id: resp.id, count: images.length, enhanced_prompt: enhancedPrompt },
            }
          }
          // OpenAI-compat shape (rare): { data: [{ b64_json | url }] }
          const dataContent: ToolContent[] = []
          for (const [index, item] of (resp.data ?? []).entries()) {
            if (item.url) {
              dataContent.push({
                type: 'resource_link',
                uri: item.url,
                name: `image-${index + 1}`,
                mimeType: 'image/png',
              })
            } else if (item.b64_json) {
              dataContent.push({
                type: 'image',
                data: item.b64_json,
                mimeType: detectBase64ImageMime(item.b64_json),
              })
            }
          }
          if (dataContent.length > 0) {
            if (enhancedPrompt) dataContent.push({ type: 'text', text: `Enhanced prompt: ${enhancedPrompt}` })
            return {
              content: dataContent,
              structuredContent: {
                count: dataContent.length - (enhancedPrompt ? 1 : 0),
                enhanced_prompt: enhancedPrompt,
              },
            }
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
      description: `Edit an image with a prompt.${X402_OK}${localPathNote}${mediaDirNote}`,
      inputSchema: {
        image_url: z.string().min(1).describe('URL, data URL, or local absolute path of the image to edit.'),
        prompt: z.string().min(1).max(32_000),
        model: z.string().optional().describe('Edit model id; defaults to firered-image-edit.'),
        aspect_ratio: z.string().optional().describe('Output aspect ratio, e.g. "1:1", "16:9", "9:16", "4:5". Supported values vary by model; the API validates.'),
        safe_mode: z.boolean().optional(),
        enhance_prompt: z.boolean().optional().describe('Rewrite the edit prompt with awareness of the input image. May add time and cost.'),
        resolution: z.string().optional().describe('Model-specific output resolution tier; the API validates supported values.'),
        output_format: z.enum(['jpeg', 'jpg', 'png', 'webp']).optional(),
        quality: z.enum(['low', 'medium', 'high']).optional().describe('Model-specific quality tier; may change pricing.'),
      },
      handler: async (args) => {
        try {
          const image = await resolveMediaInput(args.image_url, localInput('image_url'))
          const { buffer, contentType, headers } = await client.postBinary('/v1/image/edit', {
            method: 'POST',
            json: {
              image,
              prompt: args.prompt,
              model: args.model,
              aspect_ratio: args.aspect_ratio,
              safe_mode: args.safe_mode ?? false,
              enhance_prompt: args.enhance_prompt,
              resolution: args.resolution,
              output_format: args.output_format,
              quality: args.quality,
            },
          })
          const enhancedPrompt = decodeEnhancedPrompt(headers)
          return mediaResult(store, {
            kind: 'image',
            buffer,
            mimeType: contentType,
            label: args.prompt,
            metadata: { tool: 'venice_image_edit', model: args.model, enhanced_prompt: enhancedPrompt, params: sanitizeParams(args) },
            inline: () => ({ type: 'image', data: buffer.toString('base64'), mimeType: contentType }),
            preview: imagePreview(buffer, contentType),
            extraText: enhancedPrompt ? `Enhanced prompt: ${enhancedPrompt}` : undefined,
            structured: enhancedPrompt ? { enhanced_prompt: enhancedPrompt } : undefined,
          })
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_image_multi_edit',
      title: 'Venice Image Multi-Edit',
      description: `Edit multiple images together with a single prompt (multi-image composition / outpainting).${X402_OK}${localPathNote}${mediaDirNote}`,
      inputSchema: {
        image_urls: z.array(z.string().min(1)).min(1).max(8).describe('URLs, data URLs, or local absolute paths.'),
        prompt: z.string().min(1).max(32_000),
        model: z.string().optional(),
        aspect_ratio: z.string().optional().describe('Output aspect ratio, e.g. "1:1", "16:9", "9:16", "4:5". Supported values vary by model; the API validates.'),
        enhance_prompt: z.boolean().optional().describe('Rewrite the edit prompt with awareness of the input images. May add time and cost.'),
        resolution: z.string().optional().describe('Model-specific output resolution tier; the API validates supported values.'),
        output_format: z.enum(['jpeg', 'jpg', 'png', 'webp']).optional(),
        quality: z.enum(['low', 'medium', 'high']).optional().describe('Model-specific quality tier; may change pricing.'),
      },
      handler: async (args) => {
        try {
          // Multi-edit accepts multipart 'images' files or JSON 'images' array of base64/URL strings.
          // We send JSON with URL strings for simplicity.
          const images = await resolveMediaInputs(args.image_urls, localInput('image_urls'))
          const { buffer, contentType, headers } = await client.postBinary('/v1/image/multi-edit', {
            method: 'POST',
            json: {
              images,
              prompt: args.prompt,
              model: args.model,
              aspect_ratio: args.aspect_ratio,
              enhance_prompt: args.enhance_prompt,
              resolution: args.resolution,
              output_format: args.output_format,
              quality: args.quality,
            },
          })
          const enhancedPrompt = decodeEnhancedPrompt(headers)
          return mediaResult(store, {
            kind: 'image',
            buffer,
            mimeType: contentType,
            label: args.prompt,
            metadata: { tool: 'venice_image_multi_edit', model: args.model, enhanced_prompt: enhancedPrompt, params: sanitizeParams(args) },
            inline: () => ({ type: 'image', data: buffer.toString('base64'), mimeType: contentType }),
            preview: imagePreview(buffer, contentType),
            extraText: enhancedPrompt ? `Enhanced prompt: ${enhancedPrompt}` : undefined,
            structured: enhancedPrompt ? { enhanced_prompt: enhancedPrompt } : undefined,
          })
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_image_upscale',
      title: 'Venice Image Upscale',
      description: `Upscale an image (2-4× scale). The image is uploaded as multipart form data.${X402_OK}${localPathNote}${mediaDirNote}`,
      inputSchema: {
        image_url: z.string().min(1).describe('URL, data URL, or local absolute path.'),
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
          const source =
            (await readLocalUploadSource(args.image_url, localInput('image_url'))) ??
            (await fetchUploadSource(args.image_url, {
              label: 'image_url',
              fallbackContentType: 'image/png',
              fallbackFilename: 'image.png',
              timeoutMs: cfg.timeoutMs,
              allowedContentTypes: ['image/'],
            }))
          const form = new FormData()
          form.set('image', new Blob([source.buffer], { type: source.contentType }), source.filename)
          if (args.scale !== undefined) form.set('scale', String(args.scale))
          if (args.creativity !== undefined) form.set('creativity', String(args.creativity))
          const { buffer, contentType } = await client.postBinary('/v1/image/upscale', { form })
          return mediaResult(store, {
            kind: 'image',
            buffer,
            mimeType: contentType,
            label: `upscale-${source.filename}`,
            metadata: { tool: 'venice_image_upscale', params: sanitizeParams(args) },
            inline: () => ({ type: 'image', data: buffer.toString('base64'), mimeType: contentType }),
            preview: imagePreview(buffer, contentType),
          })
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_image_remove_bg',
      title: 'Venice Image Background Remove',
      description: `Remove image background; returns a transparent PNG.${X402_OK}${localPathNote}${mediaDirNote}`,
      inputSchema: { image_url: z.string().min(1).describe('URL, data URL, or local absolute path.') },
      handler: async (args) => {
        try {
          const image_url = await resolveMediaInput(args.image_url, localInput('image_url'))
          const { buffer, contentType } = await client.postBinary('/v1/image/background-remove', {
            method: 'POST',
            json: { image_url },
          })
          return mediaResult(store, {
            kind: 'image',
            buffer,
            mimeType: contentType,
            label: 'background-removed',
            metadata: { tool: 'venice_image_remove_bg', params: sanitizeParams(args) },
            inline: () => ({ type: 'image', data: buffer.toString('base64'), mimeType: contentType }),
            preview: imagePreview(buffer, contentType),
          })
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
      description: `Queue a video generation. Supports Sora 2, Veo 3.1, Kling, Wan, LTX 2, Seedance, Runway Gen-4, and others. Pick a specific id like "veo3.1-fast-text-to-video", "veo3.1-fast-image-to-video", "kling-2.6-pro-text-to-video", "wan-2.6-text-to-video", "seedance-2-0-r2v" etc.${nsfwNote}${X402_OK} Returns { model, queue_id, estimated_cost_usd }; poll with venice_video_status or block with venice_video_wait. NOTE: 'duration' is a string enum like '4s' / '6s' / '8s' (model-specific, see model card).${localPathNote} Current public Seedance models may reject detectable persons outright. Consent flags are defensive compatibility support, not a policy bypass; set them only after showing a returned policy to the user and receiving explicit confirmation.`,
      inputSchema: {
        prompt: z.string().min(1).max(4096),
        model: z.string().describe('Required. Full model id, e.g. "veo3.1-fast-text-to-video".'),
        duration: z.string().optional().describe('Duration as model-specific string enum, e.g. "4s", "6s", "8s". See GET /v1/models/:id/card.'),
        aspect_ratio: z.string().optional().describe('Output aspect ratio, e.g. "16:9", "9:16", "1:1", "4:5", "9:21". Model-specific; see GET /v1/models/:id/card.'),
        seed: z.number().int().optional(),
        image_url: z.string().min(1).optional().describe('For image-to-video models: starting frame. URL, data URL, or local absolute path.'),
        end_image_url: z.string().min(1).optional().describe('For models that support end frames or transitions. URL, data URL, or local path.'),
        video_url: z.string().min(1).optional().describe('For video-to-video models (e.g. seedance-2-0-r2v): input video. URL, data URL, or local path. Supported: MP4, MOV, WebM.'),
        audio_url: z.string().min(1).optional().describe('For models that support audio input: background music. URL, data URL, or local path. Supported: WAV, MP3. Max 30s, 15MB.'),
        reference_image_urls: z.array(z.string().min(1)).max(9).optional().describe('For models with reference image support: up to 9 images for character/style consistency. Each a URL, data URL, or local path.'),
        reference_video_urls: z.array(z.string().min(1)).max(3).optional().describe('For Seedance 2.0 R2V and similar: up to 3 reference video clips to inherit subject motion, camera movement, and style. Per-clip 2–15s, MP4/MOV, ≤50MB; aggregate ≤15s. Each a URL, data URL, or local path.'),
        reference_audio_urls: z.array(z.string().min(1)).max(3).optional().describe('For Seedance 2.0 R2V and similar: up to 3 reference audio clips for vocal timbre, narration, or sound effects. Per-clip 2–15s, WAV/MP3; aggregate ≤15s. Must be paired with at least one reference image or video. Each a URL, data URL, or local path.'),
        elements: z.array(z.object({
          frontal_image_url: z.string().min(1).optional(),
          reference_image_urls: z.array(z.string().min(1)).max(3).optional(),
          video_url: z.string().min(1).optional(),
        })).max(4).optional().describe('For Kling O3 R2V and similar: up to 4 character/object elements. Reference in prompt as @Element1, @Element2, etc. URLs, data URLs, or local paths.'),
        scene_image_urls: z.array(z.string().min(1)).max(4).optional().describe('For models with advanced element support: up to 4 scene reference images. Reference in prompt as @Image1, @Image2, etc. URLs, data URLs, or local paths.'),
        negative_prompt: z.string().max(4096).optional().describe('Negative prompt (what to avoid). Supported by Seedance and other models.'),
        resolution: z.string().optional().describe('Output resolution, e.g. "720p", "1080p", "4k". Model-specific; see model card.'),
        upscale_factor: z.number().int().optional().describe('For upscale models only: 1 = quality enhance, 2 = double resolution, 4 = quadruple.'),
        audio: z.boolean().optional().describe('Enable or disable audio generation for models that support it. Defaults to true.'),
        consents: z.object({
          seedance: z.object({
            confirmed_terms_and_privacy: z.literal(true).describe('Set true only after the user confirms the returned policy text and Venice terms/privacy.'),
            confirmed_legal_right: z.literal(true).describe('Set true only after the user confirms legal rights/consent for every depicted person and all submitted media.'),
            confirmed_screening_acknowledged: z.literal(true).describe('Set true only after the user acknowledges automated media screening.'),
          }).strict(),
        }).strict().optional().describe('Defensive compatibility support for a returned Seedance needs_consent flow. Current public models may reject detectable persons outright. All three flags must be true after explicit user confirmation and cannot bypass content policy.'),
      },
      handler: async (args) => {
        try {
          const body = {
            ...args,
            image_url: args.image_url && (await resolveMediaInput(args.image_url, localInput('image_url'))),
            end_image_url: args.end_image_url && (await resolveMediaInput(args.end_image_url, localInput('end_image_url'))),
            video_url: args.video_url && (await resolveMediaInput(args.video_url, localInput('video_url'))),
            audio_url: args.audio_url && (await resolveMediaInput(args.audio_url, localInput('audio_url'))),
            reference_image_urls: await resolveMediaInputs(args.reference_image_urls, localInput('reference_image_urls')),
            reference_video_urls: await resolveMediaInputs(args.reference_video_urls, localInput('reference_video_urls')),
            reference_audio_urls: await resolveMediaInputs(args.reference_audio_urls, localInput('reference_audio_urls')),
            scene_image_urls: await resolveMediaInputs(args.scene_image_urls, localInput('scene_image_urls')),
            elements: args.elements && (await Promise.all(args.elements.map(async (el: NonNullable<typeof args.elements>[number], i: number) => ({
              frontal_image_url: el.frontal_image_url && (await resolveMediaInput(el.frontal_image_url, localInput(`elements[${i}].frontal_image_url`))),
              reference_image_urls: await resolveMediaInputs(el.reference_image_urls, localInput(`elements[${i}].reference_image_urls`)),
              video_url: el.video_url && (await resolveMediaInput(el.video_url, localInput(`elements[${i}].video_url`))),
            })))),
          }
          const estimatedCost = await estimateVideoCost(client, {
            model: args.model,
            duration: args.duration,
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            upscale_factor: args.upscale_factor,
            audio: args.audio,
            video_url: body.video_url,
            reference_image_count: args.reference_image_urls?.length,
          })
          const resp = await client.post<{ model?: string; queue_id?: string; download_url?: string }>(
            '/v1/video/queue',
            body
          )
          const id = resp.queue_id
          if (!id) return fail('No queue_id returned by Venice.')
          rememberQueueDownloadUrl(id, resp.download_url)
          rememberQueueRequest(id, { tool: 'venice_video_generate', model: resp.model ?? args.model, prompt: args.prompt, params: sanitizeParams(args), estimated_cost_usd: estimatedCost })
          const costNote = estimatedCost !== undefined ? ` Estimated cost: $${estimatedCost.toFixed(4)} USD.` : ''
          return ok(
            `Queued: queue_id=${id}, model=${resp.model}.${costNote}\n` +
              'Block until done with venice_video_wait, or poll with venice_video_status using queue_id and model. This process remembers download_url; pass it from structuredContent only if another process will poll. Do not invent a download_url.',
            { queue_id: id, model: resp.model, download_url: resp.download_url, estimated_cost_usd: estimatedCost }
          )
        } catch (err) {
          const consent = needsConsentDetails(err)
          if (consent) {
            const roles = consent.face_media_roles?.join(', ') || 'submitted face media'
            const policy = consent.consent?.policy_text || 'Venice did not return policy text.'
            const docs = consent.docs_url ? `\nPolicy guide: ${consent.docs_url}` : ''
            return fail(
              `Seedance consent is required for: ${roles}.\n\nPolicy text:\n${policy}\n\n` +
                'Next step: show this policy to the user. Only after the user explicitly confirms every attestation, resubmit the same request with consents.seedance.confirmed_terms_and_privacy, confirmed_legal_right, and confirmed_screening_acknowledged all set to true.' +
                docs,
              {
                status: 'needs_consent',
                consent_flow: consent.consent_flow,
                face_media_roles: consent.face_media_roles,
                consent_version: consent.consent?.consent_version,
                policy_text: consent.consent?.policy_text,
                docs_url: consent.docs_url,
                next_step: 'Obtain explicit user confirmation, then resubmit the same request with all three consents.seedance flags set to true.',
              },
            )
          }
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_video_status',
      title: 'Venice Video Retrieve / Status',
      description: `Check status of a queued video job. Returns JSON progress while PROCESSING. Completed jobs are either an embedded base64 video/mp4 MCP resource or a download_url resource link. For VPS / Grok Imagine Private models, retrieve returns COMPLETED JSON without a URL: this process reuses the queue-time download_url when venice_video_generate ran here, or accepts a Venice-host download_url argument. POST endpoint with body {model, queue_id}.${X402_OK}${mediaDirNote}`,
      inputSchema: {
        queue_id: z.string().min(1).describe('Returned by venice_video_generate.'),
        model: z.string().min(1).describe('Same model id used to queue.'),
        download_url: z.string().url().optional().describe(
          'Queue-time download_url from venice_video_generate. Must be an https Venice host. Needed for VPS / Grok Imagine Private only when this process did not queue the job (retrieve returns COMPLETED without a URL).',
        ),
        delete_media_on_completion: z.boolean().optional(),
      },
      handler: async (args) => {
        try {
          const { download_url: queueDownloadUrl, ...retrieveArgs } = args
          const response = await client.postMixed<{
            status?: 'PROCESSING' | 'COMPLETED'
            download_url?: string
            url?: string
            average_execution_time?: number
            execution_duration?: number
          }>('/v1/video/retrieve', {
            ...retrieveArgs,
            // Defer deletion until the result is safely captured. This keeps an
            // oversized binary response retryable after increasing the configured limit.
            delete_media_on_completion: false,
          }, { maxBytes: cfg.maxVideoResponseBytes })
          const cleanupAfterSuccess = async (successNote: string) => {
            if (!args.delete_media_on_completion) {
              return { deleted: false, cleanupNote: '' }
            }
            try {
              await client.post('/v1/video/complete', {
                queue_id: args.queue_id,
                model: args.model,
              })
              return { deleted: true, cleanupNote: ` ${successNote}` }
            } catch (cleanupError) {
              return {
                deleted: false,
                cleanupNote: ` Retrieval succeeded, but server-side cleanup failed: ${formatToolError(cleanupError)}`,
              }
            }
          }
          const queued = rememberedQueueRequest(args.queue_id)
          const videoMetadata = (extra: Record<string, unknown>) => ({
            tool: 'venice_video_generate',
            model: queued?.model ?? args.model,
            queue_id: args.queue_id,
            prompt: queued?.prompt,
            params: queued?.params,
            estimated_cost_usd: queued?.estimated_cost_usd,
            queued_at: queued?.queued_at,
            ...extra,
          })
          if (response.kind === 'binary') {
            if (!response.contentType.toLowerCase().includes('video/mp4')) {
              return fail(`Venice returned unsupported video content type: ${response.contentType}`)
            }
            return mediaResult(store, {
              kind: 'video',
              buffer: response.buffer,
              mimeType: 'video/mp4',
              label: queued?.prompt ?? args.queue_id,
              metadata: videoMetadata({ delivery: 'stream' }),
              inline: () => ({
                type: 'resource',
                resource: {
                  uri: `venice://video/${encodeURIComponent(args.queue_id)}.mp4`,
                  mimeType: 'video/mp4',
                  blob: response.buffer.toString('base64'),
                },
              }),
              afterSave: () => cleanupAfterSuccess(
                store
                  ? 'Server-side media was deleted after the MP4 was written to disk.'
                  : 'Server-side media was deleted after the MP4 was buffered.',
              ),
              extraText: `Completed video (${response.buffer.length} bytes${store ? '' : ', embedded as base64 video/mp4'}).`,
              structured: {
                status: 'COMPLETED',
                queue_id: args.queue_id,
                representation: 'MCP embedded blob resource',
                estimated_cost_usd: queued?.estimated_cost_usd,
              },
            })
          }
          const resp = response.data
          const url =
            resp.download_url ??
            resp.url ??
            rememberedQueueDownloadUrl(args.queue_id) ??
            trustedQueueDownloadUrl(queueDownloadUrl)
          if (resp.status === 'COMPLETED') {
            if (!url) {
              return fail(
                'Video completed but Venice returned neither a video/mp4 body nor a download_url.',
                { status: 'COMPLETED' },
              )
            }
            if (store) {
              const downloaded = await downloadVeniceUrl(url, cfg.maxVideoResponseBytes)
              return mediaResult(store, {
                kind: 'video',
                buffer: downloaded.buffer,
                mimeType: downloaded.contentType,
                label: queued?.prompt ?? args.queue_id,
                metadata: videoMetadata({ delivery: 'download_url', download_url: url }),
                inline: () => ({ type: 'resource_link', uri: url, name: 'video', mimeType: 'video/mp4' }),
                afterSave: () => cleanupAfterSuccess('Server-side media was deleted after the download was written to disk.'),
                extraText: `Downloaded from ${url}.`,
                structured: {
                  status: 'COMPLETED',
                  queue_id: args.queue_id,
                  url,
                  estimated_cost_usd: queued?.estimated_cost_usd,
                },
              })
            }
            const { deleted, cleanupNote } = await cleanupAfterSuccess(
              'Server-side media was deleted after the download URL was captured.',
            )
            return {
              content: [
                { type: 'resource_link', uri: url, name: 'video', mimeType: 'video/mp4' },
                { type: 'text', text: `${url}${cleanupNote}` },
              ],
              structuredContent: {
                status: 'COMPLETED',
                url,
                representation: 'download_url resource link',
                server_media_deleted: deleted,
              },
            }
          }
          const eta = resp.average_execution_time ? `${Math.round(resp.average_execution_time / 1000)}s ETA` : ''
          const dur = resp.execution_duration ? `${Math.round(resp.execution_duration / 1000)}s elapsed` : ''
          return ok(`Status: ${resp.status ?? 'unknown'} ${dur} ${eta}`.trim(), {
            status: resp.status,
            queue_id: args.queue_id,
            average_execution_time: resp.average_execution_time,
            execution_duration: resp.execution_duration,
          })
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) {
            return fail(
              `Completed video exceeds the configured ${err.maxBytes}-byte MCP response limit. ` +
                'The queued media was not deleted. Raise VENICE_MAX_VIDEO_RESPONSE_BYTES, restart the server, and retry venice_video_status with the same queue_id; alternatively, create a new shorter/lower-resolution generation.',
              {
                status: 'COMPLETED',
                error: 'video_response_too_large',
                max_bytes: err.maxBytes,
                retry_safe: true,
                queue_id: args.queue_id,
              },
            )
          }
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_video_wait',
      title: 'Venice Video Wait (poll until done)',
      description: `Block until a queued video job completes, polling venice_video_status with backoff. Returns the same result as venice_video_status on completion. If timeout_seconds elapses first, returns status PROCESSING with the queue_id so you can call venice_video_wait or venice_video_status again; the job keeps running server-side.${X402_OK}${mediaDirNote}`,
      inputSchema: {
        queue_id: z.string().min(1).describe('Returned by venice_video_generate.'),
        model: z.string().min(1).describe('Same model id used to queue.'),
        download_url: z.string().url().optional().describe('Queue-time download_url, only needed when another process queued the job.'),
        delete_media_on_completion: z.boolean().optional(),
        timeout_seconds: z.number().int().min(5).max(1800).optional().describe('Maximum wall-clock wait. Defaults to 300.'),
      },
      handler: async (args) => {
        const { timeout_seconds, ...statusArgs } = args
        const status = toolByName('venice_video_status')
        const { result, timedOut, elapsedMs } = await pollUntilDone(
          () => status.handler(statusArgs as never),
          { timeoutMs: (timeout_seconds ?? 300) * 1000, initialDelayMs: 5_000, maxDelayMs: 30_000, sleep },
        )
        if (!timedOut) return result
        return ok(
          `Still PROCESSING after ${Math.round(elapsedMs / 1000)}s. The job continues server-side; call venice_video_wait or venice_video_status again with queue_id=${args.queue_id}, model=${args.model}.`,
          { ...result.structuredContent, status: 'PROCESSING', queue_id: args.queue_id, model: args.model, timed_out: true, waited_seconds: Math.round(elapsedMs / 1000) },
        )
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
      description: `Convert text to speech. Supports cloned voices + emotion tags ([whispers], [sarcastically], etc.).${X402_OK}${mediaDirNote}`,
      inputSchema: {
        input: z.string().min(1).max(4096).describe('Text to convert to speech (max 4096 chars).'),
        voice: z.string().optional().describe('Voice id; see venice://voices.'),
        model: z.string().optional(),
        speed: z.number().min(0.25).max(4).optional(),
        response_format: z.enum(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']).optional(),
      },
      handler: async (args) => {
        try {
          const model = args.model ?? cfg.defaultTtsModel
          const { buffer, contentType } = await client.postBinary('/v1/audio/speech', {
            method: 'POST',
            json: { ...args, model },
          })
          return mediaResult(store, {
            kind: 'speech',
            buffer,
            mimeType: contentType,
            label: args.input,
            metadata: { tool: 'venice_tts', model, params: sanitizeParams(args) },
            inline: () => ({ type: 'audio', data: buffer.toString('base64'), mimeType: contentType }),
          })
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
      description: `Queue music generation. Discover models with venice_list_models type=music (e.g. ace-step-15, elevenlabs-music, minimax-music-v2/v25/v26, stable-audio-25, mmaudio-v2-text-to-audio, elevenlabs-sound-effects-v2).${nsfwNote}${X402_OK} Returns { model, queue_id, estimated_cost_usd }; poll with venice_music_status or block with venice_music_wait.`,
      inputSchema: {
        prompt: z.string().min(1).max(4000),
        model: z.string().describe('Required. Music model id, e.g. "elevenlabs-music".'),
        duration_seconds: z.union([
          z.number().int().positive(),
          z.string().regex(/^\d+$/, 'Must be a numeric string'),
        ]).optional().describe('Optional duration in seconds as a positive integer or numeric string. Model-specific.'),
        force_instrumental: z.boolean().optional().describe('Only for models reporting supports_force_instrumental.'),
        lyrics_prompt: z.string().optional().describe('Lyrics/text for lyric-capable models. Length limits come from model metadata.'),
        lyrics_optimizer: z.boolean().optional().describe('Auto-generate lyrics. lyrics_prompt must be empty when enabled.'),
        loop: z.boolean().optional().describe('Create a seamless loop on models reporting supports_loop.'),
        voice: z.string().optional().describe('Model-supported voice id/name.'),
        language_code: z.string().optional().describe('ISO 639-1 language code on supported models.'),
        speed: z.number().min(0.25).max(4).optional().describe('Model-specific speed multiplier. Check model min_speed/max_speed.'),
      },
      handler: async (args) => {
        try {
          const durationSeconds =
            typeof args.duration_seconds === 'string' ? Number(args.duration_seconds) : args.duration_seconds
          const estimatedCost = await estimateMusicCost(client, {
            model: args.model,
            duration_seconds: durationSeconds,
            character_count: args.lyrics_prompt?.length,
          })
          const resp = await client.post<{ model?: string; queue_id?: string }>(
            '/v1/audio/queue',
            args
          )
          const id = resp.queue_id
          if (!id) return fail('No queue_id returned.')
          rememberQueueRequest(id, { tool: 'venice_music_generate', model: resp.model ?? args.model, prompt: args.prompt, params: sanitizeParams(args), estimated_cost_usd: estimatedCost })
          const costNote = estimatedCost !== undefined ? ` Estimated cost: $${estimatedCost.toFixed(4)} USD.` : ''
          return ok(
            `Queued: queue_id=${id}, model=${resp.model}.${costNote}\n` +
              `Block until done with venice_music_wait, or poll with venice_music_status({ queue_id: "${id}", model: "${resp.model}" })`,
            { queue_id: id, model: resp.model, estimated_cost_usd: estimatedCost }
          )
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_music_status',
      title: 'Venice Music Retrieve / Status',
      description: `Check status of a queued music job. Returns JSON progress while PROCESSING and completed audio as an embedded MCP blob resource. POST endpoint with body {model, queue_id}.${X402_OK}${mediaDirNote}`,
      inputSchema: {
        queue_id: z.string().min(1),
        model: z.string().min(1),
        delete_media_on_completion: z.boolean().optional(),
      },
      handler: async (args) => {
        try {
          const response = await client.postMixed<{
            status?: 'PROCESSING' | 'COMPLETED'
            download_url?: string
            url?: string
            average_execution_time?: number
            execution_duration?: number
          }>(
            '/v1/audio/retrieve',
            {
              ...args,
              // Keep the queued media until a supported response is safely buffered.
              // This makes an oversized response retryable with a higher limit.
              delete_media_on_completion: false,
            },
            { maxBytes: cfg.maxAudioResponseBytes },
          )
          const cleanupAfterSuccess = async (successNote: string) => {
            if (!args.delete_media_on_completion) {
              return { deleted: false, cleanupNote: '' }
            }
            try {
              const completion = await client.post<{ success?: boolean }>('/v1/audio/complete', {
                queue_id: args.queue_id,
                model: args.model,
              })
              if (completion.success !== true) {
                return {
                  deleted: false,
                  cleanupNote:
                    ' Retrieval succeeded, but server-side cleanup failed: Venice did not confirm success=true.',
                }
              }
              return { deleted: true, cleanupNote: ` ${successNote}` }
            } catch (cleanupError) {
              return {
                deleted: false,
                cleanupNote: ` Retrieval succeeded, but server-side cleanup failed: ${formatToolError(cleanupError)}`,
              }
            }
          }
          if (response.kind === 'binary') {
            const mimeType = response.contentType.split(';', 1)[0].trim().toLowerCase()
            if (!mimeType.startsWith('audio/') || mimeType.length === 'audio/'.length) {
              return fail(
                `Venice returned unsupported completed music content type: ${response.contentType || '(missing)'}. ` +
                  'Expected an audio/* response. The queued media was not deleted.',
                {
                  status: 'COMPLETED',
                  error: 'unsupported_audio_content_type',
                  content_type: response.contentType,
                  server_media_deleted: false,
                  queue_id: args.queue_id,
                },
              )
            }
            const queued = rememberedQueueRequest(args.queue_id)
            const durationHeader = Number(response.headers['x-venice-audio-duration'])
            return mediaResult(store, {
              kind: 'music',
              buffer: response.buffer,
              mimeType,
              label: queued?.prompt ?? args.queue_id,
              metadata: {
                tool: 'venice_music_generate',
                model: queued?.model ?? args.model,
                queue_id: args.queue_id,
                prompt: queued?.prompt,
                params: queued?.params,
                estimated_cost_usd: queued?.estimated_cost_usd,
                queued_at: queued?.queued_at,
                audio_format: response.headers['x-venice-audio-format'],
                duration_seconds: Number.isFinite(durationHeader) && durationHeader > 0 ? durationHeader : undefined,
              },
              inline: () => ({
                type: 'resource',
                resource: {
                  uri: `venice://music/${encodeURIComponent(args.queue_id)}`,
                  mimeType,
                  blob: response.buffer.toString('base64'),
                },
              }),
              afterSave: () => cleanupAfterSuccess(
                store
                  ? 'Server-side media was deleted after the audio was written to disk.'
                  : 'Server-side media was deleted after the audio was buffered.',
              ),
              extraText: `Completed music (${response.buffer.length} bytes${store ? '' : `, embedded as a base64 ${mimeType} resource`}).`,
              structured: {
                status: 'COMPLETED',
                queue_id: args.queue_id,
                representation: 'MCP embedded blob resource',
                estimated_cost_usd: queued?.estimated_cost_usd,
                duration_seconds: Number.isFinite(durationHeader) && durationHeader > 0 ? durationHeader : undefined,
              },
            })
          }
          const resp = response.data
          const url = resp.download_url ?? resp.url
          if (resp.status === 'COMPLETED' && url) {
            const { deleted, cleanupNote } = await cleanupAfterSuccess(
              'Server-side media was deleted after the download URL was captured.',
            )
            return {
              content: [
                { type: 'resource_link', uri: url, name: 'music', mimeType: 'audio/mpeg' },
                { type: 'text', text: `${url}${cleanupNote}` },
              ],
              structuredContent: {
                status: resp.status,
                url,
                representation: 'download_url resource link',
                server_media_deleted: deleted,
              },
            }
          }
          const eta = resp.average_execution_time ? `${Math.round(resp.average_execution_time / 1000)}s ETA` : ''
          const dur = resp.execution_duration ? `${Math.round(resp.execution_duration / 1000)}s elapsed` : ''
          return ok(`Status: ${resp.status ?? 'unknown'} ${dur} ${eta}`.trim(), {
            status: resp.status,
            queue_id: args.queue_id,
            average_execution_time: resp.average_execution_time,
            execution_duration: resp.execution_duration,
          })
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) {
            return fail(
              `Completed music exceeds the configured ${err.maxBytes}-byte MCP response limit. ` +
                'The queued media was not deleted. Raise VENICE_MAX_AUDIO_RESPONSE_BYTES, restart the server, and retry venice_music_status with the same queue_id; alternatively, create a new shorter generation.',
              {
                status: 'COMPLETED',
                error: 'audio_response_too_large',
                max_bytes: err.maxBytes,
                retry_safe: true,
                queue_id: args.queue_id,
                server_media_deleted: false,
              },
            )
          }
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_music_wait',
      title: 'Venice Music Wait (poll until done)',
      description: `Block until a queued music job completes, polling venice_music_status with backoff. Returns the same result as venice_music_status on completion. If timeout_seconds elapses first, returns status PROCESSING with the queue_id so you can call again; the job keeps running server-side.${X402_OK}${mediaDirNote}`,
      inputSchema: {
        queue_id: z.string().min(1),
        model: z.string().min(1),
        delete_media_on_completion: z.boolean().optional(),
        timeout_seconds: z.number().int().min(5).max(1800).optional().describe('Maximum wall-clock wait. Defaults to 300.'),
      },
      handler: async (args) => {
        const { timeout_seconds, ...statusArgs } = args
        const status = toolByName('venice_music_status')
        const { result, timedOut, elapsedMs } = await pollUntilDone(
          () => status.handler(statusArgs as never),
          { timeoutMs: (timeout_seconds ?? 300) * 1000, initialDelayMs: 5_000, maxDelayMs: 30_000, sleep },
        )
        if (!timedOut) return result
        return ok(
          `Still PROCESSING after ${Math.round(elapsedMs / 1000)}s. The job continues server-side; call venice_music_wait or venice_music_status again with queue_id=${args.queue_id}, model=${args.model}.`,
          { ...result.structuredContent, status: 'PROCESSING', queue_id: args.queue_id, model: args.model, timed_out: true, waited_seconds: Math.round(elapsedMs / 1000) },
        )
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
          const resp = await client.post<unknown>(
            `/v1/crypto/rpc/${encodeURIComponent(args.network)}`,
            { jsonrpc: '2.0', method: args.rpc_method, params: args.rpc_params ?? [], id: 1 }
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
          const path = type && type !== 'all'
            ? `/v1/models?type=${encodeURIComponent(type)}`
            : '/v1/models'
          const resp = await client.get<{ data?: unknown[]; models?: unknown[] }>(path)
          const all = resp.data ?? resp.models ?? []
          return ok(JSON.stringify(all, null, 2), {
            count: all.length,
            total: all.length,
            requested_type: type && type !== 'all' ? type : undefined,
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
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
      },
      handler: async (args) => {
        try {
          const params = new URLSearchParams()
          if (args.search) params.set('search', args.search)
          if (args.tag) params.set('tag', args.tag)
          if (args.limit !== undefined) params.set('limit', String(args.limit))
          if (args.offset !== undefined) params.set('offset', String(args.offset))
          const qs = params.toString()
          const resp = await client.get<{ data?: unknown[]; characters?: unknown[] }>(
            `/v1/characters${qs ? `?${qs}` : ''}`
          )
          const list = resp.data ?? resp.characters ?? []
          return ok(JSON.stringify(list, null, 2), { count: list.length })
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

  function toolByName(name: string): ToolDef {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`tool not registered: ${name}`)
    return tool
  }

  if (!cfg.toolsets) return tools
  return tools.filter((t) => cfg.toolsets!.has(toolsetFor(t.name)))
}
