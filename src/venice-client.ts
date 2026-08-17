import type { Config } from './config.js'
import { VeniceUpstreamError } from './types.js'

export interface RequestInitJSON {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Plain JSON body; will be stringified. */
  json?: unknown
  /** Extra headers (merged on top of defaults). */
  headers?: Record<string, string>
  /** Override request timeout for this call. */
  timeoutMs?: number
  /** Override default API-key-first auth behavior for endpoint-specific requirements. */
  auth?: 'default' | 'siwx' | 'none'
  /** Require and return an upstream SSE response as one unmodified UTF-8 string. */
  responseType?: 'auto' | 'event-stream'
}

/**
 * Thin HTTP client over the Venice API.
 * - Adds `Authorization: Bearer` when API key is configured (preferred).
 * - Otherwise adds `X-Sign-In-With-X` when a SIWX token is configured.
 * - Surfaces 402 responses as `VeniceUpstreamError(isPaymentRequired)` so tools
 *   can format a helpful top-up message back to the MCP host.
 *
 * We deliberately never set `X-402-Payment` on inference routes; Venice
 * rejects that header outside `/x402/top-up`.
 */
export class VeniceClient {
  constructor(private readonly cfg: Config) {}

  async request<T = unknown>(path: string, init: RequestInitJSON = {}): Promise<T> {
    const url = `${this.cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const headers: Record<string, string> = {
      Accept: init.responseType === 'event-stream' ? 'text/event-stream' : 'application/json',
      'User-Agent': `${this.cfg.serverName}/${this.cfg.serverVersion}`,
      ...(init.headers ?? {}),
    }
    if (init.json !== undefined) headers['Content-Type'] = 'application/json'
    const auth = init.auth ?? 'default'
    if (auth === 'siwx') {
      delete headers.Authorization
      delete headers.authorization
      if (this.cfg.siwxToken && !headers['X-Sign-In-With-X']) {
        headers['X-Sign-In-With-X'] = this.cfg.siwxToken
      }
    } else if (auth === 'default' && this.cfg.apiKey && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.cfg.apiKey}`
    } else if (auth === 'default' && this.cfg.siwxToken && !headers['X-Sign-In-With-X']) {
      headers['X-Sign-In-With-X'] = this.cfg.siwxToken
    }

    const ac = new AbortController()
    const timeoutMs = init.timeoutMs ?? this.cfg.timeoutMs
    const timeout = setTimeout(() => ac.abort(), timeoutMs)
    let headersReceived = false
    try {
      const res = await fetch(url, {
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        signal: ac.signal,
      })
      headersReceived = true

      const contentType = res.headers.get('content-type') ?? ''
      const mediaType = normalizeMediaType(contentType)
      const body = await readResponseBody(res, mediaType)

      // Error responses are parsed according to their actual content type before
      // applying successful-response SSE requirements. This preserves structured
      // JSON 402 bodies for the existing payment diagnostics.
      if (!res.ok) {
        const headerObj: Record<string, string> = {}
        res.headers.forEach((v, k) => {
          headerObj[k] = v
        })
        throw new VeniceUpstreamError({
          message: `Venice ${res.status} on ${path}`,
          status: res.status,
          body,
          headers: headerObj,
        })
      }
      if (init.responseType === 'event-stream') {
        if (mediaType !== 'text/event-stream') {
          throw new VeniceUpstreamError({
            message: `Venice returned ${contentType || 'an unknown content type'} instead of text/event-stream on ${path}`,
            status: 502,
            body,
          })
        }
        if (typeof body !== 'string' || !hasTerminalDoneEvent(body)) {
          throw new VeniceUpstreamError({
            message: `Venice E2EE stream ended without a terminal "data: [DONE]" event on ${path}; the encrypted response may be incomplete`,
            status: 502,
            body: { error: 'incomplete_event_stream' },
          })
        }
      }
      return body as T
    } catch (err) {
      if (err instanceof VeniceUpstreamError) throw err
      if (ac.signal.aborted || (err as Error).name === 'AbortError') {
        throw new VeniceUpstreamError({
          message: `Upstream request timed out after ${timeoutMs}ms`,
          status: 504,
          body: { error: 'timeout' },
        })
      }
      if (headersReceived) {
        throw new VeniceUpstreamError({
          message: `Failed to read Venice response body on ${path}`,
          status: 502,
          body: { error: 'response_body_read_failed' },
        })
      }
      throw err
    } finally {
      // The timeout covers both fetching headers and fully consuming the body.
      // This is the only cleanup site, so every success/error path clears once.
      clearTimeout(timeout)
    }
  }

  /** GET request returning JSON. */
  get<T = unknown>(
    path: string,
    headers?: Record<string, string>,
    opts: { auth?: RequestInitJSON['auth']; timeoutMs?: number } = {},
  ): Promise<T> {
    return this.request<T>(path, { method: 'GET', headers, ...opts })
  }

  /** POST request with JSON body. */
  post<T = unknown>(path: string, json: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>(path, { method: 'POST', json, headers })
  }

  /**
   * POST JSON and preserve the complete SSE response as UTF-8 text.
   * No SSE framing or data payload is parsed or normalized.
   */
  postEventStream(path: string, json: unknown, headers?: Record<string, string>): Promise<string> {
    return this.request<string>(path, {
      method: 'POST',
      json,
      headers,
      responseType: 'event-stream',
    })
  }

  /**
   * POST a multipart/form-data body. Used by endpoints that require file upload
   * (image/edit, image/upscale, image/multi-edit, image/background-remove,
   * audio/transcriptions, audio/voices, augment/text-parser).
   *
   * Caller passes a pre-built `FormData` instance; this helper wires up auth
   * headers and surfaces the upstream response identically to `post`.
   */
  async postMultipart<T = unknown>(path: string, form: FormData, opts: { timeoutMs?: number } = {}): Promise<T> {
    const url = `${this.cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `${this.cfg.serverName}/${this.cfg.serverVersion}`,
    }
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`
    else if (this.cfg.siwxToken) headers['X-Sign-In-With-X'] = this.cfg.siwxToken
    // NOTE: don't set Content-Type — fetch sets the boundary automatically.

    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? this.cfg.timeoutMs)
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: form, signal: ac.signal })
    } catch (err) {
      clearTimeout(timeout)
      if ((err as Error).name === 'AbortError') {
        throw new VeniceUpstreamError({
          message: `Upstream request timed out after ${opts.timeoutMs ?? this.cfg.timeoutMs}ms`,
          status: 504,
          body: { error: 'timeout' },
        })
      }
      throw err
    }
    clearTimeout(timeout)

    return parseResponse<T>(res, path)
  }

  /**
   * POST and return the raw response Buffer + content-type. Used for endpoints
   * that return binary image streams (image/edit, image/upscale, image/multi-edit,
   * image/background-remove). Caller decides what to do with the bytes
   * (typically: encode as base64 image content for MCP).
   */
  async postBinary(
    path: string,
    init: RequestInitJSON | { form: FormData },
    opts: { timeoutMs?: number } = {},
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const url = `${this.cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const headers: Record<string, string> = {
      'User-Agent': `${this.cfg.serverName}/${this.cfg.serverVersion}`,
    }
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`
    else if (this.cfg.siwxToken) headers['X-Sign-In-With-X'] = this.cfg.siwxToken

    let body: any
    if ('form' in init) {
      body = init.form
    } else {
      headers['Content-Type'] = 'application/json'
      Object.assign(headers, init.headers ?? {})
      body = init.json !== undefined ? JSON.stringify(init.json) : undefined
    }

    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? this.cfg.timeoutMs)
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal })
    } catch (err) {
      clearTimeout(timeout)
      if ((err as Error).name === 'AbortError') {
        throw new VeniceUpstreamError({
          message: `Upstream request timed out after ${opts.timeoutMs ?? this.cfg.timeoutMs}ms`,
          status: 504,
          body: { error: 'timeout' },
        })
      }
      throw err
    }
    clearTimeout(timeout)

    if (!res.ok) {
      // For errors, still parse as JSON so we get a useful error body
      const ct = res.headers.get('content-type') ?? ''
      let errBody: unknown
      if (ct.includes('application/json')) errBody = await res.json().catch(() => ({}))
      else errBody = await res.text().catch(() => '')
      const headerObj: Record<string, string> = {}
      res.headers.forEach((v, k) => (headerObj[k] = v))
      throw new VeniceUpstreamError({
        message: `Venice ${res.status} on ${path}`,
        status: res.status,
        body: errBody,
        headers: headerObj,
      })
    }

    const ab = await res.arrayBuffer()
    return { buffer: Buffer.from(ab), contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
  }
}

function normalizeMediaType(contentType: string): string {
  return contentType.split(';', 1)[0].trim().toLowerCase()
}

async function readResponseBody(res: Response, mediaType: string): Promise<unknown> {
  // Do not catch body-read errors here. A stalled, truncated, or erroring body
  // must reject so request() can map aborts to 504 and other read failures to
  // a safe 502 instead of manufacturing an empty successful response.
  const text = await res.text()
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    try {
      return text.length > 0 ? JSON.parse(text) : {}
    } catch {
      return {}
    }
  }
  return text
}

function hasTerminalDoneEvent(rawSse: string): boolean {
  // Parse only a copy for completeness validation. The original SSE string is
  // returned untouched. SSE recognizes CRLF, CR, and LF as line endings.
  const normalized = rawSse.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const boundary = /\n\n+/g
  let start = 0
  let lastDataEvent: string | undefined
  let match: RegExpExecArray | null
  while ((match = boundary.exec(normalized)) !== null) {
    const block = normalized.slice(start, match.index)
    start = boundary.lastIndex
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      if (field !== 'data') continue
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      dataLines.push(value)
    }
    if (dataLines.length > 0) lastDataEvent = dataLines.join('\n')
  }
  return lastDataEvent === '[DONE]'
}

/**
 * Shared response parser used by `request` and `postMultipart`.
 * Handles JSON vs text content, surfaces 402 / 4xx / 5xx as VeniceUpstreamError.
 */
async function parseResponse<T>(res: Response, path: string): Promise<T> {
  const contentType = res.headers.get('content-type') ?? ''
  let body: unknown
  if (contentType.includes('application/json')) {
    body = await res.json().catch(() => ({}))
  } else {
    body = await res.text().catch(() => '')
  }
  if (!res.ok) {
    const headerObj: Record<string, string> = {}
    res.headers.forEach((v, k) => (headerObj[k] = v))
    throw new VeniceUpstreamError({
      message: `Venice ${res.status} on ${path}`,
      status: res.status,
      body,
      headers: headerObj,
    })
  }
  return body as T
}
