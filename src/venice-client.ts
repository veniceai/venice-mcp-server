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

const MAX_MIXED_JSON_RESPONSE_BYTES = 1024 * 1024
const MAX_UPSTREAM_ERROR_RESPONSE_BYTES = 64 * 1024

export class VeniceResponseTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly maxBytes: number,
  ) {
    super(`Venice response on ${path} exceeds the configured ${maxBytes}-byte limit`)
    this.name = 'VeniceResponseTooLargeError'
  }
}

export class VeniceJsonResponseTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly maxBytes: number,
  ) {
    super(`Venice JSON response on ${path} exceeds the fixed ${maxBytes}-byte safety limit`)
    this.name = 'VeniceJsonResponseTooLargeError'
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
  post<T = unknown>(
    path: string,
    json: unknown,
    headers?: Record<string, string>,
    opts: Pick<RequestInitJSON, 'auth' | 'timeoutMs'> = {},
  ): Promise<T> {
    return this.request<T>(path, { method: 'POST', json, headers, ...opts })
  }

  /** POST JSON while retaining response metadata such as Venice extension headers. */
  postWithMetadata<T = unknown>(
    path: string,
    json: unknown,
    headers?: Record<string, string>,
  ): Promise<VeniceResponse<T>> {
    return this.requestWithMetadata<T>(path, { method: 'POST', json, headers })
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
    opts: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<VeniceBinaryResponse> {
    return this.postBuffered(path, init, opts, false)
  }

  /**
   * POST to an endpoint whose success response may be JSON or binary. Venice's
   * media retrieval endpoints use JSON while processing and binary when done.
   * Successful JSON and error responses use separate fixed safety limits so
   * the configured media limit applies only to a successful binary response.
   */
  async postMixed<T = unknown>(
    path: string,
    json: unknown,
    opts: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<VeniceMixedResponse<T>> {
    const response = await this.postBuffered(path, { method: 'POST', json }, opts, true)
    if (response.contentType.includes('application/json')) {
      return {
        kind: 'json',
        data: JSON.parse(response.buffer.toString('utf8')) as T,
        status: response.status,
        contentType: response.contentType,
        headers: response.headers,
      }
    }
    return { kind: 'binary', ...response }
  }

  private async postBuffered(
    path: string,
    init: RequestInitJSON | { form: FormData },
    opts: { timeoutMs?: number; maxBytes?: number },
    mixedResponse: boolean,
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
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
      if (!res.ok) {
        const { buffer, truncated } = await readTruncatedResponseBuffer(
          res,
          MAX_UPSTREAM_ERROR_RESPONSE_BYTES,
        )
        let errBody: unknown
        if (truncated) {
          errBody = {
            error: 'upstream_error_body_truncated',
            truncated: true,
            max_bytes: MAX_UPSTREAM_ERROR_RESPONSE_BYTES,
          }
        } else if (contentType.includes('application/json')) {
          try {
            errBody = JSON.parse(buffer.toString('utf8'))
          } catch {
            errBody = {}
          }
        } else {
          errBody = buffer.toString('utf8')
        }
        throw new VeniceUpstreamError({
          message: `Venice ${res.status} on ${path}`,
          status: res.status,
          body: errBody,
          headers: responseHeaders(res),
        })
      }
      const jsonSuccess = mixedResponse && contentType.includes('application/json')
      let buffer: Buffer
      try {
        buffer = await readBoundedResponseBuffer(
          res,
          path,
          jsonSuccess ? MAX_MIXED_JSON_RESPONSE_BYTES : opts.maxBytes,
        )
      } catch (err) {
        if (jsonSuccess && err instanceof VeniceResponseTooLargeError) {
          throw new VeniceJsonResponseTooLargeError(path, MAX_MIXED_JSON_RESPONSE_BYTES)
        }
        throw err
      }
      return {
        buffer,
        status: res.status,
        contentType,
        headers: responseHeaders(res),
      }
    } catch (err) {
      if (ac.signal.aborted || (err as Error).name === 'AbortError') {
        throw new VeniceUpstreamError({
          message: `Upstream request timed out after ${timeoutMs}ms`,
          status: 504,
          body: { error: 'timeout' },
        })
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
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

async function readTruncatedResponseBuffer(
  res: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const contentLength = res.headers.get('content-length')
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await res.body?.cancel()
      return { buffer: Buffer.alloc(0), truncated: true }
    }
  }

  if (!res.body) return { buffer: Buffer.alloc(0), truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return { buffer: Buffer.concat(chunks, total), truncated: false }

      const remaining = maxBytes - total
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining))
        total = maxBytes
        await reader.cancel()
        return { buffer: Buffer.concat(chunks, total), truncated: true }
      }

      chunks.push(value)
      total += value.byteLength
      if (total === maxBytes) {
        const next = await reader.read()
        if (next.done) return { buffer: Buffer.concat(chunks, total), truncated: false }
        await reader.cancel()
        return { buffer: Buffer.concat(chunks, total), truncated: true }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function responseHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })
  return headers
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
