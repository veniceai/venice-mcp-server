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
      Accept: 'application/json',
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
    const timeout = setTimeout(() => ac.abort(), init.timeoutMs ?? this.cfg.timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        signal: ac.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      if ((err as Error).name === 'AbortError') {
        throw new VeniceUpstreamError({
          message: `Upstream request timed out after ${init.timeoutMs ?? this.cfg.timeoutMs}ms`,
          status: 504,
          body: { error: 'timeout' },
        })
      }
      throw err
    }
    clearTimeout(timeout)

    const contentType = res.headers.get('content-type') ?? ''
    let body: unknown
    if (contentType.includes('application/json')) {
      body = await res.json().catch(() => ({}))
    } else {
      body = await res.text().catch(() => '')
    }

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
    return body as T
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
