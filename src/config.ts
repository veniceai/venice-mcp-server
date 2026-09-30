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
  baseUrl: string
  /** Optional API key used for all upstream calls (forwarded as Bearer). */
  apiKey: string | undefined
  /**
   * Optional pre-signed SIWX token (`X-Sign-In-With-X` header value).
   * Authenticates a wallet against an existing X402CreditAccount with prepaid balance.
   */
  siwxToken: string | undefined
  /** Default model for chat completions when caller does not specify. */
  defaultChatModel: string
  /** Default model for image generation when caller does not specify. */
  defaultImageModel: string
  /** Default TTS model. */
  defaultTtsModel: string
  /** Default ASR model. */
  defaultAsrModel: string
  /** Request timeout (ms) for non-streaming calls. */
  timeoutMs: number
  /** Maximum completed video response bytes buffered for an MCP result. */
  maxVideoResponseBytes: number
  /** Maximum completed music response bytes buffered for an MCP result. */
  maxAudioResponseBytes: number
  /** Maximum image generate/edit response bytes buffered for an MCP result. */
  maxImageResponseBytes: number
  /** Whether to advertise NSFW capability in tool descriptions. */
  enableNsfw: boolean
  /**
   * When set, generated media (images, video, music, speech) is written to
   * this directory and tools return a file:// resource link plus a JSON
   * sidecar instead of inline base64. Intended for NLE / timeline-editor
   * workflows (DaVinci Resolve, Premiere, etc.) that import files from disk.
   */
  mediaDir: string | undefined
  /** Maximum bytes read from a local file passed as a media input. */
  maxLocalInputBytes: number
  /** Toolset filter. `undefined` = all tools. */
  toolsets: Set<Toolset> | undefined
  /** Server name advertised to MCP clients. */
  serverName: string
  /** Server version advertised. */
  serverVersion: string
}

export const TOOLSETS = ['chat', 'image', 'video', 'audio', 'music', 'augment', 'catalog', 'crypto', 'x402'] as const
export type Toolset = (typeof TOOLSETS)[number]

/** Named bundles resolvable from VENICE_TOOLSETS. */
const TOOLSET_ALIASES: Record<string, readonly Toolset[]> = {
  media: ['image', 'video', 'audio', 'music', 'catalog'],
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_VIDEO_RESPONSE_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_AUDIO_RESPONSE_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_LOCAL_INPUT_BYTES = 50 * 1024 * 1024

export function parseToolsets(value: string | undefined): Set<Toolset> | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const out = new Set<Toolset>()
  for (const token of raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    if (token === 'all') return undefined
    const alias = TOOLSET_ALIASES[token]
    if (alias) {
      for (const t of alias) out.add(t)
      continue
    }
    if ((TOOLSETS as readonly string[]).includes(token)) {
      out.add(token as Toolset)
      continue
    }
    throw new Error(
      `Unknown VENICE_TOOLSETS entry "${token}". Valid: all, ${Object.keys(TOOLSET_ALIASES).join(', ')}, ${TOOLSETS.join(', ')}`,
    )
  }
  return out.size > 0 ? out : undefined
}
const DEFAULT_MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    // VENICE_TEST_BASE_URL is an internal test-only escape hatch — never documented publicly.
    baseUrl: env.VENICE_TEST_BASE_URL?.trim() || 'https://api.venice.ai/api',
    apiKey: env.VENICE_API_KEY,
    siwxToken: env.VENICE_SIWX_TOKEN,
    defaultChatModel: env.VENICE_DEFAULT_CHAT_MODEL ?? 'deepseek-v4-flash-0731',
    defaultImageModel: env.VENICE_DEFAULT_IMAGE_MODEL ?? 'flux-2-pro',
    defaultTtsModel: env.VENICE_DEFAULT_TTS_MODEL ?? 'tts-kokoro',
    defaultAsrModel: env.VENICE_DEFAULT_ASR_MODEL ?? 'openai/whisper-large-v3',
    timeoutMs: parseTimeoutMs(env.VENICE_HTTP_TIMEOUT_MS),
    maxVideoResponseBytes: parsePositiveInteger(
      env.VENICE_MAX_VIDEO_RESPONSE_BYTES,
      DEFAULT_MAX_VIDEO_RESPONSE_BYTES,
    ),
    maxAudioResponseBytes: parsePositiveInteger(
      env.VENICE_MAX_AUDIO_RESPONSE_BYTES,
      DEFAULT_MAX_AUDIO_RESPONSE_BYTES,
    ),
    maxImageResponseBytes: parsePositiveInteger(
      env.VENICE_MAX_IMAGE_RESPONSE_BYTES,
      DEFAULT_MAX_IMAGE_RESPONSE_BYTES,
    ),
    enableNsfw: env.VENICE_DISABLE_NSFW !== '1',
    mediaDir: env.VENICE_MEDIA_DIR?.trim() || undefined,
    maxLocalInputBytes: parsePositiveInteger(env.VENICE_MAX_LOCAL_INPUT_BYTES, DEFAULT_MAX_LOCAL_INPUT_BYTES),
    toolsets: parseToolsets(env.VENICE_TOOLSETS),
    serverName: '@veniceai/mcp-server',
    serverVersion: '0.2.0',
  }
}
