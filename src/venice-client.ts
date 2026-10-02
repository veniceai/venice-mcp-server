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
  auth?: 'default' | 'apiKey' | 'siwx' | 'none'
  /** Observe response metadata without changing the existing body-only return type. */
  onResponse?: (metadata: ResponseMetadata) => void
}

export interface ResponseMetadata {
  status: number
  headers: Record<string, string>
}

/**
 * Thin HTTP client over the Venice API.
 * - Adds `Authorization: Bearer` when API key is configured (preferred).
 * - Otherwise adds the canonical `SIGN-IN-WITH-X` when a SIWX token is configured.
 * - Surfaces 402 responses as `VeniceUpstreamError(isPaymentRequired)` so tools
 *   can format a helpful top-up message back to the MCP host.
 *
 * We deliberately never set a payment header. Payment submission belongs only
 * on `/x402/top-up`, and this client currently exposes discovery—not settlement.
 */
export class VeniceClient {
  constructor(private readonly cfg: Config) {}

  async request<T = unknown>(path: string, init: RequestInitJSON = {}): Promise<T> {
    const url = `${this.cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `${this.cfg.serverName}/${this.cfg.serverVersion}`,
      ...(init.headers ?? {}),
    }
    if (init.json !== undefined) headers['Content-Type'] = 'application/json'
    const auth = init.auth ?? 'default'
    if (auth === 'apiKey') {
      for (const key of Object.keys(headers)) {
        if (
          [
            'authorization',
            'sign-in-with-x',
            'x-sign-in-with-x',
            'payment-signature',
            'x-402-payment',
            'x-payment',
          ].includes(key.toLowerCase())
        ) {
          delete headers[key]
        }
      }
      if (!this.cfg.apiKey) {
        throw new Error('VENICE_API_KEY is required for this API-key-only endpoint.')
      }
      headers.Authorization = `Bearer ${this.cfg.apiKey}`
    } else if (auth === 'siwx') {
      delete headers.Authorization
      delete headers.authorization
      if (this.cfg.siwxToken && !headers['SIGN-IN-WITH-X']) {
        headers['SIGN-IN-WITH-X'] = this.cfg.siwxToken
      }
    } else if (auth === 'default' && this.cfg.apiKey && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.cfg.apiKey}`
    } else if (auth === 'default' && this.cfg.siwxToken && !headers['SIGN-IN-WITH-X']) {
      headers['SIGN-IN-WITH-X'] = this.cfg.siwxToken
    }

    const timeoutMs = init.timeoutMs ?? this.cfg.timeoutMs
    // The timer stays armed until the body is fully read: a 200 whose body
    // stalls after the headers must still time out.
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
          headers,
          body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
          signal: ac.signal,
        },
        timeoutMs,
      )

      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      init.onResponse?.({ status: res.status, headers: responseHeaders })

      const body = await readBody(res, ac.signal, timeoutMs)
      if (!res.ok) {
        throw new VeniceUpstreamError({
          message: `Venice ${res.status} on ${path}`,
          status: res.status,
          body,
          headers: responseHeaders,
        })
      }
      return body as T
    } finally {
      clearTimeout(timeout)
    }
  }

  /** GET request returning JSON. */
  get<T = unknown>(
    path: string,
    headers?: Record<string, string>,
    opts: Pick<RequestInitJSON, 'auth' | 'timeoutMs' | 'onResponse'> = {},
  ): Promise<T> {
    return this.request<T>(path, { method: 'GET', headers, ...opts })
  }

  /** POST request with JSON body. */
  post<T = unknown>(
    path: string,
    json: unknown,
    headers?: Record<string, string>,
    opts: Pick<RequestInitJSON, 'auth' | 'timeoutMs' | 'onResponse'> = {},
  ): Promise<T> {
    return this.request<T>(path, { method: 'POST', json, headers, ...opts })
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
    else if (this.cfg.siwxToken) headers['SIGN-IN-WITH-X'] = this.cfg.siwxToken
    // NOTE: don't set Content-Type — fetch sets the boundary automatically.

    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetchWithTimeout(url, { method: 'POST', headers, body: form, signal: ac.signal }, timeoutMs)
      return await parseResponse<T>(res, path, ac.signal, timeoutMs)
    } finally {
      clearTimeout(timeout)
    }
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
    else if (this.cfg.siwxToken) headers['SIGN-IN-WITH-X'] = this.cfg.siwxToken

    let body: any
    if ('form' in init) {
      body = init.form
    } else {
      headers['Content-Type'] = 'application/json'
      Object.assign(headers, init.headers ?? {})
      body = init.json !== undefined ? JSON.stringify(init.json) : undefined
    }

    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetchWithTimeout(url, { method: 'POST', headers, body, signal: ac.signal }, timeoutMs)

      if (!res.ok) {
        // For errors, still parse as JSON so we get a useful error body
        const errBody = await readBody(res, ac.signal, timeoutMs)
        const headerObj: Record<string, string> = {}
        res.headers.forEach((v, k) => (headerObj[k] = v))
        throw new VeniceUpstreamError({
          message: `Venice ${res.status} on ${path}`,
          status: res.status,
          body: errBody,
          headers: headerObj,
        })
      }

      let ab: ArrayBuffer
      try {
        ab = await res.arrayBuffer()
      } catch (err) {
        if (ac.signal.aborted) throw timeoutError(timeoutMs)
        throw err
      }
      return { buffer: Buffer.from(ab), contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
    } finally {
      clearTimeout(timeout)
    }
  }
}

function timeoutError(timeoutMs: number): VeniceUpstreamError {
  return new VeniceUpstreamError({
    message: `Upstream request timed out after ${timeoutMs}ms`,
    status: 504,
    body: { error: 'timeout' },
  })
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw timeoutError(timeoutMs)
    throw err
  }
}

/**
 * Read a JSON or text body. An unreadable body degrades to `{}` / `''`, but a
 * body cut off by the request timeout surfaces as a 504 so callers can tell a
 * stalled response from an empty one.
 */
async function readBody(res: Response, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
  try {
    return isJson ? await res.json() : await res.text()
  } catch {
    if (signal.aborted) throw timeoutError(timeoutMs)
    return isJson ? {} : ''
  }
}

/**
 * Shared response parser used by `postMultipart`.
 * Handles JSON vs text content, surfaces 402 / 4xx / 5xx as VeniceUpstreamError.
 */
async function parseResponse<T>(res: Response, path: string, signal: AbortSignal, timeoutMs: number): Promise<T> {
  const body = await readBody(res, signal, timeoutMs)
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
