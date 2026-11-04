import express from 'express'
import type { Express, NextFunction, Request, Response } from 'express'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import { isIP } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import { buildServer, type BuildOptions } from '../server.js'
import { loadConfig, type Config } from '../config.js'
import { VeniceClient, VeniceResponseTooLargeError } from '../venice-client.js'
import {
  bearerChallenge,
  createOAuthVerifier,
  loadOAuthSettings,
  protectedResourceMetadata,
  resourceMetadataUrl,
  type OAuthSettings,
  type OAuthVerifier,
} from '../auth/oauth.js'

const DEFAULT_MAX_HTTP_SESSIONS = 100
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000
const MIN_EXPOSED_AUTH_TOKEN_LENGTH = 16
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8

/**
 * - `token`: one shared `VENICE_MCP_AUTH_TOKEN` gates the server, and every session uses the
 *   operator's `VENICE_API_KEY` / `VENICE_SIWX_TOKEN`. Sessionful.
 * - `user-key`: each request carries the caller's own Venice credentials (`Authorization: Bearer
 *   <Venice API key>` or a `SIGN-IN-WITH-X` proof), and the server never uses its own. Stateless.
 * - `oauth`: each request carries an OAuth access token from the configured authorization server;
 *   the token is introspected and mapped to that user's Venice API key. Stateless.
 */
export type HttpAuthMode = 'token' | 'user-key' | 'oauth'

export interface UpstreamCredentials {
  apiKey?: string
  siwxToken?: string
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport
  lastSeen: number
}

type ServerFactory = typeof buildServer

export function parseHttpAuthMode(value: string | undefined): HttpAuthMode {
  const mode = (value ?? 'token').trim().toLowerCase()
  if (mode === 'token' || mode === 'user-key' || mode === 'oauth') return mode
  throw new Error(`Unknown VENICE_MCP_AUTH "${value}". Use "token", "user-key" or "oauth".`)
}

export function isAuthorizedBearerHeader(header: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken) return true
  if (!header?.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(expectedToken)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Caller-supplied Venice credentials for `user-key` mode. An API key wins over a wallet proof. */
export function credentialsFromHeaders(header: (name: string) => string | undefined): UpstreamCredentials | undefined {
  const authorization = header('authorization')
  if (authorization?.startsWith('Bearer ')) {
    const apiKey = authorization.slice('Bearer '.length).trim()
    if (apiKey) return { apiKey }
  }
  const siwxToken = (header('sign-in-with-x') ?? header('x-sign-in-with-x'))?.trim()
  if (siwxToken) return { siwxToken }
  return undefined
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '::1' || normalized === '[::1]') return true
  if (normalized === '') return false

  const withoutBrackets = normalized.replace(/^\[(.*)\]$/, '$1')
  const version = isIP(withoutBrackets)
  if (version === 4) {
    const first = Number(withoutBrackets.split('.')[0])
    return first === 127
  }
  if (version === 6) return withoutBrackets === '::1'
  return false
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function validateHttpAuthConfig(
  host: string,
  authToken: string | undefined,
  allowUnauthenticated = process.env.VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP === '1',
  mode: HttpAuthMode = 'token',
): void {
  if (mode !== 'token') return
  if (isLoopbackHost(host)) return
  if (allowUnauthenticated) return

  const token = authToken?.trim()
  if (!token) {
    throw new Error(
      'VENICE_MCP_AUTH_TOKEN is required when HTTP mode binds to a non-loopback host. ' +
        'Set VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP=1 only behind a trusted authenticated proxy, ' +
        'or use VENICE_MCP_AUTH=user-key so each caller brings their own Venice key.'
    )
  }
  if (token.length < MIN_EXPOSED_AUTH_TOKEN_LENGTH) {
    throw new Error(`VENICE_MCP_AUTH_TOKEN must be at least ${MIN_EXPOSED_AUTH_TOKEN_LENGTH} characters when HTTP mode is exposed.`)
  }
}

export function isValidSessionId(sessionId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
}

async function closeTransport(transport: StreamableHTTPServerTransport): Promise<void> {
  try {
    await transport.close()
  } catch {
    console.error('[venice-mcp] transport cleanup failed')
  }
}

function normalizeAuthority(value: string): string | undefined {
  const authority = value.toLowerCase()
  const match = /^(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/.exec(authority)
  if (!match) return undefined
  if (!match[1].startsWith('[') && match[1].split('.').some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined
  try {
    const url = new URL(`http://${authority}`)
    // Reject URL aliases such as shortened/hex IPv4, and require canonical IPv6.
    if (url.hostname !== match[1]) return undefined
    return authority
  } catch {
    return undefined
  }
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) return undefined
    return normalizeAuthority(url.host) ? url.origin : undefined
  } catch {
    return undefined
  }
}

function parseAllowlist(
  env: NodeJS.ProcessEnv,
  name: string,
  normalize: (value: string) => string | undefined,
): Set<string> | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  const entries = new Set<string>()
  for (const entry of value.split(',')) {
    const normalized = normalize(entry.trim())
    if (normalized === undefined) {
      throw new Error(`${name} must contain comma-separated exact ${name.endsWith('HOSTS') ? 'Host authorities' : 'HTTP(S) origins'}; wildcards and empty entries are not allowed.`)
    }
    entries.add(normalized)
  }
  return entries
}

function headerCount(req: Request, name: string): number {
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count++
  }
  return count
}

export interface HttpAppOptions {
  authMode?: HttpAuthMode
  /** Shared bearer token for `token` mode. */
  authToken?: string
  /** Base configuration; `user-key` mode replaces its credentials per request. */
  config?: Config
  /** Exact Host authorities to accept. Defaults to localhost names on the listener port. */
  allowedHosts?: Set<string>
  /** Exact browser origins to accept. Defaults to localhost origins on the listener port. */
  allowedOrigins?: Set<string>
  maxSessions?: number
  sessionTtlMs?: number
  /** Active user-key requests, including work continuing after a disconnect. */
  maxConcurrentRequests?: number
  serverFactory?: ServerFactory
  /** Required in `oauth` mode. */
  oauth?: OAuthSettings
  /** Overrides token verification in `oauth` mode (tests). */
  oauthVerifier?: OAuthVerifier
}

function buildHttpApp(opts: HttpAppOptions): { app: Express; closeSessions: () => void } {
  const authMode = opts.authMode ?? 'token'
  const baseConfig = opts.config ?? loadConfig()
  const serverFactory = opts.serverFactory ?? buildServer
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_HTTP_SESSIONS
  const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const maxConcurrentRequests = opts.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) {
    throw new Error('maxConcurrentRequests must be a positive safe integer')
  }
  const app = express()
  const parseJson = express.json({ limit: '10mb' })

  app.get('/healthz', (_req, res) => res.json({ ok: true, name: '@veniceai/mcp-server' }))

  app.use('/mcp', (req, res, next) => {
    // Use the actual listener port (including port=0), never forwarded headers.
    const localHosts = ['localhost', '127.0.0.1', '[::1]'].map((name) => `${name}:${req.socket.localPort}`)
    const allowedHosts = opts.allowedHosts ?? new Set([
      ...localHosts,
      ...(req.socket.localPort === 80 ? ['localhost', '127.0.0.1', '[::1]'] : []),
    ])
    const allowedOrigins = opts.allowedOrigins ?? new Set(localHosts.map((name) => new URL(`http://${name}`).origin))
    const authority = normalizeAuthority(req.header('host') ?? '')
    const originHeader = req.header('origin')
    const origin = originHeader === undefined ? undefined : normalizeOrigin(originHeader)
    if (headerCount(req, 'host') !== 1 || !authority || !allowedHosts.has(authority) ||
        headerCount(req, 'origin') > 1 ||
        (originHeader !== undefined && (!origin || !allowedOrigins.has(origin)))) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  })

  const parseBody = (req: Request, res: Response, next: NextFunction) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'content-type must be application/json' })
      return
    }
    parseJson(req, res, (err: { status?: number } | undefined) => {
      if (err) {
        const status = err.status === 413 ? 413 : err.status === 415 ? 415 : 400
        res.status(status).json({ error: status === 413 ? 'request body too large' : 'invalid request body' })
        return
      }
      next()
    })
  }

  const operations = new WeakMap<Response, (operation: Promise<unknown>) => void>()
  if (authMode !== 'token') {
    let activeRequests = 0
    app.use('/mcp', (_req, res, next) => {
      if (activeRequests >= maxConcurrentRequests) {
        res.setHeader('Retry-After', '1')
        res.setHeader('Connection', 'close')
        res.status(503).json({ error: 'too many active MCP requests' })
        return
      }
      activeRequests++
      let pending = 0
      let closed = false
      let released = false
      const release = () => {
        if (closed && pending === 0 && !released) {
          released = true
          activeRequests--
          operations.delete(res)
        }
      }
      operations.set(res, (operation) => {
        pending++
        const finish = () => { pending--; release() }
        void operation.then(finish, finish)
      })
      res.once('close', () => { closed = true; release() })
      next()
    })
  }

  if (authMode === 'oauth') {
    const settings = opts.oauth
    if (!settings) throw new Error('oauth mode requires OAuth settings')
    const verifier = opts.oauthVerifier ?? createOAuthVerifier(settings)
    const metadataPath = new URL(resourceMetadataUrl(settings)).pathname
    const sendMetadata = (_req: Request, res: Response) => {
      res.json(protectedResourceMetadata(settings))
    }
    app.get('/.well-known/oauth-protected-resource', sendMetadata)
    if (metadataPath !== '/.well-known/oauth-protected-resource') app.get(metadataPath, sendMetadata)

    app.all('/mcp', async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        res.status(405).json({ error: 'stateless server: send JSON-RPC requests with POST' })
        return
      }
      const authorization = req.header('authorization')
      const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''
      if (!token) {
        res.setHeader('WWW-Authenticate', bearerChallenge(settings))
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      let identity
      try {
        identity = await verifier.verify(token)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[venice-mcp] token verification failed', (err as Error).message)
        res.status(503).json({ error: 'authorization service unavailable' })
        return
      }
      if (!identity) {
        res.setHeader(
          'WWW-Authenticate',
          bearerChallenge(settings, { code: 'invalid_token', description: 'The access token is invalid, expired or not for this server' }),
        )
        res.status(401).json({ error: 'invalid_token' })
        return
      }
      const verified = identity
      parseBody(req, res, () => {
        if (rejectBatch(req, res, 'oauth')) return
        if (res.destroyed) return
        const config = { ...baseConfig, apiKey: verified.veniceApiKey, siwxToken: undefined }
        const client = new VeniceClient(config)
        void handleStateless(req, res, config, serverFactory, {
          stateless: true,
          client,
          trackOperation: operations.get(res),
          beforeUpload: uploadKeyValidator(client, config, res),
          auth: {
            scopes: settings.requiredScopes,
            token: verified.token,
            reauthChallenge: bearerChallenge(settings, {
              code: 'invalid_token',
              description: 'Your Venice connection expired or was revoked. Reconnect to continue.',
            }),
          },
        })
      })
    })
    return { app, closeSessions: () => {} }
  }

  if (authMode === 'user-key') {
    app.all('/mcp', (req, res, next) => {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        res.status(405).json({ error: 'stateless server: send JSON-RPC requests with POST' })
        return
      }
      if (!credentialsFromHeaders((name) => req.header(name))) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="venice", error="invalid_request", error_description="Send your Venice API key as a Bearer token"')
        res.status(401).json({ error: 'missing Venice credentials: send Authorization: Bearer <Venice API key>' })
        return
      }
      next()
    }, parseBody, async (req, res) => {
      if (rejectBatch(req, res, 'user-key')) return
      if (res.destroyed) return
      const credentials = credentialsFromHeaders((name) => req.header(name))
      const config = { ...baseConfig, apiKey: credentials?.apiKey, siwxToken: credentials?.siwxToken }
      const client = new VeniceClient(config)
      await handleStateless(req, res, config, serverFactory, {
        stateless: true,
        client,
        trackOperation: operations.get(res),
        beforeUpload: uploadKeyValidator(client, config, res),
      })
    })
    return { app, closeSessions: () => {} }
  }

  const sessions = new Map<string, SessionEntry>()

  const cleanupExpiredSessions = () => {
    const now = Date.now()
    for (const [sid, entry] of sessions) {
      if (now - entry.lastSeen > sessionTtlMs) {
        sessions.delete(sid)
        void closeTransport(entry.transport)
      }
    }
  }

  app.all('/mcp', (req, res, next) => {
    if (!isAuthorizedBearerHeader(req.header('authorization'), opts.authToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE')
      res.status(405).json({ error: 'method not allowed' })
      return
    }
    if (req.method !== 'POST') {
      next()
      return
    }
    parseBody(req, res, next)
  }, async (req, res) => {
    let newTransport: StreamableHTTPServerTransport | undefined
    let newSessionId: string | undefined
    let keepNewSession = false
    try {
      cleanupExpiredSessions()
      const sessionHeader = req.header('mcp-session-id')
      let entry = sessionHeader ? sessions.get(sessionHeader) : undefined

      if (sessionHeader && !isValidSessionId(sessionHeader)) {
        res.status(400).json({ error: 'invalid MCP session id' })
        return
      }

      if (sessionHeader && !entry) {
        res.status(404).json({ error: 'unknown MCP session id; initialize a new session without the mcp-session-id header' })
        return
      }

      if (!entry) {
        const message = Array.isArray(req.body) && req.body.length === 1 ? req.body[0] : req.body
        if (req.method !== 'POST' || !isJSONRPCRequest(message) || !isInitializeRequest(message)) {
          res.status(400).json({ error: 'initialize a new MCP session with a valid initialize request' })
          return
        }
        if (sessions.size >= maxSessions) {
          res.status(503).json({ error: 'too many active MCP sessions' })
          return
        }
        const sessionId = randomUUID()
        newSessionId = sessionId
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, lastSeen: Date.now() })
          },
          enableJsonResponse: true,
        })
        newTransport = transport
        transport.onclose = () => {
          sessions.delete(sessionId)
        }
        const server = serverFactory({ config: baseConfig })
        await server.connect(transport)
        entry = { transport, lastSeen: Date.now() }
      }

      entry.lastSeen = Date.now()
      await entry.transport.handleRequest(req, res, req.body)
      keepNewSession = res.statusCode < 400 && res.writableEnded &&
        newSessionId !== undefined && sessions.get(newSessionId)?.transport === newTransport
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[venice-mcp] /mcp error', err)
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal' })
      }
    } finally {
      if (newTransport && !keepNewSession) {
        if (newSessionId) sessions.delete(newSessionId)
        await closeTransport(newTransport)
      }
    }
  })

  const closeSessions = () => {
    for (const entry of sessions.values()) void closeTransport(entry.transport)
    sessions.clear()
  }
  return { app, closeSessions }
}

/**
 * Build the Streamable HTTP app for hosted deployments (Smithery, internal Cloud Run, etc.).
 * Exported separately from `runHttp` so tests can bind it to an ephemeral port.
 */
export function createHttpApp(opts: HttpAppOptions = {}): Express {
  return buildHttpApp(opts).app
}

/** One admission must not fan out into multiple downloads, even with older MCP versions. */
function rejectBatch(req: Request, res: Response, mode: HttpAuthMode): boolean {
  if (!Array.isArray(req.body)) return false
  res.status(400).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: `JSON-RPC batches are not supported in ${mode} mode` },
  })
  return true
}

/** Checks the caller's key with Venice before a tool downloads a caller-supplied source. */
function uploadKeyValidator(client: VeniceClient, config: Config, res: Response): () => Promise<void> {
  return async () => {
    if (!config.apiKey) {
      throw new Error(
        'An API key is required for tools that download upload sources in HTTP user-key mode. ' +
        'Send Authorization: Bearer <Venice API key>. Wallet proofs cannot be pre-validated without consuming their single-use nonce.',
      )
    }
    const validation = await client.get<{ data?: { accessPermitted?: boolean } }>(
      '/v1/api_keys/rate_limits', undefined, { auth: 'apiKey', maxBytes: 1024 * 1024 },
    ).catch((err: unknown) => {
      if (err instanceof VeniceResponseTooLargeError) {
        throw new Error('API key validation response exceeds 1 MiB. No source was downloaded or inference submitted.')
      }
      throw err
    })
    if (validation?.data?.accessPermitted !== true) {
      throw new Error(
        'API key access is not permitted; check its balance and permissions. No source was downloaded or inference submitted.',
      )
    }
    if (res.destroyed) throw new Error('MCP request disconnected before the upload started.')
  }
}

/** One server and transport per request, discarded when the response closes. */
async function handleStateless(
  req: Request,
  res: Response,
  config: Config,
  serverFactory: ServerFactory,
  options: Omit<BuildOptions, 'config'>,
): Promise<void> {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const server = serverFactory({ config, ...options })
    const closed = new Promise<void>((resolve) => {
      res.once('close', () => {
        void server.close()
        resolve()
      })
    })
    await server.connect(transport)
    await Promise.race([transport.handleRequest(req, res, req.body), closed])
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[venice-mcp] /mcp error', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal' })
    }
  }
}

/**
 * Run the server over Streamable HTTP for hosted deployments
 * (Smithery, internal Cloud Run, etc.).
 */
export async function runHttp(opts: {
  port?: number
  host?: string
  env?: NodeJS.ProcessEnv
  serverFactory?: ServerFactory
} = {}): Promise<Server> {
  const env = opts.env ?? process.env
  const authMode = parseHttpAuthMode(env.VENICE_MCP_AUTH)
  const port = opts.port ?? Number(env.PORT ?? 3333)
  const host = opts.host ?? env.VENICE_MCP_HOST ?? '127.0.0.1'
  const authToken = env.VENICE_MCP_AUTH_TOKEN
  validateHttpAuthConfig(host, authToken, env.VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP === '1', authMode)
  const { app, closeSessions } = buildHttpApp({
    authMode,
    authToken,
    config: loadConfig(env),
    allowedHosts: parseAllowlist(env, 'VENICE_MCP_ALLOWED_HOSTS', normalizeAuthority),
    allowedOrigins: parseAllowlist(env, 'VENICE_MCP_ALLOWED_ORIGINS', normalizeOrigin),
    maxSessions: parsePositiveInt(env.VENICE_MCP_MAX_SESSIONS, DEFAULT_MAX_HTTP_SESSIONS),
    sessionTtlMs: parsePositiveInt(env.VENICE_MCP_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
    maxConcurrentRequests: parsePositiveInt(env.VENICE_MCP_MAX_CONCURRENT_REQUESTS, DEFAULT_MAX_CONCURRENT_REQUESTS),
    serverFactory: opts.serverFactory,
    oauth: authMode === 'oauth' ? loadOAuthSettings(env) : undefined,
  })

  const listener = app.listen(port, host)
  listener.once('close', closeSessions)
  await new Promise<void>((resolve, reject) => {
    listener.once('listening', () => resolve())
    listener.once('error', reject)
  })
  const address = listener.address()
  // eslint-disable-next-line no-console
  console.error(`[venice-mcp] listening on http://${host}:${typeof address === 'object' && address ? address.port : port}/mcp (auth: ${authMode})`)
  if (!isLoopbackHost(host) && authMode === 'token') {
    // eslint-disable-next-line no-console
    console.error(`[venice-mcp] WARNING: bound to ${host} — server is reachable beyond loopback. Keep VENICE_MCP_AUTH_TOKEN set or use a trusted authenticated proxy.`)
  }
  return listener
}
