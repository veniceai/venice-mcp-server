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
  /** `full` exposes every tool; `hosted` is the curated, safe-by-default set for shared deployments. */
  profile: ToolProfile
  /** How long status tools wait for a queued job to finish before returning (0 = return immediately). */
  statusWaitMs: number
  /** Largest inline media payload (base64 characters) a tool result may carry; 0 = unlimited. */
  maxInlineMediaChars: number
  /** Server name advertised to MCP clients. */
  serverName: string
  /** Server version advertised. */
  serverVersion: string
}

const DEFAULT_TIMEOUT_MS = 60_000
// Stays under ChatGPT's ~60 s tool-call limit.
const HOSTED_STATUS_WAIT_MS = 45_000
const MAX_STATUS_WAIT_MS = 55_000
// Claude caps a tool result at ~150k characters; leave room for the text around it.
const HOSTED_MAX_INLINE_MEDIA_CHARS = 100_000

export type ToolProfile = 'full' | 'hosted'

export function parseToolProfile(value: string | undefined): ToolProfile {
  const profile = (value ?? 'full').trim().toLowerCase()
  if (profile === 'full' || profile === 'hosted') return profile
  throw new Error(`Unknown VENICE_MCP_PROFILE "${value}". Use "full" or "hosted".`)
}

function parseNonNegativeInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback
}

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const profile = parseToolProfile(env.VENICE_MCP_PROFILE)
  const hosted = profile === 'hosted'
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
    enableNsfw: !hosted && env.VENICE_DISABLE_NSFW !== '1',
    profile,
    statusWaitMs: parseNonNegativeInt(env.VENICE_MCP_STATUS_WAIT_MS, hosted ? HOSTED_STATUS_WAIT_MS : 0, MAX_STATUS_WAIT_MS),
    maxInlineMediaChars: parseNonNegativeInt(env.VENICE_MCP_MAX_INLINE_MEDIA_CHARS, hosted ? HOSTED_MAX_INLINE_MEDIA_CHARS : 0),
    serverName: '@veniceai/mcp-server',
    serverVersion: '0.2.0',
  }
}
