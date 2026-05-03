// eslint-disable-next-line @typescript-eslint/no-require-imports
import express from 'express'
import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildServer } from '../server.js'

/**
 * Run the server over Streamable HTTP for hosted deployments
 * (Smithery, internal Cloud Run, etc.). Sessionful.
 */
export async function runHttp(opts: { port?: number; host?: string } = {}): Promise<void> {
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  const sessions = new Map<string, StreamableHTTPServerTransport>()

  app.get('/healthz', (_req, res) => res.json({ ok: true, name: '@veniceai/mcp-server' }))

  app.all('/mcp', async (req, res) => {
    try {
      const sessionHeader = req.header('mcp-session-id')
      let transport = sessionHeader ? sessions.get(sessionHeader) : undefined

      if (!transport) {
        const sessionId = sessionHeader ?? randomUUID()
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, newTransport)
          },
          enableJsonResponse: true,
        })
        newTransport.onclose = () => {
          sessions.delete(sessionId)
        }
        const server = buildServer()
        await server.connect(newTransport)
        transport = newTransport
      }

      await transport.handleRequest(req, res, req.body)
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
  await new Promise<void>((resolve) => {
    app.listen(port, host, () => resolve())
  })
  // eslint-disable-next-line no-console
  console.error(`[venice-mcp] listening on http://${host}:${port}/mcp`)
  if (host === '0.0.0.0') {
    // eslint-disable-next-line no-console
    console.error(`[venice-mcp] WARNING: bound to 0.0.0.0 — server is reachable from any network interface. Ensure this is intentional (e.g. inside a container).`)
  }
}
