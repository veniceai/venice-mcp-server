import express from 'express'
import type { Request } from 'express'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import { isIP } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import { buildServer } from '../server.js'

const DEFAULT_MAX_HTTP_SESSIONS = 100
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000
const MIN_EXPOSED_AUTH_TOKEN_LENGTH = 16

interface SessionEntry {
  transport: StreamableHTTPServerTransport
  lastSeen: number
}

const BEARER_SCHEME_PATTERN = /^Bearer\s+(.+)$/i

export function isAuthorizedBearerHeader(header: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken) return true

  // RFC 7235 makes the auth scheme case-insensitive and allows more than one
  // space (and, for obs-fold, tabs) between the scheme and the token. A strict
  // startsWith('Bearer ') rejected "bearer", "BEARER" and extra spacing, which
  // several HTTP clients emit.
  const match = header === undefined ? null : BEARER_SCHEME_PATTERN.exec(header)
  if (!match) return false

  const actual = Buffer.from(match[1].trimEnd())
  const expected = Buffer.from(expectedToken)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
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
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function validateHttpAuthConfig(
  host: string,
  authToken: string | undefined,
  allowUnauthenticated = process.env.VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP === '1',
): void {
  if (isLoopbackHost(host)) return
  if (allowUnauthenticated) return

  const token = authToken?.trim()
  if (!token) {
    throw new Error(
      'VENICE_MCP_AUTH_TOKEN is required when HTTP mode binds to a non-loopback host. ' +
        'Set VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP=1 only behind a trusted authenticated proxy.'
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

/**
 * Run the server over Streamable HTTP for hosted deployments
 * (Smithery, internal Cloud Run, etc.). Sessionful.
 */
export async function runHttp(opts: {
  port?: number
  host?: string
  env?: NodeJS.ProcessEnv
  serverFactory?: typeof buildServer
} = {}): Promise<Server> {
  const env = opts.env ?? process.env
  const port = opts.port ?? Number(env.PORT ?? 3333)
  const host = opts.host ?? env.VENICE_MCP_HOST ?? '127.0.0.1'
  const authToken = env.VENICE_MCP_AUTH_TOKEN
  validateHttpAuthConfig(host, authToken, env.VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP === '1')
  const configuredHosts = parseAllowlist(env, 'VENICE_MCP_ALLOWED_HOSTS', normalizeAuthority)
  const configuredOrigins = parseAllowlist(env, 'VENICE_MCP_ALLOWED_ORIGINS', normalizeOrigin)
  const serverFactory = opts.serverFactory ?? buildServer
  const app = express()
  const parseJson = express.json({ limit: '10mb' })

  const sessions = new Map<string, SessionEntry>()
  const maxSessions = parsePositiveInt(env.VENICE_MCP_MAX_SESSIONS, DEFAULT_MAX_HTTP_SESSIONS)
  const sessionTtlMs = parsePositiveInt(env.VENICE_MCP_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS)

  const cleanupExpiredSessions = () => {
    const now = Date.now()
    for (const [sid, entry] of sessions) {
      if (now - entry.lastSeen > sessionTtlMs) {
        sessions.delete(sid)
        void closeTransport(entry.transport)
      }
    }
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, name: '@veniceai/mcp-server' }))

  app.all('/mcp', (req, res, next) => {
    // Use the actual listener port (including port=0), never forwarded headers.
    const localHosts = ['localhost', '127.0.0.1', '[::1]'].map((name) => `${name}:${req.socket.localPort}`)
    const allowedHosts = configuredHosts ?? new Set([
      ...localHosts,
      ...(req.socket.localPort === 80 ? ['localhost', '127.0.0.1', '[::1]'] : []),
    ])
    const allowedOrigins = configuredOrigins ?? new Set(localHosts.map((name) => new URL(`http://${name}`).origin))
    const authority = normalizeAuthority(req.header('host') ?? '')
    const originHeader = req.header('origin')
    const origin = originHeader === undefined ? undefined : normalizeOrigin(originHeader)
    if (headerCount(req, 'host') !== 1 || !authority || !allowedHosts.has(authority) ||
        headerCount(req, 'origin') > 1 ||
        (originHeader !== undefined && (!origin || !allowedOrigins.has(origin)))) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    if (!isAuthorizedBearerHeader(req.header('authorization'), authToken)) {
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
        const server = serverFactory()
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

  const listener = app.listen(port, host)
  listener.once('close', () => {
    for (const entry of sessions.values()) void closeTransport(entry.transport)
    sessions.clear()
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('listening', () => resolve())
    listener.once('error', reject)
  })
  const address = listener.address()
  // eslint-disable-next-line no-console
  console.error(`[venice-mcp] listening on http://${host}:${typeof address === 'object' && address ? address.port : port}/mcp`)
  if (!isLoopbackHost(host)) {
    // eslint-disable-next-line no-console
    console.error(`[venice-mcp] WARNING: bound to ${host} — server is reachable beyond loopback. Keep VENICE_MCP_AUTH_TOKEN set or use a trusted authenticated proxy.`)
  }
  return listener
}
