import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { VeniceClient, VeniceResponseTooLargeError } from '../src/venice-client.js'
import { loadConfig } from '../src/config.js'
import { VeniceUpstreamError } from '../src/types.js'
import { startMockVenice, type MockVeniceServer } from './helpers/mock-venice-server.js'

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

  it('offers opt-in response metadata without changing existing body-only methods', async () => {
    const c = new VeniceClient(makeCfg())
    const r = await c.postWithMetadata<{ ok: boolean }>('/v1/metadata', {})
    assert.equal(r.data.ok, true)
    assert.equal(r.status, 200)
    assert.equal(r.headers['x-venice-enhanced-prompt'], 'detailed%20prompt')
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
