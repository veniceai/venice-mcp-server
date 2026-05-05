import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { startMockVenice, type MockVeniceServer } from './helpers/mock-venice-server.js'

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname)

/**
 * Wraps a child process speaking JSON-RPC over stdio.
 */
class StdioRpcClient {
  private buf = ''
  private nextId = 1
  private pending = new Map<number, (msg: unknown) => void>()
  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buf += chunk
      let nl: number
      // Each JSON-RPC message is delimited by \n in our SDK output.
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as { id?: number }
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const resolve = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            resolve(msg)
          }
        } catch {
          // ignore non-JSON output (e.g. log lines on stderr)
        }
      }
    })
    child.stderr.on('data', () => {
      // discard
    })
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const msg = { jsonrpc: '2.0', id, method, params: params ?? {} }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, 5000)
      this.pending.set(id, (m) => {
        clearTimeout(timeout)
        resolve(m)
      })
      this.child.stdin.write(JSON.stringify(msg) + '\n')
    })
  }

  notify(method: string, params?: unknown): void {
    const msg = { jsonrpc: '2.0', method, params: params ?? {} }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  close(): void {
    this.child.stdin.end()
    this.child.kill('SIGTERM')
  }
}

interface RpcResult {
  jsonrpc: string
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

describe('integration — JSON-RPC over stdio with mock Venice', () => {
  let venice: MockVeniceServer
  let mcp: ChildProcessWithoutNullStreams
  let rpc: StdioRpcClient

  before(async () => {
    venice = await startMockVenice([
      { match: 'GET /v1/models', reply: { data: [{ id: 'venice-uncensored', type: 'text' }] } },
      {
        match: 'POST /v1/chat/completions',
        reply: ({ headers, body }) => ({
          choices: [
            {
              message: {
                content:
                  `auth=${headers.authorization ?? 'none'};` +
                  `siwx=${headers['x-sign-in-with-x'] ?? 'none'};` +
                  `model=${(body as { model?: string }).model};`,
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 9 },
        }),
      },
      {
        match: 'POST /v1/image/generate',
        reply: { id: 'mock-img-id', images: ['bW9jay1iYXNlNjQ='] },
      },
      {
        match: 'POST /v1/insufficient',
        reply: {
          __status: 402,
          __body: {
            reason: 'insufficient_balance',
            currentBalanceUsd: 0,
            minimumBalanceUsd: 0.1,
            suggestedTopUpUsd: 10,
            topUpInstructions: {
              step1: 'POST /api/v1/x402/top-up',
              step2: 'Sign USDC',
              step3: 'POST signed',
              receiverWallet: '0xVENICE',
              network: 'base',
            },
          },
        },
      },
      {
        match: 'POST /v1/x402/top-up',
        reply: {
          __status: 402,
          __body: {
            reason: 'authentication',
            authOptions: {
              apiKey: { getKey: 'https://venice.ai/settings/api', docs: 'https://docs.venice.ai/api-reference' },
              x402Wallet: { topUp: 'POST /api/v1/x402/top-up', docs: 'https://docs.venice.ai/x402' },
            },
          },
        },
      },
    ])

    mcp = spawn(
      'node',
      [path.join(REPO_ROOT, 'dist/cli.js')],
      {
        env: {
          ...process.env,
          VENICE_API_BASE_URL: venice.url,
          VENICE_API_KEY: 'vk_integration',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    rpc = new StdioRpcClient(mcp)

    // Initialize the MCP session
    const init = (await rpc.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0' },
    })) as RpcResult
    assert.equal(init.error, undefined)
    rpc.notify('notifications/initialized')
  })

  after(async () => {
    if (rpc) rpc.close()
    if (venice) await venice.close()
  })

  it('initialize returns server info + capabilities', async () => {
    // already tested in before(); verify capabilities advertised
    const tools = (await rpc.request('tools/list')) as RpcResult
    assert.ok(Array.isArray((tools.result as { tools: unknown[] }).tools))
  })

  it('lists 31 tools over JSON-RPC', async () => {
    const r = (await rpc.request('tools/list')) as RpcResult
    const list = (r.result as { tools: Array<{ name: string }> }).tools
    assert.equal(list.length, 31)
    // Spot-check a few
    const names = list.map((t) => t.name)
    assert.ok(names.includes('venice_chat'))
    assert.ok(names.includes('venice_video_status'))
    assert.ok(names.includes('venice_x402_balance'))
  })

  it('lists 3 resources', async () => {
    const r = (await rpc.request('resources/list')) as RpcResult
    const list = (r.result as { resources: Array<{ uri: string }> }).resources
    assert.equal(list.length, 3)
    const uris = list.map((r) => r.uri)
    assert.ok(uris.includes('venice://models'))
    assert.ok(uris.includes('venice://styles'))
    assert.ok(uris.includes('venice://voices'))
  })

  it('lists 3 prompts', async () => {
    const r = (await rpc.request('prompts/list')) as RpcResult
    const list = (r.result as { prompts: Array<{ name: string }> }).prompts
    assert.equal(list.length, 3)
  })

  it('venice_chat tool call hits Venice API and returns content', async () => {
    const r = (await rpc.request('tools/call', {
      name: 'venice_chat',
      arguments: { messages: [{ role: 'user', content: 'hi' }] },
    })) as RpcResult
    assert.equal(r.error, undefined)
    const text = (r.result as { content: Array<{ text: string }> }).content[0].text
    assert.match(text, /auth=Bearer vk_integration/)
    assert.match(text, /model=venice-uncensored/)
  })

  it('venice_image_generate returns base64 image content', async () => {
    const r = (await rpc.request('tools/call', {
      name: 'venice_image_generate',
      arguments: { prompt: 'a sunset' },
    })) as RpcResult
    assert.equal(r.error, undefined)
    const result = r.result as {
      content: Array<{ type: string; data?: string }>
      structuredContent?: { id?: string; count?: number }
    }
    const img = result.content.find((c) => c.type === 'image')
    assert.ok(img, 'expected image content')
    assert.equal(img!.data, 'bW9jay1iYXNlNjQ=')
    assert.equal(result.structuredContent?.id, 'mock-img-id')
  })

  it('reads venice://models resource', async () => {
    const r = (await rpc.request('resources/read', { uri: 'venice://models' })) as RpcResult
    assert.equal(r.error, undefined)
    const text = (r.result as { contents: Array<{ text: string }> }).contents[0].text
    assert.match(text, /venice-uncensored/)
  })
})

describe('integration — x402-only mode (no API key)', () => {
  let venice: MockVeniceServer
  let mcp: ChildProcessWithoutNullStreams
  let rpc: StdioRpcClient

  before(async () => {
    venice = await startMockVenice([
      {
        match: 'POST /v1/chat/completions',
        reply: ({ headers }) =>
          headers['x-sign-in-with-x']
            ? {
                choices: [{ message: { content: `siwx=${headers['x-sign-in-with-x']}` } }],
              }
            : {
                __status: 402,
                __body: {
                  reason: 'authentication',
                  authOptions: {
                    apiKey: { getKey: 'https://venice.ai/settings/api', docs: '' },
                    x402Wallet: { topUp: 'POST /api/v1/x402/top-up', docs: '' },
                  },
                },
              },
      },
    ])

    mcp = spawn('node', [path.join(REPO_ROOT, 'dist/cli.js')], {
      env: {
        ...process.env,
        VENICE_API_BASE_URL: venice.url,
        VENICE_SIWX_TOKEN: 'siwx_integration_token',
        // explicitly NO API key
        VENICE_API_KEY: undefined,
      } as unknown as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    rpc = new StdioRpcClient(mcp)
    await rpc.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0' },
    })
    rpc.notify('notifications/initialized')
  })

  after(async () => {
    if (rpc) rpc.close()
    if (venice) await venice.close()
  })

  it('forwards SIWX token instead of Authorization', async () => {
    const r = (await rpc.request('tools/call', {
      name: 'venice_chat',
      arguments: { messages: [{ role: 'user', content: 'hi' }] },
    })) as RpcResult
    const text = (r.result as { content: Array<{ text: string }> }).content[0].text
    assert.match(text, /siwx=siwx_integration_token/)
  })
})

describe('integration — no auth at all (402 surfaces auth options)', () => {
  let venice: MockVeniceServer
  let mcp: ChildProcessWithoutNullStreams
  let rpc: StdioRpcClient

  before(async () => {
    venice = await startMockVenice([
      {
        match: 'POST /v1/chat/completions',
        reply: {
          __status: 402,
          __body: {
            reason: 'authentication',
            authOptions: {
              apiKey: { getKey: 'https://venice.ai/settings/api', docs: 'https://docs.venice.ai/api-reference' },
              x402Wallet: { topUp: 'POST /api/v1/x402/top-up', docs: 'https://docs.venice.ai/x402' },
            },
          },
        },
      },
    ])
    mcp = spawn('node', [path.join(REPO_ROOT, 'dist/cli.js')], {
      env: {
        ...process.env,
        VENICE_API_BASE_URL: venice.url,
        VENICE_API_KEY: undefined,
        VENICE_SIWX_TOKEN: undefined,
      } as unknown as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    rpc = new StdioRpcClient(mcp)
    await rpc.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    rpc.notify('notifications/initialized')
  })

  after(async () => {
    if (rpc) rpc.close()
    if (venice) await venice.close()
  })

  it('returns isError=true with both auth options visible to the agent', async () => {
    const r = (await rpc.request('tools/call', {
      name: 'venice_chat',
      arguments: { messages: [{ role: 'user', content: 'hi' }] },
    })) as RpcResult
    const result = r.result as { isError?: boolean; content: Array<{ text: string }> }
    assert.equal(result.isError, true)
    const text = result.content[0].text
    assert.match(text, /402 Payment Required/)
    assert.match(text, /Option A — API key/)
    assert.match(text, /Option B — x402 wallet/)
  })
})
