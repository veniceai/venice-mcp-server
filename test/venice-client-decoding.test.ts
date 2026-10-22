import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  VeniceClient,
  VeniceMalformedResponseError,
  VeniceResponseTooLargeError,
} from '../src/venice-client.js'
import { close, config, listen } from './helpers/upstream-boundaries.js'

describe('requestWithMetadata UTF-8 compatibility', () => {
  let server: http.Server
  let client: VeniceClient
  const json = { text: 'café 🌊 \uFEFF inside' }
  const text = 'café 🌊 \uFEFF inside\r\n'
  const sse = `data: ${JSON.stringify(json)}\r\n\r\ndata: [DONE]\r\n\r\n`
  const bodies = {
    json: Buffer.from(`\uFEFF${JSON.stringify(json)}`),
    doubleJson: Buffer.from(`\uFEFF\uFEFF${JSON.stringify(json)}`),
    text: Buffer.from(`\uFEFF${text}`),
    sse: Buffer.from(`\uFEFF${sse}`),
    invalid: Buffer.concat([Buffer.from('\uFEFF{"text":"'), Buffer.from([0xe2, 0x28, 0xa1]), Buffer.from('"}')]),
    malformed: Buffer.from('\uFEFF{"text":'),
  }

  before(async () => {
    server = http.createServer(async (req, res) => {
      req.resume()
      const url = new URL(req.url!, 'http://fixture')
      const kind = url.pathname.slice(1) as keyof typeof bodies
      const body = bodies[kind]
      res.writeHead(200, {
        'content-type': kind === 'sse' ? 'text/event-stream' : kind === 'text' ? 'text/plain' : 'application/json',
        'x-request-id': 'utf8-fixture',
      })
      const split = Number(url.searchParams.get('split'))
      if (split > 0) {
        for (let offset = 0; offset < body.length; offset += split) {
          res.write(body.subarray(offset, offset + split))
          await delay(2)
        }
        res.end()
      } else {
        res.end(body)
      }
    })
    client = new VeniceClient(config(await listen(server)))
  })
  after(async () => close(server))

  for (const split of [0, 1, 2]) {
    it(`decodes default-budget JSON with a leading BOM (${split || 'whole'}-byte chunks)`, async () => {
      const response = await client.requestWithMetadata(`/json?split=${split}`)
      assert.deepEqual(response.data, json)
      assert.equal(response.status, 200)
      assert.equal(response.headers['x-request-id'], 'utf8-fixture')
    })
  }

  it('matches the former fetch decoder for repeated leading BOMs', async () => {
    const expected = JSON.parse(await new Response(bodies.doubleJson).text())
    assert.deepEqual(await client.get('/doubleJson?split=1'), expected)
  })

  it('preserves default-budget text decoding and embedded BOM characters', async () => {
    assert.equal(await client.get('/text?split=1'), text)
  })

  it('preserves UTF-8 replacement for invalid bytes split across chunks', async () => {
    assert.deepEqual(await client.get('/invalid?split=1'), { text: '\uFFFD(\uFFFD' })
  })

  it('still rejects malformed JSON after a leading BOM', async () => {
    await assert.rejects(client.get('/malformed?split=1'), VeniceMalformedResponseError)
  })

  it('preserves default-budget SSE framing after Response.text-compatible BOM decoding', async () => {
    assert.equal(await client.request('/sse?split=1', { responseType: 'event-stream' }), sse)
  })

  it('keeps explicitly bounded text and SSE decoding unchanged, including the BOM', async () => {
    assert.equal(await client.get('/text?split=1', undefined, { maxBytes: bodies.text.length }), `\uFEFF${text}`)
    assert.equal(await client.request('/sse?split=1', {
      responseType: 'event-stream', maxResponseBytes: bodies.sse.length,
    }), `\uFEFF${sse}`)
  })
})

describe('response overflow billing guidance', () => {
  let server: http.Server
  let client: VeniceClient
  const observed: Array<{ method: string; path: string; payment: string | string[] | undefined }> = []
  const body = JSON.stringify({ data: 'x'.repeat(128) })

  before(async () => {
    server = http.createServer((req, res) => {
      req.resume()
      const url = new URL(req.url!, 'http://fixture')
      observed.push({ method: req.method!, path: url.pathname, payment: req.headers['payment-signature'] })
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(url.searchParams.get('wire') === 'declared' ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
        ...(url.pathname === '/v1/crypto/rpc/ethereum-mainnet' ? { 'x-venice-rpc-credits': '20' } : {}),
      })
      res.write(body.slice(0, 32))
      res.end(body.slice(32))
    })
    client = new VeniceClient(config(await listen(server)))
  })
  after(async () => close(server))

  for (const [label, method, path] of [
    ['free catalog', 'GET', '/v1/models'],
    ['free RPC networks', 'GET', '/v1/crypto/rpc/networks'],
    ['free quote', 'POST', '/v1/video/quote'],
    ['payment-free x402 discovery', 'POST', '/v1/x402/top-up'],
    ['paid inference', 'POST', '/v1/chat/completions'],
    ['paid RPC', 'POST', '/v1/crypto/rpc/ethereum-mainnet'],
  ] as const) {
    for (const wire of ['declared', 'chunked']) {
      it(`qualifies billing risk for oversized ${label} ${method} (${wire})`, async () => {
        const url = `${path}?wire=${wire}`
        await assert.rejects(client.requestWithMetadata(url, {
          method, json: method === 'POST' ? {} : undefined, auth: 'none', maxBytes: 64,
        }), (err: unknown) => {
          assert.ok(err instanceof VeniceResponseTooLargeError)
          assert.equal(err.path, url)
          assert.equal(err.maxBytes, 64)
          assert.match(err.message, /If this was a billable request, it may have been charged; check its result before retrying\./)
          assert.doesNotMatch(err.message, /The request may have completed upstream and been charged/)
          if (path === '/v1/crypto/rpc/ethereum-mainnet') assert.equal(err.headers['x-venice-rpc-credits'], '20')
          return true
        })
        assert.deepEqual(observed.at(-1), { method, path, payment: undefined })
      })
    }
  }
})
