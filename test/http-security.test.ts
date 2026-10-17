import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http, { type IncomingHttpHeaders } from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadConfig } from '../src/config.js'
import { buildServer } from '../src/server.js'
import { runHttp } from '../src/transports/http.js'
import { startMockVenice } from './helpers/mock-venice-server.js'

const TOKEN = 'synthetic-http-token-0123456789'
const ACCEPT = 'application/json, text/event-stream'
const initialize = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'http-security-test', version: '1' },
  },
}

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  text: string
}

interface RequestOptions {
  method?: string
  path?: string
  headers?: http.OutgoingHttpHeaders
  body?: string
  /** Send only a prefix; rejection must arrive before the body is complete. */
  incompleteBody?: boolean
}

function request(port: number, opts: RequestOptions = {}): Promise<HttpResult> {
  const body = opts.body ?? JSON.stringify(initialize)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp',
      agent: false, setHost: false,
      headers: {
        host: `127.0.0.1:${port}`, accept: ACCEPT, 'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)), ...opts.headers,
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('error', reject)
      res.on('end', () => {
        resolve({ status: res.statusCode!, headers: res.headers, text })
        req.destroy()
      })
    })
    req.setTimeout(5000, () => req.destroy(new Error('local HTTP test timed out')))
    req.on('error', reject)
    if (opts.incompleteBody) req.write(body.slice(0, 1024))
    else req.end(body)
  })
}

function rawRequest(port: number, headers: string[]): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let raw = ''
    socket.setTimeout(5000, () => socket.destroy(new Error('raw HTTP test timed out')))
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      const body = JSON.stringify(initialize)
      socket.write([
        'POST /mcp HTTP/1.1', ...headers,
        `Accept: ${ACCEPT}`, 'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body,
      ].join('\r\n'))
    })
    socket.on('data', (chunk) => { raw += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      const [head, text] = raw.split('\r\n\r\n')
      resolve({ status: Number(head.split(' ')[1]), headers: {}, text: text ?? '' })
    })
  })
}

async function fixture(t: TestContext, opts: {
  env?: NodeJS.ProcessEnv
  host?: string
  configureServer?: (server: ReturnType<typeof buildServer>) => void
} = {}) {
  const upstream = await startMockVenice([
    {
      match: 'POST /v1/chat/completions',
      reply: { id: 'local-chat', model: 'local-model', choices: [{ message: { content: 'local reply' } }] },
    },
  ])
  t.after(() => upstream.close())
  let builds = 0
  const listener = await runHttp({
    port: 0, host: opts.host ?? '127.0.0.1', env: opts.env ?? {},
    serverFactory: () => {
      builds++
      const server = buildServer({
        config: loadConfig({ VENICE_API_KEY: 'synthetic-upstream-key', VENICE_TEST_BASE_URL: upstream.url }),
      })
      opts.configureServer?.(server)
      return server
    },
  })
  t.after(() => new Promise<void>((resolve, reject) => {
    listener.close((err) => err ? reject(err) : resolve())
    listener.closeAllConnections()
  }))
  const port = (listener.address() as AddressInfo).port
  return { port, upstream, builds: () => builds, request: (opts?: RequestOptions) => request(port, opts) }
}

function assertJsonError(result: HttpResult, status: number, error: string) {
  assert.equal(result.status, status, result.text)
  assert.match(result.headers['content-type'] ?? '', /^application\/json/)
  assert.deepEqual(JSON.parse(result.text), { error })
}

describe('HTTP Host and Origin boundary', () => {
  for (const token of [undefined, TOKEN]) {
    it(`blocks hostile headers before parsing, auth, and dispatch (${token ? 'token configured' : 'no token'})`, async (t) => {
      const f = await fixture(t, { env: { VENICE_MCP_AUTH_TOKEN: token } })
      const host = `127.0.0.1:${f.port}`
      const origins = [
        'https://attacker.example', 'null', '', 'not-an-origin',
        `http://localhost:${f.port === 6274 ? 6275 : 6274}`,
        `http://localhost:${f.port}/`, `http://localhost:${f.port}/path`,
        `http://localhost:${f.port}?query=1`, `http://localhost:${f.port}#fragment`,
        `http://user@localhost:${f.port}`, `https://localhost:${f.port}`,
        `http://localhost.attacker.example:${f.port}`, `http://sub.localhost:${f.port}`,
        `http://localhost:${f.port}, http://127.0.0.1:${f.port}`,
      ]
      const hosts = [
        `attacker.example:${f.port}`, `localhost.attacker.example:${f.port}`,
        `sub.localhost:${f.port}`, `localhost.:${f.port}`, `localhost:${f.port + 1}`,
        'localhost', '127.0.0.1', `127.0.0.2:${f.port}`, `127.1:${f.port}`,
        `localhost:${f.port}@attacker.example`, `localhost:${f.port}/path`,
        `${host},attacker.example`, '',
      ]
      for (const authorization of token ? [undefined, `Bearer ${token}`] : [undefined]) {
        for (const hostile of [
          ...origins.map((origin) => ({ host, origin })),
          ...hosts.map((value) => ({ host: value, origin: `http://localhost:${f.port}` })),
        ]) {
          const result = await f.request({
            headers: {
              ...hostile, ...(authorization ? { authorization } : {}),
              'x-forwarded-host': host, 'x-forwarded-proto': 'http',
              forwarded: `host=${host};proto=http`,
            },
            body: '{malformed-private-marker',
          })
          assert.equal(result.status, 403, JSON.stringify(hostile))
          assertJsonError(result, 403, 'forbidden')
        }
      }
      assert.equal(f.builds(), 0)
      assert.equal(f.upstream.calls.length, 0)
    })

    it(`blocks repeated hostile requests with an issued session (${token ? 'token configured' : 'no token'})`, async (t) => {
      const f = await fixture(t, { env: { VENICE_MCP_AUTH_TOKEN: token } })
      const auth = token ? { authorization: `Bearer ${token}` } : {}
      const initialized = await f.request({ headers: auth })
      assert.equal(initialized.status, 200, initialized.text)
      const session = initialized.headers['mcp-session-id'] as string
      assert.ok(session)
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const hostile of [{ host: 'attacker.example' }, { origin: 'https://attacker.example' }]) {
          for (const method of ['POST', 'GET', 'DELETE']) {
            const result = await f.request({
              method, headers: { ...auth, ...hostile, 'mcp-session-id': session },
              body: method === 'POST' ? JSON.stringify({
                jsonrpc: '2.0', id: 2, method: 'tools/call',
                params: { name: 'venice_chat', arguments: { messages: [{ role: 'user', content: 'blocked' }] } },
              }) : '',
            })
            assertJsonError(result, 403, 'forbidden')
          }
        }
      }
      assert.equal(f.builds(), 1)
      assert.equal(f.upstream.calls.length, 0)
      const ping = await f.request({
        headers: { ...auth, 'mcp-session-id': session },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
      })
      assert.equal(ping.status, 200, ping.text)
      assert.deepEqual(JSON.parse(ping.text).result, {})
    })
  }

  it('rejects duplicate, missing, and malformed raw headers before parsing', async (t) => {
    const f = await fixture(t)
    const host = `127.0.0.1:${f.port}`
    const origin = `http://${host}`
    for (const headers of [
      [], ['Host:'], ['Host: localhost:bad'],
      [`Host: ${host}`, `hOsT: ${host}`],
      [`Host: ${host}`, 'Host: attacker.example'],
      ['Host: attacker.example', `Host: ${host}`],
      [`Host: ${host}`, `Origin: ${origin}`, `oRiGiN: ${origin}`],
      [`Host: ${host}`, `Origin: ${origin}`, 'Origin: null'],
      [`Host: ${host}`, 'Origin: null', `Origin: ${origin}`],
    ]) {
      const result = await rawRequest(f.port, headers)
      // Node may reject missing/duplicate Host itself before Express receives it.
      assert.ok([400, 403].includes(result.status), `${headers.join('; ')}: ${result.status}`)
      assert.doesNotMatch(result.text, /SyntaxError|stack|<html|invalid request body/i)
    }
    assert.equal(f.builds(), 0)
  })

  it('keeps exact defaults on exposed binds, even with the explicit no-auth proxy override', async (t) => {
    for (const env of [{ VENICE_MCP_AUTH_TOKEN: TOKEN }, { VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP: '1' }]) {
      const f = await fixture(t, { host: '0.0.0.0', env })
      const headers = env.VENICE_MCP_AUTH_TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}
      assertJsonError(await f.request({ headers: { ...headers, host: 'proxy.example' } }), 403, 'forbidden')
      assertJsonError(await f.request({ headers: { ...headers, origin: 'http://localhost:6274' } }), 403, 'forbidden')
      assert.equal((await f.request({ headers })).status, 200)
    }
  })

  it('supports exact proxy authorities and Inspector origins without trusting suffixes or forwarded headers', async (t) => {
    const f = await fixture(t, { env: {
      VENICE_MCP_AUTH_TOKEN: TOKEN,
      VENICE_MCP_ALLOWED_HOSTS: 'mcp.example, proxy.example:8443',
      VENICE_MCP_ALLOWED_ORIGINS: 'https://app.example, http://localhost:6274',
    } })
    const auth = { authorization: `Bearer ${TOKEN}` }
    for (const host of ['mcp.example', 'proxy.example:8443', 'MCP.EXAMPLE']) {
      for (const origin of [undefined, 'https://app.example', 'http://localhost:6274']) {
        const result = await f.request({ headers: { ...auth, host, ...(origin ? { origin } : {}) } })
        assert.equal(result.status, 200, result.text)
      }
    }
    for (const headers of [
      { host: 'mcp.example.attacker.example', origin: 'https://app.example' },
      { host: 'mcp.example:8443' }, { host: 'proxy.example' },
      { host: 'mcp.example', origin: 'https://app.example.attacker.example' },
      { host: 'mcp.example', origin: 'http://localhost:6275' },
      { host: 'mcp.example', origin: `http://localhost:${f.port}` },
      { host: `127.0.0.1:${f.port}`, 'x-forwarded-host': 'mcp.example' },
    ]) {
      assertJsonError(await f.request({ headers: { ...auth, ...headers } }), 403, 'forbidden')
    }
  })

  it('fails startup for invalid allowlists', async () => {
    for (const [name, values] of [
      ['VENICE_MCP_ALLOWED_HOSTS', ['', '*', '*.example', 'localhost,', 'http://localhost:3333',
        'user@localhost', 'localhost/path', 'localhost:65536', '127.1', 'localhost:0',
        'mcp..example', 'mcp.-example', 'mcp.example-', 'localhost.']],
      ['VENICE_MCP_ALLOWED_ORIGINS', ['', '*', 'null', 'https://*.example', 'localhost:3333',
        'https://app.example/', 'https://user@app.example', 'https://app.example/path',
        'https://app.example?query=1', 'https://app.example#fragment', 'file://app.example',
        'https://app.example,', 'https://127.1']],
    ] as const) {
      for (const value of values) {
        await assert.rejects(runHttp({ port: 0, env: { [name]: value } }), new RegExp(name))
      }
    }
  })

  it('keeps health exempt from headers, auth, and JSON parsing', async (t) => {
    const f = await fixture(t, { env: { VENICE_MCP_AUTH_TOKEN: TOKEN } })
    const result = await f.request({
      method: 'GET', path: '/healthz', body: '{malformed',
      headers: { host: 'probe.internal', origin: 'null' },
    })
    assert.equal(result.status, 200)
    assert.deepEqual(JSON.parse(result.text), { ok: true, name: '@veniceai/mcp-server' })
    assert.equal(f.builds(), 0)
  })
})

describe('HTTP authentication, parsing, and allocation', () => {
  it('authenticates before malformed and oversized JSON parsing', async (t) => {
    const f = await fixture(t, { env: { VENICE_MCP_AUTH_TOKEN: TOKEN } })
    for (const body of ['{"private-marker":', JSON.stringify({ payload: 'x'.repeat(10 * 1024 * 1024) })]) {
      for (const authorization of [undefined, 'Bearer wrong']) {
        const result = await f.request({
          body, incompleteBody: body.length > 1024,
          headers: authorization ? { authorization } : {},
        })
        assertJsonError(result, 401, 'unauthorized')
        assert.equal(result.headers['www-authenticate'], 'Bearer')
      }
      assertJsonError(await f.request({
        body, incompleteBody: body.length > 1024,
        headers: { host: 'attacker.example', authorization: `Bearer ${TOKEN}` },
      }), 403, 'forbidden')
    }
    assert.equal(f.builds(), 0)
  })

  it('returns generic JSON for malformed, oversized, and unsupported encoded bodies', async (t) => {
    const f = await fixture(t, { env: { VENICE_MCP_AUTH_TOKEN: TOKEN } })
    const headers = { authorization: `Bearer ${TOKEN}` }
    assertJsonError(await f.request({ headers, body: '{"sensitive-marker":' }), 400, 'invalid request body')
    assertJsonError(await f.request({
      headers, body: JSON.stringify({ payload: 'x'.repeat(10 * 1024 * 1024) }),
    }), 413, 'request body too large')
    assertJsonError(await f.request({
      headers: { ...headers, 'content-encoding': 'gzip' }, body: 'not gzip; private-marker',
    }), 400, 'invalid request body')
    assertJsonError(await f.request({
      headers: { ...headers, 'content-type': 'application/json; charset=unsupported' },
    }), 415, 'invalid request body')
    assert.equal(f.builds(), 0)
    assert.equal((await f.request({ headers })).status, 200)
  })

  it('rejects invalid sessionless methods and envelopes without building a server', async (t) => {
    const f = await fixture(t)
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD']) {
      const result = await f.request({ method, body: '' })
      assert.equal(result.status, ['GET', 'DELETE'].includes(method) ? 400 : 405)
    }
    for (const body of [
      {}, [], [initialize, initialize], { ...initialize, jsonrpc: '1.0' },
      { ...initialize, id: null }, { ...initialize, id: undefined },
      { ...initialize, params: {} }, { ...initialize, params: { ...initialize.params, capabilities: null } },
      { ...initialize, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]) {
      assert.equal((await f.request({ body: JSON.stringify(body) })).status, 400)
    }
    assert.equal((await f.request({ headers: { 'content-type': 'text/plain' } })).status, 415)
    assert.equal((await f.request({ headers: { 'mcp-session-id': 'invalid' } })).status, 400)
    assert.equal((await f.request({ headers: { 'mcp-session-id': '550e8400-e29b-41d4-a716-446655440000' } })).status, 404)
    assert.equal(f.builds(), 0)
    assert.equal(f.upstream.calls.length, 0)
  })

  it('closes unsupported-Accept initialization and preserves successful sessions and capacity', async (t) => {
    const closed: StreamableHTTPServerTransport[] = []
    const originalClose = StreamableHTTPServerTransport.prototype.close
    t.mock.method(StreamableHTTPServerTransport.prototype, 'close', async function (this: StreamableHTTPServerTransport) {
      closed.push(this)
      await originalClose.call(this)
    })
    const f = await fixture(t, { env: { VENICE_MCP_MAX_SESSIONS: '1' } })
    for (const accept of ['text/html', 'application/json']) {
      assert.equal((await f.request({ headers: { accept } })).status, 406)
    }
    assert.equal(closed.length, 2)
    const result = await f.request()
    assert.equal(result.status, 200, result.text)
    assert.equal(closed.length, 2)
    assert.equal((await f.request()).status, 503)
    const session = result.headers['mcp-session-id'] as string
    assert.equal((await f.request({ method: 'DELETE', body: '', headers: { 'mcp-session-id': session } })).status, 200)
    assert.equal((await f.request({ headers: { 'mcp-session-id': session } })).status, 404)
    assert.equal((await f.request()).status, 200)
  })

  for (const failure of ['connect', 'handle-before-init', 'handle-after-init'] as const) {
    it(`closes a newly constructed transport after ${failure} failure`, async (t) => {
      const closed: StreamableHTTPServerTransport[] = []
      const originalClose = StreamableHTTPServerTransport.prototype.close
      t.mock.method(StreamableHTTPServerTransport.prototype, 'close', async function (this: StreamableHTTPServerTransport) {
        closed.push(this)
        await originalClose.call(this)
      })
      let failed = false
      const f = await fixture(t, {
        env: { VENICE_MCP_MAX_SESSIONS: '1' },
        configureServer: (server) => {
          if (failed) return
          failed = true
          const connect = server.connect.bind(server)
          t.mock.method(server, 'connect', async (transport: StreamableHTTPServerTransport) => {
            if (failure === 'connect') throw new Error('synthetic connect failure')
            const handleRequest = transport.handleRequest.bind(transport)
            t.mock.method(transport, 'handleRequest', async (...args: Parameters<typeof transport.handleRequest>) => {
              if (failure === 'handle-after-init') await handleRequest(...args)
              throw new Error('synthetic handling failure')
            })
            await connect(transport)
          })
        },
      })
      const result = await f.request()
      assert.equal(result.status, failure === 'handle-after-init' ? 200 : 500)
      assert.equal(closed.length, 1)
      if (failure === 'handle-after-init') {
        assert.equal((await f.request({ headers: { 'mcp-session-id': result.headers['mcp-session-id'] as string } })).status, 404)
      }
      assert.equal((await f.request()).status, 200)
      assert.equal(closed.length, 1)
    })
  }
})

describe('legitimate HTTP clients', () => {
  it('accepts the three exact local authorities and origins, and missing Origin', async (t) => {
    const f = await fixture(t)
    for (const name of ['localhost', '127.0.0.1', '[::1]']) {
      const host = `${name}:${f.port}`
      for (const origin of [undefined, `http://${host}`]) {
        const result = await f.request({ headers: { host, ...(origin ? { origin } : {}) } })
        assert.equal(result.status, 200, result.text)
        assert.ok(result.headers['mcp-session-id'])
      }
    }
    // The installed SDK still supports a one-item initialization array.
    assert.equal((await f.request({ body: JSON.stringify([initialize]) })).status, 200)
  })

  for (const token of [undefined, TOKEN]) {
    it(`runs the SDK client lifecycle and a mock tool call (${token ? 'token configured' : 'no token'})`, async (t) => {
      const f = await fixture(t, { env: { VENICE_MCP_AUTH_TOKEN: token } })
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.port}/mcp`), {
        requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
      })
      const client = new Client({ name: 'local-native-client', version: '1' })
      t.after(() => client.close())
      await client.connect(transport)
      const tools = await client.listTools()
      assert.ok(tools.tools.some((tool) => tool.name === 'venice_chat'))
      const reply = await client.callTool({
        name: 'venice_chat', arguments: { messages: [{ role: 'user', content: 'local test' }] },
      })
      assert.equal(reply.isError, undefined)
      assert.equal((reply.content as Array<{ text: string }>)[0].text, 'local reply')
      assert.equal(f.upstream.calls.length, 1)
      assert.equal(f.upstream.calls[0].headers.authorization, 'Bearer synthetic-upstream-key')
      assert.equal(f.upstream.calls[0].headers['sign-in-with-x'], undefined)
      assert.equal(f.builds(), 1)
      await transport.terminateSession()
    })
  }
})
