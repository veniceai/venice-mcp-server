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
  it('registers exactly the documented set (31 tools)', () => {
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
    assert.equal(tools.length, 31)
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
      quality: 'medium',
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
      quality: 'medium',
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
  { tool: 'venice_list_models', args: { type: 'video' }, expectMethod: 'GET', expectPath: '/v1/models?type=video' },

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
      if (m.expectBodyContains) {
        const body = call.body as Record<string, unknown>
        for (const [k, v] of Object.entries(m.expectBodyContains)) {
          assert.deepEqual(body[k], v, `${m.tool} body.${k}`)
        }
      }
    })
  }
})

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
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'x',
      model: 'm',
    } as never)
    assert.equal((r.structuredContent as { status: string }).status, 'COMPLETED')
    const resource = r.content.find((c) => c.type === 'resource') as {
      type: 'resource'
      resource: { mimeType: string; blob: string }
    } | undefined
    assert.equal(resource?.resource.mimeType, 'video/mp4')
    assert.equal(resource?.resource.blob, mp4.toString('base64'))
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

  it('venice_list_models filters by capability type', async () => {
    const stub = new StubClient({
      '/v1/models?type=image': () => ({ data: [{ id: 'flux-2-pro' }] }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const get = (name: string) => tools.find((t) => t.name === name)!
    const r = await get('venice_list_models').handler({ type: 'image' } as never)
    assert.equal(stub.calls.at(-1)?.path, '/v1/models?type=image')
    assert.equal((r.structuredContent as { count: number; total: number }).total, 1)
    assert.equal((r.structuredContent as { count: number }).count, 1)
  })

  it('venice_list_models does not truncate a server-filtered catalog', async () => {
    const models = Array.from({ length: 101 }, (_, index) => ({ id: `video-${index}` }))
    const stub = new StubClient({
      '/v1/models?type=video': () => ({ data: models }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_list_models')!.handler({ type: 'video' } as never)

    assert.equal((r.structuredContent as { count: number }).count, 101)
    assert.equal((JSON.parse((r.content[0] as { text: string }).text) as unknown[]).length, 101)
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
})
