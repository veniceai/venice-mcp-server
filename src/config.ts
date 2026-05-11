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
  /** Whether to advertise NSFW capability in tool descriptions. */
  enableNsfw: boolean
  /** Server name advertised to MCP clients. */
  serverName: string
  /** Server version advertised. */
  serverVersion: string
}

const DEFAULT_BASE_URL = 'https://api.venice.ai/api'
const DEFAULT_TIMEOUT_MS = 60_000

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.')
}

function normalizeBaseUrl(value: string | undefined, env: NodeJS.ProcessEnv): string {
  const trimmed = value?.trim()
  if (!trimmed) return DEFAULT_BASE_URL

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('VENICE_API_BASE_URL must be an absolute URL')
  }

  if (parsed.username || parsed.password) {
    throw new Error('VENICE_API_BASE_URL must not include credentials')
  }
  if (parsed.protocol !== 'https:') {
    const allowInsecure = env.VENICE_ALLOW_INSECURE_API_BASE_URL === '1'
    const allowLoopback = parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)
    if (!allowInsecure && !allowLoopback) {
      throw new Error('VENICE_API_BASE_URL must use https unless it points to loopback or VENICE_ALLOW_INSECURE_API_BASE_URL=1 is set')
    }
  }

  const withoutTrailingSlash = parsed.href.replace(/\/+$/, '')
  if (withoutTrailingSlash === 'https://api.venice.ai') return DEFAULT_BASE_URL
  return withoutTrailingSlash
}

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    baseUrl: normalizeBaseUrl(env.VENICE_API_BASE_URL, env),
    apiKey: env.VENICE_API_KEY,
    siwxToken: env.VENICE_SIWX_TOKEN,
    defaultChatModel: env.VENICE_DEFAULT_CHAT_MODEL ?? 'venice-uncensored',
    defaultImageModel: env.VENICE_DEFAULT_IMAGE_MODEL ?? 'flux-2-pro',
    defaultTtsModel: env.VENICE_DEFAULT_TTS_MODEL ?? 'tts-kokoro',
    defaultAsrModel: env.VENICE_DEFAULT_ASR_MODEL ?? 'openai/whisper-large-v3',
    timeoutMs: parseTimeoutMs(env.VENICE_HTTP_TIMEOUT_MS),
    enableNsfw: env.VENICE_DISABLE_NSFW !== '1',
    serverName: '@veniceai/mcp-server',
    serverVersion: '0.1.0',
  }
}
