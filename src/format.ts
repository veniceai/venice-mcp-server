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

  // Fallback: dump the raw 402 body.
  lines.push('Raw response from Venice:')
  lines.push('```json')
  lines.push(JSON.stringify(err.body, null, 2))
  lines.push('```')
  return lines.join('\n')
}

/** Convert any thrown error into a structured MCP-tool error string. */
export function formatToolError(err: unknown): string {
  if (err instanceof VeniceUpstreamError) {
    if (err.isPaymentRequired) return format402(err)
    const bodyStr = typeof err.body === 'string' ? err.body : JSON.stringify(err.body)
    return `Venice API error ${err.status}: ${bodyStr}`
  }
  if (err instanceof Error) return `Error: ${err.message}`
  return `Error: ${String(err)}`
}

/** Truncate large strings for safe inclusion in tool responses. */
export function truncate(s: string, max = 8000): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}
