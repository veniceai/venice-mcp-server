import express from 'express'
import type { Request, Response } from 'express'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
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

/**
 * Startup warning describing how exposed the listener is, or undefined when the
 * posture is fully guarded.
 *
 * A loopback bind with no token is the quiet case worth naming: it cannot fail
 * validation, so it starts silently, yet any local process can call the
 * endpoint and spend the server's Venice credentials.
 */
export function httpAuthWarning(host: string, authToken: string | undefined): string | undefined {
  const token = authToken?.trim()
  if (token) {
    return isLoopbackHost(host)
      ? undefined
      : `bound to ${host} — server is reachable beyond loopback. Keep VENICE_MCP_AUTH_TOKEN set or use a trusted authenticated proxy.`
  }

  return isLoopbackHost(host)
    ? 'no VENICE_MCP_AUTH_TOKEN set — any local process can call it and spend the server\'s Venice credentials.'
    : 'no VENICE_MCP_AUTH_TOKEN set — the server is reachable beyond loopback and any caller can spend its Venice credentials.'
}

function closeTransport(transport: StreamableHTTPServerTransport): void {
  const close = (transport as unknown as { close?: () => void | Promise<void> }).close
  if (typeof close === 'function') void close.call(transport)
}

/**
 * Run the server over Streamable HTTP for hosted deployments
 * (Smithery, internal Cloud Run, etc.). Sessionful.
 */
export async function runHttp(opts: { port?: number; host?: string } = {}): Promise<void> {
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  const sessions = new Map<string, SessionEntry>()
  const maxSessions = parsePositiveInt(process.env.VENICE_MCP_MAX_SESSIONS, DEFAULT_MAX_HTTP_SESSIONS)
  const sessionTtlMs = parsePositiveInt(process.env.VENICE_MCP_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS)

  const cleanupExpiredSessions = () => {
    const now = Date.now()
    for (const [sid, entry] of sessions) {
      if (now - entry.lastSeen > sessionTtlMs) {
        sessions.delete(sid)
        closeTransport(entry.transport)
      }
    }
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, name: '@veniceai/mcp-server' }))

  app.all('/mcp', async (req, res) => {
    try {
      const authToken = process.env.VENICE_MCP_AUTH_TOKEN
      if (!isAuthorizedBearerHeader(req.header('authorization'), authToken)) {
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
        const server = buildServer()
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

  const port = opts.port ?? Number(process.env.PORT ?? 3333)
  // Default to loopback-only for safety. Opt in to all-interfaces via VENICE_MCP_HOST=0.0.0.0
  // (useful for Docker containers and intentional LAN exposure).
  const host = opts.host ?? process.env.VENICE_MCP_HOST ?? '127.0.0.1'
  const authToken = process.env.VENICE_MCP_AUTH_TOKEN
  validateHttpAuthConfig(host, authToken)
  await new Promise<void>((resolve, reject) => {
    const listener = app.listen(port, host)
    listener.once('listening', () => resolve())
    listener.once('error', reject)
  })
  // eslint-disable-next-line no-console
  console.error(`[venice-mcp] listening on http://${host}:${port}/mcp`)
  const warning = httpAuthWarning(host, authToken)
  if (warning) {
    // eslint-disable-next-line no-console
    console.error(`[venice-mcp] WARNING: ${warning}`)
  }
}
