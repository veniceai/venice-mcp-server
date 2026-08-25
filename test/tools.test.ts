import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { buildTools, type ToolDef } from '../src/tools/index.js'
import { resetWeb3MintAttemptStore } from '../src/tools/web3-key-mint.js'
import { loadConfig } from '../src/config.js'
import { VeniceUpstreamError } from '../src/types.js'
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
  it('registers exactly the documented set (40 tools)', () => {
    const { tools } = setup()
    const names = tools.map((t) => t.name).sort()
    const expected = [
      'venice_asr',
      'venice_audio_quote',
      'venice_api_key_rate_limit_logs',
      'venice_api_key_rate_limits',
      'venice_billing_balance',
      'venice_billing_usage_analytics',
      'venice_billing_usage_history',
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
      'venice_get_api_key',
      'venice_list_api_keys',
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
      'venice_web3_key_challenge',
      'venice_web3_key_mint',
      'venice_x402_balance',
      'venice_x402_top_up_info',
      'venice_x402_transactions',
    ].sort()
    assert.deepEqual(names, expected)
    assert.equal(tools.length, 40)
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

  it('billing and operator API-key tools call out API-key-only requirements', () => {
    const { get } = setup()
    for (const name of [
      'venice_billing_balance',
      'venice_billing_usage_analytics',
      'venice_billing_usage_history',
      'venice_list_api_keys',
      'venice_get_api_key',
    ]) {
      assert.match(get(name).description, /ADMIN API key required/i, `${name} admin description`)
    }
    for (const name of ['venice_api_key_rate_limits', 'venice_api_key_rate_limit_logs']) {
      assert.match(get(name).description, /API key required/i, `${name} auth description`)
      assert.doesNotMatch(get(name).description, /ADMIN API key required/i, `${name} allows inference keys`)
    }
  })

  it('all API_KEY_ONLY discovery and read tools force explicit API-key auth', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['venice_list_characters', { limit: 3 }],
      ['venice_billing_balance', {}],
      ['venice_billing_usage_analytics', { lookback: '7d' }],
      ['venice_billing_usage_history', { page_size: 10 }],
      ['venice_list_api_keys', {}],
      ['venice_get_api_key', { id: 'key-1' }],
      ['venice_api_key_rate_limits', {}],
      ['venice_api_key_rate_limit_logs', {}],
    ]
    for (const [name, args] of cases) {
      const stub = new StubClient()
      const tool = buildTools(stub.asClient(), cfg).find((item) => item.name === name)!
      await tool.handler(args as never)
      assert.equal(stub.calls.length, 1, `${name} request count`)
      assert.equal(stub.calls[0].auth, 'apiKey', `${name} auth mode`)
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

  // billing
  { tool: 'venice_billing_balance', args: {}, expectMethod: 'GET', expectPath: '/v1/billing/balance' },
  {
    tool: 'venice_billing_usage_analytics',
    args: { start_date: '2026-08-01', end_date: '2026-08-10' },
    expectMethod: 'GET',
    expectPath: '/v1/billing/usage-analytics?startDate=2026-08-01&endDate=2026-08-10',
  },
  {
    tool: 'venice_billing_usage_history',
    args: {
      currency: 'DIEM',
      start_timestamp: '2026-08-01T00:00:00.000Z',
      page_size: 100,
    },
    expectMethod: 'GET',
    expectPath: '/v1/billing/usage-history?currency=DIEM&startTimestamp=2026-08-01T00%3A00%3A00.000Z&pageSize=100',
  },

  // API keys
  { tool: 'venice_list_api_keys', args: {}, expectMethod: 'GET', expectPath: '/v1/api_keys' },
  {
    tool: 'venice_get_api_key',
    args: { id: 'key/id' },
    expectMethod: 'GET',
    expectPath: '/v1/api_keys/key%2Fid',
  },
  {
    tool: 'venice_api_key_rate_limits',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/api_keys/rate_limits',
  },
  {
    tool: 'venice_api_key_rate_limit_logs',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/api_keys/rate_limits/log',
  },
  {
    tool: 'venice_web3_key_challenge',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/api_keys/generate_web3_key',
  },
  {
    tool: 'venice_web3_key_mint',
    args: {
      address: `0x${'a'.repeat(40)}`,
      signature: '0xsigned',
      token: 'challenge',
      api_key_type: 'INFERENCE',
      consumption_limit: { usd: 50, diem: 10 },
      limit_period: 'MONTH',
    },
    expectMethod: 'POST',
    expectPath: '/v1/api_keys/generate_web3_key',
    expectBodyContains: {
      apiKeyType: 'INFERENCE',
      consumptionLimit: { usd: 50, diem: 10 },
      limitPeriod: 'MONTH',
    },
  },

  // x402 helpers
  {
    tool: 'venice_x402_balance',
    args: { wallet_address: '0x' + 'a'.repeat(40) },
    expectMethod: 'GET',
    expectPath: `/v1/x402/balance/0x${'a'.repeat(40)}`,
  },
  {
    tool: 'venice_x402_top_up_info',
    args: { wallet_address: 'So11111111111111111111111111111111111111112' },
    expectMethod: 'POST',
    expectPath: '/v1/x402/top-up',
    expectBodyContains: {},
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
      resetWeb3MintAttemptStore()
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

  it('accepts EVM and Solana addresses on all x402 helpers and preserves Solana case', async () => {
    const { get } = setup()
    const evm = `0x${'A'.repeat(40)}`
    const solana = 'So11111111111111111111111111111111111111112'
    for (const name of [
      'venice_x402_balance',
      'venice_x402_top_up_info',
      'venice_x402_transactions',
    ]) {
      const schema = z.object(get(name).inputSchema)
      assert.equal(schema.safeParse({ wallet_address: evm }).success, true, `${name} EVM`)
      assert.equal(schema.safeParse({ wallet_address: solana }).success, true, `${name} Solana`)
      assert.equal(schema.safeParse({ wallet_address: 'not-a-wallet' }).success, false, `${name} invalid`)
    }

    const stub = new StubClient()
    const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_x402_balance')!
    await tool.handler({ wallet_address: solana } as never)
    assert.equal(stub.calls.at(-1)?.path, `/v1/x402/balance/${solana}`)
  })

  it('uses cursor-only continuation and exposes JSON and CSV next cursors', async () => {
    const { get, stub } = setup()
    const history = get('venice_billing_usage_history')

    const invalid = await history.handler({ cursor: 'cursor_1', currency: 'USD' } as never)
    assert.equal(invalid.isError, true)
    assert.equal(stub.calls.length, 0)

    const json = await history.handler({ cursor: 'cursor_1' } as never)
    assert.equal(stub.calls.at(-1)?.path, '/v1/billing/usage-history?cursor=cursor_1')
    assert.equal(json.structuredContent?.nextCursor, 'stub-next-cursor')

    const csvStub = new StubClient({
      '/v1/billing/usage-history': () => 'timestamp,amount\n2026-08-01T00:00:00.000Z,-0.1',
    })
    const csvTool = buildTools(csvStub.asClient(), cfg).find(
      (tool) => tool.name === 'venice_billing_usage_history',
    )!
    const csv = await csvTool.handler({ format: 'csv', page_size: 50 } as never)
    assert.equal(csvStub.calls.at(-1)?.headers?.Accept, 'text/csv')
    assert.equal(csv.structuredContent?.nextCursor, 'csv:stub-next-cursor')
    assert.match((csv.content[0] as { text: string }).text, /timestamp,amount/)

    const continued = await csvTool.handler({ cursor: csv.structuredContent?.nextCursor as string } as never)
    assert.equal(csvStub.calls.at(-1)?.headers?.Accept, 'text/csv')
    assert.equal(csvStub.calls.at(-1)?.path, '/v1/billing/usage-history?cursor=stub-next-cursor')
    assert.equal(continued.structuredContent?.format, 'csv')
  })

  it('validates analytics filter combinations before making a request', async () => {
    const { get, stub } = setup()
    const analytics = get('venice_billing_usage_analytics')
    assert.equal(
      (await analytics.handler({ lookback: '7d', start_date: '2026-08-01', end_date: '2026-08-02' } as never)).isError,
      true,
    )
    assert.equal((await analytics.handler({ lookback: '91d' } as never)).isError, true)
    assert.equal((await analytics.handler({ start_date: '2026-08-01' } as never)).isError, true)
    assert.equal(stub.calls.length, 0)
  })

  it('uses unauthenticated Web3 challenge/mint calls without accepting a private-key field', async () => {
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) =>
        method === 'POST'
          ? { success: true, data: { apiKey: 'vk_new_secret', id: 'key-1' } }
          : { success: true, data: { token: 'challenge-token' } },
    })
    const tools = buildTools(stub.asClient(), cfg)
    const challenge = tools.find((tool) => tool.name === 'venice_web3_key_challenge')!
    const mint = tools.find((tool) => tool.name === 'venice_web3_key_mint')!
    assert.equal('private_key' in mint.inputSchema, false)
    assert.equal('privateKey' in mint.inputSchema, false)

    await challenge.handler({} as never)
    assert.equal(stub.calls.at(-1)?.auth, 'none')

    resetWeb3MintAttemptStore()
    const result = await mint.handler({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      consumption_limit: { usd: 25 },
    } as never)
    assert.equal(stub.calls.at(-1)?.auth, 'none')
    assert.equal((stub.calls.at(-1)?.body as { apiKeyType?: string }).apiKeyType, 'INFERENCE')
    assert.equal((stub.calls.at(-1)?.body as { limitPeriod?: string }).limitPeriod, 'LIFETIME')
    assert.match((result.content[0] as { text: string }).text, /vk_new_secret/)
    assert.equal(result.structuredContent, undefined)

    const schema = z.object(mint.inputSchema)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      api_key_type: 'ADMIN',
      consumption_limit: { usd: 25 },
    }).success, false)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
    }).success, false)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      consumption_limit: { usd: 0, diem: null },
    }).success, false)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      description: 'x'.repeat(64),
      consumption_limit: { usd: 25 },
    }).success, true)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      description: 'x'.repeat(65),
      consumption_limit: { usd: 25 },
    }).success, false)
  })

  it('replays a successful web3 mint for the same challenge token without creating another key', async () => {
    resetWeb3MintAttemptStore()
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) =>
        method === 'POST' ? { success: true, data: { apiKey: 'vk_replay_secret', id: 'key-replay' } } : {},
    })
    const mint = buildTools(stub.asClient(), cfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const args = {
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'replay-token',
      consumption_limit: { usd: 25 },
    } as never

    const first = await mint.handler(args)
    const second = await mint.handler(args)
    assert.equal(stub.calls.filter((call) => call.method === 'POST').length, 1)
    assert.match((first.content[0] as { text: string }).text, /vk_replay_secret/)
    assert.match((second.content[0] as { text: string }).text, /vk_replay_secret/)

    const otherSigner = await mint.handler({
      ...args,
      address: `0x${'b'.repeat(40)}`,
    } as never)
    assert.equal(otherSigner.isError, true)
    assert.match((otherSigner.content[0] as { text: string }).text, /different wallet or signature/)
    assert.equal(stub.calls.filter((call) => call.method === 'POST').length, 1)
  })

  it('refuses to retry a web3 mint after an unknown outcome', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        throw new VeniceUpstreamError({
          message: 'timeout',
          status: 504,
          body: { error: 'timeout' },
        })
      },
    })
    const mint = buildTools(stub.asClient(), cfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const args = {
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'unknown-token',
      consumption_limit: { usd: 25 },
    } as never

    const first = await mint.handler(args)
    const second = await mint.handler(args)
    assert.equal(first.isError, true)
    assert.equal(second.isError, true)
    assert.equal(posts, 1)
    assert.match((first.content[0] as { text: string }).text, /Mint outcome is unknown/)
    assert.match((second.content[0] as { text: string }).text, /Do not retry/)
    assert.match((second.content[0] as { text: string }).text, /venice_list_api_keys/)
  })

  it('refuses to retry a web3 mint after a 429', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        throw new VeniceUpstreamError({
          message: 'rate limited',
          status: 429,
          body: { error: 'rate limited' },
        })
      },
    })
    const mint = buildTools(stub.asClient(), cfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const args = {
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'rate-limited-token',
      consumption_limit: { usd: 25 },
    } as never

    const first = await mint.handler(args)
    const second = await mint.handler(args)
    assert.equal(first.isError, true)
    assert.equal(second.isError, true)
    assert.equal(posts, 1)
    assert.match((second.content[0] as { text: string }).text, /Do not retry/)
  })

  it('refuses a new challenge token for a wallet with an unknown mint outcome', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        throw new VeniceUpstreamError({
          message: 'timeout',
          status: 504,
          body: { error: 'timeout' },
        })
      },
    })
    const mint = buildTools(stub.asClient(), cfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const address = `0x${'a'.repeat(40)}`
    const first = await mint.handler({
      address,
      signature: 'signed-value',
      token: 'lost-token',
      consumption_limit: { usd: 25 },
    } as never)
    const second = await mint.handler({
      address,
      signature: 'signed-value',
      token: 'fresh-challenge-token',
      consumption_limit: { usd: 25 },
    } as never)
    assert.equal(first.isError, true)
    assert.equal(second.isError, true)
    assert.equal(posts, 1)
    assert.match((second.content[0] as { text: string }).text, /new challenge will not mint/)
  })

  it('allows a corrected web3 mint after a definitive 4xx', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        if (posts === 1) {
          throw new VeniceUpstreamError({
            message: 'bad token',
            status: 400,
            body: { error: 'invalid token' },
          })
        }
        return { success: true, data: { apiKey: 'vk_after_400', id: 'key-400' } }
      },
    })
    const mint = buildTools(stub.asClient(), cfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const args = {
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'retryable-token',
      consumption_limit: { usd: 25 },
      expires_at: '2026-08-01T12:00:00.123456Z',
    } as never

    const first = await mint.handler(args)
    const second = await mint.handler(args)
    assert.equal(first.isError, true)
    assert.equal(second.isError, undefined)
    assert.equal(posts, 2)
    assert.equal((stub.calls.at(-1)?.body as { expiresAt?: string }).expiresAt, '2026-08-01T12:00:00.123Z')
    assert.match((second.content[0] as { text: string }).text, /vk_after_400/)
  })

  it('accepts high-precision RFC3339 timestamps on usage-history filters', async () => {
    const { get, stub } = setup()
    const history = get('venice_billing_usage_history')
    const schema = z.object(history.inputSchema)
    assert.equal(schema.safeParse({ start_timestamp: '2026-08-01T00:00:00.123456Z' }).success, true)
    assert.equal(schema.safeParse({ start_timestamp: '2026-08-01T00:00:00.1Z' }).success, true)
    assert.equal(schema.safeParse({ start_timestamp: '2026-08-01T00:00:00.123456789Z' }).success, true)

    const result = await history.handler({
      start_timestamp: '2026-08-01T00:00:00.123456Z',
      end_timestamp: '2026-08-02T00:00:00.1Z',
    } as never)
    assert.equal(result.isError, undefined)
    assert.equal(
      stub.calls.at(-1)?.path,
      '/v1/billing/usage-history?startTimestamp=2026-08-01T00%3A00%3A00.123456Z&endTimestamp=2026-08-02T00%3A00%3A00.1Z',
    )
  })

  it('redacts unexpected secret fields from operator API-key reads', async () => {
    const secret = 'vk_should_not_escape'
    const stub = new StubClient({
      '/v1/api_keys': () => ({
        object: 'list',
        data: [{ id: 'key-1', last6Chars: 'escape', apiKey: secret, token: 'token-secret' }],
      }),
    })
    const tool = buildTools(stub.asClient(), cfg).find((item) => item.name === 'venice_list_api_keys')!
    const result = await tool.handler({} as never)
    const text = (result.content[0] as { text: string }).text
    assert.doesNotMatch(text, new RegExp(secret))
    assert.doesNotMatch(text, /token-secret/)
    assert.match(text, /\[REDACTED\]/)
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
