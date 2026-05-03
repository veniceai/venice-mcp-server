import type { VeniceClient } from '../../src/venice-client.js'

export interface StubCall {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  headers?: Record<string, string>
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

  get<T>(path: string) {
    return this.dispatch<T>({ method: 'GET', path })
  }
  post<T>(path: string, json: unknown) {
    return this.dispatch<T>({ method: 'POST', path, body: json })
  }
  /**
   * Stub for postBinary. Tool calls expecting binary back get a synthetic
   * { buffer, contentType } shaped Buffer of zero bytes (image/png by default).
   */
  async postBinary(
    path: string,
    init: { json?: unknown; method?: string; form?: unknown },
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const body = (init as { json?: unknown }).json
    const isMultipart = (init as { form?: unknown }).form !== undefined
    this.calls.push({
      method: 'POST',
      path,
      body: isMultipart ? '<FormData>' : body,
      multipart: isMultipart,
      binary: true,
    })
    return {
      buffer: Buffer.from('stub-binary-image-data'),
      contentType: 'image/png',
    }
  }
  /** Stub for postMultipart — returns canned JSON like normal POST. */
  async postMultipart<T>(path: string): Promise<T> {
    this.calls.push({ method: 'POST', path, body: '<FormData>', multipart: true })
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
  if (path.startsWith('/v1/models'))
    return {
      data: [
        { id: 'venice-uncensored', type: 'text' },
        { id: 'flux-2-pro', type: 'image' },
        { id: 'veo3.1-fast-text-to-video', type: 'video' },
      ],
    }
  if (path.startsWith('/v1/characters')) return { data: [{ slug: 'sample', name: 'Sample' }] }
  if (path.startsWith('/v1/x402/balance')) return { walletAddress: '0x', balanceUsd: 5.42, currency: 'USDC' }
  if (path.startsWith('/v1/x402/transactions')) return { transactions: [] }
  return {}
}
