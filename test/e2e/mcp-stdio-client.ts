/**
 * MCP client over stdio — spawns ./dist/cli.js as a child process and speaks
 * MCP JSON-RPC over its stdio transport. Used to drive end-to-end tests.
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

export type McpAuth =
  | { mode: 'apikey'; apiKey: string }
  | { mode: 'x402'; siwxToken: string }

export interface McpClient {
  call(method: string, params?: unknown): Promise<any>
  initialize(): Promise<any>
  listTools(): Promise<any>
  callTool(name: string, args?: Record<string, unknown>): Promise<any>
  close(): Promise<void>
  stderr(): string
}

export function spawnMcp(auth: McpAuth, env: NodeJS.ProcessEnv = {}): McpClient {
  const credential = auth.mode === 'apikey' ? auth.apiKey : auth.siwxToken
  if (!credential) throw new Error(`An explicit ${auth.mode} credential is required`)

  // Keep runtime settings, but never let inherited or overridden credentials
  // silently change the auth mode being tested. API keys take precedence upstream.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, NODE_ENV: 'test', VENICE_MCP_HTTP: '0' }
  delete childEnv.VENICE_API_KEY
  delete childEnv.VENICE_SIWX_TOKEN
  childEnv[auth.mode === 'apikey' ? 'VENICE_API_KEY' : 'VENICE_SIWX_TOKEN'] = credential

  const cliPath = resolve(process.cwd(), 'dist/cli.js')
  const proc = spawn(process.execPath, [cliPath], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stderrBuf = ''
  proc.stderr?.on('data', d => (stderrBuf += d.toString('utf8')))

  let nextId = 1
  const pending = new Map<number, {
    resolve: (v: any) => void
    reject: (e: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  let stdoutBuf = ''
  let closed = false

  function rejectPending(error: Error) {
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
  }

  proc.on('error', rejectPending)
  const childClosed = new Promise<void>(resolve => {
    proc.once('close', () => {
      closed = true
      rejectPending(new Error('MCP process closed'))
      resolve()
    })
  })

  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    let nl: number
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!
          pending.delete(msg.id)
          clearTimeout(p.timeout)
          if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
          else p.resolve(msg.result)
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  })

  function call(method: string, params?: unknown): Promise<any> {
    if (closed) return Promise.reject(new Error('MCP process closed'))
    return new Promise((resolve, reject) => {
      const id = nextId++
      // Timeout safety
      const timeout = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`MCP call timed out: ${method}`))
        }
      }, 60_000)
      pending.set(id, { resolve, reject, timeout })
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      proc.stdin?.write(req)
    })
  }

  return {
    call,
    initialize: () =>
      call('initialize', {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'e2e-tester', version: '1.0.0' },
        capabilities: {},
      }),
    listTools: () => call('tools/list', {}),
    callTool: (name, args = {}) => call('tools/call', { name, arguments: args }),
    async close() {
      if (!closed) {
        proc.stdin?.end()
        proc.kill()
      }
      await childClosed
    },
    stderr: () => stderrBuf,
  }
}
