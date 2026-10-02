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
  /** Reject a successful response body larger than this many bytes. */
  maxBytes?: number
}

export interface VeniceResponse<T> {
  data: T
  status: number
  contentType: string
  headers: Record<string, string>
}

export interface VeniceBinaryResponse {
  buffer: Buffer
  status: number
  contentType: string
  headers: Record<string, string>
}

export type VeniceMixedResponse<T> =
  | ({ kind: 'json' } & VeniceResponse<T>)
  | ({ kind: 'binary' } & VeniceBinaryResponse)

export class VeniceResponseTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly maxBytes: number,
  ) {
    super(`Venice response on ${path} exceeds the configured ${maxBytes}-byte limit`)
    this.name = 'VeniceResponseTooLargeError'
  }
}

export class VeniceMalformedResponseError extends Error {
  constructor(readonly path: string) {
    super(
      `Venice returned an unreadable JSON response on ${path}. The request may have completed upstream and been charged; check its result before retrying.`,
    )
    this.name = 'VeniceMalformedResponseError'
  }
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
    return (await this.requestWithMetadata<T>(path, init)).data
  }

  /**
   * Request JSON/text while retaining response headers and status. Existing
   * request/get/post methods intentionally continue to return only the body.
   */
  async requestWithMetadata<T = unknown>(
    path: string,
    init: RequestInitJSON = {},
  ): Promise<VeniceResponse<T>> {
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
    const timeoutMs = init.timeoutMs ?? this.cfg.timeoutMs
    // The timer stays armed until the body is consumed so a stalled body cannot hang the call.
    const timeout = setTimeout(() => ac.abort(), timeoutMs)
    let res: Response
    let contentType: string
    let body: unknown
    try {
      res = await fetch(url, {
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        signal: ac.signal,
      })
      contentType = res.headers.get('content-type') ?? ''
      if (!res.ok) throw await upstreamError(res, path, init.maxBytes)
      const text =
        init.maxBytes !== undefined
          ? (await readBoundedResponseBuffer(res, path, init.maxBytes)).toString('utf8')
          : await res.text()
      if (ac.signal.aborted) throw timeoutError(timeoutMs)
      body = isJsonContentType(contentType) ? parseSuccessJson(text, path) : text
    } catch (err) {
      throw classifyRequestError(err, ac.signal, timeoutMs)
    } finally {
      clearTimeout(timeout)
    }

    return {
      data: body as T,
      status: res.status,
      contentType,
      headers: responseHeaders(res),
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

  /** POST JSON while retaining response metadata such as Venice extension headers. */
  postWithMetadata<T = unknown>(
    path: string,
    json: unknown,
    headers?: Record<string, string>,
    opts: Pick<RequestInitJSON, 'maxBytes'> = {},
  ): Promise<VeniceResponse<T>> {
    return this.requestWithMetadata<T>(path, { method: 'POST', json, headers, ...opts })
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
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs
    // The timer stays armed until the body is consumed so a stalled body cannot hang the call.
    const timeout = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, { method: 'POST', headers, body: form, signal: ac.signal })
      const body = await parseResponse<T>(res, path)
      if (ac.signal.aborted) throw timeoutError(timeoutMs)
      return body
    } catch (err) {
      throw classifyRequestError(err, ac.signal, timeoutMs)
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
    opts: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<VeniceBinaryResponse> {
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
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs
    const timeout = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal })
      if (!res.ok) throw await upstreamError(res, path, opts.maxBytes)

      const buffer = await readBoundedResponseBuffer(res, path, opts.maxBytes)
      return {
        buffer,
        status: res.status,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        headers: responseHeaders(res),
      }
    } catch (err) {
      throw classifyRequestError(err, ac.signal, timeoutMs)
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * POST to an endpoint whose success response may be JSON or binary. Venice's
   * video retrieval endpoint uses JSON while processing and video/mp4 when done.
   */
  async postMixed<T = unknown>(
    path: string,
    json: unknown,
    opts: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<VeniceMixedResponse<T>> {
    const response = await this.postBinary(path, { method: 'POST', json }, opts)
    if (isJsonContentType(response.contentType)) {
      return {
        kind: 'json',
        data: parseSuccessJson(response.buffer.toString('utf8'), path) as T,
        status: response.status,
        contentType: response.contentType,
        headers: response.headers,
      }
    }
    return { kind: 'binary', ...response }
  }
}

async function readBoundedResponseBuffer(
  res: Response,
  path: string,
  maxBytes?: number,
): Promise<Buffer> {
  if (maxBytes === undefined) return Buffer.from(await res.arrayBuffer())

  const contentLength = res.headers.get('content-length')
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await res.body?.cancel()
      throw new VeniceResponseTooLargeError(path, maxBytes)
    }
  }

  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new VeniceResponseTooLargeError(path, maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

/** Parse a 2xx JSON body. Empty bodies stay `{}`; anything else unparseable is an error, never a silent `{}`. */
function parseSuccessJson(text: string, path: string): unknown {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new VeniceMalformedResponseError(path)
  }
}

function timeoutError(timeoutMs: number): VeniceUpstreamError {
  return new VeniceUpstreamError({
    message: `Upstream request timed out after ${timeoutMs}ms`,
    status: 504,
    body: { error: 'timeout' },
  })
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('application/json')
}

/**
 * Build the error for a non-2xx response. The HTTP status is authoritative:
 * an unreadable, oversized, or aborted error body degrades to an empty body
 * rather than turning the failure into a timeout or size-limit error.
 */
async function upstreamError(res: Response, path: string, maxBytes?: number): Promise<VeniceUpstreamError> {
  const json = isJsonContentType(res.headers.get('content-type') ?? '')
  let body: unknown = json ? {} : ''
  try {
    const text = (await readBoundedResponseBuffer(res, path, maxBytes)).toString('utf8')
    if (!json) body = text
    else if (text.trim()) body = JSON.parse(text)
  } catch {}
  return new VeniceUpstreamError({
    message: `Venice ${res.status} on ${path}`,
    status: res.status,
    body,
    headers: responseHeaders(res),
  })
}

/** Errors this client already classified pass through unchanged; only an unclassified abort becomes a timeout. */
function classifyRequestError(err: unknown, signal: AbortSignal, timeoutMs: number): unknown {
  if (
    err instanceof VeniceUpstreamError ||
    err instanceof VeniceMalformedResponseError ||
    err instanceof VeniceResponseTooLargeError
  ) {
    return err
  }
  if (signal.aborted || (err as Error).name === 'AbortError') return timeoutError(timeoutMs)
  return err
}

function responseHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })
  return headers
}

/**
 * Response parser used by `postMultipart`.
 * Handles JSON vs text content, surfaces 402 / 4xx / 5xx as VeniceUpstreamError.
 */
async function parseResponse<T>(res: Response, path: string): Promise<T> {
  if (!res.ok) throw await upstreamError(res, path)
  const text = await res.text()
  return (isJsonContentType(res.headers.get('content-type') ?? '') ? parseSuccessJson(text, path) : text) as T
}
