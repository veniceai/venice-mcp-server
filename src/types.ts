/** Canonical error wrapping for upstream failures. */
export class VeniceUpstreamError extends Error {
  readonly status: number
  readonly body: unknown
  readonly headers: Record<string, string>
  /** True when the upstream returned 402 Payment Required (x402). */
  readonly isPaymentRequired: boolean

  constructor(opts: {
    message: string
    status: number
    body: unknown
    headers?: Record<string, string>
  }) {
    super(opts.message)
    this.name = 'VeniceUpstreamError'
    this.status = opts.status
    this.body = opts.body
    this.headers = opts.headers ?? {}
    this.isPaymentRequired = opts.status === 402
  }
}

export interface VeniceMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
