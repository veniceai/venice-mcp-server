import express from 'express'
import type { Express, Request, Response } from 'express'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildServer } from '../server.js'
import { loadConfig, type Config } from '../config.js'

const DEFAULT_MAX_HTTP_SESSIONS = 100
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000
const MIN_EXPOSED_AUTH_TOKEN_LENGTH = 16

/**
 * - `token`: one shared `VENICE_MCP_AUTH_TOKEN` gates the server, and every session uses the
 *   operator's `VENICE_API_KEY` / `VENICE_SIWX_TOKEN`. Sessionful.
 * - `user-key`: each request carries the caller's own Venice credentials (`Authorization: Bearer
 *   <Venice API key>` or a `SIGN-IN-WITH-X` proof), and the server never uses its own. Stateless.
 */
export type HttpAuthMode = 'token' | 'user-key'

export interface UpstreamCredentials {
  apiKey?: string
  siwxToken?: string
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport
  lastSeen: number
}

export function parseHttpAuthMode(value: string | undefined): HttpAuthMode {
  const mode = (value ?? 'token').trim().toLowerCase()
  if (mode === 'token' || mode === 'user-key') return mode
  throw new Error(`Unknown VENICE_MCP_AUTH "${value}". Use "token" or "user-key".`)
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

export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean)
}

/**
 * Blocks DNS-rebinding style requests from browsers. Requests without an `Origin` header
 * (MCP clients, curl, servers) are not browser requests and pass.
 */
export function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[], boundToLoopback: boolean): boolean {
  if (!origin) return true
  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase()
  if (allowedOrigins.length > 0) return allowedOrigins.includes(normalized)
  if (!boundToLoopback) return true
  try {
    return isLoopbackHost(new URL(normalized).hostname)
  } catch {
    return false
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function validateHttpAuthConfig(
  host: string,
  authToken: string | undefined,
  allowUnauthenticated = process.env.VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP === '1',
  mode: HttpAuthMode = 'token',
): void {
  if (mode === 'user-key') return
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

function closeTransport(transport: StreamableHTTPServerTransport): void {
  const close = (transport as unknown as { close?: () => void | Promise<void> }).close
  if (typeof close === 'function') void close.call(transport)
}

export interface HttpAppOptions {
  authMode?: HttpAuthMode
  /** Shared bearer token for `token` mode. */
  authToken?: string
  /** Base configuration; `user-key` mode replaces its credentials per request. */
  config?: Config
  host?: string
  allowedOrigins?: string[]
  maxSessions?: number
  sessionTtlMs?: number
}

/**
 * Build the Streamable HTTP app for hosted deployments (Smithery, internal Cloud Run, etc.).
 * Exported separately from `runHttp` so tests can bind it to an ephemeral port.
 */
export function createHttpApp(opts: HttpAppOptions = {}): Express {
  const authMode = opts.authMode ?? 'token'
  const baseConfig = opts.config ?? loadConfig()
  const boundToLoopback = isLoopbackHost(opts.host ?? '127.0.0.1')
  const allowedOrigins = opts.allowedOrigins ?? []

  const app = express()
  app.use(express.json({ limit: '10mb' }))

  app.get('/healthz', (_req, res) => res.json({ ok: true, name: '@veniceai/mcp-server' }))

  app.use('/mcp', (req, res, next) => {
    if (!isAllowedOrigin(req.header('origin'), allowedOrigins, boundToLoopback)) {
      res.status(403).json({ error: 'origin not allowed' })
      return
    }
    next()
  })

  if (authMode === 'user-key') {
    app.all('/mcp', async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        res.status(405).json({ error: 'stateless server: send JSON-RPC requests with POST' })
        return
      }
      const credentials = credentialsFromHeaders((name) => req.header(name))
      if (!credentials) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="venice", error="invalid_request", error_description="Send your Venice API key as a Bearer token"')
        res.status(401).json({ error: 'missing Venice credentials: send Authorization: Bearer <Venice API key>' })
        return
      }
      await handleStateless(req, res, { ...baseConfig, apiKey: credentials.apiKey, siwxToken: credentials.siwxToken })
    })
    return app
  }

  const sessions = new Map<string, SessionEntry>()
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_HTTP_SESSIONS
  const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS

  const cleanupExpiredSessions = () => {
    const now = Date.now()
    for (const [sid, entry] of sessions) {
      if (now - entry.lastSeen > sessionTtlMs) {
        sessions.delete(sid)
        closeTransport(entry.transport)
      }
    }
  }

  app.all('/mcp', async (req, res) => {
    try {
      if (!isAuthorizedBearerHeader(req.header('authorization'), opts.authToken)) {
        res.setHeader('WWW-Authenticate', 'Bearer')
        res.status(401).json({ error: 'unauthorized' })
        return
      }

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
        if (sessions.size >= maxSessions) {
          res.status(503).json({ error: 'too many active MCP sessions' })
          return
        }
        const sessionId = randomUUID()
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport: newTransport, lastSeen: Date.now() })
          },
          enableJsonResponse: true,
        })
        newTransport.onclose = () => {
          sessions.delete(sessionId)
        }
        const server = buildServer({ config: baseConfig })
        await server.connect(newTransport)
        entry = { transport: newTransport, lastSeen: Date.now() }
      }

      entry.lastSeen = Date.now()
      await entry.transport.handleRequest(req, res, req.body)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[venice-mcp] /mcp error', err)
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal' })
      }
    }
  })

  return app
}

/** One server and transport per request, discarded when the response closes. */
async function handleStateless(req: Request, res: Response, config: Config): Promise<void> {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const server = buildServer({ config })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[venice-mcp] /mcp error', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal' })
    }
  }
}

export async function runHttp(opts: { port?: number; host?: string } = {}): Promise<void> {
  const authMode = parseHttpAuthMode(process.env.VENICE_MCP_AUTH)
  const authToken = process.env.VENICE_MCP_AUTH_TOKEN
  const port = opts.port ?? Number(process.env.PORT ?? 3333)
  // Default to loopback-only for safety. Opt in to all-interfaces via VENICE_MCP_HOST=0.0.0.0
  // (useful for Docker containers and intentional LAN exposure).
  const host = opts.host ?? process.env.VENICE_MCP_HOST ?? '127.0.0.1'
  validateHttpAuthConfig(host, authToken, undefined, authMode)

  const app = createHttpApp({
    authMode,
    authToken,
    host,
    allowedOrigins: parseAllowedOrigins(process.env.VENICE_MCP_ALLOWED_ORIGINS),
    maxSessions: parsePositiveInt(process.env.VENICE_MCP_MAX_SESSIONS, DEFAULT_MAX_HTTP_SESSIONS),
    sessionTtlMs: parsePositiveInt(process.env.VENICE_MCP_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
  })

  await new Promise<void>((resolve, reject) => {
    const listener = app.listen(port, host)
    listener.once('listening', () => resolve())
    listener.once('error', reject)
  })
  // eslint-disable-next-line no-console
  console.error(`[venice-mcp] listening on http://${host}:${port}/mcp (auth: ${authMode})`)
  if (!isLoopbackHost(host) && authMode === 'token') {
    // eslint-disable-next-line no-console
    console.error(`[venice-mcp] WARNING: bound to ${host} — server is reachable beyond loopback. Keep VENICE_MCP_AUTH_TOKEN set or use a trusted authenticated proxy.`)
  }
}
