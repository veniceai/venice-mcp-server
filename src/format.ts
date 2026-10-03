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

const MAX_TEXT_CHARS = 8000
const TRUNCATION_MARKER = '…[truncated]'
const MIN_SHORTENED_STRING_CHARS = 32
// Only these keys hold free text; anything else (ids, slugs, URLs, addresses, hashes) must stay byte-exact.
const PROSE_KEYS = new Set([
  'bio',
  'body',
  'content',
  'description',
  'firstmessage',
  'first_message',
  'greeting',
  'instructions',
  'message',
  'prompt',
  'summary',
  'systemprompt',
  'system_prompt',
  'text',
])

/** Truncate large strings for safe inclusion in tool responses. */
export function truncate(s: string, max = MAX_TEXT_CHARS): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

/**
 * Pretty-print a list as JSON within `max` chars by dropping whole trailing items.
 * When items are dropped the output becomes `{ truncated, returned, total, data }`.
 * If even the first item is too large, its prose fields are shortened so it can still be returned.
 */
export function fitJsonList(items: unknown[], max = MAX_TEXT_CHARS): { text: string; returned: number; truncated: boolean } {
  const full = JSON.stringify(items, null, 2)
  if (full.length <= max) return { text: full, returned: items.length, truncated: false }
  const envelope = (data: unknown[]) => ({ truncated: true, returned: data.length, total: items.length, data })
  const render = (n: number) => JSON.stringify(envelope(items.slice(0, n)), null, 2)
  let lo = 0
  let hi = items.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (render(mid).length <= max) lo = mid
    else hi = mid - 1
  }
  if (lo === 0 && items.length > 0) {
    const root = envelope([JSON.parse(JSON.stringify(items[0])) as unknown])
    if (shortenProse(root, max) <= max) return { text: JSON.stringify(root, null, 2), returned: 1, truncated: true }
  }
  return { text: render(lo), returned: lo, truncated: true }
}

/**
 * Shorten the longest prose strings in `root` in place until its pretty-printed JSON fits `max`
 * or nothing more can be shortened. Returns the resulting length.
 */
function shortenProse(root: unknown, max: number): number {
  const leaves: Array<{ holder: Record<string, unknown>; key: string; value: string }> = []
  const walk = (node: unknown): void => {
    if (!isObject(node)) return
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string') {
        if (!Array.isArray(node) && PROSE_KEYS.has(key.toLowerCase())) leaves.push({ holder: node, key, value: child })
      } else walk(child)
    }
  }
  walk(root)
  leaves.sort((a, b) => b.value.length - a.value.length)

  let size = JSON.stringify(root, null, 2).length
  for (const leaf of leaves) {
    if (size <= max || leaf.value.length <= MIN_SHORTENED_STRING_CHARS) break
    const keep = Math.max(MIN_SHORTENED_STRING_CHARS, leaf.value.length - (size - max) - TRUNCATION_MARKER.length)
    const shortened = `${leaf.value.slice(0, keep)}${TRUNCATION_MARKER}`
    if (shortened.length >= leaf.value.length) continue
    size -= JSON.stringify(leaf.value).length - JSON.stringify(shortened).length
    leaf.holder[leaf.key] = shortened
  }
  return size
}

/**
 * Pretty-print a value as JSON within `max` chars by shortening its longest prose strings
 * (see PROSE_KEYS), then dropping trailing items from its largest arrays if that is not enough.
 * Other strings are never modified. Object roots gain `truncated: true` when anything was shortened or dropped.
 */
export function fitJson(value: unknown, max = MAX_TEXT_CHARS): { text: string; truncated: boolean } {
  const full = JSON.stringify(value, null, 2)
  if (full.length <= max) return { text: full, truncated: false }

  const parsed: unknown = JSON.parse(full)
  const root = isObject(parsed) && !Array.isArray(parsed) ? { ...parsed, truncated: true } : parsed
  if (shortenProse(root, max) <= max) return { text: JSON.stringify(root, null, 2), truncated: true }

  const arrays: unknown[][] = []
  const collect = (node: unknown): void => {
    if (!isObject(node)) return
    if (Array.isArray(node)) arrays.push(node)
    for (const child of Object.values(node)) collect(child)
  }
  collect(root)
  arrays.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)
  for (const array of arrays) {
    const items = array.slice()
    const fits = (n: number) => {
      array.length = 0
      for (let i = 0; i < n; i++) array.push(items[i])
      return JSON.stringify(root, null, 2).length <= max
    }
    let lo = 0
    let hi = items.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fits(mid)) lo = mid
      else hi = mid - 1
    }
    if (fits(lo)) return { text: JSON.stringify(root, null, 2), truncated: true }
  }
  return {
    text: JSON.stringify({ truncated: true, error: `Response exceeds ${max} characters even after truncation.` }, null, 2),
    truncated: true,
  }
}
