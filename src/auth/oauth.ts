import { createHash } from 'node:crypto'

/**
 * OAuth 2.1 protected-resource support for hosted deployments (ChatGPT, Claude.ai, Cursor, Grok).
 *
 * The server is a resource server only: an external authorization server (Clerk today, or a
 * Venice-built one) signs users in. Each request's bearer token is checked with RFC 7662 token
 * introspection, then mapped to the Venice API key that request should spend. The client's token
 * is never forwarded upstream.
 */
export interface OAuthSettings {
  /** Canonical URL of this MCP endpoint, e.g. `https://mcp.venice.ai/mcp`. Tokens must be issued for it. */
  resourceUrl: string
  /** Authorization server issuer URL(s) advertised to clients. */
  authorizationServers: string[]
  /** RFC 7662 introspection endpoint. */
  introspectionUrl: string
  /** Client credentials used to call the introspection endpoint, when it requires them. */
  introspectionClientId?: string
  introspectionClientSecret?: string
  /** Scopes every token must carry. Empty means any active token for this resource is accepted. */
  requiredScopes: string[]
  /** Optional endpoint that maps a verified user to their Venice API key (see `resolveVeniceApiKey`). */
  keyResolverUrl?: string
  keyResolverToken?: string
  /** How long a verified token's Venice key is reused before checking again. */
  cacheTtlMs: number
}

export interface VerifiedToken {
  subject: string
  clientId?: string
  scopes: string[]
  /** Seconds since epoch, from the introspection response. */
  expiresAt?: number
  email?: string
  name?: string
  /** Present when the authorization server issues Venice keys itself. */
  veniceApiKey?: string
}

export interface RequestIdentity {
  token: VerifiedToken
  veniceApiKey: string
}

type FetchLike = typeof fetch

const DEFAULT_CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 1_000

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function loadOAuthSettings(env: NodeJS.ProcessEnv = process.env): OAuthSettings {
  const missing = ['VENICE_MCP_RESOURCE_URL', 'VENICE_MCP_OAUTH_ISSUER', 'VENICE_MCP_OAUTH_INTROSPECTION_URL'].filter(
    (name) => !env[name]?.trim(),
  )
  if (missing.length > 0) {
    throw new Error(`VENICE_MCP_AUTH=oauth requires ${missing.join(', ')}.`)
  }
  const ttl = Number(env.VENICE_MCP_OAUTH_CACHE_TTL_MS)
  return {
    resourceUrl: env.VENICE_MCP_RESOURCE_URL!.trim(),
    authorizationServers: splitList(env.VENICE_MCP_OAUTH_ISSUER),
    introspectionUrl: env.VENICE_MCP_OAUTH_INTROSPECTION_URL!.trim(),
    introspectionClientId: env.VENICE_MCP_OAUTH_CLIENT_ID?.trim() || undefined,
    introspectionClientSecret: env.VENICE_MCP_OAUTH_CLIENT_SECRET?.trim() || undefined,
    requiredScopes: splitList(env.VENICE_MCP_OAUTH_SCOPES),
    keyResolverUrl: env.VENICE_MCP_KEY_RESOLVER_URL?.trim() || undefined,
    keyResolverToken: env.VENICE_MCP_KEY_RESOLVER_TOKEN?.trim() || undefined,
    cacheTtlMs: Number.isSafeInteger(ttl) && ttl >= 0 ? ttl : DEFAULT_CACHE_TTL_MS,
  }
}

/** `/.well-known/oauth-protected-resource` for the resource URL's path (RFC 9728). */
export function resourceMetadataUrl(settings: OAuthSettings): string {
  const url = new URL(settings.resourceUrl)
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  return `${url.origin}/.well-known/oauth-protected-resource${path}`
}

export function protectedResourceMetadata(settings: OAuthSettings): Record<string, unknown> {
  return {
    resource: settings.resourceUrl,
    authorization_servers: settings.authorizationServers,
    scopes_supported: settings.requiredScopes,
    bearer_methods_supported: ['header'],
    resource_name: 'Venice',
    resource_documentation: 'https://docs.venice.ai',
  }
}

/** `WWW-Authenticate` value that points clients at the resource metadata (RFC 9728 §5.1). */
export function bearerChallenge(settings: OAuthSettings, error?: { code: string; description: string }): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl(settings)}"`]
  if (settings.requiredScopes.length > 0) parts.push(`scope="${settings.requiredScopes.join(' ')}"`)
  if (error) parts.push(`error="${error.code}"`, `error_description="${error.description}"`)
  return parts.join(', ')
}

function audienceMatches(aud: unknown, resourceUrl: string): boolean {
  if (aud === undefined) return true
  const values = Array.isArray(aud) ? aud : [aud]
  return values.some((value) => typeof value === 'string' && value.replace(/\/+$/, '') === resourceUrl.replace(/\/+$/, ''))
}

/** RFC 7662 introspection. Returns undefined for inactive, expired, wrong-audience or under-scoped tokens. */
export async function introspectToken(
  token: string,
  settings: OAuthSettings,
  fetchImpl: FetchLike = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedToken | undefined> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  }
  if (settings.introspectionClientId) {
    const credentials = `${settings.introspectionClientId}:${settings.introspectionClientSecret ?? ''}`
    headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`
  }
  const res = await fetchImpl(settings.introspectionUrl, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
  })
  if (!res.ok) throw new Error(`token introspection failed with HTTP ${res.status}`)
  const body = (await res.json()) as Record<string, unknown>

  if (body.active !== true) return undefined
  if (typeof body.exp === 'number' && body.exp <= nowSeconds) return undefined
  if (!audienceMatches(body.aud, settings.resourceUrl)) return undefined
  const subject = typeof body.sub === 'string' ? body.sub : undefined
  if (!subject) return undefined
  const scopes = typeof body.scope === 'string' ? splitList(body.scope) : []
  if (!settings.requiredScopes.every((scope) => scopes.includes(scope))) return undefined

  return {
    subject,
    clientId: typeof body.client_id === 'string' ? body.client_id : undefined,
    scopes,
    expiresAt: typeof body.exp === 'number' ? body.exp : undefined,
    email: typeof body.email === 'string' ? body.email : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    veniceApiKey: typeof body.venice_api_key === 'string' && body.venice_api_key ? body.venice_api_key : undefined,
  }
}

/**
 * The Venice API key a verified user's requests spend. Uses the key from introspection when the
 * authorization server provides one; otherwise asks the key resolver:
 *
 *   POST {VENICE_MCP_KEY_RESOLVER_URL}
 *   Authorization: Bearer {VENICE_MCP_KEY_RESOLVER_TOKEN}
 *   { "subject": "<token sub>", "client_id": "<OAuth client>" }
 *   → 200 { "api_key": "<Venice INFERENCE key for this user and client>" }
 */
export async function resolveVeniceApiKey(
  token: VerifiedToken,
  settings: OAuthSettings,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  if (token.veniceApiKey) return token.veniceApiKey
  if (!settings.keyResolverUrl) {
    throw new Error('No Venice API key for this token: set VENICE_MCP_KEY_RESOLVER_URL or issue venice_api_key from introspection.')
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (settings.keyResolverToken) headers.Authorization = `Bearer ${settings.keyResolverToken}`
  const res = await fetchImpl(settings.keyResolverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ subject: token.subject, client_id: token.clientId }),
  })
  if (!res.ok) throw new Error(`Venice key resolver failed with HTTP ${res.status}`)
  const body = (await res.json()) as { api_key?: unknown }
  if (typeof body.api_key !== 'string' || !body.api_key) throw new Error('Venice key resolver returned no api_key')
  return body.api_key
}

/** Short-lived cache of verified tokens, keyed by a hash so raw tokens are never held as map keys. */
export class IdentityCache {
  private readonly entries = new Map<string, { identity: RequestIdentity; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  get(token: string): RequestIdentity | undefined {
    const key = this.key(token)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.identity
  }

  set(token: string, identity: RequestIdentity): void {
    if (this.ttlMs <= 0) return
    const tokenExpiry = identity.token.expiresAt ? identity.token.expiresAt * 1000 : Number.POSITIVE_INFINITY
    const expiresAt = Math.min(this.now() + this.ttlMs, tokenExpiry)
    if (expiresAt <= this.now()) return
    if (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(this.key(token), { identity, expiresAt })
  }
}

export interface OAuthVerifier {
  verify(token: string): Promise<RequestIdentity | undefined>
}

export function createOAuthVerifier(settings: OAuthSettings, fetchImpl: FetchLike = fetch): OAuthVerifier {
  const cache = new IdentityCache(settings.cacheTtlMs)
  return {
    async verify(token) {
      const cached = cache.get(token)
      if (cached) return cached
      const verified = await introspectToken(token, settings, fetchImpl)
      if (!verified) return undefined
      const identity = { token: verified, veniceApiKey: await resolveVeniceApiKey(verified, settings, fetchImpl) }
      cache.set(token, identity)
      return identity
    },
  }
}
