import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockRoute {
  /** Method + path, e.g. "POST /v1/chat/completions". Path may end with "*" for prefix match. */
  match: string
  /**
   * Either a static response or a function that gets the parsed request and returns one.
   * Return a plain object → 200 JSON. Return { __status, __body, __headers } → custom.
   */
  reply:
    | unknown
    | ((req: { method: string; path: string; headers: Record<string, string>; body: unknown }) => unknown)
}

export interface MockVeniceServer {
  url: string
  port: number
  /** Calls received, in order. */
  calls: Array<{
    method: string
    path: string
    headers: Record<string, string>
    body: unknown
  }>
  close(): Promise<void>
}

export async function startMockVenice(routes: MockRoute[]): Promise<MockVeniceServer> {
  const calls: MockVeniceServer['calls'] = []

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', async () => {
      const path = req.url ?? '/'
      const method = req.method ?? 'GET'
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '')
      }
      let body: unknown = undefined
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
      }
      calls.push({ method, path, headers, body })

      // Find first matching route
      const match = routes.find((r) => {
        const [m, p] = r.match.split(' ', 2)
        if (m !== method) return false
        if (p.endsWith('*')) return path.startsWith(p.slice(0, -1))
        return path === p
      })

      if (!match) {
        res.statusCode = 404
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'no mock route', method, path }))
        return
      }

      let reply =
        typeof match.reply === 'function'
          ? (match.reply as (r: typeof calls[number]) => unknown)({ method, path, headers, body })
          : match.reply
      if (reply && typeof (reply as { then?: unknown }).then === 'function') {
        reply = await (reply as Promise<unknown>)
      }

      if (
        reply &&
        typeof reply === 'object' &&
        '__status' in (reply as object)
      ) {
        const r = reply as {
          __status: number
          __body?: unknown
          __headers?: Record<string, string>
        }
        res.statusCode = r.__status
        for (const [k, v] of Object.entries(r.__headers ?? {})) {
          res.setHeader(k, v)
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(r.__body ?? {}))
        return
      }

      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(reply))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
