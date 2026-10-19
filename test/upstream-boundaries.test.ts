import assert from 'node:assert/strict'
import http from 'node:http'
import { ReadableStream } from 'node:stream/web'
import { after, before, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { buildResources } from '../src/resources.js'
import { buildTools } from '../src/tools/index.js'
import { VeniceUpstreamError } from '../src/types.js'
import {
  DEFAULT_MAX_EVENT_STREAM_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  VeniceClient,
  VeniceJsonResponseTooLargeError,
  VeniceResponseTooLargeError,
} from '../src/venice-client.js'
import { MiB, close, config, form, isUpstreamError, listen, readCalls } from './helpers/upstream-boundaries.js'

describe('finite success body budgets and existing endpoint limits', () => {
  let server: http.Server
  let baseUrl: string
  const aborted = new Set<string>()

  before(async () => {
    server = http.createServer((req, res) => {
      req.resume()
      const [, , type, wire, sizeText] = req.url!.split('/')
      const size = Number(sizeText)
      const headers: Record<string, string> = {
        'content-type': type === 'json' ? 'application/json' : type === 'sse' ? 'text/event-stream' : type === 'binary' ? 'application/octet-stream' : 'text/plain',
        'x-venice-rpc-credits': '20',
        'x-request-id': 'boundary-fixture',
      }
      res.on('close', () => { if (!res.writableFinished) aborted.add(req.url!) })
      if (wire === 'declared') {
        res.writeHead(200, { ...headers, 'content-length': String(size) })
        res.flushHeaders()
        return
      }
      if (wire === 'stall') {
        res.writeHead(200, headers)
        res.write(type === 'json' ? '{"data":"' : 'partial')
        return
      }
      let body: Buffer
      if (type === 'json') body = Buffer.from(`{"data":"${'x'.repeat(size - 11)}"}`)
      else if (type === 'sse') body = Buffer.from(`:${'x'.repeat(size - 17)}\n\ndata: [DONE]\n\n`)
      else body = Buffer.alloc(size, 'x')
      assert.equal(body.byteLength, size)
      if (wire === 'gzip') {
        const compressed = gzipSync(body)
        assert.ok(compressed.byteLength < size)
        res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': String(compressed.byteLength) })
        res.end(compressed)
      } else if (wire === 'overflow-stall') {
        res.writeHead(200, headers)
        res.write(body)
      } else if (wire === 'chunked') {
        res.writeHead(200, headers)
        res.write(body.subarray(0, Math.min(size, MiB)))
        res.end(body.subarray(Math.min(size, MiB)))
      } else {
        res.writeHead(200, { ...headers, 'content-length': String(size) })
        res.end(body)
      }
    })
    baseUrl = await listen(server)
  })
  after(async () => close(server))

  for (const call of readCalls) {
    for (const type of ['json', 'text', 'binary']) {
      for (const wire of ['declared', 'chunked', 'gzip']) {
        it(`${call.name} rejects ${type} ${wire} above the default 16 MiB budget`, async () => {
          const client = new VeniceClient(config(baseUrl))
          await assert.rejects(call.invoke(client, `/success/${type}/${wire}/${16 * MiB + 1}`), (err: unknown) => {
            assert.ok(err instanceof VeniceResponseTooLargeError)
            assert.equal(err.maxBytes, 16 * MiB)
            assert.equal(err.headers['x-venice-rpc-credits'], '20')
            assert.match(err.message, /If this was a billable request, it may have been charged; check its result before retrying/)
            return true
          })
        })
      }
    }
  }

  it('cancels advertised oversized bodies instead of waiting for their configured deadline', { timeout: 2_000 }, async () => {
    const path = `/success/binary/declared/${16 * MiB + 1}`
    await assert.rejects(new VeniceClient(config(baseUrl)).postBinary(path, { json: {} }), VeniceResponseTooLargeError)
    for (let i = 0; i < 50 && !aborted.has(path); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(aborted.has(path), 'upstream socket must observe body cancellation')
  })

  it('cancels a chunked success body immediately after overflow while upstream is still streaming', { timeout: 2_000 }, async () => {
    const client = new VeniceClient(config(baseUrl))
    for (const [index, call] of readCalls.entries()) {
      const path = `/success/binary/overflow-stall/1025/${index}`
      await assert.rejects(call.invoke(client, path, { maxBytes: 1024 }), VeniceResponseTooLargeError)
      for (let i = 0; i < 50 && !aborted.has(path); i++) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(aborted.has(path), `${call.name} must cancel after chunked overflow`)
    }
  })

  it('accepts JSON, text, multipart, and binary bodies exactly at the default limit', async () => {
    assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 16 * MiB)
    const client = new VeniceClient(config(baseUrl))
    const path = `/success/json/length/${16 * MiB}`
    assert.equal((await client.get<{ data: string }>(path)).data.length, 16 * MiB - 11)
    assert.equal((await client.postMultipart<{ data: string }>(path, form())).data.length, 16 * MiB - 11)
    assert.equal((await client.get<string>(`/success/text/chunked/${16 * MiB}`)).length, 16 * MiB)
    assert.equal((await client.postBinary(`/success/binary/chunked/${16 * MiB}`, { form: form() })).buffer.length, 16 * MiB)
  })

  it('retains larger explicit image/audio/video budgets and the deprecated alias', async () => {
    const cfg = config(baseUrl)
    const client = new VeniceClient(cfg)
    const size = 16 * MiB + 1
    assert.ok(cfg.maxImageResponseBytes > size && cfg.maxAudioResponseBytes > size && cfg.maxVideoResponseBytes > size)
    const image = await client.postWithMetadata<{ data: string }>(`/success/json/length/${size}`, {}, undefined, { maxBytes: cfg.maxImageResponseBytes })
    assert.equal(image.data.data.length, size - 11)
    const audio = await client.postBinary(`/success/binary/length/${size}`, { json: {} }, { maxBytes: cfg.maxAudioResponseBytes })
    assert.equal(audio.buffer.length, size)
    const video = await client.postMixed(`/success/binary/length/${size}`, {}, { maxBytes: cfg.maxVideoResponseBytes })
    assert.equal(video.kind, 'binary')
    if (video.kind === 'binary') assert.equal(video.buffer.length, size)
    const multipart = await client.postMultipart<{ data: string }>(`/success/json/length/${size}`, form(), { maxBytes: size })
    assert.equal(multipart.data.length, size - 11)
    const alias = await client.post<{ data: string }>(`/success/json/length/${size}`, {}, undefined, { maxResponseBytes: size })
    assert.equal(alias.data.length, size - 11)
  })

  it('keeps smaller explicit limits, maxBytes precedence, and RPC billing headers', async () => {
    const client = new VeniceClient(config(baseUrl))
    for (const call of readCalls) {
      await assert.rejects(call.invoke(client, '/success/json/chunked/65537', { maxBytes: 64 * 1024 }), (err: unknown) => {
        assert.ok(err instanceof VeniceResponseTooLargeError)
        assert.equal(err.maxBytes, 64 * 1024)
        assert.equal(err.headers['x-venice-rpc-credits'], '20')
        return true
      })
    }
    await assert.rejects(client.request('/success/json/length/100', { maxBytes: 64, maxResponseBytes: 1_000 }), VeniceResponseTooLargeError)
    await assert.rejects(client.postWithHeaders('/success/json/length/65537', {}, undefined, { maxResponseBytes: 64 * 1024 }), (err: unknown) => {
      assert.ok(err instanceof VeniceResponseTooLargeError)
      assert.equal(err.headers['x-venice-rpc-credits'], '20')
      return true
    })
  })

  it('retains the separate 1 MiB mixed status JSON budget despite tiny or larger media caps', async () => {
    const client = new VeniceClient(config(baseUrl))
    for (const maxBytes of [8, 32 * MiB]) {
      const result = await client.postMixed<{ data: string }>(`/success/json/length/${MiB}`, {}, { maxBytes })
      assert.equal(result.kind, 'json')
      if (result.kind === 'json') assert.equal(result.data.data.length, MiB - 11)
      await assert.rejects(client.postMixed(`/success/json/chunked/${MiB + 1}`, {}, { maxBytes }), (err: unknown) => {
        assert.ok(err instanceof VeniceJsonResponseTooLargeError)
        assert.equal(err.maxBytes, MiB)
        return true
      })
    }
    await assert.rejects(client.postMixed(`/success/binary/declared/${16 * MiB + 1}`, {}), VeniceResponseTooLargeError)
  })

  it('enforces the 16 MiB SSE default and preserves a complete stream exactly at the cap', async () => {
    assert.equal(DEFAULT_MAX_EVENT_STREAM_BYTES, 16 * MiB)
    const client = new VeniceClient(config(baseUrl))
    const result = await client.request<string>(`/success/sse/length/${16 * MiB}`, { responseType: 'event-stream' })
    assert.equal(Buffer.byteLength(result), 16 * MiB)
    assert.ok(result.endsWith('\n\ndata: [DONE]\n\n'))
    await assert.rejects(client.request(`/success/sse/chunked/${16 * MiB + 1}`, { responseType: 'event-stream' }), VeniceResponseTooLargeError)
  })

  it('keeps deadlines armed for stalled success bodies on every transport', { timeout: 3_000 }, async () => {
    const client = new VeniceClient({ ...config(baseUrl), timeoutMs: 75 })
    for (const call of readCalls) {
      await assert.rejects(call.invoke(client, '/success/json/stall/100'), (err: unknown) => {
        assert.ok(err instanceof VeniceUpstreamError)
        assert.equal(err.status, 504)
        return true
      })
    }
  })
})

describe('original error status, payment instructions, and cancellation deadlines', () => {
  for (const cancelMode of ['pending', 'rejected']) {
    for (const declared of [false, true]) {
      it(`does not wait for ${cancelMode} cancellation (${declared ? 'Content-Length' : 'stream overflow'})`, { timeout: 2_000 }, async () => {
        const originalFetch = globalThis.fetch
        let cancelled = 0
        try {
          globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(Buffer.alloc(64 * 1024 + 1)) },
            cancel() {
              cancelled++
              return cancelMode === 'pending' ? new Promise<void>(() => {}) : Promise.reject(new Error('cleanup failed'))
            },
          }), {
            status: 307,
            headers: { 'content-type': 'application/json', 'x-request-id': 'boundary-fixture', ...(declared ? { 'content-length': String(64 * 1024 + 1) } : {}) },
          })
          const client = new VeniceClient(config('http://unused.invalid'))
          for (const call of readCalls) {
            await assert.rejects(call.invoke(client, '/redirect'), isUpstreamError(307, {
              error: 'upstream_error_body_truncated', truncated: true, max_bytes: 64 * 1024,
            }))
          }
          assert.equal(cancelled, readCalls.length)
        } finally {
          globalThis.fetch = originalFetch
        }
      })
    }
  }
})

describe('large legitimate catalog, resource, and embeddings callers', () => {
  it('allows multi-MiB responses below the default through real tool and resource handlers', async () => {
    const catalog = {
      data: Array.from({ length: 160 }, (_, i) => ({
        id: `model-${i}`, type: 'tts',
        model_spec: { name: `Model ${i}`, description: 'x'.repeat(16 * 1024), voices: ['alloy'], default_voice: 'alloy' },
      })),
    }
    const embeddings = {
      data: Array.from({ length: 128 }, (_, index) => ({ index, embedding: Array.from({ length: 4096 }, () => 0.123456) })),
    }
    const styles = { data: Array.from({ length: 160 }, (_, i) => ({ name: `style-${i}`, description: 'x'.repeat(16 * 1024) })) }
    for (const payload of [catalog, embeddings, styles]) {
      const bytes = Buffer.byteLength(JSON.stringify(payload))
      assert.ok(bytes > 2 * MiB && bytes < 16 * MiB)
    }
    const observed: string[] = []
    const server = http.createServer((req, res) => {
      req.resume()
      observed.push(req.url!)
      const payload = req.url === '/v1/embeddings' ? embeddings : req.url === '/v1/image/styles' ? styles : catalog
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    })
    const baseUrl = await listen(server)
    try {
      const cfg = config(baseUrl)
      const client = new VeniceClient(cfg)
      const tools = buildTools(client, cfg)
      const tool = (name: string) => tools.find((entry) => entry.name === name)!
      const models = await tool('venice_list_models').handler({})
      assert.notEqual(models.isError, true)
      assert.equal(models.structuredContent?.total, catalog.data.length)
      assert.deepEqual(models.structuredContent?.ids, catalog.data.map(({ id }) => id))
      const details = await tool('venice_model_details').handler({ model_id: 'model-159', type: 'tts' })
      assert.notEqual(details.isError, true)
      assert.equal(details.structuredContent?.id, 'model-159')
      const embedded = await tool('venice_embeddings').handler({ model: 'fixture', input: ['hello'] })
      assert.notEqual(embedded.isError, true)
      assert.deepEqual(embedded.structuredContent, { count: 128, dimensions: 4096 })
      const text = embedded.content[0]
      assert.equal(text.type, 'text')
      if (text.type === 'text') assert.deepEqual(JSON.parse(text.text), embeddings)
      for (const resource of buildResources(client)) {
        const result = await resource.read()
        assert.equal(result.mimeType, 'application/json')
        const parsed = JSON.parse(result.text)
        if (resource.uri === 'venice://models') assert.deepEqual(parsed, catalog)
        else if (resource.uri === 'venice://styles') assert.deepEqual(parsed, styles)
        else {
          assert.equal(parsed.data.length, 160)
          assert.deepEqual(parsed.data[159].voices, ['alloy'])
        }
      }
      assert.ok(observed.includes('/v1/models?type=all'))
      assert.ok(observed.includes('/v1/models?type=tts'))
      assert.ok(observed.includes('/v1/embeddings'))
      assert.ok(observed.includes('/v1/image/styles'))
    } finally {
      await close(server)
    }
  })
})
