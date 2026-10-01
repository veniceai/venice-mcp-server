import { VeniceUpstreamError } from './types.js'

interface BalanceFields {
  currentBalanceUsd?: number
  minimumBalanceUsd?: number
  suggestedTopUpUsd?: number
  minimumTopUpUsd?: number
  reason?: string
  message?: string
  receiverWallet?: string
  topUpInstructions?: {
    step1?: string
    step2?: string
    step3?: string
    receiverWallet?: string
    tokenAddress?: string
    network?: string
    minimumAmountUsd?: number
  }
  authOptions?: {
    apiKey?: { header?: string; getKey?: string; docs?: string }
    x402Wallet?: { header?: string; topUp?: string; docs?: string }
  }
}

/** x402 v2 PaymentRequired body (https://github.com/x402-foundation/x402). */
interface X402V2PaymentRequired {
  x402Version?: number
  error?: string
  resource?: {
    url?: string
    description?: string | null
    mimeType?: string | null
  }
  accepts?: X402V2PaymentRequirement[]
}

interface X402V2PaymentRequirement {
  scheme?: string
  network?: string
  amount?: string
  asset?: string
  payTo?: string
  maxTimeoutSeconds?: number
  extra?: {
    name?: string
    version?: string
    assetTransferMethod?: string
    paymentFlow?: string
    [k: string]: unknown
  }
}

/** True when err.body is an x402 v2 PaymentRequired object. */
function isX402V2Body(body: unknown): body is X402V2PaymentRequired {
  if (!isObject(body)) return false
  if (body.x402Version !== 2) return false
  return Array.isArray((body as { accepts?: unknown }).accepts)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function format402(err: VeniceUpstreamError): string {
  const body = isObject(err.body) ? (err.body as BalanceFields) : {}
  const lines: string[] = []
  lines.push('⚠️ Venice returned 402 Payment Required.')
  lines.push('')

  // Case 1: insufficient balance (already authenticated wallet)
  if (typeof body.currentBalanceUsd === 'number') {
    lines.push(`Your x402 wallet credit is too low.`)
    lines.push(`  Current balance:   $${body.currentBalanceUsd.toFixed(4)} USD`)
    if (body.minimumBalanceUsd !== undefined) {
      lines.push(`  Minimum required:  $${body.minimumBalanceUsd.toFixed(4)} USD`)
    }
    if (body.suggestedTopUpUsd !== undefined) {
      lines.push(`  Suggested top-up:  $${body.suggestedTopUpUsd.toFixed(2)} USD`)
    }
    lines.push('')
    lines.push('To top up:')
    if (body.topUpInstructions) {
      lines.push(`  1. ${body.topUpInstructions.step1 ?? 'POST /api/v1/x402/top-up with no payment header to get requirements'}`)
      lines.push(`  2. ${body.topUpInstructions.step2 ?? 'Sign a USDC transfer authorization with the x402 SDK'}`)
      lines.push(`  3. ${body.topUpInstructions.step3 ?? 'POST /api/v1/x402/top-up with X-402-Payment header'}`)
      if (body.topUpInstructions.receiverWallet) {
        lines.push(`  Receiver: ${body.topUpInstructions.receiverWallet}`)
      }
      if (body.topUpInstructions.network) {
        lines.push(`  Network:  ${body.topUpInstructions.network}`)
      }
    }
    return lines.join('\n')
  }

  // Case 2: no auth at all (discovery)
  if (body.authOptions) {
    lines.push('Authentication required. Two options:')
    lines.push('')
    lines.push('Option A — API key (simple)')
    lines.push(`  Set VENICE_API_KEY in this MCP server's env.`)
    if (body.authOptions.apiKey?.getKey) {
      lines.push(`  Get a key: ${body.authOptions.apiKey.getKey}`)
    }
    lines.push('')
    lines.push('Option B — x402 wallet (no account)')
    lines.push('  1. Generate a SIWE message + signature with your wallet.')
    lines.push('  2. Set VENICE_SIWX_TOKEN in this MCP server\'s env.')
    lines.push('  3. Top up via POST /api/v1/x402/top-up (the venice_x402_balance')
    lines.push('     and venice_x402_top_up_info tools can help).')
    if (body.authOptions.x402Wallet?.docs) {
      lines.push(`  Docs: ${body.authOptions.x402Wallet.docs}`)
    }
    return lines.join('\n')
  }

  // Case 3: x402 v2 PaymentRequired — newer protocol carrying `accepts[]`.
  // The live Venice POST /v1/x402/top-up discovery returns this shape; we must
  // surface each payment requirement so an agent can complete a wallet top-up.
  if (isX402V2Body(body)) {
    return formatX402V2(body)
  }

  // Avoid reflecting unexpected upstream bodies; they may contain implementation details.
  lines.push('Payment is required, but Venice returned an unrecognized payment response.')
  return lines.join('\n')
}

/** USDC has 6 decimals on every chain Venice uses (base, base-sepolia, etc.). */
const USDC_DECIMALS = 6

/** Render an x402 v2 PaymentRequired body as human-readable payment instructions. */
function formatX402V2(body: X402V2PaymentRequired): string {
  const lines: string[] = []
  lines.push('⚠️ Venice returned 402 Payment Required.')
  lines.push('')
  lines.push(`x402 protocol v2 — payment is required to access this resource.`)
  if (body.error) {
    lines.push(`Reason: ${body.error}`)
  }
  if (body.resource?.url) {
    lines.push(`Resource: ${body.resource.url}`)
  }
  if (body.resource?.description) {
    lines.push(`  ${body.resource.description}`)
  }
  lines.push('')

  const reqs = body.accepts ?? []
  if (reqs.length === 0) {
    lines.push('Venice advertised no acceptable payment methods.')
    return lines.join('\n')
  }

  lines.push(`Accepted payment method${reqs.length > 1 ? 's' : ''} (${reqs.length}):`)
  lines.push('')
  reqs.forEach((req, i) => {
    const tag = reqs.length > 1 ? ` [${i + 1}]` : ''
    const scheme = req.scheme ?? 'exact'
    const network = req.network ?? 'unknown'
    lines.push(`Payment${tag} — scheme=${scheme}, network=${network}`)

    if (typeof req.amount === 'string' && req.amount !== '') {
      const usd = baseUnitsToUsd(req.amount)
      if (usd !== null) {
        lines.push(`  Amount:   $${usd.toFixed(6)} USD (${req.amount} base units)`)
      } else {
        lines.push(`  Amount:   ${req.amount} base units`)
      }
    }
    if (req.asset) {
      const label = req.extra?.name ? `${req.extra.name}${req.extra.version ? ` v${req.extra.version}` : ''}` : 'token'
      lines.push(`  Asset:    ${req.asset} (${label})`)
    }
    if (req.payTo) {
      lines.push(`  Pay to:   ${req.payTo}`)
    }
    if (typeof req.maxTimeoutSeconds === 'number') {
      lines.push(`  Timeout:  ${req.maxTimeoutSeconds}s`)
    }
    if (req.extra?.assetTransferMethod) {
      lines.push(`  Transfer: ${req.extra.assetTransferMethod}`)
    }
    lines.push('')
  })

  lines.push('To pay:')
  lines.push('  1. Pick an accepted method above.')
  lines.push('  2. Sign a USDC transfer authorization with the x402 SDK for that')
  lines.push('     network, asset, payTo, and amount (use the base-units value).')
  lines.push('  3. Retry the Venice request with the PAYMENT-SIGNATURE header set to')
  lines.push('     the base64-encoded x402 PaymentPayload.')
  return lines.join('\n')
}

/** Convert an x402 v2 `amount` (atomic USDC base units) to USD, or null if not a number. */
function baseUnitsToUsd(amount: string): number | null {
  const units = Number(amount)
  if (!Number.isFinite(units)) return null
  return units / 10 ** USDC_DECIMALS
}

/** Convert any thrown error into a structured MCP-tool error string. */
export function formatToolError(err: unknown): string {
  if (err instanceof VeniceUpstreamError) {
    if (err.isPaymentRequired) return format402(err)
    return `Venice API error ${err.status}: upstream request failed.`
  }
  if (err instanceof Error) return `Error: ${err.message}`
  return `Error: ${String(err)}`
}

/** Truncate large strings for safe inclusion in tool responses. */
export function truncate(s: string, max = 8000): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

export const ASR_TIMESTAMP_DEFAULT_LIMIT = 200
export const ASR_TIMESTAMP_MAX_LIMIT = 500

const ASR_TIMESTAMP_ARRAY_KEYS = ['word', 'segment', 'char'] as const

export interface AsrUpstreamBody {
  text?: string
  transcription?: string
  duration?: number
  timestamps?: unknown
}

/** Keep the transcript and a bounded page of timestamp arrays for MCP responses. */
export function boundAsrResult(
  resp: AsrUpstreamBody,
  offset = 0,
  limit = ASR_TIMESTAMP_DEFAULT_LIMIT,
): { text: string; structured: Record<string, unknown> } {
  const transcript = resp.text ?? resp.transcription ?? ''
  const structured: Record<string, unknown> = {}
  if (resp.text !== undefined) structured.text = truncate(resp.text)
  else if (resp.transcription !== undefined) structured.text = truncate(resp.transcription)
  if (resp.duration !== undefined) structured.duration = resp.duration
  if (resp.timestamps !== undefined) Object.assign(structured, pageAsrTimestamps(resp.timestamps, offset, limit))
  return { text: transcript || JSON.stringify(structured, null, 2), structured }
}

function pageAsrTimestamps(raw: unknown, offset: number, limit: number): Record<string, unknown> {
  const meta = { timestamp_offset: offset, timestamp_limit: limit }

  if (Array.isArray(raw)) {
    return {
      timestamps: raw.slice(offset, offset + limit),
      ...meta,
      timestamp_total: raw.length,
      timestamps_truncated: offset > 0 || raw.length > offset + limit,
    }
  }

  if (isObject(raw)) {
    const timestamps: Record<string, unknown> = {}
    const totals: Record<string, number> = {}
    let pagedAny = false
    let truncated = offset > 0

    for (const key of ASR_TIMESTAMP_ARRAY_KEYS) {
      const value = raw[key]
      if (!Array.isArray(value)) continue
      pagedAny = true
      totals[key] = value.length
      timestamps[key] = value.slice(offset, offset + limit)
      if (value.length > offset + limit) truncated = true
    }

    if (pagedAny) {
      return {
        timestamps,
        ...meta,
        timestamp_total: totals,
        timestamps_truncated: truncated,
      }
    }

    return { ...meta, timestamps_omitted: true, timestamps_truncated: true }
  }

  return { ...meta, timestamps_omitted: true, timestamps_truncated: true }
}
