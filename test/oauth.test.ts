import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../src/config.js'
import {
  bearerChallenge,
  IdentityCache,
  introspectToken,
  loadOAuthSettings,
  protectedResourceMetadata,
  resolveVeniceApiKey,
  resourceMetadataUrl,
  type OAuthSettings,
} from '../src/auth/oauth.js'
import { createHttpApp } from '../src/transports/http.js'
import { startMockVenice, type MockVeniceServer } from './helpers/mock-venice-server.js'

const RESOURCE = 'https://mcp.venice.test/mcp'

function settings(overrides: Partial<OAuthSettings> = {}): OAuthSettings {
  return {
    resourceUrl: RESOURCE,
    authorizationServers: ['https://auth.venice.test'],
    introspectionUrl: 'https://auth.venice.test/oauth/token_info',
    requiredScopes: [],
    cacheTtlMs: 60_000,
    ...overrides,
  }
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

describe('oauth settings and metadata', () => {
  it('requires the resource, issuer and introspection URLs', () => {
    assert.throws(() => loadOAuthSettings({}), /VENICE_MCP_RESOURCE_URL, VENICE_MCP_OAUTH_ISSUER, VENICE_MCP_OAUTH_INTROSPECTION_URL/)
    const s = loadOAuthSettings({
      VENICE_MCP_RESOURCE_URL: RESOURCE,
      VENICE_MCP_OAUTH_ISSUER: 'https://auth.venice.test',
      VENICE_MCP_OAUTH_INTROSPECTION_URL: 'https://auth.venice.test/oauth/token_info',
      VENICE_MCP_OAUTH_SCOPES: 'venice.inference, offline_access',
    })
    assert.deepEqual(s.requiredScopes, ['venice.inference', 'offline_access'])
    assert.equal(s.cacheTtlMs, 60_000)
  })

  it('publishes RFC 9728 metadata at the path-specific well-known URL', () => {
    const s = settings()
    assert.equal(resourceMetadataUrl(s), 'https://mcp.venice.test/.well-known/oauth-protected-resource/mcp')
    assert.deepEqual(protectedResourceMetadata(s).authorization_servers, ['https://auth.venice.test'])
    assert.equal(protectedResourceMetadata(s).resource, RESOURCE)
    assert.match(bearerChallenge(s), /^Bearer resource_metadata="https:\/\/mcp\.venice\.test\/\.well-known\/oauth-protected-resource\/mcp"$/)
  })
})

describe('token introspection', () => {
  const now = 1_800_000_000

  it('accepts an active token issued for this resource', async () => {
    const verified = await introspectToken(
      't',
      settings(),
      jsonFetch({ active: true, sub: 'user_123', client_id: 'chatgpt', aud: RESOURCE, scope: 'openid', exp: now + 60 }),
      now,
    )
    assert.equal(verified?.subject, 'user_123')
    assert.equal(verified?.clientId, 'chatgpt')
  })

  it('rejects inactive, expired, wrong-audience and under-scoped tokens', async () => {
    const s = settings({ requiredScopes: ['venice.inference'] })
    const base = { active: true, sub: 'user_123', aud: RESOURCE, scope: 'venice.inference', exp: now + 60 }
    assert.ok(await introspectToken('t', s, jsonFetch(base), now))
    for (const body of [
      { ...base, active: false },
      { ...base, exp: now - 1 },
      { ...base, aud: 'https://other.example/mcp' },
      { ...base, scope: 'openid' },
      { ...base, sub: undefined },
    ]) {
      assert.equal(await introspectToken('t', s, jsonFetch(body), now), undefined)
    }
  })

  it('sends client credentials with Basic auth and the token form-encoded', async () => {
    let seen: { auth?: string; body?: string } = {}
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen = { auth: (init?.headers as Record<string, string>).Authorization, body: String(init?.body) }
      return new Response(JSON.stringify({ active: false }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await introspectToken('tok-1', settings({ introspectionClientId: 'id', introspectionClientSecret: 'secret' }), fetchImpl)
    assert.equal(seen.auth, `Basic ${Buffer.from('id:secret').toString('base64')}`)
    assert.equal(seen.body, 'token=tok-1&token_type_hint=access_token')
  })
})

describe('Venice key resolution', () => {
  const token = { subject: 'user_123', clientId: 'chatgpt', scopes: [] }

  it('uses a key issued by the authorization server', async () => {
    assert.equal(await resolveVeniceApiKey({ ...token, veniceApiKey: 'vk_from_as' }, settings()), 'vk_from_as')
  })

  it('asks the key resolver otherwise, and fails clearly without one', async () => {
    let request: { auth?: string; body?: string } = {}
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      request = { auth: (init?.headers as Record<string, string>).Authorization, body: String(init?.body) }
      return new Response(JSON.stringify({ api_key: 'vk_resolved' }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const s = settings({ keyResolverUrl: 'https://api.venice.test/internal/mcp/key', keyResolverToken: 'svc' })
    assert.equal(await resolveVeniceApiKey(token, s, fetchImpl), 'vk_resolved')
    assert.equal(request.auth, 'Bearer svc')
    assert.deepEqual(JSON.parse(request.body!), { subject: 'user_123', client_id: 'chatgpt' })
    await assert.rejects(() => resolveVeniceApiKey(token, settings()), /VENICE_MCP_KEY_RESOLVER_URL/)
  })

  it('caches identities for the TTL and never past token expiry', () => {
    let clock = 0
    const cache = new IdentityCache(60_000, () => clock)
    const identity = { token: { ...token, expiresAt: 30 }, veniceApiKey: 'vk' }
    cache.set('raw-token', identity)
    clock = 29_000
    assert.equal(cache.get('raw-token'), identity)
    clock = 30_000
    assert.equal(cache.get('raw-token'), undefined)
  })
})

describe('http oauth mode', () => {
  let upstream: MockVeniceServer
  let server: Server
  let url: string

  const rpc = (body: unknown, token?: string) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })

  before(async () => {
    upstream = await startMockVenice([
      {
        match: 'POST /oauth/token_info',
        reply: (req: { body: unknown }) => {
          const token = new URLSearchParams(String(req.body)).get('token')
          if (token === 'good-token') {
            return { active: true, sub: 'user_123', client_id: 'chatgpt', aud: RESOURCE, email: 'sabrina@venice.test', venice_api_key: 'vk_user_123' }
          }
          if (token === 'revoked-key-token') {
            return { active: true, sub: 'user_456', aud: RESOURCE, venice_api_key: 'vk_revoked' }
          }
          return { active: false }
        },
      },
      {
        match: 'GET /v1/models*',
        reply: (req: { headers: Record<string, string> }) =>
          req.headers.authorization === 'Bearer vk_revoked'
            ? { __status: 401, __body: { error: 'Invalid API key' } }
            : { data: [{ id: 'deepseek-v4-flash-0731', type: 'text' }] },
      },
    ])
    const config = { ...loadConfig({}), baseUrl: upstream.url, apiKey: 'server-operator-key' }
    const oauth = settings({ introspectionUrl: `${upstream.url}/oauth/token_info` })
    server = createHttpApp({ authMode: 'oauth', oauth, config }).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await upstream.close()
  })

  it('serves protected-resource metadata', async () => {
    const base = url.replace(/\/mcp$/, '')
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const body = (await (await fetch(`${base}${path}`)).json()) as { resource: string; authorization_servers: string[] }
      assert.equal(body.resource, RESOURCE)
      assert.deepEqual(body.authorization_servers, ['https://auth.venice.test'])
    }
  })

  it('challenges unauthenticated and invalid requests with resource_metadata', async () => {
    const missing = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(missing.status, 401)
    assert.match(missing.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/mcp\.venice\.test\/\.well-known\/oauth-protected-resource\/mcp"/)

    const invalid = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'bad-token')
    assert.equal(invalid.status, 401)
    assert.match(invalid.headers.get('www-authenticate') ?? '', /error="invalid_token"/)
  })

  it('runs tools with the user’s own Venice key and never the operator key', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'venice_list_models', arguments: {} } }, 'good-token')
    assert.equal(res.status, 200)
    const call = upstream.calls.find((c) => c.path.startsWith('/v1/models'))
    assert.equal(call?.headers.authorization, 'Bearer vk_user_123')
    assert.equal(upstream.calls.some((c) => c.headers.authorization === 'Bearer server-operator-key'), false)
    assert.equal(upstream.calls.some((c) => c.headers.authorization === 'Bearer good-token'), false)
  })

  it('advertises oauth2 security schemes and a ChatGPT profile tool', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'good-token')
    const tools = ((await res.json()) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown>; outputSchema?: unknown }> } }).result.tools
    assert.ok(tools.every((t) => Array.isArray(t._meta?.securitySchemes)))
    const profile = tools.find((t) => t.name === 'venice_get_profile')
    assert.equal(profile?._meta?.['openai/profile'], true)
    assert.ok(profile?.outputSchema)

    const who = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'venice_get_profile', arguments: {} } }, 'good-token')
    const result = ((await who.json()) as { result: { structuredContent: Record<string, string> } }).result
    assert.deepEqual(result.structuredContent, { id: 'user_123', email: 'sabrina@venice.test' })
  })

  it('asks the host to reconnect when the Venice key behind a token is revoked', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'venice_list_models', arguments: {} } }, 'revoked-key-token')
    const result = ((await res.json()) as { result: { isError?: boolean; _meta?: Record<string, string[]> } }).result
    assert.equal(result.isError, true)
    const challenge = result._meta?.['mcp/www_authenticate']?.[0] ?? ''
    assert.match(challenge, /resource_metadata=/)
    assert.match(challenge, /error="invalid_token"/)
    assert.match(challenge, /error_description="/)
  })
})
