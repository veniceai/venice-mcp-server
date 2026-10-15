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
 *      - api_keys/rate_limits (INFERENCE or ADMIN); rate_limits/log requires ADMIN
 *      - billing/* and api_keys list/get require an ADMIN key
 *      - support-bot
 *   🔓 Auth-free:
 *      - models, models/traits
 *      - crypto/rpc/networks
 *      - image/styles
 *      - audio/quote, video/quote
 *      - x402/top-up requirement discovery
 *      - tee/attestation, tee/signature
 *   👛 SIWX only:
 *      - x402/balance, x402/transactions
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { VeniceClient } from '../venice-client.js'
import { VeniceJsonResponseTooLargeError, VeniceResponseTooLargeError } from '../venice-client.js'
import type { Config } from '../config.js'
import { shapeTtsVoiceCatalog, VeniceUpstreamError, type ModelCatalogItem, type ModelCatalogResponse } from '../types.js'
import {
  ASR_TEXT_PAGE_CHARS,
  ASR_TIMESTAMP_DEFAULT_LIMIT,
  ASR_TIMESTAMP_MAX_LIMIT,
  boundAsrResult,
  fitJson,
  fitJsonList,
  formatToolError,
  truncate,
  type AsrUpstreamBody,
} from '../format.js'
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
  annotations?: ToolAnnotations
  inputSchema: S
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>
}

const ok = (text: string, structured?: Record<string, unknown>, extraText: string[] = []): ToolResult => ({
  content: [text, ...extraText].map((t) => ({ type: 'text', text: t })),
  ...(structured ? { structuredContent: structured } : {}),
})
const fail = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
  ...(structured ? { structuredContent: structured } : {}),
})

const AUDIO_EXTENSION_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
}

function audioMimeTypeFromUrl(url: string): string | undefined {
  try {
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase()
    return ext ? AUDIO_EXTENSION_MIME_TYPES[ext] : undefined
  } catch {
    return undefined
  }
}

/** Venice answers HTTP 200 with `{ success: false }` when storage deletion fails. */
function videoCleanupSucceeded(body: { success?: boolean } | null | undefined): boolean {
  return body?.success === true
}

const QUEUE_DOWNLOAD_URL_TTL_MS = 24 * 60 * 60 * 1000
const QUEUE_DOWNLOAD_URL_MAX_ENTRIES = 1000
/** Queue-time download URLs, scoped to one MCP session so another session cannot resolve them by queue_id. */
class QueueDownloadUrlStore {
  private readonly urls = new Map<string, { url: string; expiresAt: number }>()

  /** Venice-issued URLs are stored as returned; only caller-supplied URLs go through trustedQueueDownloadUrl. */
  remember(queueId: string, url: string | undefined): void {
    if (!url) return
    this.prune()
    // Map iteration is insertion-ordered, so the oldest surviving entry is dropped first.
    while (this.urls.size >= QUEUE_DOWNLOAD_URL_MAX_ENTRIES) {
      const oldest = this.urls.keys().next()
      if (oldest.done) break
      this.urls.delete(oldest.value)
    }
    this.urls.set(queueId, { url, expiresAt: Date.now() + QUEUE_DOWNLOAD_URL_TTL_MS })
  }

  get(queueId: string): string | undefined {
    this.prune()
    return this.urls.get(queueId)?.url
  }

  delete(queueId: string): void {
    this.urls.delete(queueId)
  }

  private prune(now = Date.now()): void {
    for (const [queueId, entry] of this.urls) {
      if (entry.expiresAt <= now) this.urls.delete(queueId)
    }
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

function imageResponseTooLarge(err: VeniceResponseTooLargeError): ToolResult {
  return fail(
    `Image response exceeds the configured ${err.maxBytes}-byte MCP response limit and was discarded. ` +
      'Venice may still charge for the generation. Retry with fewer variants, a lower resolution, or jpeg/webp output, or raise VENICE_MAX_IMAGE_RESPONSE_BYTES and restart the server.',
    { error: 'image_response_too_large', max_bytes: err.maxBytes, retry_safe: false },
  )
}

function audioResponseTooLarge(err: VeniceResponseTooLargeError): ToolResult {
  return fail(
    `Audio response exceeds the configured ${err.maxBytes}-byte MCP response limit and was discarded. ` +
      'Venice may still charge for the generation. Retry with shorter input or a compressed response_format such as mp3 or opus, or raise VENICE_MAX_AUDIO_RESPONSE_BYTES and restart the server.',
    { error: 'audio_response_too_large', max_bytes: err.maxBytes, retry_safe: false },
  )
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
const ADMIN_API_KEY_ONLY =
  ' ADMIN API key required — inference keys cannot call this endpoint. This endpoint does not accept x402 wallet auth.'
const NO_AUTH = ' No authentication required.'
const walletAddressSchema = z
  .string()
  .regex(
    /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/,
    'Must be an EVM (0x + 40 hex characters) or Solana base58 wallet address.',
  )
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must use YYYY-MM-DD format.')
  .refine(isCalendarDate, 'Must be a real calendar date.')
const utcTimestampSchema = z
  .string()
  .max(40)
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
    'Must be an ISO 8601 UTC timestamp with a Z suffix.',
  )
  // Date.parse rolls impossible days such as Feb 30 into the next month.
  .refine(
    (value) => isCalendarDate(value) && Number.isFinite(Date.parse(value)),
    'Must be a real calendar date and time.',
  )

function normalizeExpiresAt(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/)
  if (!match || !match[2] || match[2].length === 3) return value
  return `${match[1]}.${match[2].padEnd(3, '0').slice(0, 3)}Z`
}

function normalizeWalletAddress(address: string): string {
  return address.startsWith('0x') ? address.toLowerCase() : address
}

const TOP_UP_ACCEPT_FIELDS = ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds', 'extra'] as const

/** Keeps only the documented x402 requirement fields rather than reflecting the raw 402 body. */
function topUpRequirements(body: unknown): { x402Version: unknown; accepts: Record<string, unknown>[] } | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const { x402Version, accepts } = body as { x402Version?: unknown; accepts?: unknown }
  if (!Array.isArray(accepts)) return undefined
  return {
    x402Version,
    accepts: accepts
      .filter((option): option is Record<string, unknown> => typeof option === 'object' && option !== null)
      .map((option) =>
        Object.fromEntries(TOP_UP_ACCEPT_FIELDS.filter((field) => field in option).map((field) => [field, option[field]])),
      ),
  }
}

function redactSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretFields)
  if (typeof value !== 'object' || value === null) return value
  const redacted: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
    redacted[key] = ['apikey', 'signature', 'token', 'paymentsignature', 'authorization', 'secret', 'privatekey', 'password', 'key'].includes(normalizedKey)
      ? '[REDACTED]'
      : redactSecretFields(child)
  }
  return redacted
}

function safeJson(value: unknown): string {
  return JSON.stringify(redactSecretFields(value), null, 2)
}

const BILLING_USAGE_DEFAULT_PAGE_SIZE = 10
const BILLING_USAGE_MAX_RESPONSE_BYTES = 64 * 1024
const BILLING_USAGE_TOO_LARGE =
  'Billing usage page exceeds 64 KiB. No partial records or continuation cursor were returned. ' +
  'Restart with the original filters and a smaller page_size (minimum 10), or a narrower timestamp range. ' +
  'Retrying the same cursor cannot shrink its page because the cursor fixes page_size.'

function usageHistoryResult(text: string, metadata: Record<string, unknown>): ToolResult {
  if (Buffer.byteLength(text, 'utf8') > BILLING_USAGE_MAX_RESPONSE_BYTES) return fail(BILLING_USAGE_TOO_LARGE)
  return ok(text, { ...metadata, truncated: false })
}
/** Types in the live catalog (GET /v1/models?type=all). Accepted as strings so a new Venice type still works. */
const KNOWN_MODEL_TYPES = ['text', 'image', 'inpaint', 'upscale', 'video', 'music', 'tts', 'asr', 'embedding', 'decision'] as const
/** Shared by music generation and quote so a quoted request is always queueable. */
const musicDurationSecondsSchema = z
  .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/, 'Must be a positive integer string')])
  .optional()
  .describe('Optional duration in seconds as a positive integer or numeric string. Model-specific.')
const modelTypeSchema = z
  .string()
  .trim()
  .max(64)
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_-]*$/, 'Must be a catalog type such as "video".')
/** Single-type endpoints reject the list-only "all" and "code" filters. */
const concreteModelTypeSchema = modelTypeSchema.refine(
  (t) => t !== 'all' && t !== 'code',
  'Use a concrete type such as "video"; "all" and "code" are not allowed.',
)

// First entry is the upstream default for POST /audio/voices when model is omitted.
const VOICE_CLONE_MODELS = ['tts-chatterbox-hd', 'tts-minimax-speech-02-hd'] as const

const MODEL_LIST_DEFAULT_LIMIT = 50
const MODEL_LIST_MAX_LIMIT = 200
// A full video model entry is ~1.5 KB, so 200 verbose entries would still be
// hundreds of KB; pages stop early at this budget and report next_offset.
const MODEL_LIST_MAX_PAGE_CHARS = 64 * 1024

function compactModel(model: ModelCatalogItem): Record<string, unknown> {
  const spec = model.model_spec ?? {}
  const capabilities = spec.capabilities
  const enabled =
    capabilities && typeof capabilities === 'object'
      ? Object.entries(capabilities).filter(([, v]) => v === true).map(([k]) => k)
      : []
  const traits = Array.isArray(spec.traits) && spec.traits.length > 0 ? spec.traits : undefined
  return {
    id: model.id,
    type: model.type,
    name: spec.name,
    context_length: model.context_length,
    max_completion_tokens: spec.maxCompletionTokens,
    capabilities: enabled.length > 0 ? enabled : undefined,
    traits,
    privacy: spec.privacy,
    offline: spec.offline === true ? true : undefined,
    beta: spec.betaModel === true ? true : undefined,
    pricing: spec.pricing,
  }
}

// Transcription is charged per successful request, so a paged timestamp walk has
// to read one retained result rather than transcribe the clip again. Retention is
// capped in both lifetime and entry count so a long-lived server cannot accumulate
// full transcripts indefinitely.
const ASR_RESULT_TTL_MS = 10 * 60 * 1000
const ASR_RESULT_MAX_ENTRIES = 16

/** Retained ASR results, scoped to one buildTools call so HTTP sessions never share handles. */
class AsrResultStore {
  private readonly results = new Map<string, { body: AsrUpstreamBody; expiresAt: number; timer: NodeJS.Timeout }>()

  remember(body: AsrUpstreamBody): string {
    // Map iteration is insertion-ordered, so the oldest surviving entry is dropped first.
    while (this.results.size >= ASR_RESULT_MAX_ENTRIES) {
      const oldest = this.results.keys().next()
      if (oldest.done) break
      this.evict(oldest.value)
    }
    const handle = randomUUID()
    // Unref'd so a retained transcript never keeps the process alive.
    const timer = setTimeout(() => this.evict(handle), ASR_RESULT_TTL_MS).unref()
    this.results.set(handle, { body, expiresAt: Date.now() + ASR_RESULT_TTL_MS, timer })
    return handle
  }

  get(handle: string): AsrUpstreamBody | undefined {
    const entry = this.results.get(handle)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.evict(handle)
      return undefined
    }
    return entry.body
  }

  private evict(handle: string): void {
    const entry = this.results.get(handle)
    if (!entry) return
    clearTimeout(entry.timer)
    this.results.delete(handle)
  }
}

const CRYPTO_RPC_MAX_RESPONSE_BYTES = 64 * 1024
const CRYPTO_RPC_IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,255}$/
// Path segments must not be able to form "." or "..", which URL normalisation would resolve.
const CRYPTO_RPC_NETWORK = /^[a-z0-9][a-z0-9-]{0,99}$/
const CHARACTER_SLUG = /^[A-Za-z0-9_-]{1,200}$/
const CRYPTO_RPC_BROADCAST_METHODS = new Set([
  'eth_sendrawtransaction',
  'eth_senduseroperation',
  'starknet_addinvoketransaction',
  'starknet_adddeclaretransaction',
  'starknet_adddeployaccounttransaction',
])

const cryptoRpcIdSchema = z.union([z.string(), z.number().int()])
const cryptoRpcParamsSchema = z.union([z.array(z.unknown()), z.record(z.unknown())])
const cryptoRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0').optional().describe('JSON-RPC version. Defaults to "2.0".'),
  method: z.string().min(1).describe('JSON-RPC method name.'),
  params: cryptoRpcParamsSchema.optional().describe('Method parameters, by position (array) or by name (object).'),
  id: cryptoRpcIdSchema.optional().describe('Caller-supplied request ID. Defaults to 1 for a single request.'),
})
const cryptoRpcBatchRequestSchema = cryptoRpcRequestSchema.extend({
  id: cryptoRpcIdSchema.describe('Required request ID used to correlate this batch item with its response.'),
})
const cryptoRpcIdempotencyKeySchema = z
  .string()
  .regex(CRYPTO_RPC_IDEMPOTENCY_KEY)
  .describe(
    'Reuse the same key when retrying a request. Required for eth_sendRawTransaction, eth_sendUserOperation, Solana sendTransaction, and Starknet writes so a lost response is not broadcast again.',
  )

function cryptoRpcMethodName(item: unknown): string {
  if (typeof item !== 'object' || item === null || !('method' in item)) return ''
  return String((item as { method: unknown }).method)
}

function cryptoRpcMethods(body: unknown): string[] {
  return Array.isArray(body) ? body.map(cryptoRpcMethodName) : [cryptoRpcMethodName(body)]
}

function isBroadcastRpcMethod(method: string): boolean {
  const normalized = method.toLowerCase()
  if (CRYPTO_RPC_BROADCAST_METHODS.has(normalized)) return true
  if (normalized.includes('sendrawtransaction') || normalized.includes('sendtransaction') || normalized.includes('senduseroperation')) return true
  if (normalized.startsWith('starknet_add')) return true
  return false
}

function cryptoRpcRequiresIdempotencyKey(body: unknown): boolean {
  return cryptoRpcMethods(body).some(isBroadcastRpcMethod)
}

function cryptoRpcBatchedBroadcasts(body: unknown): string[] {
  if (!Array.isArray(body) || body.length <= 1) return []
  return [...new Set(cryptoRpcMethods(body).filter(isBroadcastRpcMethod))]
}

function cryptoRpcBilling(headers: Record<string, string>): Record<string, unknown> {
  const billing: Record<string, unknown> = {}
  if (headers['idempotent-replayed'] !== undefined) billing.idempotentReplayed = headers['idempotent-replayed'] === 'true'
  const credits = Number(headers['x-venice-rpc-credits'])
  if (headers['x-venice-rpc-credits'] !== undefined && Number.isFinite(credits)) billing.rpcCredits = credits
  if (headers['x-venice-rpc-cost-usd'] !== undefined) billing.rpcCostUsd = headers['x-venice-rpc-cost-usd']
  return billing
}

function formatCryptoRpcBilling(billing: Record<string, unknown>): string {
  const parts: string[] = []
  if (billing.idempotentReplayed === true) parts.push('replayed from idempotency cache')
  if (billing.rpcCredits !== undefined) parts.push(`credits: ${billing.rpcCredits}`)
  if (billing.rpcCostUsd !== undefined) parts.push(`cost: $${billing.rpcCostUsd}`)
  return parts.join(', ')
}

function cryptoRpcTooLargeMessage(billing: Record<string, unknown>): string {
  const billingLine = formatCryptoRpcBilling(billing)
  return [
    `Crypto RPC response exceeds ${CRYPTO_RPC_MAX_RESPONSE_BYTES} bytes (${CRYPTO_RPC_MAX_RESPONSE_BYTES / 1024} KiB) and was not returned.`,
    `Venice already processed and billed this request upstream${billingLine ? ` (${billingLine})` : ''}; re-sending it will be billed again.`,
    'Narrow the query instead: a smaller eth_getLogs block range or address/topic filter, fewer batch items, or avoid trace/replay/txpool_content methods.',
  ].join(' ')
}
const cacheControlSchema = z
  .object({
    type: z.literal('ephemeral'),
    ttl: z.string().optional().describe('Optional extended cache TTL, for example "1h".'),
  })
  .describe('Prompt cache control for providers that support it.')

const textContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
  cache_control: cacheControlSchema.optional(),
})

const chatUserContentPartSchema = z.union([
  textContentPartSchema,
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string().min(1).describe('Public URL or base64 data URL for an image at least 64px square.'),
    }),
    cache_control: cacheControlSchema.optional(),
  }),
  z.object({
    type: z.literal('input_audio'),
    input_audio: z.object({
      data: z.string().min(1).describe('Base64-encoded audio bytes; direct audio URLs are not supported.'),
      format: z.enum(['wav', 'mp3', 'aiff', 'aac', 'ogg', 'flac', 'm4a', 'pcm16', 'pcm24']).optional(),
    }),
    cache_control: cacheControlSchema.optional(),
  }),
  z.object({
    type: z.literal('video_url'),
    video_url: z.object({
      url: z.string().min(1).describe('Public video URL, supported YouTube URL, or base64 video data URL.'),
    }),
    cache_control: cacheControlSchema.optional(),
  }),
  z.object({
    type: z.literal('file'),
    file: z.object({
      file_data: z.string().min(1).describe('Public file URL or base64 data URL.'),
      filename: z.string().optional(),
    }),
    cache_control: cacheControlSchema.optional(),
  }),
])

const assistantToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  thought_signature: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
})

const chatMessageSchema = z.union([
  z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(chatUserContentPartSchema).min(1)]),
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.union([z.string(), z.array(textContentPartSchema), z.null()]).optional(),
    name: z.string().optional(),
    tool_calls: z.array(assistantToolCallSchema).optional(),
    reasoning_content: z.string().nullable().optional(),
    reasoning_details: z.array(z.object({
      type: z.string(),
      data: z.string().optional(),
      format: z.string().optional(),
      id: z.string().optional(),
      index: z.number().optional(),
      text: z.string().optional(),
    })).optional(),
    thought_signature: z.string().nullable().optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: z.string(),
    tool_call_id: z.string(),
    name: z.string().optional(),
  }),
  z.object({
    role: z.enum(['system', 'developer']),
    content: z.union([z.string(), z.array(textContentPartSchema).min(1)]),
    name: z.string().optional(),
  }),
])

const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const reasoningSchema = z.object({
  effort: reasoningEffortSchema.optional(),
  summary: z.enum(['auto', 'concise', 'detailed']).optional(),
})

const jsonSchemaValue = z.record(z.unknown())
const responseFormatSchema = z.union([
  z.object({ type: z.literal('json_schema'), json_schema: jsonSchemaValue }),
  z.object({ type: z.literal('json_object') }),
  z.object({ type: z.literal('text') }),
])

const chatFunctionToolSchema = z.object({
  type: z.literal('function').optional(),
  id: z.string().optional(),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: jsonSchemaValue.optional(),
    strict: z.boolean().optional(),
  }),
})

const chatToolSchema = z.union([
  chatFunctionToolSchema,
  z.object({ type: z.enum(['web_search', 'x_search']) }),
])

const chatToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1) }),
  }),
])

const responsesContentPartSchema = z.union([
  z.object({ type: z.enum(['input_text', 'text', 'output_text']), text: z.string() }),
  z.object({
    type: z.enum(['input_image', 'image_url']),
    image_url: z.union([
      z.string().min(1),
      z.object({
        url: z.string().min(1),
        detail: z.enum(['auto', 'low', 'high']).optional(),
      }),
    ]),
  }),
])

const responsesMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.union([z.string(), z.array(responsesContentPartSchema).min(1)]),
  type: z.literal('message').optional(),
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
  .strict()
  .optional()
  .describe('Venice-only options: web search, citations, system prompt control, reasoning control, and characters.')

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
  const asrResults = new AsrResultStore()
  const queueDownloadUrls = new QueueDownloadUrlStore()

  const tools: ToolDef[] = [
    // ========================================================================
    // CHAT / TEXT — x402 + API key
    // ========================================================================

    {
      name: 'venice_chat',
      title: 'Venice Chat (LLM)',
      description: `Run an OpenAI-compatible chat completion via Venice's text-model catalog. Calls are non-streaming plaintext. enable_e2ee is rejected: this server does not encrypt chat.${nsfwNote}${X402_OK}`,
      inputSchema: {
        messages: z
          .array(chatMessageSchema)
          .min(1)
          .describe('Chat messages. Multimodal image, audio, video, and file blocks belong in user messages.'),
        model: z.string().optional().describe(`Model id. Defaults to ${cfg.defaultChatModel}.`),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().positive().max(32_000).optional(),
        max_completion_tokens: z.number().int().positive().optional().describe('Maximum visible plus reasoning tokens. Preferred over deprecated max_tokens.'),
        top_p: z.number().min(0).max(1).optional(),
        stop: z.union([z.string(), z.array(z.string()).min(1).max(4)]).optional(),
        verbosity: z.enum(['low', 'medium', 'high', 'auto']).optional().describe('How much text the model returns.'),
        response_format: responseFormatSchema.optional(),
        tools: z.array(chatToolSchema).optional(),
        tool_choice: chatToolChoiceSchema.optional(),
        parallel_tool_calls: z.boolean().optional(),
        prompt_cache_key: z.string().optional(),
        prompt_cache_retention: z.enum(['default', 'extended', '24h']).optional(),
        reasoning: reasoningSchema.optional(),
        reasoning_effort: reasoningEffortSchema.optional().describe('Takes precedence over reasoning.effort.'),
        venice_parameters: veniceParametersSchema,
        timeout_ms: z
          .number()
          .int()
          .min(1_000)
          .max(600_000)
          .optional()
          .describe('Upstream timeout for this call, covering the full response body. Long generations may need more than the VENICE_HTTP_TIMEOUT_MS default.'),
      },
      handler: async (args) => {
        try {
          if (args.venice_parameters && 'enable_e2ee' in args.venice_parameters) {
            return fail('E2EE is not available from this server. venice_chat does not accept enable_e2ee.')
          }

          const body = {
            model: args.model ?? cfg.defaultChatModel,
            messages: args.messages,
            temperature: args.temperature,
            max_tokens: args.max_tokens,
            max_completion_tokens: args.max_completion_tokens,
            top_p: args.top_p,
            stop: args.stop,
            verbosity: args.verbosity,
            response_format: args.response_format,
            tools: args.tools,
            tool_choice: args.tool_choice,
            parallel_tool_calls: args.parallel_tool_calls,
            prompt_cache_key: args.prompt_cache_key,
            prompt_cache_retention: args.prompt_cache_retention,
            reasoning: args.reasoning,
            reasoning_effort: args.reasoning_effort,
            venice_parameters: args.venice_parameters,
            stream: false,
          }

          const resp = await client.post<{
            choices?: Array<{ message?: Record<string, unknown> & { content?: string | null } }>
            usage?: Record<string, number>
          }>('/v1/chat/completions', body, undefined, { timeoutMs: args.timeout_ms })
          const message = resp.choices?.[0]?.message
          const text = message?.content ?? JSON.stringify(message ?? resp, null, 2)
          return ok(truncate(text), { message, usage: resp.usage })
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_responses',
      title: 'Venice Responses API',
      description: `Alpha, stateless OpenAI-compatible Responses API for Venice text models. Supports text/image input and reasoning controls, but this MCP tool does not advertise tool calling because the endpoint does not reliably accept those fields. E2EE-capable models are not supported.${nsfwNote}${X402_OK}`,
      inputSchema: {
        input: z
          .union([
            z.string(),
            z.array(responsesMessageSchema),
          ])
          .describe('Plain text or an array of text/image message inputs.'),
        model: z.string().optional(),
        max_output_tokens: z.number().int().positive().max(32_000).optional(),
        temperature: z.number().min(0).max(2).optional(),
        top_p: z.number().min(0).max(1).optional(),
        reasoning: reasoningSchema.optional(),
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
        model: z.string().min(1).describe('Embedding model id.'),
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
          }, undefined, { maxBytes: cfg.maxImageResponseBytes })
          const enhancedPrompt = decodeEnhancedPrompt(headers)
          // Default Venice response: { id, images: [<base64>, ...] }
          const images = resp.images?.filter((image): image is string =>
            typeof image === 'string' && image.length > 0
          ) ?? []
          if (images.length > 0) {
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
          if (err instanceof VeniceResponseTooLargeError) return imageResponseTooLarge(err)
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
        enhance_prompt: z.boolean().optional().describe('Rewrite the edit prompt with awareness of the input image. May add time and cost.'),
        resolution: z.string().optional().describe('Model-specific output resolution tier; the API validates supported values.'),
        output_format: z.enum(['jpeg', 'jpg', 'png', 'webp']).optional(),
      },
      handler: async (args) => {
        try {
          const { buffer, contentType, headers } = await client.postBinary('/v1/image/edit', {
            method: 'POST',
            json: {
              image: args.image_url,
              prompt: args.prompt,
              model: args.model,
              aspect_ratio: args.aspect_ratio,
              safe_mode: args.safe_mode ?? false,
              enhance_prompt: args.enhance_prompt,
              resolution: args.resolution,
              output_format: args.output_format,
            },
          }, { maxBytes: cfg.maxImageResponseBytes })
          const enhancedPrompt = decodeEnhancedPrompt(headers)
          return {
            content: [
              { type: 'image', data: buffer.toString('base64'), mimeType: contentType },
              ...(enhancedPrompt ? [{ type: 'text' as const, text: `Enhanced prompt: ${enhancedPrompt}` }] : []),
            ],
            structuredContent: enhancedPrompt ? { enhanced_prompt: enhancedPrompt } : undefined,
          }
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) return imageResponseTooLarge(err)
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
        enhance_prompt: z.boolean().optional().describe('Rewrite the edit prompt with awareness of the input images. May add time and cost.'),
        resolution: z.string().optional().describe('Model-specific output resolution tier; the API validates supported values.'),
        output_format: z.enum(['jpeg', 'jpg', 'png', 'webp']).optional(),
        quality: z.enum(['low', 'medium', 'high']).optional().describe('Model-specific quality tier; may change pricing.'),
      },
      handler: async (args) => {
        try {
          // Multi-edit accepts multipart 'images' files or JSON 'images' array of base64/URL strings.
          // We send JSON with URL strings for simplicity.
          const { buffer, contentType, headers } = await client.postBinary('/v1/image/multi-edit', {
            method: 'POST',
            json: {
              images: args.image_urls,
              prompt: args.prompt,
              // MultiEditImageRequest names this field modelId and rejects unknown keys.
              ...(args.model !== undefined ? { modelId: args.model } : {}),
              aspect_ratio: args.aspect_ratio,
              enhance_prompt: args.enhance_prompt,
              resolution: args.resolution,
              output_format: args.output_format,
              quality: args.quality,
            },
          }, { maxBytes: cfg.maxImageResponseBytes })
          const enhancedPrompt = decodeEnhancedPrompt(headers)
          return {
            content: [
              { type: 'image', data: buffer.toString('base64'), mimeType: contentType },
              ...(enhancedPrompt ? [{ type: 'text' as const, text: `Enhanced prompt: ${enhancedPrompt}` }] : []),
            ],
            structuredContent: enhancedPrompt ? { enhanced_prompt: enhancedPrompt } : undefined,
          }
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) return imageResponseTooLarge(err)
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
          const { buffer, contentType } = await client.postBinary('/v1/image/upscale', { form }, {
            maxBytes: cfg.maxImageResponseBytes,
          })
          return {
            content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
          }
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) return imageResponseTooLarge(err)
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
          }, { maxBytes: cfg.maxImageResponseBytes })
          return {
            content: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }],
          }
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) return imageResponseTooLarge(err)
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
      description: `Queue a video generation. Supports Sora 2, Veo 3.1, Kling, Wan, LTX 2, Seedance, Runway Gen-4, and others. Pick a specific id like "veo3.1-fast-text-to-video", "veo3.1-fast-image-to-video", "kling-2.6-pro-text-to-video", "wan-2.6-text-to-video", "seedance-2-0-r2v" etc.${nsfwNote}${X402_OK} Returns { model, queue_id }; poll with venice_video_status. NOTE: 'duration' is a model-specific string enum like '4s' / '6s' / '8s'; inspect it with venice_model_details. Current public Seedance models may reject detectable persons outright. Consent flags are defensive compatibility support, not a policy bypass; set them only after showing a returned policy to the user and receiving explicit confirmation.`,
      inputSchema: {
        prompt: z.string().min(1).max(4096),
        model: z.string().describe('Required. Full model id, e.g. "veo3.1-fast-text-to-video".'),
        duration: z.string().describe('Duration as model-specific string enum, e.g. "4s", "6s", "8s". See venice_model_details.'),
        aspect_ratio: z.string().optional().describe('Output aspect ratio, e.g. "16:9", "9:16", "1:1", "4:5", "9:21". Model-specific; see venice_model_details.'),
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
        resolution: z.string().optional().describe('Output resolution, e.g. "720p", "1080p", "4k". Model-specific; see venice_model_details.'),
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
          const resp = await client.post<{ model?: string; queue_id?: string; download_url?: string }>(
            '/v1/video/queue',
            args
          )
          const id = resp.queue_id
          if (!id) return fail('No queue_id returned by Venice.')
          queueDownloadUrls.remember(id, resp.download_url)
          return ok(
            `Queued: queue_id=${id}, model=${resp.model}\n` +
              'Poll with venice_video_status using queue_id and model. This process remembers download_url; pass it from structuredContent only if another process will poll. Do not invent a download_url.',
            { queue_id: id, model: resp.model, download_url: resp.download_url }
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
      description: `Check status of a queued video job. Returns JSON progress while PROCESSING. Completed jobs are either an embedded base64 video/mp4 MCP resource or a download_url resource link. For VPS / Grok Imagine Private models, retrieve returns COMPLETED JSON without a URL: this process reuses the queue-time download_url when venice_video_generate ran here, or accepts a Venice-host download_url argument. POST endpoint with body {model, queue_id}.${X402_OK}`,
      inputSchema: {
        queue_id: z.string().min(1).describe('Returned by venice_video_generate.'),
        model: z.string().min(1).describe('Same model id used to queue.'),
        download_url: z.string().url().optional().describe(
          'Queue-time download_url from venice_video_generate. Must be an https Venice host. Needed for VPS / Grok Imagine Private only when this process did not queue the job (retrieve returns COMPLETED without a URL).',
        ),
        delete_media_on_completion: z.boolean().optional().describe(
          'Delete server-side media once an embedded MP4 has been buffered. Ignored for download_url results: download first, then call venice_video_complete.',
        ),
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
              // Venice answers HTTP 200 with { success: false } when the storage
              // delete fails, so the status code alone cannot confirm cleanup.
              const cleanup = await client.post<{ success?: boolean }>('/v1/video/complete', {
                queue_id: args.queue_id,
                model: args.model,
              })
              if (!videoCleanupSucceeded(cleanup)) {
                return {
                  deleted: false,
                  cleanupNote:
                    ' Retrieval succeeded, but server-side cleanup was not confirmed: Venice did not report success.' +
                    ' Assume the media is still stored server-side and retry with venice_video_complete.',
                }
              }
              queueDownloadUrls.delete(args.queue_id)
              return { deleted: true, cleanupNote: ` ${successNote}` }
            } catch (cleanupError) {
              return {
                deleted: false,
                cleanupNote: ` Retrieval succeeded, but server-side cleanup failed: ${formatToolError(cleanupError)}`,
              }
            }
          }
          if (response.kind === 'binary') {
            if (!response.contentType.toLowerCase().includes('video/mp4')) {
              return fail(`Venice returned unsupported video content type: ${response.contentType}`)
            }
            if (response.buffer.length === 0) {
              return fail(
                'Venice returned an empty video/mp4 body. The queued media was not deleted; retry venice_video_status with the same queue_id.',
                { error: 'empty_video_response', retry_safe: true, queue_id: args.queue_id, server_media_deleted: false },
              )
            }
            const blob = response.buffer.toString('base64')
            const { deleted, cleanupNote } = await cleanupAfterSuccess(
              'Server-side media was deleted after the MP4 was buffered.',
            )
            return {
              content: [
                {
                  type: 'resource',
                  resource: {
                    uri: `venice://video/${encodeURIComponent(args.queue_id)}.mp4`,
                    mimeType: 'video/mp4',
                    blob,
                  },
                },
                { type: 'text', text: `Completed video (${response.buffer.length} bytes, embedded as base64 video/mp4).${cleanupNote}` },
              ],
              structuredContent: {
                status: 'COMPLETED',
                mime_type: 'video/mp4',
                byte_length: response.buffer.length,
                representation: 'MCP embedded blob resource',
                server_media_deleted: deleted,
              },
            }
          }
          const resp = response.data
          const url =
            resp.download_url ??
            resp.url ??
            queueDownloadUrls.get(args.queue_id) ??
            trustedQueueDownloadUrl(queueDownloadUrl)
          if (resp.status === 'COMPLETED') {
            if (!url) {
              return fail(
                queueDownloadUrl !== undefined
                  ? 'download_url rejected: must be https on venice.ai or a subdomain.'
                  : 'Video completed but Venice returned neither a video/mp4 body nor a download_url.',
                { status: 'COMPLETED' },
              )
            }
            // The download URL stops working once the stored object is removed, so
            // cleanup must wait until the caller has fetched the bytes.
            const cleanupNote = args.delete_media_on_completion
              ? ' Server-side media was NOT deleted because this download_url is only valid until the stored object is removed.' +
                ' Download the file from this URL first, then call venice_video_complete with the same queue_id and model.' +
                ' Optionally send an HTTP DELETE to the download_url afterwards to revoke the link.'
              : ''
            return {
              content: [
                { type: 'resource_link', uri: url, name: 'video', mimeType: 'video/mp4' },
                { type: 'text', text: `${url}${cleanupNote}` },
              ],
              structuredContent: {
                status: 'COMPLETED',
                url,
                representation: 'download_url resource link',
                server_media_deleted: false,
                ...(args.delete_media_on_completion
                  ? { next_step: 'Download url, then call venice_video_complete with the same queue_id and model.' }
                  : {}),
              },
            }
          }
          const eta = resp.average_execution_time ? `${Math.round(resp.average_execution_time / 1000)}s ETA` : ''
          const dur = resp.execution_duration ? `${Math.round(resp.execution_duration / 1000)}s elapsed` : ''
          return ok(`Status: ${resp.status ?? 'unknown'} ${dur} ${eta}`.trim(), { status: resp.status })
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
      name: 'venice_video_complete',
      title: 'Venice Video Complete (cleanup)',
      description: `Mark a completed video as downloaded and delete server-side media. Reports removal only when Venice confirms success.${X402_OK}`,
      inputSchema: {
        queue_id: z.string().min(1),
        model: z.string().min(1),
      },
      handler: async (args) => {
        try {
          const cleanup = await client.post<{ success?: boolean }>('/v1/video/complete', args)
          if (!videoCleanupSucceeded(cleanup)) {
            return fail(
              `Server-side cleanup was not confirmed for ${args.queue_id}: Venice did not report success. ` +
                'Assume the media is still stored and retry venice_video_complete.',
              { server_media_deleted: false },
            )
          }
          queueDownloadUrls.delete(args.queue_id)
          return ok(`Marked ${args.queue_id} complete; server-side media removed.`, {
            server_media_deleted: true,
          })
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
      description: `Convert text to speech. Supports cloned voices + emotion tags ([whispers], [sarcastically], etc.). When streaming=true, Venice streams upstream but this MCP tool buffers and returns one complete audio result; it does not emit incremental MCP chunks.${X402_OK}`,
      inputSchema: {
        input: z.string().min(1).max(4096).describe('Text to convert to speech (max 4096 chars).'),
        voice: z.string().optional().describe('Voice id; see venice://voices.'),
        model: z.string().optional(),
        speed: z.number().min(0.25).max(4).optional(),
        response_format: z.enum(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']).optional(),
        temperature: z.number().min(0).max(2).optional().describe('Sampling temperature. Only supported by some TTS models; unsupported models ignore it.'),
        streaming: z.boolean().optional().describe('Forward Venice\'s streaming flag. The MCP result is still buffered into one complete audio response, not delivered incrementally.'),
      },
      handler: async (args) => {
        try {
          const { buffer, contentType } = await client.postBinary('/v1/audio/speech', {
            method: 'POST',
            json: { ...args, model: args.model ?? cfg.defaultTtsModel },
          }, { maxBytes: cfg.maxAudioResponseBytes })
          return {
            content: [{ type: 'audio', data: buffer.toString('base64'), mimeType: contentType }],
          }
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) return audioResponseTooLarge(err)
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_asr',
      title: 'Venice ASR (Speech-to-Text)',
      description: `Transcribe audio. Fetches the URL server-side and forwards as multipart/form-data file upload. Upstream transcription JSON larger than 1 MiB is rejected so word/character timestamps cannot exhaust memory. Timestamp arrays and transcripts longer than ${ASR_TEXT_PAGE_CHARS} characters are paged in the MCP result: such a transcription returns result_handle alongside the first page, and every later page must be requested with that handle so the clip is transcribed — and charged — exactly once. Handles are held in memory, per MCP session, for ${ASR_RESULT_TTL_MS / 60_000} minutes and only the ${ASR_RESULT_MAX_ENTRIES} most recent survive, after which paging fails and a fresh transcription is needed.${X402_OK}`,
      inputSchema: {
        audio_url: z.string().url().optional().describe('Audio to transcribe. Required unless result_handle is supplied.'),
        result_handle: z
          .string()
          .min(1)
          .optional()
          .describe(`Handle returned by an earlier paged transcription. Pages that retained result without submitting another transcription, so audio_url is ignored when this is set. Expires after ${ASR_RESULT_TTL_MS / 60_000} minutes or once ${ASR_RESULT_MAX_ENTRIES} newer results are retained; an expired handle is an error rather than a silent re-transcription.`),
        model: z.string().optional(),
        language: z.string().optional(),
        response_format: z.enum(['json', 'text']).optional(),
        timestamps: z.boolean().optional().describe('Include word and character timestamps in JSON responses. Defaults to false.'),
        timestamp_offset: z.number().int().min(0).optional().describe('Start index into each timestamp array (word/segment/char). Defaults to 0. Use result_handle to move past the first page.'),
        timestamp_limit: z.number().int().min(1).max(ASR_TIMESTAMP_MAX_LIMIT).optional().describe(`Max entries returned per timestamp array. Defaults to ${ASR_TIMESTAMP_DEFAULT_LIMIT}. Follow next_timestamp_offset; it is null on the last page.`),
        text_offset: z.number().int().min(0).optional().describe(`Start character of the transcript page (${ASR_TEXT_PAGE_CHARS} characters each). Defaults to 0. Use result_handle with next_text_offset to read past the first page.`),
      },
      handler: async (args) => {
        const offset = args.timestamp_offset ?? 0
        const limit = args.timestamp_limit ?? ASR_TIMESTAMP_DEFAULT_LIMIT
        const textOffset = args.text_offset ?? 0
        const respond = (body: AsrUpstreamBody, handle: string | undefined) => {
          const { text, structured, paged } = boundAsrResult(body, offset, limit, textOffset)
          const pageable = structured.timestamps_truncated || structured.next_text_offset != null
          const resultHandle = handle ?? (pageable ? asrResults.remember(body) : undefined)
          const full = resultHandle ? { ...structured, result_handle: resultHandle } : structured
          // Hosts that read only text content still need the page and its continuation handle.
          return ok(paged ? JSON.stringify(full) : text, full)
        }
        if (args.result_handle) {
          const retained = asrResults.get(args.result_handle)
          if (!retained) {
            return fail(
              `Unknown or expired result_handle. Retained transcriptions are dropped after ${ASR_RESULT_TTL_MS / 60_000} minutes, or sooner once ${ASR_RESULT_MAX_ENTRIES} newer results are retained. ` +
                'Call venice_asr again with audio_url to transcribe the audio afresh; paging never re-submits a transcription on your behalf because each one is charged.',
              { error: 'asr_result_expired', result_handle: args.result_handle },
            )
          }
          return respond(retained, args.result_handle)
        }
        if (!args.audio_url) return fail('audio_url is required unless result_handle is supplied')
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
          if (args.timestamps !== undefined) form.set('timestamps', String(args.timestamps))
          const resp = await client.postMultipart<
            string | { text?: string; transcription?: string; duration?: number; timestamps?: unknown }
          >(
            '/v1/audio/transcriptions',
            form,
            { maxBytes: 1024 * 1024 },
          )
          const body: AsrUpstreamBody = typeof resp === 'string' ? { text: resp } : resp
          return respond(body, undefined)
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) {
            return fail(
              'Transcription response exceeds 1 MiB. Disable timestamps or transcribe a shorter clip; timestamped word/character arrays are unbounded upstream.',
            )
          }
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_voice_clone',
      title: 'Venice Voice Clone / List',
      description: `Discover or clone TTS voices. Action 'list' reads live per-model voice metadata from auth-free GET /v1/models?type=tts. Action 'create' requires sample_url, then uploads the sample to POST /v1/audio/voices for the chosen cloning model. Cloned voices come back as a \`vv_<id>\` handle; pass it as venice_tts voice together with the same model.${X402_OK}`,
      inputSchema: {
        action: z.enum(['list', 'create']).describe('list = fetch live TTS model voice metadata; create requires sample_url'),
        sample_url: z
          .string()
          .url()
          .optional()
          .describe('Required for action=create. Audio sample URL; tts-chatterbox-hd accepts MP3/WAV/FLAC/M4A, tts-minimax-speech-02-hd MP3/WAV only.'),
        model: z
          .enum(VOICE_CLONE_MODELS)
          .optional()
          .describe(`TTS model the cloned voice is paired with (action=create). Defaults to ${VOICE_CLONE_MODELS[0]}.`),
      },
      handler: async (args) => {
        try {
          if (args.action === 'list') {
            const resp = await client.get<ModelCatalogResponse>('/v1/models?type=tts')
            const voices = shapeTtsVoiceCatalog(resp)
            return ok(JSON.stringify(voices, null, 2), voices)
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
        duration_seconds: musicDurationSecondsSchema,
        force_instrumental: z.boolean().optional().describe('Only for models reporting supports_force_instrumental.'),
        lyrics_prompt: z.string().optional().describe('Lyrics/text for lyric-capable models. Length limits come from model metadata.'),
        lyrics_optimizer: z.boolean().optional().describe('Auto-generate lyrics. lyrics_prompt must be empty when enabled.'),
        loop: z.boolean().optional().describe('Create a seamless loop on models reporting supports_loop.'),
        voice: z.string().optional().describe('Model-supported voice id/name.'),
        language_code: z.string().optional().describe('ISO 639-1 language code on supported models.'),
        speed: z.number().min(0.25).max(4).optional().describe('Model-specific speed multiplier. Check model min_speed/max_speed.'),
        instrumental: z.boolean().optional().describe('Deprecated: use force_instrumental. Ignored when force_instrumental is set.'),
        lyrics: z.string().optional().describe('Deprecated: use lyrics_prompt. Ignored when lyrics_prompt is set.'),
      },
      handler: async (args) => {
        try {
          const { instrumental, lyrics, ...queueArgs } = args
          const resp = await client.post<{ model?: string; queue_id?: string }>(
            '/v1/audio/queue',
            {
              ...queueArgs,
              force_instrumental: args.force_instrumental ?? instrumental,
              lyrics_prompt: args.lyrics_prompt ?? lyrics,
            }
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
      description: `Check status of a queued music job. Returns JSON progress while PROCESSING. Completed jobs are either an embedded base64 audio MCP resource or a download_url resource link. POST endpoint with body {model, queue_id}.${X402_OK}`,
      inputSchema: {
        queue_id: z.string().min(1),
        model: z.string().min(1),
        delete_media_on_completion: z.boolean().optional().describe(
          'Delete server-side media once embedded audio has been buffered. Ignored for download_url results: download first, then call venice_music_complete.',
        ),
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
                    ' Retrieval succeeded, but server-side cleanup was not confirmed: Venice did not report success.' +
                    ' Assume the media is still stored server-side and retry with venice_music_complete.',
                }
              }
              return { deleted: true, cleanupNote: ` ${successNote}` }
            } catch (cleanupError) {
              return {
                deleted: false,
                cleanupNote:
                  ` Retrieval succeeded, but server-side cleanup failed: ${formatToolError(cleanupError)}` +
                  ' Retry with venice_music_complete.',
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
            if (response.buffer.length === 0) {
              return fail(
                `Venice returned an empty ${mimeType} body. The queued media was not deleted; retry venice_music_status with the same queue_id.`,
                { error: 'empty_audio_response', retry_safe: true, queue_id: args.queue_id, server_media_deleted: false },
              )
            }
            const blob = response.buffer.toString('base64')
            const { deleted, cleanupNote } = await cleanupAfterSuccess(
              'Server-side media was deleted after the audio was buffered.',
            )
            return {
              content: [
                {
                  type: 'resource',
                  resource: {
                    uri: `venice://music/${encodeURIComponent(args.queue_id)}`,
                    mimeType,
                    blob,
                  },
                },
                {
                  type: 'text',
                  text: `Completed music (${response.buffer.length} bytes, embedded as a base64 ${mimeType} resource).${cleanupNote}`,
                },
              ],
              structuredContent: {
                status: 'COMPLETED',
                mime_type: mimeType,
                byte_length: response.buffer.length,
                representation: 'MCP embedded blob resource',
                server_media_deleted: deleted,
              },
            }
          }
          const resp = response.data
          const url = resp.download_url ?? resp.url
          if (resp.status === 'COMPLETED' && url) {
            // The download URL stops working once the stored object is removed, so
            // cleanup must wait until the caller has fetched the bytes.
            const cleanupNote = args.delete_media_on_completion
              ? ' Server-side media was NOT deleted because this download_url is only valid until the stored object is removed.' +
                ' Download the file from this URL first, then call venice_music_complete with the same queue_id and model.'
              : ''
            const mimeType = audioMimeTypeFromUrl(url)
            return {
              content: [
                { type: 'resource_link', uri: url, name: 'music', ...(mimeType ? { mimeType } : {}) },
                { type: 'text', text: `${url}${cleanupNote}` },
              ],
              structuredContent: {
                status: resp.status,
                url,
                representation: 'download_url resource link',
                server_media_deleted: false,
                ...(args.delete_media_on_completion
                  ? { next_step: 'Download url, then call venice_music_complete with the same queue_id and model.' }
                  : {}),
              },
            }
          }
          if (resp.status === 'COMPLETED') {
            return fail('Music completed but Venice returned neither an audio/* body nor a download_url.', {
              status: 'COMPLETED',
              server_media_deleted: false,
              queue_id: args.queue_id,
            })
          }
          const eta = resp.average_execution_time ? `${Math.round(resp.average_execution_time / 1000)}s ETA` : ''
          const dur = resp.execution_duration ? `${Math.round(resp.execution_duration / 1000)}s elapsed` : ''
          return ok(`Status: ${resp.status ?? 'unknown'} ${dur} ${eta}`.trim(), {
            status: resp.status,
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
          if (err instanceof VeniceJsonResponseTooLargeError) {
            return fail(
              `${formatToolError(err)}. The queued media was not deleted; retry venice_music_status with the same queue_id.`,
              {
                error: 'status_response_too_large',
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
      name: 'venice_music_complete',
      title: 'Venice Music Complete (cleanup)',
      description: `Mark a completed music job as downloaded and delete server-side media. Reports removal only when Venice confirms success.${X402_OK}`,
      inputSchema: { queue_id: z.string().min(1), model: z.string().min(1) },
      handler: async (args) => {
        try {
          const resp = await client.post<{ success?: boolean }>('/v1/audio/complete', args)
          if (resp?.success !== true) {
            return fail(`Venice did not confirm cleanup for music ${args.queue_id}; server-side media may still exist.`)
          }
          return ok(`Marked music ${args.queue_id} complete; server-side media removed.`, { server_media_deleted: true })
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
      description: `Search the web with Brave Search (default, Zero Data Retention) or Google Search (proxied and anonymized by Venice). Returns structured results with titles, URLs, snippets, and dates.${X402_OK}`,
      inputSchema: {
        query: z.string().min(1).max(400),
        limit: z.number().int().min(1).max(20).optional(),
        search_provider: z.enum(['brave', 'google']).optional().describe('brave (default) uses Zero Data Retention; google is proxied/anonymized by Venice.'),
      },
      handler: async (args) => {
        try {
          const resp = await client.post<unknown>('/v1/augment/search', args)
          const structured =
            resp && typeof resp === 'object' && !Array.isArray(resp) ? (resp as Record<string, unknown>) : undefined
          return ok(JSON.stringify(resp, null, 2), structured)
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
      description: `Proxy one JSON-RPC request or a batch of up to 100 requests to a supported blockchain network. Use venice_crypto_networks for the live network list. For a simple call, pass rpc_method/rpc_params; for complete request IDs or batches, pass request. Relays (eth_sendRawTransaction, eth_sendUserOperation, Solana sendTransaction, and Starknet writes) must be sent as single requests (not batched) with idempotency_key; reuse the same key when retrying. Results are returned as compact JSON; responses larger than 64 KiB are rejected after Venice has billed them, so keep queries narrow.${X402_OK}`,
      inputSchema: {
        network: z
          .string()
          .regex(CRYPTO_RPC_NETWORK)
          .describe('Network slug returned by venice_crypto_networks, e.g. "ethereum-mainnet".'),
        request: z
          .union([cryptoRpcRequestSchema, z.array(cryptoRpcBatchRequestSchema).min(1).max(100)])
          .optional()
          .describe('A single JSON-RPC request object (ID optional) or a non-empty batch of at most 100 request objects (ID required per item).'),
        rpc_method: z.string().min(1).optional().describe('Convenience form for a single request. Do not combine with request.'),
        rpc_params: cryptoRpcParamsSchema.optional().describe('Parameters for rpc_method, by position (array) or by name (object).'),
        idempotency_key: cryptoRpcIdempotencyKeySchema.optional(),
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
          // A one-item batch is sent as a single request so broadcasts keep the single-request idempotency contract.
          const batchOfOne = Array.isArray(args.request) && args.request.length === 1
          const body =
            args.request === undefined
              ? { jsonrpc: '2.0' as const, method: args.rpc_method!, params: args.rpc_params ?? [], id: 1 }
              : Array.isArray(args.request)
                ? batchOfOne
                  ? { jsonrpc: '2.0' as const, ...args.request[0] }
                  : args.request.map((item) => ({ jsonrpc: '2.0' as const, ...item }))
                : { jsonrpc: '2.0' as const, ...args.request, id: args.request.id ?? 1 }
          const batchedBroadcasts = cryptoRpcBatchedBroadcasts(body)
          if (batchedBroadcasts.length > 0) {
            return fail(
              `Transaction relays cannot be batched with other requests; this batch contains ${batchedBroadcasts.join(', ')}. Send each broadcast as a single request.`,
            )
          }
          if (cryptoRpcRequiresIdempotencyKey(body) && !args.idempotency_key) {
            return fail(
              'idempotency_key is required for transaction relays (eth_sendRawTransaction, eth_sendUserOperation, Solana sendTransaction, and Starknet writes). Reuse the same key when retrying so Venice can return the cached result instead of broadcasting again.',
            )
          }
          const headers = args.idempotency_key ? { 'Idempotency-Key': args.idempotency_key } : undefined
          const resp = await client.postWithHeaders<unknown>(
            `/v1/crypto/rpc/${encodeURIComponent(args.network)}`,
            body,
            headers,
            { maxResponseBytes: CRYPTO_RPC_MAX_RESPONSE_BYTES },
          )
          const result = batchOfOne && !Array.isArray(resp.body) ? [resp.body] : resp.body
          const billing = cryptoRpcBilling(resp.headers)
          const billingLine = formatCryptoRpcBilling(billing)
          const text = JSON.stringify(result)
          const extraText = billingLine ? [`Venice RPC: ${billingLine}`] : []
          if (Buffer.byteLength(text + extraText.join(''), 'utf8') > CRYPTO_RPC_MAX_RESPONSE_BYTES) {
            return fail(cryptoRpcTooLargeMessage(billing))
          }
          return ok(text, Object.keys(billing).length > 0 ? billing : undefined, extraText)
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) {
            return fail(cryptoRpcTooLargeMessage(cryptoRpcBilling(err.headers)))
          }
          return fail(formatToolError(err))
        }
      },
    },

    // ========================================================================
    // CATALOG — auth-free GETs (or API-key for characters)
    // ========================================================================

    {
      name: 'venice_tee_attestation',
      title: 'Venice TEE Attestation',
      description: `Fetch hardware-attestation evidence for a TEE-capable text model. The caller must supply a fresh 32-byte nonce and independently verify the echoed nonce, Intel TDX quote, optional NVIDIA evidence, debug-mode state, and signing-key binding before trusting the key. Fetching this evidence does not itself establish E2EE.${NO_AUTH}`,
      inputSchema: {
        model: z.string().min(1).describe('TEE-capable text model id; check supportsTeeAttestation in venice_list_models.'),
        nonce: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .describe('Caller-generated 32-byte freshness challenge encoded as exactly 64 hexadecimal characters.'),
      },
      handler: async ({ model, nonce }) => {
        try {
          const params = new URLSearchParams({ model, nonce })
          const resp = await client.get<Record<string, unknown>>(
            `/v1/tee/attestation?${params.toString()}`,
            undefined,
            { auth: 'none' },
          )
          return ok(JSON.stringify(resp, null, 2), resp)
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_tee_signature',
      title: 'Venice TEE Response Signature',
      description: `Fetch the enclave signature for a completed TEE text-model chat request. The caller must cryptographically verify it against the signing identity bound by a separately verified attestation; this tool only returns the provider payload.${NO_AUTH}`,
      inputSchema: {
        model: z.string().min(1).describe('Same TEE-capable text model used for the chat completion.'),
        request_id: z.string().min(1).describe('Completion id returned by POST /v1/chat/completions.'),
      },
      handler: async ({ model, request_id }) => {
        try {
          const params = new URLSearchParams({ model, request_id })
          const resp = await client.get<Record<string, unknown>>(
            `/v1/tee/signature?${params.toString()}`,
            undefined,
            { auth: 'none' },
          )
          return ok(JSON.stringify(resp, null, 2), resp)
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_list_models',
      title: 'Venice List Models',
      description: `List the live model catalog, one page at a time. Omitting type lists every model type (sent upstream as type=all). Each entry is a compact summary (id, type, name, context length, enabled capabilities, traits, privacy, pricing); set verbose=true for the full upstream model objects. Returns total, next_offset, and every matching model id in ids; call again with offset=next_offset until next_offset is null.${NO_AUTH}`,
      inputSchema: {
        type: modelTypeSchema
          .optional()
          .describe(`Catalog type: ${KNOWN_MODEL_TYPES.join(', ')}, "code", or "all" (default). Without a type Venice returns only text models, so pass one to find video, image or audio ids.`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MODEL_LIST_MAX_LIMIT)
          .optional()
          .describe(`Max models per page. Defaults to ${MODEL_LIST_DEFAULT_LIMIT}. A page may hold fewer when entries are large; follow next_offset.`),
        offset: z.number().int().min(0).optional().describe('Index of the first model to return. Defaults to 0.'),
        verbose: z.boolean().optional().describe('Return full upstream model objects instead of compact summaries. Defaults to false.'),
      },
      handler: async ({ type, limit, offset, verbose }) => {
        try {
          const requestedType = type ?? 'all'
          const query = new URLSearchParams({ type: requestedType }).toString()
          const resp = await client.get<ModelCatalogResponse>(`/v1/models?${query}`)
          const models = resp.data ?? resp.models ?? []
          const ids = models
            .map((m) => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : undefined))
            .filter((id): id is string => typeof id === 'string')
          const start = offset ?? 0
          const end = Math.min(models.length, start + (limit ?? MODEL_LIST_DEFAULT_LIMIT))
          const page: unknown[] = []
          const result = {
            requested_type: requestedType,
            total: models.length,
            count: end - start,
            offset: start,
            next_offset: end as number | null,
            ids,
            data: page,
          }
          let chars = JSON.stringify(result).length
          for (let i = start; i < end; i++) {
            const entry = verbose ? models[i] : compactModel(models[i])
            const size = JSON.stringify(entry).length + 1
            if (page.length > 0 && chars + size > MODEL_LIST_MAX_PAGE_CHARS) break
            page.push(entry)
            chars += size
          }
          const next = start + page.length
          const nextOffset = next < models.length ? next : null
          result.count = page.length
          result.next_offset = nextOffset
          return ok(JSON.stringify(result), result)
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_model_traits',
      title: 'Venice Model Traits',
      description: `Return the live trait-name to model-id mapping for a model type. The API defaults to text when type is omitted.${NO_AUTH}`,
      inputSchema: {
        type: concreteModelTypeSchema
          .optional()
          .describe(`Catalog type: ${KNOWN_MODEL_TYPES.join(', ')}. Defaults to text upstream.`),
      },
      handler: async ({ type }) => {
        try {
          const path = type
            ? `/v1/models/traits?type=${encodeURIComponent(type)}`
            : '/v1/models/traits'
          const resp = await client.get<Record<string, unknown>>(path)
          return ok(JSON.stringify(resp, null, 2), resp)
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_model_compatibility_mapping',
      title: 'Venice Model Compatibility Mapping',
      description: `Return the live compatible model-name to Venice model-id mapping for a model type. The API defaults to text when type is omitted.${NO_AUTH}`,
      inputSchema: {
        type: concreteModelTypeSchema
          .optional()
          .describe(`Catalog type: ${KNOWN_MODEL_TYPES.join(', ')}. Defaults to text upstream.`),
      },
      handler: async ({ type }) => {
        try {
          const path = type
            ? `/v1/models/compatibility_mapping?type=${encodeURIComponent(type)}`
            : '/v1/models/compatibility_mapping'
          const resp = await client.get<Record<string, unknown>>(path)
          return ok(JSON.stringify(resp, null, 2), resp)
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_model_details',
      title: 'Venice Model Details',
      description: `Get one exact model's full catalog row, including model_spec constraints, capabilities, and pricing when available. Requires a concrete type to keep the upstream catalog response bounded.${NO_AUTH}`,
      inputSchema: {
        model_id: z.string().trim().min(1).describe('Exact model id, e.g. from venice_list_models({ type: "video" }).'),
        type: concreteModelTypeSchema
          .describe(`Catalog type the model belongs to: ${KNOWN_MODEL_TYPES.join(', ')}.`),
      },
      handler: async ({ model_id, type }) => {
        try {
          const query = new URLSearchParams({ type }).toString()
          const resp = await client.get<ModelCatalogResponse>(`/v1/models?${query}`)
          const models: unknown[] = resp.data ?? resp.models ?? []
          const model = models
            .filter((candidate): candidate is Record<string, unknown> =>
              typeof candidate === 'object' && candidate !== null
            )
            .find((candidate) => typeof candidate.id === 'string' && candidate.id.toLowerCase() === model_id.toLowerCase())
          if (!model) {
            return fail(
              `No model "${model_id}" in the "${type}" catalog. If the id is right, it may belong to another type ` +
                `(${KNOWN_MODEL_TYPES.filter((t) => t !== type).join(', ')}); retry with that type, or find it with venice_list_models({ type }).`
            )
          }
          return ok(JSON.stringify(model, null, 2), model)
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
        duration_seconds: musicDurationSecondsSchema,
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
        duration: z.string().describe('Duration as model-specific string enum, e.g. "4s", "6s", "8s".'),
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
        search: z.string().max(200).optional(),
        tags: z.array(z.string().max(100)).max(20).optional(),
        tag: z.string().max(100).optional().describe('Deprecated: use tags. A single tag, merged into tags.'),
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
          const tags = new Set<string>(args.tags ?? [])
          if (args.tag) tags.add(args.tag)
          for (const tag of tags) params.append('tags', tag)
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
          const fitted = fitJsonList(list)
          return ok(fitted.text, {
            count: list.length,
            ...(fitted.truncated ? { truncated: true, returned: fitted.returned, total: list.length } : {}),
          })
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
        slug: z.string().regex(CHARACTER_SLUG).describe('Public character slug, e.g. "alan-watts".'),
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
          const fitted = fitJson(resp)
          return ok(fitted.text, fitted.truncated ? { truncated: true } : undefined)
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
        slug: z.string().regex(CHARACTER_SLUG).describe('Public character slug, e.g. "alan-watts".'),
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
          const fitted = fitJson(resp)
          return ok(fitted.text, fitted.truncated ? { truncated: true } : undefined)
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
    // BILLING — ADMIN API KEY ONLY
    // ========================================================================

    {
      name: 'venice_billing_balance',
      title: 'Venice Billing Balance',
      description: `Get current USD, DIEM, and bundled-credit availability for the authenticated Venice account.${ADMIN_API_KEY_ONLY}`,
      inputSchema: {},
      handler: async () => {
        try {
          const resp = await client.get<unknown>('/v1/billing/balance', undefined, { auth: 'apiKey' })
          return ok(JSON.stringify(resp, null, 2))
        } catch (err) {
          return fail(formatToolError(err))
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
            return fail('Choose either lookback or start_date/end_date, not both.')
          }
          if ((args.start_date && !args.end_date) || (!args.start_date && args.end_date)) {
            return fail('start_date and end_date must be provided together.')
          }
          if (args.start_date && args.end_date && args.start_date > args.end_date) {
            return fail('start_date cannot be later than end_date.')
          }
          if (args.lookback && Number(args.lookback.slice(0, -1)) > 90) {
            return fail('lookback cannot exceed 90d.')
          }
          const params = new URLSearchParams()
          if (args.lookback) params.set('lookback', args.lookback)
          if (args.start_date) params.set('startDate', args.start_date)
          if (args.end_date) params.set('endDate', args.end_date)
          const query = params.toString()
          const resp = await client.get<unknown>(
            `/v1/billing/usage-analytics${query ? `?${query}` : ''}`,
            undefined,
            { auth: 'apiKey' },
          )
          return ok(truncate(JSON.stringify(resp, null, 2)))
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_billing_usage_history',
      title: 'Venice Billing Usage History',
      description: `Walk detailed billing usage in ascending timestamp order using cursor pagination. Supports complete JSON or upstream CSV pages, defaulting to 10 rows. Pages exceeding 64 KiB fail without returning partial rows or a next cursor. On continuation, send cursor without the original filters; CSV nextCursor values already encode format=csv so a cursor-only follow-up stays on text/csv. This uses /billing/usage-history, never deprecated /billing/usage.${ADMIN_API_KEY_ONLY}`,
      inputSchema: {
        currency: z.enum(['USD', 'DIEM', 'BUNDLED_CREDITS']).optional(),
        cursor: z
          .string()
          .regex(
            /^(?:csv:)?[A-Za-z0-9_-]{1,512}$/,
            'Must be a nextCursor from a previous page: up to 512 URL-safe characters, optionally prefixed with csv:.',
          )
          .optional()
          .describe('Opaque nextCursor from the previous page. CSV pages return a csv: prefix so continuation stays on text/csv. Cannot be combined with filters or page_size.'),
        start_timestamp: utcTimestampSchema
          .optional()
          .describe('Inclusive first-page lower bound, ISO 8601 UTC with Z suffix.'),
        end_timestamp: utcTimestampSchema
          .optional()
          .describe('Exclusive first-page upper bound, ISO 8601 UTC with Z suffix.'),
        page_size: z.number().int().min(10).max(1000).optional()
          .describe('First-page row count. Defaults to 10. Complete pages larger than 64 KiB are rejected; use smaller pages or narrower timestamp filters.'),
        format: z.enum(['json', 'csv']).optional().describe('Defaults to json. Optional on continuation; CSV nextCursor values already stay on CSV.'),
      },
      handler: async (args) => {
        try {
          if (
            args.cursor &&
            (args.currency || args.start_timestamp || args.end_timestamp || args.page_size !== undefined)
          ) {
            return fail('cursor must be sent without currency, timestamps, or page_size. format may be resent.')
          }
          if (
            args.start_timestamp &&
            args.end_timestamp &&
            Date.parse(args.start_timestamp) >= Date.parse(args.end_timestamp)
          ) {
            return fail('end_timestamp must be later than start_timestamp.')
          }
          const CSV_CURSOR_PREFIX = 'csv:'
          const rawCursor = args.cursor?.startsWith(CSV_CURSOR_PREFIX)
            ? args.cursor.slice(CSV_CURSOR_PREFIX.length)
            : args.cursor
          if (args.cursor?.startsWith(CSV_CURSOR_PREFIX) && args.format === 'json') {
            return fail('csv-prefixed cursor cannot be combined with format=json.')
          }
          const wantCsv = args.format === 'csv' || Boolean(args.cursor?.startsWith(CSV_CURSOR_PREFIX))
          const params = new URLSearchParams()
          if (rawCursor) params.set('cursor', rawCursor)
          if (args.currency) params.set('currency', args.currency)
          if (args.start_timestamp) params.set('startTimestamp', args.start_timestamp)
          if (args.end_timestamp) params.set('endTimestamp', args.end_timestamp)
          if (!rawCursor) params.set('pageSize', String(args.page_size ?? BILLING_USAGE_DEFAULT_PAGE_SIZE))
          const query = params.toString()
          const path = `/v1/billing/usage-history${query ? `?${query}` : ''}`
          if (wantCsv) {
            let nextCursor: string | undefined
            const csv = await client.get<string>(
              path,
              { Accept: 'text/csv' },
              {
                auth: 'apiKey',
                maxBytes: BILLING_USAGE_MAX_RESPONSE_BYTES,
                onResponse: ({ headers }) => {
                  nextCursor = headers['x-next-cursor']
                },
              },
            )
            return usageHistoryResult(csv, {
              format: 'csv',
              nextCursor: nextCursor ? `${CSV_CURSOR_PREFIX}${nextCursor}` : null,
            })
          }
          const resp = await client.get<{ data?: unknown[]; nextCursor?: string | null }>(
            path,
            undefined,
            { auth: 'apiKey', maxBytes: BILLING_USAGE_MAX_RESPONSE_BYTES },
          )
          return usageHistoryResult(JSON.stringify(resp, null, 2), {
            format: 'json',
            count: resp.data?.length ?? 0,
            nextCursor: resp.nextCursor ?? null,
          })
        } catch (err) {
          if (err instanceof VeniceResponseTooLargeError) return fail(BILLING_USAGE_TOO_LARGE)
          return fail(formatToolError(err))
        }
      },
    },

    // ========================================================================
    // API KEYS — safe reads. Web3 challenge and mint live on a follow-up.
    // ========================================================================

    {
      name: 'venice_list_api_keys',
      title: 'Venice List API Keys',
      description: `List active API-key metadata, including only the documented last six characters—not full key secrets.${ADMIN_API_KEY_ONLY}`,
      inputSchema: {},
      handler: async () => {
        try {
          const resp = await client.get<{ data?: unknown[] }>('/v1/api_keys', undefined, { auth: 'apiKey' })
          return ok(safeJson(resp), { count: resp.data?.length ?? 0 })
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.get<unknown>(
            `/v1/api_keys/${encodeURIComponent(id)}`,
            undefined,
            { auth: 'apiKey' },
          )
          return ok(safeJson(resp))
        } catch (err) {
          return fail(formatToolError(err))
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
          const resp = await client.get<unknown>('/v1/api_keys/rate_limits', undefined, { auth: 'apiKey' })
          return ok(safeJson(resp))
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    {
      name: 'venice_api_key_rate_limit_logs',
      title: 'Venice API Key Rate Limit Logs',
      description: `Get the last 50 exceeded rate-limit events for the account. This read-only endpoint is experimental.${ADMIN_API_KEY_ONLY}`,
      inputSchema: {},
      handler: async () => {
        try {
          const resp = await client.get<{ data?: unknown[] }>(
            '/v1/api_keys/rate_limits/log',
            undefined,
            { auth: 'apiKey' },
          )
          return ok(safeJson(resp), { count: resp.data?.length ?? 0 })
        } catch (err) {
          return fail(formatToolError(err))
        }
      },
    },

    // ========================================================================
    // x402 wallet helpers — SIWX reads + auth-free top-up discovery
    // ========================================================================

    {
      name: 'venice_x402_balance',
      title: 'Venice x402 Wallet Balance',
      description:
        `Check the prepaid x402 credit balance for an EVM or Solana wallet address. SIWX-ONLY: this endpoint rejects API key auth and requires SIGN-IN-WITH-X (forwarded from VENICE_SIWX_TOKEN). The wallet in the path must match the SIWX-authenticated wallet.`,
      inputSchema: {
        wallet_address: walletAddressSchema,
      },
      handler: async ({ wallet_address }) => {
        try {
          const resp = await client.get<unknown>(
            `/v1/x402/balance/${encodeURIComponent(normalizeWalletAddress(wallet_address))}`,
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
        `Fetch the x402 top-up payment requirements: the accepted USDC payment options (currently Base and Solana), each with network, asset, receiver wallet (payTo), minimum amount in base units, and settlement timeout. Sends an empty POST with no payment header, so nothing is charged. Signing and PAYMENT-SIGNATURE submission happen OUTSIDE this MCP server.${NO_AUTH}`,
      inputSchema: {},
      handler: async () => {
        try {
          await client.post('/v1/x402/top-up', {}, undefined, { auth: 'none' })
          return ok('Unexpected non-402 response. Top-up may already be processed.')
        } catch (err) {
          if (err instanceof VeniceUpstreamError && err.status === 402) {
            const requirements = topUpRequirements(err.body)
            if (requirements) return ok(JSON.stringify(requirements, null, 2), requirements)
            return ok(formatToolError(err))
          }
          return fail(formatToolError(err))
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
          const qs = limit ? `?limit=${limit}` : ''
          const resp = await client.get<unknown>(
            `/v1/x402/transactions/${encodeURIComponent(normalizeWalletAddress(wallet_address))}${qs}`,
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
