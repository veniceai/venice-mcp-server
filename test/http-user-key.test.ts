import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { createHttpApp, type HttpAppOptions } from '../src/transports/http.js'
import { loadConfig } from '../src/config.js'
import { buildTools } from '../src/tools/index.js'
import { VeniceClient } from '../src/venice-client.js'
import { startMockVenice, type MockRoute } from './helpers/mock-venice-server.js'

const sourceUrl = 'https://93.184.216.34/source.wav'
const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
})
const headers = {
  'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer caller-key',
}

async function fixture(t: TestContext, routes: MockRoute[], opts: Pick<HttpAppOptions, 'authMode'> & { timeoutMs?: number } = {}) {
  const upstream = await startMockVenice(routes)
  const config = {
    ...loadConfig({}), baseUrl: upstream.url, apiKey: opts.authMode === 'token' ? undefined : 'operator-key',
    siwxToken: 'operator-proof', timeoutMs: opts.timeoutMs ?? 1000,
  }
  const app = createHttpApp({ authMode: opts.authMode ?? 'user-key', authToken: 'caller-key', config, maxConcurrentRequests: 1 })
  const listener = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => listener.once('listening', resolve))
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`
  t.after(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    await upstream.close()
  })
  const post = (body: unknown, extra: Record<string, string> = {}, signal?: AbortSignal) =>
    fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal })
  return { upstream, post, url, config }
}

function interceptSource(t: TestContext, onFetch: () => void) {
  const realFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === sourceUrl) {
      onFetch()
      return new Response('RIFFmock audio', { headers: { 'content-type': 'audio/wav' } })
    }
    return realFetch(input, init)
  })
}

async function waitForCapacity(post: (body: unknown) => Promise<Response>) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(10)
    const response = await post(call('venice_list_models'))
    await response.text()
    if (response.status === 200) return
    assert.equal(response.status, 503)
  }
  assert.fail('request admission did not recover')
}

it('rejects invalid API keys before downloading any of the four upload sources', async (t) => {
  let downloads = 0
  interceptSource(t, () => downloads++)
  const { post, upstream } = await fixture(t, [
    { match: 'GET /v1/api_keys/rate_limits', reply: { __status: 401, __body: { error: 'invalid key' } } },
  ])
  for (const [name, args] of [
    ['venice_asr', { audio_url: sourceUrl }],
    ['venice_image_upscale', { image_url: sourceUrl }],
    ['venice_voice_clone', { action: 'create', sample_url: sourceUrl }],
    ['venice_text_parser', { url: sourceUrl }],
  ] as const) {
    const response = await post(call(name, args), { authorization: 'Bearer fabricated-key' })
    const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }
    assert.equal(body.result.isError, true, name)
    assert.match(body.result.content[0].text, /401/, name)
  }
  assert.equal(downloads, 0)
  assert.equal(upstream.calls.length, 4)
  assert.ok(upstream.calls.every((request) => request.path === '/v1/api_keys/rate_limits'))
  assert.ok(upstream.calls.every((request) => request.headers.authorization === 'Bearer fabricated-key'))
})

it('validates the caller key before fetching audio and returns the complete stateless transcript', async (t) => {
  const order: string[] = []
  const transcript = 'long transcript '.repeat(1000)
  const { post, upstream } = await fixture(t, [
    { match: 'GET /v1/api_keys/rate_limits', reply: () => { order.push('validate'); return { data: { accessPermitted: true } } } },
    { match: 'POST /v1/audio/transcriptions', reply: () => { order.push('transcribe'); return { text: transcript } } },
  ])
  interceptSource(t, () => order.push('download'))
  const response = await post(call('venice_asr', { audio_url: sourceUrl }))
  const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown> } }
  assert.notEqual(body.result.isError, true)
  assert.deepEqual(order, ['validate', 'download', 'transcribe'])
  assert.equal(body.result.structuredContent.text, transcript)
  assert.equal(JSON.parse(body.result.content[0].text).text, transcript)
  assert.equal(body.result.structuredContent.result_handle, undefined)
  assert.ok(upstream.calls.every((request) => request.headers.authorization === 'Bearer caller-key'))
  assert.ok(upstream.calls.every((request) => !request.headers['sign-in-with-x']))

  const continuation = await post(call('venice_asr', { audio_url: sourceUrl, text_offset: 8000 }))
  assert.equal(((await continuation.json()) as { result: { isError: boolean } }).result.isError, true)
  assert.equal(upstream.calls.length, 2)
  assert.equal(order.length, 3)
  const fresh = await post(call('venice_asr', { audio_url: sourceUrl }))
  await fresh.text()
  assert.deepEqual(order, ['validate', 'download', 'transcribe', 'validate', 'download', 'transcribe'])
})

it('fails closed on validation errors, oversized responses, and timeouts without downloading', async (t) => {
  let downloads = 0
  interceptSource(t, () => downloads++)
  let mode = 'status'
  const { post } = await fixture(t, [{
    match: 'GET /v1/api_keys/rate_limits',
    reply: async () => {
      if (mode === 'timeout') { await delay(120); return { data: { accessPermitted: true } } }
      if (mode === 'oversize') return { data: 'x'.repeat(1024 * 1024 + 1) }
      if (mode === 'denied') return { data: { accessPermitted: false } }
      if (mode === 'malformed') return { unexpected: true }
      return { __status: 503, __body: { error: 'validation failed' } }
    },
  }], { timeoutMs: 50 })
  for (const scenario of ['status', 'oversize', 'timeout', 'denied', 'malformed']) {
    mode = scenario
    const response = await post(call('venice_asr', { audio_url: sourceUrl }))
    const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }
    assert.equal(body.result.isError, true, scenario)
    if (scenario === 'oversize') {
      assert.match(body.result.content[0].text, /API key validation response exceeds/)
      assert.match(body.result.content[0].text, /No source was downloaded or inference submitted/)
    }
    if (scenario === 'status') assert.match(body.result.content[0].text, /503/)
    if (scenario === 'denied' || scenario === 'malformed') {
      assert.match(body.result.content[0].text, /API key access is not permitted; check its balance and permissions/)
      assert.match(body.result.content[0].text, /No source was downloaded or inference submitted/)
    }
  }
  assert.equal(downloads, 0)
})

it('does not download or transcribe after the caller disconnects during credential validation', async (t) => {
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  t.after(() => release())
  let downloads = 0
  interceptSource(t, () => downloads++)
  const { post, upstream } = await fixture(t, [
    { match: 'GET /v1/api_keys/rate_limits', reply: async () => {
      started()
      await pending
      return { data: { accessPermitted: true } }
    } },
    { match: 'GET /v1/models*', reply: { data: [] } },
  ])
  const controller = new AbortController()
  const request = post(call('venice_asr', { audio_url: sourceUrl }), {}, controller.signal).catch(() => undefined)
  await entered
  controller.abort()
  await request
  await delay(20)
  release()
  await waitForCapacity(post)
  assert.equal(downloads, 0)
  assert.deepEqual(upstream.calls.map((item) => item.path), ['/v1/api_keys/rate_limits', '/v1/models?type=all'])
})

it('rejects wallet uploads before any upstream request and forwards other wallet calls exactly once', async (t) => {
  let downloads = 0
  interceptSource(t, () => downloads++)
  const { post, upstream } = await fixture(t, [{ match: 'GET /v1/models*', reply: { data: [] } }])
  for (const header of ['sign-in-with-x', 'x-sign-in-with-x']) {
    const wallet = { authorization: '', [header]: 'one-use-proof' }
    const response = await post(call('venice_asr', { audio_url: sourceUrl }), wallet)
    const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }
    assert.equal(body.result.isError, true)
    assert.match(body.result.content[0].text, /API key is required/)
    assert.equal(downloads, 0)
    const before = upstream.calls.length
    const listed = await post(call('venice_list_models'), wallet)
    assert.equal(listed.status, 200)
    await listed.text()
    assert.equal(upstream.calls.length, before + 1)
    assert.equal(upstream.calls.at(-1)?.headers['sign-in-with-x'], 'one-use-proof')
    assert.equal(upstream.calls.at(-1)?.headers.authorization, undefined)
  }
})

it('returns the video URL in text and retrieves it across independent user-key requests', async (t) => {
  const downloadUrl = 'https://private-share.venice.ai/v1/share/read/fixture'
  let status = 'PROCESSING'
  const { post, upstream } = await fixture(t, [
    { match: 'POST /v1/video/queue', reply: { queue_id: 'q1', model: 'private-model', download_url: downloadUrl } },
    { match: 'POST /v1/video/retrieve', reply: () => ({ status }) },
  ])
  const queued = await post(call('venice_video_generate', { prompt: 'test', model: 'private-model', duration: '8s' }))
  const body = await queued.json() as { result: { content: Array<{ text: string }>; structuredContent: { download_url: string } } }
  const urlFromText = body.result.content[0].text.match(/^download_url=(.+)$/m)?.[1]
  assert.equal(urlFromText, downloadUrl)
  assert.equal(body.result.structuredContent.download_url, downloadUrl)
  for (status of ['PROCESSING', 'COMPLETED']) {
    const response = await post(call('venice_video_status', { queue_id: 'q1', model: 'private-model', download_url: urlFromText }))
    const { result } = await response.json() as { result: { isError?: boolean; structuredContent: { status: string; url?: string }; content: Array<{ type: string; uri?: string }> } }
    assert.notEqual(result.isError, true)
    assert.equal(result.structuredContent.status, status)
    assert.deepEqual(upstream.calls.at(-1)?.body, { queue_id: 'q1', model: 'private-model', delete_media_on_completion: false })
    if (status === 'COMPLETED') {
      assert.equal(result.structuredContent.url, downloadUrl)
      assert.ok(result.content.some((item) => item.type === 'resource_link' && item.uri === downloadUrl))
    }
  }
})

it('preserves wallet uploads in token HTTP and the default tools used by stdio without validation calls', async (t) => {
  let downloads = 0
  interceptSource(t, () => downloads++)
  const { post, upstream, config } = await fixture(t, [
    { match: 'POST /v1/audio/transcriptions', reply: { text: 'wallet transcript' } },
  ], { authMode: 'token' })
  const initialized = await post({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })
  await initialized.text()
  const sessionId = initialized.headers.get('mcp-session-id')
  assert.ok(sessionId)
  const response = await post(call('venice_asr', { audio_url: sourceUrl }), { 'mcp-session-id': sessionId })
  const body = await response.json() as { result: { isError?: boolean; structuredContent: { text: string } } }
  assert.notEqual(body.result.isError, true)
  assert.equal(body.result.structuredContent.text, 'wallet transcript')

  const asr = buildTools(new VeniceClient(config), config).find((tool) => tool.name === 'venice_asr')
  assert.ok(asr)
  const direct = await asr.handler({ audio_url: sourceUrl })
  assert.notEqual(direct.isError, true)
  assert.equal(direct.structuredContent?.text, 'wallet transcript')
  assert.equal(downloads, 2)
  assert.equal(upstream.calls.length, 2)
  assert.ok(upstream.calls.every((request) => request.path === '/v1/audio/transcriptions'))
  assert.ok(upstream.calls.every((request) => request.headers['sign-in-with-x'] === 'operator-proof'))
  assert.ok(upstream.calls.every((request) => !request.headers.authorization))
})

it('holds admission through disconnected work, rejects concurrent calls, and recovers capacity', async (t) => {
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  let block = true
  t.after(() => release())
  const { post, upstream, url } = await fixture(t, [{
    match: 'GET /v1/models*', reply: async () => { if (block) { started(); await pending }; return { data: [] } },
  }])
  const controller = new AbortController()
  const first = post(call('venice_list_models'), {}, controller.signal).catch(() => undefined)
  await entered
  const busy = await post(call('venice_list_models'))
  assert.equal(busy.status, 503)
  assert.equal(busy.headers.get('retry-after'), '1')
  await busy.text()
  const unparsed = await fetch(url, { method: 'POST', headers, body: '{' })
  assert.equal(unparsed.status, 503)
  await unparsed.text()
  controller.abort()
  await first
  await delay(20)
  const stillBusy = await post(call('venice_list_models'))
  assert.equal(stillBusy.status, 503)
  await stillBusy.text()
  assert.equal(upstream.calls.length, 1)
  block = false
  release()
  await waitForCapacity(post)
})

it('rejects batch fanout and releases admission after invalid JSON', async (t) => {
  const { post, upstream, url } = await fixture(t, [{ match: 'GET /v1/models*', reply: { data: [] } }])
  const batch = await post([call('venice_list_models'), { ...call('venice_list_models'), id: 2 }])
  assert.equal(batch.status, 400)
  assert.deepEqual(await batch.json(), {
    jsonrpc: '2.0', id: null,
    error: { code: -32600, message: 'JSON-RPC batches are not supported in user-key mode' },
  })
  assert.equal(upstream.calls.length, 0)
  const notifications = await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }])
  assert.equal(notifications.status, 400)
  await notifications.text()
  const malformed = await fetch(url, { method: 'POST', headers, body: '{' })
  assert.equal(malformed.status, 400)
  await malformed.text()
  const ready = await post(call('venice_list_models'))
  assert.equal(ready.status, 200)
  await ready.text()
  assert.equal(upstream.calls.length, 1)
})
