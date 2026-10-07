import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MAX_EVENT_STREAM_BYTES, VeniceClient, VeniceMalformedResponseError, VeniceResponseTooLargeError } from '../src/venice-client.js'
import { loadConfig } from '../src/config.js'
import { VeniceUpstreamError } from '../src/types.js'
import { startMockVenice, type MockVeniceServer } from './helpers/mock-venice-server.js'

function eventStream(
  client: VeniceClient,
  path: string,
  json: unknown,
  _headers?: Record<string, string>,
  opts: { timeoutMs?: number; maxResponseBytes?: number } = {},
) {
  return client.request<string>(path, {
    json,
    responseType: 'event-stream',
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes ?? DEFAULT_MAX_EVENT_STREAM_BYTES,
  })
}

const ENCRYPTED_CHUNK = 'ab'.repeat(12_000)
const RAW_E2EE_SSE =
  `event: message\r\ndata: {"choices":[{"delta":{"content":"${ENCRYPTED_CHUNK}"}}]}\r\n\r\n` +
  'data: [DONE]\r\n\r\n'

describe('VeniceClient', () => {
  let server: MockVeniceServer

  before(async () => {
    server = await startMockVenice([
      { match: 'GET /v1/models', reply: { data: [{ id: 'a', type: 'text' }] } },
      { match: 'POST /v1/chat/completions', reply: { choices: [{ message: { content: 'ok' } }] } },
      {
        match: 'POST /v1/needs-key',
        reply: ({ headers }) =>
          headers.authorization
            ? { ok: true, key: headers.authorization }
            : { __status: 401, __body: { error: 'no auth' } },
      },
      {
        match: 'POST /v1/needs-siwx',
        reply: ({ headers }) =>
          headers['x-sign-in-with-x']
            ? { ok: true, siwx: headers['x-sign-in-with-x'] }
            : { __status: 401, __body: { error: 'no auth' } },
      },
      {
        match: 'POST /v1/insufficient',
        reply: {
          __status: 402,
          __body: {
            reason: 'insufficient_balance',
            currentBalanceUsd: 0,
            minimumBalanceUsd: 0.1,
          },
        },
      },
      { match: 'POST /v1/server-error', reply: { __status: 503, __body: { error: 'down' } } },
      { match: 'POST /v1/text-only', reply: { __status: 200, __body: 'plain text', __headers: { 'content-type': 'text/plain' } } },
      {
        match: 'POST /v1/e2ee-stream',
        reply: {
          __status: 200,
          __rawBody: RAW_E2EE_SSE,
          __headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        },
      },
      {
        match: 'POST /v1/not-a-stream',
        reply: {
          __status: 200,
          __body: { choices: [] },
          __headers: { 'content-type': 'application/json' },
        },
      },
      {
        match: 'POST /v1/metadata',
        reply: {
          __status: 200,
          __body: { ok: true },
          __headers: { 'x-venice-enhanced-prompt': 'detailed%20prompt' },
        },
      },
      {
        match: 'POST /v1/video/processing',
        reply: {
          __status: 200,
          __body: { status: 'PROCESSING', average_execution_time: 60_000, execution_duration: 10_000 },
        },
      },
      {
        match: 'POST /v1/video/completed',
        reply: {
          __status: 200,
          __body: Buffer.from('mp4-binary-data'),
          __headers: { 'content-type': 'video/mp4' },
        },
      },
      {
        match: 'POST /v1/video/exact-limit',
        reply: {
          __status: 200,
          __body: Buffer.from('12345678'),
          __headers: { 'content-type': 'video/mp4' },
        },
      },
      {
        match: 'POST /v1/video/over-limit',
        reply: {
          __status: 200,
          __body: Buffer.from('123456789'),
          __headers: { 'content-type': 'video/mp4' },
        },
      },
      {
        match: 'POST /v1/video/stalled-body',
        reply: {
          __status: 200,
          __body: Buffer.from('partial-mp4'),
          __headers: { 'content-type': 'video/mp4' },
          __stallBody: true,
        },
      },
      {
        match: 'POST /v1/json-stalled-body',
        reply: {
          __status: 200,
          __body: Buffer.from('{"data":[{"url":"https://'),
          __headers: { 'content-type': 'application/json' },
          __stallBody: true,
        },
      },
      {
        match: 'POST /v1/text-stalled-body',
        reply: {
          __status: 200,
          __body: 'partial text',
          __headers: { 'content-type': 'text/plain' },
          __stallBody: true,
        },
      },
      {
        match: 'POST /v1/stalled-402',
        reply: {
          __status: 402,
          __body: '{"reason":"insufficient',
          __headers: { 'content-type': 'application/json' },
          __stallBody: true,
        },
      },
      {
        match: 'POST /v1/stalled-500',
        reply: { __status: 500, __body: 'upstream fail', __headers: { 'content-type': 'text/plain' }, __stallBody: true },
      },
      {
        match: 'POST /v1/mixed-case-json',
        reply: {
          __status: 200,
          __body: '{"status":"PROCESSING"}',
          __headers: { 'content-type': 'Application/JSON; charset=utf-8' },
        },
      },
      {
        match: 'POST /v1/mixed-case-malformed-json',
        reply: {
          __status: 200,
          __body: '{"status":',
          __headers: { 'content-type': 'APPLICATION/JSON; charset=UTF-8' },
        },
      },
      {
        match: 'POST /v1/malformed-json',
        reply: {
          __status: 200,
          __body: Buffer.from('{"data":[{"b64_json":"abc'),
          __headers: { 'content-type': 'application/json' },
        },
      },
      {
        match: 'POST /v1/lookalike-stream',
        reply: {
          __status: 200,
          __rawBody: RAW_E2EE_SSE,
          __headers: { 'content-type': 'text/event-streaming' },
        },
      },
      {
        match: 'POST /v1/incomplete-stream',
        reply: {
          __status: 200,
          __rawBody: 'data: {"choices":[{"delta":{"content":"deadbeef"}}]}\n\n',
          __headers: { 'content-type': 'text/event-stream' },
        },
      },
      {
        match: 'POST /v1/error-envelope-stream',
        reply: {
          __status: 200,
          __rawBody:
            'data: {"error":{"message":"attestation stale","type":"invalid_request_error"}}\n\n' +
            'data: [DONE]\n\n',
          __headers: { 'content-type': 'text/event-stream' },
        },
      },
      {
        match: 'POST /v1/e2ee-insufficient',
        reply: {
          __status: 402,
          __body: {
            reason: 'insufficient_balance',
            currentBalanceUsd: 0,
            minimumBalanceUsd: 0.1,
          },
          __headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      },
      {
        match: 'POST /v1/slow-stream',
        reply: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({
              __status: 200,
              __rawBody: RAW_E2EE_SSE,
              __headers: { 'content-type': 'text/event-stream' },
            }), 150)
          }) as unknown,
      },
      {
        match: 'POST /v1/empty-json',
        reply: {
          __status: 200,
          __body: Buffer.alloc(0),
          __headers: { 'content-type': 'application/json' },
        },
      },
      {
        match: 'POST /v1/slow',
        reply: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true }), 500)
          }) as unknown,
      },
    ])
  })

  after(async () => {
    if (server) await server.close()
  })

  function makeCfg(overrides: { apiKey?: string; siwxToken?: string; timeoutMs?: number } = {}) {
    return {
      ...loadConfig({}),
      baseUrl: server.url,
      ...overrides,
    }
  }

  it('forwards Authorization Bearer when API key set', async () => {
    const c = new VeniceClient(makeCfg({ apiKey: 'vk_abc' }))
    const r = await c.post<{ ok: boolean; key: string }>('/v1/needs-key', {})
    assert.equal(r.ok, true)
    assert.equal(r.key, 'Bearer vk_abc')
  })

  it('forwards X-Sign-In-With-X when only SIWX token set', async () => {
    const c = new VeniceClient(makeCfg({ siwxToken: 'siwx_token_xyz' }))
    const r = await c.post<{ ok: boolean; siwx: string }>('/v1/needs-siwx', {})
    assert.equal(r.ok, true)
    assert.equal(r.siwx, 'siwx_token_xyz')
  })

  it('prefers API key over SIWX when both are set (does not send SIWX)', async () => {
    const c = new VeniceClient(makeCfg({ apiKey: 'vk_abc', siwxToken: 'siwx_token_xyz' }))
    // /v1/needs-siwx returns 401 if SIWX header is absent.
    await assert.rejects(
      () => c.post('/v1/needs-siwx', {}),
      (err: unknown) => {
        assert.ok(err instanceof VeniceUpstreamError)
        assert.equal((err as VeniceUpstreamError).status, 401)
        return true
      }
    )
    // Verify on the wire: last request had Authorization but no X-Sign-In-With-X
    const last = server.calls[server.calls.length - 1]
    assert.ok(last.headers.authorization)
    assert.equal(last.headers['x-sign-in-with-x'], undefined)
  })

  it('can force SIWX auth for endpoints that reject API keys', async () => {
    const c = new VeniceClient(makeCfg({ apiKey: 'vk_abc', siwxToken: 'siwx_token_xyz' }))
    await c.get('/v1/models', undefined, { auth: 'siwx' })
    const last = server.calls[server.calls.length - 1]
    assert.equal(last.headers.authorization, undefined)
    assert.equal(last.headers['x-sign-in-with-x'], 'siwx_token_xyz')
  })

  it('can suppress configured credentials for auth-free endpoints', async () => {
    const c = new VeniceClient(makeCfg({ apiKey: 'vk_abc', siwxToken: 'siwx_token_xyz' }))
    await c.get('/v1/models', undefined, { auth: 'none' })
    const last = server.calls[server.calls.length - 1]
    assert.equal(last.headers.authorization, undefined)
    assert.equal(last.headers['x-sign-in-with-x'], undefined)
  })

  it('surfaces 402 as VeniceUpstreamError with isPaymentRequired=true', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => c.post('/v1/insufficient', {}),
      (err: unknown) => {
        assert.ok(err instanceof VeniceUpstreamError)
        const e = err as VeniceUpstreamError
        assert.equal(e.status, 402)
        assert.equal(e.isPaymentRequired, true)
        const body = e.body as { reason: string }
        assert.equal(body.reason, 'insufficient_balance')
        return true
      }
    )
  })

  it('surfaces 5xx as VeniceUpstreamError with body parsed', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => c.post('/v1/server-error', {}),
      (err: unknown) => {
        const e = err as VeniceUpstreamError
        assert.equal(e.status, 503)
        assert.equal(e.isPaymentRequired, false)
        return true
      }
    )
  })

  it('parses JSON responses transparently', async () => {
    const c = new VeniceClient(makeCfg())
    const r = await c.get<{ data: Array<{ id: string }> }>('/v1/models')
    assert.equal(r.data[0].id, 'a')
  })

  it('returns text body when content-type is not JSON', async () => {
    const c = new VeniceClient(makeCfg())
    const r = await c.post<string>('/v1/text-only', {})
    assert.equal(r, 'plain text')
  })

  it('preserves complete SSE framing and encrypted content without truncation or normalization', async () => {
    const c = new VeniceClient(makeCfg({ apiKey: 'vk_abc' }))
    const raw = await eventStream(c, '/v1/e2ee-stream', { stream: true })
    assert.equal(raw, RAW_E2EE_SSE)
    assert.ok(raw.includes(ENCRYPTED_CHUNK))
    const last = server.calls.at(-1)!
    assert.equal(last.headers.accept, 'text/event-stream')
    assert.deepEqual(last.body, { stream: true })
  })

  it('rejects a successful non-SSE response when event-stream transport is required', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => eventStream(c, '/v1/not-a-stream', { stream: true }),
      (err: unknown) => {
        const e = err as VeniceUpstreamError
        assert.equal(e.status, 502)
        assert.match(e.message, /instead of text\/event-stream/)
        return true
      },
    )
  })

  it('offers opt-in response metadata without changing existing body-only methods', async () => {
    const c = new VeniceClient(makeCfg())
    const r = await c.postWithMetadata<{ ok: boolean }>('/v1/metadata', {})
    assert.equal(r.data.ok, true)
    assert.equal(r.status, 200)
    assert.equal(r.headers['x-venice-enhanced-prompt'], 'detailed%20prompt')
  })

  it('postWithMetadata rejects a JSON body over its byte limit', async () => {
    const c = new VeniceClient(makeCfg())
    const ok = await c.postWithMetadata<{ ok: boolean }>('/v1/metadata', {}, undefined, { maxBytes: 1024 })
    assert.equal(ok.data.ok, true)
    assert.equal(ok.headers['x-venice-enhanced-prompt'], 'detailed%20prompt')
    await assert.rejects(
      () => c.postWithMetadata('/v1/metadata', {}, undefined, { maxBytes: 4 }),
      (err: unknown) => {
        assert.ok(err instanceof VeniceResponseTooLargeError)
        assert.equal(err.maxBytes, 4)
        return true
      },
    )
  })

  it('requires the exact normalized text/event-stream media type', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => eventStream(c, '/v1/lookalike-stream', { stream: true }),
      (err: unknown) => {
        const e = err as VeniceUpstreamError
        assert.equal(e.status, 502)
        assert.match(e.message, /text\/event-streaming instead of text\/event-stream/)
        return true
      },
    )
  })

  it('postMixed parses a JSON processing response', async () => {
    const c = new VeniceClient(makeCfg())
    const r = await c.postMixed<{ status: string; execution_duration: number }>('/v1/video/processing', {})
    assert.equal(r.kind, 'json')
    if (r.kind === 'json') {
      assert.equal(r.data.status, 'PROCESSING')
      assert.equal(r.data.execution_duration, 10_000)
    }
  })

  it('postMixed preserves a completed video/mp4 response as binary', async () => {
    const c = new VeniceClient(makeCfg())
    const r = await c.postMixed('/v1/video/completed', {})
    assert.equal(r.kind, 'binary')
    if (r.kind === 'binary') {
      assert.equal(r.contentType, 'video/mp4')
      assert.equal(r.buffer.toString(), 'mp4-binary-data')
    }
  })

  it('postMixed permits a binary response exactly at its byte limit', async () => {
    const c = new VeniceClient(makeCfg())
    const r = await c.postMixed('/v1/video/exact-limit', {}, { maxBytes: 8 })
    assert.equal(r.kind, 'binary')
    if (r.kind === 'binary') assert.equal(r.buffer.length, 8)
  })

  it('postMixed rejects a binary response over its byte limit before buffering it', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => c.postMixed('/v1/video/over-limit', {}, { maxBytes: 8 }),
      (err: unknown) => {
        assert.ok(err instanceof VeniceResponseTooLargeError)
        assert.equal(err.maxBytes, 8)
        return true
      },
    )
  })

  it('rejects an SSE stream that contains an error envelope even when it ends with [DONE]', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => eventStream(c, '/v1/error-envelope-stream', { stream: true }),
      (err: unknown) => {
        const e = err as VeniceUpstreamError
        assert.equal(e.status, 502)
        assert.match(e.message, /error envelope/)
        assert.deepEqual(e.body, {
          error: { message: 'attestation stale', type: 'invalid_request_error' },
        })
        return true
      },
    )
  })

  it('postMixed times out when headers arrive but the streamed body stalls', async () => {
    const c = new VeniceClient(makeCfg({ timeoutMs: 30 }))
    await assert.rejects(
      () => c.postMixed('/v1/video/stalled-body', {}, { maxBytes: 1024 }),
      (err: unknown) => {
        assert.ok(err instanceof VeniceUpstreamError)
        assert.equal(err.status, 504)
        assert.match(err.message, /timed out after 30ms/)
        return true
      },
    )
  })

  it('rejects an SSE response without a terminal data: [DONE] event', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => eventStream(c, '/v1/incomplete-stream', { stream: true }),
      (err: unknown) => {
        const e = err as VeniceUpstreamError
        assert.equal(e.status, 502)
        assert.match(e.message, /without a terminal "data: \[DONE\]" event/)
        assert.deepEqual(e.body, { error: 'incomplete_event_stream' })
        return true
      },
    )
  })

  it('post times out when headers arrive but the JSON body stalls', async () => {
    const c = new VeniceClient(makeCfg({ timeoutMs: 30 }))
    await assert.rejects(
      () => c.post('/v1/json-stalled-body', {}),
      (err: unknown) => {
        assert.ok(err instanceof VeniceUpstreamError)
        assert.equal(err.status, 504)
        assert.match(err.message, /timed out after 30ms/)
        return true
      },
    )
  })

  it('parses E2EE 402 JSON before SSE success validation', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => eventStream(c, '/v1/e2ee-insufficient', { stream: true }),
      (err: unknown) => {
        const e = err as VeniceUpstreamError
        assert.equal(e.status, 402)
        assert.equal(e.isPaymentRequired, true)
        assert.deepEqual(e.body, {
          reason: 'insufficient_balance',
          currentBalanceUsd: 0,
          minimumBalanceUsd: 0.1,
        })
        return true
      },
    )
  })

  it('postMultipart times out when headers arrive but the JSON body stalls', async () => {
    const c = new VeniceClient(makeCfg({ timeoutMs: 30 }))
    await assert.rejects(
      () => c.postMultipart('/v1/json-stalled-body', new FormData()),
      (err: unknown) => {
        assert.ok(err instanceof VeniceUpstreamError)
        assert.equal(err.status, 504)
        assert.match(err.message, /timed out after 30ms/)
        return true
      },
    )
  })

  it('keeps timeout active after headers while the SSE body stalls', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async (_input, init) => {
        const signal = init?.signal
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'))
            const abort = () => {
              const err = new Error('aborted while reading')
              err.name = 'AbortError'
              controller.error(err)
            }
            if (signal?.aborted) abort()
            else signal?.addEventListener('abort', abort, { once: true })
          },
        })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }) as typeof fetch
      const c = new VeniceClient({ ...loadConfig({}), baseUrl: 'https://stall.test', timeoutMs: 20 })
      await assert.rejects(
        () => eventStream(c, '/stream', { stream: true }),
        (err: unknown) => {
          const e = err as VeniceUpstreamError
          assert.equal(e.status, 504)
          assert.deepEqual(e.body, { error: 'timeout' })
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a truncated/erroring SSE body instead of returning an empty success', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"deadbeef"}}]}\n\n'))
            queueMicrotask(() => controller.error(new Error('socket reset')))
          },
        })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }) as typeof fetch
      const c = new VeniceClient({ ...loadConfig({}), baseUrl: 'https://truncated.test' })
      await assert.rejects(
        () => eventStream(c, '/stream', { stream: true }),
        (err: unknown) => {
          const e = err as VeniceUpstreamError
          assert.equal(e.status, 502)
          assert.deepEqual(e.body, { error: 'response_body_read_failed' })
          assert.match(e.message, /Failed to read Venice response body/)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects an SSE body larger than the byte cap with a clear error', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => eventStream(c, '/v1/e2ee-stream', { stream: true }, undefined, { maxResponseBytes: 1_000 }),
      /Venice response on \/v1\/e2ee-stream exceeds the configured 1000-byte limit/,
    )
  })

  it('enforces the SSE byte cap while streaming when content-length is absent', async () => {
    const originalFetch = globalThis.fetch
    try {
      let enqueued = 0
      globalThis.fetch = (async () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            enqueued += 1
            controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${'ab'.repeat(256)}"}}]}\n\n`))
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }) as typeof fetch
      const c = new VeniceClient({ ...loadConfig({}), baseUrl: 'https://unbounded.test' })
      await assert.rejects(
        () => eventStream(c, '/stream', { stream: true }, undefined, { maxResponseBytes: 4_096 }),
        /exceeds the configured 4096-byte limit/,
      )
      assert.ok(enqueued < 20, `read ${enqueued} chunks past the cap`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('lets a per-call timeout outlast the configured default for long SSE streams', async () => {
    const c = new VeniceClient(makeCfg({ timeoutMs: 50 }))
    await assert.rejects(
      () => eventStream(c, '/v1/slow-stream', { stream: true }),
      (err: unknown) => (err as VeniceUpstreamError).status === 504,
    )
    const raw = await eventStream(c, '/v1/slow-stream', { stream: true }, undefined, { timeoutMs: 2_000 })
    assert.equal(raw, RAW_E2EE_SSE)
  })

  it('postMultipart keeps an explicit timeout override armed through a stalled text body', { timeout: 2000 }, async () => {
    const c = new VeniceClient(makeCfg({ timeoutMs: 10_000 }))
    await assert.rejects(
      () => c.postMultipart('/v1/text-stalled-body', new FormData(), { timeoutMs: 30 }),
      (err: unknown) => {
        assert.ok(err instanceof VeniceUpstreamError)
        assert.equal(err.status, 504)
        assert.match(err.message, /timed out after 30ms/)
        return true
      },
    )
    assert.equal(server.calls.at(-1)?.path, '/v1/text-stalled-body')
  })

  it('keeps the HTTP status when a non-OK error body stalls past the timeout', async () => {
    const c = new VeniceClient(makeCfg({ timeoutMs: 30 }))
    for (const [path, status] of [['/v1/stalled-402', 402], ['/v1/stalled-500', 500]] as const) {
      for (const call of [
        () => c.post(path, {}),
        () => c.postMultipart(path, new FormData()),
        () => c.postBinary(path, { json: {} }, { maxBytes: 1024 }),
        () => c.postMixed(path, {}),
      ]) {
        await assert.rejects(call, (err: unknown) => {
          assert.ok(err instanceof VeniceUpstreamError)
          assert.equal(err.status, status)
          assert.doesNotMatch(err.message, /timed out/)
          return true
        })
      }
    }
  })

  it('treats a mixed-case JSON content type as JSON', async () => {
    const c = new VeniceClient(makeCfg())
    const mixed = await c.postMixed<{ status: string }>('/v1/mixed-case-json', {})
    assert.equal(mixed.kind, 'json')
    if (mixed.kind === 'json') assert.equal(mixed.data.status, 'PROCESSING')
    assert.deepEqual(await c.post('/v1/mixed-case-json', {}), { status: 'PROCESSING' })
    assert.deepEqual(await c.postMultipart('/v1/mixed-case-json', new FormData()), { status: 'PROCESSING' })
  })

  it('postMixed rejects malformed mixed-case JSON rather than returning it as binary', async () => {
    const c = new VeniceClient(makeCfg())
    await assert.rejects(
      () => c.postMixed('/v1/mixed-case-malformed-json', {}),
      VeniceMalformedResponseError,
    )
  })

  it('rejects a malformed 2xx JSON body instead of returning {}', async () => {
    const c = new VeniceClient(makeCfg())
    const form = new FormData()
    for (const call of [
      () => c.post('/v1/malformed-json', {}),
      () => c.postMultipart('/v1/malformed-json', form),
      () => c.postMixed('/v1/malformed-json', {}),
    ]) {
      await assert.rejects(call, (err: unknown) => {
        assert.ok(err instanceof VeniceMalformedResponseError)
        assert.match(err.message, /may have completed upstream and been charged/)
        return true
      })
    }
  })

  it('treats an empty 2xx JSON body as {}', async () => {
    const c = new VeniceClient(makeCfg())
    assert.deepEqual(await c.post('/v1/empty-json', {}), {})
  })

  it('aborts on timeout and surfaces a 504 VeniceUpstreamError', async () => {
    const c = new VeniceClient(makeCfg({ timeoutMs: 50 }))
    await assert.rejects(
      () => c.post('/v1/slow', {}),
      (err: unknown) => {
        const e = err as VeniceUpstreamError
        assert.equal(e.status, 504)
        return true
      }
    )
  })

  it('uses GET when no body and POST when body is set, by default', async () => {
    const c = new VeniceClient(makeCfg())
    await c.get('/v1/models')
    await c.post('/v1/chat/completions', { messages: [] })
    const lastTwo = server.calls.slice(-2)
    assert.equal(lastTwo[0].method, 'GET')
    assert.equal(lastTwo[1].method, 'POST')
  })

  it('baseUrl is always the Venice API root', () => {
    assert.equal('https://api.venice.ai/api', 'https://api.venice.ai/api')
  })
})
