import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/server.js'
import { buildTools } from '../src/tools/index.js'
import { VeniceClient, VeniceResponseTooLargeError } from '../src/venice-client.js'
import { close, config, listen } from './helpers/upstream-boundaries.js'

describe('embedding batch preflight', () => {
  it('rejects oversized batches before submission through both the handler and MCP', async () => {
    let requests = 0
    const upstream = http.createServer((req, res) => {
      requests++
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}')
    })
    const cfg = config(await listen(upstream))
    const tool = buildTools(new VeniceClient(cfg), cfg).find(({ name }) => name === 'venice_embeddings')!
    const server = buildServer({ config: cfg })
    const client = new Client({ name: 'embedding-preflight-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      for (const [count, encoding_format] of [[129, 'float'], [256, 'float'], [129, 'base64']] as const) {
        const args = { model: 'fixture', input: Array.from({ length: count }, () => 'hello'), encoding_format }
        const direct = await tool.handler(args)
        assert.equal(direct.isError, true)
        assert.match(JSON.stringify(direct.content), /128/)
        assert.match(JSON.stringify(direct.content), /before|submitted/i)
        const result = await client.callTool({ name: 'venice_embeddings', arguments: args })
        assert.equal(result.isError, true)
        assert.match(JSON.stringify(result.content), /128/)
        assert.match(JSON.stringify(result.content), /no request was submitted/i)
      }
      assert.equal(requests, 0, 'oversized batches must not reach a potentially billable endpoint')
      const accepted = await client.callTool({
        name: 'venice_embeddings',
        arguments: { model: 'fixture', input: Array(128).fill('hello') },
      })
      assert.notEqual(accepted.isError, true)
      assert.equal(requests, 1, 'MCP validation must accept exactly 128 texts')
    } finally {
      await client.close()
      await server.close()
      await close(upstream)
    }
  })

  it('retains the byte guard for a full-precision 256-vector upstream response', async () => {
    const vector = Array.from({ length: 4096 }, () => -0.12345678901234568)
    const body = JSON.stringify({ data: Array.from({ length: 256 }, (_, index) => ({ index, embedding: vector })) })
    assert.ok(Buffer.byteLength(body) > 16 * 1024 * 1024)
    const upstream = http.createServer((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    })
    const cfg = config(await listen(upstream))
    try {
      await assert.rejects(
        new VeniceClient(cfg).post('/v1/embeddings', { model: 'fixture', input: Array(256).fill('hello') }),
        VeniceResponseTooLargeError,
      )
    } finally {
      await close(upstream)
    }
  })

  it('returns every vector for 128 texts at 4096 dimensions without retrying or splitting', async () => {
    const vector = Array.from({ length: 4096 }, (_, i) => i % 2 ? -0.12345678901234568 : 0.12345678901234568)
    const payload = {
      model: 'fixture',
      data: Array.from({ length: 128 }, (_, index) => ({ index, embedding: vector })),
      usage: { prompt_tokens: 128, total_tokens: 128 },
    }
    const body = JSON.stringify(payload)
    assert.ok(Buffer.byteLength(body) > 8 * 1024 * 1024)
    assert.ok(Buffer.byteLength(body) < 16 * 1024 * 1024)
    const received: unknown[] = []
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write(body.slice(0, 100))
      res.end(body.slice(100))
    })
    const cfg = config(await listen(upstream))
    try {
      const tool = buildTools(new VeniceClient(cfg), cfg).find(({ name }) => name === 'venice_embeddings')!
      const args = { model: 'fixture', input: Array.from({ length: 128 }, (_, i) => `text ${i}`) }
      const result = await tool.handler(args)
      assert.notEqual(result.isError, true)
      assert.deepEqual(received, [args])
      assert.deepEqual(result.structuredContent, { count: 128, dimensions: 4096 })
      const content = result.content[0]
      assert.equal(content.type, 'text')
      if (content.type === 'text') assert.deepEqual(JSON.parse(content.text), payload)
    } finally {
      await close(upstream)
    }
  })

  it('preserves a single text and base64 response', async () => {
    const args = { model: 'fixture', input: 'hello', encoding_format: 'base64' }
    const payload = { data: [{ index: 0, embedding: 'zczMPc3MTD6amZk+' }] }
    const received: unknown[] = []
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    })
    const cfg = config(await listen(upstream))
    try {
      const tool = buildTools(new VeniceClient(cfg), cfg).find(({ name }) => name === 'venice_embeddings')!
      const result = await tool.handler(args)
      assert.notEqual(result.isError, true)
      assert.deepEqual(received, [args])
      assert.deepEqual(result.structuredContent, { count: 1, dimensions: null })
      const content = result.content[0]
      assert.equal(content.type, 'text')
      if (content.type === 'text') assert.deepEqual(JSON.parse(content.text), payload)
    } finally {
      await close(upstream)
    }
  })
})
