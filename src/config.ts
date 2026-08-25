/**
 * Configuration loaded from env vars.
 *
 * Auth modes (mutually exclusive at request time; key beats SIWX when both set):
 *   - VENICE_API_KEY        → forwarded as `Authorization: Bearer`.
 *   - VENICE_SIWX_TOKEN     → forwarded as `SIGN-IN-WITH-X` (base64-encoded
 *                              signed EVM SIWE or Solana SIWX payload).
 *                              Pre-generate this in the caller's wallet.
 *
 * x402 reality check
 * ──────────────────
 * Venice's x402 is a *prepaid balance* model, not per-call HTTP-402 settlement:
 *
 *   1. Client signs an EVM SIWE or Solana SIWX message once → SIWX token.
 *   2. Client tops up balance via `POST /api/v1/x402/top-up` with the
 *      `PAYMENT-SIGNATURE` header (signed Base or Solana USDC payment).
 *   3. Subsequent inference calls send `SIGN-IN-WITH-X` (NOT a payment header).
 *      Venice debits the credit account on success.
 *
 * Therefore this MCP server never sends a payment header. Payment signing and
 * settlement happen outside this process.
 */
export interface Config {
  /** Base URL of the Venice API. */
  baseUrl: string
  /** Optional API key used for all upstream calls (forwarded as Bearer). */
  apiKey: string | undefined
  /**
   * Optional pre-signed SIWX token (`SIGN-IN-WITH-X` header value).
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

const DEFAULT_TIMEOUT_MS = 60_000

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
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
    enableNsfw: env.VENICE_DISABLE_NSFW !== '1',
    serverName: '@veniceai/mcp-server',
    serverVersion: '0.2.0',
  }
}
