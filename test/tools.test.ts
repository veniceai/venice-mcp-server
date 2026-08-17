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
  it('registers exactly the documented set (34 tools)', () => {
    const { tools } = setup()
    const names = tools.map((t) => t.name).sort()
    const expected = [
      'venice_asr',
      'venice_audio_quote',
      'venice_chat',
      'venice_chat_with_character',
      'venice_character_reviews',
      'venice_crypto_networks',
      'venice_crypto_rpc',
      'venice_embeddings',
      'venice_image_edit',
      'venice_image_generate',
      'venice_image_multi_edit',
      'venice_image_remove_bg',
      'venice_image_styles',
      'venice_image_upscale',
      'venice_get_character',
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
    assert.equal(tools.length, 34)
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
    for (const name of ['venice_list_characters', 'venice_get_character', 'venice_character_reviews']) {
      assert.match(get(name).description, /API key required/i, `${name} should require an API key`)
      assert.match(get(name).description, /does not accept x402/i, `${name} should reject x402 discovery`)
    }
    // chat_with_character notes the discovery limitation
    assert.match(get('venice_chat_with_character').description, /API[- ]key/i)
  })

  it('crypto network discovery is explicitly auth-free', () => {
    const { get } = setup()
    assert.match(get('venice_crypto_networks').description, /No authentication required/i)
    assert.doesNotMatch(get('venice_crypto_rpc').description, /Networks include/i)
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
    tool: 'venice_crypto_networks',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/crypto/rpc/networks',
  },
  {
    tool: 'venice_crypto_rpc',
    args: { network: 'base-mainnet', rpc_method: 'eth_blockNumber' },
    expectMethod: 'POST',
    expectPath: '/v1/crypto/rpc/base-mainnet',
    expectBodyContains: { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 },
  },

  // catalog
  { tool: 'venice_list_models', args: {}, expectMethod: 'GET', expectPath: '/v1/models' },

  // characters
  {
    tool: 'venice_list_characters',
    args: {
      search: 'guide',
      tag: 'legacy',
      tags: ['helpful', 'productivity'],
      categories: ['roleplay', 'philosophy'],
      isAdult: false,
      isPro: true,
      isWebEnabled: false,
      modelId: ['model/a', 'model-b'],
      sortBy: 'highestRating',
      sortOrder: 'asc',
      limit: 100,
      offset: 20,
    },
    expectMethod: 'GET',
    expectPath: '/v1/characters?search=guide&tag=legacy&tags=helpful&tags=productivity&categories=roleplay&categories=philosophy&isAdult=false&isPro=true&isWebEnabled=false&modelId=model%2Fa&modelId=model-b&sortBy=highestRating&sortOrder=asc&limit=100&offset=20',
  },
  {
    tool: 'venice_get_character',
    args: { slug: 'alan watts/teacher' },
    expectMethod: 'GET',
    expectPath: '/v1/characters/alan%20watts%2Fteacher',
  },
  {
    tool: 'venice_character_reviews',
    args: { slug: 'alan-watts', page: 2, pageSize: 50 },
    expectMethod: 'GET',
    expectPath: '/v1/characters/alan-watts/reviews?page=2&pageSize=50',
  },
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
  it('venice_crypto_networks disables auth and returns structured network data', async () => {
    const stub = new StubClient({
      '/v1/crypto/rpc/networks': () => ({ networks: ['base-mainnet', 'ethereum-mainnet'] }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_crypto_networks')!.handler({} as never)

    assert.equal(stub.calls.at(-1)?.auth, 'none')
    assert.deepEqual(r.structuredContent, {
      networks: ['base-mainnet', 'ethereum-mainnet'],
      count: 2,
    })
  })

  it('venice_crypto_rpc forwards a single request object unchanged', async () => {
    const { stub, get } = setup()
    const request = { jsonrpc: '2.0', method: 'eth_getBalance', params: ['0xabc', 'latest'], id: 'balance-1' }
    await get('venice_crypto_rpc').handler({ network: 'ethereum-mainnet', request } as never)
    assert.deepEqual(stub.calls.at(-1)?.body, request)
  })

  it('venice_crypto_rpc forwards a batch request unchanged', async () => {
    const { stub, get } = setup()
    const request = [
      { jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 },
      { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 2 },
    ]
    await get('venice_crypto_rpc').handler({ network: 'ethereum-mainnet', request } as never)
    assert.deepEqual(stub.calls.at(-1)?.body, request)
  })

  it('venice_crypto_rpc validates batch size and request objects', () => {
    const { get } = setup()
    const schema = z.object(get('venice_crypto_rpc').inputSchema)
    const valid = { jsonrpc: '2.0' as const, method: 'eth_chainId', params: [], id: 1 }

    assert.equal(
      schema.safeParse({
        network: 'ethereum-mainnet',
        request: { jsonrpc: '2.0', method: 'eth_chainId', params: [] },
      }).success,
      true,
      'single requests may omit id',
    )
    assert.equal(schema.safeParse({ network: 'ethereum-mainnet', request: [valid] }).success, true)
    assert.equal(
      schema.safeParse({
        network: 'ethereum-mainnet',
        request: [{ ...valid, id: 'chain-id' }],
      }).success,
      true,
      'batch IDs may be strings',
    )
    assert.equal(
      schema.safeParse({
        network: 'ethereum-mainnet',
        request: [{ jsonrpc: '2.0', method: 'eth_chainId', params: [] }],
      }).success,
      false,
      'every batch item requires an id',
    )
    assert.equal(schema.safeParse({ network: 'ethereum-mainnet', request: [] }).success, false)
    assert.equal(
      schema.safeParse({ network: 'ethereum-mainnet', request: Array.from({ length: 100 }, () => valid) }).success,
      true,
    )
    assert.equal(
      schema.safeParse({ network: 'ethereum-mainnet', request: Array.from({ length: 101 }, () => valid) }).success,
      false,
    )
    assert.equal(
      schema.safeParse({ network: 'ethereum-mainnet', request: [{ jsonrpc: '1.0', method: 'eth_chainId' }] }).success,
      false,
    )
    assert.equal(
      schema.safeParse({ network: 'ethereum-mainnet', request: [{ jsonrpc: '2.0', method: '' }] }).success,
      false,
    )
  })

  it('venice_crypto_rpc rejects ambiguous or missing request forms without calling upstream', async () => {
    const { stub, get } = setup()
    const tool = get('venice_crypto_rpc')

    const both = await tool.handler({
      network: 'ethereum-mainnet',
      request: { method: 'eth_chainId' },
      rpc_method: 'eth_blockNumber',
    } as never)
    assert.equal(both.isError, true)

    const neither = await tool.handler({ network: 'ethereum-mainnet' } as never)
    assert.equal(neither.isError, true)
    assert.equal(stub.calls.length, 0)
  })

  it('character discovery rejects SIWX-only configuration locally without upstream calls', async () => {
    const stub = new StubClient()
    const siwxOnlyCfg = loadConfig({ VENICE_SIWX_TOKEN: 'siwx-test-token' })
    const tools = buildTools(stub.asClient(), siwxOnlyCfg)
    const calls = [
      { name: 'venice_list_characters', args: {} },
      { name: 'venice_get_character', args: { slug: 'alan-watts' } },
      { name: 'venice_character_reviews', args: { slug: 'alan-watts', page: 1, pageSize: 20 } },
    ]

    for (const call of calls) {
      const result = await tools.find((tool) => tool.name === call.name)!.handler(call.args as never)
      assert.equal(result.isError, true, `${call.name} should return a local error`)
      assert.match((result.content[0] as { text: string }).text, /VENICE_API_KEY is required/)
    }
    assert.equal(stub.calls.length, 0)
  })

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

describe('x402 top-up discovery auth', () => {
  it('posts an empty unauthenticated body so a configured API key is not forwarded', async () => {
    const stub = new StubClient()
    const tool = buildTools(stub.asClient(), cfg).find((item) => item.name === 'venice_x402_top_up_info')!
    await tool.handler({ wallet_address: `0x${'a'.repeat(40)}` } as never)
    const call = stub.calls.at(-1)
    assert.equal(call?.path, '/v1/x402/top-up')
    assert.deepEqual(call?.body, {})
    assert.equal(call?.auth, 'none')
  })
})

describe('character discovery auth', () => {
  it('forces API-key auth on character reads', async () => {
    const stub = new StubClient()
    const tools = buildTools(stub.asClient(), cfg)
    await tools.find((item) => item.name === 'venice_list_characters')!.handler({} as never)
    await tools.find((item) => item.name === 'venice_get_character')!.handler({ slug: 'alice' } as never)
    await tools.find((item) => item.name === 'venice_character_reviews')!.handler({ slug: 'alice' } as never)
    assert.deepEqual(
      stub.calls.map((call) => call.auth),
      ['apiKey', 'apiKey', 'apiKey'],
    )
  })
})
