import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { buildTools, type ToolDef } from '../src/tools/index.js'
import { loadConfig } from '../src/config.js'
import { StubClient } from './helpers/stub-client.js'

const cfg = loadConfig({ VENICE_API_KEY: 'test-key' })

function setup() {
  const stub = new StubClient()
  const tools = buildTools(stub.asClient(), cfg)
  const get = (name: string): ToolDef => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`tool not found: ${name}`)
    return t
  }
  return { stub, tools, get }
}

describe('tools registry', () => {
  it('registers exactly the documented set (33 tools)', () => {
    const { tools } = setup()
    const names = tools.map((t) => t.name).sort()
    const expected = [
      'venice_asr',
      'venice_audio_quote',
      'venice_chat',
      'venice_chat_with_character',
      'venice_crypto_rpc',
      'venice_embeddings',
      'venice_image_edit',
      'venice_image_generate',
      'venice_image_multi_edit',
      'venice_image_remove_bg',
      'venice_image_styles',
      'venice_image_upscale',
      'venice_list_characters',
      'venice_list_models',
      'venice_music_complete',
      'venice_music_generate',
      'venice_music_status',
      'venice_responses',
      'venice_tee_attestation',
      'venice_tee_signature',
      'venice_text_parser',
      'venice_tts',
      'venice_video_complete',
      'venice_video_generate',
      'venice_video_quote',
      'venice_video_status',
      'venice_video_transcriptions',
      'venice_voice_clone',
      'venice_web_scrape',
      'venice_web_search',
      'venice_x402_balance',
      'venice_x402_top_up_info',
      'venice_x402_transactions',
    ].sort()
    assert.deepEqual(names, expected)
    assert.equal(tools.length, 33)
  })

  it('every tool has a non-empty title and description', () => {
    const { tools } = setup()
    for (const t of tools) {
      assert.ok(t.title && t.title.length > 0, `title missing: ${t.name}`)
      assert.ok(t.description && t.description.length > 10, `description short: ${t.name}`)
    }
  })

  it('x402-eligible tools advertise wallet-auth support in their description', () => {
    const { get } = setup()
    const x402Tools = [
      'venice_chat',
      'venice_responses',
      'venice_embeddings',
      'venice_image_generate',
      'venice_image_edit',
      'venice_image_multi_edit',
      'venice_image_upscale',
      'venice_image_remove_bg',
      'venice_video_generate',
      'venice_video_status',
      'venice_video_complete',
      'venice_video_transcriptions',
      'venice_tts',
      'venice_asr',
      'venice_voice_clone',
      'venice_music_generate',
      'venice_music_status',
      'venice_music_complete',
      'venice_web_search',
      'venice_web_scrape',
      'venice_text_parser',
      'venice_crypto_rpc',
    ]
    for (const name of x402Tools) {
      const desc = get(name).description
      assert.match(desc, /x402/i, `${name} should mention x402 in description`)
    }
  })

  it('characters tools call out API-key-only requirement', () => {
    const { get } = setup()
    assert.match(get('venice_list_characters').description, /API key required/i)
    // chat_with_character notes the discovery limitation
    assert.match(get('venice_chat_with_character').description, /API[- ]key/i)
  })

  it('TEE tools advertise auth-free access and caller-side verification', () => {
    const { get } = setup()
    for (const name of ['venice_tee_attestation', 'venice_tee_signature']) {
      assert.match(get(name).description, /No authentication required/i)
      assert.match(get(name).description, /caller|verify/i)
    }
  })
})

// ----------------------------------------------------------------------------
// Endpoint + method mapping per tool. Each row says: when invoked with these
// args, the tool must hit this exact path and method.
// ----------------------------------------------------------------------------

interface Mapping {
  tool: string
  args: Record<string, unknown>
  expectMethod: 'GET' | 'POST'
  expectPath: string
  /** Optional: assert specific request body fields. */
  expectBodyContains?: Record<string, unknown>
  expectAuth?: 'default' | 'siwx' | 'none'
}

const MAPPINGS: Mapping[] = [
  // chat / text
  {
    tool: 'venice_chat',
    args: { messages: [{ role: 'user', content: 'hi' }] },
    expectMethod: 'POST',
    expectPath: '/v1/chat/completions',
    expectBodyContains: { stream: false },
  },
  {
    tool: 'venice_responses',
    args: { input: 'hello' },
    expectMethod: 'POST',
    expectPath: '/v1/responses',
  },
  {
    tool: 'venice_embeddings',
    args: { input: 'foo' },
    expectMethod: 'POST',
    expectPath: '/v1/embeddings',
  },

  // image
  {
    tool: 'venice_image_generate',
    args: { prompt: 'a cat' },
    expectMethod: 'POST',
    expectPath: '/v1/image/generate',
  },
  {
    tool: 'venice_image_edit',
    args: { image_url: 'https://x/img.png', prompt: 'add hat' },
    expectMethod: 'POST',
    expectPath: '/v1/image/edit',
    // Real endpoint returns binary; tool uses postBinary. Body uses `image` (not `image_url`).
    expectBodyContains: { image: 'https://x/img.png', prompt: 'add hat' },
  },
  {
    tool: 'venice_image_multi_edit',
    args: { image_urls: ['https://x/a.png', 'https://x/b.png'], prompt: 'merge' },
    expectMethod: 'POST',
    expectPath: '/v1/image/multi-edit',
    // Tool sends `images` (plural array), not `image_urls`.
    expectBodyContains: { images: ['https://x/a.png', 'https://x/b.png'] },
  },
  {
    tool: 'venice_image_upscale',
    // upscale uses multipart upload (fetches URL → uploads bytes)
    args: { image_url: 'https://93.184.216.34/image.png', scale: 4 },
    expectMethod: 'POST',
    expectPath: '/v1/image/upscale',
  },
  {
    tool: 'venice_image_remove_bg',
    args: { image_url: 'https://x/img.png' },
    expectMethod: 'POST',
    expectPath: '/v1/image/background-remove',
  },
  {
    tool: 'venice_image_styles',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/image/styles',
  },

  // video
  {
    tool: 'venice_video_generate',
    args: { prompt: 'a sunset' },
    expectMethod: 'POST',
    expectPath: '/v1/video/queue',
  },
  {
    tool: 'venice_video_status',
    args: { queue_id: 'vid-123', model: 'veo3.1-fast-text-to-video' },
    expectMethod: 'POST', // ← critical: NOT GET
    expectPath: '/v1/video/retrieve',
    expectBodyContains: { queue_id: 'vid-123', model: 'veo3.1-fast-text-to-video' },
  },
  {
    tool: 'venice_video_complete',
    args: { queue_id: 'vid-123', model: 'veo3.1-fast-text-to-video' },
    expectMethod: 'POST',
    expectPath: '/v1/video/complete',
  },
  {
    tool: 'venice_video_transcriptions',
    args: { url: 'https://www.youtube.com/watch?v=xxx' },
    expectMethod: 'POST',
    expectPath: '/v1/video/transcriptions',
  },
  {
    tool: 'venice_video_quote',
    args: { model: 'veo3.1-fast-text-to-video', duration: '8s' },
    // Real Venice endpoint is POST not GET
    expectMethod: 'POST',
    expectPath: '/v1/video/quote',
    expectBodyContains: { model: 'veo3.1-fast-text-to-video', duration: '8s' },
  },

  // audio (TTS / ASR / voices)
  {
    tool: 'venice_tts',
    args: { input: 'hello' },
    expectMethod: 'POST',
    expectPath: '/v1/audio/speech',
    expectBodyContains: { input: 'hello' },
  },
  {
    tool: 'venice_asr',
    // ASR fetches audio_url and uploads multipart.
    args: { audio_url: 'https://93.184.216.34/audio.wav' },
    expectMethod: 'POST',
    expectPath: '/v1/audio/transcriptions',
  },
  {
    tool: 'venice_voice_clone',
    args: { action: 'list' },
    // Action 'list' returns static catalog without hitting API
    expectMethod: 'GET',
    expectPath: '__no_api_call__',
  },

  // music (audio/queue + audio/retrieve + audio/complete)
  {
    tool: 'venice_music_generate',
    args: { prompt: 'jazz' },
    expectMethod: 'POST',
    expectPath: '/v1/audio/queue',
  },
  {
    tool: 'venice_music_status',
    args: { queue_id: 'mus-123', model: 'venice-music-1' },
    expectMethod: 'POST', // ← critical
    expectPath: '/v1/audio/retrieve',
    expectBodyContains: { queue_id: 'mus-123', model: 'venice-music-1' },
  },
  {
    tool: 'venice_music_complete',
    args: { queue_id: 'mus-123', model: 'venice-music-1' },
    expectMethod: 'POST',
    expectPath: '/v1/audio/complete',
  },
  {
    tool: 'venice_audio_quote',
    args: { model: 'elevenlabs-music', duration_seconds: 60 },
    // Real Venice endpoint is POST not GET
    expectMethod: 'POST',
    expectPath: '/v1/audio/quote',
    expectBodyContains: { model: 'elevenlabs-music', duration_seconds: 60 },
  },

  // augment
  {
    tool: 'venice_web_search',
    args: { query: 'venice ai' },
    expectMethod: 'POST',
    expectPath: '/v1/augment/search',
  },
  {
    tool: 'venice_web_scrape',
    args: { url: 'https://example.com' },
    expectMethod: 'POST',
    expectPath: '/v1/augment/scrape',
  },
  {
    tool: 'venice_text_parser',
    // text_parser fetches the URL and uploads as multipart.
    args: { url: 'https://93.184.216.34/document.pdf' },
    expectMethod: 'POST',
    expectPath: '/v1/augment/text-parser',
  },

  // crypto rpc
  {
    tool: 'venice_crypto_rpc',
    args: { network: 'base', rpc_method: 'eth_blockNumber' },
    expectMethod: 'POST',
    expectPath: '/v1/crypto/rpc/base',
    expectBodyContains: { jsonrpc: '2.0', method: 'eth_blockNumber' },
  },

  // catalog
  { tool: 'venice_list_models', args: {}, expectMethod: 'GET', expectPath: '/v1/models' },
  {
    tool: 'venice_tee_attestation',
    args: { model: 'e2ee-model', nonce: '0'.repeat(64) },
    expectMethod: 'GET',
    expectPath: `/v1/tee/attestation?model=e2ee-model&nonce=${'0'.repeat(64)}`,
    expectAuth: 'none',
  },
  {
    tool: 'venice_tee_signature',
    args: { model: 'e2ee-model', request_id: 'chatcmpl-test' },
    expectMethod: 'GET',
    expectPath: '/v1/tee/signature?model=e2ee-model&request_id=chatcmpl-test',
    expectAuth: 'none',
  },

  // characters
  { tool: 'venice_list_characters', args: {}, expectMethod: 'GET', expectPath: '/v1/characters' },
  {
    tool: 'venice_chat_with_character',
    args: { character_slug: 'alice', messages: [{ role: 'user', content: 'hi' }] },
    expectMethod: 'POST',
    expectPath: '/v1/chat/completions',
    // character_slug now wraps inside venice_parameters (Venice schema requirement)
    expectBodyContains: { venice_parameters: { character_slug: 'alice' } },
  },

  // x402 helpers
  {
    tool: 'venice_x402_balance',
    args: { wallet_address: '0x' + 'a'.repeat(40) },
    expectMethod: 'GET',
    expectPath: `/v1/x402/balance/0x${'a'.repeat(40)}`,
  },
  {
    tool: 'venice_x402_transactions',
    args: { wallet_address: '0x' + 'b'.repeat(40), limit: 5 },
    expectMethod: 'GET',
    expectPath: `/v1/x402/transactions/0x${'b'.repeat(40)}?limit=5`,
  },
]

describe('tools endpoint + method mapping', () => {
  for (const m of MAPPINGS) {
    it(`${m.tool} → ${m.expectMethod} ${m.expectPath}`, async () => {
      const stub = new StubClient()
      const tools = buildTools(stub.asClient(), cfg)
      const t = tools.find((x) => x.name === m.tool)
      if (!t) throw new Error(`tool missing: ${m.tool}`)
      const originalFetch = globalThis.fetch
      const uploadContentTypes: Record<string, string> = {
        venice_image_upscale: 'image/png',
        venice_asr: 'audio/wav',
        venice_text_parser: 'application/pdf',
      }
      try {
        if (uploadContentTypes[m.tool]) {
          globalThis.fetch = (async () =>
            new Response('mock upload bytes', {
              status: 200,
              headers: { 'content-type': uploadContentTypes[m.tool] },
            })) as typeof fetch
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await t.handler(m.args as any)
      } finally {
        globalThis.fetch = originalFetch
      }
      // Some tools (e.g. voice_clone action=list, returns static catalog) make no API call.
      if (m.expectPath === '__no_api_call__') {
        assert.equal(stub.calls.length, 0, `${m.tool} should not hit the API for this args`)
        return
      }
      assert.ok(stub.calls.length >= 1, `${m.tool} should hit the API at least once (got ${stub.calls.length})`)
      // Find the matching call (some tools fetch a remote URL first then call Venice)
      const call = stub.calls.find((c) => c.path === m.expectPath) || stub.calls[stub.calls.length - 1]
      assert.equal(call.method, m.expectMethod, `${m.tool} method`)
      assert.equal(call.path, m.expectPath, `${m.tool} path`)
      if (m.expectAuth) assert.equal(call.auth, m.expectAuth, `${m.tool} auth`)
      if (m.expectBodyContains) {
        const body = call.body as Record<string, unknown>
        for (const [k, v] of Object.entries(m.expectBodyContains)) {
          assert.deepEqual(body[k], v, `${m.tool} body.${k}`)
        }
      }
    })
  }
})

describe('chat and responses request contracts', () => {
  it('accepts every documented chat content block and forwards advanced fields exactly', async () => {
    const { stub, get } = setup()
    const tool = get('venice_chat')
    const args = {
      model: 'multimodal-model',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect these inputs', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
          { type: 'video_url', video_url: { url: 'https://example.com/video.mp4' } },
          { type: 'file', file: { file_data: 'https://example.com/report.pdf', filename: 'report.pdf' } },
        ],
      }],
      response_format: {
        type: 'json_schema',
        json_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      },
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look something up',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
          strict: true,
        },
      }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      parallel_tool_calls: false,
      prompt_cache_key: 'conversation-1',
      prompt_cache_retention: '24h',
      reasoning: { effort: 'high', summary: 'concise' },
      reasoning_effort: 'medium',
      max_completion_tokens: 2048,
      venice_parameters: { enable_e2ee: true },
      e2ee_headers: {
        client_public_key: `04${'1'.repeat(128)}`,
        model_public_key: `04${'2'.repeat(128)}`,
        signing_algorithm: 'ecdsa',
      },
    }
    const parsed = zObject(tool).parse(args)
    const result = await tool.handler(parsed as never)
    const call = stub.calls.at(-1)!
    const body = call.body as Record<string, unknown>
    const { e2ee_headers: _headers, ...bodyArgs } = args
    for (const [key, value] of Object.entries(bodyArgs)) {
      assert.deepEqual(body[key], value, `chat body.${key}`)
    }
    assert.equal('e2ee_headers' in body, false)
    assert.deepEqual(call.headers, {
      'X-Venice-TEE-Client-Pub-Key': args.e2ee_headers.client_public_key,
      'X-Venice-TEE-Model-Pub-Key': args.e2ee_headers.model_public_key,
      'X-Venice-TEE-Signing-Algo': 'ecdsa',
    })
    assert.equal(body.stream, true)
    assert.equal(call.eventStream, true)
    assert.equal((result.structuredContent as { transport: string }).transport, 'sse')
    assert.equal((result.structuredContent as { encrypted: boolean }).encrypted, true)
    assert.equal(
      (result.content[0] as { text: string }).text,
      'data: {"choices":[{"delta":{"content":"deadbeef"}}]}\n\ndata: [DONE]\n\n',
    )
  })

  it('keeps plaintext chat non-streaming with unchanged completion shaping', async () => {
    const { stub, get } = setup()
    const result = await get('venice_chat').handler({
      messages: [{ role: 'user', content: 'hello' }],
    } as never)
    const call = stub.calls.at(-1)!
    assert.equal((call.body as { stream: boolean }).stream, false)
    assert.equal(call.eventStream, undefined)
    assert.equal((result.content[0] as { text: string }).text, 'reply')
    assert.deepEqual((result.structuredContent as { usage: unknown }).usage, {
      prompt_tokens: 1,
      completion_tokens: 1,
    })
  })

  it('returns long encrypted SSE byte-for-byte without normal completion parsing or truncation', async () => {
    const encrypted = 'ab'.repeat(12_000)
    const rawSse =
      `event: message\r\ndata: {"choices":[{"delta":{"content":"${encrypted}"}}]}\r\n\r\n` +
      'data: [DONE]\r\n\r\n'
    const stub = new StubClient({ '/v1/chat/completions': () => rawSse })
    const tool = buildTools(stub.asClient(), cfg).find((candidate) => candidate.name === 'venice_chat')!
    const result = await tool.handler({
      messages: [{ role: 'user', content: '04'.repeat(100) }],
      venice_parameters: { enable_e2ee: true },
      e2ee_headers: {
        client_public_key: `04${'1'.repeat(128)}`,
        model_public_key: `04${'2'.repeat(128)}`,
        signing_algorithm: 'ecdsa',
      },
    } as never)
    assert.equal((result.content[0] as { text: string }).text, rawSse)
    assert.equal((result.structuredContent as { byte_length: number }).byte_length, Buffer.byteLength(rawSse))
    assert.equal((result.structuredContent as { message?: unknown }).message, undefined)
  })

  it('rejects incoherent E2EE flag/header combinations before any upstream call', async () => {
    const completeHeaders = {
      client_public_key: `04${'1'.repeat(128)}`,
      model_public_key: `04${'2'.repeat(128)}`,
      signing_algorithm: 'ecdsa',
    }
    const invalidArgs = [
      {
        messages: [{ role: 'user', content: 'encrypted' }],
        venice_parameters: { enable_e2ee: true },
      },
      {
        messages: [{ role: 'user', content: 'plaintext' }],
        e2ee_headers: completeHeaders,
      },
      {
        messages: [{ role: 'user', content: 'plaintext' }],
        venice_parameters: { enable_e2ee: false },
        e2ee_headers: completeHeaders,
      },
      {
        messages: [{ role: 'user', content: 'encrypted' }],
        venice_parameters: { enable_e2ee: true },
        e2ee_headers: { client_public_key: completeHeaders.client_public_key },
      },
    ]
    for (const args of invalidArgs) {
      const stub = new StubClient()
      const tool = buildTools(stub.asClient(), cfg).find((candidate) => candidate.name === 'venice_chat')!
      const result = await tool.handler(args as never)
      assert.equal(result.isError, true)
      assert.equal(stub.calls.length, 0)
    }
  })

  it('supports assistant tool history and returns tool calls instead of dropping them', async () => {
    const stub = new StubClient({
      '/v1/chat/completions': () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
          },
        }],
      }),
    })
    const tool = buildTools(stub.asClient(), cfg).find((candidate) => candidate.name === 'venice_chat')!
    const result = await tool.handler({
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"result":"ok"}' },
      ],
    } as never)
    const message = (result.structuredContent as { message: { tool_calls: unknown[] } }).message
    assert.equal(message.tool_calls.length, 1)
    assert.match((result.content[0] as { text: string }).text, /tool_calls/)
  })

  it('keeps Responses to its accepted text/image/reasoning subset and does not advertise tools or E2EE', async () => {
    const { stub, get } = setup()
    const tool = get('venice_responses')
    assert.equal('tools' in tool.inputSchema, false)
    assert.equal('tool_choice' in tool.inputSchema, false)
    assert.doesNotMatch(tool.description, /with tool support/i)
    assert.match(tool.description, /E2EE-capable models are not supported/i)

    const args = {
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this' },
          { type: 'input_image', image_url: { url: 'https://example.com/image.png', detail: 'low' } },
        ],
      }],
      top_p: 0.8,
      reasoning: { effort: 'low', summary: 'auto' },
    }
    const parsed = zObject(tool).parse(args)
    await tool.handler(parsed as never)
    const body = stub.calls.at(-1)?.body as Record<string, unknown>
    for (const [key, value] of Object.entries(args)) {
      assert.deepEqual(body[key], value, `responses body.${key}`)
    }
    assert.deepEqual(
      Object.keys((body.venice_parameters ?? {}) as Record<string, unknown>).includes('enable_e2ee'),
      false,
    )
  })

  it('requires a caller-supplied 32-byte hexadecimal attestation nonce', () => {
    const { get } = setup()
    const schema = zObject(get('venice_tee_attestation'))
    assert.equal(schema.safeParse({ model: 'e2ee-model', nonce: 'a'.repeat(64) }).success, true)
    assert.equal(schema.safeParse({ model: 'e2ee-model', nonce: 'a'.repeat(32) }).success, false)
    assert.equal(schema.safeParse({ model: 'e2ee-model', nonce: 'z'.repeat(64) }).success, false)
  })
})

function zObject(tool: ToolDef) {
  return z.object(tool.inputSchema)
}

describe('tool output shaping', () => {
  it('venice_image_generate returns base64 image content + structuredContent.id', async () => {
    const { get } = setup()
    const r = await get('venice_image_generate').handler({ prompt: 'a cat' } as never)
    assert.equal(r.isError, undefined)
    // Default Venice response is { id, images: [base64] } → tool returns image content
    const img = r.content.find((c) => c.type === 'image') as { type: string; data: string } | undefined
    assert.ok(img, 'expected image content')
    assert.ok(img.data.length > 0, 'base64 data should be non-empty')
    assert.equal((r.structuredContent as { id: string }).id, 'stub-img-id')
  })

  it('venice_video_status returns COMPLETED + URL when ready', async () => {
    const { get } = setup()
    const r = await get('venice_video_status').handler({ queue_id: 'x', model: 'm' } as never)
    assert.equal((r.structuredContent as { status: string }).status, 'COMPLETED')
    assert.equal((r.structuredContent as { url: string }).url, 'https://stub/v.mp4')
  })

  it('venice_video_status returns PROCESSING progress when not ready', async () => {
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({ status: 'PROCESSING', average_execution_time: 60_000, execution_duration: 12_000 }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'x',
      model: 'm',
    } as never)
    assert.equal((r.structuredContent as { status: string }).status, 'PROCESSING')
    assert.match((r.content[0] as { text: string }).text, /PROCESSING/)
  })

  it('venice_chat surfaces error string when API throws 402', async () => {
    const stub = new StubClient({
      '/v1/chat/completions': async () => {
        const { VeniceUpstreamError } = await import('../src/types.js')
        throw new VeniceUpstreamError({
          message: 'pay',
          status: 402,
          body: { reason: 'insufficient_balance', currentBalanceUsd: 0, minimumBalanceUsd: 0.1 },
        })
      },
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_chat')!.handler({
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    assert.equal(r.isError, true)
    assert.match((r.content[0] as { text: string }).text, /402 Payment Required/)
  })

  it('venice_chat preserves structured 402 diagnostics on the E2EE SSE path', async () => {
    const stub = new StubClient({
      '/v1/chat/completions': async () => {
        const { VeniceUpstreamError } = await import('../src/types.js')
        throw new VeniceUpstreamError({
          message: 'pay',
          status: 402,
          body: {
            reason: 'insufficient_balance',
            currentBalanceUsd: 0,
            minimumBalanceUsd: 0.1,
            suggestedTopUpUsd: 10,
          },
        })
      },
    })
    const tool = buildTools(stub.asClient(), cfg).find((candidate) => candidate.name === 'venice_chat')!
    const result = await tool.handler({
      messages: [{ role: 'user', content: 'encrypted' }],
      venice_parameters: { enable_e2ee: true },
      e2ee_headers: {
        client_public_key: `04${'1'.repeat(128)}`,
        model_public_key: `04${'2'.repeat(128)}`,
        signing_algorithm: 'ecdsa',
      },
    } as never)
    assert.equal(result.isError, true)
    const text = (result.content[0] as { text: string }).text
    assert.match(text, /402 Payment Required/)
    assert.match(text, /Current balance:\s+\$0\.0000/)
    assert.match(text, /Suggested top-up:\s+\$10\.00/)
  })

  it('venice_list_models filters by capability type', async () => {
    const { get } = setup()
    const r = await get('venice_list_models').handler({ type: 'image' } as never)
    assert.equal((r.structuredContent as { count: number; total: number }).total, 3)
    assert.equal((r.structuredContent as { count: number }).count, 1)
  })

  it('x402 wallet helper tools request SIWX auth override', async () => {
    const stub = new StubClient()
    const tools = buildTools(stub.asClient(), cfg)

    await tools.find((t) => t.name === 'venice_x402_balance')!.handler({
      wallet_address: `0x${'a'.repeat(40)}`,
    } as never)
    assert.equal(stub.calls.at(-1)?.auth, 'siwx')

    await tools.find((t) => t.name === 'venice_x402_transactions')!.handler({
      wallet_address: `0x${'b'.repeat(40)}`,
      limit: 5,
    } as never)
    assert.equal(stub.calls.at(-1)?.auth, 'siwx')
  })

  it('venice_asr reports timeout when fetching audio_url stalls', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = ((_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          }
          if (init?.signal?.aborted) rejectAbort()
          else init?.signal?.addEventListener('abort', rejectAbort, { once: true })
        })) as typeof fetch

      const timeoutCfg = loadConfig({ VENICE_API_KEY: 'test-key', VENICE_HTTP_TIMEOUT_MS: '5' })
      const tools = buildTools(new StubClient().asClient(), timeoutCfg)
      const r = await tools.find((t) => t.name === 'venice_asr')!.handler({
        audio_url: 'https://93.184.216.34/slow.wav',
      } as never)

      assert.equal(r.isError, true)
      assert.match((r.content[0] as { text: string }).text, /Timed out fetching audio_url after 5ms/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
