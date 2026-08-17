import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { startMockVenice, type MockVeniceServer } from './helpers/mock-venice-server.js'

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const INTEGRATION_ENCRYPTED_CHUNK = 'cd'.repeat(12_000)
const INTEGRATION_RAW_SSE =
  `event: message\r\ndata: {"choices":[{"delta":{"content":"${INTEGRATION_ENCRYPTED_CHUNK}"}}]}\r\n\r\n` +
  'data: [DONE]\r\n\r\n'

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
      { match: 'GET /v1/models', reply: { data: [{ id: 'deepseek-v4-flash-0731', type: 'text' }] } },
      {
        match: 'POST /v1/chat/completions',
        reply: ({ headers, body }) => {
          if ((body as { stream?: boolean }).stream === true) {
            return {
              __status: 200,
              __rawBody: INTEGRATION_RAW_SSE,
              __headers: { 'content-type': 'text/event-stream; charset=utf-8' },
            }
          }
          return {
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
          }
        },
      },
      {
        match: 'POST /v1/image/generate',
        reply: { id: 'mock-img-id', images: ['bW9jay1iYXNlNjQ='] },
      },
      {
        match: 'GET /v1/tee/attestation*',
        reply: {
          verified: true,
          nonce: 'a'.repeat(64),
          model: 'e2ee-model',
          tee_provider: 'near-ai',
          intel_quote: 'quote',
          signing_key: `04${'1'.repeat(128)}`,
          signing_address: `0x${'2'.repeat(40)}`,
        },
      },
      {
        match: 'GET /v1/tee/signature*',
        reply: { model: 'e2ee-model', request_id: 'chatcmpl-test', signature: '0xsigned' },
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
          VENICE_TEST_BASE_URL: venice.url,
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

  it('lists 33 tools over JSON-RPC', async () => {
    const r = (await rpc.request('tools/list')) as RpcResult
    const list = (r.result as { tools: Array<{ name: string }> }).tools
    assert.equal(list.length, 33)
    // Spot-check a few
    const names = list.map((t) => t.name)
    assert.ok(names.includes('venice_chat'))
    assert.ok(names.includes('venice_video_status'))
    assert.ok(names.includes('venice_x402_balance'))
    assert.ok(names.includes('venice_tee_attestation'))
    assert.ok(names.includes('venice_tee_signature'))
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
    assert.match(text, /model=deepseek-v4-flash-0731/)
    const call = venice.calls.filter((candidate) => candidate.path === '/v1/chat/completions').at(-1)!
    assert.equal((call.body as { stream: boolean }).stream, false)
    assert.equal(call.headers.accept, 'application/json')
  })

  it('forwards advanced chat fields unchanged over MCP and HTTP', async () => {
    const arguments_ = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect' },
          { type: 'file', file: { file_data: 'https://example.com/report.pdf', filename: 'report.pdf' } },
        ],
      }],
      max_completion_tokens: 321,
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
      prompt_cache_key: 'integration-cache',
      prompt_cache_retention: '24h',
      venice_parameters: { enable_e2ee: true },
      e2ee_headers: {
        client_public_key: `04${'1'.repeat(128)}`,
        model_public_key: `04${'2'.repeat(128)}`,
        signing_algorithm: 'ecdsa',
      },
    }
    const r = (await rpc.request('tools/call', {
      name: 'venice_chat',
      arguments: arguments_,
    })) as RpcResult
    assert.equal(r.error, undefined)
    const call = venice.calls.filter((candidate) => candidate.path === '/v1/chat/completions').at(-1)!
    const body = call.body as Record<string, unknown>
    const { e2ee_headers: _headers, ...bodyArguments } = arguments_
    for (const [key, value] of Object.entries(bodyArguments)) {
      assert.deepEqual(body[key], value, `chat body.${key}`)
    }
    assert.equal('e2ee_headers' in body, false)
    assert.equal(call.headers['x-venice-tee-client-pub-key'], arguments_.e2ee_headers.client_public_key)
    assert.equal(call.headers['x-venice-tee-model-pub-key'], arguments_.e2ee_headers.model_public_key)
    assert.equal(call.headers['x-venice-tee-signing-algo'], 'ecdsa')
    assert.equal(call.headers.accept, 'text/event-stream')
    assert.equal(body.stream, true)
    const result = r.result as {
      content: Array<{ text: string }>
      structuredContent: { transport: string; encrypted: boolean; byte_length: number }
    }
    assert.equal(result.content[0].text, INTEGRATION_RAW_SSE)
    assert.equal(result.structuredContent.transport, 'sse')
    assert.equal(result.structuredContent.encrypted, true)
    assert.equal(result.structuredContent.byte_length, Buffer.byteLength(INTEGRATION_RAW_SSE))
  })

  it('rejects incoherent E2EE inputs over MCP without contacting Venice', async () => {
    const beforeCalls = venice.calls.filter((candidate) => candidate.path === '/v1/chat/completions').length
    const r = (await rpc.request('tools/call', {
      name: 'venice_chat',
      arguments: {
        messages: [{ role: 'user', content: 'encrypted' }],
        venice_parameters: { enable_e2ee: true },
      },
    })) as RpcResult
    assert.equal(r.error, undefined)
    const result = r.result as { isError?: boolean; content: Array<{ text: string }> }
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /complete validated e2ee_headers bundle/)
    const afterCalls = venice.calls.filter((candidate) => candidate.path === '/v1/chat/completions').length
    assert.equal(afterCalls, beforeCalls)
  })

  it('calls auth-free TEE endpoints with exact query fields', async () => {
    const attestation = (await rpc.request('tools/call', {
      name: 'venice_tee_attestation',
      arguments: { model: 'e2ee-model', nonce: 'a'.repeat(64) },
    })) as RpcResult
    assert.equal(attestation.error, undefined)
    const attestationCall = venice.calls.find((candidate) => candidate.path.startsWith('/v1/tee/attestation?'))!
    assert.match(attestationCall.path, /model=e2ee-model/)
    assert.match(attestationCall.path, new RegExp(`nonce=${'a'.repeat(64)}`))
    assert.equal(attestationCall.headers.authorization, undefined)
    assert.equal(attestationCall.headers['x-sign-in-with-x'], undefined)

    const signature = (await rpc.request('tools/call', {
      name: 'venice_tee_signature',
      arguments: { model: 'e2ee-model', request_id: 'chatcmpl-test' },
    })) as RpcResult
    assert.equal(signature.error, undefined)
    const signatureCall = venice.calls.find((candidate) => candidate.path.startsWith('/v1/tee/signature?'))!
    assert.match(signatureCall.path, /model=e2ee-model/)
    assert.match(signatureCall.path, /request_id=chatcmpl-test/)
    assert.equal(signatureCall.headers.authorization, undefined)
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
    assert.match(text, /deepseek-v4-flash-0731/)
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
        VENICE_TEST_BASE_URL: venice.url,
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
        VENICE_TEST_BASE_URL: venice.url,
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
