import type { VeniceClient } from '../../src/venice-client.js'

export interface StubCall {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  headers?: Record<string, string>
  auth?: 'default' | 'siwx' | 'none'
  /** Whether this call went through postMultipart (FormData body) instead of JSON. */
  multipart?: boolean
  /** Whether this call went through postBinary (binary response expected). */
  binary?: boolean
}

export type StubHandler = (call: StubCall) => unknown | Promise<unknown>

/**
 * Tiny fake VeniceClient. Default routes return canned shapes. Provide
 * `overrides` to short-circuit specific paths or throw errors.
 *
 * Spies on get / post / postBinary / postMultipart so any tool flow is observable.
 */
export class StubClient {
  calls: StubCall[] = []
  constructor(private overrides: Record<string, StubHandler> = {}) {}

  private async dispatch<T>(call: StubCall): Promise<T> {
    this.calls.push(call)
    const matchKey = Object.keys(this.overrides).find((k) => call.path.startsWith(k))
    if (matchKey) {
      const out = await this.overrides[matchKey](call)
      return out as T
    }
    return (defaultResponse(call.path, call.binary) as T) ?? ({} as T)
  }

  get<T>(path: string, headers?: Record<string, string>, opts: { auth?: StubCall['auth'] } = {}) {
    return this.dispatch<T>({ method: 'GET', path, headers, auth: opts.auth })
  }
  post<T>(path: string, json: unknown) {
    return this.dispatch<T>({ method: 'POST', path, body: json })
  }
  async postWithMetadata<T>(path: string, json: unknown) {
    const output = await this.dispatch<T | {
      __stubResponse: true
      data: T
      headers?: Record<string, string>
      contentType?: string
      status?: number
    }>({ method: 'POST', path, body: json })
    if (output && typeof output === 'object' && '__stubResponse' in output) {
      return {
        data: output.data,
        status: output.status ?? 200,
        contentType: output.contentType ?? 'application/json',
        headers: output.headers ?? {},
      }
    }
    return {
      data: output as T,
      status: 200,
      contentType: 'application/json',
      headers: {},
    }
  }
  /**
   * Stub for postBinary. Tool calls expecting binary back get a synthetic
   * { buffer, contentType } shaped Buffer of zero bytes (image/png by default).
   */
  async postBinary(
    path: string,
    init: { json?: unknown; method?: string; form?: unknown },
  ): Promise<{ buffer: Buffer; status: number; contentType: string; headers: Record<string, string> }> {
    const body = (init as { json?: unknown }).json
    const isMultipart = (init as { form?: unknown }).form !== undefined
    this.calls.push({
      method: 'POST',
      path,
      body: isMultipart ? '<FormData>' : body,
      multipart: isMultipart,
      binary: true,
    })
    const matchKey = Object.keys(this.overrides).find((k) => path.startsWith(k))
    if (matchKey) {
      const output = await this.overrides[matchKey](this.calls.at(-1)!)
      if (output && typeof output === 'object' && 'buffer' in output) {
        const response = output as {
          buffer: Buffer
          status?: number
          contentType?: string
          headers?: Record<string, string>
        }
        return {
          buffer: response.buffer,
          status: response.status ?? 200,
          contentType: response.contentType ?? 'application/octet-stream',
          headers: response.headers ?? {},
        }
      }
    }
    return {
      buffer: Buffer.from('stub-binary-image-data'),
      status: 200,
      contentType: 'image/png',
      headers: {},
    }
  }
  async postMixed<T>(path: string, json: unknown): Promise<
    | { kind: 'json'; data: T; status: number; contentType: string; headers: Record<string, string> }
    | { kind: 'binary'; buffer: Buffer; status: number; contentType: string; headers: Record<string, string> }
  > {
    const call: StubCall = { method: 'POST', path, body: json, binary: true }
    const data = await this.dispatch<T | {
      kind: 'json'
      data: T
      status?: number
      contentType?: string
      headers?: Record<string, string>
    } | {
      kind: 'binary'
      buffer: Buffer
      status?: number
      contentType?: string
      headers?: Record<string, string>
    }>(call)
    if (data && typeof data === 'object' && 'kind' in data) {
      if (data.kind === 'binary') {
        return {
          kind: 'binary',
          buffer: data.buffer,
          status: data.status ?? 200,
          contentType: data.contentType ?? 'application/octet-stream',
          headers: data.headers ?? {},
        }
      }
      return {
        kind: 'json',
        data: data.data,
        status: data.status ?? 200,
        contentType: data.contentType ?? 'application/json',
        headers: data.headers ?? {},
      }
    }
    return {
      kind: 'json',
      data: data as T,
      status: 200,
      contentType: 'application/json',
      headers: {},
    }
  }
  /** Stub for postMultipart — returns canned JSON like normal POST. */
  async postMultipart<T>(path: string, form: FormData): Promise<T> {
    this.calls.push({
      method: 'POST',
      path,
      body: Object.fromEntries(form.entries()),
      multipart: true,
    })
    const overrideKey = Object.keys(this.overrides).find((k) => path.startsWith(k))
    if (overrideKey) {
      return await this.overrides[overrideKey](this.calls.at(-1)!) as T
    }
    return (defaultResponse(path, false) as T) ?? ({} as T)
  }

  /** Return calls filtered by exact path. */
  callsTo(path: string): StubCall[] {
    return this.calls.filter((c) => c.path === path)
  }
  /** Return calls filtered by path prefix. */
  callsStartingWith(prefix: string): StubCall[] {
    return this.calls.filter((c) => c.path.startsWith(prefix))
  }

  /** Cast helper — TypeScript doesn't structurally accept us as VeniceClient. */
  asClient(): VeniceClient {
    return this as unknown as VeniceClient
  }
}

function defaultResponse(path: string, _binary?: boolean): unknown {
  if (path.startsWith('/v1/chat/completions'))
    return { choices: [{ message: { content: 'reply' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
  if (path.startsWith('/v1/responses')) return { output_text: 'response' }
  if (path.startsWith('/v1/embeddings'))
    return { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }
  // image/generate: real Venice returns { id, images: [base64] } when return_binary=false (the default we send)
  if (path.startsWith('/v1/image/generate')) return { id: 'stub-img-id', images: ['c3R1Yi1iYXNlNjQ='] }
  if (path.startsWith('/v1/image/edit')) return { url: 'https://stub/edit.png' }
  if (path.startsWith('/v1/image/multi-edit')) return { url: 'https://stub/multi.png' }
  if (path.startsWith('/v1/image/upscale')) return { url: 'https://stub/up.png' }
  if (path.startsWith('/v1/image/background-remove')) return { url: 'https://stub/bg.png' }
  if (path.startsWith('/v1/image/styles')) return { data: ['photographic', 'cinematic', 'anime'] }
  if (path.startsWith('/v1/video/queue')) return { model: 'veo3.1-fast-text-to-video', queue_id: 'vid-123' }
  if (path.startsWith('/v1/video/retrieve'))
    return { status: 'COMPLETED', download_url: 'https://stub/v.mp4', average_execution_time: 60_000, execution_duration: 30_000 }
  if (path.startsWith('/v1/video/complete')) return { ok: true }
  // Real Venice video/transcriptions returns { transcript, lang }
  if (path.startsWith('/v1/video/transcriptions')) return { transcript: 'video transcript', lang: 'en' }
  if (path.startsWith('/v1/video/quote')) return { quote: 0.5, model: 'veo3.1-fast-text-to-video' }
  if (path.startsWith('/v1/audio/speech')) return { url: 'https://stub/tts.mp3' }
  if (path.startsWith('/v1/audio/transcriptions')) return { text: 'transcript' }
  if (path.startsWith('/v1/audio/voices')) return { voice_id: 'vv_stubbed_clone' }
  if (path.startsWith('/v1/audio/queue')) return { model: 'elevenlabs-music', queue_id: 'mus-123' }
  if (path.startsWith('/v1/audio/retrieve'))
    return { status: 'COMPLETED', download_url: 'https://stub/m.mp3' }
  if (path.startsWith('/v1/audio/complete')) return { ok: true }
  if (path.startsWith('/v1/audio/quote')) return { quote: 0.1 }
  if (path.startsWith('/v1/augment/search')) return { results: [{ url: 'https://x', snippet: 's' }] }
  if (path.startsWith('/v1/augment/scrape')) return { markdown: '# stub' }
  if (path.startsWith('/v1/augment/text-parser')) return { text: 'parsed text' }
  if (path.startsWith('/v1/crypto/rpc')) return { jsonrpc: '2.0', result: '0x1', id: 1 }
  if (path.startsWith('/v1/models/traits'))
    return { data: { default: 'deepseek-v4-flash-0731' }, object: 'list', type: 'text' }
  if (path.startsWith('/v1/models/compatibility_mapping'))
    return { data: { 'gpt-4o': 'deepseek-v4-flash-0731' }, object: 'list', type: 'text' }
  if (path.startsWith('/v1/models?type=tts'))
    return {
      data: [{
        id: 'tts-live',
        type: 'tts',
        owned_by: 'venice.ai',
        model_spec: {
          name: 'Live TTS',
          voices: ['voice-a', 'voice-b'],
          default_voice: 'voice-a',
          supports_custom_voice_id: true,
          voice_cloning: { mode: 'persistent', accepted_formats: ['mp3'] },
          supported_formats: ['mp3', 'wav'],
          default_format: 'mp3',
        },
      }],
      object: 'list',
      type: 'tts',
    }
  if (path.startsWith('/v1/models'))
    return {
      data: [
        { id: 'deepseek-v4-flash-0731', type: 'text' },
        { id: 'flux-2-pro', type: 'image' },
        { id: 'veo3.1-fast-text-to-video', type: 'video' },
      ],
    }
  if (path.startsWith('/v1/characters')) return { data: [{ slug: 'sample', name: 'Sample' }] }
  if (path.startsWith('/v1/x402/balance')) return { walletAddress: '0x', balanceUsd: 5.42, currency: 'USDC' }
  if (path.startsWith('/v1/x402/transactions')) return { transactions: [] }
  return {}
}
