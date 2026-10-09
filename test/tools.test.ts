import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { buildTools, type ToolDef } from '../src/tools/index.js'
import { loadConfig } from '../src/config.js'
import { StubClient } from './helpers/stub-client.js'
import { TOOL_ANNOTATIONS } from '../src/tools/annotations.js'

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
  it('registers exactly the documented set (35 tools)', () => {
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
      'venice_model_compatibility_mapping',
      'venice_model_details',
      'venice_model_traits',
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
      'venice_voice_clone',
      'venice_web_scrape',
      'venice_web_search',
      'venice_x402_balance',
      'venice_x402_top_up_info',
      'venice_x402_transactions',
    ].sort()
    assert.deepEqual(names, expected)
    assert.equal(tools.length, 35)
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

  it('requires a non-empty model id and bounded type for venice_model_details', () => {
    const { get } = setup()
    const schema = z.object(get('venice_model_details').inputSchema)
    assert.equal(schema.safeParse({ model_id: '', type: 'image' }).success, false)
    assert.equal(schema.safeParse({ model_id: '   ', type: 'image' }).success, false)
    assert.equal(schema.safeParse({ model_id: 'flux-2-pro' }).success, false)
    assert.equal(schema.safeParse({ model_id: 'flux-2-pro', type: 'all' }).success, false)
    assert.equal(schema.safeParse({ model_id: 'flux-2-pro', type: 'code' }).success, false)
    assert.equal(schema.safeParse({ model_id: 'jev-latest', type: 'decision' }).success, true)
    assert.equal(schema.safeParse({ model_id: 'x', type: 'some-new-type' }).success, true)
    assert.deepEqual(schema.parse({ model_id: '  FLUX-2-Pro  ', type: 'image' }), {
      model_id: 'FLUX-2-Pro',
      type: 'image',
    })
  })

  it('venice_audio_quote accepts every duration venice_music_generate accepts', () => {
    const { get } = setup()
    const generate = z.object(get('venice_music_generate').inputSchema)
    const quote = z.object(get('venice_audio_quote').inputSchema)
    for (const duration_seconds of [1, 300, 301, 600, '1', '45', '480']) {
      assert.equal(generate.safeParse({ prompt: 'p', model: 'm', duration_seconds }).success, true)
      assert.equal(quote.safeParse({ model: 'm', duration_seconds }).success, true)
    }
    for (const duration_seconds of [0, -1, 1.5, '0', '00', '01', '-1', '4.5', 'abc', '']) {
      assert.equal(generate.safeParse({ prompt: 'p', model: 'm', duration_seconds }).success, false)
      assert.equal(quote.safeParse({ model: 'm', duration_seconds }).success, false)
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
    args: {
      input: 'foo',
      model: 'text-embedding-bge-m3',
    },
    expectMethod: 'POST',
    expectPath: '/v1/embeddings',
    expectBodyContains: {
      model: 'text-embedding-bge-m3',
    },
  },
  // image
  {
    tool: 'venice_image_generate',
    args: {
      prompt: 'a cat',
      aspect_ratio: '21:9-custom',
      resolution: '2K-model-tier',
      quality: 'high',
      enhance_prompt: true,
      style_references: [{ image: 'https://x/style.png', strength: 0.7 }],
      enable_web_search: true,
      disable_prompt_optimization_thinking: true,
      variants: 3,
      format: 'png',
    },
    expectMethod: 'POST',
    expectPath: '/v1/image/generate',
    expectBodyContains: {
      aspect_ratio: '21:9-custom',
      resolution: '2K-model-tier',
      quality: 'high',
      enhance_prompt: true,
      style_references: [{ image: 'https://x/style.png', strength: 0.7 }],
      enable_web_search: true,
      disable_prompt_optimization_thinking: true,
      variants: 3,
      format: 'png',
    },
  },
  {
    tool: 'venice_image_edit',
    args: {
      image_url: 'https://x/img.png',
      prompt: 'add hat',
      aspect_ratio: '7:3-model-specific',
      enhance_prompt: true,
      resolution: '4K-custom',
      output_format: 'webp',
    },
    expectMethod: 'POST',
    expectPath: '/v1/image/edit',
    // Real endpoint returns binary; tool uses postBinary. Body uses `image` (not `image_url`).
    expectBodyContains: {
      image: 'https://x/img.png',
      prompt: 'add hat',
      aspect_ratio: '7:3-model-specific',
      enhance_prompt: true,
      resolution: '4K-custom',
      output_format: 'webp',
    },
  },
  {
    tool: 'venice_image_multi_edit',
    args: {
      image_urls: ['https://x/a.png', 'https://x/b.png'],
      prompt: 'merge',
      aspect_ratio: '5:2-model-specific',
      enhance_prompt: true,
      resolution: '2K-custom',
      output_format: 'jpeg',
      quality: 'high',
    },
    expectMethod: 'POST',
    expectPath: '/v1/image/multi-edit',
    // Tool sends `images` (plural array), not `image_urls`.
    expectBodyContains: {
      images: ['https://x/a.png', 'https://x/b.png'],
      aspect_ratio: '5:2-model-specific',
      enhance_prompt: true,
      resolution: '2K-custom',
      output_format: 'jpeg',
      quality: 'high',
    },
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
    args: {
      prompt: 'a sunset',
      model: 'seedance-2-0-reference-to-video',
      duration: '8s',
      consents: {
        seedance: {
          confirmed_terms_and_privacy: true,
          confirmed_legal_right: true,
          confirmed_screening_acknowledged: true,
        },
      },
    },
    expectMethod: 'POST',
    expectPath: '/v1/video/queue',
    expectBodyContains: {
      model: 'seedance-2-0-reference-to-video',
      duration: '8s',
      consents: {
        seedance: {
          confirmed_terms_and_privacy: true,
          confirmed_legal_right: true,
          confirmed_screening_acknowledged: true,
        },
      },
    },
  },
  {
    tool: 'venice_video_status',
    args: { queue_id: 'vid-123', model: 'veo3.1-fast-text-to-video' },
    expectMethod: 'POST', // ← critical: NOT GET
    expectPath: '/v1/video/retrieve',
    expectBodyContains: {
      queue_id: 'vid-123',
      model: 'veo3.1-fast-text-to-video',
      delete_media_on_completion: false,
    },
  },
  {
    tool: 'venice_video_complete',
    args: { queue_id: 'vid-123', model: 'veo3.1-fast-text-to-video' },
    expectMethod: 'POST',
    expectPath: '/v1/video/complete',
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
    args: { input: 'hello', temperature: 0.7, streaming: true },
    expectMethod: 'POST',
    expectPath: '/v1/audio/speech',
    expectBodyContains: { input: 'hello', temperature: 0.7, streaming: true },
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
    expectMethod: 'GET',
    expectPath: '/v1/models?type=tts',
  },

  // music (audio/queue + audio/retrieve + audio/complete)
  {
    tool: 'venice_music_generate',
    args: {
      prompt: 'jazz',
      model: 'elevenlabs-music',
      duration_seconds: '60',
      force_instrumental: true,
      lyrics_prompt: 'City lights',
      lyrics_optimizer: false,
      loop: true,
      voice: 'Aria',
      language_code: 'en',
      speed: 1.25,
    },
    expectMethod: 'POST',
    expectPath: '/v1/audio/queue',
    expectBodyContains: {
      duration_seconds: '60',
      force_instrumental: true,
      lyrics_prompt: 'City lights',
      lyrics_optimizer: false,
      loop: true,
      voice: 'Aria',
      language_code: 'en',
      speed: 1.25,
    },
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
    args: { query: 'venice ai', search_provider: 'google' },
    expectMethod: 'POST',
    expectPath: '/v1/augment/search',
    expectBodyContains: { search_provider: 'google' },
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
  { tool: 'venice_list_models', args: {}, expectMethod: 'GET', expectPath: '/v1/models?type=all' },
  { tool: 'venice_list_models', args: { type: 'video' }, expectMethod: 'GET', expectPath: '/v1/models?type=video' },
  {
    tool: 'venice_list_models',
    args: { type: 'tts' },
    expectMethod: 'GET',
    expectPath: '/v1/models?type=tts',
  },
  {
    tool: 'venice_model_traits',
    args: { type: 'image' },
    expectMethod: 'GET',
    expectPath: '/v1/models/traits?type=image',
  },
  {
    tool: 'venice_model_compatibility_mapping',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/models/compatibility_mapping',
  },
  {
    tool: 'venice_model_details',
    args: { model_id: 'flux-2-pro', type: 'image' },
    expectMethod: 'GET',
    expectPath: '/v1/models?type=image',
  },
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
    }
    const parsed = zObject(tool).parse(args)
    const result = await tool.handler(parsed as never)
    const call = stub.calls.at(-1)!
    const body = call.body as Record<string, unknown>
    for (const [key, value] of Object.entries(args)) {
      assert.deepEqual(body[key], value, `chat body.${key}`)
    }
    assert.equal(body.stream, false)
    assert.equal(call.eventStream, undefined)
    assert.equal((result.content[0] as { text: string }).text, 'reply')
  })

  it('forwards a bounded per-call timeout_ms on plaintext chat', async () => {
    const { stub, get } = setup()
    const tool = get('venice_chat')
    const schema = zObject(tool)
    assert.equal(schema.safeParse({ messages: [{ role: 'user', content: 'x' }], timeout_ms: 600_001 }).success, false)
    assert.equal(schema.safeParse({ messages: [{ role: 'user', content: 'x' }], timeout_ms: 999 }).success, false)

    await tool.handler(schema.parse({ messages: [{ role: 'user', content: 'hi' }], timeout_ms: 120_000 }) as never)
    const plainCall = stub.calls.at(-1)!
    assert.equal(plainCall.eventStream, undefined)
    assert.equal(plainCall.timeoutMs, 120_000)
    assert.equal('timeout_ms' in (plainCall.body as Record<string, unknown>), false)
  })

  it('rejects enable_e2ee before any chat request', async () => {
    const { stub, get } = setup()
    const tool = get('venice_chat')
    const schema = zObject(tool)
    assert.equal(
      schema.safeParse({
        messages: [{ role: 'user', content: 'hello' }],
        venice_parameters: { enable_e2ee: true },
      }).success,
      false,
    )
    const result = await tool.handler({
      messages: [{ role: 'user', content: 'hello' }],
      venice_parameters: { enable_e2ee: true },
    } as never)
    assert.equal(result.isError, true)
    assert.match((result.content[0] as { text: string }).text, /does not accept enable_e2ee/)
    assert.equal(stub.calls.some((call) => call.path === '/v1/chat/completions'), false)
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

  it('preserves per-tool-call thought signatures through schema validation and replay', async () => {
    const message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', thought_signature: 'signature-1+/=', function: { name: 'lookup', arguments: '{}' } },
        { id: 'call_2', type: 'function', thought_signature: 'signature-2+/=', function: { name: 'lookup', arguments: '{}' } },
      ],
    }
    const stub = new StubClient({ '/v1/chat/completions': () => ({ choices: [{ message }] }) })
    const tool = buildTools(stub.asClient(), cfg).find((candidate) => candidate.name === 'venice_chat')!
    const schema = z.object(tool.inputSchema)
    const first = await tool.handler(schema.parse({ messages: [{ role: 'user', content: 'Look these up' }] }))
    const messages = [
      first.structuredContent?.message,
      { role: 'tool', tool_call_id: 'call_1', content: 'first result' },
      { role: 'tool', tool_call_id: 'call_2', content: 'second result' },
    ]
    const replay = schema.parse({ messages })
    await tool.handler(replay)
    assert.deepEqual((stub.calls.at(-1)?.body as { messages: unknown[] }).messages, messages)
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

  it('venice_image_generate returns every Venice images[] variant', async () => {
    const variants = ['dmFyaWFudC0x', 'dmFyaWFudC0y', 'dmFyaWFudC0z']
    const stub = new StubClient({
      '/v1/image/generate': () => ({
        __stubResponse: true,
        data: { id: 'variants', images: variants },
      }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_image_generate')!.handler({
      prompt: 'three scenes',
      variants: 3,
    } as never)

    const images = r.content.filter((item) => item.type === 'image') as Array<{ data: string }>
    assert.deepEqual(images.map((image) => image.data), variants)
    assert.equal((r.structuredContent as { count: number }).count, 3)
  })

  it('venice_image_generate returns every usable OpenAI data[] variant', async () => {
    const stub = new StubClient({
      '/v1/image/generate': () => ({
        __stubResponse: true,
        data: {
          id: 'openai-variants',
          data: [
            { url: 'https://x/one.png' },
            { b64_json: 'dmFyaWFudC10d28=' },
            { url: 'https://x/three.png' },
          ],
        },
      }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_image_generate')!.handler({
      prompt: 'three scenes',
      variants: 3,
    } as never)

    const media = r.content.filter((item) => item.type === 'image' || item.type === 'resource_link')
    assert.equal(media.length, 3)
    assert.equal(media[0].type, 'resource_link')
    assert.equal(media[1].type, 'image')
    assert.equal(media[2].type, 'resource_link')
    assert.equal((r.structuredContent as { count: number }).count, 3)
  })

  it('venice_video_status returns a completed MP4 as an embedded MCP blob resource', async () => {
    const mp4 = Buffer.from('mock-mp4-bytes')
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({
        kind: 'binary',
        buffer: mp4,
        contentType: 'video/mp4',
      }),
    })
    const tools = buildTools(stub.asClient(), { ...cfg, maxVideoResponseBytes: 4096 })
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'x',
      model: 'm',
    } as never)
    assert.equal(stub.callsTo('/v1/video/retrieve')[0].maxBytes, 4096)
    assert.equal((r.structuredContent as { status: string }).status, 'COMPLETED')
    const resource = r.content.find((c) => c.type === 'resource') as {
      type: 'resource'
      resource: { mimeType: string; blob: string }
    } | undefined
    assert.equal(resource?.resource.mimeType, 'video/mp4')
    assert.equal(resource?.resource.blob, mp4.toString('base64'))
  })

  it('venice_video_status rejects an empty MP4 without cleanup and preserves the queued URL for retry', async () => {
    let empty = true
    const url = 'https://private-share.venice.ai/v1/share/read/retry'
    const stub = new StubClient({
      '/v1/video/queue': () => ({ model: 'm', queue_id: 'empty-video', download_url: url }),
      '/v1/video/retrieve': () => empty
        ? { kind: 'binary', status: 200, buffer: Buffer.alloc(0), contentType: 'video/mp4' }
        : { status: 'COMPLETED' },
    })
    const tools = buildTools(stub.asClient(), cfg)
    await tools.find((t) => t.name === 'venice_video_generate')!.handler({ prompt: 'p', model: 'm', duration: '8s' })
    const status = tools.find((t) => t.name === 'venice_video_status')!
    const args = { queue_id: 'empty-video', model: 'm', delete_media_on_completion: true }
    const result = await status.handler(args)
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent?.retry_safe, true)
    assert.equal(result.structuredContent?.server_media_deleted, false)
    assert.match(result.content[0].type === "text" && result.content[0].text, /empty video\/mp4 body/)
    assert.equal(result.content.some((item) => item.type === 'resource'), false)
    assert.equal(stub.callsTo('/v1/video/complete').length, 0)
    assert.equal((stub.callsTo('/v1/video/retrieve')[0].body as typeof args).delete_media_on_completion, false)

    empty = false
    const retry = await status.handler(args)
    assert.equal(retry.isError, undefined)
    assert.equal(retry.structuredContent?.url, url)
    assert.equal(stub.callsTo('/v1/video/complete').length, 0)
  })

  it('venice_video_status returns a JSON completed download_url as a resource link', async () => {
    const { get } = setup()
    const r = await get('venice_video_status').handler({ queue_id: 'x', model: 'm' } as never)
    assert.equal((r.structuredContent as { status: string }).status, 'COMPLETED')
    assert.equal((r.structuredContent as { url: string }).url, 'https://stub/v.mp4')
    assert.equal((r.structuredContent as { representation: string }).representation, 'download_url resource link')
    const link = r.content.find((c) => c.type === 'resource_link') as { uri: string; mimeType?: string } | undefined
    assert.equal(link?.uri, 'https://stub/v.mp4')
    assert.equal(link?.mimeType, 'video/mp4')
  })

  it('venice_video_status fails JSON COMPLETED responses that omit a download URL', async () => {
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({ status: 'COMPLETED' }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'x',
      model: 'm',
    } as never)
    assert.equal(r.isError, true)
    assert.match((r.content[0] as { text: string }).text, /download_url/)
  })

  it('venice_video_status uses the queue-time download_url when retrieve omits one', async () => {
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({ status: 'COMPLETED' }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'vps-1',
      model: 'grok-imagine-text-to-video-private',
      download_url: 'https://private-share.venice.ai/v1/share/read/abc',
    } as never)

    assert.equal(r.isError, undefined)
    assert.equal((r.structuredContent as { status: string }).status, 'COMPLETED')
    assert.equal(
      (r.structuredContent as { url: string }).url,
      'https://private-share.venice.ai/v1/share/read/abc',
    )
    const retrieveBody = stub.calls.find((call) => call.path === '/v1/video/retrieve')!.body as Record<string, unknown>
    assert.equal(retrieveBody.download_url, undefined)
    assert.equal(retrieveBody.queue_id, 'vps-1')
    assert.equal(retrieveBody.model, 'grok-imagine-text-to-video-private')
  })

  it('venice_video_status reuses a queue-time URL remembered from generate', async () => {
    const stub = new StubClient({
      '/v1/video/queue': () => ({
        model: 'grok-imagine-text-to-video-private',
        queue_id: 'vps-remember',
        download_url: 'https://private-share.venice.ai/v1/share/read/remembered',
      }),
      '/v1/video/retrieve': () => ({ status: 'COMPLETED' }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    await tools.find((t) => t.name === 'venice_video_generate')!.handler({
      prompt: 'a gondola',
      model: 'grok-imagine-text-to-video-private',
    } as never)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'vps-remember',
      model: 'grok-imagine-text-to-video-private',
    } as never)
    assert.equal(r.isError, undefined)
    assert.equal(
      (r.structuredContent as { url: string }).url,
      'https://private-share.venice.ai/v1/share/read/remembered',
    )
  })

  it('venice_video_status keeps a Venice-issued queue URL served from a non-venice.ai host', async () => {
    const cdnUrl = 'https://cdn.example-media.net/v/remembered.mp4'
    const stub = new StubClient({
      '/v1/video/queue': () => ({ model: 'grok-imagine-text-to-video-private', queue_id: 'vps-cdn', download_url: cdnUrl }),
      '/v1/video/retrieve': () => ({ status: 'COMPLETED' }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    await tools.find((t) => t.name === 'venice_video_generate')!.handler({
      prompt: 'a gondola',
      model: 'grok-imagine-text-to-video-private',
    } as never)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'vps-cdn',
      model: 'grok-imagine-text-to-video-private',
    } as never)
    assert.equal(r.isError, undefined)
    assert.equal((r.structuredContent as { url: string }).url, cdnUrl)
  })

  it('remembered queue URLs are not visible to another session', async () => {
    const stub = new StubClient({
      '/v1/video/queue': () => ({
        model: 'grok-imagine-text-to-video-private',
        queue_id: 'vps-private',
        download_url: 'https://private-share.venice.ai/v1/share/read/private',
      }),
      '/v1/video/retrieve': () => ({ status: 'COMPLETED' }),
    })
    const owner = buildTools(stub.asClient(), cfg)
    const other = buildTools(stub.asClient(), cfg)
    await owner.find((t) => t.name === 'venice_video_generate')!.handler({
      prompt: 'a gondola',
      model: 'grok-imagine-text-to-video-private',
    } as never)
    const r = await other.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'vps-private',
      model: 'grok-imagine-text-to-video-private',
    } as never)
    assert.equal(r.isError, true)
    assert.doesNotMatch(JSON.stringify(r), /share\/read\/private/)
  })

  it('venice_video_generate evicts the oldest remembered queue URL instead of growing forever', async () => {
    let queued = 0
    const stub = new StubClient({
      '/v1/video/queue': () => {
        queued += 1
        return {
          model: 'grok-imagine-text-to-video-private',
          queue_id: `vps-bulk-${queued}`,
          download_url: `https://private-share.venice.ai/v1/share/read/${queued}`,
        }
      },
      '/v1/video/retrieve': () => ({ status: 'COMPLETED' }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const generate = tools.find((t) => t.name === 'venice_video_generate')!
    const status = tools.find((t) => t.name === 'venice_video_status')!
    for (let i = 0; i < 1001; i += 1) {
      await generate.handler({ prompt: 'a gondola', model: 'grok-imagine-text-to-video-private' } as never)
    }

    const evicted = await status.handler({
      queue_id: 'vps-bulk-1',
      model: 'grok-imagine-text-to-video-private',
    } as never)
    assert.equal(evicted.isError, true)

    const newest = await status.handler({
      queue_id: `vps-bulk-${queued}`,
      model: 'grok-imagine-text-to-video-private',
    } as never)
    assert.equal(newest.isError, undefined)
    assert.equal(
      (newest.structuredContent as { url: string }).url,
      `https://private-share.venice.ai/v1/share/read/${queued}`,
    )
  })

  for (const downloadUrl of [
    'https://evil.example/payload.mp4?secret=do-not-echo',
    'http://venice.ai/payload.mp4',
    'https://venice.ai.evil.example/payload.mp4',
  ]) {
    it(`venice_video_status explicitly rejects an untrusted caller download_url (${downloadUrl})`, async () => {
      const stub = new StubClient({
        '/v1/video/retrieve': () => ({ status: 'COMPLETED' }),
      })
      const tools = buildTools(stub.asClient(), cfg)
      const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
        queue_id: 'vps-1',
        model: 'grok-imagine-text-to-video-private',
        download_url: downloadUrl,
      } as never)
      assert.equal(r.isError, true)
      assert.equal(
        (r.content[0] as { text: string }).text,
        'download_url rejected: must be https on venice.ai or a subdomain.',
      )
      assert.equal(JSON.stringify(r).includes(downloadUrl), false)
      assert.deepEqual(r.structuredContent, { status: 'COMPLETED' })
    })
  }

  it('venice_video_generate tells the host to pass queue-time download_url into status', async () => {
    const stub = new StubClient({
      '/v1/video/queue': () => ({
        model: 'grok-imagine-text-to-video-private',
        queue_id: 'vps-1',
        download_url: 'https://private-share.venice.ai/v1/share/read/abc',
      }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_generate')!.handler({
      prompt: 'a gondola',
      model: 'grok-imagine-text-to-video-private',
    } as never)

    const text = (r.content[0] as { text: string }).text
    assert.match(text, /venice_video_status/)
    assert.match(text, /download_url/)
    assert.equal(
      (r.structuredContent as { download_url?: string }).download_url,
      'https://private-share.venice.ai/v1/share/read/abc',
    )
  })

  it('venice_video_status defers requested deletion until after MP4 buffering', async () => {
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({
        kind: 'binary',
        buffer: Buffer.from('mock-mp4'),
        contentType: 'video/mp4',
      }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'delete-after-buffer',
      model: 'm',
      delete_media_on_completion: true,
    } as never)

    assert.equal(
      (stub.calls.find((call) => call.path === '/v1/video/retrieve')!.body as {
        delete_media_on_completion: boolean
      }).delete_media_on_completion,
      false,
    )
    assert.ok(stub.calls.some((call) => call.path === '/v1/video/complete'))
    assert.equal((r.structuredContent as { server_media_deleted: boolean }).server_media_deleted, true)
  })

  it('venice_video_status reports cleanup failure when complete returns 200 { success: false }', async () => {
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({
        kind: 'binary',
        buffer: Buffer.from('mock-mp4'),
        contentType: 'video/mp4',
      }),
      '/v1/video/complete': () => ({ success: false }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'cleanup-refused',
      model: 'm',
      delete_media_on_completion: true,
    } as never)

    assert.equal(r.isError, undefined)
    assert.equal((r.content[0] as { type: string }).type, 'resource')
    assert.equal((r.structuredContent as { server_media_deleted: boolean }).server_media_deleted, false)
    assert.match((r.content[1] as { text: string }).text, /cleanup was not confirmed/)
  })

  it('venice_video_status does not claim deletion when complete omits success', async () => {
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({
        kind: 'binary',
        buffer: Buffer.from('mock-mp4'),
        contentType: 'video/mp4',
      }),
      '/v1/video/complete': () => ({}),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'cleanup-silent',
      model: 'm',
      delete_media_on_completion: true,
    } as never)

    assert.equal(r.isError, undefined)
    assert.equal((r.structuredContent as { server_media_deleted: boolean }).server_media_deleted, false)
    assert.match((r.content[1] as { text: string }).text, /cleanup was not confirmed/)
  })

  for (const automatic of [false, true]) {
    for (const cleanup of [{ success: true }, { success: false }, {}, null, new Error('cleanup failed')]) {
      it(`${automatic ? 'automatic' : 'explicit'} video cleanup evicts the remembered URL only on confirmed success: ${JSON.stringify(cleanup)}`, async () => {
        const url = 'https://private-share.venice.ai/v1/share/read/cleanup'
        let binary = automatic
        const stub = new StubClient({
          '/v1/video/queue': () => ({ model: 'm', queue_id: 'cleanup', download_url: url }),
          '/v1/video/retrieve': () => binary
            ? { kind: 'binary', buffer: Buffer.from('mp4'), contentType: 'video/mp4' }
            : { status: 'COMPLETED' },
          '/v1/video/complete': () => {
            if (cleanup instanceof Error) throw cleanup
            return cleanup
          },
        })
        const tools = buildTools(stub.asClient(), cfg)
        const get = (name: string) => tools.find((tool) => tool.name === name)!
        const args = { queue_id: 'cleanup', model: 'm' }
        await get('venice_video_generate').handler({ prompt: 'p', model: 'm', duration: '8s' })
        await get(automatic ? 'venice_video_status' : 'venice_video_complete').handler({
          ...args,
          ...(automatic ? { delete_media_on_completion: true } : {}),
        })
        assert.equal(stub.callsTo('/v1/video/complete').length, 1)
        binary = false
        const result = await get('venice_video_status').handler(args)
        if (cleanup && 'success' in cleanup && cleanup.success === true) {
          assert.equal(result.isError, true)
          assert.doesNotMatch(JSON.stringify(result), /share\/read\/cleanup/)
        } else {
          assert.equal(result.isError, undefined)
          assert.equal(result.structuredContent?.url, url)
        }
      })
    }
  }

  it('venice_video_complete reports removal only when Venice confirms success', async () => {
    const stub = new StubClient({
      '/v1/video/complete': () => ({ success: true }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_complete')!.handler({
      queue_id: 'cleanup-ok',
      model: 'm',
    } as never)

    assert.equal(r.isError, undefined)
    assert.equal((r.structuredContent as { server_media_deleted: boolean }).server_media_deleted, true)
    assert.match((r.content[0] as { text: string }).text, /server-side media removed/)
  })

  it('venice_video_complete does not claim removal when complete returns 200 { success: false }', async () => {
    const stub = new StubClient({
      '/v1/video/complete': () => ({ success: false }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_complete')!.handler({
      queue_id: 'cleanup-refused',
      model: 'm',
    } as never)

    assert.equal(r.isError, true)
    assert.equal((r.structuredContent as { server_media_deleted: boolean }).server_media_deleted, false)
    const text = (r.content[0] as { text: string }).text
    assert.match(text, /not confirmed/)
    assert.doesNotMatch(text, /media removed/)
  })

  it('venice_video_complete does not claim removal when complete omits success', async () => {
    const stub = new StubClient({
      '/v1/video/complete': () => ({}),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_complete')!.handler({
      queue_id: 'cleanup-silent',
      model: 'm',
    } as never)

    assert.equal(r.isError, true)
    assert.equal((r.structuredContent as { server_media_deleted: boolean }).server_media_deleted, false)
    assert.match((r.content[0] as { text: string }).text, /not confirmed/)
  })

  it('venice_video_status never completes a JSON download_url before the caller downloads it', async () => {
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({ status: 'COMPLETED' }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'vps-delete-requested',
      model: 'grok-imagine-text-to-video-private',
      download_url: 'https://private-share.venice.ai/v1/share/read/keep-me',
      delete_media_on_completion: true,
    } as never)

    assert.equal(r.isError, undefined)
    assert.equal(stub.calls.some((call) => call.path === '/v1/video/complete'), false)
    assert.equal(
      (r.structuredContent as { url: string }).url,
      'https://private-share.venice.ai/v1/share/read/keep-me',
    )
    assert.equal((r.structuredContent as { server_media_deleted: boolean }).server_media_deleted, false)
    assert.match((r.structuredContent as { next_step: string }).next_step, /venice_video_complete/)
    const text = (r.content[1] as { text: string }).text
    assert.match(text, /NOT deleted/)
    assert.match(text, /Download the file from this URL first, then call venice_video_complete/)
    assert.match(text, /HTTP DELETE/)
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

  it('venice_list_models forwards every documented type', async () => {
    const { get } = setup()
    const typeSchema = get('venice_list_models').inputSchema.type
    for (const type of ['asr', 'decision', 'embedding', 'image', 'music', 'text', 'tts', 'upscale', 'inpaint', 'video', 'all', 'code']) {
      assert.equal(typeSchema.safeParse(type).success, true, `missing model type ${type}`)
    }
    for (const name of ['venice_model_traits', 'venice_model_compatibility_mapping']) {
      const schema = get(name).inputSchema.type
      for (const type of ['asr', 'decision', 'embedding', 'image', 'music', 'text', 'tts', 'upscale', 'inpaint', 'video']) {
        assert.equal(schema.safeParse(type).success, true, `${name} missing model type ${type}`)
      }
      assert.equal(schema.safeParse('all').success, false, `${name} does not accept all`)
      assert.equal(schema.safeParse('code').success, false, `${name} does not accept code`)
      assert.equal(schema.safeParse('some-new-type').success, true, `${name} accepts a new catalog type`)
      assert.equal(schema.parse(' Image '), 'image')
    }
  })

  it('venice_model_traits forwards a new catalog type upstream', async () => {
    const { stub, get } = setup()
    const args = z.object(get('venice_model_traits').inputSchema).parse({ type: 'some-new-type' })
    await get('venice_model_traits').handler(args as never)
    assert.equal(stub.calls.at(-1)?.path, '/v1/models/traits?type=some-new-type')
  })

  it('venice_list_models pages compact summaries and reports next_offset', async () => {
    const models = Array.from({ length: 120 }, (_, i) => ({
      id: `model-${i}`,
      type: 'text',
      object: 'model',
      owned_by: 'venice.ai',
      context_length: 128_000,
      model_spec: {
        name: `Model ${i}`,
        description: 'long upstream description',
        maxCompletionTokens: 8192,
        capabilities: { supportsVision: true, supportsReasoning: false, quantization: 'fp8' },
        traits: [],
        privacy: 'private',
        offline: false,
        pricing: { input: { usd: 1 }, output: { usd: 2 } },
      },
    }))
    const stub = new StubClient({ '/v1/models?type=text': () => ({ data: models }) })
    const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_list_models')!

    const first = await tool.handler({ type: 'text' } as never)
    const s1 = first.structuredContent as { total: number; count: number; offset: number; next_offset: number | null; data: unknown[] }
    assert.equal(s1.total, 120)
    assert.equal(s1.count, 50)
    assert.equal(s1.offset, 0)
    assert.equal(s1.next_offset, 50)
    const text = (first.content[0] as { text: string }).text
    assert.doesNotMatch(text, /\n/, 'compact JSON')
    assert.deepEqual(JSON.parse(text).data[0], {
      id: 'model-0',
      type: 'text',
      name: 'Model 0',
      context_length: 128_000,
      max_completion_tokens: 8192,
      capabilities: ['supportsVision'],
      privacy: 'private',
      pricing: { input: { usd: 1 }, output: { usd: 2 } },
    })

    const last = await tool.handler({ type: 'text', offset: 100, limit: 50 } as never)
    const s2 = last.structuredContent as { count: number; next_offset: number | null }
    assert.equal(s2.count, 20)
    assert.equal(s2.next_offset, null)

    const verbose = await tool.handler({ type: 'text', limit: 1, verbose: true } as never)
    assert.deepEqual((verbose.structuredContent as { data: unknown[] }).data, [models[0]])
    assert.equal(tool.inputSchema.limit.safeParse(201).success, false)
  })

  for (const verbose of [false, true]) {
    it(`venice_list_models follows every page using only text content (verbose=${verbose})`, async () => {
      const models = Array.from({ length: 120 }, (_, i) => ({
        id: `model-${i}`,
        type: 'text',
        model_spec: { description: 'x'.repeat(1500) },
      }))
      const stub = new StubClient({ '/v1/models?type=all': () => ({ data: models }) })
      const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_list_models')!
      const seen: string[] = []
      let offset: number | null = 0
      while (offset !== null) {
        const result = await tool.handler({ offset, verbose })
        const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        const page = JSON.parse(text)
        assert.equal(page.total, models.length)
        assert.deepEqual(page.ids, models.map((m) => m.id))
        assert.equal(page.offset, offset)
        assert.equal(page.count, page.data.length)
        assert.ok(page.count > 0)
        seen.push(...page.data.map((m: { id: string }) => m.id))
        assert.ok(page.next_offset === null || page.next_offset === offset + page.count)
        assert.ok(seen.length <= models.length)
        offset = page.next_offset
      }
      assert.deepEqual(seen, models.map((m) => m.id))
    })
  }

  it('venice_list_models caps verbose pages by size and continues via next_offset', async () => {
    const models = Array.from({ length: 200 }, (_, i) => ({
      id: `model-${i}`,
      type: 'video',
      model_spec: { description: 'x'.repeat(1500) },
    }))
    const stub = new StubClient({ '/v1/models?type=all': () => ({ data: models }) })
    const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_list_models')!
    const r = await tool.handler({ limit: 200, verbose: true } as never)
    const s = r.structuredContent as { count: number; next_offset: number | null }
    const text = (r.content[0] as { text: string }).text
    assert.ok(s.count > 0 && s.count < 200)
    assert.equal(s.next_offset, s.count)
    assert.ok(text.length <= 64 * 1024)
    assert.equal(JSON.parse(text).data.length, s.count)
  })

  it('venice_voice_clone list shapes live model-scoped voice metadata', async () => {
    const { get, stub } = setup()
    const r = await get('venice_voice_clone').handler({ action: 'list' } as never)
    assert.equal(stub.calls.at(-1)?.path, '/v1/models?type=tts')
    const shaped = r.structuredContent as {
      type: string
      data: Array<{
        id: string
        voices: string[]
        voice_cloning: { mode: string }
        supported_formats: string[]
      }>
    }
    assert.equal(shaped.type, 'tts')
    assert.deepEqual(shaped.data[0].voices, ['voice-a', 'voice-b'])
    assert.equal(shaped.data[0].voice_cloning.mode, 'persistent')
    assert.deepEqual(shaped.data[0].supported_formats, ['mp3', 'wav'])
  })

  it('venice_voice_clone create leaves model to the upstream default and only accepts cloning models', async () => {
    const { get, stub } = setup()
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        new Response('mock audio', {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })) as typeof fetch
      const tool = get('venice_voice_clone')
      const r = await tool.handler({
        action: 'create',
        sample_url: 'https://93.184.216.34/sample.mp3',
      } as never)
      assert.equal(r.isError, undefined)
      const body = stub.callsTo('/v1/audio/voices')[0].body as Record<string, unknown>
      assert.equal('model' in body, false)
      assert.equal(tool.inputSchema.model.safeParse('tts-minimax-speech-02-hd').success, true)
      assert.equal(tool.inputSchema.model.safeParse('tts-kokoro').success, false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_web_search returns parsed results as structuredContent', async () => {
    const { get } = setup()
    const r = await get('venice_web_search').handler({ query: 'venice' } as never)
    assert.deepEqual(r.structuredContent, { results: [{ url: 'https://x', snippet: 's' }] })
  })

  it('catalog metadata tools preserve the upstream map envelope', async () => {
    const { get } = setup()
    const traits = await get('venice_model_traits').handler({} as never)
    assert.deepEqual(traits.structuredContent, {
      data: { default: 'deepseek-v4-flash-0731' },
      object: 'list',
      type: 'text',
    })
    const compatibility = await get('venice_model_compatibility_mapping').handler({} as never)
    assert.deepEqual(compatibility.structuredContent, {
      data: { 'gpt-4o': 'deepseek-v4-flash-0731' },
      object: 'list',
      type: 'text',
    })
  })

  it('venice_asr forwards timestamps and preserves timestamp metadata', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        new Response('mock audio', {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })) as typeof fetch
      const stub = new StubClient({
        '/v1/audio/transcriptions': () => ({
          text: 'hello',
          duration: 1.5,
          timestamps: { word: [{ word: 'hello', start: 0, end: 1.5 }] },
        }),
      })
      const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
      const r = await tool.handler({
        audio_url: 'https://93.184.216.34/audio.wav',
        response_format: 'json',
        timestamps: true,
      } as never)
      assert.equal(stub.calls.at(-1)?.maxBytes, 1024 * 1024)
      const body = stub.calls.at(-1)?.body as Record<string, unknown>
      assert.equal(body.response_format, 'json')
      assert.equal(body.timestamps, 'true')
      assert.deepEqual((r.structuredContent as { timestamps: unknown }).timestamps, {
        word: [{ word: 'hello', start: 0, end: 1.5 }],
      })
      const textContent = JSON.parse((r.content[0] as { text: string }).text)
      assert.equal(textContent.text, 'hello')
      assert.deepEqual(textContent.timestamps, { word: [{ word: 'hello', start: 0, end: 1.5 }] })
      assert.equal(textContent.result_handle, undefined)
      assert.equal(r.structuredContent?.result_handle, undefined)
      assert.equal(textContent.timestamps_truncated, false)
      assert.equal(textContent.next_timestamp_offset, null)
      assert.equal(tool.inputSchema.response_format.safeParse('srt').success, false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_asr does not retain timestamp results that fit the requested page', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () =>
        new Response('mock audio', { headers: { 'content-type': 'audio/wav' } })
      const words = Array.from({ length: 200 }, (_, i) => ({ word: `w${i}`, start: i, end: i + 1 }))
      const stub = new StubClient({
        '/v1/audio/transcriptions': () => ({ text: 'hi', timestamps: { word: words } }),
      })
      const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
      for (const args of [{}, { timestamp_offset: 199, timestamp_limit: 1 }]) {
        const result = await tool.handler({ audio_url: 'https://93.184.216.34/audio.wav', timestamps: true, ...args })
        assert.equal(result.isError, undefined)
        assert.equal(result.structuredContent?.timestamps_truncated, false)
        assert.equal(result.structuredContent?.result_handle, undefined)
        assert.equal(JSON.parse((result.content[0] as { text: string }).text).result_handle, undefined)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_asr pages a retained result without transcribing the clip twice', async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    try {
      globalThis.fetch = (async () => {
        fetchCalls += 1
        return new Response('mock audio', {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })
      }) as typeof fetch
      const words = Array.from({ length: 250 }, (_, i) => ({ word: `w${i}`, start: i, end: i + 1 }))
      const stub = new StubClient({
        '/v1/audio/transcriptions': () => ({
          text: 'long transcript',
          timestamps: { word: words },
        }),
      })
      const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
      const r = await tool.handler({
        audio_url: 'https://93.184.216.34/audio.wav',
        timestamps: true,
      } as never)
      const structured = r.structuredContent as {
        timestamps: { word: unknown[] }
        timestamp_total: { word: number }
        timestamps_truncated: boolean
        timestamp_limit: number
        next_timestamp_offset: number | null
        result_handle: string
      }
      assert.equal(structured.timestamps.word.length, 200)
      assert.deepEqual(structured.timestamps.word[0], words[0])
      assert.equal(structured.timestamp_total.word, 250)
      assert.equal(structured.timestamps_truncated, true)
      assert.equal(structured.timestamp_limit, 200)
      assert.equal(typeof structured.result_handle, 'string')
      assert.equal(structured.next_timestamp_offset, 200)
      const text = (r.content[0] as { text: string }).text
      assert.equal(JSON.parse(text).result_handle, structured.result_handle)
      assert.equal(JSON.parse(text).next_timestamp_offset, 200)
      assert.doesNotMatch(text, /w249/)

      const page = await tool.handler({
        result_handle: structured.result_handle,
        timestamp_offset: 200,
        timestamp_limit: 50,
      } as never)
      const paged = page.structuredContent as {
        timestamps: { word: unknown[] }
        timestamp_offset: number
        timestamps_truncated: boolean
        next_timestamp_offset: number | null
        result_handle: string
      }
      assert.equal(paged.timestamps.word.length, 50)
      assert.deepEqual(paged.timestamps.word[0], words[200])
      assert.equal(paged.timestamp_offset, 200)
      assert.equal(paged.timestamps_truncated, false)
      assert.equal(paged.next_timestamp_offset, null)
      assert.equal(paged.result_handle, structured.result_handle)
      // The point of the handle: continuation must not pay for a second transcription.
      assert.equal(stub.callsTo('/v1/audio/transcriptions').length, 1)
      assert.equal(fetchCalls, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_asr result handles are private to the tool set that created them', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        new Response('mock audio', {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })) as typeof fetch
      const stub = new StubClient({
        '/v1/audio/transcriptions': () => ({ text: 'hi', timestamps: { word: Array.from({ length: 201 }, () => ({ word: 'hi', start: 0, end: 1 })) } }),
      })
      const sessionA = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
      const sessionB = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
      const r = await sessionA.handler({ audio_url: 'https://93.184.216.34/audio.wav', timestamps: true } as never)
      const handle = (r.structuredContent as { result_handle: string }).result_handle
      assert.equal(typeof handle, 'string')

      const own = await sessionA.handler({ result_handle: handle } as never)
      assert.equal(own.isError, undefined)
      const other = await sessionB.handler({ result_handle: handle } as never)
      assert.equal(other.isError, true)
      assert.equal((other.structuredContent as { error: string }).error, 'asr_result_expired')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_asr pages a long transcript through the handle without transcribing again', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        new Response('mock audio', { status: 200, headers: { 'content-type': 'audio/wav' } })) as typeof fetch
      const transcript = 'a'.repeat(8000) + 'tail'
      const stub = new StubClient({ '/v1/audio/transcriptions': () => transcript })
      const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
      const first = await tool.handler({ audio_url: 'https://93.184.216.34/audio.wav', response_format: 'text' } as never)
      const s1 = first.structuredContent as { text: string; next_text_offset: number; result_handle: string }
      assert.equal(s1.text.length, 8000)
      assert.equal(s1.next_text_offset, 8000)
      assert.equal(JSON.parse((first.content[0] as { text: string }).text).result_handle, s1.result_handle)

      const next = await tool.handler({ result_handle: s1.result_handle, text_offset: s1.next_text_offset } as never)
      const s2 = next.structuredContent as { text: string; next_text_offset: number | null }
      assert.equal(s2.text, 'tail')
      assert.equal(s2.next_text_offset, null)
      assert.equal(stub.callsTo('/v1/audio/transcriptions').length, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_asr drops a retained result when its retention timer fires', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        new Response('mock audio', { status: 200, headers: { 'content-type': 'audio/wav' } })) as typeof fetch
      const stub = new StubClient({
        '/v1/audio/transcriptions': () => ({ text: 'hi', timestamps: { word: Array.from({ length: 201 }, () => ({ word: 'hi', start: 0, end: 1 })) } }),
      })
      const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
      const r = await tool.handler({ audio_url: 'https://93.184.216.34/audio.wav', timestamps: true } as never)
      const handle = (r.structuredContent as { result_handle: string }).result_handle
      assert.equal(typeof handle, 'string')
      t.mock.timers.tick(10 * 60 * 1000)
      const expired = await tool.handler({ result_handle: handle } as never)
      assert.equal((expired.structuredContent as { error: string }).error, 'asr_result_expired')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_web_search caps query at the API maximum of 400 characters', () => {
    const tool = buildTools(new StubClient().asClient(), cfg).find((t) => t.name === 'venice_web_search')!
    const schema = z.object(tool.inputSchema)
    assert.equal(schema.safeParse({ query: 'q'.repeat(400) }).success, true)
    assert.equal(schema.safeParse({ query: 'q'.repeat(401) }).success, false)
  })

  it('venice_asr refuses to re-transcribe when a result handle is unknown or expired', async () => {
    const stub = new StubClient()
    const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
    const r = await tool.handler({
      result_handle: 'missing-handle',
      timestamp_offset: 200,
    } as never)

    assert.equal(r.isError, true)
    assert.match((r.content[0] as { text: string }).text, /expired result_handle/)
    assert.equal((r.structuredContent as { error: string }).error, 'asr_result_expired')
    assert.equal(stub.callsTo('/v1/audio/transcriptions').length, 0)
  })

  it('venice_asr requires audio_url when no result handle is supplied', async () => {
    const stub = new StubClient()
    const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
    const r = await tool.handler({ timestamps: true } as never)

    assert.equal(r.isError, true)
    assert.match((r.content[0] as { text: string }).text, /audio_url is required/)
    assert.equal(stub.calls.length, 0)
  })

  it('venice_asr rejects an oversized timestamped transcription before echoing it', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        new Response('mock audio', {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })) as typeof fetch
      const { VeniceResponseTooLargeError } = await import('../src/venice-client.js')
      const stub = new StubClient({
        '/v1/audio/transcriptions': () => {
          throw new VeniceResponseTooLargeError('/v1/audio/transcriptions', 1024 * 1024)
        },
      })
      const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_asr')!
      const r = await tool.handler({
        audio_url: 'https://93.184.216.34/audio.wav',
        timestamps: true,
      } as never)
      assert.equal(r.isError, true)
      assert.match((r.content[0] as { text: string }).text, /1 MiB/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_list_models forwards type to the catalog so non-text models are discoverable', async () => {
    const { stub, get } = setup()
    const r = await get('venice_list_models').handler({ type: 'image' } as never)
    assert.equal(stub.calls.at(-1)?.path, '/v1/models?type=image')
    assert.equal((r.structuredContent as { count: number }).count, 1)
    assert.match((r.content[0] as { text: string }).text, /flux-2-pro/)
    assert.deepEqual((r.structuredContent as { ids: string[] }).ids, ['flux-2-pro'])

    await get('venice_list_models').handler({} as never)
    assert.equal(stub.calls.at(-1)?.path, '/v1/models?type=all')
  })

  it('venice_model_details returns the full matching catalog row', async () => {
    const { get } = setup()
    const r = await get('venice_model_details').handler({
      model_id: 'FLUX-2-Pro',
      type: 'image',
    } as never)
    assert.equal(r.isError, undefined)
    assert.match((r.content[0] as { text: string }).text, /"constraints"/)
    const model = r.structuredContent as {
      id: string
      model_spec: {
        pricing: { generation: { usd: number } }
        constraints: { aspectRatios: string[] }
        supportsWebSearch: boolean
      }
    }
    assert.equal(model.id, 'flux-2-pro')
    assert.deepEqual(model.model_spec.constraints.aspectRatios, ['1:1', '16:9'])
    assert.equal(model.model_spec.pricing.generation.usd, 0.03)
    assert.equal(model.model_spec.supportsWebSearch, false)
  })

  it('venice_model_details reads a catalog returned under models', async () => {
    const stub = new StubClient({
      '/v1/models?type=video': () => ({ models: [{ id: 'video-model', type: 'video', model_spec: {} }] }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_model_details')!.handler({
      model_id: 'video-model',
      type: 'video',
    } as never)
    assert.equal(r.isError, undefined)
    assert.equal((r.structuredContent as { id: string }).id, 'video-model')
  })

  it('venice_model_details resolves a mixed-case id after schema normalization', async () => {
    const { get } = setup()
    const tool = get('venice_model_details')
    const args = z.object(tool.inputSchema).parse({ model_id: '  FLUX-2-Pro  ', type: 'IMAGE' })
    const result = await tool.handler(args)
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent?.id, 'flux-2-pro')
  })

  it('venice_model_details rejects prefix matches and preserves the requested id in errors', async () => {
    const stub = new StubClient({
      '/v1/models?type=image': () => ({
        data: [{ id: 'flux-2-pro-preview', model_spec: {}, type: 'image' }],
      }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_model_details')!.handler({
      model_id: 'FLUX-2-Pro',
      type: 'image',
    } as never)
    assert.equal(r.isError, true)
    const text = (r.content[0] as { text: string }).text
    assert.match(text, /No model "FLUX-2-Pro" in the "image" catalog/)
    assert.match(text, /retry with that type/)
    assert.doesNotMatch(text, /\(.*\bimage\b.*\)/)
    assert.equal(stub.calls.at(-1)?.path, '/v1/models?type=image')
  })

  it('venice_model_details formats upstream errors consistently', async () => {
    const stub = new StubClient({
      '/v1/models?type=image': async () => {
        const { VeniceUpstreamError } = await import('../src/types.js')
        throw new VeniceUpstreamError({
          message: 'missing',
          status: 404,
          body: { error: 'Model not found' },
        })
      },
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_model_details')!.handler({
      model_id: 'FLUX-2-Pro',
      type: 'image',
    } as never)
    assert.equal(r.isError, true)
    assert.equal((r.content[0] as { text: string }).text, 'Venice API error 404: upstream request failed.')
  })

  it('venice_music_generate accepts model-defined lyrics_prompt lengths', () => {
    const { get } = setup()
    const schema = z.object(get('venice_music_generate').inputSchema)
    const longLyrics = 'la'.repeat(3_000)
    const parsed = schema.parse({
      prompt: 'song',
      model: 'lyrics-model',
      lyrics_prompt: longLyrics,
    })
    assert.equal(parsed.lyrics_prompt, longLyrics)
  })

  it('image generate/edit/multi-edit cap response bytes and explain an oversized result', async () => {
    const { VeniceResponseTooLargeError } = await import('../src/venice-client.js')
    const imageCfg = { ...cfg, maxImageResponseBytes: 2048 }
    const tooLarge = (path: string) => () => {
      throw new VeniceResponseTooLargeError(path, 2048)
    }
    const stub = new StubClient({
      '/v1/image/generate': tooLarge('/v1/image/generate'),
      '/v1/image/edit': tooLarge('/v1/image/edit'),
      '/v1/image/multi-edit': tooLarge('/v1/image/multi-edit'),
    })
    const tools = buildTools(stub.asClient(), imageCfg)
    const get = (name: string) => tools.find((t) => t.name === name)!
    const results = [
      await get('venice_image_generate').handler({ prompt: 'four 4K scenes', variants: 4, resolution: '4K' } as never),
      await get('venice_image_edit').handler({ image_url: 'https://x/img.png', prompt: 'winter' } as never),
      await get('venice_image_multi_edit').handler({ image_urls: ['https://x/a.png'], prompt: 'winter' } as never),
    ]

    for (const path of ['/v1/image/generate', '/v1/image/edit', '/v1/image/multi-edit']) {
      assert.equal(stub.calls.find((call) => call.path === path)?.maxBytes, 2048)
    }
    for (const r of results) {
      assert.equal(r.isError, true)
      assert.equal((r.structuredContent as { error: string }).error, 'image_response_too_large')
      assert.equal((r.structuredContent as { max_bytes: number }).max_bytes, 2048)
      const text = (r.content[0] as { text: string }).text
      assert.match(text, /2048-byte/)
      assert.match(text, /fewer variants/)
      assert.match(text, /VENICE_MAX_IMAGE_RESPONSE_BYTES/)
    }
  })

  it('image upscale/background-remove cap response bytes with the image limit', async () => {
    const { VeniceResponseTooLargeError } = await import('../src/venice-client.js')
    const stub = new StubClient({
      '/v1/image/upscale': () => {
        throw new VeniceResponseTooLargeError('/v1/image/upscale', 2048)
      },
      '/v1/image/background-remove': () => {
        throw new VeniceResponseTooLargeError('/v1/image/background-remove', 2048)
      },
    })
    const tools = buildTools(stub.asClient(), { ...cfg, maxImageResponseBytes: 2048 })
    const get = (name: string) => tools.find((t) => t.name === name)!
    const originalFetch = globalThis.fetch
    const results = []
    try {
      globalThis.fetch = (async () =>
        new Response('mock upload bytes', { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch
      results.push(await get('venice_image_upscale').handler({ image_url: 'https://93.184.216.34/image.png' } as never))
    } finally {
      globalThis.fetch = originalFetch
    }
    results.push(await get('venice_image_remove_bg').handler({ image_url: 'https://x/img.png' } as never))

    for (const path of ['/v1/image/upscale', '/v1/image/background-remove']) {
      assert.equal(stub.callsTo(path)[0]?.maxBytes, 2048)
    }
    for (const r of results) {
      assert.equal(r.isError, true)
      assert.equal((r.structuredContent as { error: string }).error, 'image_response_too_large')
      assert.match((r.content[0] as { text: string }).text, /VENICE_MAX_IMAGE_RESPONSE_BYTES/)
    }
  })

  it('venice_tts caps response bytes with the audio limit', async () => {
    const { stub, get } = setup()
    await get('venice_tts').handler({ input: 'hello' } as never)
    assert.equal(stub.callsTo('/v1/audio/speech')[0].maxBytes, cfg.maxAudioResponseBytes)

    const { VeniceResponseTooLargeError } = await import('../src/venice-client.js')
    const tooLarge = new StubClient({
      '/v1/audio/speech': () => {
        throw new VeniceResponseTooLargeError('/v1/audio/speech', 1024)
      },
    })
    const tools = buildTools(tooLarge.asClient(), { ...cfg, maxAudioResponseBytes: 1024 })
    const r = await tools.find((t) => t.name === 'venice_tts')!.handler({ input: 'hello' } as never)
    assert.equal(tooLarge.callsTo('/v1/audio/speech')[0].maxBytes, 1024)
    assert.equal(r.isError, true)
    assert.equal((r.structuredContent as { error: string }).error, 'audio_response_too_large')
    assert.equal((r.structuredContent as { retry_safe: boolean }).retry_safe, false)
    assert.match((r.content[0] as { text: string }).text, /VENICE_MAX_AUDIO_RESPONSE_BYTES/)
  })

  it('venice_image_edit does not send quality, which EditImageRequest rejects', async () => {
    const { stub, get } = setup()
    const tool = get('venice_image_edit')
    assert.equal('quality' in tool.inputSchema, false)
    await tool.handler(z.object(tool.inputSchema).parse({
      image_url: 'https://x/img.png',
      prompt: 'add hat',
      quality: 'high',
    }) as never)
    const body = stub.calls.at(-1)!.body as Record<string, unknown>
    assert.equal('quality' in body, false)
  })

  it('venice_music_generate maps deprecated instrumental/lyrics onto the live fields', async () => {
    const { stub, get } = setup()
    const tool = get('venice_music_generate')
    const args = z.object(tool.inputSchema).parse({
      prompt: 'song',
      model: 'elevenlabs-music',
      instrumental: true,
      lyrics: 'Old lyrics field',
    })
    await tool.handler(args as never)

    const body = stub.calls.at(-1)!.body as Record<string, unknown>
    assert.equal(body.force_instrumental, true)
    assert.equal(body.lyrics_prompt, 'Old lyrics field')
    assert.equal('instrumental' in body, false)
    assert.equal('lyrics' in body, false)
  })

  it('venice_music_generate prefers force_instrumental/lyrics_prompt over deprecated aliases', async () => {
    const { stub, get } = setup()
    await get('venice_music_generate').handler({
      prompt: 'song',
      model: 'elevenlabs-music',
      instrumental: true,
      force_instrumental: false,
      lyrics: 'Old lyrics field',
      lyrics_prompt: 'New lyrics field',
    } as never)

    const body = stub.calls.at(-1)!.body as Record<string, unknown>
    assert.equal(body.force_instrumental, false)
    assert.equal(body.lyrics_prompt, 'New lyrics field')
  })

  it('venice_video_status returns retry-safe guidance for an oversized MP4', async () => {
    const { VeniceResponseTooLargeError } = await import('../src/venice-client.js')
    const stub = new StubClient({
      '/v1/video/retrieve': () => {
        throw new VeniceResponseTooLargeError('/v1/video/retrieve', 1024)
      },
    })
    const tools = buildTools(stub.asClient(), { ...cfg, maxVideoResponseBytes: 1024 })
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'still-queued',
      model: 'video-model',
    } as never)

    assert.equal(r.isError, true)
    assert.equal((r.structuredContent as { retry_safe: boolean }).retry_safe, true)
    assert.equal((r.structuredContent as { queue_id: string }).queue_id, 'still-queued')
    const text = (r.content[0] as { text: string }).text
    assert.match(text, /same queue_id/)
    assert.match(text, /VENICE_MAX_VIDEO_RESPONSE_BYTES/)
    assert.match(text, /not deleted/)
  })

  it('image tools surface URL-decoded enhanced prompts from response headers', async () => {
    const stub = new StubClient({
      '/v1/image/generate': () => ({
        __stubResponse: true,
        data: { id: 'enhanced', images: ['cG5n'] },
        headers: { 'x-venice-enhanced-prompt': 'a%20more%20detailed%20prompt' },
      }),
      '/v1/image/edit': () => ({
        buffer: Buffer.from('edited'),
        contentType: 'image/png',
        headers: { 'x-venice-enhanced-prompt': 'make%20it%20winter' },
      }),
      '/v1/image/multi-edit': () => ({
        buffer: Buffer.from('multi-edited'),
        contentType: 'image/png',
        headers: { 'x-venice-enhanced-prompt': 'unified%20winter%20scene' },
      }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const get = (name: string) => tools.find((t) => t.name === name)!

    const generated = await get('venice_image_generate').handler({ prompt: 'scene', enhance_prompt: true } as never)
    assert.equal((generated.structuredContent as { enhanced_prompt: string }).enhanced_prompt, 'a more detailed prompt')

    const edited = await get('venice_image_edit').handler({
      image_url: 'https://x/img.png',
      prompt: 'winter',
      enhance_prompt: true,
    } as never)
    assert.equal((edited.structuredContent as { enhanced_prompt: string }).enhanced_prompt, 'make it winter')

    const multiEdited = await get('venice_image_multi_edit').handler({
      image_urls: ['https://x/a.png'],
      prompt: 'winter',
      enhance_prompt: true,
    } as never)
    assert.equal((multiEdited.structuredContent as { enhanced_prompt: string }).enhanced_prompt, 'unified winter scene')
  })

  it('venice_image_multi_edit sends modelId and omits model', async () => {
    const stub = new StubClient()
    const tools = buildTools(stub.asClient(), cfg)
    await tools.find((t) => t.name === 'venice_image_multi_edit')!.handler({
      image_urls: ['https://x/a.png', 'https://x/b.png'],
      prompt: 'merge them',
      model: 'qwen-image-2-edit',
      aspect_ratio: '16:9',
    } as never)

    const sent = JSON.parse(JSON.stringify(stub.callsTo('/v1/image/multi-edit')[0].body)) as Record<string, unknown>
    assert.equal(sent.modelId, 'qwen-image-2-edit')
    assert.equal('model' in sent, false)
    assert.deepEqual(sent.images, ['https://x/a.png', 'https://x/b.png'])
  })

  it('venice_image_multi_edit omits model fields when model is unset', async () => {
    const stub = new StubClient()
    const tools = buildTools(stub.asClient(), cfg)
    await tools.find((t) => t.name === 'venice_image_multi_edit')!.handler({
      image_urls: ['https://x/a.png'],
      prompt: 'merge them',
    } as never)

    const sent = JSON.parse(JSON.stringify(stub.callsTo('/v1/image/multi-edit')[0].body)) as Record<string, unknown>
    assert.equal('model' in sent, false)
    assert.equal('modelId' in sent, false)
    assert.deepEqual(sent.images, ['https://x/a.png'])
    assert.equal(sent.prompt, 'merge them')
  })

  it('venice_image_edit still sends model', async () => {
    const stub = new StubClient()
    const tools = buildTools(stub.asClient(), cfg)
    await tools.find((t) => t.name === 'venice_image_edit')!.handler({
      image_url: 'https://x/img.png',
      prompt: 'add hat',
      model: 'firered-image-edit',
    } as never)

    const sent = JSON.parse(JSON.stringify(stub.callsTo('/v1/image/edit')[0].body)) as Record<string, unknown>
    assert.equal(sent.model, 'firered-image-edit')
    assert.equal('modelId' in sent, false)
  })

  it('venice_video_generate returns Seedance consent policy and explicit next step', async () => {
    const stub = new StubClient({
      '/v1/video/queue': async () => {
        const { VeniceUpstreamError } = await import('../src/types.js')
        throw new VeniceUpstreamError({
          message: 'consent required',
          status: 409,
          body: {
            error: { code: 'needs_consent', message: 'Seedance consent is required.' },
            consent_flow: 'seedance',
            face_media_roles: ['reference_image'],
            consent: { consent_version: 'v2.0', policy_text: 'You have legal consent for every depicted person.' },
            docs_url: 'https://docs.venice.ai/guides/media/seedance-face-consent',
          },
        })
      },
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_generate')!.handler({
      prompt: 'animate',
      model: 'seedance-2-0-reference-to-video',
      reference_image_urls: ['https://x/person.png'],
    } as never)

    assert.equal(r.isError, true)
    assert.equal((r.structuredContent as { status: string }).status, 'needs_consent')
    const text = (r.content[0] as { text: string }).text
    assert.match(text, /legal consent/)
    assert.match(text, /Only after the user explicitly confirms/)
    assert.match(text, /all set to true/)
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

  it('requires model for venice_embeddings', () => {
    const { get } = setup()
    const tool = get('venice_embeddings')

    const modelSchema = tool.inputSchema.model

    assert.equal(
      modelSchema.isOptional(),
      false,
      'venice_embeddings.model should be required'
    )
  })
})

describe('video tool schemas', () => {
  it('venice_video_generate requires duration', () => {
    const { get } = setup()
    const schema = z.object(get('venice_video_generate').inputSchema)

    const result = schema.safeParse({
      prompt: 'a sunset',
      model: 'veo3.1-fast-text-to-video',
    })

    assert.equal(result.success, false)
  })

  it('venice_video_quote requires duration', () => {
    const { get } = setup()
    const schema = z.object(get('venice_video_quote').inputSchema)

    const result = schema.safeParse({
      model: 'veo3.1-fast-text-to-video',
    })

    assert.equal(result.success, false)
  })

  it('accepts duration for venice_video_generate', () => {
    const { get } = setup()
    const schema = z.object(get('venice_video_generate').inputSchema)

    const result = schema.safeParse({
      prompt: 'a sunset',
      model: 'veo3.1-fast-text-to-video',
      duration: '8s',
    })

    assert.equal(result.success, true)
  })

  it('accepts duration for venice_video_quote', () => {
    const { get } = setup()
    const schema = z.object(get('venice_video_quote').inputSchema)

    const result = schema.safeParse({
      model: 'veo3.1-fast-text-to-video',
      duration: '8s',
    })

    assert.equal(result.success, true)
  })
})
describe('tool annotations', () => {
  it('every tool has explicit readOnly, destructive, idempotent and openWorld hints', () => {
    const { tools } = setup()
    for (const t of tools) {
      const hints = TOOL_ANNOTATIONS[t.name]
      assert.ok(hints, `${t.name} has no entry in TOOL_ANNOTATIONS`)
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        assert.equal(typeof hints[key], 'boolean', `${t.name}.${key}`)
      }
    }
  })

  it('only lookups are read-only, and only cleanup and crypto relays are destructive', () => {
    assert.equal(TOOL_ANNOTATIONS.venice_list_models.readOnlyHint, true)
    assert.equal(TOOL_ANNOTATIONS.venice_video_generate.readOnlyHint, false)
    assert.equal(TOOL_ANNOTATIONS.venice_video_complete.destructiveHint, true)
    assert.equal(TOOL_ANNOTATIONS.venice_crypto_rpc.destructiveHint, true)
    assert.equal(TOOL_ANNOTATIONS.venice_image_generate.destructiveHint, false)
  })
})

describe('media cleanup reporting', () => {
  for (const [tool, path] of [
    ['venice_video_complete', '/v1/video/complete'],
    ['venice_music_complete', '/v1/audio/complete'],
  ] as const) {
    it(`${tool} only reports deletion when Venice returns success: true`, async () => {
      const confirmed = await buildTools(new StubClient({ [path]: () => ({ success: true }) }).asClient(), cfg)
        .find((t) => t.name === tool)!
        .handler({ queue_id: 'q', model: 'm' } as never)
      assert.equal(confirmed.isError, undefined)
      assert.equal((confirmed.structuredContent as { server_media_deleted: boolean }).server_media_deleted, true)

      for (const body of [{ success: false }, {}]) {
        const r = await buildTools(new StubClient({ [path]: () => body }).asClient(), cfg)
          .find((t) => t.name === tool)!
          .handler({ queue_id: 'q', model: 'm' } as never)
        assert.equal(r.isError, true)
        assert.match((r.content[0] as { text: string }).text, /not confirmed|did not confirm cleanup/)
      }
    })
  }
})

describe('venice_image_multi_edit request body', () => {
  it('sends modelId, which the API accepts, and never model', async () => {
    const { stub, get } = setup()
    await get('venice_image_multi_edit').handler({ image_urls: ['https://x/a.png'], prompt: 'merge', model: 'qwen-edit' } as never)
    const body = stub.calls.at(-1)!.body as Record<string, unknown>
    assert.equal(body.modelId, 'qwen-edit')
    assert.equal('model' in body, false)
  })
})
