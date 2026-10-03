import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../src/config.js'
import {
  createHttpApp,
  credentialsFromHeaders,
  isAllowedOrigin,
  parseAllowedOrigins,
  parseHttpAuthMode,
  validateHttpAuthConfig,
  type HttpAppOptions,
} from '../src/transports/http.js'
import { startMockVenice, type MockVeniceServer } from './helpers/mock-venice-server.js'

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '0.0.0' } },
}
const LIST_MODELS = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'venice_list_models', arguments: {} },
}

async function listen(opts: HttpAppOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createHttpApp(opts).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
}

describe('http auth helpers', () => {
  it('parses the auth mode and rejects unknown values', () => {
    assert.equal(parseHttpAuthMode(undefined), 'token')
    assert.equal(parseHttpAuthMode(' User-Key '), 'user-key')
    assert.throws(() => parseHttpAuthMode('open'), /Unknown VENICE_MCP_AUTH/)
  })

  it('reads caller credentials, preferring an API key over a wallet proof', () => {
    const headers = (h: Record<string, string>) => (name: string) => h[name]
    assert.deepEqual(credentialsFromHeaders(headers({ authorization: 'Bearer vk_1' })), { apiKey: 'vk_1' })
    assert.deepEqual(credentialsFromHeaders(headers({ 'sign-in-with-x': 'proof' })), { siwxToken: 'proof' })
    assert.deepEqual(credentialsFromHeaders(headers({ 'x-sign-in-with-x': 'legacy' })), { siwxToken: 'legacy' })
    assert.deepEqual(
      credentialsFromHeaders(headers({ authorization: 'Bearer vk_1', 'sign-in-with-x': 'proof' })),
      { apiKey: 'vk_1' },
    )
    assert.equal(credentialsFromHeaders(headers({ authorization: 'Bearer   ' })), undefined)
    assert.equal(credentialsFromHeaders(headers({ authorization: 'Basic abc' })), undefined)
  })

  it('does not require a shared token in user-key mode, even when exposed', () => {
    assert.doesNotThrow(() => validateHttpAuthConfig('0.0.0.0', undefined, false, 'user-key'))
    assert.throws(() => validateHttpAuthConfig('0.0.0.0', undefined, false, 'token'), /VENICE_MCP_AUTH_TOKEN/)
  })

  it('blocks browser origins that could rebind to a loopback server', () => {
    assert.equal(isAllowedOrigin(undefined, [], true), true)
    assert.equal(isAllowedOrigin('http://localhost:6274', [], true), true)
    assert.equal(isAllowedOrigin('https://evil.example', [], true), false)
    assert.equal(isAllowedOrigin('https://evil.example', [], false), true)
    const allowed = parseAllowedOrigins('https://chatgpt.com/, https://claude.ai')
    assert.equal(isAllowedOrigin('https://claude.ai', allowed, false), true)
    assert.equal(isAllowedOrigin('https://evil.example', allowed, false), false)
  })
})

describe('http user-key mode', () => {
  let venice: MockVeniceServer
  let mcp: { url: string; close: () => Promise<void> }

  before(async () => {
    venice = await startMockVenice([
      { match: 'GET /v1/models*', reply: { data: [{ id: 'deepseek-v4-flash-0731', type: 'text' }] } },
    ])
    const config = { ...loadConfig({}), baseUrl: venice.url, apiKey: 'server-operator-key', siwxToken: 'server-siwx' }
    mcp = await listen({ authMode: 'user-key', config })
  })

  after(async () => {
    await mcp.close()
    await venice.close()
  })

  it('rejects requests without Venice credentials', async () => {
    const res = await post(mcp.url, INITIALIZE)
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/)
  })

  it('initializes without a session and forwards each caller’s own key upstream', async () => {
    const init = await post(mcp.url, INITIALIZE, { authorization: 'Bearer user-key-a' })
    assert.equal(init.status, 200)
    assert.equal(init.headers.get('mcp-session-id'), null)

    for (const key of ['user-key-a', 'user-key-b']) {
      const res = await post(mcp.url, LIST_MODELS, { authorization: `Bearer ${key}` })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { result?: { isError?: boolean } }
      assert.notEqual(body.result?.isError, true)
      assert.equal(venice.calls.at(-1)?.headers.authorization, `Bearer ${key}`)
    }
    assert.equal(venice.calls.some((c) => c.headers.authorization === 'Bearer server-operator-key'), false)
  })

  it('forwards a caller wallet proof and never falls back to the operator credentials', async () => {
    const res = await post(mcp.url, LIST_MODELS, { 'sign-in-with-x': 'caller-proof' })
    assert.equal(res.status, 200)
    const last = venice.calls.at(-1)!
    assert.equal(last.headers.authorization, undefined)
    assert.equal(last.headers['x-sign-in-with-x'] ?? last.headers['sign-in-with-x'], 'caller-proof')
  })

  it('answers GET with 405 because there is no session stream', async () => {
    const res = await fetch(mcp.url, { headers: { authorization: 'Bearer user-key-a' } })
    assert.equal(res.status, 405)
  })

  it('refuses a cross-site browser origin', async () => {
    const res = await post(mcp.url, INITIALIZE, { authorization: 'Bearer user-key-a', origin: 'https://evil.example' })
    assert.equal(res.status, 403)
  })
})

describe('http token mode', () => {
  let venice: MockVeniceServer
  let mcp: { url: string; close: () => Promise<void> }

  before(async () => {
    venice = await startMockVenice([
      { match: 'GET /v1/models*', reply: { data: [{ id: 'deepseek-v4-flash-0731', type: 'text' }] } },
    ])
    const config = { ...loadConfig({}), baseUrl: venice.url, apiKey: 'server-operator-key' }
    mcp = await listen({ authMode: 'token', authToken: 'shared-gate-token-123', config })
  })

  after(async () => {
    await mcp.close()
    await venice.close()
  })

  it('keeps the shared-token gate and sessionful behavior', async () => {
    assert.equal((await post(mcp.url, INITIALIZE)).status, 401)
    const init = await post(mcp.url, INITIALIZE, { authorization: 'Bearer shared-gate-token-123' })
    assert.equal(init.status, 200)
    const sessionId = init.headers.get('mcp-session-id')
    assert.ok(sessionId)

    const res = await post(mcp.url, LIST_MODELS, {
      authorization: 'Bearer shared-gate-token-123',
      'mcp-session-id': sessionId!,
    })
    assert.equal(res.status, 200)
    assert.equal(venice.calls.at(-1)?.headers.authorization, 'Bearer server-operator-key')
  })
})
