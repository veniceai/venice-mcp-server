import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { VeniceUpstreamError } from '../src/types.js'
import { VeniceClient } from '../src/venice-client.js'
import {
  API_KEY,
  MiB,
  REQUEST_MARKER,
  SIWX,
  calls,
  close,
  config,
  isUpstreamError,
  listen,
  readCalls,
} from './helpers/upstream-boundaries.js'

describe('upstream redirects never forward credentials or request bodies', () => {
  let source: http.Server
  let destination: http.Server
  let sourceUrl: string
  let destinationUrl: string
  const destinationCalls: Array<{ headers: http.IncomingHttpHeaders; body: string }> = []
  const sourceCalls: Array<{ headers: http.IncomingHttpHeaders; body: string }> = []
  let sameOriginHits = 0

  before(async () => {
    destination = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      destinationCalls.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"leaked":true}')
    })
    destinationUrl = await listen(destination)
    source = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      sourceCalls.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
      if (req.url === '/same-destination') {
        sameOriginHits++
        res.writeHead(200).end()
        return
      }
      const [, , status, kind = 'json'] = req.url!.split('/')
      const location = kind === 'same' ? `${sourceUrl}/same-destination` : `${destinationUrl}/destination-secret`
      res.writeHead(Number(status), {
        location,
        'content-type': kind === 'text' ? 'text/plain' : 'application/json',
        'x-request-id': 'boundary-fixture',
      })
      res.end(kind === 'text' ? 'This endpoint has moved' : '{"error":"endpoint_moved"}')
    })
    sourceUrl = await listen(source)
    assert.notEqual(sourceUrl, destinationUrl)
  })

  after(async () => {
    await Promise.all([close(source), close(destination)])
    assert.deepEqual(destinationCalls, [], 'redirect destination must receive no requests, headers, or bodies')
    assert.equal(sameOriginHits, 0)
  })

  for (const status of [301, 302, 303, 307, 308]) {
    for (const auth of ['siwx', 'apiKey'] as const) {
      for (const call of calls) {
        it(`${status} ${auth} ${call.name}: preserves source status with zero destination hits`, async () => {
          const client = new VeniceClient({
            ...config(sourceUrl),
            siwxToken: auth === 'siwx' ? SIWX : undefined,
            apiKey: auth === 'apiKey' ? API_KEY : undefined,
          })
          const count = sourceCalls.length
          await assert.rejects(call.invoke(client, `/redirect/${status}`), isUpstreamError(status, { error: 'endpoint_moved' }))
          assert.equal(sourceCalls.length, count + 1)
          const observed = sourceCalls.at(-1)!
          assert.equal(observed.headers['sign-in-with-x'], auth === 'siwx' ? SIWX : undefined)
          assert.equal(observed.headers.authorization, auth === 'apiKey' ? `Bearer ${API_KEY}` : undefined)
          if (call.hasBody) assert.ok(observed.body.includes(REQUEST_MARKER))
          else assert.equal(observed.body, '')
          assert.deepEqual(destinationCalls, [])
        })
      }
    }
  }

  it('preserves useful text redirect bodies and rejects same-origin redirects', async () => {
    const client = new VeniceClient(config(sourceUrl))
    for (const call of readCalls) {
      await assert.rejects(call.invoke(client, '/redirect/307/text'), isUpstreamError(307, 'This endpoint has moved'))
      await assert.rejects(call.invoke(client, '/redirect/308/same'), isUpstreamError(308, { error: 'endpoint_moved' }))
    }
    assert.equal(sameOriginHits, 0)
  })

  it('also protects a caller-supplied custom SIWX header', async () => {
    const client = new VeniceClient(config(sourceUrl))
    for (const invoke of [
      () => client.post('/redirect/307', { prompt: REQUEST_MARKER }, { 'SIGN-IN-WITH-X': SIWX }),
      () => client.postBinary('/redirect/308', { json: { prompt: REQUEST_MARKER }, headers: { 'SIGN-IN-WITH-X': SIWX } }),
    ]) {
      await assert.rejects(invoke, VeniceUpstreamError)
      assert.equal(sourceCalls.at(-1)!.headers['sign-in-with-x'], SIWX)
      assert.ok(sourceCalls.at(-1)!.body.includes(REQUEST_MARKER))
    }
    assert.deepEqual(destinationCalls, [])
  })
})

describe('original error status, payment instructions, and cancellation deadlines', () => {
  let server: http.Server
  let baseUrl: string
  const aborted = new Set<string>()

  before(async () => {
    server = http.createServer((req, res) => {
      req.resume()
      const [, , statusText, mode] = req.url!.split('/')
      const status = Number(statusText)
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-request-id': 'boundary-fixture',
        'x-venice-rpc-credits': '20',
      }
      // A redirect target on this same fixture must never be requested.
      if (status >= 300 && status < 400) headers.location = `${baseUrl}/unexpected-follow`
      res.on('close', () => { if (!res.writableFinished) aborted.add(req.url!) })
      if (mode === 'declared') headers['content-length'] = String(2 * MiB)
      res.writeHead(status, headers)
      if (mode === 'declared') res.flushHeaders()
      else if (mode === 'stall') res.write('{"error":"unfinished')
      else if (mode === 'broken') {
        res.write('{"error":"unfinished')
        setImmediate(() => res.destroy())
      } else if (mode === 'malformed') res.end('{"error":')
      else if (mode === 'oversized') {
        res.write('{"error":"')
        res.end(`${'x'.repeat(2 * MiB)}"}`)
      } else if (mode === 'overflow-stall') {
        res.write('x'.repeat(64 * 1024 + 1))
      } else {
        res.end(JSON.stringify({ reason: 'insufficient_balance', instructions: 'x'.repeat(128 * 1024) }))
      }
    })
    baseUrl = await listen(server)
  })
  after(async () => close(server))

  for (const status of [301, 302, 303, 307, 308, 402, 500]) {
    for (const mode of ['declared', 'oversized', 'stall', 'broken', 'malformed']) {
      it(`${status} ${mode} preserves status and headers across transports`, { timeout: 3_000 }, async () => {
        const client = new VeniceClient({ ...config(baseUrl), timeoutMs: 100 })
        for (const call of readCalls) {
          const expected = mode === 'declared' || mode === 'oversized'
            ? { error: 'upstream_error_body_truncated', truncated: true, max_bytes: status === 402 ? MiB : 64 * 1024 }
            : {}
          await assert.rejects(call.invoke(client, `/error/${status}/${mode}`), isUpstreamError(status, expected))
        }
      })
    }
  }

  it('retains useful 402 bodies above the generic error and caller success caps', async () => {
    const client = new VeniceClient(config(baseUrl))
    for (const call of [...readCalls, calls.find(({ name }) => name === 'mixed')!]) {
      await assert.rejects(call.invoke(client, '/error/402/payment', { maxBytes: 8 }), isUpstreamError(402, {
        reason: 'insufficient_balance', instructions: 'x'.repeat(128 * 1024),
      }))
    }
  })

  it('preserves generic error truncation and smaller caller error budgets', async () => {
    const client = new VeniceClient(config(baseUrl))
    for (const call of readCalls.filter(({ name }) => !name.startsWith('binary'))) {
      await assert.rejects(call.invoke(client, '/error/307/payment', { maxBytes: 32 }), isUpstreamError(307, {
        error: 'upstream_error_body_truncated', truncated: true, max_bytes: 32,
      }))
    }
  })

  it('closes stalled and advertised oversized error bodies', { timeout: 2_000 }, async () => {
    const client = new VeniceClient({ ...config(baseUrl), timeoutMs: 75 })
    for (const mode of ['stall', 'declared', 'overflow-stall']) {
      const path = `/error/308/${mode}/cancellation-check`
      await assert.rejects(client.post(path, {}), VeniceUpstreamError)
      for (let i = 0; i < 50 && !aborted.has(path); i++) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(aborted.has(path), `upstream must observe cancellation for ${mode}`)
    }
  })
})
