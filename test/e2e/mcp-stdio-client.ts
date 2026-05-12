/**
 * MCP client over stdio — spawns ./dist/cli.js as a child process and speaks
 * MCP JSON-RPC over its stdio transport. Used to drive end-to-end tests.
 */
import { spawn, ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'

export interface McpClient {
  call(method: string, params?: unknown): Promise<any>
  initialize(): Promise<any>
  listTools(): Promise<any>
  callTool(name: string, args?: Record<string, unknown>): Promise<any>
  close(): Promise<void>
  stderr(): string
}

export function spawnMcp(env: Record<string, string>): McpClient {
  const cliPath = resolve(process.cwd(), 'dist/cli.js')
  const proc = spawn(process.execPath, [cliPath], {
    env: { ...process.env, ...env, NODE_ENV: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stderrBuf = ''
  proc.stderr?.on('data', d => (stderrBuf += d.toString('utf8')))

  let nextId = 1
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  let stdoutBuf = ''

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
          if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
          else p.resolve(msg.result)
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  })

  function call(method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      proc.stdin?.write(req)
      // Timeout safety
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`MCP call timed out: ${method}`))
        }
      }, 60_000)
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
      proc.stdin?.end()
      proc.kill()
      try {
        await once(proc, 'exit')
      } catch {}
    },
    stderr: () => stderrBuf,
  }
}
